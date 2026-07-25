// Plan-symbol extract + cross-sheet match (pure, pdfjs-free).
//
// Reads positioned PDF text tokens (the same {str,x,y,h} shape scheduleParse
// uses) and keeps ONLY short architectural callout marks — door/window tags
// in circles (D06), boxed type marks (T1-08), finish codes on the plan
// (CPT-1). Everything else (notes, dimensions, title-block prose) is dropped.
//
// Cross-sheet link: the same normalized tag on another uploaded sheet is
// attached as a match so hover can show "also on A-102". Schedule/condition
// enrichment fills known fields; blanks stay editable via SymbolNotes.

export type SymbolKind = "door" | "window" | "type" | "finish" | "detail";

export type SymbolToken = { str: string; x: number; y: number; h: number; w?: number };

export type SymbolKindInfo = { tag: string; kind: SymbolKind };

/** One extracted mark in image (viewport) px — center + hit box. */
export interface RawPlanSymbol {
  tag: string;
  kind: SymbolKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Room name from nearby PDF text (e.g. "GENERAL STORE-04" above PD1-39). */
  room_name?: string;
}

export interface SymbolMatchRef {
  sheet_id: string;
  x: number;
  y: number;
  kind: SymbolKind;
}

/** Schedule / condition fields shown on hover (any may be empty). */
export interface SymbolScheduleInfo {
  finish_tag?: string;
  description?: string;
  manufacturer?: string;
  style?: string;
  color?: string;
  size?: string;
  remarks?: string;
}

/** User-entered overrides for blank (or incorrect) fields — keyed externally. */
export type SymbolNotes = {
  room_name?: string;
  description?: string;
  manufacturer?: string;
  style?: string;
  color?: string;
  size?: string;
  remarks?: string;
  type?: string;
};

export interface PlanSymbol extends RawPlanSymbol {
  id: string;
  sheet_id: string;
  matches: SymbolMatchRef[];
  schedule: SymbolScheduleInfo;
}

// Door / window marks (circular tags on plans): D06, D03, W12, D1A
const DOOR_RE = /^D\d{1,3}[A-Z]?$/;
const WINDOW_RE = /^W\d{1,3}[A-Z]?$/;
// Boxed type / unit marks: T1-08, PD1-39, 1ST-02 (digit-led unit codes)
const TYPE_RE = /^(?:T\d{1,2}-\d{2}[A-Z]?|[A-Z]{1,3}\d+-\d{2,3}[A-Z]?|\d{1,2}[A-Z]{1,3}-\d{2,3}[A-Z]?)$/;
// Finish codes placed on the plan (not single-letter noise): CPT-1, LVT-2, RB-1
const FINISH_RE = /^[A-Z]{2,4}-[A-Z0-9]{1,4}$/;
// Detail callout bubble bottom (sheet id): A4103, S2101 — letter + 4–5 digits
const DETAIL_RE = /^[A-Z]\d{4,5}$/;
// Title-block sheet numbers to skip when they aren't door-shaped (A003, A-101)
const SHEET_NO_RE = /^[A-Z]{1,3}[-.]?\d{1,3}(\.\d{1,2})?[A-Z]?$/;
// Room / space names printed above a mark (STORE-04, STAIRCASE-1, LIVING ROOM)
const ROOM_NAME_RE = /^(?:[A-Z][A-Z0-9/&.\-']*(?:[ -]+[A-Z0-9/&.\-']+){0,5})$/;

const SKIP = new Set([
  "SCALE", "NORTH", "TRUE", "PLAN", "FLOOR", "LEVEL", "SHEET", "DRAWING",
  "REV", "DATE", "PROJECT", "TITLE", "TYP", "SEE", "NOTE", "NOTES",
  "DETAIL", "SECTION", "ELEVATION", "SIM", "OPP", "DN", "UP",
]);

/** Classify a raw text run as a plan symbol, or null if it isn't one. */
export function classifyPlanSymbol(raw: string): SymbolKindInfo | null {
  const tag = (raw || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!tag || tag.length < 2 || tag.length > 12) return null;
  if (SKIP.has(tag)) return null;
  if (DOOR_RE.test(tag)) return { tag, kind: "door" };
  if (WINDOW_RE.test(tag)) return { tag, kind: "window" };
  if (TYPE_RE.test(tag)) return { tag, kind: "type" };
  if (FINISH_RE.test(tag)) return { tag, kind: "finish" };
  if (DETAIL_RE.test(tag)) return { tag, kind: "detail" };
  // Short sheet numbers (A-101, A003) are not plan marks
  if (SHEET_NO_RE.test(tag) && !DOOR_RE.test(tag) && !WINDOW_RE.test(tag)) return null;
  return null;
}

/** True if a text run looks like a room / space name (not a code mark). */
export function looksLikeRoomName(raw: string): boolean {
  const s = (raw || "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!s || s.length < 3 || s.length > 48) return false;
  if (classifyPlanSymbol(s)) return false;
  if (SKIP.has(s)) return false;
  if (/^\d+(\.\d+)?["']?$/.test(s)) return false;           // dimension
  if (/^\d{1,2}[A-Z]?$/.test(s)) return false;               // lone room number / detail #
  if (!ROOM_NAME_RE.test(s)) return false;
  // Prefer names that carry a letter word (STORE, GENERAL, LIVING…) —
  // pure digit-hyphen codes are marks, not names.
  if (!/[A-Z]{2,}/.test(s)) return false;
  return true;
}

/** Stable id for persistence of manual notes (sheet + tag + rounded anchor). */
export function symbolNoteKey(sheet_id: string, tag: string, x: number, y: number): string {
  return `${sheet_id}::${tag}::${Math.round(x)}::${Math.round(y)}`;
}

/**
 * Extract plan symbols from positioned text tokens.
 * Dedupes near-duplicate glyphs of the same tag (PDF often double-draws).
 * Attaches a nearby room name printed above the mark when present.
 */
export function extractPlanSymbols(tokens: SymbolToken[]): RawPlanSymbol[] {
  const toks = (tokens || []).filter((t) => (t.str || "").trim());
  const out: RawPlanSymbol[] = [];
  for (const t of toks) {
    const parts = (t.str || "").trim().split(/\s+/);
    for (const part of parts) {
      const hit = classifyPlanSymbol(part);
      if (!hit) continue;
      const h = Math.max(6, t.h || 10);
      const w = Math.max(h, t.w || hit.tag.length * h * 0.62);
      // Text-matrix origin is typically the baseline-left; center the hit box.
      const x = t.x + w * 0.5;
      const y = t.y - h * 0.35;
      out.push({ tag: hit.tag, kind: hit.kind, x, y, w: w * 1.35, h: h * 1.5 });
    }
  }
  const deduped = dedupeNearby(out);
  return attachRoomNames(deduped, toks);
}

/** Pair each mark with the closest room-name label sitting above it.
 *  Detail bubbles also pick up the callout number (top half: "4") as "DETAIL 4". */
function attachRoomNames(syms: RawPlanSymbol[], tokens: SymbolToken[]): RawPlanSymbol[] {
  // Candidate name runs — whole token strings that look like room names.
  const names: Array<{ text: string; x: number; y: number; h: number; w: number }> = [];
  const detailNos: Array<{ text: string; x: number; y: number; h: number; w: number }> = [];
  for (const t of tokens) {
    const text = (t.str || "").trim().replace(/\s+/g, " ").toUpperCase();
    const h = Math.max(6, t.h || 10);
    if (/^\d{1,2}$/.test(text)) {
      const w = Math.max(h, t.w || h);
      detailNos.push({ text, x: t.x + w * 0.5, y: t.y - h * 0.35, h, w });
      continue;
    }
    if (!looksLikeRoomName(text)) continue;
    const w = Math.max(h, t.w || text.length * h * 0.55);
    names.push({ text, x: t.x + w * 0.5, y: t.y - h * 0.35, h, w });
  }
  // Also merge stacked name lines (GENERAL + STORE-04 → GENERAL STORE-04)
  // when two name tokens sit on consecutive lines above the same x band.
  const mergedNames = mergeStackedRoomNames(names);

  return syms.map((s) => {
    let best: { text: string; score: number } | null = null;
    for (const n of mergedNames) {
      // Name must sit ABOVE the mark (smaller y) and within a tight band.
      const dy = s.y - n.y;                       // >0 ⇒ name is above
      if (dy < s.h * 0.15 || dy > Math.max(s.h, n.h) * 5.5) continue;
      const dx = Math.abs(s.x - n.x);
      const maxDx = Math.max(s.w, n.w) * 0.85 + s.h * 1.2;
      if (dx > maxDx) continue;
      // Prefer closer vertically, then horizontally.
      const score = dy + dx * 0.35;
      if (!best || score < best.score) best = { text: n.text, score };
    }
    if (best) return { ...s, room_name: best.text };
    // Detail callout: pair sheet id (A4103) with the number in the top half
    if (s.kind === "detail") {
      let bestNo: { text: string; score: number } | null = null;
      for (const n of detailNos) {
        const dy = s.y - n.y;
        if (dy < s.h * 0.05 || dy > s.h * 2.8) continue;
        const dx = Math.abs(s.x - n.x);
        if (dx > s.w * 0.75) continue;
        const score = dy + dx * 0.5;
        if (!bestNo || score < bestNo.score) bestNo = { text: n.text, score };
      }
      if (bestNo) return { ...s, room_name: `DETAIL ${bestNo.text}` };
    }
    return s;
  });
}

/** Join two room-name lines that stack (GENERAL above STORE-04). */
function mergeStackedRoomNames(
  names: Array<{ text: string; x: number; y: number; h: number; w: number }>,
): Array<{ text: string; x: number; y: number; h: number; w: number }> {
  if (names.length < 2) return names;
  const sorted = [...names].sort((a, b) => a.y - b.y || a.x - b.x);
  const used = new Set<number>();
  const out: typeof names = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const a = sorted[i];
    let joined = a;
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const b = sorted[j];
      const dy = b.y - joined.y;
      if (dy < joined.h * 0.4 || dy > joined.h * 2.2) continue;
      if (Math.abs(b.x - joined.x) > Math.max(joined.w, b.w) * 0.7) continue;
      // b is the lower line — combine "GENERAL" + "STORE-04"
      joined = {
        text: `${joined.text} ${b.text}`.replace(/\s+/g, " ").trim(),
        x: (joined.x + b.x) / 2,
        y: (joined.y + b.y) / 2,
        h: joined.h + dy,
        w: Math.max(joined.w, b.w),
      };
      used.add(j);
    }
    out.push(joined);
    // Keep the original single-line names too (STORE-04 alone still matches)
    if (joined.text !== a.text) out.push(a);
  }
  return out;
}

/** Drop the weaker of two same-tag marks within ~1.2× glyph size. */
function dedupeNearby(syms: RawPlanSymbol[]): RawPlanSymbol[] {
  const sorted = [...syms].sort((a, b) => a.tag.localeCompare(b.tag) || a.y - b.y || a.x - b.x);
  const kept: RawPlanSymbol[] = [];
  for (const s of sorted) {
    const near = kept.find((k) =>
      k.tag === s.tag
      && Math.hypot(k.x - s.x, k.y - s.y) < Math.max(k.h, s.h) * 1.2);
    if (near) {
      // Prefer the larger glyph (more likely the callout, not a tiny leader)
      if (s.w * s.h > near.w * near.h) {
        near.x = s.x; near.y = s.y; near.w = s.w; near.h = s.h; near.kind = s.kind;
        if (s.room_name) near.room_name = s.room_name;
      } else if (s.room_name && !near.room_name) {
        near.room_name = s.room_name;
      }
      continue;
    }
    kept.push({ ...s });
  }
  return kept;
}

/** Attach sheet ids and stable ids; link same-tag marks across sheets. */
export function buildPlanSymbolIndex(
  bySheet: Record<string, RawPlanSymbol[]>,
): PlanSymbol[] {
  const flat: PlanSymbol[] = [];
  for (const [sheet_id, list] of Object.entries(bySheet || {})) {
    (list || []).forEach((s, i) => {
      flat.push({
        ...s,
        id: `${sheet_id}::${s.tag}::${i}`,
        sheet_id,
        matches: [],
        schedule: {},
      });
    });
  }
  const byTag = new Map<string, PlanSymbol[]>();
  for (const s of flat) {
    const arr = byTag.get(s.tag) || [];
    arr.push(s);
    byTag.set(s.tag, arr);
  }
  for (const s of flat) {
    s.matches = (byTag.get(s.tag) || [])
      .filter((o) => o.id !== s.id)
      .map((o) => ({ sheet_id: o.sheet_id, x: o.x, y: o.y, kind: o.kind }));
  }
  return flat;
}

type CondLike = {
  finish_tag?: string;
  name?: string;
  description?: string;
  materials?: Array<{ name?: string; manufacturer?: string }>;
};
type RowLike = {
  finish_tag?: string;
  description?: string;
  manufacturer?: string;
  style?: string;
  spec_color?: string;
  size?: string;
  remarks?: string;
};

/** Fill schedule fields from imported schedule rows and/or conditions. */
export function enrichSymbolsWithSchedule(
  symbols: PlanSymbol[],
  opts: { conditions?: CondLike[]; rows?: RowLike[] } = {},
): PlanSymbol[] {
  const rowBy = new Map<string, RowLike>();
  for (const r of opts.rows || []) {
    const t = (r.finish_tag || "").trim().toUpperCase();
    if (t) rowBy.set(t, r);
  }
  const condBy = new Map<string, CondLike>();
  for (const c of opts.conditions || []) {
    const t = (c.finish_tag || "").trim().toUpperCase();
    if (t) condBy.set(t, c);
  }
  return symbols.map((s) => {
    const row = rowBy.get(s.tag);
    const cond = condBy.get(s.tag);
    const mat0 = cond?.materials?.[0];
    const schedule: SymbolScheduleInfo = {
      finish_tag: row?.finish_tag || cond?.finish_tag || (s.kind === "finish" ? s.tag : undefined),
      description: row?.description || cond?.description || cond?.name || undefined,
      manufacturer: row?.manufacturer || mat0?.manufacturer || undefined,
      style: row?.style || mat0?.name || undefined,
      color: row?.spec_color || undefined,
      size: row?.size || undefined,
      remarks: row?.remarks || undefined,
    };
    // Drop empty keys so the UI can treat missing as "enter manually"
    for (const k of Object.keys(schedule) as (keyof SymbolScheduleInfo)[]) {
      if (!schedule[k] || !String(schedule[k]).trim()) delete schedule[k];
    }
    return { ...s, schedule };
  });
}

/** Merge schedule + manual notes for display (manual wins on non-empty). */
export function resolveSymbolFields(
  schedule: SymbolScheduleInfo,
  notes?: SymbolNotes | null,
  roomName?: string | null,
): Required<SymbolNotes> & { finish_tag: string } {
  const n = notes || {};
  const pick = (a?: string, b?: string, c?: string) =>
    (a && String(a).trim()) || (b && String(b).trim()) || (c && String(c).trim()) || "";
  return {
    finish_tag: pick(schedule.finish_tag),
    room_name: pick(n.room_name, roomName || undefined),
    description: pick(n.description, schedule.description),
    manufacturer: pick(n.manufacturer, schedule.manufacturer),
    style: pick(n.style, schedule.style),
    color: pick(n.color, schedule.color),
    size: pick(n.size, schedule.size),
    remarks: pick(n.remarks, schedule.remarks),
    type: pick(n.type),
  };
}

/** Hit-test a point against symbol boxes (image px, panel-local). */
export function hitPlanSymbol(
  symbols: PlanSymbol[],
  sheet_id: string,
  x: number,
  y: number,
  pad = 2,
): PlanSymbol | null {
  let best: PlanSymbol | null = null;
  let bestD = Infinity;
  for (const s of symbols) {
    if (s.sheet_id !== sheet_id) continue;
    const hw = s.w / 2 + pad, hh = s.h / 2 + pad;
    if (x < s.x - hw || x > s.x + hw || y < s.y - hh || y > s.y + hh) continue;
    const d = Math.hypot(x - s.x, y - s.y);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

export const SYMBOL_KIND_LABEL: Record<SymbolKind, string> = {
  door: "Door mark",
  window: "Window mark",
  type: "Type mark",
  finish: "Finish code",
  detail: "Detail callout",
};
