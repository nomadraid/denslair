/* ============================================================
   main.js — boot order.

   The room has to look finished the instant the door opens, so
   the plates are decoded before the enter button unlocks, and the
   effects only start once the visitor is actually inside.
   ============================================================ */

import { $, $$, store, onMotionChange, reducedMotion } from "./util.js";
import * as state from "./state.js";
import { initScene, PRESETS, wakeChrome } from "./scene.js";
import { initHotspots } from "./hotspots.js";
import { ACTIONS, setWeather } from "./actions.js";
import { toast } from "./toast.js";

import { initPanels, openPanel, closePanel } from "./panels.js";
import { initTv } from "./tv.js";
import { initShelf } from "./shelf.js";
import { initArcade } from "./arcade.js";
import { initAmbience } from "./ambience.js";
import { initTerminal } from "./terminal.js";

import { initWeatherFx } from "./fx/weather.js";
import { initFireFx } from "./fx/fire.js";
import { initAtmosFx } from "./fx/atmos.js";
import { initPatches } from "./fx/patches.js";

import { QUOTES } from "./data/content.js";

/* ---------- preload the plates ---------- */

const PLATES = ["day", "night"];

function plateUrl(name) {
  const w = innerWidth * (devicePixelRatio || 1);
  const size = w > 1500 ? 1672 : w > 1050 ? 1254 : 940;
  const type = document.createElement("canvas")
    .toDataURL("image/webp").startsWith("data:image/webp") ? "webp" : "webp";
  return `/assets/plates/${name}-${size}.${type}`;
}

async function preload() {
  const progress = $("#boot-progress");
  let done = 0;
  await Promise.all(
    PLATES.map(
      (name) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = img.onerror = () => {
            done += 1;
            if (progress) progress.textContent = done < PLATES.length
              ? "lighting the fire…"
              : "ready.";
            resolve();
          };
          img.src = plateUrl(name);
        })
    )
  );
  // the <picture> elements in the markup resolve from the same cache
  await Promise.all(
    $$(".plate img").map((img) => (img.decode ? img.decode().catch(() => {}) : null))
  );
}

/* ---------- chrome wiring ---------- */

function wireChrome() {
  $("#year") && ($("#year").textContent = String(new Date().getFullYear()));

  const q = $("#quote");
  if (q && QUOTES?.length) {
    let i = Math.floor(Math.random() * QUOTES.length);
    const show = () => {
      q.style.opacity = "0";
      setTimeout(() => {
        q.textContent = QUOTES[i % QUOTES.length];
        i += 1;
        q.style.opacity = "";
      }, 400);
    };
    q.textContent = QUOTES[i % QUOTES.length];
    i += 1;
    setInterval(show, 14000);
  }

  for (const btn of $$("#nav [data-nav]")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.nav;
      $$("#nav [data-nav]").forEach((b) => b.classList.toggle("is-active", b === btn));
      if (key === "lair") { closePanel(); return; }
      if (key === "tv") { ACTIONS.tv(); return; }
      ACTIONS[key]?.();
    });
  }

  for (const card of $$("#cards .card")) {
    card.addEventListener("click", () => openPanel(card.dataset.panel));
  }

  for (const btn of $$("#weather-card [data-wx]")) {
    btn.addEventListener("click", () => setWeather(btn.dataset.wx));
  }
  state.on("weather", (name) => {
    const p = PRESETS[name];
    $$("#weather-card [data-wx]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.wx === name));
    $("#wx-name") && ($("#wx-name").textContent = p.label);
    $("#wx-temp") && ($("#wx-temp").textContent = `${p.temp}°C`);
    const ico = $("#wx-ico");
    if (ico) ico.innerHTML = `<i data-ico="${p.ico}"></i>`;
  }, true);

  $("#settings-btn")?.addEventListener("click", () => openPanel("settings"));
  $("#signin-btn")?.addEventListener("click", () => openPanel("signin"));

  const hint = $("#hint");
  if (hint) {
    if (state.get("hintSeen")) hint.hidden = true;
    $("#hint-x")?.addEventListener("click", () => {
      hint.hidden = true;
      state.set("hintSeen", true);
    });
  }

  state.on("user", (u) => {
    $("#wm-who") && ($("#wm-who").textContent = u.name || "guest");
    const label = $("#signin-btn span");
    if (label) label.textContent = u.signedIn ? u.name.toUpperCase() : "SIGN IN";
  }, true);

  // one Escape handler for the whole page, in priority order
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.get("cinema")) { state.set("cinema", false); return; }
    if (state.get("panel")) { closePanel(); return; }
  });
}

/* ---------- go ---------- */

function startRoom() {
  document.body.dataset.booted = "true";
  document.body.dataset.lights = state.get("lightsOn") ? "on" : "off";
  document.body.dataset.fire = state.get("fireOn") ? "on" : "off";
  state.set("entered", true);

  initWeatherFx();
  initFireFx();
  initAtmosFx();
  initPatches();
  initShelf();
  initArcade();
  initTerminal();

  setTimeout(() => {
    if (!state.get("hintSeen") && !state.get("panel")) $("#hint")?.removeAttribute("hidden");
  }, 2600);

  wakeChrome();
}

async function boot() {
  initScene();
  initPanels();
  initTv();
  initAmbience();
  initHotspots(ACTIONS);
  wireChrome();

  onMotionChange(() => location.reload());

  await preload();

  const enter = $("#boot-enter");
  if (enter) {
    enter.disabled = false;
    enter.addEventListener("click", startRoom, { once: true });
  }
  // let the keyboard through the door too
  addEventListener("keydown", function once(e) {
    if (e.key === "Enter" && !state.get("entered")) {
      removeEventListener("keydown", once);
      startRoom();
    }
  });
}

boot().catch((err) => {
  console.error("[lair] boot failed", err);
  const p = $("#boot-progress");
  if (p) p.textContent = "something went wrong lighting the fire — check the console.";
  $("#boot-enter") && ($("#boot-enter").disabled = false);
});

window.lair = Object.assign(window.lair || {}, { openPanel, toast, setWeather });
