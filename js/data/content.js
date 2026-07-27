/* ============================================================
   content.js — every word that isn't code.

   Denis: the PROJECTS, ARTICLES and LINKS blocks are placeholders.
   They read as finished so the panels look right, but replace them
   with the real thing before you tell anyone the URL.
   ============================================================ */

/* ---------- who to contact ---------- */
// TODO(Denis): your real links.
export const LINKS = {
  email: "hello@denslair.com",
  github: "https://github.com/",
  linkedin: "",
  cv: "",
};

/* ---------- the recruiters panel ---------- */
export const SKILLS = [
  "Data Engineering", "Analytics Engineering", "Kafka / Streaming",
  "Cloud Architecture", "Terraform · IaC", "CI/CD · DevOps",
  "Trading Infrastructure", "Python · SQL", "React (learning)",
];

// TODO(Denis): replace all four with real work, with numbers where you can.
export const PROJECTS = [
  {
    title: "Enterprise leadership dashboards",
    role: "Data engineer",
    body: "A cloud-native analytics platform feeding executive reporting. Infrastructure defined "
        + "end to end in Terraform, with the modelling layer version-controlled and tested like "
        + "application code.",
    tags: ["Cloud", "IaC", "Analytics"],
  },
  {
    title: "Trading data infrastructure",
    role: "Data engineer",
    body: "Streaming pipelines carrying market and execution data, with monitoring designed so a "
        + "silent failure is louder than a noisy one.",
    tags: ["Kafka", "Streaming", "Observability"],
  },
  {
    title: "Warehouse migration",
    role: "Lead",
    body: "Moved reporting onto a new warehouse without a reporting outage, by running both "
        + "sides in parallel and reconciling them daily until the diff stayed at zero.",
    tags: ["Migration", "SQL", "Reliability"],
  },
  {
    title: "Den's Lair",
    role: "Everything",
    body: "This room. A painted 16:9 plate brought to life with layered canvas effects, a "
        + "measured hotspot map, and no framework or build step anywhere. Deployed to the edge "
        + "as static files.",
    tags: ["Canvas", "Vanilla JS", "Cloudflare"],
  },
];

// TODO(Denis): your own writing goes here.
export const ARTICLES = [
  { title: "Why your pipeline is slow and it isn't the database",
    note: "on the cost of doing work row by row when you could do it once",
    url: "" },
  { title: "Terraform state is a database. Treat it like one.",
    note: "backups, locking, and the day you learn why both matter",
    url: "" },
  { title: "Notes on building this room",
    note: "measuring a painting so code can sit on top of it",
    url: "" },
];

/* ---------- the library ---------- */
// Project Gutenberg ebook ids, all long out of copyright.
export const BOOKS = [
  { title: "Frankenstein", author: "Mary Shelley", url: "https://www.gutenberg.org/ebooks/84",
    note: "the original cautionary tale about shipping without a review" },
  { title: "The Time Machine", author: "H. G. Wells", url: "https://www.gutenberg.org/ebooks/35",
    note: "proto sci-fi, and still sharper than most of its descendants" },
  { title: "The Adventures of Sherlock Holmes", author: "Arthur Conan Doyle",
    url: "https://www.gutenberg.org/ebooks/1661", note: "fireplace-grade deduction" },
  { title: "The Art of War", author: "Sun Tzu", url: "https://www.gutenberg.org/ebooks/132",
    note: "quoted in far more sprint plannings than it deserves" },
  { title: "Meditations", author: "Marcus Aurelius", url: "https://www.gutenberg.org/ebooks/2680",
    note: "a roman emperor talking himself down. relatable." },
  { title: "Flatland", author: "Edwin A. Abbott", url: "https://www.gutenberg.org/ebooks/97",
    note: "dimensional thinking, disguised as satire" },
  { title: "The Strange Case of Dr Jekyll and Mr Hyde", author: "Robert Louis Stevenson",
    url: "https://www.gutenberg.org/ebooks/43", note: "prod and staging, personified" },
  { title: "Twenty Thousand Leagues Under the Seas", author: "Jules Verne",
    url: "https://www.gutenberg.org/ebooks/164", note: "for when the room isn't quiet enough" },
];

/* ---------- footer lines ---------- */
// Original lines, deliberately unattributed — no quoting real people.
export const QUOTES = [
  "the fire does not need you to watch it to keep burning.",
  "everything here was measured before it was built.",
  "a room is just a set of decisions someone stopped revisiting.",
  "ship it, then sit down.",
  "the hard part was never the code.",
  "make it work, make it right, then go outside.",
  "good infrastructure is the kind nobody thanks you for.",
  "the dog has the correct approach to most problems.",
];

/* ---------- the resident ---------- */
export const DOG_LINES = [
  "*exhales through nose*",
  "one eye. just the one.",
  "*repositions, somehow taking up more room*",
  "tail moves once. that's the whole response.",
  "*sighs like you've asked for a great deal*",
  "not asleep. resting the eyes.",
  "a single ear rotates toward you, then gives up.",
  "*dreams audibly*",
  "she has decided you are furniture.",
  "you have been acknowledged. do not expect more.",
];

/* ---------- terminal ---------- */
export const FORTUNES = [
  "the bug is in the part you were sure about.",
  "you will spend an hour on the thing you estimated at five minutes.",
  "somewhere, a cron job is running that nobody remembers writing.",
  "it works on your machine. your machine is not the customer.",
  "the logs contained the answer the entire time.",
  "naming things is still the hard one.",
  "that TODO is now four years old.",
  "cache invalidation says hello.",
];

export const WHOAMI = [
  "Denis — data & software engineer.",
  "Builds pipelines, dashboards and the odd trading system.",
  "Currently: learning React, and painting a room with javascript.",
];

/* ---------- small flavour panels ---------- */
export const FLAVOUR = {
  globe: {
    title: "the globe",
    body: "Mostly decorative. It does spin, if you're the sort of person who spins globes.\n\n"
        + "Places that turn up in my CV: the Netherlands, and a good deal of remote work with "
        + "teams several time zones out. The overlap hours are where the real engineering "
        + "decisions get made.",
  },
  picture: {
    title: "somewhere quieter",
    body: "A river, some mountains, no notifications.\n\n"
        + "It's here to remind me the screen is not the only place things happen.",
  },
  mantel: {
    title: "the mantelpiece",
    body: "A plant that has survived longer than expected, and two photographs that are none of "
        + "your business.\n\nThe plant is the achievement.",
  },
};

/* ---------- the fake filesystem the terminal walks ---------- */
export const FS = {
  "/": ["about", "projects", "films", "books", "contact", "lair"],
  "/about": WHOAMI.join("\n"),
  "/projects": PROJECTS.map((p) => `${p.title} — ${p.role}\n  ${p.body}`).join("\n\n"),
  "/books": BOOKS.map((b) => `${b.title} — ${b.author}\n  ${b.url}`).join("\n"),
  "/contact": `email    ${LINKS.email}\ngithub   ${LINKS.github || "(not set)"}\ncv       ${LINKS.cv || "(not set yet)"}`,
  "/lair": "built with vanilla javascript, one painted plate, and a lot of measuring.\n"
         + "no framework. no build step. no tracking.",
};
