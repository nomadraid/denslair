/* ============================================================
   fx/patches.js — motion without cutting the artwork up.

   A "live patch" is a clone of one rectangle of the plate, laid
   back down exactly where it came from and then transformed by a
   fraction of a percent. Because it is the same pixels in the same
   place, the only thing that can betray it is the edge of the
   clone — so the edge is feathered away with a mask, and the
   movement is kept small enough that nothing slides out from under
   the feather.

   The alignment is done entirely with percentage background sizing,
   which means it stays correct at any window size with no JS
   re-measuring: for a container the size of the region, setting
   background-size to (PLATE / region) and background-position to
   region / (PLATE - region) lines the clone up exactly.
   ============================================================ */

import { PLATE, PATCHES } from "../geometry.js";
import { $, reducedMotion } from "../util.js";
import * as state from "../state.js";

const pct = (n) => `${(n * 100).toFixed(4)}%`;

function plateSize() {
  const w = innerWidth * (devicePixelRatio || 1);
  return w > 1500 ? 1672 : w > 1050 ? 1254 : 940;
}

const plateUrl = (night, size) =>
  `/assets/plates/${night ? "night" : "day"}-${size}.webp`;

/** how much of the night plate the room is currently showing, 0..1 */
const nightAmount = () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--is-night");
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const clones = [];

function build(name, spec) {
  const host = $(`#patch-${name}`);
  if (!host) return;

  const { x, y, w, h } = spec.region;

  // feather the container edge so the clone has no visible border
  const fx = (spec.feather / w) * 100;
  const fy = (spec.feather / h) * 100;
  const mask =
    `radial-gradient(ellipse ${100 - fx}% ${100 - fy}% at 50% 50%, ` +
    `#000 60%, rgba(0,0,0,0.55) 82%, transparent 100%)`;
  host.style.mask = mask;
  host.style.webkitMask = mask;

  // two stacked clones so the day/night swap can cross-fade
  const layers = [0, 1].map(() => {
    const n = document.createElement("div");
    Object.assign(n.style, {
      position: "absolute",
      inset: "0",
      backgroundRepeat: "no-repeat",
      backgroundSize: `${pct(PLATE.w / w)} ${pct(PLATE.h / h)}`,
      backgroundPosition:
        `${pct(x / (PLATE.w - w))} ${pct(y / (PLATE.h - h))}`,
      transformOrigin: spec.anim === "breathe" ? "50% 92%" : "50% 8%",
      willChange: "transform",
      transition: "opacity .18s linear",
      opacity: "0",
    });
    host.append(n);
    return n;
  });

  // layer 0 is the day plate and stays fully opaque; layer 1 is the
  // night plate and tracks the preset's night value, exactly mirroring
  // what the two real plates behind it are doing
  const rec = { name, spec, host, layers, size: null };
  layers[0].style.opacity = "1";
  layers[1].style.transition = "opacity 0.18s linear";
  clones.push(rec);
  loadPlates(rec);
  syncNight(rec);
  animate(rec);
}

function loadPlates(rec) {
  const size = plateSize();
  if (rec.size === size) return;
  rec.size = size;
  rec.layers[0].style.backgroundImage = `url("${plateUrl(false, size)}")`;
  rec.layers[1].style.backgroundImage = `url("${plateUrl(true, size)}")`;
}

function syncNight(rec, night) {
  const v = typeof night === "number" ? night : nightAmount();
  rec.layers[1].style.opacity = v.toFixed(3);
}

/* The movement is CSS rather than ticker-driven: these are slow,
   continuous and never need to respond to anything, so handing them
   to the compositor is both smoother and cheaper. */
function animate(rec) {
  if (reducedMotion()) return;
  const anim = rec.spec.anim === "breathe" ? "patch-breathe" : "patch-sway";
  const dur = rec.spec.anim === "breathe" ? 3.8 : 9.5;
  for (const l of rec.layers) {
    l.style.animation = `${anim} ${dur}s ease-in-out infinite`;
  }
}

export function initPatches() {
  if (!document.getElementById("patch-dog")) return;

  for (const [name, spec] of Object.entries(PATCHES)) build(name, spec);

  // scene.js may defer the real plate swap behind a dip to black, so
  // wait for its signal rather than reacting to the weather change
  document.addEventListener("lair:plate", (e) => {
    for (const rec of clones) syncNight(rec, e.detail?.night);
  });

  addEventListener("resize", () => {
    for (const rec of clones) loadPlates(rec);
  }, { passive: true });
}
