/* ============================================================
   films.js — what's on the shelf.

   Everything here is either public domain or an official free
   upload, and nothing is hosted by us: the TV embeds the source
   player directly. Every archive.org identifier below was checked
   against https://archive.org/metadata/<id> and confirmed to have
   at least one playable video file. If you add a title, check it
   the same way first — archive.org answers 200 with an empty {}
   for identifiers that do not exist, so a green status code alone
   proves nothing.
   ============================================================ */

export const GENRES = [
  { key: "scifi",   label: "SCI-FI",    accent: "#6fc3e8" },
  { key: "thriller",label: "THRILLER",  accent: "#e0574a" },
  { key: "noir",    label: "NOIR",      accent: "#9aa7b4" },
  { key: "cyber",   label: "ANTI-UTOPIA", accent: "#b98bff" },
  { key: "drama",   label: "DRAMA",     accent: "#f2c15c" },
  { key: "advent",  label: "ADVENTURE", accent: "#5ec98a" },
  { key: "action",  label: "ACTION",    accent: "#f08a3c" },
];

const archive = (src) => ({ type: "archive", src, link: `https://archive.org/details/${src}` });

export const FILMS = [
  /* ---------- sci-fi ---------- */
  {
    id: "metropolis", genre: "scifi", title: "Metropolis", year: 1927,
    runtime: 153, colour: "#3b6d8c", ...archive("metropolis_202511"),
    blurb: "the city runs on people you never see. still the best-looking film about that.",
  },
  {
    id: "things-to-come", genre: "scifi", title: "Things to Come", year: 1936,
    runtime: 100, colour: "#4a7f93", ...archive("things-to-come-1936_202505"),
    blurb: "wells writes the next hundred years. gets a surprising amount of it right.",
  },
  {
    id: "teenagers-outer-space", genre: "scifi", title: "Teenagers from Outer Space", year: 1959,
    runtime: 86, colour: "#2f5f74", ...archive("TeenagersFromOuterSpace1959"),
    blurb: "the budget is visible from orbit. watch it anyway.",
  },

  /* ---------- thriller ---------- */
  {
    id: "doa", genre: "thriller", title: "D.O.A.", year: 1950,
    runtime: 83, colour: "#a8382c", ...archive("d.-o.-a.-1950"),
    blurb: "a man walks into a police station to report his own murder.",
  },
  {
    id: "nosferatu", genre: "thriller", title: "Nosferatu", year: 1922,
    runtime: 94, colour: "#4a3b52", ...archive("nosferatu-1922_202510"),
    blurb: "a hundred years on and the shadow going up the stairs still works.",
  },

  /* ---------- noir ---------- */
  {
    id: "hitch-hiker", genre: "noir", title: "The Hitch-Hiker", year: 1953,
    runtime: 71, colour: "#2c333b", ...archive("Hitch_Hiker"),
    blurb: "two men, a car, and a passenger who never quite closes both eyes.",
  },
  {
    id: "detour", genre: "noir", title: "Detour", year: 1945,
    runtime: 68, colour: "#3a3f47", ...archive("detour_1945"),
    blurb: "sixty-eight minutes of a man explaining how none of it was his fault.",
  },
  {
    id: "scarlet-street", genre: "noir", title: "Scarlet Street", year: 1945,
    runtime: 102, colour: "#7a2f30", ...archive("ScarletStreet"),
    blurb: "a mild cashier paints on sundays. it goes badly.",
  },

  /* ---------- anti-utopia ---------- */
  {
    id: "equilibrium", genre: "cyber", title: "Equilibrium", year: 2002,
    runtime: 107, colour: "#5c4a8a", type: "youtube", src: "vuyJx_pMae4",
    link: "https://youtu.be/vuyJx_pMae4", restricted: true,
    blurb: "feeling is a crime. youtube thinks you might be too young for it.",
  },
  {
    id: "last-man-on-earth", genre: "cyber", title: "The Last Man on Earth", year: 1964,
    runtime: 86, colour: "#6b5a7d", ...archive("the-last-man-on-earth-1964"),
    blurb: "the one everything after it borrowed from.",
  },

  /* ---------- drama ---------- */
  {
    id: "meet-john-doe", genre: "drama", title: "Meet John Doe", year: 1941,
    runtime: 122, colour: "#b08432", ...archive("MeetJohnDoeHD"),
    blurb: "a made-up man becomes a movement. capra knows exactly how that ends.",
  },
  {
    id: "his-girl-friday", genre: "drama", title: "His Girl Friday", year: 1940,
    runtime: 92, colour: "#c9963f", ...archive("HisGirlFriday1940"),
    blurb: "nobody has spoken this fast since. put the subtitles on.",
  },

  /* ---------- adventure ---------- */
  {
    id: "the-general", genre: "advent", title: "The General", year: 1926,
    runtime: 67, colour: "#3f7d4e", ...archive("TheGeneral720p1926"),
    blurb: "keaton, a locomotive, and no visible special effects. all of it is real.",
  },
  {
    id: "the-lost-world", genre: "advent", title: "The Lost World", year: 1925,
    runtime: 106, colour: "#2f6b46", ...archive("TheLostWorld1925"),
    blurb: "stop-motion dinosaurs, decades early. willis o'brien warming up for kong.",
  },
  {
    id: "gullivers-travels", genre: "advent", title: "Gulliver's Travels", year: 1939,
    runtime: 76, colour: "#4e8f63", ...archive("gullivers-travels-1939"),
    blurb: "fleischer studios take on swift. gorgeous, and quietly strange.",
  },

  /* ---------- action ---------- */
  {
    id: "kansas-city-confidential", genre: "action", title: "Kansas City Confidential", year: 1952,
    runtime: 99, colour: "#b3652a", ...archive("KansasCityConfidential1952"),
    blurb: "an armoured car job where nobody knows anybody's face. tarantino took notes.",
  },
  {
    id: "beat-the-devil", genre: "action", title: "Beat the Devil", year: 1953,
    runtime: 89, colour: "#a2662f", ...archive("beat-the-devil-1953"),
    blurb: "huston and capote wrote it as they shot it. it shows, delightfully.",
  },
];

export const filmsByGenre = (key) => FILMS.filter((f) => f.genre === key);
export const filmById = (id) => FILMS.find((f) => f.id === id) || null;

/** archive.org serves a free item thumbnail; there is none for YouTube entries. */
export const posterUrl = (film) =>
  film.type === "archive" ? `https://archive.org/services/img/${film.src}` : null;
