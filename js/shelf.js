/* ============================================================
   shelf.js — the film shelf.

   Seven painted compartments, seven genres. Every board in the
   artwork has its own tilt, so each row is rotated to match the
   board it stands on; without that the cases read as stickers
   rather than objects.

   All sizing here is expressed in PLATE pixels and converted to
   screen pixels through --pp (one plate px), which is derived
   from --room-w. scene.js keeps --room-w current on resize, so
   nothing in this module has to listen for one.

   No ticker subscription: every motion here is a CSS transition
   on a transform, so an idle shelf costs nothing per frame.
   ============================================================ */

import { SHELF, PLATE, px } from "./geometry.js";
import { $, el, clamp, reducedMotion } from "./util.js";
import * as state from "./state.js";
import { toast } from "./toast.js";
import { playTape } from "./tv.js";
import * as catalogue from "./data/films.js";

/* The box scene.js gives us, in plate space. Derived, never typed. */
const ZONE = {
  x0: SHELF.x0,
  y0: SHELF.bounds.y,
  w: SHELF.width,
  h: SHELF.bounds.h,
};

/* ---------- row metrics, plate px ---------- */
const PAD_L = 4;      // clear of the left upright
const PAD_R = 5;
const PAD_B = 3;      // the board has a front lip; don't stand on the edge
const LAB_W = 40;     // fixed label column, so the genres line up down the shelf
const LAB_GAP = 4;
const GAP = 2.4;      // breathing room between cases when there is room to breathe
const CASE_RATIO = 0.68;   // width / height of a case face
const CASE_FILL = 0.72;    // of the compartment height — the rest is headroom for the lift
const MIN_ADVANCE = 0.42;  // a case may never hide more than 58% of its neighbour

/* ---------- detail card, plate px ---------- */
const CARD_W = 258;
const CARD_H = 150;
const CARD_GUTTER = 16;   // between the card and the shelf's left upright

const THUMB = "https://archive.org/services/img/";

let zone = null;
let card = null;
let cardParts = null;
let rows = [];            // [{ el, label, key, films, buttons, geo }]
let keyIndex = new Map(); // normalised alias -> row index
let cursor = { r: 0, c: 0 };
let showTimer = null;
let hideTimer = null;
let pulseTimer = null;

/* ============================================================
   reading data/films.js

   That file is authored in parallel with this one, so rather than
   betting on one shape we accept either a flat list of films with
   a genre on each, or a list of genre groups. Source order is the
   shelf order in both cases.
   ============================================================ */

const firstOf = (obj, ...keys) => {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== "") return v;
  }
  return null;
};

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

function arrayExports() {
  const named = ["GENRES", "SHELF", "CATALOGUE", "CATALOG", "FILMS", "TAPES",
                 "genres", "shelf", "catalogue", "films", "tapes", "default"];
  const seen = new Set();
  const out = [];
  for (const k of named) {
    const v = catalogue[k];
    if (Array.isArray(v) && v.length && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  for (const v of Object.values(catalogue)) {
    if (Array.isArray(v) && v.length && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

const looksGrouped = (arr) =>
  arr.every((g) => g && Array.isArray(firstOf(g, "films", "items", "tapes", "movies", "entries")));

/** -> [{ label, key, colour, films: [raw] }] in source order. */
function readCatalogue() {
  const arrays = arrayExports();
  const grouped = arrays.find(looksGrouped);

  if (grouped) {
    return grouped.map((g) => ({
      label: String(firstOf(g, "label", "genre", "name", "title", "key") || "—"),
      key: String(firstOf(g, "key", "id", "slug", "genre", "label", "name") || ""),
      colour: firstOf(g, "colour", "color", "accent"),
      films: firstOf(g, "films", "items", "tapes", "movies", "entries") || [],
    }));
  }

  const flat = arrays.find((a) => a.some((f) => firstOf(f, "title", "name")));
  if (!flat) return [];

  const order = [];
  const byGenre = new Map();
  for (const f of flat) {
    const raw = firstOf(f, "genre", "genreKey", "category", "section") || "other";
    const k = norm(raw);
    if (!byGenre.has(k)) {
      byGenre.set(k, {
        label: String(firstOf(f, "label", "genre") || raw),
        key: String(raw),
        colour: null,
        films: [],
      });
      order.push(k);
    }
    byGenre.get(k).films.push(f);
  }
  return order.map((k) => byGenre.get(k));
}

/* ---------- one film, normalised ---------- */

function fmtRuntime(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return `${Math.round(v)} min`;
  const s = String(v).trim();
  return /^\d+$/.test(s) ? `${s} min` : s;
}

function initialsOf(title) {
  const words = title
    .replace(/\(\d{4}\)/g, " ")
    .split(/[\s.\-—–:,'"]+/)
    .filter(Boolean)
    .filter((w) => !/^(the|a|an|of|and|de|la|le|el)$/i.test(w));
  const src = words.length ? words : [title];
  // an all-initials title (D.O.A.) deserves all of its letters
  const take = src.every((w) => w.length === 1) ? 3 : 2;
  return src.slice(0, take).map((w) => w[0]).join("").toUpperCase() || "?";
}

function artUrl(raw) {
  const direct = firstOf(raw, "poster", "thumb", "thumbnail", "art", "image", "cover");
  if (direct) return String(direct);

  let id = firstOf(raw, "archive", "archiveId", "identifier", "ia");
  if (!id) {
    const kind = String(firstOf(raw, "type", "source", "host", "provider") || "").toLowerCase();
    if (kind === "archive" || kind === "archive.org" || kind === "ia") {
      id = firstOf(raw, "src", "id", "slug");
    }
  }
  return id ? THUMB + encodeURIComponent(String(id)) : null;
}

function readFilm(raw, groupColour) {
  const rawTitle = String(firstOf(raw, "title", "name") || "untitled");
  const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(rawTitle);
  const year = firstOf(raw, "year", "released") ?? (m ? Number(m[2]) : null);
  const title = m ? m[1] : rawTitle;

  return {
    raw,
    title,
    year,
    runtime: fmtRuntime(firstOf(raw, "runtime", "mins", "minutes", "duration", "length")),
    blurb: firstOf(raw, "blurb", "summary", "note", "desc", "description", "tagline"),
    colour: String(firstOf(raw, "colour", "color", "paint") || groupColour || "#5b3d2a"),
    art: artUrl(raw),
    initials: initialsOf(title),
  };
}

/* ============================================================
   geometry -> css
   ============================================================ */

const pctY = (v) => ((v - ZONE.y0) / ZONE.h) * 100;
const r2 = (n) => Math.round(n * 100) / 100;

/** Deterministic 0..1 per cell, so the cases don't reshuffle on re-render. */
function jitter(r, c) {
  const s = Math.sin((r + 1) * 12.9898 + (c + 1) * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Case size + horizontal advance for a row holding `n` cases. */
function packRow(rowH, n) {
  const ch = rowH * CASE_FILL;
  let cw = ch * CASE_RATIO;
  const avail = ZONE.w - PAD_L - PAD_R - LAB_W - LAB_GAP;
  let step = GAP;

  if (n > 1) {
    let advance = (avail - cw) / (n - 1);
    if (advance >= cw + GAP) advance = cw + GAP;
    if (advance < cw * MIN_ADVANCE) {
      // still won't fit even shoulder to shoulder: narrow the cases instead
      cw = avail / (1 + MIN_ADVANCE * (n - 1));
      advance = cw * MIN_ADVANCE;
    }
    step = advance - cw;
  }
  return { cw: r2(cw), ch: r2(ch), step: r2(step) };
}

/* ============================================================
   markup
   ============================================================ */

function buildCase(film, r, c, n) {
  const label = film.year ? `play ${film.title}, ${film.year}` : `play ${film.title}`;

  const art = el("img", {
    class: "sh-art", alt: "", decoding: "async", loading: "lazy",
    fetchpriority: "low", referrerpolicy: "no-referrer",
  });

  const face = el("span", { class: "sh-face" },
    el("span", { class: "sh-init", text: film.initials }),
    art,
    el("span", { class: "sh-gloss" }),
    el("span", { class: "sh-spine" }),
  );

  const btn = el("button", {
    type: "button",
    class: "sh-case",
    "aria-label": label,
    tabindex: "-1",
  },
    el("span", { class: "sh-cast" }),
    el("span", { class: "sh-body" }, face),
  );

  btn.style.setProperty("--tilt", `${r2((jitter(r, c) * 2 - 1) * 1.6)}deg`);
  btn.style.setProperty("--paint", film.colour);
  btn.style.setProperty("--i", String(c));
  // left-hand cases sit in front: the shelf is right of the viewer's centre
  btn.style.setProperty("--z", String(60 + (n - c)));

  if (film.art) {
    art.addEventListener("load", () => { btn.dataset.art = "ok"; }, { once: true });
    art.addEventListener("error", () => { btn.dataset.art = "none"; }, { once: true });
    art.src = film.art;
    if (art.complete && art.naturalWidth) btn.dataset.art = "ok";
  } else {
    btn.dataset.art = "none";
  }

  btn._film = film;
  btn._rc = { r, c };
  return btn;
}

function buildRow(group, geo, r, runningIndex) {
  const films = (group.films || []).map((f) => readFilm(f, group.colour));
  const { cw, ch, step } = packRow(geo.h, Math.max(films.length, 1));

  const node = el("div", {
    class: "sh-row",
    role: "group",
    "aria-label": group.label,
  });

  node.style.top = `${r2(pctY(geo.y))}%`;
  node.style.height = `${r2((geo.h / ZONE.h) * 100)}%`;
  node.style.transform = `rotate(${r2(geo.rot)}deg)`;
  node.style.setProperty("--cw", String(cw));
  node.style.setProperty("--ch", String(ch));
  node.style.setProperty("--step", String(step));
  node.style.setProperty("--r", String(r));

  node.append(el("span", { class: "sh-label", text: group.label }));

  const buttons = films.map((film, c) => {
    const btn = buildCase(film, r, c, films.length);
    btn.style.setProperty("--n", String(runningIndex + c));
    node.append(btn);
    return btn;
  });

  if (!films.length) node.classList.add("is-empty");

  return { el: node, label: group.label, key: group.key, films, buttons };
}

/* ============================================================
   the detail card — where the real information lives, because
   nothing at 30 plate px wide can carry it
   ============================================================ */

function buildCard(room) {
  const img = el("img", {
    class: "shd-img", alt: "", decoding: "async", referrerpolicy: "no-referrer",
  });
  const artBox = el("div", { class: "shd-art" },
    el("span", { class: "shd-init" }),
    img,
  );
  const genre = el("div", { class: "shd-genre" });
  const title = el("div", { class: "shd-title" });
  const meta = el("div", { class: "shd-meta" });
  const blurb = el("p", { class: "shd-blurb" });
  const cta = el("div", { class: "shd-cta", text: "click to play" });

  const node = el("aside", { id: "shelf-detail", "aria-hidden": "true" },
    el("span", { class: "shd-nib" }),
    artBox,
    el("div", { class: "shd-text" }, genre, title, meta, blurb, cta),
  );

  const left = SHELF.x0 - CARD_GUTTER - CARD_W;
  node.style.left = px(left, "x");
  node.style.width = px(CARD_W, "x");
  node.style.height = px(CARD_H, "y");

  room.append(node);
  cardParts = { img, artBox, genre, title, meta, blurb, cta };
  return node;
}

function paintCard(btn) {
  if (!card || !cardParts) return;
  if (document.body.dataset.narrow === "true") return;
  if (state.get("cinema") || state.get("panel")) return;

  const film = btn._film;
  const row = rows[btn._rc.r];
  if (!film || !row) return;

  const p = cardParts;
  p.genre.textContent = row.label;
  p.title.textContent = film.title;
  p.meta.textContent = [film.year, film.runtime].filter(Boolean).join("  ·  ");
  p.blurb.textContent = film.blurb || "";
  p.blurb.hidden = !film.blurb;
  p.init ??= card.querySelector(".shd-init");
  p.init.textContent = film.initials;
  card.style.setProperty("--paint", film.colour);

  const want = film.art || "";
  if (p.img.dataset.want !== want) {
    p.img.dataset.want = want;
    p.artBox.dataset.art = "none";
    if (want) {
      p.img.onload = () => { if (p.img.dataset.want === want) p.artBox.dataset.art = "ok"; };
      p.img.onerror = () => { p.artBox.dataset.art = "none"; };
      p.img.src = want;
      if (p.img.complete && p.img.naturalWidth) p.artBox.dataset.art = "ok";
    } else {
      p.img.removeAttribute("src");
    }
  }

  const midY = row.geo.y + row.geo.h / 2;
  const top = clamp(midY - CARD_H / 2, 22, PLATE.h - CARD_H - 22);
  card.style.top = px(top, "y");
  card.style.setProperty("--nib", `${r2(((midY - top) / CARD_H) * 100)}%`);

  card.classList.add("is-shown");
}

function askCard(btn) {
  clearTimeout(hideTimer);
  if (card && card.classList.contains("is-shown")) { paintCard(btn); return; }
  clearTimeout(showTimer);
  showTimer = setTimeout(() => paintCard(btn), 110);
}

function dropCard(now = false) {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  if (now) card?.classList.remove("is-shown");
  else hideTimer = setTimeout(() => card?.classList.remove("is-shown"), 130);
}

/* ============================================================
   interaction
   ============================================================ */

function play(btn) {
  const film = btn?._film;
  if (!film) return;
  dropCard(true);
  const named = film.year ? `${film.title} (${film.year})` : film.title;
  try { playTape(film.raw); } catch (err) { console.error("[shelf] playTape", err); }
  toast(`now playing — ${named}`);
}

function setCursor(r, c, focus = true) {
  if (!rows.length) return;
  r = clamp(r, 0, rows.length - 1);
  const list = rows[r].buttons;
  if (!list.length) return;
  c = clamp(c, 0, list.length - 1);

  rows[cursor.r]?.buttons[cursor.c]?.setAttribute("tabindex", "-1");
  cursor = { r, c };
  const btn = list[c];
  btn.setAttribute("tabindex", "0");
  if (focus) btn.focus();
}

/** Nearest row above/below that actually holds something. */
function stepRow(from, dir) {
  for (let r = from + dir; r >= 0 && r < rows.length; r += dir) {
    if (rows[r].buttons.length) return r;
  }
  return -1;
}

function onKeydown(e) {
  const btn = e.target.closest?.(".sh-case");
  if (!btn) return;
  const { r, c } = btn._rc;
  let handled = true;

  switch (e.key) {
    case "ArrowRight": setCursor(r, c + 1); break;
    case "ArrowLeft":  setCursor(r, c - 1); break;
    case "ArrowDown": { const n = stepRow(r, 1);  if (n >= 0) setCursor(n, c); break; }
    case "ArrowUp":   { const n = stepRow(r, -1); if (n >= 0) setCursor(n, c); break; }
    case "Home":      setCursor(e.ctrlKey ? 0 : r, 0); break;
    case "End":       setCursor(r, rows[r].buttons.length - 1); break;
    case "Escape":    dropCard(true); btn.blur(); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
}

function wire() {
  zone.addEventListener("keydown", onKeydown);

  zone.addEventListener("click", (e) => {
    const btn = e.target.closest(".sh-case");
    if (btn) play(btn);
  });

  zone.addEventListener("focusin", (e) => {
    const btn = e.target.closest(".sh-case");
    if (!btn) return;
    const { r, c } = btn._rc;
    if (r !== cursor.r || c !== cursor.c) setCursor(r, c, false);
    askCard(btn);
  });

  zone.addEventListener("focusout", (e) => {
    if (!zone.contains(e.relatedTarget)) dropCard();
  });

  // pointerover/out bubble, so one pair of listeners covers every case
  zone.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const btn = e.target.closest(".sh-case");
    if (btn) askCard(btn);
  });

  zone.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch") return;
    const btn = e.target.closest(".sh-case");
    if (btn && !btn.contains(e.relatedTarget)) dropCard();
  });

  // the card has no business hanging around once the room changes mode
  state.on("panel", (v) => { if (v) dropCard(true); });
  state.on("cinema", (v) => { if (v) dropCard(true); });
}

/* ============================================================
   public: pulse one row
   ============================================================ */

/**
 * Briefly draw the eye to one genre. Accepts a key, a genre name,
 * a label or a row index. Returns false if nothing matched.
 */
export function highlightGenre(key) {
  if (!rows.length || key == null) return false;

  let idx = -1;
  if (typeof key === "number" && Number.isFinite(key)) idx = key;
  else idx = keyIndex.get(norm(key)) ?? -1;
  if (idx < 0 || idx >= rows.length) return false;

  const row = rows[idx];
  clearTimeout(pulseTimer);
  for (const other of rows) other.el.classList.remove("is-pulsing", "is-marked");

  // keep the roving cursor pointing where the eye was sent
  if (row.buttons.length) setCursor(idx, 0, false);

  if (reducedMotion()) {
    row.el.classList.add("is-marked");
    pulseTimer = setTimeout(() => row.el.classList.remove("is-marked"), 1400);
  } else {
    // reflow so a second call to the same row restarts the animation
    void row.el.offsetWidth;
    row.el.classList.add("is-pulsing");
    pulseTimer = setTimeout(() => row.el.classList.remove("is-pulsing"), 1500);
  }
  return true;
}

/* ============================================================
   boot
   ============================================================ */

export function initShelf() {
  zone = $("#shelf-zone");
  const room = $("#room");
  if (!zone || !room || zone.dataset.built === "true") return;

  const groups = readCatalogue();
  if (!groups.length) {
    console.warn("[shelf] no catalogue found in data/films.js");
    return;
  }
  if (groups.length > SHELF.rows.length) {
    console.warn(`[shelf] ${groups.length} genres, ${SHELF.rows.length} compartments — showing the first ${SHELF.rows.length}`);
  }

  injectCss();

  zone.dataset.built = "true";
  zone.classList.add("shelf-ready");
  zone.setAttribute("role", "group");
  zone.setAttribute("aria-label", "the shelf: films by genre");

  const frag = document.createDocumentFragment();
  let running = 0;
  rows = [];
  keyIndex = new Map();

  SHELF.rows.forEach((geo, r) => {
    const group = groups[r];
    if (!group) return;
    const row = buildRow(group, geo, r, running);
    row.geo = geo;
    running += row.buttons.length;
    rows.push(row);
    frag.append(row.el);

    for (const alias of [group.key, group.label, String(r)]) {
      if (alias) keyIndex.set(norm(alias), r);
    }
  });

  zone.append(frag);
  card = $("#shelf-detail") || buildCard(room);

  const firstFilled = rows.findIndex((row) => row.buttons.length);
  if (firstFilled >= 0) {
    cursor = { r: firstFilled, c: 0 };
    rows[firstFilled].buttons[0].setAttribute("tabindex", "0");
  }

  wire();

  // the shelf fills itself once the visitor is actually in the room
  if (!reducedMotion()) {
    const start = () => {
      zone.classList.add("is-arriving");
      setTimeout(() => zone.classList.remove("is-arriving"), 700 + running * 38);
    };
    if (state.get("entered")) start();
    else state.on("entered", (v) => { if (v) start(); });
  }
}

/* ============================================================
   styles

   shelf.js owns no stylesheet of its own, so it brings one. Only
   #shelf-zone.shelf-ready and #shelf-detail are touched at the top
   level; everything else is namespaced .sh- / .shd-.
   ============================================================ */

function injectCss() {
  if (document.getElementById("shelf-css")) return;
  document.head.append(el("style", { id: "shelf-css", text: CSS }));
}

const CSS = `
#shelf-zone.shelf-ready{
  --pp: calc(var(--room-w, 100vw) / 1672);
  --nightf: var(--is-night, 0);
  --dim: calc(1 - 0.34 * var(--nightf));
  position: absolute;
  z-index: 12;
  /* gaps between cases fall through to the shelf hotspot underneath */
  pointer-events: none;
}

/* ---------- a compartment ---------- */
.sh-row{
  position: absolute;
  left: 0;
  width: 100%;
  display: flex;
  align-items: flex-end;
  transform-origin: 0% 100%;
  padding: 0 calc(${PAD_R} * var(--pp)) calc(${PAD_B} * var(--pp)) calc(${PAD_L} * var(--pp));
}
.sh-row::after{
  content: "";
  position: absolute;
  inset: calc(-1 * var(--pp)) 0;
  border-radius: calc(3 * var(--pp));
  background: linear-gradient(90deg,
    rgb(242 193 92 / 0), rgb(242 193 92 / .17) 42%, rgb(242 193 92 / .05));
  box-shadow: inset 0 0 calc(6 * var(--pp)) rgb(255 190 110 / .28);
  opacity: 0;
  pointer-events: none;
}
.sh-row.is-marked::after{ opacity: 1; }

.sh-label{
  flex: none;
  width: calc(${LAB_W} * var(--pp));
  margin-right: calc(${LAB_GAP} * var(--pp));
  padding-bottom: calc(1 * var(--pp));
  font-family: var(--f-display);
  font-size: calc(6.4 * var(--pp));
  line-height: 1.04;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  overflow-wrap: anywhere;
  color: var(--amber);
  opacity: calc(0.74 + 0.2 * var(--nightf));
  text-shadow:
    0 calc(0.6 * var(--pp)) 0 rgb(0 0 0 / .6),
    0 0 calc(4 * var(--pp)) rgb(242 193 92 / calc(0.12 + 0.34 * var(--nightf)));
  pointer-events: none;
  user-select: none;
}
.sh-row.is-empty .sh-label{ opacity: calc(0.32 + 0.1 * var(--nightf)); }

/* ---------- a case ---------- */
.sh-case{
  --lift: 0;
  --nudge: 0;
  --pop: 1;
  --tiltf: 1;
  --z: 60;
  position: relative;
  flex: none;
  width: calc(var(--cw) * var(--pp));
  height: calc(var(--ch) * var(--pp));
  z-index: var(--z);
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
  transform: translate3d(calc(var(--nudge) * var(--pp)), 0, 0);
  transition: transform .3s var(--ease-out);
}
.sh-case + .sh-case{ margin-left: calc(var(--step) * var(--pp)); }
.sh-case:focus-visible{ outline: none; }

.sh-body{
  position: absolute;
  inset: 0;
  transform-origin: 50% 100%;
  transform:
    translate3d(0, calc(var(--lift) * var(--pp)), 0)
    rotate(calc(var(--tilt, 0deg) * var(--tiltf)))
    scale(var(--pop));
  transition: transform .3s var(--ease-out);
}

/* contact shadow — stays on the board while the case lifts off it */
.sh-cast{
  position: absolute;
  left: calc(-1.5 * var(--pp));
  right: calc(-1.5 * var(--pp));
  bottom: calc(-1 * var(--pp));
  height: calc(3.4 * var(--pp));
  background: radial-gradient(50% 100% at 50% 100%, rgb(0 0 0 / .66), rgb(0 0 0 / 0) 72%);
  opacity: .72;
  transition: opacity .3s var(--ease), transform .3s var(--ease-out);
}

.sh-face{
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: calc(1.2 * var(--pp));
  background: var(--paint, #5b3d2a);
  box-shadow:
    inset 0 0 0 calc(0.6 * var(--pp)) rgb(0 0 0 / .5),
    0 calc(0.8 * var(--pp)) calc(1.6 * var(--pp)) rgb(0 0 0 / .45);
  filter: brightness(var(--dim));
  transition: filter .3s var(--ease), box-shadow .3s var(--ease);
}

.sh-init{
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-family: var(--f-display);
  font-size: calc(var(--ch) * 0.33 * var(--pp));
  letter-spacing: 0.02em;
  line-height: 1;
  color: rgb(255 248 238 / .8);
  text-shadow: 0 calc(0.7 * var(--pp)) 0 rgb(0 0 0 / .38);
}

.sh-art{
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity .55s var(--ease);
}
.sh-case[data-art="ok"] .sh-art{ opacity: 1; }

/* printed sheen, lit from the upper left like the rest of the room */
.sh-gloss{
  position: absolute;
  inset: 0;
  background: linear-gradient(112deg,
    rgb(255 240 214 / .26) 0%, rgb(255 240 214 / .06) 22%,
    rgb(0 0 0 / 0) 48%, rgb(0 0 0 / .26) 100%);
}
.sh-spine{
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: calc(1.8 * var(--pp));
  background: linear-gradient(90deg, rgb(0 0 0 / .6), rgb(255 255 255 / .12));
}

/* ---------- hover / focus: the case is picked out of the row ---------- */
.sh-case:hover,
.sh-case:focus-visible{ --lift: -5; --pop: 1.11; --tiltf: .25; --z: 99; }

.sh-case:hover .sh-face,
.sh-case:focus-visible .sh-face{
  filter: brightness(calc(var(--dim) + .3)) saturate(1.06);
  box-shadow:
    inset 0 0 0 calc(0.7 * var(--pp)) rgb(255 216 158 / .9),
    inset calc(1.6 * var(--pp)) 0 calc(2.6 * var(--pp)) calc(-1.2 * var(--pp)) rgb(255 194 126 / .55),
    0 calc(3.4 * var(--pp)) calc(5.5 * var(--pp)) rgb(0 0 0 / .55),
    0 0 calc(8 * var(--pp)) rgb(255 150 70 / .3);
}
.sh-case:hover .sh-cast,
.sh-case:focus-visible .sh-cast{
  opacity: .46;
  transform: scale(1.3, 1.5);
}

/* neighbours make room, but only just */
.sh-case:hover + .sh-case,
.sh-case:focus-visible + .sh-case{ --nudge: 2.4; }
.sh-case:has(+ .sh-case:hover),
.sh-case:has(+ .sh-case:focus-visible){ --nudge: -2.4; }

/* ---------- arrival ---------- */
@keyframes sh-place{
  from{ opacity: 0; transform: translate3d(0, calc(-6 * var(--pp)), 0) rotate(calc(var(--tilt, 0deg) * 2.2)) scale(.94); }
  to{ opacity: 1; transform: translate3d(0, 0, 0) rotate(var(--tilt, 0deg)) scale(1); }
}
#shelf-zone.is-arriving .sh-body{
  animation: sh-place .46s var(--ease-out) both;
  animation-delay: calc(var(--n) * 38ms);
}
#shelf-zone.is-arriving .sh-cast{
  animation: sh-fade .46s var(--ease) both;
  animation-delay: calc(var(--n) * 38ms);
}
#shelf-zone.is-arriving .sh-label{
  animation: sh-fade .5s var(--ease) both;
  animation-delay: calc(var(--r) * 70ms);
}
@keyframes sh-fade{ from{ opacity: 0 } }

/* ---------- highlightGenre ---------- */
@keyframes sh-wash{
  0%{ opacity: 0 } 16%{ opacity: 1 } 55%{ opacity: .85 } 100%{ opacity: 0 }
}
@keyframes sh-nudge-up{
  0%, 100%{ transform: translate3d(0,0,0) rotate(var(--tilt, 0deg)) scale(1); }
  38%{ transform: translate3d(0, calc(-4.5 * var(--pp)), 0) rotate(calc(var(--tilt, 0deg) * .4)) scale(1.06); }
}
.sh-row.is-pulsing::after{ animation: sh-wash 1.2s var(--ease); }
.sh-row.is-pulsing .sh-body{
  animation: sh-nudge-up .58s var(--ease-out);
  animation-delay: calc(var(--i) * 45ms);
}

/* ============================================================
   the detail card
   ============================================================ */
#shelf-detail{
  --pp: calc(var(--room-w, 100vw) / 1672);
  position: absolute;
  z-index: 40;
  display: flex;
  gap: calc(9 * var(--pp));
  padding: calc(9 * var(--pp));
  border-radius: calc(6 * var(--pp));
  background: linear-gradient(180deg, rgb(27 21 17 / .965), rgb(15 11 9 / .975));
  box-shadow:
    0 0 0 calc(0.8 * var(--pp)) rgb(255 226 190 / .16),
    0 calc(12 * var(--pp)) calc(30 * var(--pp)) rgb(0 0 0 / .62),
    inset 0 calc(0.8 * var(--pp)) 0 rgb(255 226 190 / .08);
  pointer-events: none;
  opacity: 0;
  transform: translate3d(calc(7 * var(--pp)), 0, 0) scale(.972);
  transform-origin: 100% 50%;
  transition: opacity .16s var(--ease), transform .24s var(--ease-out);
}
#shelf-detail.is-shown{ opacity: 1; transform: none; }
body[data-narrow="true"] #shelf-detail{ display: none; }

.shd-nib{
  position: absolute;
  right: calc(-4.4 * var(--pp));
  top: var(--nib, 50%);
  width: calc(5 * var(--pp));
  height: calc(9 * var(--pp));
  transform: translateY(-50%);
  background: rgb(19 14 11 / .97);
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}

.shd-art{
  position: relative;
  flex: none;
  width: calc(84 * var(--pp));
  align-self: stretch;
  overflow: hidden;
  border-radius: calc(3 * var(--pp));
  background: var(--paint, #5b3d2a);
  box-shadow:
    inset 0 0 0 calc(0.8 * var(--pp)) rgb(0 0 0 / .45),
    0 calc(2 * var(--pp)) calc(8 * var(--pp)) rgb(0 0 0 / .5);
}
.shd-init{
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-family: var(--f-display);
  font-size: calc(30 * var(--pp));
  line-height: 1;
  color: rgb(255 248 238 / .8);
  text-shadow: 0 calc(1.5 * var(--pp)) 0 rgb(0 0 0 / .35);
}
.shd-img{
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity .3s var(--ease);
}
.shd-art[data-art="ok"] .shd-img{ opacity: 1; }

.shd-text{
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.shd-genre{
  font-family: var(--f-display);
  font-size: calc(7 * var(--pp));
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--amber);
  opacity: .82;
}
.shd-title{
  margin: calc(3 * var(--pp)) 0 0;
  font-family: var(--f-display);
  font-size: calc(15.5 * var(--pp));
  line-height: 1.02;
  letter-spacing: 0.005em;
  color: var(--ink);
}
.shd-meta{
  margin-top: calc(3 * var(--pp));
  font-family: var(--f-mono);
  font-size: calc(8 * var(--pp));
  letter-spacing: 0.04em;
  color: var(--ink-mute);
}
.shd-blurb{
  margin: calc(5 * var(--pp)) 0 0;
  font-size: calc(8.4 * var(--pp));
  line-height: 1.42;
  color: var(--ink-dim);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  overflow: hidden;
}
.shd-cta{
  margin-top: auto;
  padding-top: calc(5 * var(--pp));
  font-size: calc(7.6 * var(--pp));
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--amber);
  opacity: .7;
}

/* ---------- reduced motion ----------
   the states stay, the travel between them does not. */
@media (prefers-reduced-motion: reduce){
  #shelf-zone.shelf-ready .sh-case,
  #shelf-zone.shelf-ready .sh-body,
  #shelf-zone.shelf-ready .sh-cast,
  #shelf-zone.shelf-ready .sh-face,
  #shelf-zone.shelf-ready .sh-art,
  #shelf-detail{
    transition-duration: 1ms;
    animation: none;
  }
  #shelf-detail{ transform: none; }
}
`;
