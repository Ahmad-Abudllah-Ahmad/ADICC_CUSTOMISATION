import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSummaryTree,
  resolveFloorLevel,
  categorizeMeasureRole,
  compareFloorLevels,
} from "../src/lib/summaryTree.js";

test("resolveFloorLevel resolves level from sheetLevels map or fallback", () => {
  const levels = { "A101.pdf": "Ground Floor", "A102.pdf": "1st Floor" };
  assert.equal(resolveFloorLevel("A101.pdf", levels), "Ground Floor");
  assert.equal(resolveFloorLevel("A102.pdf", levels), "1st Floor");
  assert.equal(resolveFloorLevel("drawings/A101.pdf", levels), "Ground Floor");
  assert.equal(resolveFloorLevel("unknown.pdf", {}), "unknown.pdf");
});

test("compareFloorLevels sorts floors logically", () => {
  const floors = ["2nd Floor", "Ground Floor", "Basement", "1st Floor", "10th Floor", "Roof"];
  const sorted = floors.sort(compareFloorLevels);
  assert.deepEqual(sorted, ["Basement", "Ground Floor", "1st Floor", "2nd Floor", "10th Floor", "Roof"]);
});

test("categorizeMeasureRole maps roles correctly", () => {
  assert.equal(categorizeMeasureRole("floor_area").key, "floor");
  assert.equal(categorizeMeasureRole("surface_area").key, "wall");
  assert.equal(categorizeMeasureRole("wall_area").key, "wall");
  assert.equal(categorizeMeasureRole("linear").key, "linear");
  assert.equal(categorizeMeasureRole("count").key, "count");
});

test("buildSummaryTree builds 3-level hierarchy: Floor → Item Type → Item Code", () => {
  const conditions = [
    { id: "c1", finish_tag: "F1", name: "Porcelain Tile", color: "#1f6b4a" },
    { id: "c2", finish_tag: "W1", name: "Emulsion Paint", color: "#1f3fc7" },
    { id: "c3", finish_tag: "SK1", name: "Skirting", color: "#b8860b" },
  ];

  const shapes = [
    { id: "s1", sheet_id: "sheet1.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 120 } },
    { id: "s2", sheet_id: "sheet1.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 80 } },
    { id: "s3", sheet_id: "sheet1.pdf", condition_id: "c2", measure_role: "surface_area", computed: { wall_face_sf: 300 } },
    { id: "s4", sheet_id: "sheet1.pdf", condition_id: "c3", measure_role: "linear", computed: { perimeter_lf: 50 } },
    { id: "s5", sheet_id: "sheet2.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 250 } },
  ];

  const sheetLevels = {
    "sheet1.pdf": "Ground Floor",
    "sheet2.pdf": "1st Floor",
  };

  const tree = buildSummaryTree({
    shapes,
    conditions,
    sheetLevels,
    units: "imperial",
  });

  assert.equal(tree.length, 2); // Ground Floor, 1st Floor
  assert.equal(tree[0].level, "Ground Floor");
  assert.equal(tree[0].shapes_count, 4);
  assert.equal(tree[1].level, "1st Floor");
  assert.equal(tree[1].shapes_count, 1);

  // Check categories on Ground Floor
  const gfTypes = tree[0].children;
  assert.equal(gfTypes.length, 3); // floor, wall, linear
  assert.equal(gfTypes[0].typeKey, "floor");
  assert.equal(gfTypes[0].total_qty, 200); // 120 + 80
  assert.equal(gfTypes[1].typeKey, "wall");
  assert.equal(gfTypes[1].total_qty, 300);
  assert.equal(gfTypes[2].typeKey, "linear");
  assert.equal(gfTypes[2].total_qty, 50);

  // Check code level
  const floorCodes = gfTypes[0].children;
  assert.equal(floorCodes.length, 1);
  assert.equal(floorCodes[0].code, "F1");
  assert.equal(floorCodes[0].total_qty, 200);
  assert.equal(floorCodes[0].shapes.length, 2);
});

test("buildSummaryTree tracks hidden status and indeterminate states", () => {
  const conditions = [{ id: "c1", finish_tag: "F1", color: "#1f6b4a" }];
  const shapes = [
    { id: "s1", sheet_id: "s.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 100 } },
    { id: "s2", sheet_id: "s.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 100 } },
  ];

  // When s1 is hidden and s2 is visible
  const treePartial = buildSummaryTree({
    shapes,
    conditions,
    hiddenShapeIds: { s1: true },
  });
  assert.equal(treePartial[0].hidden, false);
  assert.equal(treePartial[0].indeterminate, true);
  assert.equal(treePartial[0].children[0].children[0].hidden, false);
  assert.equal(treePartial[0].children[0].children[0].indeterminate, true);

  // When all are hidden
  const treeAllHidden = buildSummaryTree({
    shapes,
    conditions,
    hiddenShapeIds: { s1: true, s2: true },
  });
  assert.equal(treeAllHidden[0].hidden, true);
  assert.equal(treeAllHidden[0].indeterminate, false);
});
