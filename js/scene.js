/* ============================================================
   scene.js — the stage itself.

   Owns four things:
     1. fitting the plate box into the viewport (contain, never crop)
     2. positioning every geometry-driven container exactly once
     3. the day/night crossfade and colour grade
     4. pointer parallax and the idle fade of the chrome

   Everything here works in plate space and converts to percentages,
   so the room stays pixel-accurate at any window size.
   ============================================================ */

import { PLATE, TV, SHELF, ARCADE, FIRE, WINDOW, LAMP, PATCHES, rectToCss, px }
  from "./geometry.js";
import { $, el, clamp, lerp, reducedMotion, ticker, debounce } from "./util.js";
import * as state from "./state.js";

/* ---------- 1. fitting ---------- */

const frame = $("#frame");
const stage = $("#stage");

function fitFrame() {
  if (!frame) return;
  const vw = stage.clientWidth;
  const vh = stage.clientHeight;
  // contain: the whole room is always visible, letterbox handled by #ambilight
  const narrow = vw < 760 || vw / vh < 1.15;
  document.body.dataset.narrow = narrow ? "true" : "false";

  const w = narrow ? vw : Math.min(vw, vh * PLATE.ratio);
  const h = w / PLATE.ratio;
  frame.style.width = `${w}px`;
  // narrow: the room is a block at the top of a scrolling page, so the
  // frame must grow to fit the chrome stacked beneath it
  frame.style.height = narrow ? "auto" : `${h}px`;
  document.documentElement.style.setProperty("--room-w", `${w}px`);
  document.documentElement.style.setProperty("--room-h", `${h}px`);
}

/* ---------- 2. positioning ---------- */

/** Apply a plate-space rect to an element as percentages. */
function place(node, rect, rot = 0) {
  if (!node) return;
  Object.assign(node.style, rectToCss(rect));
  if (rot) {
    node.style.transform = `rotate(${rot}deg)`;
    node.style.transformOrigin = "50% 50%";
  }
}

/** Centre-anchored variant, for the rotated screens. */
function placeCentred(node, { cx, cy, w, h, rot = 0, skew = 0 }) {
  if (!node) return;
  Object.assign(node.style, rectToCss({ x: cx - w / 2, y: cy - h / 2, w, h }));
  node.style.transformOrigin = "50% 50%";
  node.style.transform =
    `rotate(${rot}deg)` + (skew ? ` skewX(${skew}deg)` : "");
}

/** Radial glow blob centred on a point. */
function placeGlow(node, { cx, cy, rx, ry }) {
  place(node, { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 });
}

function layout() {
  placeCentred($("#tv-zone"), TV.screen);
  placeGlow($("#fx-tvglow"), TV.glow);

  // the eject/cinema buttons ride just under the screen's lower-right corner
  const [, , br] = TV.quad;
  place($("#tv-controls"), { x: br[0] - 92, y: br[1] + 6, w: 92, h: 26 });

  placeCentred($("#arcade-zone"), ARCADE.screen);

  place($("#shelf-zone"), {
    x: SHELF.x0, y: 40, w: SHELF.width, h: 520,
  });

  // window weather: bounding box of the glass polygon
  const xs = WINDOW.glass.map((p) => p[0]);
  const ys = WINDOW.glass.map((p) => p[1]);
  const gx = Math.min(...xs), gy = Math.min(...ys);
  place($("#fx-window"), {
    x: gx, y: gy, w: Math.max(...xs) - gx, h: Math.max(...ys) - gy,
  });
  // #fx-city is a child of #fx-window, so plate-space percentages would
  // resolve against the wrong box. fx/atmos.js positions it itself.

  placeGlow($("#fx-lamp"), { cx: LAMP.cx, cy: LAMP.cy, rx: LAMP.r, ry: LAMP.r });
  placeGlow($("#fx-firelight"), FIRE.spill);
  place($("#fx-embers"), {
    x: FIRE.box.x - 20, y: FIRE.box.y - 90, w: FIRE.box.w + 40, h: FIRE.box.h + 100,
  });

  // the neon strip sits above the TV, on the wall
  place($("#neon-tv"), { x: TV.screen.cx - 150, y: 128, w: 300, h: 46 }, -1.7);

  for (const [name, spec] of Object.entries(PATCHES)) {
    place($(`#patch-${name}`), spec.region);
  }

  buildGlassMask();
}

/* ---------- the window mask ----------
   Rain is drawn across the whole glass box, then masked so it only
   shows through actual glass — never over the lamp, the bonsai or
   the mullion, which are all indoors and in front of the window. */
function buildGlassMask() {
  const host = $("#fx-window");
  if (!host || document.getElementById("glass-mask-svg")) return;

  const xs = WINDOW.glass.map((p) => p[0]);
  const ys = WINDOW.glass.map((p) => p[1]);
  const ox = Math.min(...xs), oy = Math.min(...ys);
  const w = Math.max(...xs) - ox, h = Math.max(...ys) - oy;
  const o = WINDOW.occluders;

  const rel = (p) => `${p[0] - ox},${p[1] - oy}`;
  const svg = `
<svg id="glass-mask-svg" width="0" height="0" aria-hidden="true">
  <defs>
    <mask id="glass-mask" maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox">
      <g transform="scale(${1 / w}, ${1 / h})">
        <polygon points="${WINDOW.glass.map(rel).join(" ")}" fill="#fff"/>
        <rect x="${o.mullion.x - ox}" y="${o.mullion.y - oy}"
              width="${o.mullion.w}" height="${o.mullion.h}" fill="#000"/>
        <ellipse cx="${o.lampHead.cx - ox}" cy="${o.lampHead.cy - oy}"
                 rx="${o.lampHead.rx}" ry="${o.lampHead.ry}" fill="#000"/>
        <polygon points="${o.lampArm.map(rel).join(" ")}" fill="#000"/>
        <ellipse cx="${o.bonsaiTop.cx - ox}" cy="${o.bonsaiTop.cy - oy}"
                 rx="${o.bonsaiTop.rx}" ry="${o.bonsaiTop.ry}" fill="#000"/>
        <rect x="${o.bonsaiPot.x - ox}" y="${o.bonsaiPot.y - oy}"
              width="${o.bonsaiPot.w}" height="${o.bonsaiPot.h}" fill="#000"/>
      </g>
    </mask>
  </defs>
</svg>`;
  document.body.insertAdjacentHTML("beforeend", svg);
  host.style.mask = "url(#glass-mask)";
  host.style.webkitMask = "url(#glass-mask)";
}

/* ---------- 3. day / night ---------- */

/** Each preset is a full description of the room's light. */
/* The two plates were generated independently, so they are NOT
   pixel-aligned with one another: the same TV bezel edge sits at
   x=587 on the day plate and x=596 on the night plate, the shelf
   post drifts 16px, the poster 12px the other way. Showing both at
   partial opacity double-exposes every hard edge in the room.

   So `night` is deliberately binary. Daylight moods are made from
   the day plate plus a grade; only the night preset swaps plates,
   and that swap goes through a short dip to black (see `dip`) so
   the two images are never on screen together.

   If the night plate is ever regenerated as an edit of the day
   plate rather than a fresh render, these can go back to being
   fractional and the dip can be dropped. */
export const PRESETS = {
  sunny: {
    night: 0, label: "SUNNY", temp: 24, ico: "sun",
    grade: "transparent", gradeBlend: "normal", gradeAlpha: 0,
    lamp: 0.25, fire: 0.55, dust: 1, tint: "#ffd9a3",
  },
  cloudy: {
    night: 0, label: "OVERCAST", temp: 16, ico: "cloud",
    grade: "#5c6d84", gradeBlend: "soft-light", gradeAlpha: 0.78,
    lamp: 0.6, fire: 0.72, dust: 0.55, tint: "#c8d3e0",
  },
  rainy: {
    night: 0, label: "RAINY", temp: 13, ico: "rain",
    grade: "#2c3e57", gradeBlend: "soft-light", gradeAlpha: 1,
    lamp: 0.85, fire: 0.88, dust: 0.3, tint: "#9fb6cc",
  },
  night: {
    night: 1, label: "NIGHT", temp: 9, ico: "moon",
    grade: "#0d1830", gradeBlend: "soft-light", gradeAlpha: 0.3,
    lamp: 1, fire: 1, dust: 0.7, tint: "#7d93c4",
  },
};

export const preset = () => PRESETS[state.get("weather")] || PRESETS.sunny;

/* A short dip to black, used only when the plates actually swap.
   Reads as the light in the room changing, and means the two
   misaligned images are never both visible. */
let dipNode = null;
function dip(swap) {
  if (!dipNode) {
    dipNode = el("div", { class: "room-dip", "aria-hidden": "true" });
    $("#room")?.append(dipNode);
  }
  if (reducedMotion()) { swap(); return; }
  dipNode.classList.add("is-down");
  setTimeout(() => {
    swap();
    // give the browser a frame to paint the new plate before lifting
    requestAnimationFrame(() =>
      requestAnimationFrame(() => dipNode.classList.remove("is-down")));
  }, 250);
}

let lastNight = null;

function applyPreset(name) {
  const p = PRESETS[name] || PRESETS.sunny;
  const swapping = lastNight !== null && lastNight !== p.night;
  lastNight = p.night;
  if (swapping) dip(() => paintPreset(p, name));
  else paintPreset(p, name);
}

function paintPreset(p, name) {
  const root = document.documentElement;

  $(".plate--night")?.style.setProperty("opacity", String(p.night));

  const grade = $("#grade");
  if (grade) {
    grade.style.background = p.grade;
    grade.style.mixBlendMode = p.gradeBlend;
    grade.style.opacity = String(p.gradeAlpha);
  }

  // effects read these rather than the preset object, so they can be
  // eased in CSS rather than stepped
  root.style.setProperty("--lamp-strength", String(p.lamp));
  root.style.setProperty("--fire-strength", String(p.fire));
  root.style.setProperty("--dust-strength", String(p.dust));
  root.style.setProperty("--room-tint", p.tint);
  root.style.setProperty("--is-night", String(p.night));

  document.body.dataset.weather = name;
  $("#ambilight")?.style.setProperty("--bleed-opacity", String(0.5 - p.night * 0.25));

  // fx/patches.js clones the plate, so it has to swap on exactly the
  // same frame we do — not when the weather state changed, which may
  // be a quarter of a second earlier if a dip is running
  document.dispatchEvent(new CustomEvent("lair:plate", { detail: { night: p.night } }));
}

/* ---------- 4. parallax + idle ---------- */

const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
let parallaxStop = null;

function startParallax() {
  if (parallaxStop || reducedMotion()) return;
  const room = $("#room");
  if (!room) return;

  const onMove = (e) => {
    const r = stage.getBoundingClientRect();
    pointer.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    pointer.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  window.addEventListener("pointermove", onMove, { passive: true });

  const tick = () => {
    // A transform on #room would make it the containing block for the
    // fixed-position TV in cinema mode, so drop it entirely while
    // cinema is on rather than fighting it in CSS.
    if (state.get("cinema")) {
      if (room.style.transform) room.style.transform = "";
      return;
    }
    pointer.x = lerp(pointer.x, pointer.tx, 0.055);
    pointer.y = lerp(pointer.y, pointer.ty, 0.055);
    // scale a touch so the edges never reveal the backdrop
    room.style.transform =
      `scale(1.018) translate3d(${(-pointer.x * 0.52).toFixed(3)}%, ${(-pointer.y * 0.42).toFixed(3)}%, 0)`;
    // the view through the window shifts a little further, for depth
    const win = $("#fx-window");
    if (win) win.style.setProperty("--par-x", `${(-pointer.x * 0.9).toFixed(2)}%`);
  };
  const remove = ticker.add(tick);
  parallaxStop = () => {
    remove();
    window.removeEventListener("pointermove", onMove);
    room.style.transform = "";
    parallaxStop = null;
  };
}

/* the chrome dims itself when nothing has happened for a while */
const IDLE_AFTER = 4200;
let idleTimer = null;

function poke() {
  if (state.get("idle")) state.set("idle", false);
  clearTimeout(idleTimer);
  if (state.get("panel") || state.get("cinema")) return;
  idleTimer = setTimeout(() => state.set("idle", true), IDLE_AFTER);
}

export function wakeChrome() { poke(); }

/* ---------- boot ---------- */

export function initScene() {
  fitFrame();
  layout();
  applyPreset(state.get("weather"));

  state.on("weather", applyPreset);
  state.on("idle", (v) => { $("#chrome").dataset.idle = String(v); });
  state.on("panel", (v) => {
    document.body.dataset.panelOpen = v ? "true" : "false";
    poke();
  });
  state.on("cinema", (v) => {
    document.body.dataset.cinema = String(v);
    poke();
  });
  state.on("tv", (v) => { document.body.dataset.tv = v; });

  addEventListener("resize", debounce(() => { fitFrame(); }, 80));
  // orientation changes on iOS report the old size for a beat
  addEventListener("orientationchange", () => setTimeout(fitFrame, 220));

  for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) {
    addEventListener(ev, poke, { passive: true });
  }
  poke();

  startParallax();
  if (typeof onMotionChange === "function") { /* handled in main */ }
}

export { fitFrame, startParallax };
