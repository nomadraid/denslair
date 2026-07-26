/* ============ Den's Lair — main.js ============ */
"use strict";

/* ---------- THE SHELF ----------
   type "youtube": embedded via YouTube IFrame API (official free uploads only).
     Age-restricted tapes refuse to play embedded — the TV shows a fallback link.
   type "archive": public-domain films embedded from archive.org (no restrictions).
   To add a tape: drop an entry here. That's it. */
const SHELF = [
  {
    genre: "Sci-Fi", label: "SCI-FI", color: "#4aa3c8",
    title: "Metropolis (1927)", type: "archive", src: "metropolis_202511",
    link: "https://archive.org/details/metropolis_202511",
  },
  {
    genre: "Thriller", label: "THRILL", color: "#a83226",
    title: "D.O.A. (1950)", type: "archive", src: "d.-o.-a.-1950",
    link: "https://archive.org/details/d.-o.-a.-1950",
  },
  {
    genre: "Noir", label: "NOIR", color: "#23201c",
    title: "The Hitch-Hiker (1953)", type: "archive", src: "1thehitchhiker",
    link: "https://archive.org/details/1thehitchhiker",
  },
  {
    genre: "Cyberpunk", label: "CYBER", color: "#6c3fa0",
    title: "Equilibrium (2002)", type: "youtube", src: "vuyJx_pMae4",
    link: "https://youtu.be/vuyJx_pMae4",
  },
  {
    genre: "Drama", label: "DRAMA", color: "#d8a03c",
    title: "Scarlet Street (1945)", type: "archive", src: "ScarletStreet",
    link: "https://archive.org/details/ScarletStreet",
  },
  {
    genre: "Adventure", label: "ADVNT", color: "#3f7d4e",
    title: "The General (1926)", type: "archive", src: "TheGeneral720p1926",
    link: "https://archive.org/details/TheGeneral720p1926",
  },
  {
    genre: "Action", label: "ACTION", color: "#b3762a",
    title: "Kansas City Confidential (1952)", type: "archive", src: "KansasCityConfidential1952",
    link: "https://archive.org/details/KansasCityConfidential1952",
  },
];

const $ = (sel) => document.querySelector(sel);
const scene = $("#scene");
const sceneWrap = $(".scene-wrap");
const tvZone = $("#tv-zone");
const tvPlayer = $("#tv-player");
const tvMsg = $("#tv-msg");
const tvOsd = $("#tv-osd");
const tvLed = $("#tvLed");
const noiseCanvas = $("#tv-noise");
const toastEl = $("#toast");

/* ============ toast ============ */
let toastTimer = null;
function toast(text, ms = 2600) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

/* ============ TV: white noise ============ */
const nctx = noiseCanvas.getContext("2d", { willReadFrequently: false });
let noiseRunning = false;
let lastNoise = 0;
let rollY = 0;
function noiseLoop(t) {
  if (!noiseRunning) return;
  if (t - lastNoise > 40) { // ~25fps, plenty for static
    lastNoise = t;
    const { width: w, height: h } = noiseCanvas;
    const img = nctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    nctx.putImageData(img, 0, 0);
    // rolling brightness bar, very CRT
    rollY = (rollY + 2.5) % (h + 30);
    nctx.fillStyle = "rgba(255,255,255,0.09)";
    nctx.fillRect(0, rollY - 15, w, 14);
  }
  requestAnimationFrame(noiseLoop);
}
function startNoise() {
  if (noiseRunning) return;
  noiseRunning = true;
  requestAnimationFrame(noiseLoop);
}
function stopNoise() { noiseRunning = false; }

/* ============ TV: state machine ============ */
let tvState = "off";
let currentTape = null;
let osdTimer = null;

function setTvState(state) {
  tvState = state;
  tvZone.dataset.state = state;
  sceneWrap.dataset.tv = state;
  tvLed.setAttribute("fill", state === "off" ? "#5c2b22" : "#59ffa0");
  if (state === "static" || state === "loading") startNoise();
  else stopNoise();
  if (state === "off" || state === "static") {
    currentTape = null;
    destroyPlayback();
  }
}

function osd(text, sticky = false) {
  tvOsd.textContent = text;
  tvOsd.style.opacity = "1";
  clearTimeout(osdTimer);
  if (!sticky) osdTimer = setTimeout(() => (tvOsd.style.opacity = "0"), 4000);
}

/* ---------- playback backends ---------- */
let ytPlayer = null;
let ytApiPromise = null;
let watchdog = null;

function loadYouTubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

function destroyPlayback() {
  clearTimeout(watchdog);
  if (ytPlayer) {
    try { ytPlayer.destroy(); } catch (_) { /* already gone */ }
    ytPlayer = null;
  }
  tvPlayer.innerHTML = "";
}

function tvError(tape, headline) {
  setTvState("error");
  tvMsg.innerHTML =
    `<div>⚠ ${headline}</div>` +
    `<div style="margin-top:.6em">» <a href="${tape.link}" target="_blank" rel="noopener">WATCH AT THE SOURCE ↗</a></div>` +
    `<div style="margin-top:.6em;opacity:.6">[ ⏏ to return ]</div>`;
}

function playTape(tape) {
  destroyPlayback();
  currentTape = tape;
  setTvState("loading");
  osd(`▶ LOADING… ${tape.title.toUpperCase()}`, true);
  toast(`📼 ${tape.genre}: ${tape.title}`);

  if (tape.type === "youtube") {
    watchdog = setTimeout(() => tvError(tape, "NO SIGNAL — the tape won't start."), 12000);
    loadYouTubeApi().then((YT) => {
      if (currentTape !== tape) return;
      const mount = document.createElement("div");
      tvPlayer.innerHTML = "";
      tvPlayer.appendChild(mount);
      ytPlayer = new YT.Player(mount, {
        width: "100%",
        height: "100%",
        videoId: tape.src,
        host: "https://www.youtube-nocookie.com",
        playerVars: { autoplay: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: (e) => e.target.playVideo(),
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) {
              clearTimeout(watchdog);
              setTvState("playing");
              osd(`▶ ${tape.title.toUpperCase()}`);
            }
          },
          onError: (e) => {
            clearTimeout(watchdog);
            const restricted = e.data === 101 || e.data === 150;
            tvError(
              tape,
              restricted
                ? "AGE-RESTRICTED TAPE — YouTube refuses to play it inside the lair."
                : "TAPE DAMAGED — this video can't be embedded."
            );
          },
        },
      });
    });
  } else {
    // archive.org — plain iframe, no restrictions
    const frame = document.createElement("iframe");
    frame.src = `https://archive.org/embed/${encodeURIComponent(tape.src)}?autoplay=1`;
    frame.allow = "fullscreen";
    frame.allowFullscreen = true;
    frame.addEventListener("load", () => {
      if (currentTape !== tape) return;
      setTvState("playing");
      osd(`▶ ${tape.title.toUpperCase()}`);
    });
    tvPlayer.appendChild(frame);
    watchdog = setTimeout(() => {
      if (currentTape === tape && tvState === "loading") {
        setTvState("playing");
        osd(`▶ ${tape.title.toUpperCase()}`);
      }
    }, 6000);
  }
}

/* ============ DVD shelf ============ */
const SVG_NS = "http://www.w3.org/2000/svg";
function buildShelf() {
  const row = $("#dvdRow");
  const caseW = 34, caseH = 66, gap = 14;
  const total = SHELF.length * caseW + (SHELF.length - 1) * gap;
  const startX = 846 + (388 - total) / 2;
  const y = 608;
  SHELF.forEach((tape, i) => {
    const x = startX + i * (caseW + gap);
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "dvd");
    g.dataset.tip = `${tape.genre} — ${tape.title}`;
    g.dataset.index = String(i);

    const box = document.createElementNS(SVG_NS, "rect");
    box.setAttribute("x", x); box.setAttribute("y", y);
    box.setAttribute("width", caseW); box.setAttribute("height", caseH);
    box.setAttribute("rx", 3);
    box.setAttribute("fill", tape.color);
    box.setAttribute("stroke", "#0c0805");
    box.setAttribute("stroke-width", "2.5");

    const band = document.createElementNS(SVG_NS, "rect");
    band.setAttribute("x", x); band.setAttribute("y", y);
    band.setAttribute("width", caseW); band.setAttribute("height", 9);
    band.setAttribute("rx", 3);
    band.setAttribute("fill", "rgba(255,255,255,.28)");

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "dvd-label");
    label.setAttribute("x", x + caseW / 2);
    label.setAttribute("y", y + caseH / 2);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dominant-baseline", "middle");
    label.setAttribute("transform", `rotate(-90 ${x + caseW / 2} ${y + caseH / 2})`);
    label.setAttribute("fill", tape.color === "#23201c" ? "#d8c9a8" : "#0d0a08");
    label.textContent = tape.label;

    g.append(box, band, label);
    g.addEventListener("click", () => playTape(tape));
    row.appendChild(g);
  });
}

/* ============ room interactions ============ */
const WEATHERS = ["clear", "rain", "snow"];
const WEATHER_MSG = { clear: "🌙 clear night over the city", rain: "🌧 rain — cozy level rising", snow: "❄ snow — maximum cozy achieved" };

function cycleWeather() {
  const cur = scene.dataset.weather || "clear";
  const next = WEATHERS[(WEATHERS.indexOf(cur) + 1) % WEATHERS.length];
  scene.dataset.weather = next;
  toast(WEATHER_MSG[next]);
}

function toggleLights() {
  const off = scene.dataset.lights === "off";
  scene.dataset.lights = off ? "on" : "off";
  $("#switchNub").setAttribute("y", off ? "304" : "318");
  toast(off ? "💡 lights on" : "🌘 lights low — movie mode");
}

function toggleFire() {
  const off = scene.dataset.fire === "off";
  scene.dataset.fire = off ? "on" : "off";
  toast(off ? "🔥 fire's back on" : "🪵 fire banked for the night");
}

const CAT_LINES = ["meow.", "prrrp?", "*ignores you*", "mrrrow…", "*slow blink*", "feed me, human"];
let catTimer = null;
function pokeCat() {
  const bubble = $("#catBubble");
  const cat = $("#cat");
  bubble.textContent = CAT_LINES[(Math.random() * CAT_LINES.length) | 0];
  bubble.classList.add("show");
  cat.classList.add("awake");
  clearTimeout(catTimer);
  catTimer = setTimeout(() => {
    bubble.classList.remove("show");
    cat.classList.remove("awake");
  }, 2200);
}

/* ============ modal ============ */
const modal = $("#modal");
function openModal(name) {
  modal.dataset.show = name;
  modal.classList.add("open");
  if (name === "arcade") snakeFocus();
}
function closeModal() {
  modal.classList.remove("open");
  modal.dataset.show = "";
  snakeBlur();
}
modal.querySelector(".modal-backdrop").addEventListener("click", closeModal);
modal.querySelectorAll(".close").forEach((b) => b.addEventListener("click", closeModal));

/* ============ scene click routing ============ */
const ACTIONS = {
  weather: cycleWeather,
  lights: toggleLights,
  fire: toggleFire,
  cat: pokeCat,
  about: () => openModal("about"),
  recruiters: () => openModal("recruiters"),
  library: () => openModal("library"),
  arcade: () => openModal("arcade"),
  power: () => {
    if (tvState === "off") { setTvState("static"); osd("CH 03 — NO SIGNAL"); }
    else setTvState("off");
  },
};

scene.addEventListener("click", (e) => {
  const target = e.target.closest("[data-act]");
  if (!target) return;
  e.stopPropagation();
  const act = ACTIONS[target.dataset.act];
  if (act) act();
});

/* TV buttons */
$("#btnEject").addEventListener("click", () => {
  document.body.classList.remove("cinema");
  setTvState("static");
  osd("TAPE EJECTED");
});
$("#btnCinema").addEventListener("click", () => document.body.classList.toggle("cinema"));
$("#cinemaBackdrop").addEventListener("click", () => document.body.classList.remove("cinema"));

/* about link */
$("#aboutLink").addEventListener("click", (e) => { e.preventDefault(); openModal("about"); });

/* ============ tooltip ============ */
const tooltip = $("#tooltip");
document.addEventListener("mousemove", (e) => {
  const t = e.target.closest("[data-tip]");
  if (t && !modal.classList.contains("open")) {
    tooltip.textContent = t.dataset.tip;
    tooltip.classList.add("show");
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const r = tooltip.getBoundingClientRect();
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  } else {
    tooltip.classList.remove("show");
  }
});

/* ============ keyboard ============ */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.body.classList.contains("cinema")) document.body.classList.remove("cinema");
    else if (modal.classList.contains("open")) closeModal();
  }
});

/* ============ hint + intro ============ */
$("#hintClose").addEventListener("click", () => {
  $("#hint").classList.add("hidden");
  try { localStorage.setItem("lair-hint", "seen"); } catch (_) {}
});
try { if (localStorage.getItem("lair-hint")) $("#hint").classList.add("hidden"); } catch (_) {}

$("#enter").addEventListener("click", () => {
  const intro = $("#intro");
  intro.classList.add("gone");
  setTimeout(() => intro.remove(), 900);
  setTvState("static");
  osd("CH 03 — NO SIGNAL");
});

/* ============ SNAKE ============ */
const snakeCanvas = $("#snake");
const sctx = snakeCanvas.getContext("2d");
const GRID = 20, CELL = 16;
let snake, dir, nextDir, food, score, best = 0, alive, started, stepMs, acc, lastT, rafId = null;

try { best = Number(localStorage.getItem("lair-snake-best") || 0); } catch (_) {}
$("#snakeBest").textContent = best;

function snakeReset() {
  snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  dir = { x: 1, y: 0 };
  nextDir = dir;
  score = 0;
  stepMs = 150;
  alive = true;
  started = false;
  acc = 0;
  placeFood();
  $("#snakeScore").textContent = "0";
}

function placeFood() {
  do {
    food = { x: (Math.random() * GRID) | 0, y: (Math.random() * GRID) | 0 };
  } while (snake.some((s) => s.x === food.x && s.y === food.y));
}

function snakeStep() {
  dir = nextDir;
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
  if (head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID ||
      snake.some((s) => s.x === head.x && s.y === head.y)) {
    alive = false;
    if (score > best) {
      best = score;
      $("#snakeBest").textContent = best;
      try { localStorage.setItem("lair-snake-best", String(best)); } catch (_) {}
    }
    return;
  }
  snake.unshift(head);
  if (head.x === food.x && head.y === food.y) {
    score += 10;
    $("#snakeScore").textContent = score;
    stepMs = Math.max(70, stepMs - 2.5);
    placeFood();
  } else {
    snake.pop();
  }
}

function snakeDraw() {
  sctx.fillStyle = "#07120b";
  sctx.fillRect(0, 0, 320, 320);
  sctx.strokeStyle = "rgba(89,255,160,.05)";
  for (let i = 1; i < GRID; i++) {
    sctx.beginPath(); sctx.moveTo(i * CELL, 0); sctx.lineTo(i * CELL, 320); sctx.stroke();
    sctx.beginPath(); sctx.moveTo(0, i * CELL); sctx.lineTo(320, i * CELL); sctx.stroke();
  }
  // food
  sctx.fillStyle = "#e2571e";
  sctx.beginPath();
  sctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL / 2 - 3, 0, Math.PI * 2);
  sctx.fill();
  // snake
  snake.forEach((s, i) => {
    sctx.fillStyle = i === 0 ? "#8dffb8" : "#3f9d5e";
    sctx.beginPath();
    sctx.roundRect(s.x * CELL + 1.5, s.y * CELL + 1.5, CELL - 3, CELL - 3, 4);
    sctx.fill();
  });
  sctx.fillStyle = "rgba(216,201,168,.92)";
  sctx.font = "22px VT323, monospace";
  sctx.textAlign = "center";
  if (!started) {
    sctx.fillText("PRESS SPACE TO START", 160, 150);
  } else if (!alive) {
    sctx.fillText("GAME OVER", 160, 140);
    sctx.fillText("SPACE TO RETRY", 160, 170);
  }
}

function snakeLoop(t) {
  rafId = requestAnimationFrame(snakeLoop);
  if (lastT === undefined) lastT = t;
  const dt = t - lastT;
  lastT = t;
  if (started && alive) {
    acc += dt;
    while (acc >= stepMs) { acc -= stepMs; snakeStep(); }
  }
  snakeDraw();
}

function snakeFocus() {
  snakeReset();
  lastT = undefined;
  if (rafId === null) rafId = requestAnimationFrame(snakeLoop);
}
function snakeBlur() {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
}

const KEYMAP = {
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  w: { x: 0, y: -1 }, s: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 },
};
document.addEventListener("keydown", (e) => {
  if (modal.dataset.show !== "arcade") return;
  if (e.key === " ") {
    e.preventDefault();
    if (!started || !alive) { if (!alive) snakeReset(); started = true; }
    return;
  }
  const nd = KEYMAP[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (nd) {
    e.preventDefault();
    if (nd.x !== -dir.x || nd.y !== -dir.y) nextDir = nd;
  }
});

/* ============ boot ============ */
buildShelf();
scene.dataset.lights = "on";
scene.dataset.fire = "on";
