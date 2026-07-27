/* ============================================================
   fx/atmos.js — the air in the room.

   Three quiet things:
     · dust motes, thickest where light actually enters
     · the city outside, twinkling after dark
     · the wash the television throws back into the room

   All three are meant to be felt rather than noticed. If any of
   them reads as an effect, it is turned up too far.
   ============================================================ */

import { PLATE, WINDOW, LAMP } from "../geometry.js";
import { $, clamp, lerp, rand, randInt, fitCanvas, reducedMotion, ticker, debounce }
  from "../util.js";
import * as state from "../state.js";

let started = false;

/* ---------- small local helpers ---------- */

const cssNum = (name, fallback) => {
  const n = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name)
  );
  return Number.isFinite(n) ? n : fallback;
};

const cssStr = (name, fallback) => {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name).trim();
  return v || fallback;
};

function ensureLayer(node, fill = false) {
  const cs = getComputedStyle(node);
  if (cs.position === "static") {
    node.style.position = "absolute";
    if (fill && !node.style.left) node.style.inset = "0";
  }
  if (cs.pointerEvents !== "none") node.style.pointerEvents = "none";
}

function rgbOf(color, fallback = [255, 240, 220]) {
  const s = String(color).trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = s.match(/(\d+(?:\.\d+)?)/g);
  return rgb && rgb.length >= 3 ? rgb.slice(0, 3).map(Number) : fallback;
}

/** bounding box of the window glass, in plate space */
function glassBox() {
  const xs = WINDOW.glass.map((p) => p[0]);
  const ys = WINDOW.glass.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/* ============================================================
   1. DUST
   ============================================================ */

function initDust() {
  const cv = $("#fx-dust");
  if (!cv) return;
  ensureLayer(cv, true);

  const ctx = cv.getContext("2d", { alpha: true });
  const still = reducedMotion();
  const gb = glassBox();

  /* Where the light is. Motes cluster in the glass itself, in the
     wedge of daylight that lands out in the room, and around the desk
     lamp; everywhere else gets the thin ambient scatter. */
  const BLOBS = [
    { cx: gb.x + gb.w * 0.50, cy: gb.y + gb.h * 0.50,
      rx: gb.w * 0.72, ry: gb.h * 0.72, w: 1.00, tag: "sky" },
    { cx: gb.x + gb.w * 1.25, cy: gb.y + gb.h * 0.95,
      rx: gb.w * 0.95, ry: gb.h * 0.85, w: 0.85, tag: "sky" },
    { cx: LAMP.cx, cy: LAMP.cy,
      rx: LAMP.r * 1.5, ry: LAMP.r * 1.5, w: 0.70, tag: "lamp" },
  ];
  const BLOB_TOTAL = BLOBS.reduce((s, b) => s + b.w, 0);

  /** roughly normal, in about [-1.6, 1.6] */
  const bell = () => (rand(-1, 1) + rand(-1, 1) + rand(-1, 1)) / 1.9;

  const sprites = { sky: null, lamp: null, air: null };
  function buildSprites() {
    const tint = rgbOf(cssStr("--room-tint", "#ffd9a3"));
    sprites.sky = makeMote(tint);
    sprites.lamp = makeMote([255, 222, 170]);
    sprites.air = makeMote([246, 239, 230]);
  }

  function makeMote(rgb, size = 32) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const r = size / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    const col = (a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
    grd.addColorStop(0.0, col(1));
    grd.addColorStop(0.3, col(0.55));
    grd.addColorStop(1.0, col(0));
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  }
  buildSprites();

  function seed(p) {
    let tag = "air";
    if (Math.random() < 0.78) {
      let r = rand(0, BLOB_TOTAL);
      let b = BLOBS[0];
      for (const cand of BLOBS) { b = cand; r -= cand.w; if (r <= 0) break; }
      p.x = b.cx + b.rx * bell() * 0.55;
      p.y = b.cy + b.ry * bell() * 0.55;
      tag = b.tag;
    } else {
      p.x = rand(0, PLATE.w);
      p.y = rand(0, PLATE.h);
    }
    p.x = clamp(p.x, -20, PLATE.w + 20);
    p.y = clamp(p.y, -20, PLATE.h + 20);
    p.tag = tag;
    p.vx = rand(-0.003, 0.007);
    p.vy = rand(-0.004, 0.003);
    p.size = rand(0.7, 1.9);
    p.wf = rand(0.00035, 0.0011);
    p.wp = rand(0, 6.283);
    p.wa = rand(0.0015, 0.0045);
    p.max = rand(14000, 30000);
    p.life = 0;
    p.peak = rand(0.055, 0.22);
    return p;
  }

  const motes = [];
  function populate() {
    const w = cv.getBoundingClientRect().width || PLATE.w;
    const want = Math.round(clamp(w / 15, 34, 88));
    while (motes.length > want) motes.pop();
    while (motes.length < want) {
      const p = seed({});
      p.life = rand(0, p.max); // no synchronised bloom on the first frame
      motes.push(p);
    }
  }

  let dust = cssNum("--dust-strength", 1);
  let warmGain = state.get("lightsOn") === false ? 0.35 : 1;
  let s = 1; // backing-store px per plate px

  function remeasure() {
    fitCanvas(cv);
    s = cv.width / PLATE.w;
    populate();
  }
  remeasure();

  function draw(dt, t) {
    if (!cv.width) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = "lighter";

    // one shared breath of air, so the field moves as a whole
    const cur = 0.0018 * Math.sin(t * 0.000082) + 0.0011 * Math.sin(t * 0.00021 + 1.4);

    for (const p of motes) {
      if (dt) {
        p.life += dt;
        p.x += (p.vx + cur + Math.sin(t * p.wf + p.wp) * p.wa) * dt;
        p.y += p.vy * dt;
        if (
          p.life >= p.max ||
          p.x < -40 || p.x > PLATE.w + 40 ||
          p.y < -40 || p.y > PLATE.h + 40
        ) {
          // respawn from the density field rather than wrapping, so the
          // bias toward the light never washes out over time
          seed(p);
        }
      }

      const k = p.life / p.max;
      const fade =
        k < 0.09 ? k / 0.09 : k > 0.82 ? (1 - k) / 0.18 : 1;
      const a = p.peak * fade * dust * (p.tag === "lamp" ? warmGain : 1) * 0.55;
      if (a <= 0.004) continue;

      const r = p.size * s * 2.6;
      ctx.globalAlpha = a;
      ctx.drawImage(sprites[p.tag], p.x * s - r, p.y * s - r, r * 2, r * 2);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  if (still) {
    draw(0, 0);
  } else {
    ticker.add(draw);
  }

  state.on("weather", () => {
    dust = cssNum("--dust-strength", 1);
    buildSprites();
    if (still) draw(0, 0);
  });

  state.on("lightsOn", (v) => {
    warmGain = v === false ? 0.35 : 1;
    if (still) draw(0, 0);
  });

  addEventListener("resize", debounce(() => {
    remeasure();
    if (still) draw(0, 0);
  }, 140));
}

/* ============================================================
   2. THE CITY
   ============================================================ */

const CITY_COLS = [
  ["#ffc978", 0.30], ["#ffb457", 0.26], ["#ffdca6", 0.22],
  ["#fff1d2", 0.14], ["#a9c8ff", 0.08],
];

function initCity() {
  const host = $("#fx-city");
  if (!host) return;

  /* #fx-city lives inside #fx-window, so the band has to be expressed
     against the glass box rather than against the plate. */
  const gb = glassBox();
  const b = WINDOW.cityBand;
  Object.assign(host.style, {
    position: "absolute",
    left: `${((b.x - gb.x) / gb.w) * 100}%`,
    top: `${((b.y - gb.y) / gb.h) * 100}%`,
    width: `${(b.w / gb.w) * 100}%`,
    height: `${(b.h / gb.h) * 100}%`,
    pointerEvents: "none",
    transition: "opacity var(--t-slow, 0.9s) var(--ease, ease)",
  });
  host.replaceChildren();

  const still = reducedMotion();
  const COLS = 34;
  const ROWS = 15;
  const cw = 100 / COLS;
  const ch = 100 / ROWS;

  const anims = [];
  const wins = [];
  const taken = new Set();

  for (let i = 0; i < 40; i++) {
    let cell;
    let guard = 0;
    do {
      cell = randInt(0, COLS - 1) + randInt(0, ROWS - 1) * COLS;
    } while (taken.has(cell) && guard++ < 24);
    taken.add(cell);

    const col = cell % COLS;
    const row = (cell / COLS) | 0;
    const w = cw * rand(0.26, 0.5);
    const h = ch * rand(0.22, 0.44);

    let r = Math.random();
    let colour = CITY_COLS[0][0];
    for (const [c, p] of CITY_COLS) { colour = c; r -= p; if (r <= 0) break; }

    const outer = document.createElement("div");
    outer.className = "city-win";
    Object.assign(outer.style, {
      position: "absolute",
      left: `${col * cw + (cw - w) * rand(0.2, 0.8)}%`,
      top: `${row * ch + (ch - h) * rand(0.2, 0.8)}%`,
      width: `${w}%`,
      height: `${h}%`,
    });

    const base = rand(0.35, 1);
    const lit = document.createElement("div");
    lit.className = "city-win-lit";
    Object.assign(lit.style, {
      position: "absolute",
      inset: "0",
      background: colour,
      boxShadow: `0 0 4px ${colour}`,
      opacity: String(base * 0.8),
    });

    outer.append(lit);
    host.append(outer);
    wins.push(outer);

    if (!still) {
      anims.push(
        lit.animate(
          [{ opacity: base * 0.5 }, { opacity: base }, { opacity: base * 0.68 }],
          {
            duration: rand(4200, 11000),
            delay: -rand(0, 11000),
            iterations: Infinity,
            direction: "alternate",
            easing: "ease-in-out",
          }
        )
      );
    }
  }

  /** somebody switches a light off, then comes back to the room */
  function flick(node) {
    const off = rand(140, 900);
    const d = 90 + off + 300;
    node.animate(
      [
        { opacity: 1, offset: 0, easing: "ease-in" },
        { opacity: 0.05, offset: 90 / d },
        { opacity: 0.05, offset: (90 + off) / d, easing: "ease-out" },
        { opacity: 1, offset: 1 },
      ],
      { duration: d, fill: "none" }
    );
  }

  let timer = null;
  let hideTimer = null;

  function setNight(v) {
    host.style.opacity = String(v);
    const live = v > 0.02 && !still;

    clearTimeout(hideTimer);
    if (v > 0.02) {
      host.style.visibility = "visible";
    } else {
      hideTimer = setTimeout(() => { host.style.visibility = "hidden"; }, 1000);
    }

    for (const a of anims) live ? a.play() : a.pause();
    clearTimeout(timer);
    if (timer) timer = null;
    clearInterval(timer);
    timer = live
      ? setInterval(() => {
          if (Math.random() < 0.6) flick(wins[randInt(0, wins.length - 1)]);
        }, 2300)
      : null;
  }

  setNight(cssNum("--is-night", 0));
  state.on("weather", () => setNight(cssNum("--is-night", 0)));
}

/* ============================================================
   3. TV GLOW
   ============================================================ */

const TV_LEVEL = { off: 0, error: 0, loading: 0.55, static: 0.9, playing: 1 };

function initTvGlow() {
  const node = $("#fx-tvglow");
  if (!node) return;
  ensureLayer(node);

  if (getComputedStyle(node).backgroundImage === "none") {
    node.style.background =
      "radial-gradient(ellipse at 50% 50%," +
      " rgba(196,220,255,0.40) 0%," +
      " rgba(126,168,238,0.18) 40%," +
      " rgba(58,96,176,0.06) 66%," +
      " rgba(0,0,0,0) 84%)";
    node.style.mixBlendMode = "screen";
  }
  node.style.willChange = "opacity, transform";

  const still = reducedMotion();
  let target = TV_LEVEL[state.get("tv")] ?? 0;
  let env = target;
  let level = 1;
  let levelTarget = 1;
  let nextCut = 0;
  let stop = null;

  function tick(dt, t) {
    env += (target - env) * (1 - Math.exp(-dt / 260));

    const playing = state.get("tv") === "playing";
    if (playing) {
      // a picture that keeps changing: mostly slow wobble, with the
      // occasional step for a cut to a brighter or darker shot
      if (t > nextCut) {
        levelTarget = rand(0.80, 1.14);
        nextCut = t + rand(2600, 9000);
      }
      level += (levelTarget - level) * (1 - Math.exp(-dt / 240));
    } else {
      levelTarget = 1;
      level += (1 - level) * (1 - Math.exp(-dt / 400));
      nextCut = 0;
    }

    const wob = playing
      ? 1 + 0.035 * Math.sin(t * 0.0013) + 0.022 * Math.sin(t * 0.0029 + 1.3)
      : 1;
    const a = env * level * wob;

    node.style.opacity = a.toFixed(4);
    node.style.transform = `scale(${(0.98 + 0.02 * env + 0.008 * (level - 1)).toFixed(4)})`;

    if (!playing && Math.abs(target - env) < 0.002) {
      env = target;
      node.style.opacity = target.toFixed(4);
      if (target === 0) node.style.transform = "scale(0.98)";
      if (stop) { stop(); stop = null; }
    }
  }

  function applyStill() {
    node.style.transition = "opacity var(--t-mid, 0.36s) var(--ease, ease)";
    node.style.opacity = String(target);
    node.style.transform = "scale(1)";
  }

  if (still) {
    applyStill();
  } else {
    node.style.transition = "none";
    node.style.opacity = String(env);
  }

  state.on("tv", (v) => {
    target = TV_LEVEL[v] ?? 0;
    if (still) { applyStill(); return; }
    if (!stop) stop = ticker.add(tick);
  });
}

/* ============================================================ */

export function initAtmosFx() {
  if (started) return;
  started = true;
  initDust();
  initCity();
  initTvGlow();
}
