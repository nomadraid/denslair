/* ============================================================
   fx/fire.js — the fireplace.

   The plate already paints a lit firebox. This adds the two things
   a still image cannot do: the pool of warm light breathing on the
   floorboards and the beanbag, and embers coming off the logs.

   Nothing here uses Math.random() per frame. Fire read from across
   a room is slow — a few long waves beating against each other with
   a lazy drift on top. Per-frame noise strobes, which is the one
   thing real firelight never does.
   ============================================================ */

import { FIRE, PLATE } from "../geometry.js";
import { $, clamp, rand, randInt, fitCanvas, reducedMotion, ticker, debounce }
  from "../util.js";
import * as state from "../state.js";

/* Time constants for the on/off envelope. Lighting a fire is quicker
   than losing one, so the two directions are not symmetric. */
const TAU_UP = 210;
const TAU_DOWN = 380;

const EMBER_COLS = ["#ffdca8", "#ffae5c", "#ff7a43"];
const EMBER_MAX = 30;
/** steady-state emission, embers per millisecond */
const EMBER_RATE = 0.0062;

let started = false;

/* ---------- small local helpers ---------- */

const cssNum = (name, fallback) => {
  const n = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name)
  );
  return Number.isFinite(n) ? n : fallback;
};

function ensureLayer(node) {
  const cs = getComputedStyle(node);
  if (cs.position === "static") node.style.position = "absolute";
  if (cs.pointerEvents !== "none") node.style.pointerEvents = "none";
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Firelight, as a number in [-1, 1].
 *
 * Three sines whose periods share no small common multiple, so the sum
 * never visibly repeats, plus a slow walk that retargets a few times a
 * second and is eased into rather than jumped to. The walk is what stops
 * the result sounding like a machine; the easing is what stops it
 * looking like noise.
 */
function makeFlicker() {
  const w = [0.00097, 0.00234, 0.00541];
  const ph = [rand(0, 6.283), rand(0, 6.283), rand(0, 6.283)];
  let walk = 0;
  let target = 0;
  let until = 0;

  return (dt, t) => {
    if (t > until) {
      target = rand(-1, 1);
      until = t + rand(240, 560);
    }
    walk += (target - walk) * (1 - Math.exp(-dt / 170));
    const s =
      0.50 * Math.sin(t * w[0] + ph[0]) +
      0.32 * Math.sin(t * w[1] + ph[1]) +
      0.18 * Math.sin(t * w[2] + ph[2]);
    return clamp(0.70 * s + 0.30 * walk, -1, 1);
  };
}

/** Soft round sprite, so embers are dots of light rather than aliased discs. */
function makeSprite(color, size = 64) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = size / 2;
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  grd.addColorStop(0.00, rgba(color, 1));
  grd.addColorStop(0.16, rgba(color, 0.92));
  grd.addColorStop(0.42, rgba(color, 0.26));
  grd.addColorStop(1.00, rgba(color, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

/* ============================================================ */

export function initFireFx() {
  if (started) return;
  const light = $("#fx-firelight");
  const cv = $("#fx-embers");
  if (!light && !cv) return;
  started = true;

  const still = reducedMotion();
  let strength = cssNum("--fire-strength", 1);
  let on = state.get("fireOn") !== false;

  /* ---------- the spill of light ---------- */

  if (light) {
    ensureLayer(light);
    // Only paint it ourselves if the stylesheet left it blank.
    if (getComputedStyle(light).backgroundImage === "none") {
      light.style.background =
        "radial-gradient(ellipse at 50% 44%," +
        " rgba(255,176,92,0.46) 0%," +
        " rgba(255,124,52,0.24) 34%," +
        " rgba(206,72,28,0.09) 62%," +
        " rgba(0,0,0,0) 82%)";
      light.style.mixBlendMode = "screen";
    }
    light.style.willChange = "opacity, transform";
  }

  /* ---------- embers ---------- */

  const ctx = cv ? cv.getContext("2d", { alpha: true }) : null;
  if (cv) {
    ensureLayer(cv);
    fitCanvas(cv);
  }

  const sprites = ctx ? EMBER_COLS.map((c) => makeSprite(c)) : [];
  const parts = [];

  /* Plate space -> canvas backing store. #room carries the parallax
     transform, but so does the canvas inside it, so measuring both and
     working with the difference stays correct at any scale. */
  const m = { ok: false, s: 1, ox: 0, oy: 0, dpr: 1, topY: 0 };

  function measure() {
    if (!cv) return false;
    const room = $("#room");
    if (!room) return false;
    const rr = room.getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    if (!rr.width || !cr.width || !cv.width) {
      m.ok = false;
      return false;
    }
    m.s = rr.width / PLATE.w;
    m.ox = cr.left - rr.left;
    m.oy = cr.top - rr.top;
    m.dpr = cv.width / cr.width;
    m.topY = m.oy / m.s; // plate y of the canvas top edge
    m.ok = true;
    return true;
  }
  measure();

  const toX = (x) => (x * m.s - m.ox) * m.dpr;
  const toY = (y) => (y * m.s - m.oy) * m.dpr;

  function spawn(hot) {
    if (parts.length >= EMBER_MAX) return;
    const spread = FIRE.box.w * (hot ? 0.34 : 0.26);
    parts.push({
      x: FIRE.core.cx + rand(-spread, spread),
      y: FIRE.core.cy + rand(-8, 16),
      vx: rand(-0.006, 0.006) * (hot ? 2.2 : 1),
      vy: -(hot ? rand(0.048, 0.092) : rand(0.022, 0.052)),
      life: 0,
      max: hot ? rand(900, 1900) : rand(1500, 3000),
      size: hot ? rand(1.0, 2.4) : rand(0.85, 2.0),
      wf: rand(0.0016, 0.0042),
      wp: rand(0, 6.283),
      wa: rand(0.004, 0.012),
      col: sprites[randInt(0, sprites.length - 1)],
    });
  }

  /* ---------- state ---------- */

  const flicker = makeFlicker();
  let env = on ? 1 : 0;
  let emitAcc = 0;
  let nextBurst = 0;
  let stop = null;

  function start() {
    if (stop || still) return;
    stop = ticker.add(tick);
  }

  function halt() {
    if (!stop) return;
    stop();
    stop = null;
  }

  function tick(dt, t) {
    env += (on ? 1 - env : -env) * (1 - Math.exp(-dt / (on ? TAU_UP : TAU_DOWN)));

    const f = flicker(dt, t);
    const breath = 0.5 + 0.5 * Math.sin(t * 0.00058);

    if (light) {
      const a = env * strength * (0.82 + 0.13 * f + 0.06 * breath);
      // as the fire dies the pool of light contracts as well as dims
      const sc = (1 + 0.028 * f + 0.018 * breath) * (0.94 + 0.06 * env);
      light.style.opacity = a.toFixed(4);
      light.style.transform = `scale(${sc.toFixed(4)})`;
    }

    if (ctx) {
      if (!m.ok && !measure()) return;

      if (on) {
        emitAcc += dt * EMBER_RATE * strength * (0.75 + 0.45 * (f * 0.5 + 0.5));
        while (emitAcc >= 1) {
          emitAcc -= 1;
          spawn(false);
        }
        // every so often a log settles and throws a handful up at once
        if (t > nextBurst) {
          if (nextBurst) for (let i = randInt(5, 11); i--; ) spawn(true);
          nextBurst = t + rand(6500, 17000);
        }
      }

      // one shared current, so the embers drift together like real air
      const cur =
        0.005 * Math.sin(t * 0.00041) + 0.003 * Math.sin(t * 0.00097 + 2.2);

      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.globalCompositeOperation = "lighter";

      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life += dt;
        p.vy *= 1 - 0.00035 * dt; // cools, so the rise tails off
        p.x += (p.vx + cur + Math.sin(t * p.wf + p.wp) * p.wa) * dt;
        p.y += p.vy * dt;

        const k = p.life / p.max;
        if (k >= 1 || p.y < m.topY - 12) {
          parts.splice(i, 1);
          continue;
        }

        const a =
          (k < 0.1 ? k / 0.1 : Math.pow(1 - (k - 0.1) / 0.9, 1.7)) *
          env * clamp(strength, 0, 1) * 0.9;
        if (a <= 0.004) continue;

        const r = p.size * (1 - 0.55 * k) * m.s * m.dpr * 3.0;
        ctx.globalAlpha = a;
        ctx.drawImage(p.col, toX(p.x) - r, toY(p.y) - r, r * 2, r * 2);
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    if (!on && env < 0.004 && !parts.length) {
      if (light) light.style.opacity = "0";
      if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
      halt();
    }
  }

  /** Reduced motion: one honest frame, eased by CSS when the fire is toggled. */
  function applyStill() {
    if (light) {
      light.style.transition = "opacity var(--t-slow, 0.9s) var(--ease, ease)";
      light.style.transform = "scale(1)";
      light.style.opacity = String(on ? strength * 0.86 : 0);
    }
    if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
  }

  if (still) {
    applyStill();
  } else {
    if (light) light.style.transition = "none";
    start();
  }

  /* ---------- wiring ---------- */

  state.on("fireOn", (v) => {
    on = v !== false;
    if (still) { applyStill(); return; }
    if (on) {
      // a poke sends something up straight away
      nextBurst = 0;
      emitAcc = 1;
    }
    start();
  });

  state.on("weather", () => {
    strength = cssNum("--fire-strength", 1);
    if (still) applyStill();
    else start(); // a strength change needs at least one frame to land
  });

  addEventListener(
    "resize",
    debounce(() => {
      if (!cv) return;
      fitCanvas(cv);
      measure();
      if (still) applyStill();
    }, 120)
  );
}
