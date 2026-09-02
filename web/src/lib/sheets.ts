// Shared sheet/plan-text helpers for the Takeoff Canvas and the Sheet Gallery:
// sheet-key codec, standard scales, title-block sheet numbers, drawn-scale notes.
import * as pdfjsLib from "pdfjs-dist";
import type { Token } from "./scheduleParse";
export { parseSheetKey, compareSheetKeys } from "./sheetKey"; // moved to a pdfjs-free module; re-exported for existing importers
export type { ParsedSheetKey } from "./sheetKey";

export const RENDER_SCALE = 2.0;

/** Side-by-side panel cap — shared by the canvas group logic and the gallery's
 * open-side-by-side gate so the two can never disagree. Hi-res sheets render at
 * the full auto budget, so a 4-up of large hi-res sheets is memory-heavy. */
export const MAX_GROUP = 4;

export interface Scale {
  label: string;
  /** real feet per image pixel at RENDER_SCALE */
  upp: number;
}
type ScaleWithKeys = Scale & { keys: string[] };

/** A page viewport (subset of pdf.js's PageViewport that we use). */
interface Viewport {
  width: number;
  height: number;
  transform: number[];
}
interface TextItemLike {
  str?: string;
  transform: number[];
  height?: number;
}
interface TextContentLike {
  items: TextItemLike[];
}


export interface DetectedScale {
  upp: number;
  label: string;
  multi: boolean;
}

// Standard architectural/engineering scales → units_per_px (real feet per image
// pixel). A plan PDF plotted to size has 72 pt = 1 paper inch; we raster at
// RENDER_SCALE, so 1 paper inch = 72*RENDER_SCALE px. For "1/4\"=1'-0\"", 1 paper
// inch = 4 ft, so feet/px = 4 / (72*RENDER_SCALE). (Use Calibrate for scans.)
const PX_PER_IN = 72 * RENDER_SCALE;
const arch = (inPerFt: number): number => (1 / inPerFt) / PX_PER_IN; // inPerFt e.g. 0.25 for 1/4"=1'
const eng = (ftPerIn: number): number => ftPerIn / PX_PER_IN;        // ftPerIn e.g. 20 for 1"=20'
// Metric ratio scales (EU plans): 1:R means 1 paper unit = R real units, so one
// paper inch = R real inches = R/12 real feet. upp stays in FEET per px — the
// unit system only changes what the UI displays (lib/units.ts).
const metric = (r: number): number => (r / 12) / PX_PER_IN;
export const STANDARD_SCALES: Scale[] = [
  { label: '1/16" = 1\'-0"', upp: arch(1 / 16) },
  { label: '3/32" = 1\'-0"', upp: arch(3 / 32) },
  { label: '1/8" = 1\'-0"', upp: arch(1 / 8) },
  { label: '3/16" = 1\'-0"', upp: arch(3 / 16) },
  { label: '1/4" = 1\'-0"', upp: arch(1 / 4) },
  { label: '3/8" = 1\'-0"', upp: arch(3 / 8) },
  { label: '1/2" = 1\'-0"', upp: arch(1 / 2) },
  { label: '3/4" = 1\'-0"', upp: arch(3 / 4) },
  { label: '1" = 1\'-0"', upp: arch(1) },
  { label: '1-1/2" = 1\'-0"', upp: arch(1.5) },
  { label: '3" = 1\'-0"', upp: arch(3) },
  { label: '1" = 10\'', upp: eng(10) },
  { label: '1" = 20\'', upp: eng(20) },
  { label: '1" = 30\'', upp: eng(30) },
  { label: '1" = 40\'', upp: eng(40) },
  { label: '1" = 50\'', upp: eng(50) },
  { label: '1" = 60\'', upp: eng(60) },
  { label: "1:20", upp: metric(20) },
  { label: "1:25", upp: metric(25) },
  { label: "1:50", upp: metric(50) },
  { label: "1:75", upp: metric(75) },
  { label: "1:100", upp: metric(100) },
  { label: "1:125", upp: metric(125) },
  { label: "1:200", upp: metric(200) },
  { label: "1:250", upp: metric(250) },
  { label: "1:500", upp: metric(500) },
];

// Pull the drawing's sheet number (e.g. A003, A-101, A4101, S1.1) from the title block —
// the largest sheet-number-shaped token in the lower-right region of the page.
const SHEET_NO_SHORT = /^[A-Z]{1,3}[-. ]?\d{1,3}(\.\d{1,2})?[A-Z]?$/;
const SHEET_NO_LONG = /^[A-Z]\d{4,5}$/;
export function extractSheetNumber(textContent: TextContentLike, viewport: Viewport): string | null {
  const W = viewport.width, H = viewport.height;
  let best: string | null = null, bestH = 0;
  for (const it of textContent.items || []) {
    const raw = (it.str || "").trim().toUpperCase().replace(/\s+/g, "");
    const rawCanon = raw.replace(/[-.]/g, "");
    const isShort = raw.length >= 2 && raw.length <= 8 && SHEET_NO_SHORT.test(raw);
    const isLong = SHEET_NO_LONG.test(rawCanon);
    if (!isShort && !isLong) continue;
    const t = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const x = t[4], y = t[5], h = Math.hypot(t[2], t[3]) || it.height || 0;
    // title block lives lower-right; require it there and prefer the biggest text
    if (x < W * 0.60 || y < H * 0.55) continue;
    const score = h + (x / W) * 4 + (y / H) * 4; // bigger + further to lower-right wins
    if (score > bestH) { bestH = score; best = isLong ? rawCanon : raw; }
  }
  return best;
}

// ── drawing title: left title strip + DRAWING TITLE / Drg.Title table ────────
// Multi-page ingest names each split sheet from this (not "file - page N").
export interface TitleTok { str: string; x: number; y: number; h: number }

const TITLE_LABEL_RE = /^(?:DRAWING|DRG\.?|SHEET|DWG\.?)\s*TITLE\s*:?$/i;
const TITLE_INLINE_RE = /^(?:DRAWING|DRG\.?|SHEET|DWG\.?)\s*TITLE\s*:?\s+(.+)$/i;
const TITLE_STOP_RE = /^(DRAWING\s*(NO\.?|NUMBER|SIZE)|REVISION|REV\.?\s*NO\.?|SCALE|SUBMISSION|PROJECT(\s*ID|\s*NAME)?|DATE|CLIENT|ARCHITECT|ZONE|SECTOR|PLOT(\s*NO)?|AREA|FLOORTYPE|OFFICIAL\s*USE|OWNER|CONSULTANT|DEVELOPER|MASTER\s*DEVELOPER)\b/i;

function positionedTitleToks(textContent: TextContentLike, viewport: Viewport): TitleTok[] {
  const out: TitleTok[] = [];
  for (const it of textContent.items || []) {
    const str = (it.str || "").trim();
    if (!str) continue;
    const t = pdfjsLib.Util.transform(viewport.transform, it.transform);
    out.push({
      str,
      x: t[4],
      y: t[5],
      h: Math.hypot(t[2], t[3]) || it.height || 0,
    });
  }
  return out;
}

function isTitleLabel(str: string): boolean {
  return TITLE_LABEL_RE.test(str.trim());
}

function isTitleStop(str: string): boolean {
  const s = str.trim();
  if (isTitleLabel(s) || TITLE_INLINE_RE.test(s)) return false;
  return TITLE_STOP_RE.test(s);
}

/** User-chosen Files label (right-click Rename). Does not change the stored PDF key. */
export function cleanFileDisplayName(raw: string): string | null {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  s = s.replace(/\.pdf$/i, "");
  s = s.replace(/[\\/:*?"<>|]/g, "-").trim();
  if (s.length < 1 || s.length > 120) return null;
  return s;
}

/** Collapse OCR / PDF-text title fragments into a safe file-name stem, or null. */
export function cleanDrawingTitle(raw: string): string | null {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^[:.\-–—]+\s*/, "").replace(/\s*[:.\-–—]+$/, "");
  s = s.replace(/[\\/:*?"<>|]/g, "-");
  if (s.length < 3 || s.length > 120) return null;
  if (!/[A-Za-z]{3,}/.test(s)) return null;
  if (/^(title|drawing title|drg\.?\s*title|sheet title|untitled)$/i.test(s)) return null;
  // BOQ / schedule column headers glued together ("Item Item Item…")
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    const uniq = new Set(words.map((w) => w.toLowerCase()));
    if (uniq.size === 1) return null;
  }
  if (/^(item|qty|unit|description|amount|total|no\.?|code)(\s+\1)+$/i.test(s)) return null;
  return s;
}

function joinTitleToks(toks: TitleTok[]): string | null {
  if (!toks.length) return null;
  const rows: TitleTok[][] = [];
  const sorted = [...toks].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const t of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - t.y) <= Math.max(r[0].h, t.h, 8) * 0.75);
    if (row) row.push(t);
    else rows.push([t]);
  }
  const text = rows
    .map((r) => r.sort((a, b) => a.x - b.x).map((t) => t.str).join(" "))
    .join(" ")
    .replace(/\s+-\s+/g, " - ");
  return cleanDrawingTitle(text);
}

function titleFromLabeledField(toks: TitleTok[], W: number, H: number): string | null {
  for (const lab of toks) {
    const inline = lab.str.match(TITLE_INLINE_RE);
    if (inline) {
      const cleaned = cleanDrawingTitle(inline[1]);
      if (cleaned) return cleaned;
    }
    if (!isTitleLabel(lab.str) && !inline) continue;

    const lineTol = Math.max(lab.h * 0.7, 6);
    const sameLine = toks.filter((t) =>
      t !== lab
      && t.x > lab.x + 6
      && Math.abs(t.y - lab.y) <= lineTol
      && !isTitleStop(t.str)
      && !isTitleLabel(t.str),
    );
    const same = joinTitleToks(sameLine);
    if (same) return same;

    const nextFieldY = toks
      .filter((t) => isTitleStop(t.str) && t.y > lab.y + 2 && Math.abs(t.x - lab.x) < W * 0.28)
      .reduce((min, t) => Math.min(min, t.y), lab.y + Math.max(H * 0.10, 90));
    const below = toks.filter((t) =>
      t !== lab
      && t.y > lab.y + lab.h * 0.25
      && t.y < nextFieldY - 1
      && t.x > lab.x - 20
      && t.x < W
      && !isTitleStop(t.str)
      && !isTitleLabel(t.str),
    );
    const under = joinTitleToks(below);
    if (under) return under;
  }
  return null;
}

function isTitleLike(str: string): boolean {
  const s = str.trim();
  if (s.length < 4 || s.length > 70) return false;
  if (!/[A-Za-z]{3,}/.test(s)) return false;
  if (isTitleStop(s) || isTitleLabel(s)) return false;
  if (/^\d+([.:]\d+)?$/.test(s)) return false;
  if (/^PROPOSED\b/i.test(s)) return false;
  return true;
}

/** Largest title-like line in the bottom-left title-strip table (SCALE nearby). */
function titleFromLeftStrip(toks: TitleTok[], W: number, H: number): string | null {
  const band = toks.filter((t) => t.x < W * 0.22 && t.y > H * 0.80);
  if (!band.some((t) => /^SCALE\b/i.test(t.str))) return null;
  const candidates = band.filter((t) => t.h >= 8 && isTitleLike(t.str));
  if (!candidates.length) return null;
  const maxH = Math.max(...candidates.map((t) => t.h));
  return joinTitleToks(candidates.filter((t) => t.h >= maxH * 0.78));
}

const RIGHT_TITLE_HINT =
  /\b(PLAN|DETAILS?|SECTION|ELEVATION|SCHEDULE|LAYOUT|WATERPROOFING|HANDRAIL|LADDER|CEILING|FLOOR|ROOF|PARKING|STAIR|DOOR|WINDOW|GARBAGE|LIFT|PLATFORM|POOL|RECEPTION|ENTRANCE|FINISHING|TYPICAL)\b/i;

/** Unlabeled title in the lower-right block (e.g. "LIFT DETAILS 1/2"). */
function titleFromRightBlock(toks: TitleTok[], W: number, H: number): string | null {
  const band = toks.filter((t) =>
    t.x > W * 0.68
    && t.y > H * 0.62
    && t.y < H * 0.90
    && t.h >= 8
    && isTitleLike(t.str)
    && RIGHT_TITLE_HINT.test(t.str),
  );
  if (!band.length) return null;
  const maxH = Math.max(...band.map((t) => t.h));
  return joinTitleToks(band.filter((t) => t.h >= maxH * 0.78));
}

/**
 * Drawing title from the title-block table. Prefers a DRAWING TITLE / Drg.Title
 * field; then the left title-strip table; then an unlabeled right-block title.
 */
export function drawingTitleFromTokens(toks: TitleTok[], width: number, height: number): string | null {
  return titleFromLabeledField(toks, width, height)
    || titleFromLeftStrip(toks, width, height)
    || titleFromRightBlock(toks, width, height);
}

export function extractDrawingTitle(textContent: TextContentLike, viewport: Viewport): string | null {
  return drawingTitleFromTokens(positionedTitleToks(textContent, viewport), viewport.width, viewport.height);
}

/** Parse Tesseract / OCR dump of a title-block crop into a drawing title. */
export function parseDrawingTitleFromOcr(text: string): string | null {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(TITLE_INLINE_RE);
    if (inline) {
      const cleaned = cleanDrawingTitle(inline[1]);
      if (cleaned) return cleaned;
    }
    if (TITLE_LABEL_RE.test(lines[i])) {
      const next = lines[i + 1];
      if (next && !isTitleStop(next) && !TITLE_LABEL_RE.test(next)) {
        const cleaned = cleanDrawingTitle(next);
        if (cleaned) return cleaned;
      }
    }
  }
  // Left-strip OCR often has the title as the largest remaining line, no label.
  const candidates = lines.filter((l) =>
    !TITLE_LABEL_RE.test(l) && !isTitleStop(l) && /[A-Za-z]{4,}/.test(l) && l.length <= 80,
  );
  if (candidates.length === 1) return cleanDrawingTitle(candidates[0]);
  return null;
}

// ── scale detect: read the drawn scale note off the page text ────────────────
// Plans state their scale ("SCALE: 1/8" = 1'-0"" / "1 : 200") in the title block
// and under viewports. Prefer the labeled SCALE field; fall back to page-wide
// note matching against STANDARD_SCALES.
const SCALE_LABEL_RE = /^SCALE\s*:?\s*$/i;
const SCALE_INLINE_RE = /^SCALE\s*:?\s*(.+)$/i;

function scaleFromScaleField(raw: string): DetectedScale | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  return scaleFromLabel(s);
}

/** Read the SCALE row from a positioned title-block table (text layer). */
function extractScaleFromTitleBlock(textContent: TextContentLike, viewport: Viewport): DetectedScale | null {
  const W = viewport.width, H = viewport.height;
  const toks = positionedTitleToks(textContent, viewport);
  const inTitleBlock = (t: TitleTok) =>
    (t.x > W * 0.55 && t.y > H * 0.50) || (t.x < W * 0.30 && t.y > H * 0.75);
  const band = toks.filter(inTitleBlock).sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i < band.length; i++) {
    const str = band[i].str.trim();
    const inline = str.match(SCALE_INLINE_RE);
    if (inline) {
      const det = scaleFromScaleField(inline[1]);
      if (det) return det;
    }
    if (!SCALE_LABEL_RE.test(str)) continue;
    const row = band.filter((t) =>
      Math.abs(t.y - band[i].y) <= Math.max(band[i].h, t.h) * 0.75 && t.x > band[i].x + 1,
    );
    if (row.length) {
      const det = scaleFromScaleField(row.map((t) => t.str.trim()).join(" "));
      if (det) return det;
    }
    for (let j = i + 1; j < band.length; j++) {
      const t = band[j];
      if (t.y > band[i].y + band[i].h * 2.8) break;
      if (Math.abs(t.x - band[i].x) > W * 0.20) continue;
      if (TITLE_STOP_RE.test(t.str) && !SCALE_INLINE_RE.test(t.str)) break;
      const det = scaleFromScaleField(t.str);
      if (det) return det;
    }
  }
  return null;
}

/** Parse Tesseract / OCR dump of a title-block crop into a drawn scale. */
export function parseScaleFromOcr(text: string): DetectedScale | null {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(SCALE_INLINE_RE);
    if (inline) {
      const det = scaleFromScaleField(inline[1]);
      if (det) return det;
    }
    if (SCALE_LABEL_RE.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/^(DRAWING|REVISION|PROJECT|SUBMISSION|DRAWING\s*SIZE)/i.test(lines[j])) break;
        const det = scaleFromScaleField(lines[j]);
        if (det) return det;
      }
    }
  }
  const m = String(text || "").match(/SCALE\s*:?\s*([^\n\r]{1,48})/i);
  if (m) {
    const det = scaleFromScaleField(m[1]);
    if (det) return det;
  }
  return null;
}
const _canonScaleText = (s: string): string => s
  .replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'")
  .replace(/\s+/g, "").toUpperCase();
const SCALE_KEYS: ScaleWithKeys[] = STANDARD_SCALES.map((s) => {
  const full = _canonScaleText(s.label);
  const keys = new Set<string>([full]);
  if (full.endsWith("=1'-0\"")) keys.add(full.slice(0, -3));   // 1/8"=1'-0" also written 1/8"=1'
  else if (full.endsWith("'")) keys.add(`${full}-0"`);         // 1"=20' also written 1"=20'-0"
  return { ...s, keys: [...keys] };
});
function _findScales(canon: string): ScaleWithKeys[] {
  const out: ScaleWithKeys[] = [];
  for (const sc of SCALE_KEYS) {
    let hit = false;
    for (const k of sc.keys) {
      let i = canon.indexOf(k);
      while (i !== -1 && !hit) {
        const prev = canon[i - 1];
        const next = canon[i + k.length];
        // boundary: "11/8"=1'" or "1-1/2"=…" must not read as 1/8" or 1/2";
        // and a metric "1:500" must not read as its "1:50" prefix
        if (!(prev >= "0" && prev <= "9") && prev !== "/" && prev !== "-"
            && !(next >= "0" && next <= "9")) hit = true;
        else i = canon.indexOf(k, i + 1);
      }
      if (hit) break;
    }
    if (hit) out.push(sc);
  }
  return out;
}
// → {upp, label, multi} or null. Title-block region is authoritative; a single
// page-wide note is accepted; several distinct scales with no title-block note
// is ambiguous (details are often drawn larger) → suggest nothing.
export function detectScale(textContent: TextContentLike, viewport: Viewport): DetectedScale | null {
  const labeled = extractScaleFromTitleBlock(textContent, viewport);
  if (labeled) return labeled;
  const W = viewport.width, H = viewport.height;
  let all = "", tb = "";
  for (const it of textContent.items || []) {
    const str = it.str || "";
    if (!str.trim()) continue;
    all += str + " ";
    const t = pdfjsLib.Util.transform(viewport.transform, it.transform);
    if (t[4] > W * 0.55 && t[5] > H * 0.5) tb += str + " ";
  }
  const tbHits = _findScales(_canonScaleText(tb));
  const allHits = _findScales(_canonScaleText(all));
  if (tbHits.length) return { upp: tbHits[0].upp, label: tbHits[0].label, multi: allHits.length > 1 };
  if (allHits.length === 1) return { upp: allHits[0].upp, label: allHits[0].label, multi: false };
  return null;
}

// ── marquee → tokens: the text-layer half of "Import from schedule" ──────────
// Turn the page text layer into positioned tokens inside a viewport-px rect (the
// box the estimator dragged around the schedule). x is the glyph's left edge, y
// grows downward, h is the cap height — exactly what parseSchedule() clusters on.
// A vector plan needs no OCR: this IS the extraction. Returns [] for a raster
// page (no text items in the box) so the caller can fall back to the OCR path.
export function extractRegionText(
  textContent: TextContentLike,
  viewport: Viewport,
  rect: { x0: number; y0: number; x1: number; y1: number },
): Token[] {
  const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
  const out: Token[] = [];
  for (const it of textContent.items || []) {
    const str = it.str || "";
    if (!str.trim()) continue;
    const t = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const x = t[4], y = t[5], h = Math.hypot(t[2], t[3]) || it.height || 0;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    out.push({ str, x, y, h });
  }
  return out;
}

// Ported from upstream d02032a lens: BYO-AI read-scale (see docs/PARENT_FORK_PORTS.md #3)
export function scaleFromLabel(text: string): DetectedScale | null {
  if (!text || /^\s*UNKNOWN\s*$/i.test(text)) return null;
  const hits = _findScales(_canonScaleText(text));
  return hits.length === 1 ? { upp: hits[0].upp, label: hits[0].label, multi: false } : null;
}
