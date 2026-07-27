/* ============================================================
   state.js — one small observable store for the whole lair.

   Modules never talk to each other directly. They read state,
   write state, and subscribe to the keys they care about. That
   keeps the weather engine, the TV, the ambience mixer and the
   chrome from having to know one another exists.
   ============================================================ */

import { store } from "./util.js";

const listeners = new Map(); // key -> Set<fn>
const anyListeners = new Set();

/** Keys persisted across visits. Everything else resets each load. */
const PERSIST = ["weather", "ambience", "user", "hintSeen", "scores"];

const initial = {
  /** 'sunny' | 'cloudy' | 'rainy' | 'night' */
  weather: store.get("weather", "sunny"),

  /** the room lamp + overheads */
  lightsOn: true,
  fireOn: true,

  /** 'off' | 'static' | 'loading' | 'playing' | 'error' */
  tv: "off",
  tape: null,
  cinema: false,

  /** currently open panel id, or null */
  panel: null,

  /** true once the chrome has faded out from inactivity */
  idle: false,

  /** true after the visitor has walked through the door */
  entered: false,

  ambience: store.get("ambience", {
    on: false,
    master: 0.7,
    layers: { rain: 0.6, fire: 0.75, vinyl: 0.15, city: 0.35 },
    track: null,
  }),

  /** replaced wholesale when real auth lands; see js/auth.js */
  user: store.get("user", { name: "guest", signedIn: false }),

  scores: store.get("scores", {}),
  hintSeen: store.get("hintSeen", false),
};

const state = { ...initial };

export function get(key) {
  return key === undefined ? { ...state } : state[key];
}

export function set(key, value) {
  const prev = state[key];
  if (prev === value) return value;
  state[key] = value;
  if (PERSIST.includes(key)) store.set(key, value);

  const set_ = listeners.get(key);
  if (set_) for (const fn of set_) {
    try { fn(value, prev); } catch (err) { console.error(`[state:${key}]`, err); }
  }
  for (const fn of anyListeners) {
    try { fn(key, value, prev); } catch (err) { console.error("[state:*]", err); }
  }
  return value;
}

/** Shallow-merge into an object-valued key, then notify. */
export function patch(key, partial) {
  return set(key, { ...state[key], ...partial });
}

/**
 * Subscribe to a key. Pass `immediate` to fire once right away —
 * handy for effects that need to apply the current value on boot.
 * Returns an unsubscribe function.
 */
export function on(key, fn, immediate = false) {
  if (key === "*") {
    anyListeners.add(fn);
    return () => anyListeners.delete(fn);
  }
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  if (immediate) fn(state[key], undefined);
  return () => listeners.get(key)?.delete(fn);
}

/* Handy for poking at the room from the browser console. */
if (typeof window !== "undefined") {
  window.lair = Object.assign(window.lair || {}, { state: { get, set, patch, on } });
}
