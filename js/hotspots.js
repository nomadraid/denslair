/* ============================================================
   hotspots.js — the invisible clickable shapes over the artwork.

   A single SVG with the plate's own viewBox sits on top of the
   room, so the shapes scale with the picture for free and stay
   registered at any window size. Each shape is a real focusable
   element, which is what makes the room keyboard-navigable.
   ============================================================ */

import { HOTSPOTS, shapeToPath } from "./geometry.js";
import { $, svgEl } from "./util.js";
import * as state from "./state.js";

const tip = () => document.getElementById("tooltip");

let hideTimer = null;

function showTip(text, x, y) {
  const node = tip();
  if (!node) return;
  node.textContent = text;
  node.classList.add("is-shown");
  // measure after the text is in, so the flip logic uses real width
  const r = node.getBoundingClientRect();
  const pad = 16;
  let left = x + pad;
  let top = y + pad;
  if (left + r.width > innerWidth - 8) left = x - r.width - pad;
  if (top + r.height > innerHeight - 8) top = y - r.height - pad;
  node.style.left = `${Math.max(8, left)}px`;
  node.style.top = `${Math.max(8, top)}px`;
}

function hideTip() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => tip()?.classList.remove("is-shown"), 60);
}

/**
 * @param {Record<string, (id: string) => void>} actions
 *   handler table, keyed by the `act` field in geometry.HOTSPOTS
 */
export function initHotspots(actions) {
  const svg = $("#hotspots");
  if (!svg) return;
  svg.textContent = "";

  for (const spot of HOTSPOTS) {
    const path = svgEl("path", {
      d: shapeToPath(spot.shape),
      class: "hot",
      "data-hot": spot.id,
      "data-act": spot.act,
      tabindex: "0",
      role: "button",
      "aria-label": spot.label,
    });

    const fire = (ev) => {
      ev.preventDefault();
      if (state.get("panel") || state.get("cinema")) return;
      actions[spot.act]?.(spot.id, spot);
    };

    path.addEventListener("click", fire);
    path.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") fire(e);
    });

    path.addEventListener("pointerenter", (e) => {
      clearTimeout(hideTimer);
      showTip(spot.label, e.clientX, e.clientY);
    });
    path.addEventListener("pointermove", (e) => showTip(spot.label, e.clientX, e.clientY));
    path.addEventListener("pointerleave", hideTip);
    path.addEventListener("focus", () => {
      const r = path.getBoundingClientRect();
      showTip(spot.label, r.left + r.width / 2, r.top + r.height / 2);
    });
    path.addEventListener("blur", hideTip);

    svg.append(path);
  }

  // the tooltip is meaningless once anything covers the room
  state.on("panel", (v) => { if (v) hideTip(); });
  state.on("cinema", (v) => { if (v) hideTip(); });
}

/** Briefly ring a hotspot, so other modules can point at things. */
export function pulseHotspot(id, ms = 1600) {
  const node = document.querySelector(`[data-hot="${id}"]`);
  if (!node) return;
  node.classList.add("is-pulsing");
  setTimeout(() => node.classList.remove("is-pulsing"), ms);
}
