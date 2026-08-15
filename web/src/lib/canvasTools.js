// Canvas tool catalog — the select / commit / Layers contract for every tool
// that can be armed on the takeoff canvas. Pure data + helpers so node:test
// can pin the table without mounting TakeoffCanvas.jsx.
//
// Arming a tool is only setTool(id): no shape, no markup, no Layers leaf.
// A Layers row appears only after a shape commit (buildLayerTree + kindFromRole).
// Markup / stamp land in markups[] and never in the Layers panel.

import { kindFromRole } from "./layerTree.js";

/** Letter-key → tool id. Shift D/Q are in SHIFT_LETTER_TO_TOOL, not here. */
export const LETTER_TO_TOOL = {
  p: "pan",
  v: "select",
  a: "area",
  r: "rect",
  l: "linear",
  q: "curve",
  s: "surface",
  c: "count",
  d: "deduct",
  o: "oneclick",
  w: "walltrace",
  u: "wallarea",
  k: "check",
  h: "highlighter",
};

/** Shift + this `e.key` (uppercase) arms the cut-out variants. */
export const SHIFT_LETTER_TO_TOOL = {
  D: "deduct-rect",
  Q: "deduct-curve",
};

function shape(fields) {
  return {
    creates: "shape",
    createsLayer: true,
    needsScale: true,
    needsCondition: true,
    needsHeight: false,
    proposalThenCreate: false,
    ...fields,
    layerKind: kindFromRole(fields.measure_role),
  };
}

function markup(fields = {}) {
  return {
    creates: "markup",
    createsLayer: false,
    layerKind: null,
    needsScale: false,
    needsCondition: false,
    needsHeight: false,
    ...fields,
  };
}

function none(fields = {}) {
  return {
    creates: "none",
    createsLayer: false,
    layerKind: null,
    needsScale: false,
    needsCondition: false,
    needsHeight: false,
    ...fields,
  };
}

/**
 * One row per canvas tool id (and chrome that is not a draw tool).
 * `minPts` is the Enter / Finish gate for poly-draw tools; omit it when the
 * tool commits on click, via a proposal, or never draws a poly.
 */
export const TOOL_SPEC = {
  // ── measure rail ──────────────────────────────────────────────────────────
  oneclick: shape({
    shortcut: "O",
    measure_role: "floor_area",
    carveRole: "deduct",
    proposalThenCreate: true,
  }),
  walltrace: shape({
    shortcut: "W",
    measure_role: "wall_area",
    proposalThenCreate: true,
    needsHeight: true,
  }),
  wallarea: shape({
    shortcut: "U",
    measure_role: "surface_area",
    minPts: 2,
    needsHeight: true,
  }),
  area: shape({
    shortcut: "A",
    measure_role: "floor_area",
    minPts: 3,
  }),
  rect: shape({
    shortcut: "R",
    measure_role: "floor_area",
    clickCommit: "two-corner",
    commitVerts: 4,
  }),
  linear: shape({
    shortcut: "L",
    measure_role: "linear",
    minPts: 2,
  }),
  curve: shape({
    shortcut: "Q",
    measure_role: "linear",
    minPts: 2,
    curved: true,
  }),
  surface: shape({
    shortcut: "S",
    measure_role: "surface_area",
    minPts: 2,
    needsHeight: true,
  }),
  count: shape({
    shortcut: "C",
    measure_role: "count",
    clickCommit: "point",
    commitVerts: 1,
    needsScale: false,
  }),

  // ── cut out ───────────────────────────────────────────────────────────────
  deduct: shape({
    shortcut: "D",
    measure_role: "deduct",
    minPts: 3,
  }),
  "deduct-rect": shape({
    shortcut: "⇧D",
    measure_role: "deduct",
    clickCommit: "two-corner",
    commitVerts: 4,
  }),
  "deduct-curve": shape({
    shortcut: "⇧Q",
    measure_role: "deduct",
    minPts: 2,
    commitMinPts: 3,
  }),

  // ── markup (markups[], never a Layers leaf) ───────────────────────────────
  highlighter: markup({ shortcut: "H" }),
  cloud: markup(),
  callout: markup(),
  text: markup(),
  highlight: markup(),
  stamp: markup(),

  // ── mode / scale / leftover ───────────────────────────────────────────────
  select: none({ shortcut: "V" }),
  pan: none({ shortcut: "P" }),
  calibrate: none(),
  check: none({ shortcut: "K" }),
  schedule: none({ clickCommit: "two-corner", returnsToSelect: true, unreachable: true }),
  zone: {
    creates: "ephemeral",
    createsLayer: false,
    layerKind: null,
    minPts: 3,
    needsScale: false,
    needsCondition: false,
    needsHeight: false,
    unreachable: true,
  },

  // ── chrome: arming / clicking these mints no takeoff ──────────────────────
  files: none(),
  layers: none(),
  invert: none(),
  theme: none(),
  "auto-takeoff": none(),
  boq: none(),
  estimate: none(),
  rates: none(),
  finishes: none(),
  report: none(),
  gallery: none({ shortcut: "G" }),
};

export const CHROME_IDS = [
  "files", "layers", "invert", "theme", "auto-takeoff",
  "boq", "estimate", "rates", "finishes", "report", "gallery",
];

export function createsLayerLeaf(toolId) {
  return TOOL_SPEC[toolId]?.createsLayer === true;
}

/** Enter / Finish gate — same rules as TakeoffCanvas canFinishCurrentDraw. */
export function canFinishDraw(tool, nPts, { zoneCross } = {}) {
  if (tool === "zone" && zoneCross) return false;
  const spec = TOOL_SPEC[tool];
  if (!spec || spec.minPts == null) return false;
  return nPts >= spec.minPts;
}

/**
 * Fixture shape for Layers tests. No area math — just the measure_role the
 * tool would stamp. Pass `{ carve: true }` for One-Click ⌥-carve (deduct).
 */
export function draftShapeFromTool(toolId, verts, opts = {}) {
  const spec = TOOL_SPEC[toolId];
  if (!spec || spec.creates !== "shape") return null;
  const role = opts.carve && spec.carveRole ? spec.carveRole : spec.measure_role;
  return {
    id: opts.id || "draft",
    sheet_id: opts.sheet_id || "s1",
    condition_id: opts.condition_id || "c1",
    measure_role: role,
    verts_norm: verts,
    ...(spec.curved ? { curved: true } : {}),
    computed: opts.computed || {},
  };
}
