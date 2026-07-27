/* ============================================================
   geometry.js — the single source of truth for where things are.

   Every coordinate below is in PLATE SPACE: the native pixel grid
   of the artwork, 1672 x 941. Nothing else in the codebase may
   hard-code a scene coordinate; import from here instead.

   These were measured off denslair_2_0_day.png by luminance edge
   detection, not eyeballed. If you regenerate the plates, re-run
   the measurement pass before trusting them again.
   ============================================================ */

export const PLATE = { w: 1672, h: 941, ratio: 1672 / 941 };

/** Convert plate px -> percentage string, for CSS positioning. */
export const px = (v, axis = "x") =>
  `${(v / (axis === "x" ? PLATE.w : PLATE.h)) * 100}%`;

/** Rect in plate space -> {left,top,width,height} as CSS percentages. */
export function rectToCss({ x, y, w, h }) {
  return {
    left: px(x, "x"),
    top: px(y, "y"),
    width: px(w, "x"),
    height: px(h, "y"),
  };
}

/* ------------------------------------------------------------
   THE TV
   Measured from the inner screen glass, not the bezel. The panel
   is rotated ~1.7deg counter-clockwise in the artwork; the quad
   below was fitted to eight independent edge samples and
   reproduces all of them to under a pixel.
   ------------------------------------------------------------ */
export const TV = {
  screen: { cx: 764, cy: 298.5, w: 338, h: 208, rot: -1.7 },
  // fitted corners, kept for the hotspot outline
  quad: [
    [592.0, 199.6],
    [929.9, 189.5],
    [936.0, 397.4],
    [598.2, 407.5],
  ],
  // where the glow pool lands on the wall + cabinet when it's on
  glow: { cx: 764, cy: 300, rx: 380, ry: 260 },
};

/* ------------------------------------------------------------
   THE BOOKSHELF
   Seven compartments, which happens to be exactly the number of
   genres on the shelf. The uprights are true verticals (confirmed
   at three heights), so each compartment only needs its own
   rotation — no full homography required.

   `top` / `bot` are [yAtLeftEdge, yAtRightEdge] of each board.
   ------------------------------------------------------------ */
const SHELF_X0 = 1032;
const SHELF_X1 = 1304;

const SHELF_BOARDS = [
  [69.9, 51.4], // underside of the crown
  [123.3, 110.6],
  [190.7, 183.8],
  [259.2, 256.9],
  [327.5, 332.1],
  [396.0, 405.3],
  [461.2, 478.6],
  [519.9, 540.7], // top of the plinth
];

export const SHELF = {
  x0: SHELF_X0,
  x1: SHELF_X1,
  width: SHELF_X1 - SHELF_X0,
  /** 7 compartments, top to bottom. */
  rows: SHELF_BOARDS.slice(0, -1).map((top, i) => {
    const bot = SHELF_BOARDS[i + 1];
    const slope = (bot[1] - bot[0]) / (SHELF_X1 - SHELF_X0);
    return {
      index: i,
      x: SHELF_X0,
      w: SHELF_X1 - SHELF_X0,
      // box is anchored on the left edge; rotation does the rest
      y: top[0],
      h: bot[0] - top[0],
      /** degrees — the tilt of the board this row's items stand on */
      rot: (Math.atan(slope) * 180) / Math.PI,
    };
  }),
  /** outer bounds, for the hotspot */
  bounds: { x: 1014, y: 40, w: 331, h: 520 },
};

/* ------------------------------------------------------------
   THE ARCADE CABINET
   Screen and marquee share the cabinet's ~3.3deg tilt.
   ------------------------------------------------------------ */
/* The cabinet leans away to the left, so the screen is not just
   rotated — its verticals lean too. These are the corners of the LIT
   area, not the bezel, checked by overlaying the box on the plate:
     TL(1445,762) TR(1564,776) BR(1558,851) BL(1440,840)
   Colour thresholding is no help here — the cabinet is dark blue too.
   The marquee is a separate panel tilted back at a steeper angle;
   it already carries painted artwork, so nothing renders on it. */
export const ARCADE = {
  screen: { cx: 1502, cy: 809, w: 122, h: 84, rot: 6, skew: -3.7 },
  marquee: { cx: 1511.5, cy: 723, w: 138, h: 38.5, rot: 9.9 },
  bounds: { x: 1395, y: 688, w: 220, h: 253 },
  joystick: { cx: 1393, cy: 826 },
};

/* ------------------------------------------------------------
   THE FIREPLACE
   ------------------------------------------------------------ */
export const FIRE = {
  box: { x: 1483, y: 434, w: 114, h: 107 },
  core: { cx: 1546, cy: 497 },
  /** warm light spilling left onto the beanbag and floorboards */
  spill: { cx: 1500, cy: 560, rx: 300, ry: 200 },
  mantel: { x: 1424, y: 300, w: 248, h: 100 },
};

/* ------------------------------------------------------------
   THE WINDOW
   Polygon traced along the visible glass. Weather effects are
   clipped to this and then masked against `WINDOW.occluders`,
   which are the indoor objects standing in front of the glass —
   without those holes, rain would fall over the desk lamp.
   ------------------------------------------------------------ */
export const WINDOW = {
  glass: [
    [24, 124],
    [120, 133],
    [210, 142],
    [290, 157],
    [365, 174],
    [365, 404],
    [290, 410],
    [210, 421],
    [120, 440],
    [24, 458],
  ],
  occluders: {
    mullion: { x: 224, y: 128, w: 19, h: 294 },
    lampHead: { cx: 100, cy: 336, rx: 44, ry: 38 },
    lampArm: [
      [82, 310],
      [96, 316],
      [50, 466],
      [34, 462],
    ],
    bonsaiTop: { cx: 162, cy: 385, rx: 46, ry: 34 },
    bonsaiPot: { x: 130, y: 414, w: 62, h: 56 },
  },
  /** band of city windows that twinkle after dark */
  cityBand: { x: 24, y: 228, w: 341, h: 184 },
  /** sky region — cloud drift and the sun/moon live here */
  sky: { x: 24, y: 124, w: 341, h: 130 },
};

export const LAMP = { cx: 100, cy: 352, r: 130 };

/* ------------------------------------------------------------
   LIVE PATCHES
   Regions of the flat plate that get cloned, clipped and gently
   transformed to fake motion without cutting the artwork up.
   Keep the movement under ~1.5% or the clip edges start to show.
   ------------------------------------------------------------ */
export const PATCHES = {
  dog: {
    region: { x: 1310, y: 592, w: 176, h: 120 },
    feather: 22,
    anim: "breathe",
  },
  blanket: {
    region: { x: 236, y: 516, w: 190, h: 190 },
    feather: 26,
    anim: "sway",
  },
};

/* ------------------------------------------------------------
   HOTSPOTS
   Order matters: earlier entries win a click when shapes overlap.
   `shape` is either a rect, an ellipse, or an explicit polygon.
   `act` maps to a handler registered in js/actions.js.
   ------------------------------------------------------------ */
export const HOTSPOTS = [
  { id: "tv", act: "tv", label: "the DEN·TRON — pick something to watch",
    shape: { poly: TV.quad } },
  { id: "shelf", act: "shelf", label: "the shelf — films, books, writing",
    shape: { rect: SHELF.bounds } },
  { id: "arcade", act: "arcade", label: "LAIR ARCADE — insert coin",
    shape: { rect: ARCADE.bounds } },
  { id: "laptop", act: "recruiters", label: "for recruiters — open the laptop",
    shape: { poly: [[819, 573], [961, 587], [928, 656], [773, 633]] } },
  { id: "window", act: "weather", label: "the window — change the weather",
    shape: { poly: WINDOW.glass } },
  { id: "fireplace", act: "fire", label: "poke the fire",
    shape: { rect: { x: 1440, y: 377, w: 220, h: 185 } } },
  { id: "dog", act: "dog", label: "the resident",
    shape: { rect: { x: 1316, y: 596, w: 166, h: 114 } } },
  { id: "lamp", act: "lamp", label: "desk lamp",
    shape: { rect: { x: 29, y: 298, w: 112, h: 178 } } },
  { id: "turntable", act: "ambience", label: "the turntable — lair ambience",
    shape: { rect: { x: 224, y: 386, w: 208, h: 76 } } },
  { id: "globe", act: "globe", label: "where I've worked",
    shape: { ellipse: { cx: 1371, cy: 467, rx: 66, ry: 70 } } },
  { id: "poster", act: "about", label: "focus · build · ship it · repeat",
    shape: { rect: { x: 438, y: 150, w: 68, h: 148 } } },
  { id: "notebook", act: "devcorner", label: "ideas · plans · execution",
    shape: { rect: { x: 165, y: 824, w: 154, h: 98 } } },
  { id: "headphones", act: "ambience", label: "ambience mixer",
    shape: { rect: { x: 23, y: 801, w: 127, h: 102 } } },
  { id: "mug", act: "mug", label: "still warm",
    shape: { rect: { x: 703, y: 565, w: 67, h: 77 } } },
  { id: "controller", act: "arcade", label: "player one",
    shape: { rect: { x: 615, y: 592, w: 85, h: 45 } } },
  { id: "picture", act: "picture", label: "somewhere quieter",
    shape: { rect: { x: 1467, y: 147, w: 138, h: 151 } } },
  { id: "mantel", act: "mantel", label: "the mantelpiece",
    shape: { rect: { x: 1440, y: 300, w: 232, h: 80 } } },
  { id: "cabinet", act: "dataroom", label: "the rack — live data",
    shape: { rect: { x: 560, y: 425, w: 390, h: 120 } } },
];

/** Build an SVG path string for any hotspot shape. */
export function shapeToPath(shape) {
  if (shape.poly) {
    return "M" + shape.poly.map(([x, y]) => `${x},${y}`).join("L") + "Z";
  }
  if (shape.rect) {
    const { x, y, w, h } = shape.rect;
    return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
  }
  const { cx, cy, rx, ry } = shape.ellipse;
  return `M${cx - rx},${cy}a${rx},${ry} 0 1,0 ${rx * 2},0a${rx},${ry} 0 1,0 ${-rx * 2},0Z`;
}
