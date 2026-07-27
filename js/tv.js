/* ============================================================
   tv.js — the DEN·TRON.

   A five-state set: off -> static -> loading -> playing | error.
   `state.tv` is the only source of truth; everything visual is a
   reaction to it, so the terminal, the shelf and the hotspots can
   all drive the television by writing one key.

   Two playback backends live behind the same door:
     archive  — a plain iframe on archive.org/embed
     youtube  — the IFrame API on the nocookie host, which refuses
                to serve age-restricted uploads to third parties.
                That refusal is a normal outcome here, not a bug,
                so it gets a written explanation and a way out.
   ============================================================ */

import { $, el, clamp, rand, randInt, reducedMotion, onMotionChange, ticker }
  from "./util.js";
import * as state from "./state.js";
import { toast } from "./toast.js";

const STATES = new Set(["off", "static", "loading", "playing", "error"]);
/** States where the screen shows snow rather than a picture. */
const NOISY = new Set(["static", "loading", "error"]);

const NOISE_FPS = 25;
const NOISE_STEP = 1000 / NOISE_FPS;

const WARM_MS = 340;      // dot -> line -> full frame, on power up
const COLLAPSE_MS = 260;  // and the reverse, on power down

const OSD_MS = 3800;
const YT_WATCHDOG_MS = 12000;
const YT_NUDGE_MS = 5200;   // by now autoplay-with-sound has either worked or not
const YT_API_MS = 10000;
const ARCHIVE_ASSUME_MS = 6000;
const RESTRICTED_MS = 1400; // let the warning be read before the failure lands

let zone, playerHost, canvas, msgNode, osdNode, cinemaBtn, ejectBtn;
let booted = false;

/* ============================================================
   1. THE SNOW
   A 160x98 backing store on purpose: static wants to be coarse,
   and the browser stretches it over the screen glass for free.
   fitCanvas() is deliberately not used here — a device-pixel
   store would only make the noise finer and less convincing.
   ============================================================ */

/* Packing greys through a Uint32 view is worth the endian check. */
const LITTLE_ENDIAN = (() => {
  const probe = new Uint8Array(4);
  new Uint32Array(probe.buffer)[0] = 1;
  return probe[0] === 1;
})();
const grey = LITTLE_ENDIAN
  ? (v) => 0xff000000 | (v << 16) | (v << 8) | v
  : (v) => (v << 24) | (v << 16) | (v << 8) | 0xff;
const BLACK = grey(0);
const WHITE = grey(255);

let ctx = null;
let img = null;
let buf = null;
let NW = 0;
let NH = 0;
let BAND = null;          // persistent low-frequency profile, drifts vertically

let noiseStop = null;     // ticker unsubscribe, null when idle
let acc = 0;              // frame-rate limiter
let elapsed = 0;          // real ms since the last drawn frame
let mode = "idle";        // 'idle' | 'noise' | 'warm' | 'collapse'
let phase = 0;            // 0..1 through warm / collapse
let roll = 0;             // vertical drift of the hum bars, in rows
let barY = 0;             // the bright bar sweeping down the tube
let tear = null;

const BAR_H = 17;         // rows of soft lift
const BAR_GAP = 74;       // dead rows between sweeps, so it is a sweep not a stripe
const BAR_LIFT = 52;
const ROLL_PER_S = 9;
const BAR_PER_S = 58;
const TEAR_CHANCE = 0.018;

const easeOut = (t) => 1 - (1 - t) ** 3;
const easeIn = (t) => t * t * t;

function initCanvas() {
  canvas = $("#tv-static");
  if (!canvas) return false;
  NW = canvas.width || 160;
  NH = canvas.height || 98;
  ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return false;
  img = ctx.createImageData(NW, NH);
  buf = new Uint32Array(img.data.buffer);
  BAND = buildBand(NH);
  return true;
}

/** Harmonics of the frame height, so the profile wraps seamlessly. */
function buildBand(h) {
  const a = new Float32Array(h);
  const p1 = rand(0, Math.PI * 2);
  const p2 = rand(0, Math.PI * 2);
  for (let y = 0; y < h; y++) {
    const u = (y / h) * Math.PI * 2;
    a[y] = Math.sin(u + p1) * 0.62 + Math.sin(u * 3 + p2) * 0.28 + Math.sin(u * 7) * 0.1;
  }
  return a;
}

function bandAt(p) {
  const i = Math.floor(p);
  const f = p - i;
  const a = BAND[((i % NH) + NH) % NH];
  const b = BAND[(((i + 1) % NH) + NH) % NH];
  return a + (b - a) * f;
}

/** The rolling bar: a soft raised lift with a thin dark leading edge. */
function barAt(y) {
  const d = y - barY;
  if (d > 2 || d < -BAR_H) return 0;
  if (d >= 0) return -14 * (1 - d / 2);
  return Math.sin((Math.PI * (d + BAR_H)) / BAR_H) * BAR_LIFT;
}

/** Shape of the picture during power up / power down. */
function envelope() {
  if (mode === "warm") {
    const t = phase;
    const a = clamp(t / 0.28, 0, 1);
    const b = clamp((t - 0.22) / 0.78, 0, 1);
    return {
      wide: 0.06 + easeOut(a) * 0.94,
      open: easeOut(b),
      glow: 1 - clamp(t / 0.7, 0, 1),
      mix: clamp((t - 0.25) / 0.5, 0, 1),
    };
  }
  if (mode === "collapse") {
    const t = phase;
    return {
      wide: t < 0.7 ? 1 : 1 - ((t - 0.7) / 0.3) * 0.94,
      open: 1 - easeIn(t),
      glow: t,
      // the signal dies well before the geometry does
      mix: clamp(1 - t * 2.2, 0, 1),
    };
  }
  return { wide: 1, open: 1, glow: 0, mix: 1 };
}

function advance(dt) {
  const s = dt / 1000;
  roll = (roll + ROLL_PER_S * s) % NH;
  barY += BAR_PER_S * s;
  if (barY > NH + BAR_GAP) barY -= NH + BAR_GAP + BAR_H;

  if (tear && --tear.ttl <= 0) tear = null;
  else if (!tear && Math.random() < TEAR_CHANCE) {
    const h = randInt(2, 13);
    const y0 = randInt(0, NH - 1 - h);
    tear = {
      y0,
      y1: y0 + h,
      dy: randInt(6, 34),                       // the band's content jumps
      hx: randInt(0, NW - 1),                   // where the bright streak starts
      hw: randInt(10, 34),
      lift: rand(-26, 38),
      ttl: randInt(1, 3),
    };
  }
}

function drawFrame(dt) {
  if (!ctx) return;
  advance(dt);

  const env = envelope();
  const cy = (NH - 1) / 2;
  const cx = (NW - 1) / 2;
  const halfY = Math.max(0.5, (NH / 2) * env.open);
  const halfX = Math.max(0.5, (NW / 2) * env.wide);
  const y0 = Math.max(0, Math.ceil(cy - halfY));
  const y1 = Math.min(NH - 1, Math.floor(cy + halfY));
  const x0 = Math.max(0, Math.ceil(cx - halfX));
  const x1 = Math.min(NW - 1, Math.floor(cx + halfX));
  const boxed = env.open < 1 || env.wide < 1;
  if (boxed) buf.fill(BLACK);

  const sig = 0.9 + halfY * 0.22;
  const flat = (1 - env.mix) * 92;
  let sum = 0;
  let seen = 0;

  for (let y = y0; y <= y1; y++) {
    let src = y;
    let lift = 0;
    let span = 176;
    if (tear && y >= tear.y0 && y < tear.y1) {
      src = y + tear.dy;
      lift = tear.lift;
      span = 96;                                 // a tear smears; it stops fizzing
      if (y === tear.y0) lift -= 54;             // hard edge where the line slipped
    }

    const dy = y - cy;
    const glow = env.glow > 0 ? env.glow * 235 * Math.exp(-(dy * dy) / (2 * sig * sig)) : 0;
    const base = 118 + bandAt(src + roll) * 13 + barAt(y) + lift + flat + glow;
    const s = span * (0.78 + Math.random() * 0.44) * env.mix;
    const lo = base - s * 0.5;
    const row = y * NW;

    for (let x = x0; x <= x1; x++) {
      let v = lo + Math.random() * s;
      v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
      buf[row + x] = grey(v);
      sum += v;
      seen++;
    }
  }

  // the bright head of a tear, drawn over the band it belongs to
  if (tear) {
    const ty0 = Math.max(y0, tear.y0);
    const ty1 = Math.min(y1, tear.y1 - 1);
    for (let y = ty0; y <= ty1; y++) {
      const row = y * NW;
      for (let i = 0; i < tear.hw; i++) {
        const x = (tear.hx + i) % NW;
        if (x < x0 || x > x1) continue;
        const k = 1 - i / tear.hw;
        buf[row + x] = grey(clamp(150 + k * 105 + rand(-20, 20), 0, 255) | 0);
      }
    }
  }

  // a handful of hard sparkles — this is what makes snow fizz
  if (mode === "noise" && y1 >= y0) {
    for (let i = 0; i < 34; i++) {
      const x = x0 + ((Math.random() * (x1 - x0 + 1)) | 0);
      const y = y0 + ((Math.random() * (y1 - y0 + 1)) | 0);
      buf[y * NW + x] = i & 1 ? WHITE : BLACK;
    }
  }

  ctx.putImageData(img, 0, 0);
  setLum(seen ? (sum / (seen * 255)) * (seen / (NW * NH)) : 0);

  if (mode === "warm" || mode === "collapse") {
    phase += dt / (mode === "warm" ? WARM_MS : COLLAPSE_MS);
    if (phase >= 1) {
      phase = 0;
      if (mode === "warm") { mode = "noise"; setAnim(""); }
      else { mode = "idle"; setAnim(""); stopNoise(); clearScreen(); }
    }
  }
}

function onFrame(dt) {
  acc += dt;
  elapsed += dt;
  if (acc < NOISE_STEP) return;
  acc = Math.min(acc - NOISE_STEP, NOISE_STEP);
  const e = elapsed;
  elapsed = 0;
  drawFrame(e);
}

function startNoise() {
  if (!ctx && !initCanvas()) return;
  if (reducedMotion()) {
    // one honest frame of snow, then nothing per-frame at all
    stopNoise();
    mode = "noise";
    setAnim("");
    drawFrame(NOISE_STEP);
    return;
  }
  if (!noiseStop) {
    acc = 0;
    elapsed = 0;
    noiseStop = ticker.add(onFrame);
  }
}

function stopNoise() {
  if (noiseStop) { noiseStop(); noiseStop = null; }
}

function clearScreen() {
  if (ctx) ctx.clearRect(0, 0, NW, NH);
  setLum(0);
}

function setAnim(v) {
  if (zone) zone.dataset.anim = v;
}

/** Power up. `flash` plays the CRT dot-to-frame bloom first. */
function powerUp(flash) {
  if (!ctx && !initCanvas()) return;
  if (flash && !reducedMotion()) {
    mode = "warm";
    phase = 0;
    setAnim("warm");
  } else if (mode !== "noise") {
    mode = "noise";
    setAnim("");
  }
  startNoise();
}

/** Power down. `flash` collapses the picture to a dot on the way out. */
function powerDown(flash) {
  if (flash && !reducedMotion() && ctx) {
    mode = "collapse";
    phase = 0;
    setAnim("collapse");
    startNoise();
    return;
  }
  mode = "idle";
  setAnim("");
  stopNoise();
  clearScreen();
}

/* The screen's own brightness, published for fx.css to hang the
   room's TV glow on. Nothing breaks if nobody reads it. */
let lumOut = -1;
function setLum(v) {
  const q = Math.round(clamp(v, 0, 1) * 100) / 100;
  if (q === lumOut) return;
  lumOut = q;
  document.documentElement.style.setProperty("--tv-lum", String(q));
}

/* ============================================================
   2. THE ON-SCREEN DISPLAY
   ============================================================ */

let osdTimer = null;

function osd(text, sticky = false) {
  if (!osdNode) return;
  osdNode.textContent = text;
  osdNode.dataset.on = "true";
  osdNode.style.opacity = "1";
  clearTimeout(osdTimer);
  if (!sticky) osdTimer = setTimeout(hideOsd, OSD_MS);
}

function hideOsd() {
  clearTimeout(osdTimer);
  if (!osdNode) return;
  osdNode.dataset.on = "false";
  osdNode.style.opacity = "0";
}

function setMessage(spec) {
  if (!msgNode) return;
  if (!spec) { msgNode.replaceChildren(); return; }
  msgNode.replaceChildren(
    el("p", { class: "tv-msg-head", text: "no picture" }),
    el("p", { class: "tv-msg-body", text: spec.reason }),
    el("p", { class: "tv-msg-act" },
      el("a", {
        class: "tv-msg-link",
        href: spec.href,
        target: "_blank",
        rel: "noopener noreferrer",
      }, spec.label)),
    el("p", { class: "tv-msg-fine", text: "eject puts it back on the shelf" }),
  );
}

/* ============================================================
   3. PLAYBACK
   ============================================================ */

let session = 0;      // bumped on every load; stale callbacks check it
let loaded = null;    // the film this module believes is in the machine
let yt = null;
let ytApi = null;
let timers = [];

const filmTitle = (f) => (f && f.title) || "untitled tape";

const safe = (fn) => { try { return fn(); } catch { /* the API throws after destroy */ } };

function later(ms, fn) {
  const id = setTimeout(fn, ms);
  timers.push(id);
  return id;
}

function clearTimers() {
  for (const id of timers) clearTimeout(id);
  timers = [];
}

/** Where to send someone when we cannot play it here. */
function sourceLink(film) {
  const raw = typeof film.link === "string" ? film.link.trim() : "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (film.type === "youtube") {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(film.src)}`;
  }
  return `https://archive.org/details/${encodeURIComponent(film.src)}`;
}

function loadYouTubeApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === "function") safe(prev);
      resolve(window.YT);
    };
    const tag = el("script", {
      src: "https://www.youtube.com/iframe_api",
      async: "",
      onError: () => reject(new Error("script blocked")),
    });
    document.head.append(tag);
    setTimeout(() => reject(new Error("api timeout")), YT_API_MS);
  });
  // a failed attempt must not poison the next one
  ytApi.catch(() => { ytApi = null; });
  return ytApi;
}

function destroyPlayback() {
  clearTimers();
  if (yt) {
    safe(() => yt.stopVideo && yt.stopVideo());
    safe(() => yt.destroy());
    yt = null;
  }
  if (playerHost) playerHost.replaceChildren();
}

function succeed(film) {
  clearTimers();
  setTvState("playing");
  osd(`▶ ${filmTitle(film)}`);
}

function fail(film, reason) {
  clearTimers();
  destroyPlayback();
  setTvState("error");
  hideOsd();
  setMessage({
    reason,
    href: sourceLink(film),
    label: `watch ${filmTitle(film)} at the source`,
  });
}

function playArchive(film, token) {
  const frame = el("iframe", {
    src: `https://archive.org/embed/${encodeURIComponent(film.src)}?autoplay=1`,
    title: filmTitle(film),
    // autoplay has to be granted explicitly or the embed sits there muted-paused
    allow: "autoplay; fullscreen; encrypted-media; picture-in-picture",
    allowfullscreen: "",
    loading: "eager",
    style: { width: "100%", height: "100%", border: "0", display: "block", background: "#000" },
    onLoad: () => { if (token === session) succeed(film); },
    onError: () => { if (token === session) fail(film, "the archive isn't answering."); },
  });
  playerHost.replaceChildren(frame);
  // some browsers never fire load for a cross-origin frame; assume the best
  later(ARCHIVE_ASSUME_MS, () => {
    if (token === session && state.get("tv") === "loading") succeed(film);
  });
}

function playYouTube(film, token) {
  later(YT_WATCHDOG_MS, () => {
    if (token === session) fail(film, "no signal — the tape never started.");
  });

  loadYouTubeApi().then((YT) => {
    if (token !== session) return;
    if (!YT || !YT.Player) throw new Error("no api");

    const PLAYING = (YT.PlayerState && YT.PlayerState.PLAYING) ?? 1;
    const ENDED = (YT.PlayerState && YT.PlayerState.ENDED) ?? 0;

    const mount = el("div");
    playerHost.replaceChildren(mount);

    yt = new YT.Player(mount, {
      width: "100%",
      height: "100%",
      videoId: film.src,
      host: "https://www.youtube-nocookie.com",
      playerVars: {
        autoplay: 1,
        rel: 0,
        playsinline: 1,
        modestbranding: 1,
        iv_load_policy: 3,
        ...(location.protocol.startsWith("http") ? { origin: location.origin } : {}),
      },
      events: {
        onReady: (e) => {
          if (token !== session) return;
          safe(() => e.target.playVideo());
        },
        onStateChange: (e) => {
          if (token !== session) return;
          if (e.data === PLAYING) succeed(film);
          else if (e.data === ENDED) osd("that's the end. eject for another.");
        },
        onError: (e) => {
          if (token !== session) return;
          const code = e && e.data;
          fail(film,
            code === 101 || code === 150
              ? "age-restricted — youtube will not embed it here."
              : code === 100
                ? "youtube can't find this one any more."
                : "this tape refuses to embed.");
        },
      },
    });

    // Autoplay with sound is blocked more often than not. Muting is an
    // ugly but honest way to get a picture; say so rather than hide it.
    later(YT_NUDGE_MS, () => {
      if (token !== session || state.get("tv") !== "loading" || !yt) return;
      safe(() => { yt.mute(); yt.playVideo(); });
      osd("started it muted — unmute on the player", true);
    });
  }).catch(() => {
    if (token !== session) return;
    fail(film, "couldn't reach youtube from here.");
  });
}

/**
 * Load a film and try to play it. Destroys whatever was playing first,
 * so audio never survives a change of tape.
 */
export function playTape(film) {
  if (!film || !film.src || !playerHost) return;

  const token = ++session;
  destroyPlayback();
  loaded = film;
  if (state.get("tape") !== film) state.set("tape", film);

  setTvState("loading");
  osd(`▶ loading · ${filmTitle(film)}`, true);
  toast(film.genre ? `${String(film.genre).toLowerCase()} · ${filmTitle(film)}` : filmTitle(film));

  const start = () => {
    if (token !== session) return;
    if (film.type === "youtube") playYouTube(film, token);
    else playArchive(film, token);
  };

  if (film.restricted) {
    // the warning first, so the refusal that usually follows reads as expected
    osd("heads up — youtube often refuses this one", true);
    later(RESTRICTED_MS, start);
  } else {
    start();
  }
}

/* ============================================================
   4. THE STATE MACHINE
   ============================================================ */

/** Move the set to a state. Anything may also write `state.tv` directly. */
export function setTvState(s) {
  if (!STATES.has(s)) return;
  state.set("tv", s);
}

function apply(s, prev) {
  if (zone) zone.dataset.state = s;

  if (s === "off" || s === "static") {
    session++;                       // orphan any load still in flight
    loaded = null;
    destroyPlayback();
    if (state.get("tape")) state.set("tape", null);
  }
  if (s !== "error") setMessage(null);

  if (s === "off") {
    hideOsd();
    if (state.get("cinema")) state.set("cinema", false);
    powerDown(prev !== undefined && prev !== "off");
  } else if (s === "playing") {
    stopNoise();
    mode = "idle";
    setAnim("");
    clearScreen();
    setLum(0.62);
  } else {
    powerUp(prev === "off");
  }

  if (ejectBtn) {
    ejectBtn.title = s === "off" ? "switch on" : s === "static" ? "switch off" : "eject";
  }
}

/** Stop the tape and drop back to a dead channel. */
export function ejectTape() {
  const had = state.get("tape") || loaded;
  if (state.get("cinema")) state.set("cinema", false);
  if (state.get("tv") === "off") return;
  setTvState("static");
  osd(had ? "tape ejected" : "ch 03 · no signal");
}

/* ============================================================
   5. CINEMA MODE
   room.css owns the expansion; this only owns the switch.
   ============================================================ */

export function toggleCinema(force) {
  const next = typeof force === "boolean" ? force : !state.get("cinema");
  if (next && state.get("tv") === "off") {
    toast("nothing's on. pick something off the shelf.");
    return;
  }
  state.set("cinema", next);
}

function onCinema(v) {
  if (cinemaBtn) {
    cinemaBtn.setAttribute("aria-pressed", String(v));
    cinemaBtn.title = v ? "leave cinema mode" : "cinema mode";
  }
  if (v) osd("cinema mode · esc to come back");
}

/* ============================================================
   6. BOOT
   ============================================================ */

export function initTv() {
  if (booted) return;
  zone = $("#tv-zone");
  if (!zone) return;
  booted = true;

  playerHost = $("#tv-player");
  msgNode = $("#tv-message");
  osdNode = $("#tv-osd");
  cinemaBtn = $("#tv-cinema");
  ejectBtn = $("#tv-eject");

  initCanvas();
  hideOsd();

  state.on("tv", apply, true);
  state.on("cinema", onCinema, true);

  // Something else may load a tape by writing the key rather than
  // calling playTape. Honour it, without looping back on ourselves.
  state.on("tape", (film) => {
    if (film && film !== loaded) playTape(film);
  });

  ejectBtn?.addEventListener("click", () => {
    const s = state.get("tv");
    if (s === "off") { setTvState("static"); osd("ch 03 · no signal"); }
    else if (s === "static") setTvState("off");
    else ejectTape();
  });

  cinemaBtn?.addEventListener("click", () => toggleCinema());
  $("#cinema-backdrop")?.addEventListener("click", () => toggleCinema(false));

  // Capture phase on window: cinema must unwind before any panel does.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state.get("cinema")) return;
    e.stopPropagation();
    e.preventDefault();
    toggleCinema(false);
  }, true);

  onMotionChange(() => {
    if (NOISY.has(state.get("tv"))) startNoise();
    else stopNoise();
  });

  // The set warms itself up a beat after the visitor walks in. Harmless
  // if something else has already put a picture on it.
  state.on("entered", (v) => {
    if (v) setTimeout(() => { if (state.get("tv") === "off") setTvState("static"); }, 900);
  }, true);

  window.lair = Object.assign(window.lair || {}, {
    tv: { playTape, setTvState, ejectTape, toggleCinema },
  });
}
