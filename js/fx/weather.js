/* ============================================================
   fx/weather.js — the view through the window.

   Everything is drawn into #fx-weather. scene.js has already sized
   that canvas over the glass and masked its container against the
   indoor occluders, so nothing here clips: the mask does it.

   Internal coordinates are "glass units": y runs 0..1 down the
   glass box, x runs 0..aspect across it. Keeping both normalised to
   the same divisor (H) means angles, speeds and radii stay isotropic
   and resolution independent — multiply by H to reach device pixels.
   ============================================================ */

import { WINDOW } from "../geometry.js";
import { $, clamp, lerp, rand, randInt, reducedMotion, onMotionChange, ticker, fitCanvas }
  from "../util.js";
import * as state from "../state.js";

const TAU = Math.PI * 2;
const root = document.documentElement;

/* ---------- the glass box, derived from the polygon ---------- */
const gys = WINDOW.glass.map((p) => p[1]);
const BOX_Y = Math.min(...gys);
const BOX_H = Math.max(...gys) - BOX_Y;

/** sky band expressed as a fraction of the box height */
const SKY_TOP = (WINDOW.sky.y - BOX_Y) / BOX_H;
const SKY_BOT = (WINDOW.sky.y + WINDOW.sky.h - BOX_Y) / BOX_H;
/** where the haze starts dissolving into the rooftops below it */
const SKY_FADE = lerp(SKY_TOP, SKY_BOT, 0.42);

/* ---------- tuning ---------- */

/* three depth layers. windMul is how hard each one leans; the spread
   between vy bands is what reads as parallax. */
const LAYERS = [
  { n: 110, len: [0.030, 0.058], vy: [0.75, 1.05], w: [0.0016, 0.0027], a: [0.05, 0.11], windMul: 0.40, soft: 0 },
  { n:  66, len: [0.058, 0.104], vy: [1.25, 1.75], w: [0.0026, 0.0042], a: [0.10, 0.20], windMul: 0.72, soft: 0 },
  { n:  32, len: [0.112, 0.196], vy: [2.10, 3.00], w: [0.0055, 0.0098], a: [0.16, 0.30], windMul: 1.00, soft: 1 },
];

const X_MARGIN = 0.15;      // how far past each edge a drop may wander

const MAX_BEADS = 78;
const MAX_RUNNERS = 3;
const MAX_TRAILS = 6;
const TRAIL_LIFE = 1.7;     // seconds a wet streak stays visible
const TRAIL_STEP = 0.032;   // distance between recorded trail points

const RAIN_WASH = "rgba(146,174,204,0.055)";
const TRAIL_COL = "rgba(206,226,248,1)";

const CLOUD_COUNT = 5;
const CLOUD_TINT = { light: "222,232,243", dark: "104,124,148" };

/* ============================================================
   sprites — built once, on the first frame that needs them
   ============================================================ */

let streakSprites = null;   // [crisp, soft]
let beadSprites = null;     // three slight variants
let cloudShapes = null;     // puff specs, shared between tints
const cloudSprites = {};    // tint -> [canvas]

const surface = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

/** A tapered streak: soft at both ends, brightest just behind the head. */
function makeStreak(soft) {
  const w = 24, h = 160;
  const c = surface(w, h);
  const g = c.getContext("2d");

  const along = g.createLinearGradient(0, 0, 0, h);
  along.addColorStop(0.00, "rgba(255,255,255,0)");
  along.addColorStop(0.18, "rgba(255,255,255,0.28)");
  along.addColorStop(0.62, "rgba(255,255,255,0.70)");
  along.addColorStop(0.90, "rgba(255,255,255,1)");
  along.addColorStop(1.00, "rgba(255,255,255,0)");
  g.fillStyle = along;
  g.fillRect(0, 0, w, h);

  // lateral falloff. The near layer gets a pure gaussian-ish ramp with
  // no plateau, which is what makes it read as slightly out of focus.
  g.globalCompositeOperation = "destination-in";
  const across = g.createLinearGradient(0, 0, w, 0);
  if (soft) {
    across.addColorStop(0.00, "rgba(0,0,0,0)");
    across.addColorStop(0.26, "rgba(0,0,0,0.22)");
    across.addColorStop(0.50, "rgba(0,0,0,1)");
    across.addColorStop(0.74, "rgba(0,0,0,0.22)");
    across.addColorStop(1.00, "rgba(0,0,0,0)");
  } else {
    across.addColorStop(0.00, "rgba(0,0,0,0)");
    across.addColorStop(0.30, "rgba(0,0,0,0.35)");
    across.addColorStop(0.45, "rgba(0,0,0,1)");
    across.addColorStop(0.55, "rgba(0,0,0,1)");
    across.addColorStop(0.70, "rgba(0,0,0,0.35)");
    across.addColorStop(1.00, "rgba(0,0,0,0)");
  }
  g.fillStyle = across;
  g.fillRect(0, 0, w, h);

  g.globalCompositeOperation = "source-atop";
  g.fillStyle = "rgb(214,231,250)";
  g.fillRect(0, 0, w, h);
  return c;
}

/** A bead: dark refracting core, specular top-left, focused crescent
    bottom-right. At six pixels across only the contrast survives, and
    that contrast is the whole trick. */
function makeBead(variant) {
  const S = 64, R = 26, cx = 32, cy = 32;
  const c = surface(S, S);
  const g = c.getContext("2d");

  const hx = cx - R * (0.30 + variant * 0.06);
  const hy = cy - R * (0.36 - variant * 0.07);

  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, TAU);
  g.clip();

  const body = g.createRadialGradient(hx, hy, R * 0.06, cx, cy, R * 1.02);
  body.addColorStop(0.00, "rgba(198,220,242,0.22)");
  body.addColorStop(0.38, "rgba(28,42,58,0.20)");
  body.addColorStop(0.80, "rgba(10,18,28,0.34)");
  body.addColorStop(1.00, "rgba(6,12,20,0.44)");
  g.fillStyle = body;
  g.fillRect(0, 0, S, S);

  const fx = cx + R * 0.50, fy = cy + R * 0.54;
  const focus = g.createRadialGradient(fx, fy, R * 0.05, fx, fy, R * 0.66);
  focus.addColorStop(0.00, "rgba(232,244,255,0.58)");
  focus.addColorStop(0.50, "rgba(198,220,246,0.20)");
  focus.addColorStop(1.00, "rgba(198,220,246,0)");
  g.fillStyle = focus;
  g.fillRect(0, 0, S, S);
  g.restore();

  const spec = g.createRadialGradient(hx, hy, 0, hx, hy, R * 0.40);
  spec.addColorStop(0.00, "rgba(255,255,255,0.74)");
  spec.addColorStop(0.45, "rgba(255,255,255,0.22)");
  spec.addColorStop(1.00, "rgba(255,255,255,0)");
  g.fillStyle = spec;
  g.beginPath();
  g.arc(hx, hy, R * 0.40, 0, TAU);
  g.fill();

  g.strokeStyle = "rgba(214,232,255,0.18)";
  g.lineWidth = Math.max(1, R * 0.07);
  g.beginPath();
  g.arc(cx, cy, R * 0.965, 0, TAU);
  g.stroke();
  return c;
}

function makeCloudShapes() {
  const shapes = [];
  for (let i = 0; i < 3; i++) {
    const puffs = [];
    const n = randInt(6, 9);
    for (let j = 0; j < n; j++) {
      puffs.push({
        x: rand(0.10, 0.90),
        y: rand(0.40, 0.62),
        rx: rand(0.16, 0.34),
        sq: rand(0.34, 0.55),
      });
    }
    shapes.push(puffs);
  }
  return shapes;
}

function makeCloud(puffs, rgb) {
  const w = 192, h = 96;
  const c = surface(w, h);
  const g = c.getContext("2d");
  for (const p of puffs) {
    const rx = p.rx * w;
    g.save();
    g.translate(p.x * w, p.y * h);
    g.scale(1, p.sq);
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    rg.addColorStop(0.00, `rgba(${rgb},0.30)`);
    rg.addColorStop(0.55, `rgba(${rgb},0.13)`);
    rg.addColorStop(1.00, `rgba(${rgb},0)`);
    g.fillStyle = rg;
    g.beginPath();
    g.arc(0, 0, rx, 0, TAU);
    g.fill();
    g.restore();
  }
  return c;
}

function ensureSprites() {
  if (!streakSprites) streakSprites = [makeStreak(0), makeStreak(1)];
  if (!beadSprites) beadSprites = [makeBead(0), makeBead(1), makeBead(2)];
  if (!cloudShapes) cloudShapes = makeCloudShapes();
}

function cloudSet(tint) {
  if (!cloudSprites[tint]) {
    cloudSprites[tint] = cloudShapes.map((p) => makeCloud(p, CLOUD_TINT[tint]));
  }
  return cloudSprites[tint];
}

/* ============================================================
   the wind field
   ============================================================ */

/* One gust eases into the next over 6-12s. `now` adds a little
   high-frequency flutter on top so the angle never sits perfectly
   still even mid-transition. */
const wind = { base: 0.35, from: 0.35, to: 0.35, t: 0, dur: 8, now: 0.35 };

function newGust() {
  wind.from = wind.base;
  wind.to = rand(-0.55, 1.05);
  wind.dur = rand(6, 12);
  wind.t = 0;
}

function updateWind(s, tSec) {
  wind.t += s;
  if (wind.t >= wind.dur) newGust();
  const p = clamp(wind.t / wind.dur, 0, 1);
  const e = p * p * p * (p * (p * 6 - 15) + 10); // smootherstep: no kick at either end
  wind.base = lerp(wind.from, wind.to, e);
  wind.now = wind.base
    + Math.sin(tSec * 0.83) * 0.035
    + Math.sin(tSec * 1.97 + 1.3) * 0.018;
}

/* ============================================================
   falling rain
   ============================================================ */

let drops = [];

function seedDrop(d, L, anywhere) {
  d.len = rand(L.len[0], L.len[1]);
  d.vy = rand(L.vy[0], L.vy[1]);
  d.w = rand(L.w[0], L.w[1]);
  d.a = rand(L.a[0], L.a[1]);
  d.jit = rand(0.82, 1.18);
  if (anywhere) {
    d.x = rand(-X_MARGIN, A + X_MARGIN);
    d.y = rand(-0.2, 1.05);
  } else {
    d.y = -rand(0.02, 0.22);
  }
}

function buildDrops() {
  drops = LAYERS.map((L) => {
    const arr = new Array(L.n);
    for (let i = 0; i < L.n; i++) {
      const d = {};
      seedDrop(d, L, true);
      arr[i] = d;
    }
    return arr;
  });
}

function stepRain(s, flash) {
  const boost = 1 + flash * 0.9;
  const span = A + X_MARGIN * 2;

  for (let li = 0; li < LAYERS.length; li++) {
    const L = LAYERS[li];
    const sprite = streakSprites[L.soft];
    const arr = drops[li];
    const w = wind.now * L.windMul;

    for (let i = 0; i < arr.length; i++) {
      const d = arr[i];
      const vx = w * d.jit;
      d.x += vx * s;
      d.y += d.vy * s;
      if (d.y - d.len > 1) seedDrop(d, L, false);
      // toroidal in x, so density stays even however hard it is blowing
      d.x = (((d.x + X_MARGIN) % span) + span) % span - X_MARGIN;

      const sp = Math.sqrt(vx * vx + d.vy * d.vy);
      const ux = vx / sp, uy = d.vy / sp;
      const len = d.len * H, wd = d.w * H;
      const hx = d.x * H, hy = d.y * H;

      ctx.globalAlpha = d.a > 1 / boost ? 1 : d.a * boost;
      // maps the sprite's unit box onto the streak: x across, y along
      ctx.setTransform(-uy * wd, ux * wd, ux * len, uy * len, hx - ux * len, hy - uy * len);
      ctx.drawImage(sprite, -0.5, 0, 1, 1);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* ============================================================
   water on the glass: beads, runners, trails
   ============================================================ */

let beads = [];
let runners = [];
let trails = [];
let beadTimer = 0;
let runTimer = 0;

function newBead(x, y, r) {
  return {
    x, y, r,
    rMax: rand(0.019, 0.030),
    // heavy-tailed: most beads barely swell, a few are candidates to run
    grow: 0.0016 * Math.pow(Math.random(), 2.6),
    a: rand(0.62, 1),
    s: randInt(0, 2),
    sag: 0,
  };
}

function spawnBead() {
  if (beads.length >= MAX_BEADS) return;
  beads.push(newBead(rand(0, A), rand(-0.02, 1.02), rand(0.0045, 0.013)));
}

function seedBeads(n) {
  for (let i = 0; i < n; i++) {
    const b = newBead(rand(0, A), rand(-0.02, 1.02), rand(0.005, 0.019));
    b.r = Math.min(b.r, b.rMax);
    beads.push(b);
  }
}

function runnerX(r) {
  // the wiggle is a function of y, not time, so the drop appears to be
  // following a channel in the water film rather than wandering
  return r.x0
    + Math.sin(r.y * 21 + r.seed) * 0.0055
    + Math.sin(r.y * 53 + r.seed * 1.7) * 0.0022
    + wind.now * 0.008;
}

function launchRunner() {
  if (runners.length >= MAX_RUNNERS || trails.length >= MAX_TRAILS) return;
  let best = -1, bestR = 0.014;
  for (let i = 0; i < beads.length; i++) {
    const b = beads[i];
    if (b.y > 0.86 || b.r <= bestR) continue;
    best = i;
    bestR = b.r;
  }
  if (best < 0) return;
  const b = beads.splice(best, 1)[0];
  const trail = { pts: [], done: false };
  trails.push(trail);
  runners.push({
    x0: b.x, y: b.y, r: b.r, s: b.s,
    vy: 0.02, stall: 0, seed: rand(0, 100), moved: 0, trail,
  });
}

function stepGlass(s) {
  // accumulate
  beadTimer -= s;
  if (beadTimer <= 0) {
    beadTimer = rand(0.08, 0.34);
    spawnBead();
  }
  for (let i = 0; i < beads.length; i++) {
    const b = beads[i];
    if (b.r < b.rMax) b.r = Math.min(b.rMax, b.r + b.grow * s);
    // a bead close to breaking loose visibly droops
    b.sag = clamp((b.r - b.rMax * 0.62) / (b.rMax * 0.38), 0, 1) * 0.34;
  }

  runTimer -= s;
  if (runTimer <= 0) {
    runTimer = rand(1.9, 5.4);
    launchRunner();
  }

  for (let i = runners.length - 1; i >= 0; i--) {
    const r = runners[i];

    if (r.stall > 0) {
      r.stall -= s;
      r.vy *= Math.pow(0.02, s);
    } else {
      r.vy += 0.30 * (r.r / 0.022) * s;
      r.vy *= Math.pow(0.55, s);
      // small drops snag on the film far more often than fat ones
      if (Math.random() < 1.4 * (0.020 / r.r) * s) r.stall = rand(0.09, 0.55);
    }
    r.y += r.vy * s;
    const rx = runnerX(r);

    // absorb whatever it runs through
    for (let j = beads.length - 1; j >= 0; j--) {
      const b = beads[j];
      const dy = b.y - r.y;
      if (dy < -0.05 || dy > 0.05) continue;
      const reach = r.r + b.r;
      const dx = b.x - rx;
      if (dx * dx + dy * dy > reach * reach) continue;
      r.r = Math.min(0.05, Math.cbrt(r.r * r.r * r.r + b.r * b.r * b.r));
      r.vy += 0.05;
      beads.splice(j, 1);
    }

    // leave part of itself behind, and thin out as it goes
    r.moved += r.vy * s;
    if (r.moved > TRAIL_STEP) {
      r.moved = 0;
      r.trail.pts.push({ x: rx, y: r.y, w: r.r * 0.5, life: 1 });
      if (Math.random() < 0.5 && beads.length < MAX_BEADS) {
        const rest = newBead(rx + rand(-0.004, 0.004), r.y - 0.012, r.r * rand(0.16, 0.30));
        rest.grow *= 0.4;
        beads.push(rest);
        r.r *= 0.968;
      }
    }

    if (r.y - r.r > 1.03) {
      r.trail.done = true;
      runners.splice(i, 1);
    }
  }

  // trails fade from the top down, oldest point first
  for (let i = trails.length - 1; i >= 0; i--) {
    const pts = trails[i].pts;
    for (let j = 0; j < pts.length; j++) pts[j].life -= s / TRAIL_LIFE;
    while (pts.length && pts[0].life <= 0) pts.shift();
    if (!pts.length && trails[i].done) trails.splice(i, 1);
  }
}

function drawTrails() {
  ctx.strokeStyle = TRAIL_COL;
  ctx.lineCap = "round";
  for (const tr of trails) {
    const pts = tr.pts;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], q = pts[i - 1];
      const lf = p.life;
      if (lf <= 0) continue;
      ctx.globalAlpha = 0.26 * lf;
      ctx.lineWidth = Math.max(0.7, p.w * H * (0.30 + 0.70 * lf));
      ctx.beginPath();
      ctx.moveTo(q.x * H, q.y * H);
      ctx.lineTo(p.x * H, p.y * H);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawBeads(flash) {
  const boost = 1 + flash * 0.7;
  for (const b of beads) {
    const R = b.r * H;
    const w = R * 2;
    ctx.globalAlpha = Math.min(1, b.a * boost);
    ctx.drawImage(beadSprites[b.s], b.x * H - R, b.y * H - R, w, w * (1 + b.sag));
  }
  for (const r of runners) {
    const R = r.r * H;
    const stretch = 1 + clamp(r.vy * 0.55, 0, 1);
    ctx.globalAlpha = Math.min(1, 0.95 * boost);
    ctx.drawImage(beadSprites[r.s], runnerX(r) * H - R, r.y * H - R, R * 2, R * 2 * stretch);
  }
  ctx.globalAlpha = 1;
}

/* ============================================================
   cloud haze over the sky band
   ============================================================ */

let clouds = [];

function buildClouds() {
  clouds = [];
  for (let i = 0; i < CLOUD_COUNT; i++) {
    clouds.push({
      i: i % 3,
      x: rand(-0.4, A + 0.4),
      y: rand(SKY_TOP + 0.06, SKY_BOT - 0.09),
      scale: rand(0.50, 1.00),
      alpha: rand(0.55, 1),
      speed: rand(0.010, 0.026),
    });
  }
}

function stepClouds(s) {
  for (const c of clouds) {
    c.x += c.speed * (0.70 + 0.50 * wind.now) * s;
    const half = c.scale * 0.5;
    if (c.x - half > A) {
      c.x = -half;
      c.y = rand(SKY_TOP + 0.06, SKY_BOT - 0.09);
      c.scale = rand(0.50, 1.00);
      c.alpha = rand(0.55, 1);
    }
  }
}

function drawClouds(tint, strength) {
  const set = cloudSet(tint);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, SKY_BOT * H);
  ctx.clip();

  for (const c of clouds) {
    const cw = c.scale * H;
    const ch = cw * 0.5;
    ctx.globalAlpha = c.alpha * strength;
    ctx.drawImage(set[c.i], c.x * H - cw * 0.5, c.y * H - ch * 0.5, cw, ch);
  }

  // dissolve the band into the rooftops rather than ending it on a line
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "destination-out";
  const fade = ctx.createLinearGradient(0, SKY_FADE * H, 0, SKY_BOT * H);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, SKY_FADE * H, W, (SKY_BOT - SKY_FADE) * H);
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}

/* ============================================================
   lightning
   ============================================================ */

const bolt = { wait: 0, live: false, t: 0, dur: 0, mag: 0, v: 0 };
let flashGrad = null;
let lastVar = -1;

/** bright, dip, brighter, decay — over a few hundred milliseconds */
function envelope(p) {
  if (p < 0.06) {
    const q = p / 0.06;
    return 1 - (1 - q) * (1 - q) * (1 - q);
  }
  if (p < 0.20) return lerp(1, 0.22, (p - 0.06) / 0.14);
  if (p < 0.28) return lerp(0.22, 0.92, (p - 0.20) / 0.08);
  const q = (p - 0.28) / 0.72;
  return 0.92 * Math.pow(1 - q, 2.4) * (0.86 + 0.14 * Math.cos(q * 34));
}

function armBolt(first) {
  // the first one comes sooner so a short visit still gets to see one
  bolt.wait = first ? rand(6, 16) : rand(12, 40);
  bolt.live = false;
  bolt.t = 0;
  bolt.v = 0;
}

function setLightning(v) {
  const q = Math.round(v * 1000) / 1000;
  if (q === lastVar) return;
  lastVar = q;
  root.style.setProperty("--lightning", String(q));
}

function stepBolt(s) {
  if (bolt.live) {
    bolt.t += s;
    const p = bolt.t / bolt.dur;
    if (p >= 1) {
      armBolt(false);
    } else {
      bolt.v = clamp(envelope(p) * bolt.mag, 0, 1);
    }
  } else {
    bolt.wait -= s;
    if (bolt.wait <= 0) {
      bolt.live = true;
      bolt.t = 0;
      bolt.dur = rand(0.32, 0.54);
      bolt.mag = rand(0.42, 1);
    }
  }
  setLightning(bolt.v);
  return bolt.v;
}

function buildFlashGradient() {
  if (!W || !H) return;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.00, "rgba(210,226,252,0.44)");
  g.addColorStop(0.45, "rgba(190,210,244,0.24)");
  g.addColorStop(1.00, "rgba(168,194,236,0.08)");
  flashGrad = g;
}

function drawFlash(v) {
  if (v <= 0.002 || !flashGrad) return;
  ctx.globalAlpha = v;
  ctx.fillStyle = flashGrad;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
}

/* ============================================================
   canvas + mode machine
   ============================================================ */

let cv = null;
let ctx = null;
let W = 0, H = 0, A = 1;
let mode = "sunny";
let stopTick = null;
let observer = null;
let teardown = null;

function clear() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, W, H);
}

function resetRain(animated) {
  beads = [];
  runners = [];
  trails = [];
  beadTimer = 0;
  runTimer = rand(2.5, 5);
  seedBeads(Math.round(MAX_BEADS * (animated ? 0.55 : 0.68)));
  if (animated) buildDrops();
  else drops = [];
}

function tick(dt, t) {
  if (!W || !H) return;
  const s = dt / 1000;
  updateWind(s, t / 1000);

  clear();

  if (mode === "cloudy") {
    stepClouds(s);
    drawClouds("light", 0.18);
    return;
  }

  const flash = stepBolt(s);

  stepClouds(s);
  drawClouds("dark", 0.30);

  ctx.fillStyle = RAIN_WASH;
  ctx.fillRect(0, 0, W, H);

  stepRain(s, flash);
  stepGlass(s);
  drawTrails();
  drawBeads(flash);
  drawFlash(flash);
}

/** One frame, no motion: what the glass looks like, held still. */
function renderStill() {
  if (!W || !H) return;
  clear();
  if (mode === "cloudy") {
    drawClouds("light", 0.18);
    return;
  }
  if (mode !== "rainy") return;

  drawClouds("dark", 0.30);
  ctx.fillStyle = RAIN_WASH;
  ctx.fillRect(0, 0, W, H);

  // two streaks that have already run, and the beads left over
  for (let i = 0; i < 2; i++) {
    const x0 = rand(A * 0.18, A * 0.82);
    const seed = rand(0, 100);
    const top = rand(0.05, 0.30);
    const bot = top + rand(0.30, 0.55);
    const pts = [];
    for (let y = top; y < bot; y += TRAIL_STEP) {
      pts.push({
        x: x0 + Math.sin(y * 21 + seed) * 0.0055 + Math.sin(y * 53 + seed * 1.7) * 0.0022,
        y,
        w: 0.012,
        life: lerp(0.18, 0.85, (y - top) / (bot - top)),
      });
    }
    trails.push({ pts, done: true });
    const head = pts[pts.length - 1];
    if (head) {
      const b = newBead(head.x, head.y + 0.01, rand(0.020, 0.028));
      b.sag = 0.3;
      beads.push(b);
    }
  }

  drawTrails();
  drawBeads(0);
}

function rescaleX(f) {
  for (const b of beads) b.x *= f;
  for (const r of runners) r.x0 *= f;
  for (const tr of trails) for (const p of tr.pts) p.x *= f;
  for (const c of clouds) c.x *= f;
}

function apply(next) {
  mode = next;
  if (stopTick) { stopTick(); stopTick = null; }
  setLightning(0);
  if (W && H) clear();

  if (mode !== "cloudy" && mode !== "rainy") {
    beads = []; runners = []; trails = []; drops = []; clouds = [];
    return;
  }

  ensureSprites();
  buildClouds();
  if (mode === "rainy") resetRain(!reducedMotion());
  else { beads = []; runners = []; trails = []; drops = []; }

  if (reducedMotion()) {
    renderStill();
  } else {
    newGust();
    if (mode === "rainy") armBolt(true);
    stopTick = ticker.add(tick);
  }
}

function onResize() {
  if (!cv) return;
  fitCanvas(cv);
  const w = cv.width, h = cv.height;
  if (!w || !h) { W = 0; H = 0; return; }
  const had = W > 0 && H > 0;
  const oldA = A;
  W = w; H = h; A = W / H;
  buildFlashGradient();
  // first real size, or a resize while parked: rebuild rather than patch
  if (!had) { apply(mode); return; }
  if (A !== oldA) rescaleX(A / oldA);
  if (!stopTick) renderStill();
}

export function initWeatherFx() {
  if (teardown) teardown();

  cv = $("#fx-weather");
  if (!cv) return;
  ctx = cv.getContext("2d", { alpha: true });
  if (!ctx) return;

  setLightning(0);
  onResize();

  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(onResize);
    observer.observe(cv);
  } else {
    addEventListener("resize", onResize);
  }

  const offWeather = state.on("weather", apply, true);
  onMotionChange(() => apply(mode));

  teardown = () => {
    offWeather();
    if (stopTick) { stopTick(); stopTick = null; }
    observer?.disconnect();
    observer = null;
    removeEventListener("resize", onResize);
    setLightning(0);
    teardown = null;
  };
}
