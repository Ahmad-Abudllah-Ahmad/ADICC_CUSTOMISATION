// Canvas tool catalog: arming vs commit vs Layers kind. Does not mount the
// TakeoffCanvas React tree — the contract lives in lib/canvasTools.js and is
// source-pinned against the page's finishShape / letter-key wiring.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CUT_TOOLS, MARKUP_TOOLS, MEASURE_TOOLS } from "../src/lib/canvasConstants.js";
import {
  CHROME_IDS,
  LETTER_TO_TOOL,
  SHIFT_LETTER_TO_TOOL,
  TOOL_SPEC,
  canFinishDraw,
  createsLayerLeaf,
  draftShapeFromTool,
} from "../src/lib/canvasTools.js";
import { buildLayerTree, kindFromRole } from "../src/lib/layerTree.js";

const here = dirname(fileURLToPath(import.meta.url));
const canvasPath = join(here, "../src/pages/TakeoffCanvas.jsx");
const guidePath = join(here, "../../docs/USER_GUIDE.md");

function fnBody(src: string, name: string) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} missing`);
  const next = src.indexOf("\n  function ", start + 1);
  assert.ok(next > start, `next function after ${name} missing`);
  return src.slice(start, next);
}

const REQUIRED_IDS = [
  ...MEASURE_TOOLS.map((t) => t.id),
  ...CUT_TOOLS.map((t) => t.id),
  ...MARKUP_TOOLS.map((t) => t.id),
  "select", "pan", "calibrate", "check", "stamp", "schedule", "zone",
];

const SHAPE_TOOLS = Object.keys(TOOL_SPEC).filter((id) => TOOL_SPEC[id].creates === "shape");
const MARKUP_IDS = Object.keys(TOOL_SPEC).filter((id) => TOOL_SPEC[id].creates === "markup");
const TRI = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4]];
const LINE = [[0.1, 0.1], [0.5, 0.1]];
const POINT = [[0.2, 0.3]];
const RECT4 = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]];

function leafKind(toolId: string, verts: number[][], opts?: { carve?: boolean }) {
  const shape = draftShapeFromTool(toolId, verts, { id: toolId, ...opts });
  assert.ok(shape, `${toolId} should draft a shape`);
  const tree = buildLayerTree({
    sheetKeys: ["s1"],
    shapes: [shape],
    condById: { c1: { finish_tag: "CPT-1", color: "#ff00ff" } },
  });
  assert.equal(tree.length, 1, `${toolId} lands as one ungrouped root leaf`);
  return tree[0];
}

test("catalog covers every measure, cut, markup, and leftover canvas tool", () => {
  const ids = Object.keys(TOOL_SPEC);
  assert.equal(new Set(ids).size, ids.length, "tool ids are unique");
  for (const id of REQUIRED_IDS) {
    assert.ok(TOOL_SPEC[id], `missing TOOL_SPEC.${id}`);
  }
  for (const id of CHROME_IDS) {
    assert.ok(TOOL_SPEC[id], `missing chrome TOOL_SPEC.${id}`);
    assert.equal(TOOL_SPEC[id].creates, "none");
    assert.equal(createsLayerLeaf(id), false);
  }
});

test("arming never creates a Layers leaf; only shape commits do", () => {
  for (const [id, spec] of Object.entries(TOOL_SPEC)) {
    assert.equal(
      spec.createsLayer,
      spec.creates === "shape",
      `${id}: createsLayer must equal creates === "shape"`,
    );
    assert.equal(createsLayerLeaf(id), spec.creates === "shape");
    if (spec.creates !== "shape") {
      assert.equal(draftShapeFromTool(id, TRI), null, `${id} must not draft a takeoff`);
    }
  }
});

test("shortcuts on the catalog match MEASURE / CUT / MARKUP lists", () => {
  for (const t of MEASURE_TOOLS) {
    assert.equal(TOOL_SPEC[t.id].shortcut, t.shortcut, t.id);
  }
  for (const t of CUT_TOOLS) {
    assert.equal(TOOL_SPEC[t.id].shortcut, t.shortcut, t.id);
  }
  for (const t of MARKUP_TOOLS) {
    assert.equal(TOOL_SPEC[t.id].shortcut, t.shortcut, t.id);
  }
});

test("letter map and shift-cut map cover the catalog shortcuts", () => {
  assert.deepEqual(LETTER_TO_TOOL, {
    p: "pan", v: "select", a: "area", r: "rect", l: "linear", q: "curve",
    s: "surface", c: "count", d: "deduct", o: "oneclick", w: "walltrace",
    u: "wallarea", k: "check", h: "highlighter",
  });
  assert.deepEqual(SHIFT_LETTER_TO_TOOL, { D: "deduct-rect", Q: "deduct-curve" });
  for (const [letter, id] of Object.entries(LETTER_TO_TOOL)) {
    assert.equal(TOOL_SPEC[id].shortcut?.toLowerCase(), letter);
  }
  assert.equal(TOOL_SPEC["deduct-rect"].shortcut, "⇧D");
  assert.equal(TOOL_SPEC["deduct-curve"].shortcut, "⇧Q");
  assert.equal(TOOL_SPEC.gallery.shortcut, "G");
  assert.equal(TOOL_SPEC.gallery.creates, "none");
});

test("finish gates: area/deduct/zone need 3; linear family needs 2; zoneCross blocks", () => {
  for (const tool of ["area", "deduct", "zone"]) {
    assert.equal(canFinishDraw(tool, 2), false, `${tool} @ 2`);
    assert.equal(canFinishDraw(tool, 3), true, `${tool} @ 3`);
  }
  assert.equal(canFinishDraw("zone", 3, { zoneCross: true }), false);
  for (const tool of ["linear", "surface", "wallarea", "curve", "deduct-curve"]) {
    assert.equal(canFinishDraw(tool, 1), false, `${tool} @ 1`);
    assert.equal(canFinishDraw(tool, 2), true, `${tool} @ 2`);
  }
  for (const tool of ["rect", "deduct-rect", "count", "oneclick", "walltrace", "select", "pan", "calibrate", "check", "stamp", "schedule"]) {
    assert.equal(canFinishDraw(tool, 9), false, `${tool} is not an Enter-finish poly`);
  }
  assert.equal(TOOL_SPEC.count.clickCommit, "point");
  assert.equal(TOOL_SPEC.count.commitVerts, 1);
  assert.equal(TOOL_SPEC.rect.clickCommit, "two-corner");
  assert.equal(TOOL_SPEC.rect.commitVerts, 4);
  assert.equal(TOOL_SPEC["deduct-rect"].commitVerts, 4);
});

test("commit → Layers: every shape tool mints the expected kind; paint follows the condition", () => {
  const cases: Array<[string, number[][], string, string, { carve?: boolean }?]> = [
    ["area", TRI, "floor_area", "area"],
    ["rect", RECT4, "floor_area", "area"],
    ["oneclick", TRI, "floor_area", "area"],
    ["oneclick", TRI, "deduct", "area", { carve: true }],
    ["deduct", TRI, "deduct", "area"],
    ["deduct-rect", RECT4, "deduct", "area"],
    ["deduct-curve", TRI, "deduct", "area"],
    ["linear", LINE, "linear", "line"],
    ["curve", LINE, "linear", "line"],
    ["surface", LINE, "surface_area", "line"],
    ["wallarea", LINE, "surface_area", "line"],
    ["walltrace", TRI, "wall_area", "area"],
    ["count", POINT, "count", "count"],
  ];
  for (const [tool, verts, role, kind, opts] of cases) {
    const node = leafKind(tool, verts, opts);
    const shape = draftShapeFromTool(tool, verts, opts);
    assert.equal(shape!.measure_role, role, `${tool} role`);
    assert.equal(kindFromRole(role), kind, `${tool} kindFromRole`);
    assert.equal(node.kind, kind, `${tool} leaf kind`);
    assert.equal(node.color, "#ff00ff", `${tool} paint follows condition colour`);
  }
});

test("Wall Area (U) is a line / surface_area; Wall Trace (W) is an area / wall_area", () => {
  assert.equal(TOOL_SPEC.wallarea.measure_role, "surface_area");
  assert.equal(TOOL_SPEC.wallarea.layerKind, "line");
  assert.equal(TOOL_SPEC.walltrace.measure_role, "wall_area");
  assert.equal(TOOL_SPEC.walltrace.layerKind, "area");
  assert.equal(TOOL_SPEC.curve.curved, true);
  const curved = draftShapeFromTool("curve", LINE);
  assert.equal(curved!.curved, true);
});

test("count skips scale; wall tools need height; proposals wait for Create", () => {
  assert.equal(TOOL_SPEC.count.needsScale, false);
  assert.equal(TOOL_SPEC.count.needsCondition, true);
  for (const id of ["wallarea", "surface", "walltrace"]) {
    assert.equal(TOOL_SPEC[id].needsHeight, true, id);
  }
  assert.equal(TOOL_SPEC.oneclick.proposalThenCreate, true);
  assert.equal(TOOL_SPEC.walltrace.proposalThenCreate, true);
  assert.equal(TOOL_SPEC.area.proposalThenCreate, false);
});

test("markup and stamp never create a Layers leaf", () => {
  for (const id of [...MARKUP_TOOLS.map((t) => t.id), "stamp"]) {
    assert.equal(TOOL_SPEC[id].creates, "markup", id);
    assert.equal(createsLayerLeaf(id), false, id);
  }
  assert.deepEqual(MARKUP_IDS.sort(), ["callout", "cloud", "highlight", "highlighter", "stamp", "text"]);
});

test("select, pan, calibrate, check, gallery, schedule, zone mint no takeoff", () => {
  for (const id of ["select", "pan", "calibrate", "check", "gallery"]) {
    assert.equal(TOOL_SPEC[id].creates, "none", id);
    assert.equal(createsLayerLeaf(id), false, id);
  }
  assert.equal(TOOL_SPEC.schedule.creates, "none");
  assert.equal(TOOL_SPEC.schedule.returnsToSelect, true);
  assert.equal(TOOL_SPEC.schedule.clickCommit, "two-corner");
  assert.equal(TOOL_SPEC.schedule.unreachable, true);
  assert.equal(TOOL_SPEC.zone.creates, "ephemeral");
  assert.equal(TOOL_SPEC.zone.unreachable, true);
  assert.equal(createsLayerLeaf("zone"), false);
});

test("every shape tool in the catalog drafts a layer leaf", () => {
  assert.ok(SHAPE_TOOLS.length >= 12);
  for (const id of SHAPE_TOOLS) {
    const spec = TOOL_SPEC[id];
    const verts = spec.commitVerts === 1 ? POINT : spec.commitVerts === 4 ? RECT4 : spec.minPts === 2 ? LINE : TRI;
    const node = leafKind(id, verts);
    assert.equal(node.kind, spec.layerKind, id);
  }
});

test("TakeoffCanvas imports the letter map and canFinishDraw", async () => {
  const src = await readFile(join(here, "../src/pages/TakeoffCanvas.jsx"), "utf8");
  assert.match(src, /import \{ LETTER_TO_TOOL, SHIFT_LETTER_TO_TOOL, canFinishDraw \} from "\.\.\/lib\/canvasTools\.js"/);
  assert.match(src, /SHIFT_LETTER_TO_TOOL\[e\.key\]/);
  assert.match(src, /LETTER_TO_TOOL\[lower\]/);
  assert.match(src, /canFinishDraw\(tool, poly\.length, \{ zoneCross: zoneTraceCross \}\)/);
  assert.doesNotMatch(src, /const map = \{ p: "pan"/);
});

test("TakeoffCanvas finishShape routes each poly tool without dispatching zone", async () => {
  const src = await readFile(join(here, "../src/pages/TakeoffCanvas.jsx"), "utf8");
  const start = src.indexOf("function finishShape()");
  assert.ok(start >= 0, "finishShape missing");
  const end = src.indexOf("function deleteSelected()", start);
  const body = src.slice(start, end > start ? end : start + 2500);
  assert.match(body, /if \(tool === "zone"\)/);
  assert.doesNotMatch(body.slice(0, body.indexOf("commitSurface")), /dispatchShape/);
  assert.match(body, /if \(tool === "surface" \|\| tool === "wallarea"\) commitSurface\(poly\)/);
  assert.match(body, /else if \(tool === "linear"\) commitLinear\(poly\)/);
  assert.match(body, /else if \(tool === "curve"\) commitLinear\(poly, true\)/);
  assert.match(body, /else if \(tool === "deduct-curve"\)/);
  assert.match(body, /flattenCurve\(poly\)/);
  assert.match(body, /if \(flat\.length >= 3\) commitPoly\(flat, true\)/);
  assert.match(body, /else commitPoly\(poly, tool === "deduct"\)/);
  assert.equal(TOOL_SPEC["deduct-curve"].minPts, 2);
  assert.equal(TOOL_SPEC["deduct-curve"].commitMinPts, 3);
});

test("TakeoffCanvas commit bodies stamp the catalog measure_role and gates", async () => {
  const src = await readFile(canvasPath, "utf8");

  const poly = fnBody(src, "commitPoly");
  assert.match(poly, /measure_role: asDeduct \? "deduct" : "floor_area"/);
  assert.match(poly, /if \(!upp\)/);
  assert.match(poly, /if \(!activeCond\)/);

  const linear = fnBody(src, "commitLinear");
  assert.match(linear, /measure_role: "linear"/);
  assert.match(linear, /if \(!upp\)/);
  assert.match(linear, /if \(!activeCond\)/);
  assert.match(linear, /\.\.\.\(curved \? \{ curved: true \} : \{\}\)/);

  const surface = fnBody(src, "commitSurface");
  assert.match(surface, /measure_role: "surface_area"/);
  assert.match(surface, /if \(!upp\)/);
  assert.match(surface, /if \(!activeCond\)/);
  assert.match(surface, /if \(!\(h > 0\)\)/);

  const count = fnBody(src, "commitCount");
  assert.match(count, /measure_role: "count"/);
  assert.match(count, /if \(!activeCond\)/);
  assert.doesNotMatch(count, /if \(!upp\)/);

  const wall = fnBody(src, "commitWallTrace");
  assert.match(wall, /measure_role: "wall_area"/);

  const traceAt = fnBody(src, "wallTraceAt");
  assert.match(traceAt, /if \(!upp\)/);
  assert.match(traceAt, /if \(!activeCond\)/);
  assert.match(traceAt, /if \(!\(h > 0\)\)/);
});

test("TakeoffCanvas performClick routes count, rect, markup, stamp — not highlighter", async () => {
  const src = await readFile(canvasPath, "utf8");
  const body = fnBody(src, "performClick");
  assert.match(body, /tool === "count"\) commitCount\(p\)/);
  assert.match(body, /tool === "rect" \|\| tool === "deduct-rect"/);
  assert.match(body, /commitPoly\(\[\[a\[0\], a\[1\]\], \[p\[0\], a\[1\]\], \[p\[0\], p\[1\]\], \[a\[0\], p\[1\]\]\], tool === "deduct-rect"\)/);
  assert.match(body, /tool === "cloud" \|\| tool === "callout" \|\| tool === "text" \|\| tool === "highlight"\) placeMarkup\(p\)/);
  assert.match(body, /tool === "stamp"\) placeStamp\(p\)/);
  assert.doesNotMatch(body, /highlighter/);
});

test("zone and schedule stay unreachable leftover paths", async () => {
  const src = await readFile(canvasPath, "utf8");
  assert.doesNotMatch(src, /setTool\("zone"\)/);
  assert.doesNotMatch(src, /setTool\("schedule"\)/);
  assert.equal(TOOL_SPEC.zone.unreachable, true);
  assert.equal(TOOL_SPEC.schedule.unreachable, true);
});

test("gallery G is a view switch, not a LETTER_TO_TOOL entry", async () => {
  const src = await readFile(canvasPath, "utf8");
  assert.match(src, /if \(lower === "g"\)/);
  assert.equal(LETTER_TO_TOOL.g, undefined);
  assert.equal(TOOL_SPEC.gallery.shortcut, "G");
});

test("USER_GUIDE §15 lists every letter and shift-cut shortcut", async () => {
  const guide = await readFile(guidePath, "utf8");
  const start = guide.indexOf("### Tools");
  const end = guide.indexOf("### Conditions", start);
  assert.ok(start >= 0 && end > start, "USER_GUIDE Tools table missing");
  const table = guide.slice(start, end);
  for (const letter of Object.keys(LETTER_TO_TOOL)) {
    const cell = `| \`${letter.toUpperCase()}\` |`;
    assert.ok(table.includes(cell), `USER_GUIDE Tools table missing ${cell}`);
  }
  for (const key of Object.keys(SHIFT_LETTER_TO_TOOL)) {
    const cell = `| \`⇧${key}\` |`;
    assert.ok(table.includes(cell), `USER_GUIDE Tools table missing ${cell}`);
  }
  assert.ok(table.includes("| `G` |"), "USER_GUIDE Tools table missing G");
});
