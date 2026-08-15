import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLayerTree,
  descendantShapeIds,
  groupSelection,
  isDescendant,
  liftSelection,
  layerPaintColor,
  kindFromRole,
  moveNodes,
  parentOf,
  shapeIdsUnder,
  shapeMetric,
  summariseNodes,
  topMostIds,
  ungroupNodes,
  sanitizeLayerIdMap,
  collectIdsForLayerToggle,
  layerPersistSlice,
  activeLayerPickIds,
  shapeIdsOnFocusSheet,
  picksForPrimarySelect,
  isHiddenId,
  isLockedId,
  sanitizeForest,
  sheetNodeId,
  togglePickIds,
  rangePickIds,
  isolateOtherIds,
  isIsolatedTo,
} from "../src/lib/layerTree.js";

const shapes = [
  { id: "a", sheet_id: "s1", condition_id: "c1", measure_role: "linear", computed: { perimeter_lf: 5 } },
  { id: "b", sheet_id: "s1", condition_id: "c1", measure_role: "linear", computed: { perimeter_lf: 4 } },
  { id: "c", sheet_id: "s1", condition_id: "c1", measure_role: "count", computed: { count: 2 } },
  { id: "d", sheet_id: "s1", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 10 } },
];
const byId = new Map(shapes.map((s) => [s.id, s]));

test("kindFromRole maps takeoff roles onto panel kinds", () => {
  assert.equal(kindFromRole("linear"), "line");
  assert.equal(kindFromRole("surface_area"), "line");
  assert.equal(kindFromRole("count"), "count");
  assert.equal(kindFromRole("floor_area"), "area");
  assert.equal(kindFromRole("deduct"), "area");
});

test("shapeMetric uses display units and count", () => {
  assert.equal(shapeMetric({ measure_role: "count", computed: { count: 6 } }), "6 ea");
  assert.equal(shapeMetric({ measure_role: "linear", computed: { perimeter_lf: 5 } }), "5 LF");
  assert.match(shapeMetric({ measure_role: "floor_area", computed: { area_sf: 18.4 } }, "metric"), /m²/);
});

test("buildLayerTree puts grouped shapes under the group and leaves the rest at the root", () => {
  const tree = buildLayerTree({
    sheetKeys: ["s1"],
    shapes,
    layerGroups: { g1: { id: "g1", label: "Walls", sheetKey: "s1", shapeIds: ["a", "b"] } },
    condById: { c1: { finish_tag: "CPT-1", color: "#f00" } },
  });
  assert.equal(tree.length, 3);
  assert.equal(tree[0].kind, "group");
  assert.equal(tree[0].name, "Walls");
  assert.deepEqual(tree[0].children.map((n) => n.id), ["a", "b"]);
  assert.equal(tree[0].color, "#f00");
  assert.equal(tree[0].children[0].color, "#f00");
  assert.match(tree[0].metric, /9 LF/);
});

test("layer paint colour follows appearance, then condition, then kind", () => {
  const byCond = buildLayerTree({
    sheetKeys: ["s1"],
    shapes: [shapes[0]],
    condById: { c1: { finish_tag: "CPT-1", color: "#ff00ff" } },
  });
  assert.equal(byCond[0].color, "#ff00ff");
  const byLook = buildLayerTree({
    sheetKeys: ["s1"],
    shapes: [{ ...shapes[0], appearance_override: true, color: "#00aa44" }],
    condById: { c1: { finish_tag: "CPT-1", color: "#ff00ff" } },
  });
  assert.equal(byLook[0].color, "#00aa44");
  const byKind = buildLayerTree({
    sheetKeys: ["s1"],
    shapes: [shapes[0]],
    condById: { c1: { finish_tag: "CPT-1" } },
  });
  assert.equal(byKind[0].color, "#a0402a");
  assert.equal(layerPaintColor(shapes[0], { c1: { color: "#abc" } }), "#abc");
});

test("folder paint colour is unanimous child paint, else the folder fallback", () => {
  const mixed = buildLayerTree({
    sheetKeys: ["s1"],
    shapes: [
      { ...shapes[0], appearance_override: true, color: "#111111" },
      { ...shapes[1], appearance_override: true, color: "#eeeeee" },
    ],
    layerGroups: { g1: { id: "g1", label: "Walls", sheetKey: "s1", shapeIds: ["a", "b"] } },
    condById: { c1: { finish_tag: "CPT-1", color: "#f00" } },
  });
  assert.equal(mixed[0].color, "#1a5276");
  assert.equal(mixed[0].children[0].color, "#111111");
  assert.equal(mixed[0].children[1].color, "#eeeeee");
});

test("multi-sheet wrap uses sheet folders; shapeIdsUnder walks them", () => {
  const tree = buildLayerTree({
    sheetKeys: ["A", "B"],
    sheetLabel: (k) => `Sheet ${k}`,
    shapes: [
      { id: "a", sheet_id: "A", measure_role: "linear", computed: { perimeter_lf: 1 } },
      { id: "b", sheet_id: "B", measure_role: "count", computed: { count: 3 } },
    ],
  });
  assert.equal(tree.length, 2);
  assert.equal(tree[0].id, "sheet::A");
  assert.deepEqual(shapeIdsUnder(tree[0]), ["a"]);
  assert.deepEqual(shapeIdsUnder(tree[1]), ["b"]);
});

test("summariseNodes adds mixed units the way a group row should", () => {
  const s = summariseNodes([
    { kind: "line", metric: "5 LF" },
    { kind: "line", metric: "4 LF" },
    { kind: "count", metric: "2 ea" },
  ]);
  assert.match(s, /9 LF/);
  assert.match(s, /2 ea/);
});

test("groupSelection wraps top-most ids in a new group without flattening", () => {
  const inner = groupSelection({}, ["a", "b"], { newId: "g1", name: "Walls", sheetKey: "s1" });
  assert.deepEqual(inner.g1.children, ["a", "b"]);
  const nested = groupSelection(inner, ["g1", "c"], { newId: "g2", name: "Zone", sheetKey: "s1" });
  assert.deepEqual(nested.g2.children, ["g1", "c"]);
  assert.deepEqual(nested.g1.children, ["a", "b"]);
  assert.equal(parentOf(nested, "g1"), "g2");
  assert.deepEqual(descendantShapeIds(nested, "g2"), ["a", "b", "c"]);
});

test("liftSelection prefers a fully selected group over its leaves", () => {
  const forest = {
    g1: { id: "g1", name: "G", sheetKey: "s1", children: ["a", "b"] },
  };
  assert.deepEqual(liftSelection(forest, ["a", "b"]), ["g1"]);
  assert.deepEqual(liftSelection(forest, ["a", "c"]).sort(), ["a", "c"]);
});

test("ungroupNodes splices children into the parent and deletes the group", () => {
  let forest = groupSelection({}, ["a", "b"], { newId: "g1", name: "Walls", sheetKey: "s1" });
  forest = groupSelection(forest, ["g1", "c"], { newId: "g2", name: "Zone", sheetKey: "s1" });
  const after = ungroupNodes(forest, ["g1"]);
  assert.equal(after.g1, undefined);
  assert.ok(after.g2.children.includes("a"));
  assert.ok(after.g2.children.includes("b"));
  assert.ok(after.g2.children.includes("c"));
});

test("moveNodes drops a group into another group without exploding leaves", () => {
  let forest = groupSelection({}, ["a", "b"], { newId: "gB", name: "B", sheetKey: "s1" });
  forest = groupSelection(forest, ["c", "d"], { newId: "gA", name: "A", sheetKey: "s1" });
  const moved = moveNodes(forest, ["gB"], "gA", 0, { shapeById: byId });
  assert.ok(moved.gA.children.includes("gB"));
  assert.deepEqual(moved.gB.children, ["a", "b"]);
  assert.equal(moved.gA.children.includes("a"), false);
});

test("moveNodes refuses a drop into self or a descendant", () => {
  let forest = groupSelection({}, ["a", "b"], { newId: "g1", name: "Inner", sheetKey: "s1" });
  forest = groupSelection(forest, ["g1", "c"], { newId: "g2", name: "Outer", sheetKey: "s1" });
  assert.equal(moveNodes(forest, ["g2"], "g1", 0), forest);
  assert.equal(isDescendant(forest, "g2", "g1"), true);
});

test("nested buildLayerTree keeps group-in-group and summed metrics", () => {
  const forest = {
    g1: { id: "g1", name: "Walls", sheetKey: "s1", children: ["a", "b"] },
    g2: { id: "g2", name: "Zone", sheetKey: "s1", children: ["g1", "c"] },
  };
  const tree = buildLayerTree({ sheetKeys: ["s1"], shapes, layerForest: forest });
  const zone = tree.find((n) => n.id === "g2");
  assert.equal(zone.children[0].id, "g1");
  assert.deepEqual(shapeIdsUnder(zone), ["a", "b", "c"]);
  assert.match(zone.metric, /9 LF/);
  assert.match(zone.metric, /2 ea/);
});

test("a locked ancestor group marks descendant leaves locked", () => {
  const forest = {
    g1: { id: "g1", name: "Walls", sheetKey: "s1", children: ["a", "b"], locked: true },
  };
  const tree = buildLayerTree({ sheetKeys: ["s1"], shapes, layerForest: forest });
  const g = tree.find((n) => n.id === "g1");
  assert.equal(g.locked, true);
  assert.equal(g.children[0].locked, true);
  assert.equal(g.children[1].locked, true);
});

test("sanitizeLayerIdMap else-clears and drops stale ids", () => {
  const live = new Set(["a", "b"]);
  assert.deepEqual(sanitizeLayerIdMap(undefined, live), {});
  assert.deepEqual(sanitizeLayerIdMap(["a"], live), {});
  assert.deepEqual(sanitizeLayerIdMap("a", live), {});
  assert.deepEqual(sanitizeLayerIdMap({ a: true, gone: true, b: false }, live), { a: true });
});

test("sanitizeLayerIdMap keeps sheet folder flags", () => {
  const live = new Set(["a"]);
  assert.deepEqual(
    sanitizeLayerIdMap({ a: true, "sheet::A": true, gone: true }, live),
    { a: true, "sheet::A": true },
  );
});

test("collectIdsForLayerToggle expands a sheet folder to live shapes on that sheet", () => {
  const got = collectIdsForLayerToggle(["sheet::A"], {
    forest: {},
    shapes: [
      { id: "a", sheet_id: "A" },
      { id: "b", sheet_id: "B" },
    ],
  });
  assert.deepEqual(got.sheetIds, ["sheet::A"]);
  assert.deepEqual(got.shapeIds, ["a"]);
  assert.deepEqual(got.groupIds, []);
});

test("empty sheet folders still hide from the sheet:: flag", () => {
  const tree = buildLayerTree({
    sheetKeys: ["A", "B"],
    hiddenShapeIds: { "sheet::A": true },
  });
  assert.equal(tree[0].hidden, true);
  assert.equal(tree[1].hidden, false);
  assert.equal(isHiddenId("a", { hiddenShapeIds: { "sheet::A": true }, sheetId: "A" }), true);
  assert.equal(isHiddenId("b", { hiddenShapeIds: { "sheet::A": true }, sheetId: "B" }), false);
  assert.equal(sheetNodeId("A"), "sheet::A");
});

test("isLockedId follows a sheet folder flag", () => {
  assert.equal(isLockedId("a", { lockedShapeIds: { "sheet::s1": true }, sheetId: "s1" }), true);
  assert.equal(isLockedId("a", { lockedShapeIds: { "sheet::s1": true }, sheetId: "s2" }), false);
});

test("layerPersistSlice omits empty maps and keeps additive keys", () => {
  assert.deepEqual(layerPersistSlice({}), {});
  assert.deepEqual(layerPersistSlice({ layerForest: {}, hiddenShapeIds: {}, lockedShapeIds: {} }), {});
  const forest = { g1: { id: "g1", children: ["a"] } };
  const slice = layerPersistSlice({
    layerForest: forest,
    hiddenShapeIds: { a: true },
    lockedShapeIds: { b: true },
  });
  assert.equal(slice.layer_tree, forest);
  assert.deepEqual(slice.layer_hidden, { a: true });
  assert.deepEqual(slice.layer_locked, { b: true });
});

test("activeLayerPickIds drops stale picks when nothing is selected", () => {
  assert.deepEqual(activeLayerPickIds(null, { a: true }), {});
  assert.deepEqual(activeLayerPickIds("", { a: true }), {});
  assert.deepEqual(activeLayerPickIds("a", { a: true, b: true }), { a: true, b: true });
  assert.deepEqual(activeLayerPickIds("a", null), {});
});

test("groupSelection with shapeById refuses mixed sheets and still nests same-sheet", () => {
  const mixed = new Map([
    ["a", { id: "a", sheet_id: "s1" }],
    ["x", { id: "x", sheet_id: "s2" }],
  ]);
  const forest = {};
  assert.equal(groupSelection(forest, ["a", "x"], { newId: "g1", name: "Bad", sheetKey: "s1", shapeById: mixed }), forest);
  const same = groupSelection(forest, ["a", "b"], { newId: "g1", name: "Walls", sheetKey: "s1", shapeById: byId });
  assert.deepEqual(same.g1.children, ["a", "b"]);
  const nested = groupSelection(same, ["g1", "c"], { newId: "g2", name: "Zone", sheetKey: "s1", shapeById: byId });
  assert.deepEqual(nested.g2.children, ["g1", "c"]);
  assert.deepEqual(nested.g1.children, ["a", "b"]);
});

test("shapeIdsOnFocusSheet is the focused sheet only", () => {
  const list = [
    { id: "a", sheet_id: "s1" },
    { id: "b", sheet_id: "s2" },
  ];
  assert.deepEqual(shapeIdsOnFocusSheet(list, "s1"), ["a"]);
  assert.deepEqual(shapeIdsOnFocusSheet(list, null, undefined, ["s2"]), ["b"]);
});

test("TakeoffCanvas autosave deps include the layer persist keys", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(here, "../src/pages/TakeoffCanvas.jsx"), "utf8");
  const marker = "buildPayload is intentionally omitted";
  const at = src.indexOf(marker);
  assert.ok(at >= 0, "autosave effect comment missing");
  const deps = src.slice(at, at + 1200);
  assert.match(deps, /layerForest/);
  assert.match(deps, /hiddenShapeIds/);
  assert.match(deps, /lockedShapeIds/);
});

test("picksForPrimarySelect keeps a multi-pick or retargets to one id", () => {
  assert.deepEqual(picksForPrimarySelect(null, { a: true }), {});
  assert.deepEqual(picksForPrimarySelect("c", { a: true, b: true }), { c: true });
  const multi = { a: true, b: true };
  assert.equal(picksForPrimarySelect("a", multi), multi);
  assert.deepEqual(picksForPrimarySelect("a", null), { a: true });
});

test("togglePickIds adds a row or drops it when already fully picked", () => {
  assert.deepEqual(togglePickIds(["a"], ["b"]), ["a", "b"]);
  assert.deepEqual(togglePickIds(["a", "b"], ["b"]), ["a"]);
  assert.deepEqual(togglePickIds(["a", "b"], ["a", "b"]), []);
  assert.deepEqual(togglePickIds(null, ["a"]), ["a"]);
});

test("rangePickIds covers visible rows between two clicks", () => {
  const rows = [["a"], ["b"], ["c", "d"], ["e"]];
  assert.deepEqual(rangePickIds(rows, 0, 2), ["a", "b", "c", "d"]);
  assert.deepEqual(rangePickIds(rows, 3, 1), ["b", "c", "d", "e"]);
  assert.deepEqual(rangePickIds(rows, -1, 0), ["a"]);
});

test("isolateOtherIds / isIsolatedTo match Alt-click eye solo", () => {
  assert.deepEqual(isolateOtherIds(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.equal(isIsolatedTo(["a", "b", "c"], ["b"], { a: true, c: true }), true);
  assert.equal(isIsolatedTo(["a", "b", "c"], ["b"], { a: true }), false);
});

test("groupSelection returns a new object when it groups", () => {
  const forest = {};
  const next = groupSelection(forest, ["a", "b"], { newId: "g1", name: "Walls", sheetKey: "s1", shapeById: byId });
  assert.notEqual(next, forest);
  assert.deepEqual(next.g1.children, ["a", "b"]);
});

test("sanitizeForest drops stale children on hydrate; tombstones reappear when the shape is live", () => {
  const forest = { g1: { id: "g1", name: "Walls", sheetKey: "s1", children: ["a", "gone"] } };
  const pruned = sanitizeForest(forest, ["a"]);
  assert.deepEqual(pruned.g1.children, ["a"]);
  const missing = { g1: { id: "g1", name: "Walls", sheetKey: "s1", children: ["a", "b"] } };
  const withoutB = buildLayerTree({ sheetKeys: ["s1"], shapes: [shapes[0]], layerForest: missing });
  const g = withoutB.find((n) => n.id === "g1");
  assert.deepEqual(g.children.map((n) => n.id), ["a"]);
  const withB = buildLayerTree({ sheetKeys: ["s1"], shapes: [shapes[0], shapes[1]], layerForest: missing });
  assert.deepEqual(withB.find((n) => n.id === "g1").children.map((n) => n.id), ["a", "b"]);
});

test("isLockedId follows the leaf map and ancestor group.locked", () => {
  const forest = { g1: { id: "g1", name: "Walls", sheetKey: "s1", children: ["a", "b"], locked: true } };
  assert.equal(isLockedId("a", { lockedShapeIds: {}, forest }), true);
  assert.equal(isLockedId("c", { lockedShapeIds: { c: true }, forest: {} }), true);
  assert.equal(isLockedId("c", { lockedShapeIds: {}, forest }), false);
  assert.equal(isLockedId(null, { lockedShapeIds: { a: true }, forest }), false);
});
