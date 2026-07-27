/* ============================================================
   actions.js — what each clickable thing in the room does.

   One table, so the hotspots, the nav, the cards and the terminal
   can all trigger the same behaviour without duplicating it.
   ============================================================ */

import * as state from "./state.js";
import { toast } from "./toast.js";
import { pick } from "./util.js";
import { openPanel } from "./panels.js";
import { PRESETS } from "./scene.js";
import { setTvState } from "./tv.js";
import { toggleAmbience } from "./ambience.js";
import { DOG_LINES } from "./data/content.js";

const ORDER = ["sunny", "cloudy", "rainy", "night"];

export function cycleWeather() {
  const cur = state.get("weather");
  const next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
  setWeather(next);
}

export function setWeather(name) {
  if (!PRESETS[name]) return;
  state.set("weather", name);
  const p = PRESETS[name];
  toast(`${p.label.toLowerCase()} · ${p.temp}°C outside`);
}

export function toggleLights() {
  const on = !state.get("lightsOn");
  state.set("lightsOn", on);
  document.body.dataset.lights = on ? "on" : "off";
  toast(on ? "lights on" : "lights low. better for films.");
}

export function toggleFire() {
  const on = !state.get("fireOn");
  state.set("fireOn", on);
  document.body.dataset.fire = on ? "on" : "off";
  toast(on ? "fire's back on" : "fire banked for the night");
}

let dogTimer = null;
export function pokeDog() {
  toast(pick(DOG_LINES), 2000);
  const patch = document.getElementById("patch-dog");
  if (!patch) return;
  patch.classList.add("is-stirred");
  clearTimeout(dogTimer);
  dogTimer = setTimeout(() => patch.classList.remove("is-stirred"), 2400);
}

export function wakeTv() {
  if (state.get("tv") === "off") setTvState("static");
  else openPanel("shelf-hint");
}

/** The table the hotspot layer and the chrome both dispatch through. */
export const ACTIONS = {
  weather: cycleWeather,
  lamp: toggleLights,
  fire: toggleFire,
  dog: pokeDog,
  ambience: () => toggleAmbience(),
  tv: wakeTv,
  mug: () => toast("still warm. somehow always still warm."),

  shelf: () => openPanel("library"),
  arcade: () => openPanel("arcade"),
  recruiters: () => openPanel("recruiters"),
  about: () => openPanel("about"),
  dataroom: () => openPanel("dataroom"),
  devcorner: () => openPanel("devcorner"),
  library: () => openPanel("library"),
  settings: () => openPanel("settings"),
  signin: () => openPanel("signin"),
  globe: () => openPanel("globe"),
  picture: () => openPanel("picture"),
  mantel: () => openPanel("mantel"),
};
