// Schedule knowledge-base: filename classify + door/finish parsers + tag lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySheetByName,
  normalizeSymbolTag,
  tagLookupKeys,
  parseDoorScheduleTokens,
  parseFinishScheduleTokens,
  parseSteelDoorFrameSchedule,
  parseElevationTypeTables,
  extractScheduleKbFromSheet,
  buildScheduleKb,
  lookupScheduleKb,
} from "../src/lib/symbolScheduleKb.ts";
import { enrichSymbolsWithSchedule, buildPlanSymbolIndex, resolveSymbolFields } from "../src/lib/planSymbols.ts";

test("classifySheetByName: doors / finishes / windows / detail", () => {
  assert.equal(classifySheetByName("A7101-WOODEN DOORS (SHEET 1 OF5).pdf"), "door_schedule");
  assert.equal(classifySheetByName("A0002-FINISHES SCHEDUALE.pdf"), "finish_schedule");
  assert.equal(classifySheetByName("A7201-ALUMINUM WINDOWS DETAILS.pdf"), "window_schedule");
  assert.equal(classifySheetByName("A7202-CURTAIN WALL SCHEDULE.pdf"), "window_schedule");
  assert.equal(classifySheetByName("A4106-STAIRCASE 04 DETAILS.pdf"), "detail");
  assert.equal(classifySheetByName("A7106-WOODEN DOORS JAMB DETAILS.pdf"), "detail");
  assert.equal(classifySheetByName("A1105-1st FLOOR PLAN.pdf"), "other");
  // Folder path must not force DETAIL class — classify basename only in extractors
  assert.equal(classifySheetByName("DETAILS/A7101-WOODEN DOORS.pdf"), "door_schedule");
  // Detail sheet must NOT become door_schedule just because page text says "DOOR"
  assert.equal(
    classifySheetByName("A5601-GARBAGE DETAIL.pdf", "HOPPER DOOR D03 FIRE RATED"),
    "detail",
  );
});

test("buildScheduleKb prefers wooden-doors sheet over garbage-detail stub", () => {
  const kb = buildScheduleKb([
    {
      tag: "D03",
      kind: "door",
      description: "Door D03 — see A5601-GARBAGE DETAIL",
      type: "Door D03",
      source_sheet: "A5601-GARBAGE DETAIL.pdf",
      source_title: "A5601-GARBAGE DETAIL",
      source_bbox: { x: 0, y: 0, w: 10, h: 10 },
    },
    {
      tag: "D03",
      kind: "door",
      room_name: "GARBAGE ROOM",
      description: "Wooden Door D03 — W 800 × H 2200 mm — Fire rating 60 MIN",
      size: "W 800 × H 2200 mm",
      fire_rating: "60 MIN",
      floors: "1ST FLOOR; 2ND TO 25TH FLOOR",
      type: "Wooden Door D03",
      source_sheet: "A7101-WOODEN DOORS.pdf",
      source_title: "A7101-WOODEN DOORS (SHEET 1 OF5)",
      source_bbox: { x: 10, y: 20, w: 100, h: 200 },
    },
  ]);
  const hit = lookupScheduleKb(kb, "D03");
  assert.ok(hit);
  assert.equal(hit.room_name, "GARBAGE ROOM");
  assert.ok(hit.source_title.includes("WOODEN DOORS"));
  assert.equal(hit.fire_rating, "60 MIN");
});

test("normalizeSymbolTag: D-1 / D1 / D01 unify", () => {
  assert.equal(normalizeSymbolTag("D-1"), "D01");
  assert.equal(normalizeSymbolTag("D1"), "D01");
  assert.equal(normalizeSymbolTag("D01"), "D01");
  assert.equal(normalizeSymbolTag("SD12"), "SD12");
  assert.equal(normalizeSymbolTag("$D12"), "SD12");
  assert.equal(normalizeSymbolTag("CW01"), "CW-01");
  assert.equal(normalizeSymbolTag("GD-2"), "GD-02");
  assert.equal(normalizeSymbolTag("LV1"), "LV-01");
});

test("tagLookupKeys includes dashed variants", () => {
  const keys = tagLookupKeys("D01");
  assert.ok(keys.includes("D01"));
  assert.ok(keys.includes("D-1"));
  assert.ok(keys.includes("D1"));
});

test("parseDoorScheduleTokens: Wooden Door Schedule _ D-7 card (A7102 layout)", () => {
  const tokens = [
    { str: "Wooden Door Schedule _ D-7", x: 1118, y: 2745, h: 12 },
    { str: "FLOOR", x: 741, y: 2808, h: 10 },
    { str: "1ST FLOOR", x: 741, y: 2861, h: 10 },
    { str: "26TH FLOOR", x: 741, y: 2888, h: 10 },
    { str: "ROOM", x: 1216, y: 2808, h: 10 },
    { str: "KIDS AREA, MPU & LOUNGE", x: 1139, y: 2860, h: 10 },
    { str: "FLAT ENTRANCE", x: 1183, y: 2888, h: 10 },
    { str: "TYPE", x: 1392, y: 2833, h: 10 },
    { str: "D07", x: 1400, y: 2861, h: 10 },
    { str: "W", x: 1748, y: 2833, h: 10 },
    { str: "H", x: 1838, y: 2833, h: 10 },
    { str: "1800", x: 1735, y: 2861, h: 10 },
    { str: "2200", x: 1823, y: 2861, h: 10 },
    { str: "Fire Rating", x: 1893, y: 2808, h: 10 },
    { str: "60 MIN.", x: 1907, y: 2861, h: 10 },
    { str: "Structural Opening", x: 1715, y: 2783, h: 10 },
  ];
  const rows = parseDoorScheduleTokens(tokens, {
    sheet_id: "A7102-WOODEN DOORS (SHEET 2 OF5).pdf",
    file_name: "A7102-WOODEN DOORS (SHEET 2 OF5).pdf",
  });
  const d07 = rows.find((r) => r.tag === "D07");
  assert.ok(d07, "D07 entry missing");
  assert.ok(d07.size?.includes("1800"), `size=${d07.size}`);
  assert.ok(d07.size?.includes("2200"), `size=${d07.size}`);
  assert.ok(d07.fire_rating?.includes("60"), `fire=${d07.fire_rating}`);
  assert.ok(d07.floors?.includes("1ST"), `floors=${d07.floors}`);
  assert.ok(d07.room_name && /KIDS|FLAT|LOUNGE/i.test(d07.room_name), `room=${d07.room_name}`);
  assert.ok(!/^Door D07 — see /i.test(d07.description || ""), "must not be stub description");
});

test("parseDoorScheduleTokens: D-1 card → room, size, fire", () => {
  // Minimal positioned tokens mirroring A7101 D-1 schedule column
  const tokens = [
    { str: "Fire", x: 637, y: 1422, h: 10 },
    { str: "90", x: 664, y: 1421, h: 10 },
    { str: "MIN.", x: 680, y: 1421, h: 10 },
    { str: "Opening", x: 625, y: 1446, h: 10 },
    { str: "H", x: 644, y: 1463, h: 10 },
    { str: "2200", x: 664, y: 1456, h: 10 },
    { str: "Structrual", x: 625, y: 1486, h: 10 },
    { str: "W", x: 644, y: 1506, h: 10 },
    { str: "1100", x: 664, y: 1500, h: 10 },
    { str: "D-1", x: 599, y: 1576, h: 12 },
    { str: "Schedule", x: 599, y: 1625, h: 10 },
    { str: "DOOR", x: 639, y: 1662, h: 10 },
    { str: "TYPE", x: 650, y: 1664, h: 10 },
    { str: "D01", x: 664, y: 1667, h: 10 },
    { str: "STAIRCASE", x: 664, y: 1732, h: 10 },
    { str: "ROOM", x: 637, y: 1747, h: 10 },
    { str: "Wooden", x: 599, y: 1755, h: 10 },
    { str: "1ST", x: 664, y: 1997, h: 10 },
    { str: "FLOOR", x: 664, y: 1960, h: 10 },
    { str: "2ND", x: 677, y: 1995, h: 10 },
    { str: "TO", x: 677, y: 1941, h: 10 },
    { str: "25TH", x: 677, y: 1914, h: 10 },
    { str: "26TH", x: 691, y: 1990, h: 10 },
  ];
  const rows = parseDoorScheduleTokens(tokens, {
    sheet_id: "A7101-WOODEN DOORS.pdf",
    file_name: "A7101-WOODEN DOORS.pdf",
  });
  assert.ok(rows.length >= 1, `expected ≥1 row, got ${rows.length}`);
  const d01 = rows.find((r) => r.tag === "D01");
  assert.ok(d01, "D01 entry missing");
  assert.equal(d01.kind, "door");
  assert.equal(d01.room_name, "STAIRCASE");
  assert.ok(d01.fire_rating?.includes("90"), `fire=${d01.fire_rating}`);
  assert.ok(d01.size?.includes("1100"), `size=${d01.size}`);
  assert.ok(d01.size?.includes("2200"), `size=${d01.size}`);
  assert.equal(d01.source_sheet, "A7101-WOODEN DOORS.pdf");
  assert.ok(d01.source_bbox.w > 0 && d01.source_bbox.h > 0);
});

test("parseSteelDoorFrameSchedule: SD1 fire / RAL / qty", () => {
  const tokens = [
    { str: "DOOR & FRAME SCHEDULE", x: 295, y: 1467, h: 10 },
    { str: "DOOR TYPE", x: 296, y: 1493, h: 10 },
    { str: "FIRE RATING", x: 381, y: 1495, h: 10 },
    { str: "RAL COLOR", x: 473, y: 1493, h: 10 },
    { str: "HANDING QTY", x: 554, y: 1493, h: 10 },
    { str: "SD1", x: 312, y: 1519, h: 10 },
    { str: "90 MIN", x: 379, y: 1518, h: 10 },
    { str: "TBC", x: 467, y: 1519, h: 10 },
    { str: "TBC", x: 542, y: 1519, h: 10 },
    { str: "19", x: 628, y: 1519, h: 10 },
    { str: "DOOR IN-FILL : MINERAL WOOL", x: 657, y: 1555, h: 10 },
    { str: ": 1.5mm Steel SHEET", x: 771, y: 1490, h: 10 },
    { str: ": 1.2 mm Steel SHEET", x: 772, y: 1522, h: 10 },
  ];
  const rows = parseSteelDoorFrameSchedule(tokens, {
    sheet_id: "A7107.pdf",
    file_name: "A7107-PRESSED STEEL DOORS (SHEET 1 OF 3).pdf",
  });
  const sd1 = rows.find((r) => r.tag === "SD1");
  assert.ok(sd1, "SD1 missing");
  assert.ok(sd1.fire_rating?.includes("90"), `fire=${sd1.fire_rating}`);
  assert.ok(sd1.color, `color=${sd1.color}`);
  assert.ok(sd1.remarks?.toLowerCase().includes("mineral"), `remarks=${sd1.remarks}`);
});

test("parseElevationTypeTables: CW-01 / GD-01", () => {
  const tokens = [
    { str: "Curtain Wall Schedule", x: 401, y: 1325, h: 10 },
    { str: "Type", x: 278, y: 1374, h: 10 },
    { str: "Width", x: 439, y: 1390, h: 10 },
    { str: "Height", x: 599, y: 1390, h: 10 },
    { str: "Count", x: 745, y: 1390, h: 10 },
    { str: "Mark", x: 276, y: 1406, h: 10 },
    { str: "CW-01", x: 279, y: 1437, h: 10 },
    { str: "8100", x: 455, y: 1437, h: 10 },
    { str: "2600", x: 620, y: 1437, h: 10 },
    { str: "1", x: 781, y: 1437, h: 10 },
    { str: "Glass Door Schedule", x: 297, y: 617, h: 10 },
    { str: "TYPE", x: 163, y: 665, h: 10 },
    { str: "WIDTH", x: 317, y: 681, h: 10 },
    { str: "HEIGHT", x: 478, y: 681, h: 10 },
    { str: "COUNT", x: 616, y: 681, h: 10 },
    { str: "MARK", x: 153, y: 698, h: 10 },
    { str: "FIRE", x: 776, y: 665, h: 10 },
    { str: "RATED", x: 761, y: 698, h: 10 },
    { str: "GD-01", x: 169, y: 727, h: 10 },
    { str: "1600", x: 328, y: 728, h: 10 },
    { str: "2400", x: 504, y: 727, h: 10 },
    { str: "01", x: 660, y: 726, h: 10 },
    { str: "60 MIN", x: 787, y: 726, h: 10 },
  ];
  const rows = parseElevationTypeTables(tokens, {
    sheet_id: "A7201.pdf",
    file_name: "A7201-ALUMINUM WINDOWS DETAILS (SHEET 1 OF 3).pdf",
  });
  const cw = rows.find((r) => r.tag === "CW-01");
  assert.ok(cw, "CW-01 missing");
  assert.ok(cw.size?.includes("8100"), `cw size=${cw.size}`);
  assert.ok(cw.size?.includes("2600"), `cw size=${cw.size}`);
  const gd = rows.find((r) => r.tag === "GD-01");
  assert.ok(gd, "GD-01 missing");
  assert.ok(gd.fire_rating?.includes("60"), `gd fire=${gd.fire_rating}`);
  assert.ok(gd.size?.includes("1600"), `gd size=${gd.size}`);
});

test("parseFinishScheduleTokens: code after description", () => {
  const tokens = [
    { str: "14.STORE", x: 100, y: 100, h: 12 },
    { str: "600*600*10MM HEAVY DUTY PORCELAIN TILE FLOORING", x: 100, y: 120, h: 10 },
    { str: "PT-10", x: 100, y: 140, h: 12 },
    { str: "100 MM PORCELAIN SKIRTING", x: 100, y: 160, h: 10 },
    { str: "SK-2", x: 100, y: 180, h: 12 },
  ];
  const rows = parseFinishScheduleTokens(tokens, {
    sheet_id: "A0002.pdf",
    file_name: "A0002-FINISHES SCHEDUALE.pdf",
  });
  const pt = rows.find((r) => r.tag === "PT-10");
  assert.ok(pt);
  assert.ok(pt.description?.toUpperCase().includes("PORCELAIN"), `desc=${pt.description}`);
  assert.equal(pt.room_name, "STORE");
  const sk = rows.find((r) => r.tag === "SK-2");
  assert.ok(sk);
});

test("extractScheduleKbFromSheet respects filename class", () => {
  const doorFile = extractScheduleKbFromSheet(
    [{ str: "Schedule", x: 100, y: 200, h: 10 }, { str: "D01", x: 120, y: 220, h: 10 }, { str: "D-1", x: 100, y: 180, h: 10 }],
    { sheet_id: "a.pdf", file_name: "A7101-WOODEN DOORS.pdf" },
  );
  assert.ok(doorFile.some((e) => e.tag === "D01" || e.kind === "door"));

  const planFile = extractScheduleKbFromSheet(
    [{ str: "D01", x: 10, y: 10, h: 10 }],
    { sheet_id: "b.pdf", file_name: "A1105-1st FLOOR PLAN.pdf" },
  );
  assert.equal(planFile.length, 0);
});

test("buildScheduleKb + lookup + enrich hover fields", () => {
  const kb = buildScheduleKb([
    {
      tag: "D01",
      kind: "door",
      room_name: "STAIRCASE",
      description: "Wooden Door D01 — W 1100 × H 2200 mm",
      size: "W 1100 × H 2200 mm",
      fire_rating: "90 MIN",
      floors: "1ST FLOOR; 2ND TO 25TH FLOOR",
      type: "Wooden Door D01",
      source_sheet: "A7101.pdf",
      source_title: "A7101-WOODEN DOORS",
      source_bbox: { x: 10, y: 20, w: 100, h: 200 },
    },
  ]);
  assert.ok(lookupScheduleKb(kb, "D01"));
  assert.ok(lookupScheduleKb(kb, "D-1"));
  assert.ok(lookupScheduleKb(kb, "D1"));

  const idx = buildPlanSymbolIndex({
    "plan.pdf": [{ tag: "D01", kind: "door", x: 50, y: 50, w: 20, h: 20 }],
  });
  const en = enrichSymbolsWithSchedule(idx, { kb });
  assert.equal(en[0].schedule.fire_rating, "90 MIN");
  assert.equal(en[0].schedule.source_sheet, "A7101.pdf");
  assert.ok(en[0].room_name === "STAIRCASE" || en[0].schedule.description?.includes("Wooden"));

  const fields = resolveSymbolFields(en[0].schedule, {}, en[0].room_name);
  assert.equal(fields.fire_rating, "90 MIN");
  assert.equal(fields.size, "W 1100 × H 2200 mm");
  assert.equal(fields.type, "Wooden Door D01");
  // Manual override wins
  assert.equal(resolveSymbolFields(en[0].schedule, { fire_rating: "60 MIN" }, null).fire_rating, "60 MIN");
});

test("enrich hover: CW-06 matches schedule KB variants", () => {
  const kb = buildScheduleKb([
    {
      tag: "CW-06",
      kind: "window",
      type: "Curtain Wall CW-06",
      description: "Curtain Wall CW-06 — W 3000 × H 2600 mm",
      size: "W 3000 × H 2600 mm",
      remarks: "Count 12 · See curtain-wall legend (C1–C6)",
      source_sheet: "A7201.pdf",
      source_title: "A7201-ALUMINUM WINDOWS DETAILS (SHEET 1 OF 2)",
      source_bbox: { x: 10, y: 20, w: 200, h: 100 },
    },
  ]);
  assert.ok(lookupScheduleKb(kb, "CW-06"));
  assert.ok(lookupScheduleKb(kb, "CW06"));

  const idx = buildPlanSymbolIndex({
    "plan.pdf": [{ tag: "CW-06", kind: "finish", x: 80, y: 80, w: 24, h: 24 }],
  });
  const en = enrichSymbolsWithSchedule(idx, { kb });
  assert.equal(en[0].schedule.type, "Curtain Wall CW-06");
  assert.equal(en[0].schedule.size, "W 3000 × H 2600 mm");
  assert.ok(en[0].schedule.source_title?.includes("ALUMINUM WINDOWS"));
  const fields = resolveSymbolFields(en[0].schedule, {}, en[0].room_name);
  assert.equal(fields.type, "Curtain Wall CW-06");
  assert.equal(fields.size, "W 3000 × H 2600 mm");
});
