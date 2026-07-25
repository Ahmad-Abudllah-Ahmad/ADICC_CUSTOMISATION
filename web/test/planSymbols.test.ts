// Plan-symbol extract / classify / match tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPlanSymbol,
  extractPlanSymbols,
  buildPlanSymbolIndex,
  enrichSymbolsWithSchedule,
  resolveSymbolFields,
  hitPlanSymbol,
  symbolNoteKey,
} from "../src/lib/planSymbols.ts";

test("classify: detail bubble sheet id + digit-led type mark", () => {
  assert.deepEqual(classifyPlanSymbol("A4103"), { tag: "A4103", kind: "detail" });
  assert.deepEqual(classifyPlanSymbol("1ST-02"), { tag: "1ST-02", kind: "type" });
  assert.equal(classifyPlanSymbol("A-101"), null); // short sheet number, not a detail bubble
});

test("extract: detail callout pairs number above sheet id", () => {
  const raw = extractPlanSymbols([
    { str: "4", x: 200, y: 180, h: 16 },
    { str: "A4103", x: 195, y: 210, h: 10 },
  ]);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].tag, "A4103");
  assert.equal(raw[0].kind, "detail");
  assert.equal(raw[0].room_name, "DETAIL 4");
});

test("extract: staircase name above 1ST-02", () => {
  const raw = extractPlanSymbols([
    { str: "STAIRCASE-1", x: 100, y: 180, h: 14 },
    { str: "1ST-02", x: 110, y: 210, h: 10 },
  ]);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].tag, "1ST-02");
  assert.equal(raw[0].room_name, "STAIRCASE-1");
});

test("classify: PD1-39 style type marks", () => {
  assert.deepEqual(classifyPlanSymbol("PD1-39"), { tag: "PD1-39", kind: "type" });
  assert.deepEqual(classifyPlanSymbol("T1-08"), { tag: "T1-08", kind: "type" });
});

test("extract: room name above a boxed mark is attached", () => {
  const raw = extractPlanSymbols([
    { str: "GENERAL STORE-04", x: 100, y: 180, h: 14 },
    { str: "PD1-39", x: 110, y: 210, h: 10 },
  ]);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].tag, "PD1-39");
  assert.equal(raw[0].room_name, "GENERAL STORE-04");
});

test("extract: stacked room name lines merge above the mark", () => {
  const raw = extractPlanSymbols([
    { str: "GENERAL", x: 100, y: 160, h: 12 },
    { str: "STORE-04", x: 100, y: 178, h: 12 },
    { str: "PD1-39", x: 105, y: 210, h: 10 },
  ]);
  assert.equal(raw.length, 1);
  assert.ok(raw[0].room_name?.includes("STORE-04"), `got room_name=${raw[0].room_name}`);
});

test("resolve: room_name from extract, overridable manually", () => {
  const fields = resolveSymbolFields({}, {}, "STORE-04");
  assert.equal(fields.room_name, "STORE-04");
  assert.equal(resolveSymbolFields({}, { room_name: "Lobby" }, "STORE-04").room_name, "Lobby");
});

test("classify: door / window / type / finish marks", () => {
  assert.deepEqual(classifyPlanSymbol("D06"), { tag: "D06", kind: "door" });
  assert.deepEqual(classifyPlanSymbol("d03"), { tag: "D03", kind: "door" });
  assert.deepEqual(classifyPlanSymbol("W12"), { tag: "W12", kind: "window" });
  assert.deepEqual(classifyPlanSymbol("T1-08"), { tag: "T1-08", kind: "type" });
  assert.deepEqual(classifyPlanSymbol("CPT-1"), { tag: "CPT-1", kind: "finish" });
});

test("classify: rejects notes, sheet numbers, prose", () => {
  assert.equal(classifyPlanSymbol("SCALE"), null);
  assert.equal(classifyPlanSymbol("A-101"), null);
  assert.equal(classifyPlanSymbol("LIVING ROOM"), null);
  assert.equal(classifyPlanSymbol("1"), null);
  assert.equal(classifyPlanSymbol(""), null);
});

test("extract: keeps door + type marks with hit boxes", () => {
  const raw = extractPlanSymbols([
    { str: "D06", x: 100, y: 200, h: 12 },
    { str: "T1-08", x: 300, y: 400, h: 10 },
    { str: "NORTH", x: 50, y: 50, h: 14 },
    { str: "see note", x: 60, y: 70, h: 8 },
  ]);
  assert.equal(raw.length, 2);
  assert.ok(raw.some((s) => s.tag === "D06" && s.kind === "door"));
  assert.ok(raw.some((s) => s.tag === "T1-08" && s.kind === "type"));
});

test("extract: dedupes double-drawn glyphs of the same tag", () => {
  const raw = extractPlanSymbols([
    { str: "D06", x: 100, y: 200, h: 12 },
    { str: "D06", x: 101, y: 201, h: 11 },
  ]);
  assert.equal(raw.length, 1);
});

test("cross-sheet: same tag links as matches", () => {
  const idx = buildPlanSymbolIndex({
    "a.pdf": [{ tag: "D06", kind: "door", x: 10, y: 10, w: 20, h: 20 }],
    "b.pdf": [{ tag: "D06", kind: "door", x: 50, y: 60, w: 20, h: 20 }],
    "b.pdf#2": [{ tag: "T1-08", kind: "type", x: 1, y: 1, w: 10, h: 10 }],
  });
  const dOnA = idx.find((s) => s.sheet_id === "a.pdf" && s.tag === "D06");
  assert.ok(dOnA);
  assert.equal(dOnA!.matches.length, 1);
  assert.equal(dOnA!.matches[0].sheet_id, "b.pdf");
  const t = idx.find((s) => s.tag === "T1-08");
  assert.ok(t);
  assert.equal(t!.matches.length, 0);
});

test("enrich + resolve: schedule fills, manual overrides blanks", () => {
  const idx = buildPlanSymbolIndex({
    "a.pdf": [{ tag: "CPT-1", kind: "finish", x: 0, y: 0, w: 10, h: 10 }],
  });
  const en = enrichSymbolsWithSchedule(idx, {
    rows: [{ finish_tag: "CPT-1", description: "Carpet tile", manufacturer: "Acme", style: "Roller" }],
  });
  assert.equal(en[0].schedule.description, "Carpet tile");
  const resolved = resolveSymbolFields(en[0].schedule, { description: "Override", remarks: "Field note" });
  assert.equal(resolved.description, "Override");
  assert.equal(resolved.manufacturer, "Acme");
  assert.equal(resolved.remarks, "Field note");
});

test("hit + note key", () => {
  const idx = buildPlanSymbolIndex({
    "a.pdf": [{ tag: "D06", kind: "door", x: 100, y: 200, w: 20, h: 20 }],
  });
  assert.ok(hitPlanSymbol(idx, "a.pdf", 100, 200));
  assert.equal(hitPlanSymbol(idx, "a.pdf", 500, 500), null);
  assert.equal(symbolNoteKey("a.pdf", "D06", 100.4, 199.6), "a.pdf::D06::100::200");
});
