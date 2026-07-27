/* ============================================================
   ambience.js — the room makes its own sound.

   Nothing in here is a recording. Four layers are synthesised
   with the Web Audio API out of two noise buffers and a handful
   of filters, so there is nothing to licence and nothing to host.

     rain   two bands of filtered noise whose cutoffs breathe
     fire   a brown-noise bed plus crackles in irregular clusters
     vinyl  surface hiss and clicks, locked to a 33rpm platter
     city   a low hum with slow swells and the odd distant siren

   The graph is built once, on the first gesture, and then left
   alone: switching ambience off suspends the context rather than
   tearing anything down. Every gain move is a ramp — assigning
   .value on a live parameter is what makes the click.
   ============================================================ */

import {
  $, clamp, rand, randInt, fitCanvas, ticker,
  reducedMotion, onMotionChange, debounce,
} from "./util.js";
import * as state from "./state.js";
import { PLATE, FIRE, WINDOW, HOTSPOTS } from "./geometry.js";
import { toast } from "./toast.js";

/* ------------------------------------------------------------
   THE SEAM FOR REAL MUSIC

   Drop licensed tracks in here and the room stops synthesising:
   the four layers duck to silence and the player streams the
   file instead. Leave it empty and the room plays itself.

     {
       title:   "Night Bus",
       artist:  "Someone Real",
       src:     "/assets/audio/night-bus.m4a",  // same-origin, or CORS-enabled
       licence: "CC BY 4.0 — https://example.com/night-bus"
     }

   `src` must be same-origin or served with Access-Control-Allow-Origin,
   otherwise the analyser that drives the footer meter reads silence.
   If a track fails to load the player falls back to synthesis and
   says so, rather than leaving the room silent.
   ------------------------------------------------------------ */
export const PLAYLIST = [];

/* The mixer's channel strip, in order. Exported so the ambience
   panel can render faders without duplicating the copy. */
export const LAYERS = [
  { key: "rain",  label: "rain",  hint: "on the window" },
  { key: "fire",  label: "fire",  hint: "logs and crackle" },
  { key: "vinyl", label: "vinyl", hint: "surface noise, 33rpm" },
  { key: "city",  label: "city",  hint: "traffic, far off" },
];
const KEYS = LAYERS.map((l) => l.key);

const DEFAULTS = {
  on: false,
  master: 0.7,
  layers: { rain: 0.6, fire: 0.75, vinyl: 0.15, city: 0.35 },
  track: null,
};

/* How the room leans on the mix. Multipliers, not replacements —
   the visitor's faders still mean something in every weather. */
const WEATHER_MIX = {
  sunny:  { rain: 0.14, city: 0.80 },
  cloudy: { rain: 0.40, city: 0.70 },
  rainy:  { rain: 1.00, city: 0.22 },
  night:  { rain: 0.18, city: 1.00 },
};
const roomMix = () => WEATHER_MIX[state.get("weather")] || WEATHER_MIX.sunny;

/* Per-layer trims so the four faders reach roughly equal loudness. */
const TRIM = { rain: 0.90, fire: 0.95, vinyl: 0.80, city: 0.85 };

/* A fader that behaves: linear travel sounds top-heavy. */
const fader = (x) => Math.pow(clamp(x, 0, 1), 1.7);

/* ------------------------------------------------------------
   Where each layer sits in the room. Taken from the artwork so the
   fire really is over to the right and the weather really is at the
   window, rather than a guess that happens to sound plausible.
   ------------------------------------------------------------ */
const WIDTH = 0.62; // how far the room is allowed to spread the image
const panAt = (x) => clamp((x / PLATE.w - 0.5) * 2 * WIDTH, -0.9, 0.9);

const glassX = WINDOW.glass.reduce((a, p) => a + p[0], 0) / WINDOW.glass.length;
const deckRect = HOTSPOTS.find((h) => h.id === "turntable")?.shape.rect;
const deckX = deckRect ? deckRect.x + deckRect.w / 2 : PLATE.w * 0.2;

const PAN = {
  rain:  panAt(glassX),
  city:  panAt(WINDOW.cityBand.x + WINDOW.cityBand.w / 2),
  fire:  panAt(FIRE.core.cx),
  vinyl: panAt(deckX),
};

/* 33 1/3 rpm. Everything about the vinyl layer hangs off this. */
const REV = 60 / (100 / 3);
const RPS = 1 / REV;

/* ============================================================
   1. AUDIO GRAPH
   ============================================================ */

let ctx = null;
let white = null;      // stereo white noise, seamless loop
let brown = null;      // stereo brown noise, seamless loop

let bed = null;        // sums the four synthesised layers
let limiter = null;    // catches crackle pile-ups, invisible otherwise
let masterGain = null;
let analyser = null;
let trackGain = null;

const bus = {};        // per-layer, driven by the visitor's fader
const duck = {};       // per-layer, driven by the room
const placed = {};     // per-layer stereo placement for the continuous beds

let booted = false;
let phase = "off";     // off | armed | starting | on
let suspendTimer = null;
let liveEvents = 0;    // scheduled one-shots currently alive

const now = () => ctx.currentTime;
const ramp = (param, v, tc = 0.12) => param.setTargetAtTime(v, now(), tc);
const fixed = (param, v) => param.setValueAtTime(v, now());

function gainNode(v) {
  const g = ctx.createGain();
  fixed(g.gain, v);
  return g;
}

function biquad(type, freq, q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  fixed(f.frequency, freq);
  fixed(f.Q, q);
  return f;
}

function panner(v) {
  if (!ctx.createStereoPanner) return null;
  const p = ctx.createStereoPanner();
  fixed(p.pan, clamp(v, -1, 1));
  return p;
}

/** Wire a list of nodes end to end, skipping any that are missing. */
function chain(...nodes) {
  const list = nodes.filter(Boolean);
  for (let i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]);
  return list[list.length - 1];
}

function kill(...nodes) {
  for (const n of nodes) { try { n?.disconnect(); } catch { /* already gone */ } }
}

/** A slow sine on an AudioParam. Runs at audio rate; costs nothing per frame. */
function lfo(rate, depth, param, phaseSeconds = 0) {
  const o = ctx.createOscillator();
  o.type = "sine";
  fixed(o.frequency, rate);
  const g = ctx.createGain();
  fixed(g.gain, depth);
  o.connect(g);
  g.connect(param);
  // starting late is a cheap way to give each modulator its own phase
  o.start(now() + phaseSeconds);
  return o;
}

function loopSource(buffer, rate = 1) {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  fixed(s.playbackRate, rate);
  return s;
}

/* ---------- noise ----------
   Generated once, at 2 uncorrelated channels, so a single source
   node already sounds wide. The tail is equal-power crossfaded over
   the head, otherwise brown noise thumps every time it wraps. */
function noiseBuffer(seconds, kind) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const fade = Math.floor(sr * 0.25);
  const buf = ctx.createBuffer(2, len, sr);

  for (let ch = 0; ch < 2; ch++) {
    const tmp = new Float32Array(len + fade);
    if (kind === "white") {
      for (let i = 0; i < tmp.length; i++) tmp[i] = Math.random() * 2 - 1;
    } else {
      let last = 0;
      for (let i = 0; i < tmp.length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        tmp[i] = last * 3.5;
      }
    }
    const d = buf.getChannelData(ch);
    d.set(tmp.subarray(0, len));
    for (let i = 0; i < fade; i++) {
      const t = (i / fade) * Math.PI * 0.5;
      d[i] = tmp[i] * Math.sin(t) + tmp[len + i] * Math.cos(t);
    }
  }
  return buf;
}

/* ---------- the four layers ---------- */

function buildRain(dest) {
  const t = now();

  // the broad hiss, sitting up in the top half of the spectrum
  const hiss = loopSource(white, 1.0);
  const hp = biquad("highpass", 700, 0.7);
  const bp = biquad("bandpass", 1700, 0.55);
  const hg = gainNode(0.55);
  chain(hiss, hp, bp, hg, dest);
  // two incommensurate rates, so the cutoff never repeats a pattern
  lfo(0.043, 620, bp.frequency, 0.0);
  lfo(0.017, 380, bp.frequency, 2.3);
  lfo(0.031, 0.14, hg.gain, 1.1);

  // the lower body — rain arriving on the glass rather than on a field
  const low = loopSource(white, 0.87);
  const lp1 = biquad("lowpass", 400, 1.05);
  const lp2 = biquad("lowpass", 950, 0.5);
  const lg = gainNode(0.80);
  chain(low, lp1, lp2, lg, dest);
  lfo(0.026, 150, lp1.frequency, 3.4);
  lfo(0.019, 0.20, lg.gain, 0.6);

  hiss.start(t, rand(0, white.duration));
  low.start(t, rand(0, white.duration));
}

function buildFire(dest) {
  const t = now();

  const bedSrc = loopSource(brown, 0.9);
  const hp = biquad("highpass", 55, 0.7);
  const lp = biquad("lowpass", 340, 0.8);
  const g = gainNode(0.55);
  chain(bedSrc, hp, lp, g, dest);
  lfo(0.070, 0.18, g.gain, 0.4);
  lfo(0.023, 120, lp.frequency, 2.0);

  // a thread of air over the top so it is not all rumble
  const air = loopSource(white, 1.0);
  const abp = biquad("bandpass", 1100, 0.5);
  const ag = gainNode(0.045);
  chain(air, abp, ag, dest);
  lfo(0.050, 0.020, ag.gain, 1.7);

  bedSrc.start(t, rand(0, brown.duration));
  air.start(t, rand(0, white.duration));
}

function buildVinyl(dest) {
  const t = now();

  const hiss = loopSource(white, 1.0);
  const hp = biquad("highpass", 1600, 0.6);
  const lp = biquad("lowpass", 7200, 0.6);
  const g = gainNode(0.12);
  chain(hiss, hp, lp, g, dest);
  lfo(RPS, 0.030, g.gain, 0);        // wow, once per turn

  const rumble = loopSource(brown, 0.8);
  const rlp = biquad("lowpass", 78, 1.0);
  const rg = gainNode(0.45);
  chain(rumble, rlp, rg, dest);
  lfo(RPS, 0.12, rg.gain, REV * 0.5);

  hiss.start(t, rand(0, white.duration));
  rumble.start(t, rand(0, brown.duration));
}

function buildCity(dest) {
  const t = now();

  const hum = loopSource(brown, 0.65);
  const lp = biquad("lowpass", 190, 0.9);
  const g = gainNode(0.80);
  chain(hum, lp, g, dest);
  lfo(0.033, 0.30, g.gain, 0.0);
  lfo(0.011, 0.18, g.gain, 4.0);
  lfo(0.021, 60, lp.frequency, 1.5);

  const traffic = loopSource(white, 0.95);
  const thp = biquad("highpass", 140, 0.7);
  const tlp = biquad("lowpass", 520, 0.8);
  const tg = gainNode(0.28);
  chain(traffic, thp, tlp, tg, dest);
  lfo(0.047, 0.12, tg.gain, 2.6);
  lfo(0.013, 180, tlp.frequency, 0.9);

  hum.start(t, rand(0, brown.duration));
  traffic.start(t, rand(0, white.duration));
}

function buildGraph() {
  white = noiseBuffer(4, "white");
  brown = noiseBuffer(6, "brown");

  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.68;

  masterGain = gainNode(0);

  limiter = ctx.createDynamicsCompressor();
  fixed(limiter.threshold, -10);
  fixed(limiter.knee, 8);
  fixed(limiter.ratio, 8);
  fixed(limiter.attack, 0.004);
  fixed(limiter.release, 0.22);

  bed = gainNode(1);
  trackGain = gainNode(0);

  chain(bed, limiter, masterGain, analyser, ctx.destination);
  trackGain.connect(limiter);

  const room = roomMix();
  const a = current();
  for (const k of KEYS) {
    bus[k] = gainNode(fader(a.layers[k]) * TRIM[k]);
    duck[k] = gainNode(roomLevel(k, room));
    bus[k].connect(duck[k]);
    duck[k].connect(bed);
    // the beds get placed in the room; one-shots pan themselves
    placed[k] = panner(PAN[k]);
    if (placed[k]) placed[k].connect(bus[k]);
  }

  buildRain(placed.rain || bus.rain);
  buildFire(placed.fire || bus.fire);
  buildVinyl(placed.vinyl || bus.vinyl);
  buildCity(placed.city || bus.city);

  freqData = new Uint8Array(analyser.frequencyBinCount);
  layoutBars();
}

function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC({ latencyHint: "playback" });
  buildGraph();
  return ctx;
}

/* ============================================================
   2. THE MIX
   ============================================================ */

/** The stored mixer, with any missing keys filled in. */
function current() {
  const a = state.get("ambience") || {};
  return {
    on: !!a.on,
    master: typeof a.master === "number" ? clamp(a.master, 0, 1) : DEFAULTS.master,
    layers: { ...DEFAULTS.layers, ...(a.layers || {}) },
    track: a.track ?? null,
  };
}

function roomLevel(key, room = roomMix()) {
  if (key === "fire") return state.get("fireOn") === false ? 0 : 1;
  if (key === "rain") return room.rain;
  if (key === "city") return room.city;
  return 1;
}

/** What each layer is actually doing, after the room has had its say. */
function effective() {
  const a = current();
  const room = roomMix();
  const out = {};
  for (const k of KEYS) out[k] = a.layers[k] * roomLevel(k, room);
  return out;
}

function setMasterGain(tc = 0.10) {
  if (!ctx) return;
  const live = phase === "starting" || phase === "on";
  ramp(masterGain.gain, live ? current().master * 0.85 : 0, tc);
}

function applyMix() {
  if (!ctx) return;
  const a = current();
  for (const k of KEYS) ramp(bus[k].gain, fader(a.layers[k]) * TRIM[k], 0.10);
  setMasterGain();
}

/** The room leaning on the mix. Slow on purpose — this should feel
    like weather changing, not like someone moving a fader. */
function applyRoom() {
  if (!ctx) return;
  const room = roomMix();
  for (const k of KEYS) ramp(duck[k].gain, roomLevel(k, room), 0.55);
}

export function setLayer(name, value) {
  if (!KEYS.includes(name)) return;
  const a = current();
  const v = clamp(Number(value) || 0, 0, 1);
  if (a.layers[name] === v) return;
  state.patch("ambience", { layers: { ...a.layers, [name]: v } });
}

export function setMaster(v) {
  const m = clamp(Number(v) || 0, 0, 1);
  if (current().master === m) return;
  state.patch("ambience", { master: m });
}

/* ============================================================
   3. SCHEDULED ONE-SHOTS

   Crackles, clicks and sirens are booked against the audio clock
   from a look-ahead timer. Deliberately not the shared rAF ticker:
   rAF stops when the tab is hidden and the fire would go out.
   ============================================================ */

const LOOKAHEAD = 1.6;   // seconds of events committed in advance
const TICK_MS = 240;
const MAX_LIVE = 64;

let schedTimer = null;
let nextFire = 0;
let nextClick = 0;
let nextSiren = 0;
let revAt = 0;

/** Poisson-ish gap. This is what stops the fire sounding like a metronome. */
const expGap = (mean) => -Math.log(1 - Math.random()) * mean;

function reap(...nodes) {
  liveEvents--;
  kill(...nodes);
}

/** A crackle: one very short slice of noise, hit hard and let go. */
function crackle(t, level) {
  if (liveEvents > MAX_LIVE) return;
  // mostly small, occasionally a proper pop — the square of a uniform
  // draw gets the distribution right without any special-casing
  const loud = Math.pow(Math.random(), 2.6);
  const peak = (0.05 + loud * 0.55) * level;
  const attack = rand(0.0015, 0.004);
  const decay = (0.022 + loud * 0.09) * rand(0.8, 1.35);
  const freq = (700 + Math.random() * 3500) * (1 - loud * 0.55);

  const s = ctx.createBufferSource();
  s.buffer = white;
  fixed(s.playbackRate, rand(0.7, 1.5));
  const bp = biquad("bandpass", clamp(freq, 250, 4600), rand(0.8, 4));
  const g = gainNode(0.0001);
  const p = panner(PAN.fire + rand(-0.22, 0.22));

  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);

  chain(s, bp, g, p, bus.fire);
  liveEvents++;
  s.start(t, rand(0, white.duration - 0.25));
  s.stop(t + attack + decay + 0.02);
  s.onended = () => reap(s, bp, g, p);
}

/** Fire comes in bursts with lulls between them, not at a steady rate. */
function fireCluster(t) {
  const r = Math.random();
  const n = r < 0.60 ? 1 : r < 0.88 ? randInt(2, 3) : randInt(4, 6);
  let at = t;
  for (let i = 0; i < n; i++) {
    crackle(at, 1);
    at += rand(0.012, 0.07) * (1 + i * 0.4);
  }
  // every so often the log settles and says nothing for a while
  const lull = Math.random() < 0.12 ? rand(1.4, 3.2) : 0;
  return at + 0.05 + expGap(0.5) + lull;
}

/** A click (dust) or a pop (a scuff in the groove). */
function vinylTick(t, kind) {
  if (liveEvents > MAX_LIVE) return;
  const pop = kind === "pop";
  const peak = pop ? rand(0.14, 0.34) : rand(0.03, 0.13);
  const decay = pop ? rand(0.028, 0.075) : rand(0.003, 0.014);
  const freq = pop ? rand(320, 900) : rand(1800, 5200);

  const s = ctx.createBufferSource();
  s.buffer = white;
  fixed(s.playbackRate, rand(0.8, 1.25));
  const bp = biquad("bandpass", freq, pop ? 1.4 : 0.9);
  const g = gainNode(0.0001);
  const p = panner(PAN.vinyl + rand(-0.28, 0.28));

  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.0007);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

  chain(s, bp, g, p, bus.vinyl);
  liveEvents++;
  s.start(t, rand(0, white.duration - 0.1));
  s.stop(t + decay + 0.02);
  s.onended = () => reap(s, bp, g, p);
}

/** Something with a light bar, several streets away, passing. */
function siren(t) {
  if (liveEvents > MAX_LIVE) return;
  const dur = rand(5.5, 9);
  const f0 = rand(560, 760);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.linearRampToValueAtTime(f0 * 0.93, t + dur); // it goes past

  const wob = ctx.createOscillator();
  wob.type = "sine";
  fixed(wob.frequency, rand(0.26, 0.4));
  const wobDepth = gainNode(rand(90, 170));
  wob.connect(wobDepth);
  wobDepth.connect(osc.frequency);

  const hp = biquad("highpass", 300, 0.7);
  const lp = biquad("lowpass", 900, 0.6);   // distance eats the top
  const g = gainNode(0.0001);
  const p = panner(clamp(PAN.city - 0.35, -0.95, 0.95));
  if (p) {
    p.pan.linearRampToValueAtTime(clamp(PAN.city + 0.55, -0.95, 0.95), t + dur);
  }

  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.08, t + dur * 0.45);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);

  chain(osc, hp, lp, g, p, bus.city);
  liveEvents++;
  osc.start(t);
  wob.start(t);
  osc.stop(t + dur + 0.05);
  wob.stop(t + dur + 0.05);
  osc.onended = () => reap(osc, wob, wobDepth, hp, lp, g, p);
}

function pump() {
  if (!ctx || ctx.state !== "running" || phase === "off") return;
  const t = now();
  const horizon = t + LOOKAHEAD;
  const lvl = effective();
  const silent = current().master < 0.01;

  // after a suspend the pointers are in the past; do not replay history
  if (nextFire < t) nextFire = t + 0.05;
  if (nextClick < t) nextClick = t + 0.05;
  if (revAt < t) revAt = t + rand(0, REV);
  if (nextSiren < t) nextSiren = t + rand(20, 60);

  while (nextFire < horizon) {
    if (!silent && lvl.fire > 0.02) nextFire = fireCluster(nextFire);
    else nextFire += 0.6;
  }

  // the same scuff comes round once per turn, plus a fainter one
  while (revAt < horizon) {
    if (!silent && lvl.vinyl > 0.02) {
      vinylTick(revAt + rand(-0.012, 0.012), "pop");
      if (Math.random() < 0.7) vinylTick(revAt + REV * rand(0.34, 0.42), "click");
    }
    revAt += REV;
  }
  while (nextClick < horizon) {
    if (!silent && lvl.vinyl > 0.02) vinylTick(nextClick, "click");
    nextClick += expGap(0.85) + 0.05;
  }

  while (nextSiren < horizon) {
    if (!silent && lvl.city > 0.06) siren(nextSiren);
    nextSiren += rand(55, 150);
  }
}

function startScheduler() {
  const t = now();
  nextFire = t + rand(0.1, 0.6);
  nextClick = t + rand(0.2, 1.2);
  revAt = t + rand(0, REV);
  nextSiren = t + rand(25, 80);
  stopScheduler();
  schedTimer = setInterval(pump, TICK_MS);
  pump();
}

function stopScheduler() {
  if (schedTimer) clearInterval(schedTimer);
  schedTimer = null;
}

/* ============================================================
   4. THE PLAYER — a real track if there is one, the room if not
   ============================================================ */

let audioEl = null;
let mediaSrc = null;
let trackIndex = 0;
let trackFailed = false;

const hasTrack = () => PLAYLIST.length > 0 && !trackFailed;

function ensureAudioElement() {
  if (audioEl) return audioEl;
  audioEl = new Audio();
  audioEl.preload = "auto";
  audioEl.crossOrigin = "anonymous";   // the analyser needs readable samples
  audioEl.addEventListener("ended", () => {
    trackIndex = (trackIndex + 1) % Math.max(PLAYLIST.length, 1);
    if (phase === "on" && hasTrack()) playTrack(trackIndex);
  });
  audioEl.addEventListener("error", () => failTrack());
  // MediaElementSource may only be created once per element
  mediaSrc = ctx.createMediaElementSource(audioEl);
  mediaSrc.connect(trackGain);
  return audioEl;
}

function playTrack(i) {
  const t = PLAYLIST[i];
  if (!t?.src) return failTrack();
  const a = ensureAudioElement();
  ramp(bed.gain, 0, 0.4);              // the room steps back
  ramp(trackGain.gain, 1, 0.4);
  if (a.src !== new URL(t.src, location.href).href) a.src = t.src;
  state.patch("ambience", {
    track: { title: t.title, artist: t.artist, licence: t.licence },
  });
  a.play().catch(() => failTrack());
  labels();
}

/** Anything goes wrong with the track and the room takes over again. */
function failTrack() {
  if (trackFailed) return;
  trackFailed = true;
  try { audioEl?.pause(); } catch { /* nothing playing */ }
  if (ctx) {
    ramp(trackGain.gain, 0, 0.3);
    ramp(bed.gain, 1, 0.6);
  }
  state.patch("ambience", { track: null });
  if (phase === "on") startScheduler();
  labels();
  toast("that track wouldn't load. the room will play itself instead.");
}

/* ============================================================
   5. TRANSPORT
   ============================================================ */

const GESTURES = ["pointerdown", "keydown", "touchend"];
let armedGo = null;

/** Browsers will not let us make a sound until the visitor acts.
    If ambience was on last visit, wait quietly for the first click. */
function armGesture() {
  if (armedGo) return;
  armedGo = () => {
    disarm();
    if (current().on) start();
  };
  for (const ev of GESTURES) {
    addEventListener(ev, armedGo, { capture: true, once: true, passive: true });
  }
}

function disarm() {
  if (!armedGo) return;
  for (const ev of GESTURES) removeEventListener(ev, armedGo, true);
  armedGo = null;
}

async function start() {
  if (phase === "starting" || phase === "on") return;
  disarm();
  clearTimeout(suspendTimer);

  phase = "starting";
  labels();

  if (!ensureContext()) {           // no Web Audio at all
    phase = "off";
    state.patch("ambience", { on: false });
    labels();
    return;
  }

  if (ctx.state !== "running") {
    try { await ctx.resume(); } catch { /* still blocked */ }
  }
  if (ctx.state !== "running") {
    phase = "armed";                // not a gesture after all; wait for one
    armGesture();
    labels();
    return;
  }
  if (phase !== "starting") return; // switched off again while resuming

  phase = "on";
  applyMix();
  applyRoom();

  if (hasTrack()) {
    stopScheduler();
    playTrack(trackIndex);
  } else {
    ramp(trackGain.gain, 0, 0.3);
    ramp(bed.gain, 1, 0.3);
    startScheduler();
  }

  setMasterGain(0.45);              // ~1.3s to come up
  startViz();
  labels();
}

function stop() {
  disarm();
  const wasLive = phase === "starting" || phase === "on";
  phase = "off";
  setMasterGain(0.18);
  stopScheduler();
  try { audioEl?.pause(); } catch { /* nothing playing */ }
  stopViz();
  labels();

  // let the fade finish, then park the context so it costs nothing
  clearTimeout(suspendTimer);
  if (wasLive && ctx) {
    suspendTimer = setTimeout(() => {
      if (phase === "off" && ctx?.state === "running") ctx.suspend().catch(() => {});
    }, 1000);
  }
}

/** Flip the ambience. State does the work; the subscriber reacts. */
export function toggleAmbience() {
  const on = !current().on;
  state.patch("ambience", { on });
  return on;
}

/* ============================================================
   6. THE FOOTER — labels and the meter
   ============================================================ */

const WORD = { rain: "rain", fire: "fire", vinyl: "vinyl", city: "the city" };

function audible() {
  const lvl = effective();
  return KEYS.filter((k) => lvl[k] > 0.06);
}

function labels() {
  const btn = $("#amb-toggle");
  const title = $("#amb-title");
  const sub = $("#amb-sub");
  const a = current();

  let t = "LAIR AMBIENCE";
  let s = "tap to play";

  if (phase === "armed") s = "click anywhere to bring it back";
  else if (phase === "starting") s = "warming up";
  else if (phase === "on") {
    if (a.track?.title) {
      t = a.track.title;
      s = a.track.artist || "now playing";
    } else {
      const on = audible();
      s = on.length ? on.map((k) => WORD[k]).join(" · ") : "all four faders are down";
    }
  }

  if (title) title.textContent = t;
  if (sub) sub.textContent = s;
  if (btn) {
    btn.dataset.on = String(phase === "on");
    btn.setAttribute("aria-pressed", String(a.on));
    btn.setAttribute("aria-label", phase === "on" ? "Stop ambience" : "Play ambience");
  }
}

/* ---------- the meter ---------- */

let cv = null;
let g2 = null;
let vw = 0;
let vh = 0;
let freqData = null;
let bars = null;
let edges = null;
let barCount = 0;
let barW = 3;
let barGap = 2;
let barX0 = 0;
let gradBars = null;
let gradIdle = null;
let vizStop = null;

const COL = { amber: "#f2c15c", ember: "#ff6b52" };

function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  COL.amber = cs.getPropertyValue("--amber").trim() || COL.amber;
  COL.ember = cs.getPropertyValue("--ember").trim() || COL.ember;
}

function withAlpha(col, a) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(col);
  if (!m) return col;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function layoutBars() {
  if (!vw) return;
  barCount = clamp(Math.floor((vw + barGap) / (barW + barGap)), 8, 72);
  barX0 = Math.round((vw - (barCount * (barW + barGap) - barGap)) / 2);
  if (!bars || bars.length !== barCount) bars = new Float32Array(barCount);

  // spread the bars over roughly 60Hz–9kHz on a curve, so the lows
  // that carry most of this mix do not eat the whole readout
  const bins = freqData ? freqData.length : 256;
  const sr = ctx ? ctx.sampleRate : 48000;
  const hi = clamp(Math.round((9000 / (sr / 2)) * bins), 8, bins - 1);
  edges = new Uint16Array(barCount + 1);
  for (let i = 0; i <= barCount; i++) {
    edges[i] = 1 + Math.round(Math.pow(i / barCount, 1.85) * (hi - 1));
  }
}

function buildGradients() {
  if (!g2 || !vh) return;
  gradBars = g2.createLinearGradient(0, vh, 0, 0);
  gradBars.addColorStop(0, withAlpha(COL.amber, 0.45));
  gradBars.addColorStop(0.55, withAlpha(COL.amber, 0.92));
  gradBars.addColorStop(1, withAlpha(COL.ember, 1));

  gradIdle = g2.createLinearGradient(0, 0, vw, 0);
  gradIdle.addColorStop(0, withAlpha(COL.amber, 0.02));
  gradIdle.addColorStop(0.5, withAlpha(COL.amber, 0.28));
  gradIdle.addColorStop(1, withAlpha(COL.amber, 0.02));
}

function fitViz() {
  if (!cv || !g2) return false;
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  fitCanvas(cv);
  vw = r.width;
  vh = r.height;
  g2.setTransform(cv.width / vw, 0, 0, cv.height / vh, 0, 0);
  layoutBars();
  buildGradients();
  return true;
}

function drawIdle() {
  if (!vw && !fitViz()) return;
  g2.clearRect(0, 0, vw, vh);
  g2.fillStyle = gradIdle;
  g2.fillRect(0, Math.round(vh / 2) - 0.5, vw, 1);
}

/** Reduced motion still gets a readout, it just does not move. */
function drawStill() {
  if (!vw && !fitViz()) return;
  g2.clearRect(0, 0, vw, vh);
  g2.fillStyle = gradBars;
  for (let i = 0; i < barCount; i++) {
    const k = i / barCount;
    const h = (0.55 * Math.exp(-k * 1.7) + 0.09) * (0.78 + 0.22 * Math.sin(i * 1.9));
    bar(barX0 + i * (barW + barGap), Math.max(1.5, h * (vh - 2)));
  }
}

function bar(x, h) {
  const y = vh - h;
  if (g2.roundRect) {
    g2.beginPath();
    g2.roundRect(x, y, barW, h, Math.min(1.5, h / 2));
    g2.fill();
  } else {
    g2.fillRect(x, y, barW, h);
  }
}

function drawFrame(dt) {
  if (!vw && !fitViz()) return;
  if (!analyser || !freqData || !edges) return;
  analyser.getByteFrequencyData(freqData);

  g2.clearRect(0, 0, vw, vh);
  g2.fillStyle = gradBars;

  // fast to rise, slow to fall — the only way a meter feels right
  const up = 1 - Math.exp(-dt / 45);
  const down = 1 - Math.exp(-dt / 210);

  for (let i = 0; i < barCount; i++) {
    const a = edges[i];
    const b = Math.max(a + 1, edges[i + 1]);
    let sum = 0;
    for (let k = a; k < b; k++) sum += freqData[k];
    const target = clamp(Math.pow(sum / (b - a) / 255, 0.9) * 1.4, 0, 1);
    bars[i] += (target - bars[i]) * (target > bars[i] ? up : down);
    bar(barX0 + i * (barW + barGap), Math.max(1.5, bars[i] * (vh - 2)));
  }
}

function startViz() {
  if (!cv || vizStop) return;
  if (reducedMotion()) { drawStill(); return; }
  vizStop = ticker.add(drawFrame);
}

function stopViz() {
  if (vizStop) { vizStop(); vizStop = null; }
  if (bars) bars.fill(0);
  drawIdle();
}

function initViz() {
  cv = $("#amb-viz");
  if (!cv) return;
  g2 = cv.getContext("2d");
  if (!g2) { cv = null; return; }
  readTokens();
  fitViz();
  drawIdle();
  addEventListener("resize", debounce(() => {
    if (!fitViz()) return;
    if (phase === "on" && reducedMotion()) drawStill();
    else if (phase !== "on") drawIdle();
  }, 140));
}

/* ============================================================
   7. BOOT
   ============================================================ */

function onAmbienceChange(v, prev) {
  const wantOn = !!v?.on;
  const wasOn = !!prev?.on;
  if (wantOn !== wasOn) {
    if (wantOn) start();
    else stop();
    return;                 // start/stop apply the mix and the labels
  }
  applyMix();
  labels();
}

function onRoomChange() {
  applyRoom();
  labels();
}

function onMotionPref() {
  if (phase !== "on") { stopViz(); return; }
  if (reducedMotion()) {
    if (vizStop) { vizStop(); vizStop = null; }
    drawStill();
  } else if (!vizStop) {
    vizStop = ticker.add(drawFrame);
  }
}

export function initAmbience() {
  if (booted) return;
  booted = true;

  // an older visit may have stored a mixer without every key
  state.set("ambience", current());

  initViz();

  $("#amb-toggle")?.addEventListener("click", () => toggleAmbience());

  state.on("ambience", onAmbienceChange);
  state.on("weather", onRoomChange);
  state.on("fireOn", onRoomChange);
  onMotionChange(onMotionPref);

  if (current().on) {
    phase = "armed";
    armGesture();
  }
  labels();

  window.lair = Object.assign(window.lair || {}, {
    ambience: {
      toggle: toggleAmbience,
      setLayer,
      setMaster,
      get ctx() { return ctx; },
      get phase() { return phase; },
    },
  });
}
