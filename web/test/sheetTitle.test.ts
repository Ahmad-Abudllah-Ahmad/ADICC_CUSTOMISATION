// Drawing-title table → split-page file name. Tokens match real ADICC /
// UAE title blocks (left strip + DRAWING TITLE / Drg.Title field).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanDrawingTitle,
  cleanFileDisplayName,
  drawingTitleFromTokens,
  parseDrawingTitleFromOcr,
  type TitleTok,
} from "../src/lib/sheets.ts";

const tok = (str: string, x: number, y: number, h: number): TitleTok => ({ str, x, y, h });

test("cleanFileDisplayName keeps user labels without changing store keys", () => {
  assert.equal(cleanFileDisplayName("  Typical Ceiling Details.pdf  "), "Typical Ceiling Details");
  assert.equal(cleanFileDisplayName("a/b:c"), "a-b-c");
  assert.equal(cleanFileDisplayName(""), null);
  assert.equal(cleanFileDisplayName("   "), null);
});

test("cleanDrawingTitle strips junk and refuses empty / numeric-only", () => {
  assert.equal(cleanDrawingTitle("  STAIRCASE HANDRAIL DETAILS  "), "STAIRCASE HANDRAIL DETAILS");
  assert.equal(cleanDrawingTitle("LIFT DETAILS 1/2"), "LIFT DETAILS 1-2");
  assert.equal(cleanDrawingTitle("DRAWING TITLE"), null);
  assert.equal(cleanDrawingTitle("12345"), null);
  assert.equal(cleanDrawingTitle(""), null);
  assert.equal(cleanDrawingTitle("Item Item Item Item Item"), null);
});

test("DRAWING TITLE field below the label (right-hand title block)", () => {
  const W = 2384, H = 1684;
  const title = drawingTitleFromTokens([
    tok("PROPOSED RESIDENTIAL BUILDING CONSISTING", 2026, 1061, 13),
    tok("DRAWING TITLE :", 2024, 1159, 9.5),
    tok("STAIRCASE HANDRAIL DETAILS", 2094, 1207, 12.4),
    tok("DRAWING NO :", 2024, 1272, 9.5),
    tok("A4012", 2101, 1284, 12.4),
    tok("SCALE :", 2192, 1329, 9.5),
  ], W, H);
  assert.equal(title, "STAIRCASE HANDRAIL DETAILS");
});

test("DRAWING TITLE two-part value on one row (GFA / floor)", () => {
  const W = 2384, H = 1684;
  const title = drawingTitleFromTokens([
    tok("DRAWING TITLE :", 2020, 1130, 10),
    tok("GFA FLOOR PLAN", 2064, 1166, 14),
    tok("-", 2186, 1166, 14),
    tok("GROUND FLOOR", 2191, 1166, 14),
    tok("DRAWING NO. :", 2020, 1215, 10),
    tok("A100", 2087, 1237, 12),
  ], W, H);
  assert.equal(title, "GFA FLOOR PLAN - GROUND FLOOR");
});

test("Drg.Title value on the same line, not the project line above", () => {
  const W = 1684, H = 1191;
  const title = drawingTitleFromTokens([
    tok("Project", 1451, 1027, 7.8),
    tok("Commercial Residential Building (UG+G+M+4TYP+R)", 1490, 1028, 7.2),
    tok("Drg.Title", 1451, 1041, 7.8),
    tok("SETTING OUT PLAN(GROUND)", 1493, 1041, 11.1),
    tok("Area", 1451, 1055, 7.8),
  ], W, H);
  assert.equal(title, "SETTING OUT PLAN(GROUND)");
});

test("unlabeled right title-block (no DRAWING TITLE label)", () => {
  const W = 1684, H = 1191;
  const title = drawingTitleFromTokens([
    tok("LIFT DETAILS 1/2", 1499, 845, 8.8),
    tok("A4010", 1477, 907, 8.8),
    tok("1:50", 1624, 907, 8.8),
  ], W, H);
  assert.equal(title, "LIFT DETAILS 1-2");
});

test("left-strip table wins when there is no DRAWING TITLE label", () => {
  const W = 1684, H = 1191;
  const title = drawingTitleFromTokens([
    tok("COMMERCIAL&RESIDENTIAL BUILDING", 68, 1134, 7.2),
    tok("SETTING OUT PLAN(GROUND)", 68, 1148, 14.4),
    tok("SCALE", 68, 1157, 7.2),
    tok("1:300", 97, 1157, 7.2),
  ], W, H);
  assert.equal(title, "SETTING OUT PLAN(GROUND)");
});

test("labeled DRAWING TITLE beats a left-edge viewport callout", () => {
  const W = 2384, H = 1684;
  const title = drawingTitleFromTokens([
    tok("GUARD LATERAL FIXING DETAILS", 94, 1623, 21.6),
    tok("A4023", 35, 1643, 13),
    tok("DRAWING TITLE :", 2024, 1159, 9.5),
    tok("STAIRCASE HANDRAIL DETAILS", 2094, 1207, 12.4),
    tok("DRAWING NO :", 2024, 1272, 9.5),
  ], W, H);
  assert.equal(title, "STAIRCASE HANDRAIL DETAILS");
});

test("parseDrawingTitleFromOcr reads label + next line and same-line value", () => {
  assert.equal(
    parseDrawingTitleFromOcr("DRAWING TITLE :\nGARBAGE DETAILS 3/3\nDRAWING NO :\nA4018"),
    "GARBAGE DETAILS 3-3",
  );
  assert.equal(
    parseDrawingTitleFromOcr("Drg.Title  SETTING OUT PLAN(GROUND)\nScale 1:300"),
    "SETTING OUT PLAN(GROUND)",
  );
  assert.equal(parseDrawingTitleFromOcr("SCALE\n1:100\nA4011"), null);
});
