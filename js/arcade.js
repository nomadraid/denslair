/* ============================================================
   arcade.js — LAIR SNAKE.

   One game, two screens:

     · the cabinet in the corner (#arcade-screen). Tiny, never
       interactive, runs an attract loop: title card -> the game
       demoing itself -> score card -> repeat. Clicking the
       cabinet is the hotspot layer's job; it opens the panel.

     · the arcade panel, which hands us a big canvas through
       mountArcade() and lets someone actually play.

   Everything is drawn in a virtual pixel grid and scaled to
   whatever backing store the canvas ends up with, so the same
   code produces a legible 130px screen on the cabinet and a
   crisp 900px one in the panel. Rects are snapped to whole
   device pixels on the way out — that is what keeps the chunk.
   ============================================================ */

import { ARCADE } from "./geometry.js";
import { clamp, fitCanvas, reducedMotion, onMotionChange, ticker } from "./util.js";
import * as state from "./state.js";

/* ------------------------------------------------------------
   1. THE PIXEL FONT
   5x7 glyphs, one base32 digit per row, bit 4 = leftmost pixel.
   Generated from ASCII art; edit the art, not the table.
   ------------------------------------------------------------ */

const GW = 5, GH = 7, TRACK = 1, ADV = GW + TRACK;
const B32 = "0123456789abcdefghijklmnopqrstuv";

const FONT_SRC = {
  "0": "ehjlphe", "1": "4c4444e", "2": "eh1248v", "3": "v2421he", "4": "26aiv22",
  "5": "vgu11he", "6": "68guhhe", "7": "v124888", "8": "ehhehhe", "9": "ehhf12c",
  "A": "ehhvhhh", "B": "uhhuhhu", "C": "ehggghe", "D": "sihhhis", "E": "vgguggv",
  "F": "vgguggg", "G": "ehgnhhf", "H": "hhhvhhh", "I": "e44444e", "J": "72222ic",
  "K": "hikokih", "L": "ggggggv", "M": "hrllhhh", "N": "hhpljhh", "O": "ehhhhhe",
  "P": "uhhuggg", "Q": "ehhhlid", "R": "uhhukih", "S": "fgge11u", "T": "v444444",
  "U": "hhhhhhe", "V": "hhhhha4", "W": "hhhllrh", "X": "hha4ahh", "Y": "hha4444",
  "Z": "v1248gv", " ": "0000000", ".": "00000cc", ",": "0000cc8", ":": "0cc0cc0",
  "-": "000v000", "'": "4400000", "!": "4444404", "?": "eh12404", "/": "11248gg",
  "+": "044v440", "=": "00v0v00", "<": "248g842", ">": "8421248", "(": "6888886",
  ")": "c22222c", "*": "0level0",
};

/* Each glyph is flattened to horizontal runs [col,row,len,...] so a
   whole string is one path and one fill instead of 200 fillRects. */
const RUNS = Object.create(null);
for (const ch in FONT_SRC) {
  const packed = FONT_SRC[ch];
  const runs = [];
  for (let r = 0; r < GH; r++) {
    const bits = B32.indexOf(packed[r]);
    let c = 0;
    while (c < GW) {
      if (bits & (1 << (GW - 1 - c))) {
        let n = 1;
        while (c + n < GW && bits & (1 << (GW - 1 - c - n))) n++;
        runs.push(c, r, n);
        c += n;
      } else c++;
    }
  }
  RUNS[ch] = runs;
}

const textW = (str, s = 1) => (str.length ? str.length * ADV * s - TRACK * s : 0);
const pad = (n, w) => String(Math.max(0, Math.round(n))).padStart(w, "0");

/* ------------------------------------------------------------
   2. PALETTE + SCREEN LAYOUT
   ------------------------------------------------------------ */

const C = {
  void:     "#02050c",
  field:    "#060d1a",
  grid:     "rgba(96,180,235,0.055)",
  frame:    "#123049",
  frameLit: "rgba(110,225,255,0.34)",
  head:     "#e6ffff",
  body0:    "#5cebff",
  body1:    "#0c6c8f",
  food:     "#ffb14a",
  foodHi:   "#ffe6b0",
  ink:      "#a7e9ff",
  inkDim:   "rgba(126,196,232,0.52)",
  amber:    "#ffc35e",
  ember:    "#ff8a5c",
  flash:    "#dff6ff",
};

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const hexA = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; };

/* Precomputed body gradient — indexing a table beats building a
   colour string per segment per frame. */
const RAMP_N = 20;
const BODY_RAMP = (() => {
  const a = rgb(C.body0), b = rgb(C.body1), out = [];
  for (let i = 0; i < RAMP_N; i++) {
    const t = i / (RAMP_N - 1);
    out.push(`rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`);
  }
  return out;
})();

const CELL = 8;   // virtual px per grid cell
const PAD  = 4;   // bezel inside the screen
const HUD  = 12;  // score strip above the field
const INF  = 8;   // field background overdraw, so the shake never tears

/* The cabinet's grid is chosen so the virtual screen matches the
   painted screen's aspect — no letterbox on the artwork. */
const CAB_ASPECT = ARCADE.screen.w / ARCADE.screen.h;
const CAB_COLS = 23;
const CAB_ROWS = clamp(
  Math.round(((CAB_COLS * CELL + PAD * 2) / CAB_ASPECT - PAD * 2 - HUD) / CELL), 8, 20);

/* ------------------------------------------------------------
   3. TIMING
   ------------------------------------------------------------ */

const STEP_BASE  = 132;   // ms per step, level 1
const STEP_DEMO  = 152;   // the demo runs a touch slower; easier to read
const STEP_FLOOR = 62;
const STEP_GAIN  = 4.5;   // ms shaved per pellet

const COIN_MS   = 620;
const READY_MS  = 980;
const GO_AT     = 620;
const DEATH_MS  = 660;
const SHAKE_MS  = 420;
const POP_MS    = 260;
const DISSOLVE  = 26;     // ms per segment as the snake burns off
const TITLE_MS  = 3600;
const DEMO_MAX  = 22000;
const CARD_MS   = 1900;
const OVER_IDLE = 12000;
const START_LEN = 4;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/* ------------------------------------------------------------
   4. HIGH SCORE
   Stored as a record rather than a bare number so a signed-in
   sync can merge on `updated` later without a migration.
   ------------------------------------------------------------ */

function readScore() {
  const raw = (state.get("scores") || {}).snake;
  if (typeof raw === "number") return { best: raw, plays: 0, updated: null };
  return { best: 0, plays: 0, updated: null, ...(raw || {}) };
}

function writeScore(partial) {
  const rec = { ...readScore(), ...partial, updated: new Date().toISOString() };
  state.patch("scores", { snake: rec });
  return rec;
}

/* ------------------------------------------------------------
   5. THE GAME
   Pure state — knows nothing about canvases.
   ------------------------------------------------------------ */

const U = { x: 0, y: -1 }, D = { x: 0, y: 1 }, L = { x: -1, y: 0 }, R = { x: 1, y: 0 };
const DIRS = [U, R, D, L];

function createGame(cols, rows) {
  const g = {
    cols, rows,
    grid: new Uint8Array(cols * rows),
    scratch: new Uint8Array(cols * rows),
    stack: new Int32Array(cols * rows),
    snake: [], dir: R, pending: [],
    food: null,
    score: 0, eaten: 0, level: 1, best: 0, record: false,
    stepMs: STEP_BASE, stepAcc: 0,
    phase: "attract", t: 0,
    attract: { stage: "title", t: 0 },
    demo: true, paused: false,
    death: null, shake: null, flash: null, pops: [], scoreFlash: 0,
  };
  resetGame(g, true);
  return g;
}

function resetGame(g, demo) {
  g.grid.fill(0);
  g.snake.length = 0;
  const y = g.rows >> 1;
  const x0 = Math.max(START_LEN, Math.round(g.cols * 0.28));
  for (let i = 0; i < START_LEN; i++) {
    const c = { x: x0 - i, y };
    g.snake.push(c);
    g.grid[y * g.cols + c.x] = 1;
  }
  g.dir = R;
  g.pending.length = 0;
  g.score = 0; g.eaten = 0; g.level = 1; g.record = false;
  g.stepMs = demo ? STEP_DEMO : STEP_BASE;
  g.stepAcc = 0;
  g.pops.length = 0;
  g.death = null; g.shake = null; g.flash = null; g.scoreFlash = 0;
  g.demo = demo;
  g.paused = false;
  g.best = readScore().best || 0;
  placeFood(g);
}

function placeFood(g) {
  const n = g.cols * g.rows;
  let free = 0;
  for (let i = 0; i < n; i++) if (!g.grid[i]) free++;
  if (!free) { g.food = null; return; }
  let k = (Math.random() * free) | 0;
  for (let i = 0; i < n; i++) {
    if (g.grid[i]) continue;
    if (k-- === 0) { g.food = { x: i % g.cols, y: (i / g.cols) | 0 }; return; }
  }
}

function steerQueue(g, d) {
  const last = g.pending.length ? g.pending[g.pending.length - 1] : g.dir;
  if (d.x === -last.x && d.y === -last.y) return;
  if (d.x === last.x && d.y === last.y) return;
  if (g.pending.length < 2) g.pending.push(d);
}

function step(s) {
  const g = s.game;
  if (g.demo) {
    const d = aiDir(g);
    if (d) g.dir = d;
    else return kill(s);
  } else if (g.pending.length) {
    g.dir = g.pending.shift();
  }

  const head = g.snake[0];
  const nx = head.x + g.dir.x;
  const ny = head.y + g.dir.y;
  if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) return kill(s);

  const eating = g.food && g.food.x === nx && g.food.y === ny;
  const tail = g.snake[g.snake.length - 1];
  const intoTail = !eating && tail.x === nx && tail.y === ny;
  if (g.grid[ny * g.cols + nx] && !intoTail) return kill(s);

  if (!eating) {
    g.snake.pop();
    g.grid[tail.y * g.cols + tail.x] = 0;
  }
  g.snake.unshift({ x: nx, y: ny });
  g.grid[ny * g.cols + nx] = 1;

  if (eating) {
    g.eaten++;
    g.level = Math.min(9, 1 + ((g.eaten / 5) | 0));
    g.score += 10 * g.level;
    g.stepMs = Math.max(STEP_FLOOR, (g.demo ? STEP_DEMO : STEP_BASE) - g.eaten * STEP_GAIN);
    g.pops.push({ x: nx, y: ny, t: 0 });
    g.scoreFlash = 240;
    placeFood(g);
  }
}

function kill(s) {
  const g = s.game;
  if (g.death) return;
  g.death = { t: 0, demo: g.demo };
  if (!reducedMotion()) {
    g.shake = { t: 0 };
    g.flash = { t: 0, ms: 190, peak: 0.7, color: C.flash };
  }
  if (g.demo) return;
  const rec = readScore();
  g.record = g.score > (rec.best || 0);
  g.best = g.record ? writeScore({ best: g.score }).best : (rec.best || 0);
}

function resolveDeath(s) {
  const g = s.game;
  const wasDemo = g.death.demo;
  g.death = null;
  if (wasDemo) {
    g.phase = "attract";
    g.attract.stage = "card";
    g.attract.t = 0;
  } else {
    g.phase = "over";
    g.t = 0;
  }
}

function toAttract(s) {
  const g = s.game;
  resetGame(g, true);
  g.phase = "attract";
  g.attract.stage = "title";
  g.attract.t = 0;
}

/* ------------------------------------------------------------
   6. THE DEMO BRAIN
   Greedy toward the pellet, but only down moves that leave it
   enough room to turn around in. It plays well, not perfectly —
   a demo that never dies never shows the death flourish.
   ------------------------------------------------------------ */

const MISTAKE = 0.012;

function reachable(g, sx, sy, eating) {
  const { cols, rows, grid, scratch, stack } = g;
  scratch.set(grid);
  if (!eating) {
    const tail = g.snake[g.snake.length - 1];
    scratch[tail.y * cols + tail.x] = 0;
  }
  let sp = 0, count = 0;
  stack[sp++] = sy * cols + sx;
  scratch[sy * cols + sx] = 1;
  while (sp) {
    const i = stack[--sp];
    count++;
    const x = i % cols, y = (i / cols) | 0;
    if (x > 0 && !scratch[i - 1]) { scratch[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < cols - 1 && !scratch[i + 1]) { scratch[i + 1] = 1; stack[sp++] = i + 1; }
    if (y > 0 && !scratch[i - cols]) { scratch[i - cols] = 1; stack[sp++] = i - cols; }
    if (y < rows - 1 && !scratch[i + cols]) { scratch[i + cols] = 1; stack[sp++] = i + cols; }
  }
  return count;
}

function aiDir(g) {
  const head = g.snake[0];
  const tail = g.snake[g.snake.length - 1];
  const legal = [];
  for (const d of DIRS) {
    if (d.x === -g.dir.x && d.y === -g.dir.y) continue;
    const nx = head.x + d.x, ny = head.y + d.y;
    if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
    const eating = g.food && g.food.x === nx && g.food.y === ny;
    const intoTail = !eating && tail.x === nx && tail.y === ny;
    if (g.grid[ny * g.cols + nx] && !intoTail) continue;
    legal.push({ d, nx, ny, eating });
  }
  if (!legal.length) return null;
  if (legal.length > 1 && Math.random() < MISTAKE) {
    return legal[(Math.random() * legal.length) | 0].d;
  }

  let best = null, bestKey = -Infinity;
  for (const o of legal) {
    const room = reachable(g, o.nx, o.ny, o.eating);
    const need = Math.min(g.snake.length + 2, g.cols * g.rows - g.snake.length);
    const dist = g.food
      ? Math.abs(o.nx - g.food.x) + Math.abs(o.ny - g.food.y)
      : 0;
    const key = (room >= need ? 1e5 : 0) + room * 40 - dist * 3 + (o.d === g.dir ? 2 : 0);
    if (key > bestKey) { bestKey = key; best = o.d; }
  }
  return best;
}

/* ------------------------------------------------------------
   7. PAINTER
   Virtual units in, whole device pixels out.
   ------------------------------------------------------------ */

function makePainter() {
  return {
    ctx: null, sc: 1, ox: 0, oy: 0,
    X(v) { return Math.round(this.ox + v * this.sc); },
    Y(v) { return Math.round(this.oy + v * this.sc); },
    rect(x, y, w, h, fill) {
      const a = this.X(x), b = this.Y(y);
      const c = this.ctx;
      c.fillStyle = fill;
      c.fillRect(a, b, this.X(x + w) - a, this.Y(y + h) - b);
    },
    /** 1-virtual-px outline. */
    frame(x, y, w, h, fill) {
      this.rect(x, y, w, 1, fill);
      this.rect(x, y + h - 1, w, 1, fill);
      this.rect(x, y + 1, 1, h - 2, fill);
      this.rect(x + w - 1, y + 1, 1, h - 2, fill);
    },
    text(str, x, y, s, fill, align) {
      const up = str.toUpperCase();
      const w = textW(up, s);
      let tx = x;
      if (align === "center") tx = Math.round(x - w / 2);
      else if (align === "right") tx = Math.round(x - w);
      const c = this.ctx;
      c.fillStyle = fill;
      c.beginPath();
      for (let i = 0; i < up.length; i++) {
        const runs = RUNS[up[i]] || RUNS["?"];
        const gx = tx + i * ADV * s;
        for (let k = 0; k < runs.length; k += 3) {
          const a = this.X(gx + runs[k] * s);
          const b = this.Y(y + runs[k + 1] * s);
          c.rect(a, b,
            this.X(gx + (runs[k] + runs[k + 2]) * s) - a,
            this.Y(y + (runs[k + 1] + 1) * s) - b);
        }
      }
      c.fill();
    },
  };
}

/* Radial bloom sprites, one per colour, drawn with 'lighter'. */
const glowCache = new Map();
function glowSprite(color) {
  let cv = glowCache.get(color);
  if (cv) return cv;
  const S = 64;
  cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d");
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, hexA(color, 0.9));
  grad.addColorStop(0.34, hexA(color, 0.3));
  grad.addColorStop(1, hexA(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  glowCache.set(color, cv);
  return cv;
}

/* ------------------------------------------------------------
   8. LAYOUT + CACHES
   ------------------------------------------------------------ */

function layoutSurface(s) {
  const W = s.canvas.width, H = s.canvas.height;
  if (!W || !H) { s.field = null; return false; }
  s.vw = s.cols * CELL + PAD * 2;
  s.vh = s.rows * CELL + PAD * 2 + HUD;
  s.sc = Math.min(W / s.vw, H / s.vh);
  s.ox = Math.round((W - s.vw * s.sc) / 2);
  s.oy = Math.round((H - s.vh * s.sc) / 2);
  s.field = { x: PAD, y: PAD + HUD, w: s.cols * CELL, h: s.rows * CELL };
  buildCaches(s);
  return true;
}

function buildCaches(s) {
  const ctx = s.ctx, W = s.canvas.width, H = s.canvas.height;

  const vg = ctx.createRadialGradient(
    W / 2, H / 2, Math.min(W, H) * 0.26, W / 2, H / 2, Math.max(W, H) * 0.7);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(0.62, "rgba(0,0,0,0.16)");
  vg.addColorStop(1, "rgba(0,0,0,0.62)");
  s.vignette = vg;

  // scanlines only earn their keep once a virtual pixel is 2+ real ones
  s.scan = null;
  if (s.sc >= 2) {
    const period = clamp(Math.round(s.sc), 2, 4);
    const lc = document.createElement("canvas");
    lc.width = 1; lc.height = period;
    const l = lc.getContext("2d");
    l.fillStyle = "rgba(0,0,0,0.16)";
    l.fillRect(0, period - 1, 1, 1);
    s.scan = ctx.createPattern(lc, "repeat");
  }

  s.rollH = Math.max(8, Math.round(H * 0.24));
  const rg = ctx.createLinearGradient(0, 0, 0, s.rollH);
  rg.addColorStop(0, "rgba(180,235,255,0)");
  rg.addColorStop(0.5, "rgba(180,235,255,0.045)");
  rg.addColorStop(1, "rgba(180,235,255,0)");
  s.roll = rg;

  buildFieldBg(s);
}

/** The field floor and its dot grid, drawn once per resize. */
function buildFieldBg(s) {
  const f = s.field;
  const w = Math.ceil((f.w + INF * 2) * s.sc);
  const h = Math.ceil((f.h + INF * 2) * s.sc);
  if (w <= 0 || h <= 0 || w > 8192 || h > 8192) { s.bg = null; return; }
  const cv = s.bg && s.bg.width === w && s.bg.height === h
    ? s.bg : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const c = cv.getContext("2d");
  c.clearRect(0, 0, w, h);
  c.fillStyle = C.field;
  c.fillRect(0, 0, w, h);

  const p = s.dotPaint || (s.dotPaint = makePainter());
  p.ctx = c; p.sc = s.sc; p.ox = INF * s.sc; p.oy = INF * s.sc;
  c.fillStyle = C.grid;
  c.beginPath();
  for (let gy = 0; gy <= s.rows; gy++) {
    for (let gx = 0; gx <= s.cols; gx++) {
      const a = p.X(gx * CELL - 0.5), b = p.Y(gy * CELL - 0.5);
      c.rect(a, b, Math.max(1, Math.round(s.sc)), Math.max(1, Math.round(s.sc)));
    }
  }
  c.fill();
  s.bg = cv;
}

/* ------------------------------------------------------------
   9. RENDER
   ------------------------------------------------------------ */

function shakeOffset(g) {
  if (!g.shake) return 0;
  const k = 1 - g.shake.t / SHAKE_MS;
  return k * k * 4.5;
}

function render(s, now) {
  const ctx = s.ctx, cv = s.canvas;
  const W = cv.width, H = cv.height;
  if (!W || !H || !s.field) return;
  const g = s.game, p = s.paint, f = s.field;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = C.void;
  ctx.fillRect(0, 0, W, H);

  p.ctx = ctx; p.sc = s.sc; p.ox = s.ox; p.oy = s.oy;

  // screen edge, so a big panel canvas still reads as a screen
  p.frame(0, 0, s.vw, s.vh, "rgba(96,180,225,0.09)");

  drawHud(s, now);
  p.frame(f.x - 2, f.y - 2, f.w + 4, f.h + 4, C.frame);
  drawCorners(s);

  ctx.save();
  const fx = p.X(f.x), fy = p.Y(f.y);
  ctx.beginPath();
  ctx.rect(fx, fy, p.X(f.x + f.w) - fx, p.Y(f.y + f.h) - fy);
  ctx.clip();

  const amp = shakeOffset(g);
  const sx = amp ? Math.round(Math.sin(g.shake.t * 0.075) * amp) : 0;
  const sy = amp ? Math.round(Math.cos(g.shake.t * 0.113) * amp * 0.6) : 0;
  const ox0 = p.ox, oy0 = p.oy;
  p.ox += sx * s.sc; p.oy += sy * s.sc;

  if (s.bg) ctx.drawImage(s.bg, p.X(f.x - INF), p.Y(f.y - INF));
  drawPlay(s, now);

  p.ox = ox0; p.oy = oy0;
  drawOverlay(s, now);
  ctx.restore();

  drawCrt(s, now);
}

function drawCorners(s) {
  const p = s.paint, f = s.field;
  const x0 = f.x - 2, y0 = f.y - 2, x1 = f.x + f.w + 2, y1 = f.y + f.h + 2;
  const n = 4;
  p.rect(x0, y0, n, 1, C.frameLit); p.rect(x0, y0, 1, n, C.frameLit);
  p.rect(x1 - n, y0, n, 1, C.frameLit); p.rect(x1 - 1, y0, 1, n, C.frameLit);
  p.rect(x0, y1 - 1, n, 1, C.frameLit); p.rect(x0, y1 - n, 1, n, C.frameLit);
  p.rect(x1 - n, y1 - 1, n, 1, C.frameLit); p.rect(x1 - 1, y1 - n, 1, n, C.frameLit);
}

function drawHud(s, now) {
  const p = s.paint, g = s.game, f = s.field;
  const y = PAD + 3;
  const live = g.phase === "play" || g.phase === "over" || !!g.death;
  const hot = g.scoreFlash > 0;
  p.text("SCORE " + pad(g.score, 4), f.x, y, 1,
    hot ? C.flash : live ? C.ink : C.inkDim);
  p.text("HI " + pad(Math.max(g.best, g.demo ? 0 : g.score), 4), f.x + f.w, y, 1,
    C.amber, "right");
  const mid = g.demo && g.phase === "attract" && g.attract.stage === "demo"
    ? "DEMO" : "LV " + g.level;
  p.text(mid, f.x + f.w / 2, y, 1, C.inkDim, "center");
}

function drawPlay(s, now) {
  const g = s.game, ctx = s.ctx;
  const titling = g.phase === "attract" && g.attract.stage !== "demo";
  if (g.phase === "coin") return;

  ctx.globalAlpha = titling ? 0.3 : 1;
  if (g.food && !g.death) drawFood(s, now);
  for (const pop of g.pops) drawPop(s, pop);
  drawSnake(s, now);
  ctx.globalAlpha = 1;
}

function drawFood(s, now) {
  const p = s.paint, g = s.game, f = s.field, ctx = s.ctx;
  const x = f.x + g.food.x * CELL;
  const y = f.y + g.food.y * CELL;
  const pulse = reducedMotion() ? 0.5 : 0.5 + 0.5 * Math.sin(now / 260);

  const r = CELL * (1.9 + pulse * 0.4);
  const cx = x + CELL / 2, cy = y + CELL / 2;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha *= 0.42 + pulse * 0.22;
  ctx.drawImage(glowSprite(C.food),
    p.X(cx - r), p.Y(cy - r), p.X(cx + r) - p.X(cx - r), p.Y(cy + r) - p.Y(cy - r));
  ctx.restore();

  p.rect(x + 2, y + 1, 4, 6, C.food);
  p.rect(x + 1, y + 2, 6, 4, C.food);
  p.rect(x + 2, y + 2, 1, 1, C.foodHi);
}

function drawPop(s, pop) {
  const p = s.paint, f = s.field, ctx = s.ctx;
  const k = clamp(pop.t / POP_MS, 0, 1);
  const r = 2 + easeOutCubic(k) * 7;
  const cx = f.x + pop.x * CELL + CELL / 2;
  const cy = f.y + pop.y * CELL + CELL / 2;
  const a = Math.pow(1 - k, 1.6);
  const keep = ctx.globalAlpha;
  ctx.globalAlpha = keep * a;
  p.frame(cx - r, cy - r, r * 2, r * 2, C.foodHi);
  ctx.globalAlpha = keep;
}

function drawSnake(s, now) {
  const p = s.paint, g = s.game, f = s.field, ctx = s.ctx;
  const len = g.snake.length;
  if (!len) return;
  const cut = g.death ? Math.floor(g.death.t / DISSOLVE) : 0;
  const keep = ctx.globalAlpha;

  for (let i = len - 1; i >= 0; i--) {
    const seg = g.snake[i];
    const x = f.x + seg.x * CELL;
    const y = f.y + seg.y * CELL;

    if (i < cut) {
      // burning off, head first — a bright block that fades out
      const a = 1 - clamp((g.death.t - i * DISSOLVE) / 200, 0, 1);
      if (a <= 0) continue;
      ctx.globalAlpha = keep * a;
      p.rect(x + 1, y + 1, CELL - 2, CELL - 2, C.flash);
      ctx.globalAlpha = keep;
      continue;
    }

    const col = i === 0 ? C.head : BODY_RAMP[Math.min(RAMP_N - 1, Math.round(clamp(i / 16, 0, 1) * (RAMP_N - 1)))];

    if (i === 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = keep * 0.3;
      const r = CELL * 1.7, cx = x + CELL / 2, cy = y + CELL / 2;
      ctx.drawImage(glowSprite(C.body0),
        p.X(cx - r), p.Y(cy - r), p.X(cx + r) - p.X(cx - r), p.Y(cy + r) - p.Y(cy - r));
      ctx.restore();
      p.rect(x, y, CELL, CELL, col);
      drawEyes(p, x, y, g.dir);
    } else {
      p.rect(x + 1, y + 1, CELL - 2, CELL - 2, col);
      // bridge to the segment in front so the body reads as one animal
      const prev = g.snake[i - 1];
      if (i - 1 >= cut) {
        const dx = prev.x - seg.x, dy = prev.y - seg.y;
        if (dx === 1) p.rect(x + CELL - 1, y + 1, 2, CELL - 2, col);
        else if (dx === -1) p.rect(x - 1, y + 1, 2, CELL - 2, col);
        else if (dy === 1) p.rect(x + 1, y + CELL - 1, CELL - 2, 2, col);
        else if (dy === -1) p.rect(x + 1, y - 1, CELL - 2, 2, col);
      }
    }
  }
  ctx.globalAlpha = keep;
}

function drawEyes(p, x, y, d) {
  const ink = C.field;
  if (d.x === 1)       { p.rect(x + 6, y + 2, 1, 1, ink); p.rect(x + 6, y + 5, 1, 1, ink); }
  else if (d.x === -1) { p.rect(x + 1, y + 2, 1, 1, ink); p.rect(x + 1, y + 5, 1, 1, ink); }
  else if (d.y === -1) { p.rect(x + 2, y + 1, 1, 1, ink); p.rect(x + 5, y + 1, 1, 1, ink); }
  else                 { p.rect(x + 2, y + 6, 1, 1, ink); p.rect(x + 5, y + 6, 1, 1, ink); }
}

/* ---------- overlays ---------- */

function scrim(s, alpha) {
  const p = s.paint, f = s.field;
  p.rect(f.x, f.y, f.w, f.h, `rgba(3,7,16,${alpha})`);
}

function pulseA(now, period = 760) {
  if (reducedMotion()) return 1;
  return 0.34 + 0.66 * Math.pow(0.5 + 0.5 * Math.sin((now / period) * Math.PI * 2), 0.7);
}

function startWord(s) {
  return s.coarse && s.interactive ? "TAP TO START" : "PRESS START";
}

function drawPrompt(s, now, y, alt) {
  const p = s.paint, ctx = s.ctx, f = s.field;
  const txt = alt && Math.floor(now / 3000) % 2 === 1 ? "INSERT COIN" : startWord(s);
  const w = textW(txt, 1);
  const cx = f.x + f.w / 2;
  p.rect(cx - w / 2 - 3, y - 2, w + 6, GH + 4, "rgba(3,8,18,0.72)");
  const keep = ctx.globalAlpha;
  ctx.globalAlpha = keep * pulseA(now);
  p.text(txt, cx, y, 1, C.ink, "center");
  ctx.globalAlpha = keep;
}

function drawOverlay(s, now) {
  const g = s.game;
  switch (g.phase) {
    case "attract": drawAttract(s, now); break;
    case "coin":    drawCoin(s, now); break;
    case "ready":   drawReady(s, now); break;
    case "play":    if (g.paused) drawPaused(s, now); break;
    case "over":    drawOver(s, now); break;
  }
}

function drawAttract(s, now) {
  const g = s.game, p = s.paint, f = s.field;
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const bottom = f.y + f.h - 11;

  if (g.attract.stage === "demo") {
    if (!g.death) drawPrompt(s, now, bottom, true);
    return;
  }
  if (g.attract.stage === "card") {
    drawGameOverCard(s, now, g.score, g.best, false, false);
    return;
  }

  scrim(s, 0.62);
  p.text("SNAKE", cx + 1, cy - 16, 2, hexA(C.ember, 0.55), "center");
  p.text("SNAKE", cx, cy - 17, 2, C.ink, "center");
  p.text("BEST " + pad(g.best, 4), cx, cy + 5, 1, C.amber, "center");
  drawPrompt(s, now, bottom, true);
}

function drawCoin(s, now) {
  const g = s.game, p = s.paint, f = s.field;
  scrim(s, 0.86);
  const blink = reducedMotion() ? true : Math.floor(g.t / 62) % 2 === 0;
  if (!blink) return;
  p.text("CREDIT 01", f.x + f.w / 2, f.y + f.h / 2 - 7, 2, C.amber, "center");
}

function drawReady(s, now) {
  const g = s.game, p = s.paint, f = s.field, ctx = s.ctx;
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  scrim(s, 0.5);
  if (g.t < GO_AT) {
    p.text("READY", cx, cy - 7, 2, C.ink, "center");
    return;
  }
  const k = clamp((g.t - GO_AT) / (READY_MS - GO_AT), 0, 1);
  if (!reducedMotion()) {
    const r = 6 + easeOutCubic(k) * 26;
    ctx.globalAlpha = 1 - k;
    p.frame(cx - r, cy - r, r * 2, r * 2, C.frameLit);
    ctx.globalAlpha = 1;
  }
  p.text("GO", cx, cy - 10, 3, C.flash, "center");
}

function drawPaused(s, now) {
  const p = s.paint, f = s.field;
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  scrim(s, 0.74);
  p.text("PAUSED", cx, cy - 12, 2, C.ink, "center");
  p.text(s.coarse ? "TAP TO RESUME" : "PRESS P", cx, cy + 8, 1, C.inkDim, "center");
}

function drawOver(s, now) {
  const g = s.game;
  drawGameOverCard(s, now, g.score, g.best, g.record, g.t > 900);
}

function drawGameOverCard(s, now, score, best, record, prompt) {
  const p = s.paint, ctx = s.ctx, f = s.field;
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  scrim(s, 0.78);
  p.text("GAME OVER", cx, cy - 26, 2, C.ember, "center");
  p.text("SCORE " + pad(score, 4), cx, cy - 4, 1, C.ink, "center");
  if (record) {
    ctx.globalAlpha = pulseA(now, 520);
    p.text("NEW BEST", cx, cy + 7, 1, C.amber, "center");
    ctx.globalAlpha = 1;
  } else {
    p.text("BEST " + pad(best, 4), cx, cy + 7, 1, C.inkDim, "center");
  }
  if (prompt) drawPrompt(s, now, f.y + f.h - 11, false);
}

/* ---------- the glass ---------- */

function drawCrt(s, now) {
  const ctx = s.ctx, W = s.canvas.width, H = s.canvas.height, g = s.game;
  const flat = reducedMotion();

  if (s.scan) { ctx.fillStyle = s.scan; ctx.fillRect(0, 0, W, H); }

  if (!flat && s.roll) {
    const y = (((now / 7400) % 1.35) - 0.2) * H;
    ctx.save();
    ctx.translate(0, y);
    ctx.fillStyle = s.roll;
    ctx.fillRect(0, 0, W, s.rollH);
    ctx.restore();
  }

  ctx.fillStyle = s.vignette;
  ctx.fillRect(0, 0, W, H);

  if (g.flash) {
    const k = clamp(g.flash.t / g.flash.ms, 0, 1);
    ctx.globalAlpha = (1 - k) * (1 - k) * g.flash.peak;
    ctx.fillStyle = g.flash.color;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------------------------------------
   10. UPDATE
   ------------------------------------------------------------ */

function runSteps(s, dt) {
  const g = s.game;
  g.stepAcc += dt;
  let guard = 0;
  while (g.stepAcc >= g.stepMs && !g.death && guard++ < 4) {
    g.stepAcc -= g.stepMs;
    step(s);
  }
  if (guard >= 4) g.stepAcc = 0;
}

function update(s, dt, now) {
  const g = s.game;

  if (g.flash) { g.flash.t += dt; if (g.flash.t >= g.flash.ms) g.flash = null; }
  if (g.shake) { g.shake.t += dt; if (g.shake.t >= SHAKE_MS) g.shake = null; }
  if (g.scoreFlash > 0) g.scoreFlash = Math.max(0, g.scoreFlash - dt);
  for (let i = g.pops.length - 1; i >= 0; i--) {
    g.pops[i].t += dt;
    if (g.pops[i].t >= POP_MS) g.pops.splice(i, 1);
  }

  if (g.death) {
    g.death.t += dt;
    if (g.death.t >= DEATH_MS) resolveDeath(s);
    return;
  }

  switch (g.phase) {
    case "attract": {
      const a = g.attract;
      a.t += dt;
      if (a.stage === "title") {
        if (a.t >= TITLE_MS) { a.stage = "demo"; a.t = 0; resetGame(g, true); }
      } else if (a.stage === "demo") {
        if (a.t >= DEMO_MAX) kill(s);
        else runSteps(s, dt);
      } else if (a.t >= CARD_MS) {
        a.stage = "title"; a.t = 0; resetGame(g, true);
      }
      break;
    }
    case "coin":
      g.t += dt;
      if (g.t >= COIN_MS) { g.phase = "ready"; g.t = 0; }
      break;
    case "ready":
      g.t += dt;
      if (g.t >= READY_MS) {
        g.phase = "play"; g.t = 0; g.stepAcc = 0;
        writeScore({ plays: (readScore().plays || 0) + 1 });
      }
      break;
    case "play":
      if (!g.paused) runSteps(s, dt);
      break;
    case "over":
      g.t += dt;
      if (g.t >= (s.interactive ? OVER_IDLE : 2600)) toAttract(s);
      break;
  }
}

/* ------------------------------------------------------------
   11. SURFACES
   ------------------------------------------------------------ */

let cabinet = null;
let panel = null;
let wired = false;

function createSurface(canvas, { interactive, cols, rows }) {
  const s = {
    canvas,
    ctx: canvas.getContext("2d", { alpha: false }),
    paint: makePainter(),
    cols, rows,
    field: null, vw: 0, vh: 0, sc: 1, ox: 0, oy: 0,
    bg: null, scan: null, roll: null, rollH: 0, vignette: null,
    game: createGame(cols, rows),
    interactive: !!interactive,
    coarse: matchMedia("(pointer: coarse)").matches,
    intersecting: false,
    visible: false,
    needsFit: true,
    stopTick: null,
    io: null, ro: null,
    touch: null,
    onPointer: null,
  };
  s.tick = (dt, now) => {
    if (!ensureFit(s)) return;
    update(s, dt, now);
    render(s, now);
    // under reduced motion the surface only runs while a game is live
    if (reducedMotion()) syncTicker(s);
  };
  return s;
}

function ensureFit(s) {
  const resized = fitCanvas(s.canvas);
  if (resized || s.needsFit || !s.field) {
    s.needsFit = false;
    maybeRegrid(s);
    if (!layoutSurface(s)) return false;
  }
  return true;
}

function gridFor(canvas) {
  const r = canvas.getBoundingClientRect();
  const a = r.width && r.height ? r.width / r.height : 1.6;
  const rows = a < 1.05 ? 22 : 18;
  const vh = rows * CELL + PAD * 2 + HUD;
  const cols = clamp(Math.round((vh * a - PAD * 2) / CELL), 16, 42);
  return { cols, rows };
}

/** The panel canvas can be any shape; refit the grid when it is safe to. */
function maybeRegrid(s) {
  if (s !== panel) return;
  const g = s.game;
  if (g.phase === "play" || g.phase === "ready" || g.phase === "coin" || g.death) return;
  const { cols, rows } = gridFor(s.canvas);
  if (cols === s.cols && rows === s.rows) return;
  s.cols = cols; s.rows = rows;
  s.game = createGame(cols, rows);
  s.bg = null;
}

function observe(s) {
  if (typeof IntersectionObserver === "function") {
    s.io = new IntersectionObserver((entries) => {
      for (const e of entries) s.intersecting = e.isIntersecting;
      refreshVisibility();
    }, { threshold: 0.01 });
    s.io.observe(s.canvas);
  } else {
    s.intersecting = true;
  }
  if (typeof ResizeObserver === "function") {
    s.ro = new ResizeObserver(() => { s.needsFit = true; drawOnce(s); });
    s.ro.observe(s.canvas);
  }
  refreshVisibility();
  drawOnce(s);
}

/** One frame outside the ticker: first paint, resize, reduced motion. */
function drawOnce(s) {
  if (s.stopTick) return;
  if (!ensureFit(s)) return;
  render(s, performance.now());
}

function syncTicker(s) {
  const live = !reducedMotion() || (s.interactive && s.game.phase !== "attract");
  const want = s.visible && live;
  if (want && !s.stopTick) {
    s.stopTick = ticker.add(s.tick);
  } else if (!want && s.stopTick) {
    s.stopTick();
    s.stopTick = null;
    if (s.visible) drawOnce(s);
  }
}

function refreshVisibility() {
  const hidden = document.hidden;
  if (cabinet) {
    cabinet.visible = cabinet.intersecting && !hidden
      && !state.get("panel") && !state.get("cinema");
    syncTicker(cabinet);
  }
  if (panel) {
    panel.visible = panel.intersecting && !hidden;
    if (!panel.visible && panel.game.phase === "play") panel.game.paused = true;
    syncTicker(panel);
  }
}

function teardown(s) {
  if (s.stopTick) { s.stopTick(); s.stopTick = null; }
  s.io?.disconnect();
  s.ro?.disconnect();
  if (s.onPointer) {
    for (const [type, fn] of s.onPointer) s.canvas.removeEventListener(type, fn);
    s.onPointer = null;
  }
  s.bg = null;
}

/* ------------------------------------------------------------
   12. INPUT
   ------------------------------------------------------------ */

const DIR_KEYS = {
  ArrowUp: U, ArrowDown: D, ArrowLeft: L, ArrowRight: R,
  w: U, s: D, a: L, d: R,
  k: U, j: D, h: L, l: R,
};

function isTyping(node) {
  if (!node) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function requestStart(s) {
  const g = s.game;
  if (g.phase === "play") {
    if (g.paused) g.paused = false;
    return;
  }
  if (g.death) return;
  if (g.phase === "coin" || g.phase === "ready") return;
  resetGame(g, false);
  g.phase = "coin";
  g.t = 0;
  if (!reducedMotion()) g.flash = { t: 0, ms: 140, peak: 0.5, color: C.amber };
  syncTicker(s);
}

function togglePause(s) {
  const g = s.game;
  if (g.phase !== "play" || g.death) return;
  g.paused = !g.paused;
}

function onKey(e) {
  const s = panel;
  if (!s || !s.interactive || !s.visible) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTyping(e.target) || isTyping(document.activeElement)) return;

  const d = DIR_KEYS[e.key] || DIR_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (d) {
    e.preventDefault();
    const g = s.game;
    if (g.phase === "attract" || g.phase === "over") requestStart(s);
    else if (g.phase === "play" && !g.paused) steerQueue(g, d);
    return;
  }
  if (e.key === " " || e.key === "Spacebar" || e.key === "Enter") {
    e.preventDefault();
    requestStart(s);
    return;
  }
  if (e.key === "p" || e.key === "P") {
    e.preventDefault();
    togglePause(s);
  }
}

const SWIPE = 22;

function bindPointer(s) {
  const cv = s.canvas;
  const down = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    cv.setPointerCapture?.(e.pointerId);
    s.touch = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    if (e.pointerType !== "mouse") e.preventDefault();
  };
  const move = (e) => {
    const t = s.touch;
    if (!t || t.id !== e.pointerId) return;
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    if (Math.abs(dx) < SWIPE && Math.abs(dy) < SWIPE) return;
    const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? R : L) : (dy > 0 ? D : U);
    const g = s.game;
    if (g.phase === "attract" || g.phase === "over") requestStart(s);
    else if (g.phase === "play" && !g.paused) steerQueue(g, d);
    t.x = e.clientX; t.y = e.clientY; t.moved = true;
  };
  const up = (e) => {
    const t = s.touch;
    s.touch = null;
    if (!t || t.id !== e.pointerId) return;
    if (t.moved) return;
    if (performance.now() - t.t > 500) return;
    requestStart(s);
  };
  const pairs = [["pointerdown", down], ["pointermove", move],
                 ["pointerup", up], ["pointercancel", up]];
  for (const [type, fn] of pairs) cv.addEventListener(type, fn, { passive: false });
  s.onPointer = pairs;
}

/* ------------------------------------------------------------
   13. PUBLIC API
   ------------------------------------------------------------ */

function wireGlobals() {
  if (wired) return;
  wired = true;
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", refreshVisibility);
  state.on("panel", (v) => {
    if (v !== "arcade") stopArcade();
    refreshVisibility();
  });
  state.on("cinema", refreshVisibility);
  onMotionChange(() => {
    for (const s of [cabinet, panel]) {
      if (!s) continue;
      s.needsFit = true;
      syncTicker(s);
      drawOnce(s);
    }
  });
}

/** The cabinet in the corner. Attract loop only — it is 130px wide. */
export function initArcade() {
  const cv = document.getElementById("arcade-screen");
  if (!cv || cabinet) return;
  wireGlobals();
  cabinet = createSurface(cv, { interactive: false, cols: CAB_COLS, rows: CAB_ROWS });
  observe(cabinet);
}

/**
 * Hand the arcade panel's canvas over to the game.
 * `opts.interactive` false gives a demo-only screen.
 * Returns the teardown function; stopArcade() does the same job.
 */
export function mountArcade(canvas, opts = {}) {
  if (!canvas || typeof canvas.getContext !== "function") return () => {};
  stopArcade();
  wireGlobals();

  const interactive = opts.interactive !== false;
  const { cols, rows } = gridFor(canvas);
  panel = createSurface(canvas, { interactive, cols, rows });

  canvas.style.touchAction = "none";
  if (interactive) {
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label",
      "snake. arrows or wasd to steer, space to start, p to pause.");
    bindPointer(panel);
  } else {
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "snake, playing itself");
  }

  observe(panel);
  return stopArcade;
}

/** Called when the arcade panel closes. Safe to call at any time. */
export function stopArcade() {
  if (!panel) return;
  teardown(panel);
  panel = null;
  refreshVisibility();
}
