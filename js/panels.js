/* ============================================================
   panels.js — the modal layer.

   One panel open at a time, driven by state.panel. Rendering is
   data-driven: register(id, fn) and the host calls fn(data) to
   build the body. Focus handling is the real work here — a modal
   that traps the keyboard badly is worse than no modal.
   ============================================================ */

import { $, $$, el, escapeHtml, clamp } from "./util.js";
import * as state from "./state.js";
import { toast } from "./toast.js";
import {
  LINKS, SKILLS, PROJECTS, ARTICLES, BOOKS, FLAVOUR, WHOAMI,
} from "./data/content.js";
import { GENRES, FILMS, filmsByGenre, posterUrl } from "./data/films.js";
import { playTape } from "./tv.js";
import { mountArcade, stopArcade } from "./arcade.js";
import { setLayer, setMaster, toggleAmbience } from "./ambience.js";
import { PRESETS } from "./scene.js";

const renderers = new Map();
export const registerPanel = (id, fn) => renderers.set(id, fn);

let host, layer, backdrop;
let lastFocus = null;
let scrollLock = 0;

/* ---------- small builders ---------- */

const h = (tag, cls, ...kids) => el(tag, cls ? { class: cls } : {}, ...kids);

const lead = (t) => h("p", "lead", t);
const note = (t) => h("p", "note", t);
const fine = (t) => h("p", "fine", t);

function chips(list) {
  return h("div", "chips", ...list.map((s) => h("span", null, s)));
}

function ctaLink(label, href, icon, external = true) {
  if (!href) {
    return el("span", { class: "cta-off", title: "not set yet" },
      el("i", { "data-ico": icon }), label);
  }
  return el("a", {
    href,
    class: "cta-link",
    ...(external && !href.startsWith("mailto:")
      ? { target: "_blank", rel: "noopener noreferrer" } : {}),
  }, el("i", { "data-ico": icon }), label);
}

/* ---------- panels ---------- */

registerPanel("recruiters", () => {
  const body = h("div", null,
    lead("I'm Denis — a data and software engineer. This is the part of the lair with the "
       + "lights on and the paperwork out."),
    chips(SKILLS),
    h("h3", null, "Selected work"),
    h("ul", "proj-list", ...PROJECTS.map((p) =>
      h("li", "proj",
        h("div", "proj-head",
          h("strong", null, p.title),
          h("em", null, p.role)),
        h("p", null, p.body),
        h("div", "proj-tags", ...p.tags.map((t) => h("span", null, t)))))),
    h("div", "cta",
      ctaLink("email me", `mailto:${LINKS.email}`, "mail", false),
      ctaLink("github", LINKS.github, "link"),
      ctaLink("linkedin", LINKS.linkedin, "link"),
      ctaLink("download CV", LINKS.cv, "link")),
    fine("Projects above are placeholders until Denis swaps in the real ones."),
  );
  return { title: "for recruiters", accent: "#ff6b52", body };
});

registerPanel("library", () => {
  const body = h("div", null,
    lead("Books worth the evening, all long out of copyright and free at Project Gutenberg."),
    h("ul", "book-list", ...BOOKS.map((b) =>
      h("li", "book",
        el("a", { href: b.url, target: "_blank", rel: "noopener noreferrer" },
          h("strong", null, b.title),
          h("em", null, ` — ${b.author}`)),
        h("span", null, b.note)))),
    h("h3", null, "Writing"),
    h("ul", "book-list", ...ARTICLES.map((a) =>
      h("li", "book",
        a.url
          ? el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" },
              h("strong", null, a.title))
          : h("strong", null, a.title),
        h("span", null, a.url ? a.note : `${a.note} · not written yet`)))),
    fine("The films live on the shelf in the room, not in here."),
  );
  return { title: "the library", accent: "#f2c15c", body };
});

registerPanel("arcade", () => {
  const canvas = el("canvas", { id: "arcade-big", width: 480, height: 480 });
  const scores = state.get("scores")?.snake || {};
  const body = h("div", "arcade-wrap",
    h("div", "arcade-screen-wrap", canvas),
    h("div", "arcade-side",
      h("div", "score-block",
        h("span", "score-label", "SCORE"),
        el("span", { class: "score-value", id: "arc-score" }, "0")),
      h("div", "score-block",
        h("span", "score-label", "BEST"),
        el("span", { class: "score-value", id: "arc-best" }, String(scores.best || 0))),
      note("arrows or WASD to steer · space to start"),
      fine("Scores are saved in this browser. They'll follow your account once sign-in lands.")),
  );
  // mount after the node is actually in the document
  queueMicrotask(() => mountArcade(canvas, { interactive: true }));
  return { title: "lair arcade", accent: "#7fb4ff", body, onClose: stopArcade };
});

registerPanel("dataroom", () => {
  // Deliberately generated, not fetched: nothing here talks to an external API.
  const series = (n, seed) => {
    let v = 50;
    return Array.from({ length: n }, (_, i) => {
      v += Math.sin(i * 0.6 + seed) * 6 + (((i * 9301 + seed * 49297) % 233) / 233 - 0.5) * 9;
      return clamp(v, 6, 94);
    });
  };
  const spark = (title, unit, seed, accent) => {
    const pts = series(34, seed);
    const d = pts.map((p, i) => `${(i / 33) * 100},${100 - p}`).join(" ");
    const last = pts[pts.length - 1].toFixed(1);
    return h("div", "spark",
      h("div", "spark-head", h("span", null, title), h("b", null, `${last}${unit}`)),
      el("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none", class: "spark-svg" },
        el("polyline", { points: d, fill: "none", stroke: accent, "stroke-width": "2",
          "vector-effect": "non-scaling-stroke" })));
  };
  const body = h("div", null,
    lead("The rack under the television. One day it will show something real."),
    h("div", "spark-grid",
      spark("events / sec", "k", 1, "#7fb4ff"),
      spark("pipeline lag", "s", 4, "#5ef0b0"),
      spark("warehouse cost", "€", 9, "#f2c15c"),
      spark("uptime", "%", 3, "#b98bff")),
    note("Sample data, generated in the browser. No external calls are made from this page."),
    fine("Planned: live Kafka lag, build status, and whatever else is worth a glance."),
  );
  return { title: "data room", accent: "#b98bff", body };
});

/* a deliberately tiny tokeniser — enough for three snippets, no library */
function highlight(code, lang) {
  const KW = lang === "sql"
    ? /\b(select|from|where|group|by|order|join|left|inner|on|with|as|and|or|not|null|case|when|then|else|end|over|partition|limit)\b/gi
    : /\b(const|let|var|function|return|import|export|from|await|async|if|else|for|of|in|new|class|=>|null|true|false)\b/g;
  const out = escapeHtml(code)
    .replace(/(--.*$|\/\/.*$)/gm, '<span class="tok-com">$1</span>')
    .replace(/('[^']*'|"[^"]*"|`[^`]*`)/g, '<span class="tok-str">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>')
    .replace(KW, '<span class="tok-kw">$&</span>');
  return out;
}

registerPanel("devcorner", () => {
  const SNIPS = [
    { title: "the bit that made the shelf sit straight", lang: "js", code:
`// the boards are not level - they follow the room's
// perspective, so each row gets its own tilt
const slope = (bot.right - bot.left) / (x1 - x0);
const rot = Math.atan(slope) * 180 / Math.PI;
row.style.transform = \`rotate(\${rot}deg)\`;` },
    { title: "finding a screen in a painting", lang: "js", code:
`// scan for the luminance cliff between wall and bezel
for (let x = x0; x < x1; x++) {
  const l = lum(pixel(x, y));
  if (prev > 90 && l < 30) return x; // edge
  prev = l;
}` },
    { title: "a query I keep rewriting", lang: "sql", code:
`select date_trunc('day', ts) as day,
       count(*) filter (where status = 'failed') as failures,
       count(*) as total
from   runs
where  ts >= now() - interval '30 days'
group  by 1
order  by 1 desc` },
  ];
  const body = h("div", null,
    lead("Bits and pieces. Mostly things I had to work out for this room."),
    ...SNIPS.map((s) =>
      h("div", "snippet",
        h("div", "snippet-head", s.title),
        el("pre", {}, el("code", { html: highlight(s.code, s.lang) })))),
    fine("More once there's more."),
  );
  return { title: "dev corner", accent: "#5ef0b0", body };
});

registerPanel("about", () => {
  const body = h("div", null,
    lead("Den's Lair is a room on the internet. Part portfolio, part living room, "
       + "entirely over-engineered."),
    h("h3", null, "How it's built"),
    h("p", null, "One painted 16:9 plate, measured pixel by pixel so code knows exactly where "
      + "the television, the shelf and the fireplace are. Everything moving on top of it is "
      + "canvas and CSS: the rain, the beads on the glass, the firelight, the dust. The dog "
      + "breathes by cloning a small rectangle of the picture and scaling it by half a percent."),
    h("p", null, "No framework. No build step. No tracking, no cookies, no analytics. "
      + "It is a folder of static files on a CDN."),
    h("h3", null, "About the films"),
    h("p", null, "Nothing is hosted here. Every title on the shelf is either public domain or "
      + "an official free upload, and the television embeds the source player directly — "
      + "archive.org, or YouTube. If a title refuses to play inside the room, the screen will "
      + "hand you a link to watch it at the source instead. That happens with age-restricted "
      + "uploads and is expected."),
    fine("© Denis · denslair.com · films belong to their rights holders · the dog belongs "
       + "to no one"),
  );
  return { title: "about this lair", accent: "#f2c15c", body };
});

registerPanel("settings", () => {
  const amb = state.get("ambience");

  const row = (label, control) => h("div", "setting-row", h("span", null, label), control);

  const weatherPicker = h("div", "seg", ...Object.entries(PRESETS).map(([key, p]) =>
    el("button", {
      class: state.get("weather") === key ? "is-active" : "",
      onClick: (e) => {
        state.set("weather", key);
        $$(".seg button", e.currentTarget.parentElement).forEach((b) =>
          b.classList.toggle("is-active", b === e.currentTarget));
      },
    }, p.label.toLowerCase())));

  const toggle = (get, onSet) => {
    const b = el("button", { class: `switch ${get() ? "is-on" : ""}`, role: "switch",
      "aria-checked": String(get()) });
    b.addEventListener("click", () => {
      onSet();
      b.classList.toggle("is-on", get());
      b.setAttribute("aria-checked", String(get()));
    });
    return b;
  };

  const slider = (value, onInput) => {
    const i = el("input", { type: "range", min: "0", max: "100", value: String(value * 100),
      class: "slider" });
    i.addEventListener("input", () => onInput(i.valueAsNumber / 100));
    return i;
  };

  const body = h("div", null,
    lead("Adjust the room."),
    row("weather", weatherPicker),
    row("lights", toggle(() => state.get("lightsOn"), () => {
      const v = !state.get("lightsOn");
      state.set("lightsOn", v);
      document.body.dataset.lights = v ? "on" : "off";
    })),
    row("fireplace", toggle(() => state.get("fireOn"), () => {
      const v = !state.get("fireOn");
      state.set("fireOn", v);
      document.body.dataset.fire = v ? "on" : "off";
    })),
    h("h3", null, "Ambience"),
    row("playing", toggle(() => state.get("ambience").on, () => toggleAmbience())),
    row("master", slider(amb.master, (v) => setMaster(v))),
    ...Object.entries(amb.layers).map(([name, v]) =>
      row(name, slider(v, (nv) => setLayer(name, nv)))),
    h("h3", null, "Housekeeping"),
    row("reset the lair", el("button", {
      class: "danger",
      onClick: () => {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("lair:")) localStorage.removeItem(k);
        }
        toast("cleared. reloading…");
        setTimeout(() => location.reload(), 700);
      },
    }, "clear saved state")),
    fine("Everything is stored in this browser only. Nothing leaves the page."),
  );
  return { title: "settings", accent: "#9aa7b4", body };
});

registerPanel("signin", () => {
  const body = h("div", null,
    lead("Not built yet — but here's what it's for."),
    h("ul", "book-list",
      h("li", "book", h("strong", null, "leave a message"),
        h("span", null, "in the terminal, for whoever drops by next")),
      h("li", "book", h("strong", null, "keep your arcade scores"),
        h("span", null, "so the high score follows you between devices")),
      h("li", "book", h("strong", null, "pick up where you left off"),
        h("span", null, "your weather, your ambience mix, the film you paused"))),
    h("form", "signin-form",
      el("input", { type: "email", placeholder: "you@example.com", disabled: "disabled",
        "aria-label": "email (not yet available)" }),
      el("button", { type: "button", class: "cta-off", disabled: "disabled" }, "sign in")),
    note("This form does nothing. It collects nothing. When it does work, it will use a "
       + "one-time link by email — there will be no password to lose."),
  );
  return { title: "sign in", accent: "#7fb4ff", body };
});

registerPanel("film", (film) => {
  if (!film) return { title: "nothing loaded", accent: "#9aa7b4", body: h("p", "empty", "…") };
  const poster = posterUrl(film);
  const art = poster
    ? el("img", { src: poster, alt: "", loading: "lazy", class: "film-poster" })
    : el("div", { class: "film-poster film-poster--none", style: { background: film.colour } },
        film.title.slice(0, 2).toUpperCase());
  const body = h("div", "film-sheet",
    art,
    h("div", "film-meta",
      h("h3", null, film.title),
      h("div", "film-sub", `${film.year} · ${film.runtime} min · ${
        (GENRES.find((g) => g.key === film.genre) || {}).label || ""}`),
      h("p", null, film.blurb),
      film.restricted
        ? note("This one is age-restricted at the source, so it will very likely refuse to "
             + "play inside the room. The screen will hand you a link instead.")
        : null,
      h("div", "cta",
        el("button", { class: "cta-link", onClick: () => { closePanel(); playTape(film); } },
          el("i", { "data-ico": "play" }), "play on the big screen"),
        ctaLink("watch at the source", film.link, "link"))),
  );
  return { title: film.title.toLowerCase(), accent: film.colour, body };
});

for (const key of ["globe", "picture", "mantel"]) {
  registerPanel(key, () => {
    const f = FLAVOUR[key];
    const body = h("div", null,
      ...f.body.split("\n\n").map((p) => h("p", null, p)));
    return { title: f.title, accent: "#c9a227", body };
  });
}

/* ---------- the host ---------- */

function focusables(root) {
  return $$('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])', root)
    .filter((n) => n.offsetParent !== null || n === document.activeElement);
}

function onKeydown(e) {
  if (e.key !== "Tab") return;
  const items = focusables(host);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

let activeClose = null;

export function openPanel(id, data) {
  const make = renderers.get(id);
  if (!make) { toast("nothing behind that one yet"); return; }

  if (state.get("panel")) closePanel({ silent: true });

  const spec = make(data);
  lastFocus = document.activeElement;

  host.textContent = "";
  const panel = el("div", { class: "panel", "data-panel": id,
    style: { "--panel-accent": spec.accent || "var(--amber)" } },
    el("div", { class: "panel-head" },
      el("h2", { class: "panel-title" }, spec.title),
      el("button", { class: "panel-close", "aria-label": "close", onClick: () => closePanel() },
        el("i", { "data-ico": "close" }))),
    el("div", { class: "panel-body" }, spec.body));
  host.append(panel);
  host.setAttribute("aria-label", spec.title);

  activeClose = spec.onClose || null;

  scrollLock = window.scrollY;
  layer.setAttribute("aria-hidden", "false");
  state.set("panel", id);

  panel.classList.add("is-entering");
  requestAnimationFrame(() => panel.classList.remove("is-entering"));

  addEventListener("keydown", onKeydown, true);
  (focusables(panel)[0] || panel.querySelector(".panel-close"))?.focus();
}

export function closePanel(opts = {}) {
  if (!state.get("panel")) return;

  try { activeClose?.(); } catch (err) { console.error("[panel:onClose]", err); }
  activeClose = null;

  const panel = host.firstElementChild;
  removeEventListener("keydown", onKeydown, true);
  layer.setAttribute("aria-hidden", "true");
  state.set("panel", null);

  const finish = () => { if (host.firstElementChild === panel) host.textContent = ""; };
  if (panel) {
    panel.classList.add("is-leaving");
    setTimeout(finish, 240);
  }

  if (!opts.silent && lastFocus && document.contains(lastFocus)) {
    lastFocus.focus({ preventScroll: true });
  }
  lastFocus = null;
}

export function initPanels() {
  layer = $("#panels");
  host = $("#panel-host");
  backdrop = $(".panel-backdrop", layer);
  if (!layer || !host) return;

  backdrop?.addEventListener("click", () => closePanel());
  layer.addEventListener("mousedown", (e) => {
    if (e.target === layer) closePanel();
  });
}
