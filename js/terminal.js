/* ============================================================
   terminal.js — the panel in the bottom-left, made real.

   A small shell: a command registry, a line editor with history
   and completion, and a fake filesystem laid over the site's own
   content. Other modules register their own commands, which is
   the seam this grows along once sign-in and chat exist.

   SECURITY: this module never touches innerHTML. Every line is
   assembled with el() and text nodes, so anything the visitor
   types — or anything read back out of the guestbook — is text
   by construction and can never become markup.
   ============================================================ */

import { $, el, rand, pick, clamp, sleep, store, debounce, reducedMotion } from "./util.js";
import * as state from "./state.js";
import { PRESETS } from "./scene.js";

/* ---------- limits ---------- */

const MAX_LINES     = 240;  // log lines kept in the DOM
const MAX_HISTORY   = 60;
const GUESTBOOK_MAX = 25;   // entries kept in localStorage
const GUESTBOOK_LEN = 240;  // characters per entry
const NAME_LEN      = 32;

/* ---------- module state ---------- */

let root = null, out = null, input = null, promptEl = null, minBtn = null;
let started = false;
let cwd = "/";
let stick = true;    // is the log pinned to the bottom
let skipType = false; // the visitor started typing during the intro
let chWidth = 0;      // measured monospace advance, for column layout

/* Commands run one at a time and in order, so a command typed
   during the boot animation still lands after it. */
let chain = Promise.resolve();
const enqueue = (fn) => (chain = chain.then(fn).catch((err) => console.error("[terminal]", err)));

/* ============================================================
   1. output
   ============================================================ */

function lineEl(cls) {
  const node = el("div", { class: "term-l" });
  if (cls) {
    for (const raw of String(cls).split(/\s+/)) {
      const t = raw.replace(/[^\w-]/g, "");
      if (t) node.classList.add(t.startsWith("term-") ? t : "term-" + t);
    }
  }
  return node;
}

function append(node) {
  if (!out) return node;
  out.append(node);
  while (out.childElementCount > MAX_LINES) out.firstElementChild.remove();
  if (stick) out.scrollTop = out.scrollHeight;
  return node;
}

/** Print one line of plain text. Exported: other modules use this. */
export function termPrint(text, cls) {
  const node = lineEl(cls);
  node.textContent = text == null ? "" : String(text);
  return append(node);
}

/** Print a line made of strings and nodes — the only way to emit a link. */
function printNode(cls, ...kids) {
  const node = lineEl(cls);
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return append(node);
}

/** Non-breaking space: an empty div collapses, this one holds a line. */
const blank = () => termPrint(" ");

const linkNode = (href, text) =>
  el("a", {
    href,
    target: /^https?:/i.test(href) ? "_blank" : null,
    rel: /^https?:/i.test(href) ? "noopener noreferrer" : null,
  }, text ?? href);

export function termClear() {
  if (out) out.replaceChildren();
  stick = true;
}

const promptText = () => `den@lair:${cwd === "/" ? "~" : cwd}$`;

function setPrompt() {
  if (promptEl) promptEl.textContent = promptText();
}

function echo(text) {
  printNode("term-echo", el("span", { class: "term-ps", text: promptText() }), " ", text);
}

/* ---------- column layout ----------
   The panel is narrow and its width moves with the viewport, so
   measure the real character advance rather than guessing 80. */

function measureChar() {
  if (!out) return;
  const probe = el("span", {
    style: { position: "absolute", visibility: "hidden", whiteSpace: "pre" },
    text: "0".repeat(40),
  });
  out.append(probe);
  const w = probe.getBoundingClientRect().width / 40;
  probe.remove();
  if (w > 2) chWidth = w;
}

function cols() {
  if (!chWidth) measureChar();
  const w = out ? out.clientWidth : 0;
  if (!chWidth || !w) return 46;
  return clamp(Math.floor((w - 6) / chWidth), 22, 110);
}

const clip = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + "…");

function columns(items) {
  if (!items.length) return [];
  const total = cols();
  const w = Math.min(Math.max(...items.map((s) => s.length)) + 2, total);
  const per = Math.max(1, Math.floor(total / w));
  const rows = [];
  for (let i = 0; i < items.length; i += per) {
    rows.push(items.slice(i, i + per).map((s) => clip(s, w).padEnd(w)).join("").trimEnd());
  }
  return rows;
}

/* ============================================================
   2. the typing intro
   ============================================================ */

const INTRO = [
  ["den's lair terminal — v2", "term-head"],
  ["the room is clickable, but you look like a keyboard person.", "term-dim"],
  ["type `help`. tab completes, up recalls.", "term-dim"],
];

/* Pause after a character. Longer at punctuation is what makes it
   read as typing rather than as a progress bar. */
const charPause = (ch) =>
  ch === " " ? rand(12, 26)
  : ",;:".includes(ch) ? rand(90, 145)
  : ".!?—".includes(ch) ? rand(150, 230)
  : rand(18, 34);

async function typeOut(text, cls) {
  const node = lineEl(cls);
  const body = document.createTextNode("");
  const caret = el("span", { class: "term-cursor", text: "█" });
  node.append(body, caret);
  append(node);

  for (const ch of text) {
    if (skipType) break;
    body.data += ch;
    if (stick) out.scrollTop = out.scrollHeight;
    await sleep(charPause(ch));
  }
  body.data = text;
  caret.remove();
  if (stick) out.scrollTop = out.scrollHeight;
}

async function bootIntro() {
  if (reducedMotion()) {
    for (const [text, cls] of INTRO) termPrint(text, cls);
    blank();
    return;
  }
  for (const [text, cls] of INTRO) {
    if (skipType) { termPrint(text, cls); continue; }
    await typeOut(text, cls);
    if (!skipType) await sleep(210);
  }
  blank();
}

/* ============================================================
   3. the command registry
   ============================================================ */

const commands = new Map();

/**
 * Register a command.
 * spec: { desc, usage, hidden, complete(prefix, args), run(args, io) }
 * `run` may be async and receives { print, printNode, clear, args, raw, cwd }.
 */
export function registerCommand(name, spec = {}) {
  const key = String(name || "").toLowerCase().trim();
  if (!key) return;
  commands.set(key, {
    name: key,
    desc: spec.desc || "",
    usage: spec.usage || key,
    hidden: Boolean(spec.hidden),
    complete: typeof spec.complete === "function" ? spec.complete : null,
    run: typeof spec.run === "function" ? spec.run : () => {},
  });
}

const visibleNames = () =>
  [...commands.values()].filter((c) => !c.hidden).map((c) => c.name).sort();

/* ============================================================
   4. lazy access to the rest of the site

   The terminal pokes at four other modules. Loading them on
   demand means a missing or broken one costs a single command
   rather than the whole shell, and sidesteps import cycles.
   ============================================================ */

const modCache = new Map();
function load(path) {
  if (!modCache.has(path)) {
    modCache.set(path, import(path).catch((err) => {
      console.warn("[terminal] could not load", path, err);
      return {};
    }));
  }
  return modCache.get(path);
}

/** Read the first field that exists, allowing for a default export. */
function field(mod, ...names) {
  for (const n of names) {
    if (mod && mod[n] != null) return mod[n];
    if (mod && mod.default && mod.default[n] != null) return mod.default[n];
  }
  return null;
}

const arr = (v) => (Array.isArray(v) ? v : []);

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "item";

/** Flatten whatever shape a content field arrived in into lines. */
function normLines(v) {
  if (v == null) return [];
  if (typeof v === "string") return v.trim().split("\n").map((s) => s.trimEnd());
  if (Array.isArray(v)) {
    return v.map((x) => {
      if (x == null) return "";
      if (typeof x === "string") return x;
      const label = x.label ?? x.title ?? x.name ?? "";
      const text = x.text ?? x.value ?? x.desc ?? x.description ?? x.note ?? x.body ?? "";
      const both = Array.isArray(text) ? text.join(", ") : String(text);
      return label && both ? `${label}: ${both}` : String(label || both);
    });
  }
  if (typeof v === "object") {
    return Object.entries(v).map(([k, val]) =>
      `${k}: ${Array.isArray(val) ? val.join(", ") : String(val)}`);
  }
  return [String(v)];
}

function normLinks(v) {
  const fix = (href) =>
    href.includes("@") && !/^[a-z]+:/i.test(href) ? "mailto:" + href : href;

  let list = [];
  if (Array.isArray(v)) {
    list = v.map((x) => (typeof x === "string"
      ? { label: x, href: x }
      : {
          label: String(x.label ?? x.name ?? x.title ?? x.href ?? x.url ?? ""),
          href: String(x.href ?? x.url ?? x.link ?? ""),
        }));
  } else if (v && typeof v === "object") {
    list = Object.entries(v)
      .filter(([, href]) => typeof href === "string")
      .map(([label, href]) => ({ label, href }));
  }
  return list
    .filter((l) => l.href)
    .map((l) => ({ label: l.label || l.href, href: fix(l.href) }));
}

const normProject = (p) => ({
  name: String(p.name ?? p.title ?? "untitled"),
  slug: slug(p.slug ?? p.id ?? p.name ?? p.title ?? "project"),
  blurb: String(p.blurb ?? p.desc ?? p.description ?? p.summary ?? ""),
  stack: [].concat(p.stack ?? p.tags ?? p.tech ?? []),
  url: String(p.url ?? p.link ?? p.href ?? ""),
  year: p.year ?? p.when ?? "",
  body: p.body ?? p.long ?? null,
});

const normBook = (b) => (typeof b === "string"
  ? { title: b, author: "", note: "" }
  : {
      title: String(b.title ?? b.name ?? "untitled"),
      author: String(b.author ?? b.by ?? ""),
      note: b.note ?? b.blurb ?? b.desc ?? b.why ?? "",
    });

const normFilm = (f, i) => ({
  ...f,
  id: f.id ?? f.slug ?? f.src ?? String(i),
  title: String(f.title ?? f.name ?? "untitled"),
  genre: String(f.genre ?? f.label ?? "misc"),
});

/* ---------- cached loads ---------- */

let filmsPromise = null, filmsCache = null;
function getFilms() {
  if (!filmsPromise) {
    filmsPromise = load("./data/films.js").then((m) => {
      const raw = field(m, "FILMS", "films", "CATALOGUE", "catalogue", "TAPES", "tapes");
      const list = Array.isArray(raw) ? raw : Array.isArray(m.default) ? m.default : [];
      filmsCache = list.map(normFilm);
      return filmsCache;
    }).catch(() => (filmsCache = []));
  }
  return filmsPromise;
}

const content = () => load("./data/content.js");

let linksPromise = null;
function getLinks() {
  if (!linksPromise) {
    linksPromise = content().then((c) =>
      normLinks(field(c, "LINKS", "links", "CONTACT", "contact", "SOCIAL", "social")));
  }
  return linksPromise;
}

const FALLBACK_FORTUNES = [
  "the fire does not care whether you ship on friday.",
  "every pipeline is fine until someone looks at it.",
  "you have exactly one good idea left today. spend it well.",
  "the dog has solved the problem. the dog is asleep.",
  "there is no clean architecture, only rooms you tidy often.",
];

let fortunePromise = null;
function getFortunes() {
  if (!fortunePromise) {
    fortunePromise = content().then((c) => {
      const f = arr(field(c, "FORTUNES", "fortunes")).filter((s) => typeof s === "string");
      return f.length ? f : FALLBACK_FORTUNES;
    }).catch(() => FALLBACK_FORTUNES);
  }
  return fortunePromise;
}

/* ============================================================
   5. the fake filesystem
   ============================================================ */

const dirNode  = (children) => ({ type: "dir", children });
const fileNode = (body) => ({ type: "file", body });

/** Add to a directory without ever losing an entry to a slug clash. */
function put(bag, name, node) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = name, i = 2;
  while (n in bag) n = `${base}-${i++}${ext}`;
  bag[n] = node;
}

const README = [
  "den's lair — filesystem, such as it is",
  "",
  "  /about      who's typing",
  "  /projects   things that got built",
  "  /films      what's on the shelf",
  "  /books      what's been read",
  "  /contact    how to reach me",
  "",
  "nothing in here is real except the words.",
];

const FALLBACK_BIO = [
  "denis. data & software engineer.",
  "i build pipelines by day and rooms like this one by night.",
];

function groupByGenre(films) {
  const map = new Map();
  for (const f of films) {
    if (!map.has(f.genre)) map.set(f.genre, []);
    map.get(f.genre).push(f);
  }
  return map;
}

function projectBody(p) {
  const lines = [`${p.name}${p.year ? `  (${p.year})` : ""}`, "─".repeat(Math.min(p.name.length + 8, 40)), ""];
  if (p.blurb) lines.push(p.blurb, "");
  if (p.stack.length) lines.push(`stack: ${p.stack.join(", ")}`);
  if (p.body) lines.push("", ...normLines(p.body));
  if (p.url) lines.push("", { label: "", href: p.url });
  return lines;
}

let fsPromise = null, fsCache = null;
function getFs() {
  if (!fsPromise) {
    fsPromise = buildFs()
      .then((tree) => (fsCache = tree))
      .catch((err) => {
        console.error("[terminal] filesystem", err);
        return (fsCache = dirNode({}));
      });
  }
  return fsPromise;
}

async function buildFs() {
  const c = await content();
  const films = await getFilms();

  const about = normLines(field(c, "ABOUT", "about", "BIO", "bio"));
  const stack = normLines(field(c, "STACK", "stack", "SKILLS", "skills"));
  const now = normLines(field(c, "NOW", "now"));
  const projects = arr(field(c, "PROJECTS", "projects")).map(normProject);
  const books = arr(field(c, "BOOKS", "books")).map(normBook);
  const links = await getLinks();

  /* /about */
  const aboutDir = {};
  put(aboutDir, "bio.txt", fileNode(about.length ? about : FALLBACK_BIO));
  if (stack.length) put(aboutDir, "stack.txt", fileNode(stack));
  if (now.length) put(aboutDir, "now.txt", fileNode(now));

  /* /projects */
  const projDir = {};
  for (const p of projects) put(projDir, p.slug + ".md", fileNode(projectBody(p)));
  if (!projects.length) {
    put(projDir, "readme.txt", fileNode([
      "not unpacked yet.",
      "the laptop on the table has the current list.",
    ]));
  }

  /* /films */
  const filmDir = {};
  put(filmDir, "catalogue.txt", fileNode(() => {
    const lines = [];
    for (const [genre, list] of groupByGenre(films)) {
      lines.push(genre.toLowerCase());
      for (const f of list) lines.push("  " + f.title);
      lines.push("");
    }
    return lines.length ? lines : ["the shelf is empty."];
  }));
  for (const [genre, list] of groupByGenre(films)) {
    put(filmDir, slug(genre) + ".txt", fileNode(list.map((f) => f.title)));
  }

  /* /books */
  const bookDir = {};
  put(bookDir, "shelf.txt", fileNode(books.length
    ? books.map((b) => (b.author ? `${b.title} — ${b.author}` : b.title))
    : ["not catalogued yet. the shelf in the room is more honest."]));
  for (const b of books.slice(0, 12)) {
    put(bookDir, slug(b.title) + ".txt", fileNode([
      b.title,
      b.author ? "by " + b.author : "",
      "",
      ...normLines(b.note),
    ].filter((l, i, a) => !(l === "" && a[i - 1] === ""))));
  }

  /* /contact */
  const email = links.find((l) => l.href.startsWith("mailto:"));
  const contactDir = {};
  put(contactDir, "links.txt", fileNode(() => (links.length
    ? links.map((l) => ({ label: l.label.toLowerCase(), href: l.href }))
    : ["nothing wired up yet."])));
  put(contactDir, "email.txt", fileNode([
    { label: "", href: email ? email.href : "mailto:hello@denslair.com" },
  ]));
  put(contactDir, "cv.pdf", fileNode(["cv.pdf: binary file. try `cv`."]));

  return dirNode({
    about: dirNode(aboutDir),
    books: dirNode(bookDir),
    contact: dirNode(contactDir),
    films: dirNode(filmDir),
    projects: dirNode(projDir),
    "readme.txt": fileNode(README),
    ".fireplace": fileNode(["still warm."]),
  });
}

/** Resolve a path against the current directory. Returns {node, path}. */
function resolvePath(rootNode, from, raw) {
  const p = String(raw).replace(/^~/, "/");
  const segs = (p.startsWith("/") ? p : from + "/" + p).split("/").filter(Boolean);
  const stack = [];
  for (const s of segs) {
    if (s === ".") continue;
    if (s === "..") { stack.pop(); continue; }
    stack.push(s);
  }
  let node = rootNode;
  for (const s of stack) {
    if (!node || node.type !== "dir") return { node: null, path: "/" + stack.join("/") };
    node = node.children[s];
  }
  return { node: node || null, path: "/" + stack.join("/") };
}

function pathCompleter(prefix) {
  if (!fsCache) return [];
  const cut = prefix.lastIndexOf("/");
  const head = cut >= 0 ? prefix.slice(0, cut + 1) : "";
  const leaf = cut >= 0 ? prefix.slice(cut + 1) : prefix;
  const { node } = resolvePath(fsCache, cwd, head || ".");
  if (!node || node.type !== "dir") return [];
  return Object.keys(node.children)
    .filter((n) => n.startsWith(leaf) && (leaf.startsWith(".") || !n.startsWith(".")))
    .sort()
    .map((n) => head + n + (node.children[n].type === "dir" ? "/" : ""));
}

/** Print one entry of a file body: a string, {text,cls} or {label,href}. */
function printEntry(entry) {
  if (entry == null || entry === "") return blank();
  if (typeof entry === "string") return termPrint(entry);
  if (entry.href) {
    const label = entry.label ? entry.label.padEnd(Math.min(entry.label.length + 2, 14)) : "";
    return printNode("term-linkline", label, linkNode(entry.href, prettyHref(entry.href)));
  }
  return termPrint(entry.text ?? "", entry.cls);
}

const prettyHref = (h) => h.replace(/^mailto:/i, "").replace(/^https?:\/\//i, "").replace(/\/$/, "");

/* ============================================================
   6. fuzzy matching — used by `play` and by did-you-mean
   ============================================================ */

function fuzzyScore(needle, hay) {
  const n = String(needle).toLowerCase().trim();
  const h = String(hay).toLowerCase();
  if (!n) return 0;
  if (h === n) return 1000;
  const at = h.indexOf(n);
  if (at === 0) return 700 - h.length * 0.1;
  if (at > 0) return 520 - at - h.length * 0.1;

  // subsequence: reward unbroken runs and matches at word starts
  let i = 0, score = 0, run = 0;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) {
      run++;
      score += 10 + run * 4 + (j === 0 || h[j - 1] === " " ? 12 : 0);
      i++;
    } else {
      run = 0;
    }
  }
  return i === n.length ? score : -1;
}

const filmScore = (q, f) => Math.max(fuzzyScore(q, f.title), fuzzyScore(q, f.genre) * 0.6);

function bestFilm(q, list) {
  let best = null, bestScore = 0;
  for (const f of list) {
    const s = filmScore(q, f);
    if (s > bestScore) { bestScore = s; best = f; }
  }
  return bestScore > 30 ? best : null;
}

/* ============================================================
   7. the built-in commands
   ============================================================ */

registerCommand("help", {
  desc: "this list",
  usage: "help [command]",
  complete: (pre) => visibleNames().filter((n) => n.startsWith(pre)),
  run(args) {
    if (args[0]) {
      const spec = commands.get(args[0].toLowerCase());
      if (!spec) return termPrint(`help: no such command: ${args[0]}`, "term-err");
      termPrint(spec.usage, "term-head");
      if (spec.desc) termPrint("  " + spec.desc, "term-dim");
      return;
    }
    const names = visibleNames();
    const pad = Math.max(...names.map((n) => n.length)) + 2;
    const room = Math.max(12, cols() - pad);
    blank();
    for (const n of names) termPrint(n.padEnd(pad) + clip(commands.get(n).desc, room));
    blank();
    termPrint("tab completes · up/down recalls · ctrl+l clears", "term-dim");
  },
});
registerCommand("?", { hidden: true, run: (a, io) => commands.get("help").run(a, io) });
registerCommand("man", { hidden: true, run: (a, io) => commands.get("help").run(a, io) });

registerCommand("whoami", {
  desc: "who's typing at the other end",
  async run() {
    const c = await content();
    const said = normLines(field(c, "WHOAMI", "whoami")).filter(Boolean);
    const lines = said.length ? said.slice(0, 3) : [
      "denis. data & software engineer.",
      "i build pipelines by day and rooms like this one by night.",
      "the dog by the fire is the real owner. i just pay for the wood.",
    ];
    for (const l of lines) termPrint(l);
  },
});

registerCommand("ls", {
  desc: "list what's in here",
  usage: "ls [-a] [path]",
  complete: pathCompleter,
  async run(args) {
    const all = args.includes("-a");
    const rest = args.filter((a) => a !== "-a");
    const fs = await getFs();
    const target = rest[0] || ".";
    const { node } = resolvePath(fs, cwd, target);
    if (!node) return termPrint(`ls: ${target}: no such file or directory`, "term-err");
    if (node.type === "file") return termPrint(target.split("/").pop());

    let names = Object.keys(node.children).sort();
    if (!all) names = names.filter((n) => !n.startsWith("."));
    if (!names.length) return termPrint("(empty)", "term-dim");
    const labels = names.map((n) => (node.children[n].type === "dir" ? n + "/" : n));
    for (const row of columns(labels)) termPrint(row);
  },
});

registerCommand("cd", {
  desc: "move around",
  usage: "cd [path]",
  complete: pathCompleter,
  async run(args) {
    const fs = await getFs();
    const target = args[0] || "/";
    const { node, path } = resolvePath(fs, cwd, target);
    if (!node) return termPrint(`cd: ${target}: no such directory`, "term-err");
    if (node.type !== "dir") return termPrint(`cd: ${target}: not a directory`, "term-err");
    cwd = path || "/";
    setPrompt();
  },
});

registerCommand("pwd", {
  desc: "where you are",
  run() { termPrint(cwd); },
});

registerCommand("cat", {
  desc: "read a file",
  usage: "cat <file>",
  complete: pathCompleter,
  async run(args) {
    if (!args.length) return termPrint("cat: give me a file. try `ls`.", "term-dim");
    const fs = await getFs();
    for (const target of args) {
      const { node } = resolvePath(fs, cwd, target);
      if (!node) { termPrint(`cat: ${target}: no such file`, "term-err"); continue; }
      if (node.type === "dir") { termPrint(`cat: ${target}: is a directory`, "term-err"); continue; }
      const body = typeof node.body === "function" ? await node.body() : node.body;
      const entries = Array.isArray(body) ? body : String(body ?? "").split("\n");
      blank();
      for (const e of entries) printEntry(e);
      blank();
    }
  },
});

const WX_ALIAS = {
  sun: "sunny", clear: "sunny", day: "sunny",
  cloud: "cloudy", clouds: "cloudy", overcast: "cloudy", grey: "cloudy", gray: "cloudy",
  rain: "rainy", wet: "rainy", storm: "rainy",
  dark: "night", evening: "night", moon: "night",
};

registerCommand("weather", {
  desc: "check it, or change it",
  usage: "weather [sunny|cloudy|rainy|night]",
  complete: (pre) => Object.keys(PRESETS).filter((n) => n.startsWith(pre)),
  run(args) {
    const names = Object.keys(PRESETS);
    if (!args.length) {
      const p = PRESETS[state.get("weather")] || PRESETS.sunny;
      termPrint(`${p.label.toLowerCase()} · ${p.temp}°c · outside den's lair`);
      termPrint(`change it: weather ${names.join("|")}`, "term-dim");
      return;
    }
    const want = WX_ALIAS[args[0].toLowerCase()] || args[0].toLowerCase();
    if (!PRESETS[want]) {
      return termPrint(`weather: i don't do ${args[0]}. try: ${names.join(", ")}`, "term-err");
    }
    state.set("weather", want);
    termPrint(`${PRESETS[want].label.toLowerCase()}. look at the window.`, "term-ok");
  },
});

/** Both toggles share the same aside when the room ends up dark. */
function darkQuip() {
  if (!state.get("lightsOn") && !state.get("fireOn")) {
    termPrint("you're sitting in the dark now. that's allowed.", "term-dim");
  }
}

registerCommand("lights", {
  desc: "toggle the lamp",
  run() {
    const on = !state.get("lightsOn");
    state.set("lightsOn", on);
    termPrint(on ? "lights on." : "lights out. the fire will do.", "term-ok");
    darkQuip();
  },
});

registerCommand("fire", {
  desc: "toggle the fireplace",
  run() {
    const on = !state.get("fireOn");
    state.set("fireOn", on);
    termPrint(on ? "fire's on." : "fire out. it'll get cold in here.", "term-ok");
    darkQuip();
  },
});

registerCommand("films", {
  desc: "what's on the shelf",
  async run() {
    const list = await getFilms();
    if (!list.length) return termPrint("the shelf is empty. that shouldn't happen.", "term-err");
    blank();
    for (const [genre, group] of groupByGenre(list)) {
      termPrint(genre.toLowerCase(), "term-head");
      for (const f of group) termPrint("  " + f.title);
    }
    blank();
    termPrint("play <title> puts one on.", "term-dim");
  },
});

registerCommand("play", {
  desc: "put a film on the big screen",
  usage: "play <title>",
  complete(pre, args) {
    if (!filmsCache) return [];
    const q = [...args, pre].join(" ").trim();
    if (!q) return [];
    return filmsCache
      .map((f) => [filmScore(q, f), f])
      .filter(([s]) => s > 30)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 6)
      .map(([, f]) => ({ all: f.title }));
  },
  async run(args) {
    const q = args.join(" ").trim();
    if (!q) return termPrint("play what? try `films`.", "term-dim");
    const list = await getFilms();
    const film = bestFilm(q, list);
    if (!film) return termPrint(`play: nothing matches "${q}". try \`films\`.`, "term-err");

    termPrint(`loading ${film.title}…`, "term-ok");
    const tv = await load("./tv.js");
    if (typeof tv.playTape === "function") tv.playTape(film);
    else { state.set("tape", film); state.set("tv", "loading"); }
  },
});

async function openPanelSafe(id) {
  const panels = await load("./panels.js");
  if (typeof panels.openPanel === "function") panels.openPanel(id);
  else state.set("panel", id);
}

registerCommand("arcade", {
  desc: "open the cabinet",
  async run() {
    await openPanelSafe("arcade");
    termPrint("arcade's open. insert coin.", "term-ok");
  },
});

registerCommand("ambience", {
  desc: "toggle the room's sound",
  run() {
    const on = !(state.get("ambience") || {}).on;
    state.patch("ambience", { on });
    termPrint(on ? "ambience on. rain, fire, a little vinyl." : "ambience off. quiet room.", "term-ok");
  },
});

registerCommand("contact", {
  desc: "how to reach me",
  async run() {
    const links = await getLinks();
    blank();
    if (!links.length) {
      printNode("", "email".padEnd(10), linkNode("mailto:hello@denslair.com", "hello@denslair.com"));
    } else {
      const pad = Math.min(Math.max(...links.map((l) => l.label.length)) + 2, 14);
      for (const l of links) {
        printNode("", l.label.toLowerCase().padEnd(pad), linkNode(l.href, prettyHref(l.href)));
      }
    }
    blank();
  },
});

registerCommand("cv", {
  desc: "the professional corner",
  async run() {
    const links = await getLinks();
    const cv = links.find((l) => /\bcv\b|resume|résumé|curriculum/i.test(l.label + " " + l.href));
    if (cv) printNode("", "cv".padEnd(10), linkNode(cv.href, prettyHref(cv.href)));
    else termPrint("no pdf on the shelf yet.", "term-dim");
    termPrint("the laptop on the table has the long version.", "term-dim");
    termPrint("the short version: whoami", "term-dim");
  },
});

registerCommand("clear", {
  desc: "wipe the log",
  run() { termClear(); },
});

registerCommand("fortune", {
  desc: "an opinion from the fire",
  async run() {
    termPrint(pick(await getFortunes()), "term-warn");
  },
});

const SUDO_LINES = [
  "guest is not in the sudoers file. this incident has been logged.",
  "there is no root in this room. only floorboards.",
  "nice try. the dog says no.",
];

registerCommand("sudo", {
  hidden: true,
  desc: "no",
  usage: "sudo <thing you cannot do>",
  run(args) {
    const rest = args.join(" ").toLowerCase().trim();
    if (rest === "make me a sandwich") return termPrint("okay.", "term-ok");
    if (!rest) return termPrint("usage: sudo <thing you cannot do>", "term-dim");
    termPrint(pick(SUDO_LINES), "term-warn");
  },
});

registerCommand("make", {
  hidden: true,
  run(args) {
    const target = args.join(" ").toLowerCase().trim();
    if (target === "me a sandwich") return termPrint("what? make it yourself.", "term-warn");
    termPrint(`make: no rule to make target '${target || "all"}'. stop.`, "term-err");
  },
});

registerCommand("rm", {
  hidden: true,
  run(args) {
    const target = args.filter((a) => !a.startsWith("-")).join(" ");
    if (!target || target === "/") return termPrint("no.", "term-err");
    termPrint(`rm: ${target}: permission denied. this room took a while.`, "term-err");
  },
});

registerCommand("dog", {
  hidden: true,
  run() {
    termPrint(pick([
      "asleep. has been all afternoon.",
      "one tail thump. that's the whole conversation.",
      "the dog does not take commands. the dog takes naps.",
    ]), "term-warn");
  },
});

/* ---------- guestbook ----------
   Local-only for now. Every value written here comes back out
   through a text node, never markup. */

function gbList() {
  const v = store.get("guestbook", []);
  return Array.isArray(v) ? v.filter((e) => e && typeof e.m === "string") : [];
}

const gbWhen = (t) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }).toLowerCase();
};

registerCommand("guestbook", {
  desc: "leave a note on the mantelpiece",
  usage: "guestbook [message | clear]",
  run(args) {
    const raw = args.join(" ").trim();

    if (raw.toLowerCase() === "clear") {
      store.del("guestbook");
      return termPrint("guestbook wiped. this browser only.", "term-ok");
    }

    if (raw) {
      const who = String((state.get("user") || {}).name || "guest").slice(0, NAME_LEN);
      const kept = [...gbList(), { n: who, m: raw.slice(0, GUESTBOOK_LEN), t: Date.now() }]
        .slice(-GUESTBOOK_MAX);
      if (!store.set("guestbook", kept)) {
        return termPrint("guestbook: this browser won't let me store anything.", "term-err");
      }
      termPrint("noted.", "term-ok");
      termPrint("kept in this browser for now — it'll sync once sign-in lands.", "term-dim");
      return;
    }

    const all = gbList();
    if (!all.length) {
      termPrint("nothing on the mantelpiece yet.", "term-dim");
      termPrint("write one: guestbook <your message>", "term-dim");
      return;
    }
    const shown = all.slice(-5);
    blank();
    for (const e of shown) {
      printNode("term-gb",
        el("span", { class: "term-gb-when", text: gbWhen(e.t) }), " ",
        el("b", { text: String(e.n || "guest").slice(0, NAME_LEN) }), "  ",
        e.m);
    }
    blank();
    termPrint(`${shown.length} of ${all.length} · this browser only · syncs once sign-in lands`, "term-dim");
  },
});

registerCommand("exit", {
  desc: "try to leave",
  run() {
    termPrint("you can't. the door only opens inward.", "term-warn");
    termPrint("close the tab if you must. the fire stays on.", "term-dim");
  },
});

/* ============================================================
   8. the line editor
   ============================================================ */

let hist = (() => {
  const v = store.get("termHistory", []);
  return (Array.isArray(v) ? v : []).map(String).slice(-MAX_HISTORY);
})();
let histIdx = hist.length;
let draft = "";

function pushHistory(line) {
  if (hist[hist.length - 1] !== line) {
    hist.push(line);
    if (hist.length > MAX_HISTORY) hist = hist.slice(-MAX_HISTORY);
    store.set("termHistory", hist);
  }
  histIdx = hist.length;
  draft = "";
}

function setInput(value) {
  input.value = value;
  input.setSelectionRange(value.length, value.length);
}

/** Split a line into arguments, honouring quotes. */
function splitArgs(line) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) parts.push(m[1] ?? m[2] ?? m[3]);
  return parts;
}

function notFound(name) {
  termPrint(`${name}: command not found`, "term-err");
  if (name.length < 2) return;
  let best = null, bestScore = 0;
  for (const n of visibleNames()) {
    const s = fuzzyScore(name, n);
    if (s > bestScore) { bestScore = s; best = n; }
  }
  if (best && bestScore >= 60) termPrint(`did you mean \`${best}\`?`, "term-dim");
}

async function runLine(raw) {
  stick = true;
  echo(raw);
  const line = raw.trim();
  if (!line) return;
  pushHistory(line);

  const parts = splitArgs(line);
  const name = parts[0].toLowerCase();
  const spec = commands.get(name);
  if (!spec) return notFound(name);

  const args = parts.slice(1);
  root.dataset.busy = "true";
  try {
    await spec.run(args, {
      print: termPrint,
      printNode,
      clear: termClear,
      args,
      raw: line,
      cwd,
    });
  } catch (err) {
    console.error("[terminal]", err);
    termPrint(`${name}: ${err && err.message ? err.message : "something broke"}`, "term-err");
  } finally {
    root.dataset.busy = "false";
  }
}

/* ---------- completion ---------- */

function commonPrefix(list) {
  let p = list[0] || "";
  for (const s of list) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

const leafLabel = (c) => {
  const bare = c.replace(/\/$/, "");
  const base = bare.split("/").pop() || bare;
  return c.endsWith("/") ? base + "/" : base;
};

function complete() {
  const value = input.value;
  const endsSpace = /\s$/.test(value);
  const parts = value.split(/\s+/).filter(Boolean);
  const cur = endsSpace ? "" : (parts[parts.length - 1] ?? "");
  const head = endsSpace ? parts : parts.slice(0, -1);

  let cands;
  if (!head.length) {
    cands = visibleNames().filter((n) => n.startsWith(cur));
  } else {
    const spec = commands.get(head[0].toLowerCase());
    cands = spec && spec.complete ? spec.complete(cur, head.slice(1)) || [] : [];
  }
  if (!cands.length) return;

  // a completer may answer with { all } to replace every argument
  if (typeof cands[0] === "object") {
    if (cands.length === 1) setInput(`${head[0]} ${cands[0].all} `);
    else for (const row of cands.map((c) => "  " + c.all)) termPrint(row, "term-dim");
    return;
  }

  const prefix = head.length ? head.join(" ") + " " : "";
  if (cands.length === 1) {
    const only = cands[0];
    setInput(prefix + only + (only.endsWith("/") ? "" : " "));
    return;
  }
  const shared = commonPrefix(cands);
  if (shared.length > cur.length) return setInput(prefix + shared);
  for (const row of columns(cands.map(leafLabel))) termPrint(row, "term-dim");
}

/* ---------- keys ---------- */

function onKeyDown(e) {
  // the first keystroke during the intro fast-forwards it
  if (!skipType && e.key.length === 1) skipType = true;

  if (e.key === "Enter") {
    e.preventDefault();
    const value = input.value;
    input.value = "";
    histIdx = hist.length;
    draft = "";
    skipType = true;
    enqueue(() => runLine(value));
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (histIdx === hist.length) draft = input.value;
    if (histIdx > 0) setInput(hist[--histIdx]);
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (histIdx < hist.length) {
      histIdx++;
      setInput(histIdx === hist.length ? draft : hist[histIdx]);
    }
    return;
  }

  if (e.key === "Tab") {
    // an empty line lets tab do its normal job and move focus on
    if (!input.value.trim()) return;
    e.preventDefault();
    complete();
    return;
  }

  if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
    e.preventDefault();
    termClear();
    return;
  }

  if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
    // only hijack ctrl+c when there is nothing selected to copy
    const sel = getSelection();
    if (sel && !sel.isCollapsed) return;
    e.preventDefault();
    echo(input.value + "^C");
    input.value = "";
    histIdx = hist.length;
    draft = "";
    return;
  }

  if (e.key === "Escape" && input.value) {
    input.value = "";
    histIdx = hist.length;
    draft = "";
  }
}

/* ============================================================
   9. focus and the minimise toggle
   ============================================================ */

function focusable() {
  return root.dataset.min !== "true" && !state.get("panel");
}

function wireFocus() {
  /* Focus only on a real click inside the terminal — never on load,
     never behind a modal, and never in the middle of a selection. */
  root.addEventListener("pointerup", (e) => {
    if (!focusable()) return;
    if (e.target.closest("#term-min, #term-bar, .term-bar, a")) return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed) return;
    input.focus({ preventScroll: true });
  });

  state.on("panel", (v) => {
    if (v && document.activeElement === input) input.blur();
  });
}

function setMin(min) {
  root.dataset.min = String(min);
  store.set("termMin", min);
  if (minBtn) {
    minBtn.textContent = min ? "+" : "—";
    minBtn.setAttribute("aria-expanded", String(!min));
    minBtn.setAttribute("title", min ? "expand" : "minimise");
    minBtn.setAttribute("aria-label", min ? "expand terminal" : "minimise terminal");
  }
  if (min && document.activeElement === input) input.blur();
  if (!min) {
    chWidth = 0;
    requestAnimationFrame(() => { if (out) out.scrollTop = out.scrollHeight; });
  }
}

/* ============================================================
   10. fallback styling

   ui.css owns the terminal's looks. This is only here so the log
   still reads correctly if it hasn't got to the line classes yet:
   it sits in a cascade layer, so any unlayered rule beats it.
   ============================================================ */

const FALLBACK_CSS = `
@layer lair-terminal {
  #term-out { font-family: var(--f-mono); white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; }
  #term-out .term-l { min-height: 1.15em; }
  #term-out .term-dim { color: var(--ink-mute); }
  #term-out .term-echo { color: var(--ink-dim); }
  #term-out .term-echo .term-ps { color: var(--mint); }
  #term-out .term-head { color: var(--term-green); }
  #term-out .term-ok { color: var(--mint); }
  #term-out .term-warn { color: var(--amber); }
  #term-out .term-err { color: var(--ember); }
  #term-out .term-gb-when { color: var(--ink-mute); }
  #term-out .term-cursor { color: var(--mint); }
  #term-out a { color: var(--amber); }
  #terminal[data-min="true"] #term-out,
  #terminal[data-min="true"] .term-line { display: none; }
  @media (prefers-reduced-motion: no-preference) {
    #term-out .term-cursor { animation: term-blink 1.05s steps(1) infinite; }
  }
  @keyframes term-blink { 50% { opacity: 0; } }
}`;

function injectFallbackCss() {
  if (document.getElementById("term-fallback-css")) return;
  const style = el("style", { id: "term-fallback-css" });
  style.textContent = FALLBACK_CSS;
  document.head.append(style);
}

/* ============================================================
   11. boot
   ============================================================ */

export function initTerminal() {
  if (started) return;
  root = $("#terminal");
  if (!root) return;
  out = $("#term-out", root);
  input = $("#term-in", root);
  if (!out || !input) return;

  promptEl = $(".term-prompt", root) || $("#term-prompt", root);
  minBtn = $("#term-min", root);
  started = true;

  injectFallbackCss();
  root.dataset.busy = "false";
  input.setAttribute("enterkeyhint", "go");
  input.setAttribute("autocorrect", "off");

  setPrompt();
  setMin(store.get("termMin", false) === true);

  input.addEventListener("keydown", onKeyDown);
  wireFocus();
  minBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    setMin(root.dataset.min !== "true");
  });

  // let the visitor scroll back without the log yanking them down
  out.addEventListener("scroll", () => {
    stick = out.scrollHeight - out.scrollTop - out.clientHeight < 28;
  }, { passive: true });

  addEventListener("resize", debounce(() => { chWidth = 0; }, 150));

  getFs();   // warm the tree so tab completion is ready when asked

  // hold the intro until the visitor is actually through the door
  if (state.get("entered")) {
    enqueue(bootIntro);
  } else {
    let fired = false;
    const go = () => {
      if (fired) return;
      fired = true;
      off();
      clearTimeout(timer);
      enqueue(bootIntro);
    };
    const off = state.on("entered", (v) => { if (v) go(); });
    const timer = setTimeout(go, 9000);
  }
}
