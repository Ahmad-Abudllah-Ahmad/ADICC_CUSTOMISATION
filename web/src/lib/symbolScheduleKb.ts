// Project schedule knowledge-base — pure, pdfjs-free.
//
// Builds a lookup from plan marks (D01, PT-1, GD-02, …) to the detail rows
// extracted from schedule / schedule-like sheets in the uploaded plan set.
// Filename cues (WOODEN DOORS, FINISHES SCHEDULE) prioritize which sheets to
// parse; positioned PDF text tokens supply the fields. Source bbox is kept so
// hover can open a floating viewer scrolled to the exact schedule card.

export type SymbolToken = { str: string; x: number; y: number; h: number; w?: number };

export type SheetClass =
  | "door_schedule"
  | "window_schedule"
  | "finish_schedule"
  | "detail"
  | "other";

export type SourceBBox = { x: number; y: number; w: number; h: number };

/** One resolved schedule row keyed by a normalized plan mark. */
export interface ScheduleKbEntry {
  tag: string;                 // normalized mark, e.g. D01 / PT-1
  kind: "door" | "window" | "finish" | "type" | "detail";
  room_name?: string;
  description?: string;
  manufacturer?: string;
  style?: string;
  color?: string;
  size?: string;               // e.g. "W 1100 × H 2200 mm"
  remarks?: string;
  fire_rating?: string;
  floors?: string;
  type?: string;               // free-text type label from schedule title
  skirting_tag?: string;
  wall_tag?: string;
  ceiling_tag?: string;
  source_sheet: string;
  source_title: string;
  source_bbox: SourceBBox;
}

export interface SheetMeta {
  sheet_id: string;
  file_name: string;           // basename, e.g. A7101-WOODEN DOORS….pdf
}

/** Classify a sheet from its filename (and optional title-block text).
 *  Filename wins for DETAIL / DOORS / FINISHES so a detail sheet that merely
 *  mentions "hopper door" is never treated as a door schedule. */
export function classifySheetByName(fileName: string, pageText = ""): SheetClass {
  const fn = (fileName || "").toUpperCase();
  const pt = (pageText || "").toUpperCase();

  // Filename-first — hard classes
  if (/FINISH(ES)?\s*SCHEDU?A?LE|FINISHES?\s+SCHED|SCHEDUALE/.test(fn)) return "finish_schedule";
  // Jamb / typical detail sheets named “…DOORS…DETAILS” are not schedule cards
  if (/\bJAMB\s+DETAILS?\b|\bTYPICAL\s+DETAILS?\b/.test(fn)) return "detail";
  if (/WOODEN\s+DOORS|PRESSED\s+STEEL\s+DOORS|STEEL\s+DOORS|\bDOORS?\s*\(SHEET/i.test(fn)
    || /DOOR\s*SCHED/.test(fn)) {
    return "door_schedule";
  }
  // Curtain-wall / louvre / glazing / aluminum window sheets (CW-##, GD-##, LV-##)
  if (/\bWINDOWS?\b/.test(fn) || /WINDOW\s*SCHED/.test(fn)
    || /CURTAIN\s*WALL\s*SCHED|GLASS\s*DOOR\s*SCHED|LOUVRE\s*SCHED|GLAZING\s*SCHED/.test(fn)
    || (/ALUMIN(?:I)?UM/.test(fn) && /\b(WINDOW|CURTAIN|GLAZ|LOUVRE)/.test(fn))) {
    return "window_schedule";
  }
  // DETAIL / ENLARGEMENT in the filename wins over loose page-text "DOOR"
  if (/\bDETAILS?\b|\bENLARGEMENT\b/.test(fn)) return "detail";

  // Page-text fallback only when the filename is ambiguous (floor plans, etc.)
  if (/FINISH(ES)?\s*SCHEDU?A?LE|FINISHES?\s+SCHED/.test(pt)) return "finish_schedule";
  if (/WOODEN\s+DOOR\s+SCHED|DOOR\s+SCHEDULE|STEEL\s+DOOR\s+SCHED|DOOR\s*&\s*FRAME\s+SCHED/.test(pt)) {
    return "door_schedule";
  }
  if (/WINDOW\s+SCHED|CURTAIN\s+WALL\s+SCHED|GLASS\s+DOOR\s+SCHED|LOUVRE\s+SCHED/.test(pt)) {
    return "window_schedule";
  }
  return "other";
}

/** Normalize plan/schedule door marks: D-1, D1, D01 → D01; SD12 stays SD12; CW-01, GD-02. */
export function normalizeSymbolTag(raw: string): string {
  let t = (raw || "").trim().toUpperCase().replace(/\s+/g, "");
  if (/^\$D\d/.test(t)) t = `S${t.slice(1)}`;
  // Curtain wall / glass door / louvre: CW01 → CW-01, GD2 → GD-02
  let m = t.match(/^(CW|GD|LV)-?0*(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  // D-1 / D1 / D01 / D-01
  m = t.match(/^D-?0*(\d{1,3})([A-Z]?)$/);
  if (m) return `D${m[1].padStart(2, "0")}${m[2]}`;
  m = t.match(/^SD-?0*(\d{1,3})([A-Z]?)$/);
  if (m) return `SD${m[1]}${m[2]}`;
  m = t.match(/^W-?0*(\d{1,3})([A-Z]?)$/);
  if (m) return `W${m[1].padStart(2, "0")}${m[2]}`;
  return t;
}

/** Alternate keys a plan mark should try against the KB. */
export function tagLookupKeys(tag: string): string[] {
  const n = normalizeSymbolTag(tag);
  const keys = new Set<string>([n, tag.toUpperCase().replace(/\s+/g, "")]);
  const dm = n.match(/^D(\d{2,3})([A-Z]?)$/);
  if (dm) {
    const num = String(parseInt(dm[1], 10));
    keys.add(`D${dm[1]}${dm[2]}`);
    keys.add(`D-${num}${dm[2]}`);
    keys.add(`D${num}${dm[2]}`);
    keys.add(`D-${dm[1]}${dm[2]}`);
  }
  const sm = n.match(/^SD(\d{1,3})([A-Z]?)$/);
  if (sm) {
    keys.add(`SD${sm[1]}${sm[2]}`);
    keys.add(`SD-${sm[1]}${sm[2]}`);
  }
  const xm = n.match(/^(CW|GD|LV)-(\d{2})$/);
  if (xm) {
    keys.add(`${xm[1]}-${xm[2]}`);
    keys.add(`${xm[1]}${xm[2]}`);
    keys.add(`${xm[1]}${parseInt(xm[2], 10)}`);
    keys.add(`${xm[1]}-${parseInt(xm[2], 10)}`);
  }
  const fm = n.match(/^(PT|CPT|STN|RUB|EPD|SK|WP|WD|FC|PC)-([A-Z0-9]{1,4})$/);
  if (fm) {
    if (fm[1] === "PT" || fm[1] === "CPT") {
      keys.add(`PT-${fm[2]}`);
      keys.add(`CPT-${fm[2]}`);
    } else {
      keys.add(`${fm[1]}-${fm[2]}`);
    }
  }
  return [...keys];
}

function normRoomKey(s: string): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function roomKeyMatch(a: string, b: string): boolean {
  const na = normRoomKey(a);
  const nb = normRoomKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = na.split(" ").filter((w) => w.length > 2);
  const wb = nb.split(" ").filter((w) => w.length > 2);
  if (!wa.length || !wb.length) return false;
  const common = wa.filter((w) => wb.includes(w));
  return common.length >= 2 || (common.length === 1 && (wa.length === 1 || wb.length === 1));
}

function tokW(t: SymbolToken): number {
  return Math.max(t.w || 0, (t.str?.length || 1) * Math.max(6, t.h || 10) * 0.55);
}

function pageTextOf(tokens: SymbolToken[]): string {
  return tokens.map((t) => t.str || "").join(" ");
}

/**
 * Parse wooden door schedule cards from positioned tokens.
 * Real sheets mint a single title token like "Wooden Door Schedule _ D-7"
 * (not a bare "Schedule"); the card spans the floor column left of the title
 * through Fire Rating on the right.
 */
export function parseDoorScheduleTokens(
  tokens: SymbolToken[],
  meta: SheetMeta,
): ScheduleKbEntry[] {
  const toks = (tokens || []).filter((t) => (t.str || "").trim());
  if (!toks.length) return [];

  // Prefer full schedule-title anchors; accept a bare "Schedule" for tests / OCR
  const scheduleAnchors = toks.filter((t) => {
    const s = (t.str || "").trim();
    return /door\s+schedule/i.test(s) || /^schedule$/i.test(s);
  });
  if (!scheduleAnchors.length) {
    return parseDoorMarksLoose(toks, meta);
  }

  const out: ScheduleKbEntry[] = [];
  const seen = new Set<string>();

  for (const anch of scheduleAnchors) {
    // Card region: floors sit ~350–450px left of the title; W/H/fire ~800px right.
    // padYAbove covers synthetic/OCR layouts where Schedule sits below the card.
    const region = toks.filter((t) =>
      t.x >= anch.x - 450 && t.x <= anch.x + 1000
      && t.y >= anch.y - 220 && t.y <= anch.y + 320);

    const joined = region.map((t) => t.str).join(" ");
    const up = joined.toUpperCase();

    // Mark from title ("… _ D-7") or TYPE column (D07)
    let markRaw = "";
    const fromTitle = (anch.str || "").match(/\bD-?\d{1,3}[A-Z]?\b/i);
    if (fromTitle) markRaw = fromTitle[0];
    if (!markRaw) {
      const typeHit = region.find((t) => /^D0?\d{1,3}[A-Z]?$/i.test((t.str || "").trim()));
      const dashHit = region.find((t) => /^D-\d{1,3}[A-Z]?$/i.test((t.str || "").trim()));
      if (typeHit) markRaw = typeHit.str;
      else if (dashHit) markRaw = dashHit.str;
      else {
        const m = up.match(/\bD-?\d{1,3}[A-Z]?\b/);
        if (m) markRaw = m[0];
      }
    }
    if (!markRaw) continue;
    const tag = normalizeSymbolTag(markRaw);
    if (seen.has(tag)) continue;
    seen.add(tag);

    // Fire rating: number near "Fire" / "MIN" / "NFR"
    let fire_rating = "";
    if (/\bNFR\b/.test(up)) fire_rating = "NFR";
    const fireTok = region.find((t) => /fire/i.test((t.str || "").trim()));
    if (!fire_rating && fireTok) {
      const near = region
        .filter((t) => Math.abs(t.y - fireTok.y) < 50 && Math.abs(t.x - fireTok.x) < 140)
        .map((t) => t.str)
        .join(" ");
      if (/\bNFR\b/i.test(near)) fire_rating = "NFR";
      else {
        const fm = near.match(/(\d+)\s*(?:MIN\.?)?/i);
        if (fm) fire_rating = `${fm[1]} MIN`;
      }
    }
    if (!fire_rating) {
      const rowFire = region.find((t) => /^\d+\s*MIN\.?$/i.test((t.str || "").trim())
        || /^NFR$/i.test((t.str || "").trim()));
      if (rowFire) {
        fire_rating = /^NFR$/i.test(rowFire.str.trim())
          ? "NFR"
          : `${(rowFire.str.match(/(\d+)/) || [])[1]} MIN`;
      }
    }
    if (!fire_rating) {
      const fm = up.match(/(\d+)\s*MIN/);
      if (fm) fire_rating = `${fm[1]} MIN`;
    }

    // Structural opening W / H — numbers may sit left OR right of the W/H label
    let wMm = "", hMm = "";
    const nearestDim = (labelChar: string) => {
      const label = region.find((t) => new RegExp(`^${labelChar}$`, "i").test((t.str || "").trim()));
      if (!label) return "";
      const cands = region
        .filter((t) => /^\d{3,4}$/.test((t.str || "").trim())
          && Math.abs(t.y - label.y) < 50
          && Math.abs(t.x - label.x) < 50)
        .sort((a, b) => Math.abs(a.y - label.y) - Math.abs(b.y - label.y)
          || Math.abs(a.x - label.x) - Math.abs(b.x - label.x));
      return cands[0] ? cands[0].str.trim() : "";
    };
    wMm = nearestDim("W");
    hMm = nearestDim("H");
    // Row under TYPE: first two 3–4 digit dims are W then H (A7102 layout)
    if (!wMm || !hMm) {
      const typeCell = region.find((t) => normalizeSymbolTag(t.str || "") === tag);
      if (typeCell) {
        const dims = region
          .filter((t) => /^\d{3,4}$/.test((t.str || "").trim())
            && Math.abs(t.y - typeCell.y) < 14
            && t.x > typeCell.x)
          .sort((a, b) => a.x - b.x)
          .map((t) => t.str.trim());
        if (!wMm && dims[0]) wMm = dims[0];
        if (!hMm && dims[1]) hMm = dims[1];
      }
    }
    if (!wMm) {
      const bm = joined.match(/(\d{3,4})\s*mm\s*BLOCKWORK\s*TO\s*BLOCKWORK\s*SIZE/i)
        || up.match(/STRUCTUR\w*\s+OPENING[\s\S]{0,40}?(\d{3,4})/i);
      if (bm) wMm = bm[1];
    }
    if (!hMm) {
      const bm = joined.match(/(\d{3,4})\s*mm\s*BLOCKWORK\s*HEIGHT/i);
      if (bm) hMm = bm[1];
    }
    if (!wMm || !hMm) {
      const pair = up.match(/STRUCTUR\w*[\s\S]{0,60}?(\d{3,4})[\s\S]{0,40}?(\d{3,4})/);
      if (pair) {
        if (!wMm) wMm = pair[1];
        if (!hMm) hMm = pair[2];
      }
    }

    // Room: words near ROOM label (often to the right / below)
    let room_name = "";
    const roomLabel = region.find((t) => /^room$/i.test((t.str || "").trim()));
    if (roomLabel) {
      const names = region
        .filter((t) => {
          const s = (t.str || "").trim();
          if (!s || /^room$/i.test(s) || /^\d+$/.test(s)) return false;
          if (Math.abs(t.y - roomLabel.y) > 120) return false;
          // Room names sit under/near the ROOM header (slightly left/right of it)
          if (t.x < roomLabel.x - 120) return false;
          if (t.x > roomLabel.x + 220) return false;
          if (/schedule/i.test(s)) return false;
          if (/^(DOOR|TYPE|NO\.|OF|DOORS|PER|FLOOR|LEAVES|W|H|FIRE|RATING|WOODEN|STEEL|PRESSED|SCHEDULE|INFO|STRUCTURAL|STRUCTRUAL|OPENING)$/i.test(s)) return false;
          return /[A-Za-z]{3,}/.test(s);
        })
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((t) => t.str.trim().toUpperCase());
      const uniq: string[] = [];
      for (const n of names) if (uniq[uniq.length - 1] !== n) uniq.push(n);
      room_name = uniq.slice(0, 4).join("; ").replace(/\s+/g, " ").trim();
      if (uniq.includes("SERVICE") && uniq.includes("CORRIDOR")) room_name = "SERVICE CORRIDOR";
      if (uniq.includes("BEDROOM") && uniq.includes("KITCHEN")) room_name = "BEDROOM & KITCHEN";
      if (uniq.some((u) => /\bGARBAGE\b/.test(u)) || /\bGARBAGE\b/.test(up)) room_name = "GARBAGE ROOM";
      if (uniq.every((u) => u === "STAIRCASE") && uniq.length) room_name = "STAIRCASE";
      if (uniq.some((u) => /\bTOILET\b/.test(u)) && uniq.some((u) => /\bBATHROOM\b|\bSTORE\b/.test(u))) {
        room_name = "TOILET, STORE & BATHROOM";
      } else if (uniq.includes("TOILET") || /\bTOILET\b/.test(up)) {
        if (!room_name || room_name === "TOILET") room_name = "TOILET";
      }
    }
    if (!room_name) {
      if (/\bGARBAGE\b/.test(up)) room_name = "GARBAGE ROOM";
      else if (/\bSERVICE\s+CORRIDOR\b/.test(up)) room_name = "SERVICE CORRIDOR";
      else if (/\bSTAIRCASE\b/.test(up)) room_name = "STAIRCASE";
      else if (/\bTOILET\b/.test(up) && /\bBATHROOM\b/.test(up)) room_name = "TOILET, STORE & BATHROOM";
      else if (/\bBATHROOM\b/.test(up) && /\bSTORE\b/.test(up)) room_name = "BATHROOM & STORE";
      else if (/\bBEDROOM\b/.test(up) && /\bKITCHEN\b/.test(up)) room_name = "BEDROOM & KITCHEN";
      else if (/\bKIDS\s+AREA\b/.test(up)) {
        room_name = /\bFLAT\s+ENTRANCE\b/.test(up)
          ? "KIDS AREA, MPU & LOUNGE; FLAT ENTRANCE"
          : "KIDS AREA, MPU & LOUNGE";
      }
      else if (/\bFLAT\s+ENTRANCE\b/.test(up)) room_name = "FLAT ENTRANCE";
      else if (/\bTOILET\b/.test(up)) room_name = "TOILET";
      else if (/\bTERRACE\b/.test(up)) room_name = "TERRACE";
      else if (/\bLOUNGE\b/.test(up)) room_name = "LOUNGE / ENTRANCE";
      else if (/\bENTRANCE\b/.test(up)) room_name = "ENTRANCE";
    }

    // Floors: 1ST / 2ND TO 25TH / 26TH (often a vertical column left of ROOM)
    const floorBits: string[] = [];
    const floorToks = region
      .filter((t) => /\b(\d+(?:ST|ND|RD|TH)\s+FLOOR|TO\s+\d+(?:ST|ND|RD|TH)\s+FLOOR)\b/i.test(t.str || ""))
      .sort((a, b) => a.y - b.y);
    for (const ft of floorToks) {
      const s = ft.str.trim().toUpperCase().replace(/\s+/g, " ");
      if (!floorBits.includes(s)) floorBits.push(s);
    }
    if (!floorBits.length) {
      if (/\b1ST\b/.test(up)) floorBits.push("1ST FLOOR");
      if (/2ND[\s\S]{0,12}25TH|TO\s*25TH/.test(up)) floorBits.push("2ND FLOOR TO 25TH FLOOR");
      else if (/\b2ND\b/.test(up)) floorBits.push("2ND FLOOR");
      if (/\b26TH\b/.test(up)) floorBits.push("26TH FLOOR");
      if (/\b27TH\b/.test(up)) floorBits.push("27TH FLOOR");
    }
    const floors = floorBits.join("; ");

    let type = "";
    if (/WOODEN/i.test(joined) || /WOODEN/i.test(meta.file_name)) type = `Wooden Door ${tag}`;
    else if (/STEEL|PRESSED/i.test(joined) || /STEEL|PRESSED/i.test(meta.file_name)) type = `Pressed Steel Door ${tag}`;
    else type = `Door ${tag}`;

    const xs = region.map((t) => t.x);
    const ys = region.map((t) => t.y - (t.h || 10));
    const x1s = region.map((t) => t.x + tokW(t));
    const y1s = region.map((t) => t.y + (t.h || 10) * 0.2);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const x1 = Math.max(...x1s), y1 = Math.max(...y1s);

    const size = (wMm || hMm)
      ? `W ${wMm || "—"} × H ${hMm || "—"} mm`
      : undefined;

    const remarks = [
      fire_rating ? `Fire rating: ${fire_rating}` : "",
      floors ? `Floors: ${floors}` : "",
    ].filter(Boolean).join(" · ");

    out.push({
      tag,
      kind: "door",
      room_name: room_name || undefined,
      description: [
        type,
        size,
        fire_rating ? `Fire rating ${fire_rating}` : "",
        floors ? `Used on ${floors}` : "",
        room_name ? `Room: ${room_name}` : "",
      ].filter(Boolean).join(" — "),
      size,
      fire_rating: fire_rating || undefined,
      floors: floors || undefined,
      type,
      remarks: remarks || undefined,
      source_sheet: meta.sheet_id,
      source_title: meta.file_name.replace(/\.pdf$/i, ""),
      source_bbox: { x: x0, y: y0, w: Math.max(40, x1 - x0), h: Math.max(40, y1 - y0) },
    });
  }
  return out;
}

/** Loose fallback — only for true door-schedule filenames (never detail sheets). */
function parseDoorMarksLoose(toks: SymbolToken[], meta: SheetMeta): ScheduleKbEntry[] {
  if (classifySheetByName(meta.file_name) !== "door_schedule") return [];
  const out: ScheduleKbEntry[] = [];
  const seen = new Set<string>();
  for (const t of toks) {
    const raw = (t.str || "").trim();
    if (!/^D-?\d{1,3}[A-Z]?$/i.test(raw) && !/^D0\d{1,2}[A-Z]?$/i.test(raw)) continue;
    const tag = normalizeSymbolTag(raw);
    if (seen.has(tag)) continue;
    seen.add(tag);
    const h = Math.max(6, t.h || 10);
    const w = tokW(t);
    out.push({
      tag,
      kind: "door",
      type: `Door ${tag}`,
      description: `Door ${tag} — see ${meta.file_name.replace(/\.pdf$/i, "")}`,
      source_sheet: meta.sheet_id,
      source_title: meta.file_name.replace(/\.pdf$/i, ""),
      source_bbox: { x: t.x, y: t.y - h, w: Math.max(w, h * 4), h: h * 8 },
    });
  }
  return out;
}

/**
 * Pressed-steel "DOOR & FRAME SCHEDULE" cards (SD1…): fire, RAL, handing, qty,
 * and MATERIALS block under each type mark.
 */
export function parseSteelDoorFrameSchedule(
  tokens: SymbolToken[],
  meta: SheetMeta,
): ScheduleKbEntry[] {
  const toks = (tokens || []).filter((t) => (t.str || "").trim());
  if (!toks.length) return [];
  const pageUp = pageTextOf(toks).toUpperCase();
  if (!/DOOR\s*&\s*FRAME\s+SCHED|PRESSED\s+STEEL|STEEL\s+DOOR/.test(pageUp)
    && !/PRESSED\s+STEEL|STEEL\s+DOOR/.test((meta.file_name || "").toUpperCase())) {
    return [];
  }

  const out: ScheduleKbEntry[] = [];
  const seen = new Set<string>();
  // Prefer the schedule-table SD token (near "DOOR TYPE"), not the elevation bubble
  const marks = toks.filter((t) => /^SD-?\d{1,3}[A-Z]?$/i.test((t.str || "").trim()));
  for (const mt of marks) {
    const tag = normalizeSymbolTag(mt.str);
    if (seen.has(tag)) continue;
    const nearHeader = toks.some((t) =>
      /DOOR\s*TYPE|FIRE\s*RATING|DOOR\s*&\s*FRAME/i.test(t.str || "")
      && Math.abs(t.y - mt.y) < 80
      && Math.abs(t.x - mt.x) < 280);
    if (!nearHeader) continue;
    seen.add(tag);

    const region = toks.filter((t) =>
      t.x >= mt.x - 80 && t.x <= mt.x + 420
      && t.y >= mt.y - 90 && t.y <= mt.y + 140);

    const fireTok = region.find((t) => /^\d+\s*MIN\.?$/i.test((t.str || "").trim())
      || /^N\/?A$/i.test((t.str || "").trim())
      || /^NFR$/i.test((t.str || "").trim()));
    let fire_rating = "";
    if (fireTok) {
      const s = fireTok.str.trim().toUpperCase();
      fire_rating = /^NFR$|^N\/?A$/.test(s) ? (s.startsWith("N/") ? "N/A" : "NFR")
        : `${(s.match(/(\d+)/) || [])[1]} MIN`;
    }

    // Row values to the right of the type mark: RAL, handing, qty
    const rowVals = region
      .filter((t) => Math.abs(t.y - mt.y) < 16 && t.x > mt.x + 20)
      .sort((a, b) => a.x - b.x);
    const ral = rowVals.find((t) => /^TBC$|^RAL\s*\d+/i.test(t.str.trim()) || /^\d{4}$/.test(t.str.trim()));
    const handing = rowVals.find((t) => /^(LH|RH|LHR|RHR|TBC)$/i.test(t.str.trim()));
    const qty = [...rowVals].reverse().find((t) => /^\d{1,3}$/.test(t.str.trim()));

    const frame = region.find((t) => /1\.5\s*mm\s*Steel/i.test(t.str || ""));
    const leaf = region.find((t) => /1\.2\s*mm\s*Steel/i.test(t.str || ""));
    const infill = region.find((t) => /MINERAL\s*WOOL|DOOR\s*IN-?FILL/i.test(t.str || ""));
    const materials = [
      frame ? `Frame ${frame.str.replace(/^:\s*/, "").trim()}` : "Frame: 1.5mm Steel Sheet",
      leaf ? `Door leaf ${leaf.str.replace(/^:\s*/, "").trim()}` : "Door leaf: 1.2mm Steel Sheet",
      infill ? (infill.str.includes(":") ? infill.str.trim() : "Door in-fill: Mineral Wool")
        : "Door in-fill: Mineral Wool",
    ].join("; ");

    const color = ral ? (/^\d{4}$/.test(ral.str.trim()) ? `RAL ${ral.str.trim()}` : ral.str.trim().toUpperCase()) : undefined;
    const style = handing ? `Handing ${handing.str.trim().toUpperCase()}` : undefined;
    const size = qty ? `Qty ${qty.str.trim()}` : undefined;
    const type = `Pressed Steel Door ${tag}`;
    const remarks = [materials, size].filter(Boolean).join(" · ");

    const xs = region.map((t) => t.x);
    const ys = region.map((t) => t.y - (t.h || 10));
    const x1s = region.map((t) => t.x + tokW(t));
    const y1s = region.map((t) => t.y + (t.h || 10) * 0.2);

    out.push({
      tag,
      kind: "door",
      type,
      description: [
        type,
        fire_rating ? `Fire rating ${fire_rating}` : "",
        color ? `Color ${color}` : "",
        style || "",
        size || "",
        materials,
      ].filter(Boolean).join(" — "),
      fire_rating: fire_rating || undefined,
      color,
      style,
      size,
      remarks: remarks || undefined,
      manufacturer: "Pressed steel",
      source_sheet: meta.sheet_id,
      source_title: meta.file_name.replace(/\.pdf$/i, ""),
      source_bbox: {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(40, Math.max(...x1s) - Math.min(...xs)),
        h: Math.max(40, Math.max(...y1s) - Math.min(...ys)),
      },
    });
  }
  return out;
}

/**
 * Curtain-wall / glass-door / louvre schedule tables on aluminum window sheets:
 * Type Mark + Width / Height / Count (+ Fire Rated for GD).
 */
export function parseElevationTypeTables(
  tokens: SymbolToken[],
  meta: SheetMeta,
): ScheduleKbEntry[] {
  const toks = (tokens || []).filter((t) => (t.str || "").trim());
  if (!toks.length) return [];

  const out: ScheduleKbEntry[] = [];
  const seen = new Set<string>();
  const marks = toks.filter((t) => /^(CW|GD|LV)-?\d{1,2}$/i.test((t.str || "").trim()));

  for (const mt of marks) {
    const tag = normalizeSymbolTag(mt.str);
    if (seen.has(tag)) continue;
    // Prefer the schedule-table mark (near Width/Height), skip elevation bubbles
    const nearTable = toks.some((t) =>
      /^(WIDTH|HEIGHT|COUNT|TYPE|MARK|FIRE)$/i.test((t.str || "").trim())
      && Math.abs(t.y - mt.y) < 100
      && Math.abs(t.x - mt.x) < 320);
    if (!nearTable) continue;
    seen.add(tag);

    const region = toks.filter((t) =>
      t.x >= mt.x - 60 && t.x <= mt.x + 700
      && t.y >= mt.y - 130 && t.y <= mt.y + 50);

    const widthHdr = region.find((t) => /^width$/i.test((t.str || "").trim()));
    const heightHdr = region.find((t) => /^height$/i.test((t.str || "").trim()));
    const countHdr = region.find((t) => /^count$/i.test((t.str || "").trim()));

    const under = (hdr: SymbolToken | undefined) => {
      if (!hdr) return "";
      const hit = region
        .filter((t) => Math.abs(t.y - mt.y) < 16
          && Math.abs(t.x - hdr.x) < 80
          && t !== mt
          && /[\d*]/.test(t.str || ""))
        .sort((a, b) => Math.abs(a.x - hdr.x) - Math.abs(b.x - hdr.x))[0];
      return hit ? hit.str.trim() : "";
    };

    let width = under(widthHdr);
    let height = under(heightHdr);
    let count = under(countHdr);

    // Fallback: values on the same baseline to the right of the mark
    if (!width || !height) {
      const row = region
        .filter((t) => Math.abs(t.y - mt.y) < 14 && t.x > mt.x + 10 && /[\d*]/.test(t.str || ""))
        .sort((a, b) => a.x - b.x);
      if (!width && row[0]) width = row[0].str.trim();
      if (!height && row[1]) height = row[1].str.trim();
      if (!count && row[2]) count = row[2].str.trim();
    }

    let fire_rating = "";
    const fireTok = region.find((t) => /^\d+\s*MIN\.?$/i.test((t.str || "").trim())
      || /^NFR$/i.test((t.str || "").trim())
      || /^N\/?A$/i.test((t.str || "").trim()));
    if (fireTok) {
      const s = fireTok.str.trim().toUpperCase();
      fire_rating = /^NFR$|^N\/?A$/.test(s) ? (s.startsWith("N/") ? "N/A" : "NFR")
        : `${(s.match(/(\d+)/) || [])[1]} MIN`;
    }

    const kindPrefix = tag.startsWith("CW") ? "Curtain Wall"
      : tag.startsWith("GD") ? "Glass Door"
        : tag.startsWith("LV") ? "Louvre"
          : "Type";
    const type = `${kindPrefix} ${tag}`;
    const size = (width || height)
      ? `W ${width || "—"} × H ${height || "—"} mm`
      : undefined;
    const remarks = [
      count ? `Count ${count}` : "",
      fire_rating ? `Fire rating: ${fire_rating}` : "",
      tag.startsWith("GD") ? "Glazing: see legend (C1)" : "",
      tag.startsWith("LV") ? "Material: Aluminum Louvre (C4)" : "",
      tag.startsWith("CW") ? "See curtain-wall legend (C1–C6)" : "",
    ].filter(Boolean).join(" · ");

    const titleTok = region.find((t) =>
      /curtain\s+wall\s+schedule|glass\s+door\s+schedule|louvre\s+schedule/i.test(t.str || ""));
    const boxToks = titleTok ? region : [mt, ...region];
    const xs = boxToks.map((t) => t.x);
    const ys = boxToks.map((t) => t.y - (t.h || 10));
    const x1s = boxToks.map((t) => t.x + tokW(t));
    const y1s = boxToks.map((t) => t.y + (t.h || 10) * 0.2);

    out.push({
      tag,
      kind: tag.startsWith("GD") ? "door" : "window",
      type,
      description: [
        type,
        size,
        count ? `Count ${count}` : "",
        fire_rating ? `Fire rating ${fire_rating}` : "",
      ].filter(Boolean).join(" — "),
      size,
      fire_rating: fire_rating || undefined,
      remarks: remarks || undefined,
      source_sheet: meta.sheet_id,
      source_title: meta.file_name.replace(/\.pdf$/i, ""),
      source_bbox: {
        x: Math.min(...xs) - 8,
        y: Math.min(...ys) - 8,
        w: Math.max(40, Math.max(...x1s) - Math.min(...xs) + 16),
        h: Math.max(40, Math.max(...y1s) - Math.min(...ys) + 16),
      },
    });
  }
  return out;
}

function normFloorKey(s: string): string {
  return normRoomKey(s);
}

/** 0–100: how well a schedule floor band matches the open plan sheet floor. */
function floorKeyMatch(sheetFloor: string, entryFloors: string): number {
  const sf = normFloorKey(sheetFloor);
  const ef = normFloorKey(entryFloors);
  if (!sf || !ef) return 0;
  if (ef === sf || ef.includes(sf) || sf.includes(ef)) return 100;
  const sn = sf.match(/\b(\d+)(ST|ND|RD|TH)\b/);
  const range = ef.match(/\b(\d+)(ST|ND|RD|TH)\s*-\s*(\d+)(ST|ND|RD|TH)\b/);
  if (sn && range) {
    const n = parseInt(sn[1], 10);
    const lo = parseInt(range[1], 10);
    const hi = parseInt(range[3], 10);
    if (n >= lo && n <= hi) return 95;
  }
  if (/\b1ST\b/.test(sf) && /\b1ST\b/.test(ef) && /PODIUM|PLAN/.test(ef)) return 85;
  if (/\bGROUND\b/.test(sf) && /\bGROUND\b/.test(ef)) return 100;
  return 0;
}

function finishLinesFromTokens(tokens: SymbolToken[]): { y: number; text: string; tokens: SymbolToken[] }[] {
  const toks = (tokens || []).filter((t) => (t.str || "").trim())
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (!toks.length) return [];
  const lines: { y: number; text: string; tokens: SymbolToken[] }[] = [];
  let cur: SymbolToken[] = [];
  let cy = 0;
  for (const t of toks) {
    const tol = Math.max(t.h * 0.65, 4);
    if (cur.length && Math.abs(t.y - cy) > tol) {
      lines.push({
        y: cy,
        text: cur.map((x) => x.str.trim()).join(" ").replace(/\s+/g, " ").trim(),
        tokens: cur,
      });
      cur = [];
    }
    cur.push(t);
    cy = cur.reduce((s, w) => s + w.y, 0) / cur.length;
  }
  if (cur.length) {
    lines.push({
      y: cy,
      text: cur.map((x) => x.str.trim()).join(" ").replace(/\s+/g, " ").trim(),
      tokens: cur,
    });
  }
  return lines;
}

function isFinishesTablePage(text: string): boolean {
  const up = (text || "").toUpperCase();
  return /FINISHES?\s*SCHED/.test(up)
    && (/SPACE\s*NAME/.test(up) || /FLOOR\s*FINISH/.test(up));
}

const FINISH_CODE_RE = /^[A-Z]{2,4}-[A-Z0-9]{1,4}$/;
const FLOOR_FINISH_MARK_RE = /^(PT|STN|RUB|EPD|CPT|LVT|VCT|RB|ACT|SK|WP|WD|FC|PC)-[A-Z0-9]{1,4}$/i;

function isFloorSectionHeader(text: string): string | null {
  const up = (text || "").toUpperCase().trim().replace(/\s+/g, " ");
  if (!up || up.length > 90) return null;
  if (/^(GROUND\s+FLOOR|BASEMENT\b|PODIUM\b|PENTHOUSE\b)/.test(up)) return up;
  if (/\bFLOOR\s+PLAN\b/.test(up)) return up;
  if (/\d+(ST|ND|RD|TH)\s*-\s*\d+(ST|ND|RD|TH)\s+FLOOR/.test(up)) return up;
  if (/\d+(ST|ND|RD|TH)\s+FLOOR/.test(up) && !FINISH_CODE_RE.test(up.replace(/\s+/g, ""))) return up;
  return null;
}

/**
 * A0002-style tabular finishes schedule: floor band → space name → floor-finish
 * description → mark (PT-1, STN-1, …) in the Floor Finish column.
 */
export function parseFinishesScheduleTable(
  tokens: SymbolToken[],
  meta: SheetMeta,
): ScheduleKbEntry[] {
  const lines = finishLinesFromTokens(tokens);
  if (!lines.length) return [];
  const pageText = lines.map((l) => l.text).join(" ");
  if (!isFinishesTablePage(pageText)) return [];

  let spaceColX = -1;
  let floorFinishColX = -1;
  let skirtingColX = -1;
  for (const line of lines) {
    const up = line.text.toUpperCase();
    if (!/SPACE/.test(up) || !/FLOOR/.test(up) || !/FINISH/.test(up)) continue;
    for (const t of line.tokens) {
      const u = (t.str || "").toUpperCase();
      if (/SPACE/.test(u)) spaceColX = spaceColX < 0 ? t.x : Math.min(spaceColX, t.x);
      if (/FLOOR/.test(u) && /FINISH/.test(u)) floorFinishColX = t.x;
      if (/SKIRTING/.test(u)) skirtingColX = t.x;
    }
    if (floorFinishColX >= 0) break;
  }

  const out: ScheduleKbEntry[] = [];
  const byKey = new Map<string, ScheduleKbEntry>();
  let floorCtx = "";

  for (const line of lines) {
    const section = isFloorSectionHeader(line.text);
    if (section) {
      floorCtx = section;
      continue;
    }
    const up = line.text.toUpperCase();
    if (/^(SPACE\s*NAME|FLOOR\s*FINISH|SKIRTING|WALL\s*FINISH|CEILING|MARK|LEGEND|PT\s|STN\s|RUB\s|EPD\s|SK\s|WP\s|WD\s|FC\s|PC\s)/.test(up)) continue;
    if (/^(PROJECT|DRAWING|SCALE|REVISION|GENERAL\s+NOTES|SHEET\s+NO)/.test(up)) continue;

    const marks = line.tokens.filter((t) => {
      const tag = (t.str || "").trim().toUpperCase().replace(/\s+/g, "");
      return FINISH_CODE_RE.test(tag);
    });
    if (!marks.length) continue;

    let floorMark = marks[0];
    if (floorFinishColX >= 0) {
      const floorMarks = marks.filter((m) => {
        const tag = (m.str || "").trim().toUpperCase().replace(/\s+/g, "");
        return FLOOR_FINISH_MARK_RE.test(tag);
      });
      if (floorMarks.length) {
        const rightBound = skirtingColX >= 0 ? skirtingColX - 8 : Infinity;
        floorMark = floorMarks.find((m) => m.x >= floorFinishColX - 24 && m.x < rightBound)
          || floorMarks.find((m) => m.x >= floorFinishColX - 24)
          || floorMarks[0];
      }
    } else {
      const floorType = marks.find((m) => FLOOR_FINISH_MARK_RE.test((m.str || "").trim().toUpperCase().replace(/\s+/g, "")));
      if (floorType) floorMark = floorType;
    }

    const tag = (floorMark.str || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!FINISH_CODE_RE.test(tag)) continue;

    const normMark = (t: SymbolToken) => (t.str || "").trim().toUpperCase().replace(/\s+/g, "");
    const skirtingMark = marks.find((m) => m !== floorMark && /^SK-/i.test(normMark(m)));
    const wallMark = marks.find((m) => /^(WP|WD)-/i.test(normMark(m)));
    const ceilingMark = marks.find((m) => /^(FC|PC)-/i.test(normMark(m)));

    const splitX = floorFinishColX >= 0
      ? floorFinishColX - 12
      : (spaceColX >= 0 ? spaceColX + 80 : floorMark.x - 120);
    const spaceTokens = line.tokens.filter((t) => t.x < splitX && t !== floorMark);
    const room_name = spaceTokens.map((t) => t.str.trim()).join(" ").replace(/\s+/g, " ").trim();

    const descTokens = line.tokens.filter((t) => t.x >= splitX && t.x < floorMark.x - 4);
    let description = descTokens.map((t) => t.str.trim()).join(" ").replace(/\s+/g, " ").trim();
    if (!description) {
      description = line.text
        .replace(new RegExp(`\\b${tag.replace("-", "\\-")}\\b`, "i"), "")
        .replace(room_name, "")
        .replace(/\b(SK|WP|WD|FC|PC|STN|RUB|EPD)-[A-Z0-9]{1,4}\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    if (!description || description.length < 8) continue;

    const h = Math.max(6, floorMark.h || 10);
    const entry: ScheduleKbEntry = {
      tag,
      kind: "finish",
      room_name: room_name || undefined,
      floors: floorCtx || undefined,
      description,
      skirting_tag: skirtingMark ? normMark(skirtingMark) : undefined,
      wall_tag: wallMark ? normMark(wallMark) : undefined,
      ceiling_tag: ceilingMark ? normMark(ceilingMark) : undefined,
      source_sheet: meta.sheet_id,
      source_title: meta.file_name.replace(/\.pdf$/i, ""),
      source_bbox: {
        x: Math.min(...line.tokens.map((t) => t.x)) - 8,
        y: floorMark.y - h * 2,
        w: Math.max(tokW(floorMark) + 220, 240),
        h: h * 8,
      },
    };
    const dedupeKey = `${tag}::${normRoomKey(room_name)}::${normFloorKey(floorCtx)}`;
    const prev = byKey.get(dedupeKey);
    if (!prev || (description.length > (prev.description?.length || 0))) byKey.set(dedupeKey, entry);
  }

  for (const e of byKey.values()) out.push(e);
  return out;
}

/**
 * Parse a finishes schedule sheet: each finish code picks up the nearest
 * preceding description paragraph (room-grouped Estidama / ID format).
 */
export function parseFinishScheduleTokens(
  tokens: SymbolToken[],
  meta: SheetMeta,
): ScheduleKbEntry[] {
  const tableRows = parseFinishesScheduleTable(tokens, meta);
  if (tableRows.length) return tableRows;

  const toks = (tokens || []).filter((t) => (t.str || "").trim())
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (!toks.length) return [];

  // Cluster into visual lines
  const lines: { y: number; text: string; tokens: SymbolToken[] }[] = [];
  let cur: SymbolToken[] = [];
  let cy = 0;
  for (const t of toks) {
    const tol = Math.max(t.h * 0.65, 4);
    if (cur.length && Math.abs(t.y - cy) > tol) {
      lines.push({
        y: cy,
        text: cur.map((x) => x.str.trim()).join(" ").replace(/\s+/g, " ").trim(),
        tokens: cur,
      });
      cur = [];
    }
    cur.push(t);
    cy = cur.reduce((s, w) => s + w.y, 0) / cur.length;
  }
  if (cur.length) {
    lines.push({
      y: cy,
      text: cur.map((x) => x.str.trim()).join(" ").replace(/\s+/g, " ").trim(),
      tokens: cur,
    });
  }

  const out: ScheduleKbEntry[] = [];
  const byTag = new Map<string, ScheduleKbEntry>();
  let pendingDesc: string[] = [];
  let roomCtx = "";

  for (const line of lines) {
    const up = line.text.toUpperCase();
    // Room header: "14.STORE" / "09. TOILETS"
    const roomM = up.match(/^(\d{1,2})\.\s*([A-Z][A-Z0-9 &/'/-]{2,40})$/);
    if (roomM) {
      roomCtx = roomM[2].trim();
      pendingDesc = [];
      continue;
    }
    // Skip title-block noise
    if (/^(PROJECT|DRAWING|SCALE|REVISION|GENERAL NOTES)/.test(up)) continue;

    // Line that is ONLY a finish code (or code + short suffix)
    const codeTok = line.tokens.find((t) => FINISH_CODE_RE.test((t.str || "").trim().toUpperCase().replace(/\s+/g, "")));
    const onlyCode = FINISH_CODE_RE.test(up.replace(/\s+/g, ""))
      || (codeTok && line.text.trim().length <= 12);

    if (codeTok && (onlyCode || FINISH_CODE_RE.test((codeTok.str || "").trim().toUpperCase()))) {
      const tag = (codeTok.str || "").trim().toUpperCase().replace(/\s+/g, "");
      if (!FINISH_CODE_RE.test(tag)) {
        pendingDesc.push(line.text);
        continue;
      }
      const desc = pendingDesc.join(" ").replace(/\s+/g, " ").trim();
      pendingDesc = [];
      const h = Math.max(6, codeTok.h || 10);
      const entry: ScheduleKbEntry = {
        tag,
        kind: "finish",
        room_name: roomCtx || undefined,
        description: desc || undefined,
        source_sheet: meta.sheet_id,
        source_title: meta.file_name.replace(/\.pdf$/i, ""),
        source_bbox: {
          x: codeTok.x - 8,
          y: codeTok.y - h * 6,
          w: Math.max(tokW(codeTok) + 16, 180),
          h: h * 10,
        },
      };
      // Keep one row per finish tag per room group (same tag can repeat under different rooms).
      const dedupeKey = `${tag}::${normRoomKey(roomCtx)}`;
      const prev = byTag.get(dedupeKey);
      if (!prev || ((desc?.length || 0) > (prev.description?.length || 0))) {
        byTag.set(dedupeKey, entry);
      }
      continue;
    }
    // Accumulate description prose
    if (line.text.length > 3 && !/^[A-Z]{1,3}\d{4}/.test(up)) {
      pendingDesc.push(line.text);
      if (pendingDesc.length > 6) pendingDesc.shift();
    }
  }

  for (const e of byTag.values()) out.push(e);
  return out;
}

/**
 * Build KB entries from one sheet's tokens, using filename to pick the parser.
 */
export function extractScheduleKbFromSheet(
  tokens: SymbolToken[],
  meta: SheetMeta,
): ScheduleKbEntry[] {
  const pageSlice = pageTextOf(tokens).slice(0, 4000);
  // Classify on the basename — a parent folder named DETAILS/ must not force
  // every PDF under it into the detail class and skip real schedule parsers.
  const baseName = (meta.file_name || "").replace(/\\/g, "/").split("/").pop() || meta.file_name;
  const cls = classifySheetByName(baseName, pageSlice);
  if (cls === "door_schedule") {
    const wooden = parseDoorScheduleTokens(tokens, meta);
    const steel = parseSteelDoorFrameSchedule(tokens, meta);
    // Prefer steel parser results on pressed-steel sheets; merge both otherwise
    if (/PRESSED\s+STEEL|STEEL\s+DOOR/i.test(meta.file_name) || /DOOR\s*&\s*FRAME\s+SCHED/i.test(pageSlice)) {
      return steel.length ? steel : wooden;
    }
    return [...wooden, ...steel];
  }
  if (cls === "window_schedule") {
    const elev = parseElevationTypeTables(tokens, meta);
    if (elev.length) return elev;
    // Fallback for window sheets that use wooden-style cards
    return parseDoorScheduleTokens(tokens, meta).map((e) => ({
      ...e,
      kind: "window" as const,
      type: (e.type || "").replace(/^Door/, "Window").replace(/Door /, "Window "),
      description: (e.description || "").replace(/\bDoor\b/g, "Window"),
    }));
  }
  if (cls === "finish_schedule") return parseFinishScheduleTokens(tokens, meta);
  // Filename says "detail" — index sheet number as a detail target
  if (cls === "detail") {
    const m = meta.file_name.toUpperCase().match(/\b([A-Z]\d{4,5})\b/);
    if (m) {
      return [{
        tag: m[1],
        kind: "detail",
        description: meta.file_name.replace(/\.pdf$/i, ""),
        type: "Detail sheet",
        source_sheet: meta.sheet_id,
        source_title: meta.file_name.replace(/\.pdf$/i, ""),
        source_bbox: { x: 0, y: 0, w: 400, h: 300 },
      }];
    }
  }
  return [];
}

/** Merge many sheet extracts into a tag → entry map (richest + best source wins). */
export function buildScheduleKb(entries: ScheduleKbEntry[]): Map<string, ScheduleKbEntry> {
  const map = new Map<string, ScheduleKbEntry>();
  const score = (x: ScheduleKbEntry) => {
    let s = [x.description, x.room_name, x.size, x.fire_rating, x.floors, x.remarks, x.type]
      .filter((v) => v && String(v).trim()).length;
    const title = (x.source_title || x.source_sheet || "").toUpperCase();
    // Prefer real door/finish schedule sheets over detail/garbage sheets
    if (/\bDOORS?\b/.test(title) || /DOOR\s*SCHED/.test(title)) s += 5;
    if (/WINDOWS?|CURTAIN|ALUMINUM|ALUMINIUM/.test(title)) s += 5;
    if (/FINISH/.test(title)) s += 5;
    if (/\bDETAILS?\b/.test(title) && !/\(SHEET/i.test(title)) s -= 4;
    // Penalize sparse "see FILENAME" stubs
    if (/^Door\s+D\d+\s+—\s+see\s+/i.test(x.description || "")) s -= 3;
    if (x.size) s += 2;
    if (x.fire_rating) s += 2;
    if (x.room_name) s += 1;
    return s;
  };
  for (const e of entries || []) {
    for (const k of tagLookupKeys(e.tag)) {
      const prev = map.get(k);
      if (!prev || score(e) > score(prev)) map.set(k, e);
      if (e.room_name?.trim()) {
        map.set(`${k}@${normRoomKey(e.room_name)}`, e);
        if (e.floors?.trim()) {
          map.set(`${k}@${normRoomKey(e.room_name)}#${normFloorKey(e.floors)}`, e);
        }
      }
    }
  }
  return map;
}

const FINISH_LEGEND_ORDER = ["PT", "CPT", "STN", "RUB", "EPD", "SK", "WP", "WD", "FC", "PC", "VN", "MT", "SF", "MR", "GRP"];

/** Tabular finish-schedule rows for the Finishes panel — one row per room × floor band. */
export function listFinishesScheduleRows(
  kb: Map<string, ScheduleKbEntry> | Record<string, ScheduleKbEntry> | null | undefined,
): ScheduleKbEntry[] {
  if (!kb) return [];
  const list: ScheduleKbEntry[] = kb instanceof Map ? [...kb.values()] : Object.values(kb || {});
  const seen = new Set<string>();
  const rows: ScheduleKbEntry[] = [];
  for (const e of list) {
    if (e.kind !== "finish" || !e.room_name?.trim()) continue;
    const key = `${normFloorKey(e.floors || "")}::${normRoomKey(e.room_name)}::${e.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(e);
  }
  rows.sort((a, b) => {
    const fa = normFloorKey(a.floors || "");
    const fb = normFloorKey(b.floors || "");
    if (fa !== fb) return fa.localeCompare(fb);
    return (a.room_name || "").localeCompare(b.room_name || "");
  });
  return rows;
}

/** Unique finish marks for the materials legend sidebar. */
export function finishesLegendEntries(
  kb: Map<string, ScheduleKbEntry> | Record<string, ScheduleKbEntry> | null | undefined,
): { prefix: string; tag: string; description: string }[] {
  if (!kb) return [];
  const list: ScheduleKbEntry[] = kb instanceof Map ? [...kb.values()] : Object.values(kb || {});
  const byTag = new Map<string, ScheduleKbEntry>();
  for (const e of list) {
    if (e.kind !== "finish" || !e.tag) continue;
    const prev = byTag.get(e.tag);
    if (!prev || (e.description?.length || 0) > (prev.description?.length || 0)) byTag.set(e.tag, e);
  }
  const out = [...byTag.values()].map((e) => ({
    prefix: e.tag.split("-")[0] || e.tag,
    tag: e.tag,
    description: e.description || "",
  }));
  out.sort((a, b) => {
    const ia = FINISH_LEGEND_ORDER.indexOf(a.prefix);
    const ib = FINISH_LEGEND_ORDER.indexOf(b.prefix);
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.tag.localeCompare(b.tag);
  });
  return out;
}

/** Room + floor scoped schedule lookup — prefers finish rows for the detected room/plan sheet. */
export function lookupScheduleKbForRoom(
  kb: Map<string, ScheduleKbEntry> | Record<string, ScheduleKbEntry> | null | undefined,
  tag: string,
  room?: string,
  sheetFloor?: string,
): ScheduleKbEntry | null {
  if (!kb || !tag) return null;
  const get = (k: string) => (kb instanceof Map ? kb.get(k) : kb[k]) || null;
  const roomName = (room || "").trim();
  const floorName = (sheetFloor || "").trim();

  if (floorName && roomName) {
    const nr = normRoomKey(roomName);
    const nf = normFloorKey(floorName);
    for (const k of tagLookupKeys(tag)) {
      const exact = get(`${k}@${nr}#${nf}`);
      if (exact?.description) return exact;
    }
  }
  if (roomName) {
    const nr = normRoomKey(roomName);
    for (const k of tagLookupKeys(tag)) {
      const exact = get(`${k}@${nr}`);
      if (exact?.description) return exact;
    }
  }

  const tagSet = new Set(tagLookupKeys(tag).map((k) => k.toUpperCase()));
  const list: ScheduleKbEntry[] = kb instanceof Map ? [...kb.values()] : Object.values(kb || {});
  let best: ScheduleKbEntry | null = null;
  let bestScore = 0;
  for (const e of list) {
    if (!e?.tag || !tagSet.has(String(e.tag).toUpperCase())) continue;
    let sc = e.description?.length || 0;
    if (roomName) {
      if (roomKeyMatch(e.room_name || "", roomName)) sc += 120;
      else if (e.room_name) sc -= 40;
    }
    if (floorName && e.floors) sc += floorKeyMatch(floorName, e.floors);
    if (sc > bestScore) { best = e; bestScore = sc; }
  }
  if (best && bestScore >= 40) return best;

  if (roomName) {
    const iter: Iterable<[string, ScheduleKbEntry]> = kb instanceof Map
      ? kb.entries()
      : Object.entries(kb || {}) as [string, ScheduleKbEntry][];
    best = null;
    bestScore = 0;
    for (const [key, e] of iter) {
      if (!String(key).includes("@")) continue;
      const at = String(key).indexOf("@");
      const tagPart = String(key).slice(0, at);
      const roomPart = String(key).slice(at + 1).split("#")[0];
      if (!tagLookupKeys(tag).some((t) => t.toUpperCase() === tagPart.toUpperCase())) continue;
      if (!roomKeyMatch(roomPart, roomName)) continue;
      const rs = (e.description?.length || 0) + (e.room_name ? 20 : 0)
        + (floorName ? floorKeyMatch(floorName, e.floors || "") : 0);
      if (rs > bestScore) { best = e; bestScore = rs; }
    }
    if (best) return best;
  }
  return lookupScheduleKb(kb, tag);
}

/** Look up a plan mark in the KB. */
export function lookupScheduleKb(
  kb: Map<string, ScheduleKbEntry> | Record<string, ScheduleKbEntry> | null | undefined,
  tag: string,
): ScheduleKbEntry | null {
  if (!kb || !tag) return null;
  const get = (k: string) => (kb instanceof Map ? kb.get(k) : kb[k]) || null;
  for (const k of tagLookupKeys(tag)) {
    const hit = get(k);
    if (hit) return hit;
  }
  return null;
}
