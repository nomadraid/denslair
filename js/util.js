/* ============================================================
   util.js — small shared helpers. No side effects on import
   except the single shared animation ticker, which stays idle
   until something actually subscribes.
   ============================================================ */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp  = (a, b, t) => a + (b - a) * t;
export const rand  = (lo, hi) => lo + Math.random() * (hi - lo);
export const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
export const pick  = (arr) => arr[(Math.random() * arr.length) | 0];

/** Create an element with attributes and children in one call. */
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function")
      n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k.startsWith("data") || k === "role" || k.startsWith("aria"))
      n.setAttribute(k.replace(/^data([A-Z])/, (_, c) => "data-" + c.toLowerCase()), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

export const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null && v !== false) n.setAttribute(k, v);
  }
  return n;
};

/* ---------- motion preference ---------- */
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
export const reducedMotion = () => motionQuery.matches;
export const onMotionChange = (fn) => motionQuery.addEventListener("change", fn);

/* ---------- one shared rAF ticker ----------
   Every animated effect subscribes here rather than starting its
   own loop. One rAF for the whole page keeps the effects in step
   and lets us stop everything at once when the tab is hidden. */
const subs = new Set();
let running = false;
let last = 0;

function frame(t) {
  if (!running) return;
  const dt = last ? Math.min(t - last, 64) : 16; // clamp after tab-switches
  last = t;
  for (const fn of subs) {
    try { fn(dt, t); } catch (err) { console.error("[ticker]", err); }
  }
  requestAnimationFrame(frame);
}

function sync() {
  const want = subs.size > 0 && !document.hidden;
  if (want && !running) {
    running = true;
    last = 0;
    requestAnimationFrame(frame);
  } else if (!want) {
    running = false;
  }
}

document.addEventListener("visibilitychange", sync);

export const ticker = {
  add(fn) { subs.add(fn); sync(); return () => ticker.remove(fn); },
  remove(fn) { subs.delete(fn); sync(); },
  get size() { return subs.size; },
};

/* ---------- canvas sizing ----------
   Canvases inside the room are laid out in percentages, so their
   backing store has to be resized to whatever the browser gives
   them. Returns true when the size actually changed. */
export function fitCanvas(canvas, maxDpr = 2) {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const dpr = Math.min(devicePixelRatio || 1, maxDpr);
  const w = Math.round(r.width * dpr);
  const h = Math.round(r.height * dpr);
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

/* ---------- storage that never throws ---------- */
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem("lair:" + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("lair:" + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  del(key) {
    try { localStorage.removeItem("lair:" + key); } catch { /* private mode */ }
  },
};

/* ---------- misc ---------- */
export const debounce = (fn, ms = 120) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
