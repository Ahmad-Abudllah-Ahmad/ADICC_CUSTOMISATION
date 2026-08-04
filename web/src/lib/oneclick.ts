// One-Click Area — v1 geometry core (pure, no DOM; node-testable).
//
// Click inside a room → flood-fill bounded by the plan's vector linework →
// traced polygon, vertices snapped. The pipeline:
//   extractVectorGeometry  PDF op list → line segments + snap endpoints (image px)
//   buildMask              segments → downscaled 1-bit boundary raster
//   floodRegionSealed      seed → bounded region (prefers door/window gap seal)
//   traceRegionWithHoles   region → outer contour + fixture/column cutouts
//
// A single-pixel Bresenham barrier is 8-connected, which provably blocks the
// 4-connected scanline fill — no dilation, so the boundary sits ~half a mask px
// inside the drawn line (sub-inch at plan scales). Text never blocks fills
// (glyphs are showText ops, not constructPath). The caller owns the
// propose → review → Create gate.
//
// Hatch (2026-07-05): hatch/poché strokes are constructPath linework too, so a
// naive mask traps the fill between hatch lines. The cure is a TIERED mask —
// walls plot bit 1, segments classified as hatch (regular runs of overlapping
// parallel rows — classifyHatchSegs) plot bit 2 — plus an escalating flood:
// the primary pass treats both as barrier (bit-identical to the original), and
// when it comes back trapped (tiny/boundary), predominantly hatch-bounded (a
// tile-grid cell), or MODERATELY hatch-bounded (a hatch-lined room — issue #32),
// a second pass re-floods with hatch transparent. The moderate tier is the only
// one bounded: it accepts the re-flood only if the area growth stays within a cap
// (grow-but-verify). If the escalated pass leaks, stays tiny, or balloons, the
// primary result stands — a misclassified wall can never make the tool worse
// than the strict mask.
//
// Openings + cutouts (2026-07-24): sealOpenings bridges hard-wall gaps up to a
// door/window-sized max (scale-aware via openingGapPx) and the sealed flood is
// preferred whenever it encloses — so door-connected floor plates don't win as
// a giant "ok". Still refuses if sealing can't enclose. After a clean flood,
// enclosed islands (vanity, toilet, washbasin, column, shaft) are auto-cutouts.

export type Point = [number, number];
export interface OpList { fnArray: number[]; argsArray: any[]; }  // per-op args array, or null for arg-less ops
/** pdf.js's OPS code table (op name → numeric code); passed in so this module never imports pdfjs. */
export type OpsTable = Record<string, number>;
/** meta: one byte per segment — SEG_* bits + device line width in the high nibble.
 *  imageArea: total placed image area in device px² (scan/photo underlay detection). */
export interface VectorGeometry { points: Point[]; segs: number[]; meta: Uint8Array; imageArea: number; }
export interface MaskObj { mask: Uint8Array; mw: number; mh: number; ws: number; softCount: number; }
export interface RegionResult { region: Uint8Array; mw: number; mh: number; ws: number; count?: number; }
export type FloodResult =
  | { status: "boundary" }
  | { status: "leak" }
  | { status: "tiny"; count: number }
  | { status: "ok"; region: Uint8Array; count: number; mw: number; mh: number; ws: number; hardHits?: number; softHits?: number; hatchFiltered?: boolean; openingsSealed?: boolean };

/** Min/max real-area gates for auto-carved interior cutouts (fixtures, columns). */
export const CUTOUT_MIN_SF = 0.4;
export const CUTOUT_MAX_FRAC = 0.40;
/** Default max opening to bridge when sealing door/window gaps (feet). */
export const OPENING_MAX_FT = 4;
/** Caller's snap-grid lookup: nearest true endpoint to (x,y) within maxDist, or null. */
export type NearestFn = (x: number, y: number, maxDist: number) => Point | null | undefined;

export const MASK_MAX_DIM = 3000;   // working raster cap (Uint8 ≈ 6–7 MB)
const LEAK_FRACTION = 0.30;         // fill > 30% of the sheet ⇒ not an enclosed space
const TINY_PX = 30;                 // fill < 30 mask px ⇒ landed in dense linework
const MIN_THICK = 4;                // region bbox thinner than 4 mask px ⇒ hatch sliver, not a room
const CURVE_STEPS = 8;              // chords per bezier (door swings stay closed)

// segment meta bits (extractVectorGeometry emits, classifyHatchSegs consumes)
export const SEG_CURVE = 1;         // bezier chord — never classified as hatch (door swings close gaps)
export const SEG_CLIP = 2;          // clip-only path (endPath) — invisible ink, never a wall
export const SEG_FILLONLY = 4;      // filled-not-stroked path (solid poché outlines classify normally)
// meta high nibble = device line width, ceil'd and capped at 15 (0 = hairline)

// hatch classification — a family is many similar-angle rows, regularly pitched,
// stacking tangentially; walls don't do that (see classifyHatchSegs)
export const HATCH_ANGLE_TOL = 2;      // deg — CAD hatch angle jitter is ≪ 1°
export const HATCH_MIN_RUN = 10;       // rows — fewer evenly-spaced parallels is plausibly walls
export const HATCH_MAX_PITCH = 24;     // mask px — keeps room-scale rhythm (demising walls) hard
export const HATCH_PITCH_TOL = 0.35;   // regularity band around the median pitch
export const HATCH_MIN_REGULAR = 0.7;  // fraction of gaps that must sit inside the band
export const HATCH_OVERLAP_FRAC = 0.5; // successive rows must overlap tangentially this much
export const ROW_EPS = 1.5;            // mask px — collinear/dashed pieces merge into one row
export const WIDE_PROTECT_RATIO = 2;   // heavier-pen member of a hairline family stays hard (wall overprint)
export const SPAN_PROTECT_RATIO = 3;   // a row spanning ≫ the run's median row is a wall riding the rhythm, not hatch
export const HATCH_BOUND_FRAC = 0.7;   // ≥ this soft-bounded fraction ⇒ PREDOMINANTLY hatch (tile-grid cell): escalate unbounded
export const HATCH_ESCALATE_FRAC = 0.35; // MODERATE band [this, HATCH_BOUND_FRAC): grow-but-verify escalation (issue #32 — real hatch-lined rooms top out ~0.63, so 0.70 alone never fired). This is the Balanced-preset value; see escalationParams.
export const HATCH_GROWTH_MAX = 2.5;     // grow-but-verify cap: reject a walls-only escalation that balloons past this × the strict area (a misclassified wall would leak or overgrow). Balanced-preset value.

// Fill sensitivity — a single 0..1 knob the estimator can dial per drawing to
// trade spill-resistance against reach (the constants above are calibrated on one
// sheet/one CAD style; other plans hatch differently). It tunes ONLY the moderate
// escalation tier: how eagerly a hatch-bounded fill escalates (escalateFrac) and
// how much area growth that escalation may add (growthMax). The trapped and
// predominantly-soft tiers stay unbounded at every setting, so lowering
// sensitivity never regresses tile-grid recovery — it only narrows the moderate
// band, and at Strict it empties (reproducing pre-#32 behavior).
export const SENS_STRICT = 0;
export const SENS_BALANCED = 0.5;      // default: the calibrated (0.35, 2.5) pair
export const SENS_AGGRESSIVE = 1;
// Notch detents interpolated piecewise-linearly: [sensitivity, escalateFrac, growthMax].
const SENS_ANCHORS: Array<[number, number, number]> = [
  [SENS_STRICT, HATCH_BOUND_FRAC, 1.5],                     // moderate band empties (escalateFrac == HATCH_BOUND_FRAC) ⇒ pre-#32
  [SENS_BALANCED, HATCH_ESCALATE_FRAC, HATCH_GROWTH_MAX],   // calibrated on the sample plan (issue #32)
  [SENS_AGGRESSIVE, 0.20, 4.0],                            // cross more hatch, tolerate more growth
];
export function escalationParams(sensitivity: number): { escalateFrac: number; growthMax: number } {
  const s = Math.max(0, Math.min(1, Number.isFinite(sensitivity) ? sensitivity : SENS_BALANCED));
  let a = SENS_ANCHORS[0], b = SENS_ANCHORS[SENS_ANCHORS.length - 1];
  for (let i = 1; i < SENS_ANCHORS.length; i++) { if (s <= SENS_ANCHORS[i][0]) { a = SENS_ANCHORS[i - 1]; b = SENS_ANCHORS[i]; break; } }
  const t = b[0] === a[0] ? 0 : (s - a[0]) / (b[0] - a[0]);
  return { escalateFrac: a[1] + (b[1] - a[1]) * t, growthMax: a[2] + (b[2] - a[2]) * t };
}

// ── 1. op-list walk ────────────────────────────────────────────────────────
// Same transform composition as the original snap extractor (save/restore/
// transform/constructPath), now also emitting SEGMENTS for the boundary mask
// plus one META byte per segment: curve/clip/fill bits + the device line width
// in the high nibble (setLineWidth / setGState "LW", scaled by the CTM). Form
// XObjects push/pop their matrix so hatch living inside a form lands where it
// draws. `transform` is viewport.transform; OPS is pdfjs's op-code table.
export function extractVectorGeometry(opList: OpList, transform: number[], OPS: OpsTable): VectorGeometry {
  const points: Point[] = [];
  const segs: number[] = [];
  const metaArr: number[] = [];
  let imageArea = 0;
  let m = transform.slice();
  let lw = 1;                          // graphics-state line width (user space)
  const stack: Array<[number[], number]> = [];
  const mul = (a: number[], b: number[]): number[] => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const tx = (x: number, y: number): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const fns = opList.fnArray, A = opList.argsArray;
  // the paint op FOLLOWS its path in the op stream (clip ops may sit between):
  // endPath = clip-only (invisible), fill/eoFill = filled-not-stroked
  const paintFlags = (i: number): number => {
    for (let j = i + 1; j < fns.length && j <= i + 3; j++) {
      const f = fns[j];
      if (f === OPS.clip || f === OPS.eoClip) continue;
      if (f === OPS.endPath) return SEG_CLIP;
      if (f === OPS.fill || f === OPS.eoFill) return SEG_FILLONLY;
      break;                            // stroke / fillStroke / anything else
    }
    return 0;
  };
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i], args = A[i];
    if (fn === OPS.save) stack.push([m.slice(), lw]);
    else if (fn === OPS.restore) { const p = stack.pop(); if (p) { m = p[0]; lw = p[1]; } }
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.setLineWidth) lw = args[0];
    else if (fn === OPS.setGState) { for (const pr of args[0] || []) if (pr && pr[0] === "LW") lw = pr[1]; }
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([m.slice(), lw]); if (args && args[0]) m = mul(m, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { const p = stack.pop(); if (p) { m = p[0]; lw = p[1]; } }
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      // the singular paint ops are each preceded by their OWN `transform` op
      // (already folded into `m` above), mapping the image's unit square onto
      // the placed rect — |det m| is its device-px area. Summed per sheet, it
      // flags scan wrappers / photo underlays (a plan-area scan covers most of
      // the sheet; logos and stamps are ≪ 2%).
      imageArea += Math.abs(m[0] * m[3] - m[1] * m[2]);
    }
    else if (fn === OPS.paintImageXObjectRepeat) {
      // pdf.js FOLDS a run of identical placements into one op — no per-instance
      // `transform` op precedes it, so `m` here is just the ambient CTM (the
      // viewport transform); placement lives in the op's OWN args instead:
      // [objId, scaleX, scaleY, positions] where positions is a flat (x, y) ×
      // instanceCount array. Area = |det ambient| × |scaleX·scaleY| × count.
      const [, scaleX, scaleY, positions] = args;
      const count = positions ? positions.length >> 1 : 0;
      imageArea += Math.abs(m[0] * m[3] - m[1] * m[2]) * Math.abs(scaleX * scaleY) * count;
    }
    else if (fn === OPS.paintImageMaskXObjectRepeat) {
      // args: [objId, a, b, c, d, positions] — a..d are the per-instance local
      // transform's 2×2 (folded the same way as the repeat op above).
      const [, ra, rb, rc, rd, positions] = args;
      const count = positions ? positions.length >> 1 : 0;
      imageArea += Math.abs(m[0] * m[3] - m[1] * m[2]) * Math.abs(ra * rd - rb * rc) * count;
    }
    else if (fn === OPS.paintImageMaskXObjectGroup) {
      // args: [images] — each images[k].transform is that instance's own local
      // [a,b,c,d,e,f] (pdf.js keeps per-instance transforms here instead of
      // folding to *Repeat when the run isn't uniform enough).
      const ctmDet = Math.abs(m[0] * m[3] - m[1] * m[2]);
      for (const im of args[0] || []) {
        const t = im && im.transform;
        if (t) imageArea += ctmDet * Math.abs(t[0] * t[3] - t[1] * t[2]);
      }
    }
    else if (fn === OPS.paintInlineImageXObjectGroup) {
      // args: [img, map] — each map[k].transform is that instance's own local
      // [a,b,c,d,e,f].
      const ctmDet = Math.abs(m[0] * m[3] - m[1] * m[2]);
      for (const mp of args[1] || []) {
        const t = mp && mp.transform;
        if (t) imageArea += ctmDet * Math.abs(t[0] * t[3] - t[1] * t[2]);
      }
    }
    else if (fn === OPS.constructPath) {
      const devW = Math.min(15, Math.max(0, Math.ceil((lw || 0) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])))));
      const flags = paintFlags(i) | (devW << 4);
      const ops = args[0], co = args[1];
      let c = 0, cur: Point | null = null, start: Point | null = null;
      const visit = (p: Point) => { points.push(p); };
      const lineTo = (p: Point) => { if (cur) { segs.push(cur[0], cur[1], p[0], p[1]); metaArr.push(flags); } cur = p; visit(p); };
      for (const op of ops) {
        if (op === OPS.moveTo) { cur = tx(co[c], co[c + 1]); start = cur; visit(cur); c += 2; }
        else if (op === OPS.lineTo) { lineTo(tx(co[c], co[c + 1])); c += 2; }
        else if (op === OPS.curveTo || op === OPS.curveTo2 || op === OPS.curveTo3) {
          // cubic bezier, sampled as chords; control points transform first
          // (affine maps commute with bezier interpolation)
          let p1: Point, p2: Point, p3: Point;
          if (op === OPS.curveTo) { p1 = tx(co[c], co[c + 1]); p2 = tx(co[c + 2], co[c + 3]); p3 = tx(co[c + 4], co[c + 5]); c += 6; }
          else if (op === OPS.curveTo2) { p1 = cur || tx(co[c], co[c + 1]); p2 = tx(co[c], co[c + 1]); p3 = tx(co[c + 2], co[c + 3]); c += 4; }
          else { p1 = tx(co[c], co[c + 1]); p2 = p3 = tx(co[c + 2], co[c + 3]); c += 4; }
          const p0: Point = cur || p1;
          for (let k = 1; k <= CURVE_STEPS; k++) {
            const t = k / CURVE_STEPS, u = 1 - t;
            const q: Point = [
              u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
              u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
            ];
            if (cur) { segs.push(cur[0], cur[1], q[0], q[1]); metaArr.push(flags | SEG_CURVE); }
            cur = q;
          }
          visit(p3);
        }
        else if (op === OPS.closePath) { if (cur && start) { segs.push(cur[0], cur[1], start[0], start[1]); metaArr.push(flags); cur = start; } }
        else if (op === OPS.rectangle) {
          const x = co[c], y = co[c + 1], w = co[c + 2], h = co[c + 3]; c += 4;
          const q: Point[] = [tx(x, y), tx(x + w, y), tx(x + w, y + h), tx(x, y + h)];
          for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; segs.push(a[0], a[1], b[0], b[1]); metaArr.push(flags); visit(a); }
          cur = q[0]; start = q[0];
        }
      }
    }
  }
  return { points, segs, meta: Uint8Array.from(metaArr), imageArea };
}

// ── 2. hatch classification ────────────────────────────────────────────────
// A hatch family is what walls never are: MANY same-angle rows (collinear
// pieces merged), REGULARLY pitched at fill scale, each row OVERLAPPING the
// next tangentially (hatch stacks; scattered parallel walls don't). Marks
// suspected hatch segments soft (1). Curve chords are exempt (door swings must
// keep closing gaps); clip-only paths are soft outright (invisible ink). Two
// wall guards inside a family: the EXTREMAL rows stay hard (tile/hatch edges
// coincide with walls), and heavier-pen members stay hard (wall overprint).
interface HatchCand { i: number; ang: number; x1: number; y1: number; x2: number; y2: number; w: number; }
interface HatchRow { d: number; t0: number; t1: number; segs: HatchCand[]; }

/** One periodic family found by the sweep — the (angle, pitch, pen-width)
 * signature plus its membership, in the caller's coordinate unit (ws-scaled).
 * This is the data `classifyHatchSegs` always computed and then threw away
 * (issue #29): the classifier's view keeps only `softIdx`; the context view
 * (`hatchFamilies`) keeps the signature, which is what makes legend↔plan
 * matching a comparison instead of a vision guess. */
export interface HatchRunInfo {
  /** Mean member angle, folded to [0, 180) — direction-free. */
  angleDeg: number;
  /** Median row-to-row gap (the pattern's pitch), in the caller's unit. */
  pitch: number;
  /** Modal device pen width of the members (meta high nibble). */
  modalW: number;
  rowCount: number;
  /** Tight bbox over member segments [x0, y0, x1, y1], caller's unit. */
  bbox: [number, number, number, number];
  /** Every segment index belonging to the run's rows. */
  memberIdx: number[];
  /** The subset the classifier softens — members minus the wall guards
   * (extremal rows, span-protected rows, heavy-pen overprints). */
  softIdx: number[];
}

/** The sweep core, shared verbatim-in-logic by both views: collect stroked
 * non-curve candidates, cluster by angle (folding the 0°/180° seam), merge
 * collinear pieces into rows, and keep maximal regularly-pitched
 * tangentially-stacking runs. Returns the runs plus the clip-only indices
 * (invisible ink — soft outright, independent of any family). */
function sweepHatchRuns(segs: number[], meta: Uint8Array, ws: number): { clipSoft: number[]; runs: HatchRunInfo[] } {
  const n = segs.length >> 2;
  const clipSoft: number[] = [];
  const runs: HatchRunInfo[] = [];
  if (!meta || !n) return { clipSoft, runs };
  const cand: HatchCand[] = [];
  for (let i = 0; i < n; i++) {
    const mt = meta[i];
    if (mt & SEG_CURVE) continue;
    if (mt & SEG_CLIP) { clipSoft.push(i); continue; }
    // Filled-not-stroked outlines bound SOLID ink (wall poché). Their short
    // 0°/90° edges ride a tile grid's rhythm and would classify as hatch — but
    // making them transparent lets the escalated fill cross a solid black band
    // (the leak that turned hatched-room clicks into "dense linework" guards).
    // Hatch itself is stroked linework, so exempting fills costs nothing.
    if (mt & SEG_FILLONLY) continue;
    const x1 = segs[i * 4] * ws, y1 = segs[i * 4 + 1] * ws, x2 = segs[i * 4 + 2] * ws, y2 = segs[i * 4 + 3] * ws;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.75) continue;                    // sub-cell specks can't form rows
    let ang = Math.atan2(dy, dx) * 180 / Math.PI; // fold to [0,180): direction-free
    if (ang < 0) ang += 180; if (ang >= 180) ang -= 180;
    cand.push({ i, ang, x1, y1, x2, y2, w: meta[i] >> 4 });
  }
  if (cand.length < HATCH_MIN_RUN) return { clipSoft, runs };
  cand.sort((a, b) => a.ang - b.ang);
  // sweep into angle clusters; a near-0° cluster merges with a near-180° one
  const clusters: HatchCand[][] = [];
  let cl: HatchCand[] = [cand[0]];
  for (let k = 1; k < cand.length; k++) {
    if (cand[k].ang - cand[k - 1].ang <= HATCH_ANGLE_TOL) cl.push(cand[k]);
    else { clusters.push(cl); cl = [cand[k]]; }
  }
  clusters.push(cl);
  if (clusters.length > 1) {
    const first = clusters[0], last = clusters[clusters.length - 1];
    if (first[0].ang < HATCH_ANGLE_TOL && last[last.length - 1].ang > 180 - HATCH_ANGLE_TOL) {
      for (const s of last) s.ang -= 180;        // fold across the seam for the mean
      clusters[0] = last.concat(first);
      clusters.pop();
    }
  }
  const median = (arr: number[]): number => { const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
  for (const members of clusters) {
    if (members.length < HATCH_MIN_RUN) continue;
    let sum = 0; for (const s of members) sum += s.ang;
    const th = (sum / members.length) * Math.PI / 180;
    const dxu = Math.cos(th), dyu = Math.sin(th);      // along the family
    const nxu = -dyu, nyu = dxu;                        // across it
    const rowsIn = members.map((s) => ({
      s,
      d: ((s.x1 + s.x2) / 2) * nxu + ((s.y1 + s.y2) / 2) * nyu,
      t0: Math.min(s.x1 * dxu + s.y1 * dyu, s.x2 * dxu + s.y2 * dyu),
      t1: Math.max(s.x1 * dxu + s.y1 * dyu, s.x2 * dxu + s.y2 * dyu),
    })).sort((a, b) => a.d - b.d);
    // collinear/dashed pieces at the same offset merge into one ROW
    const rows: HatchRow[] = [];
    let row: HatchRow = { d: rowsIn[0].d, t0: rowsIn[0].t0, t1: rowsIn[0].t1, segs: [rowsIn[0].s] };
    for (let k = 1; k < rowsIn.length; k++) {
      const r = rowsIn[k];
      if (r.d - row.d <= ROW_EPS) { row.t0 = Math.min(row.t0, r.t0); row.t1 = Math.max(row.t1, r.t1); row.segs.push(r.s); }
      else { rows.push(row); row = { d: r.d, t0: r.t0, t1: r.t1, segs: [r.s] }; }
    }
    rows.push(row);
    // maximal RUNS of rows: pitched within cap AND stacking tangentially
    let runStart = 0;
    const flushRun = (a: number, b: number) => {        // rows[a..b] inclusive
      const count = b - a + 1;
      if (count < HATCH_MIN_RUN) return;
      const gaps: number[] = [];
      for (let k = a + 1; k <= b; k++) gaps.push(rows[k].d - rows[k - 1].d);
      const med = median(gaps);
      if (!med) return;
      let reg = 0; for (const g of gaps) if (Math.abs(g - med) <= med * HATCH_PITCH_TOL) reg++;
      if (reg / gaps.length < HATCH_MIN_REGULAR) return;
      const widths: number[] = [];
      for (let k = a; k <= b; k++) for (const s of rows[k].segs) widths.push(s.w);
      const modalW = Math.max(1, median(widths));
      // hatch rows span a room; a wall at the family's angle spans the wing.
      // A row much longer than the run's median is a wall riding the pattern's
      // rhythm — softening it would let the escalated fill breach the room.
      const spans: number[] = [];
      for (let k = a; k <= b; k++) spans.push(rows[k].t1 - rows[k].t0);
      const medSpan = Math.max(1, median(spans));
      const memberIdx: number[] = [];
      const softIdx: number[] = [];
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      let angSum = 0, angN = 0;
      for (let k = a; k <= b; k++) {
        const guarded = rows[k].t1 - rows[k].t0 > SPAN_PROTECT_RATIO * medSpan;
        for (const s of rows[k].segs) {
          memberIdx.push(s.i);
          angSum += s.ang; angN++;
          bx0 = Math.min(bx0, s.x1, s.x2); by0 = Math.min(by0, s.y1, s.y2);
          bx1 = Math.max(bx1, s.x1, s.x2); by1 = Math.max(by1, s.y1, s.y2);
          // the classifier's wall guards: extremal rows stay hard, span-
          // protected rows stay hard, heavy-pen overprints stay hard
          if (k > a && k < b && !guarded && s.w < WIDE_PROTECT_RATIO * modalW) softIdx.push(s.i);
        }
      }
      const meanAng = ((angSum / Math.max(1, angN)) % 180 + 180) % 180;
      runs.push({ angleDeg: meanAng, pitch: med, modalW, rowCount: count,
                  bbox: [bx0, by0, bx1, by1], memberIdx, softIdx });
    };
    for (let k = 1; k < rows.length; k++) {
      const gap = rows[k].d - rows[k - 1].d;
      const ov = Math.min(rows[k].t1, rows[k - 1].t1) - Math.max(rows[k].t0, rows[k - 1].t0);
      const need = HATCH_OVERLAP_FRAC * Math.min(rows[k].t1 - rows[k].t0, rows[k - 1].t1 - rows[k - 1].t0);
      if (gap > HATCH_MAX_PITCH || ov < need) { flushRun(runStart, k - 1); runStart = k; }
    }
    flushRun(runStart, rows.length - 1);
  }
  return { clipSoft, runs };
}

/** The classifier's view of the sweep: clip-only paths soft outright, then
 * every run member the wall guards allow. Bit-compatible with the historical
 * implementation — the guards moved into `sweepHatchRuns` unchanged. */
export function classifyHatchSegs(segs: number[], meta: Uint8Array, ws: number): Uint8Array {
  const soft = new Uint8Array(segs.length >> 2);
  const { clipSoft, runs } = sweepHatchRuns(segs, meta, ws);
  for (const i of clipSoft) soft[i] = 1;
  for (const r of runs) for (const i of r.softIdx) soft[i] = 1;
  return soft;
}

// Signature quantization for the stable family id (issue #29): coarse enough
// to absorb CAD jitter (≪ the classifier's own tolerances), fine enough that
// distinct pattern specs never collide. The RAW signature values ride along
// beside the id so a caller can run its own tolerance match when an instance
// sits on a bucket boundary.
export const HATCH_ID_ANGLE_Q = 0.5;  // degrees
export const HATCH_ID_PITCH_Q = 0.1;  // px

/** One hatch-family INSTANCE: a periodic region of the sheet, carrying the
 * content-derived id that makes instances comparable. Two regions drawn with
 * the same pattern spec — a legend swatch and the plan region it labels — get
 * the SAME id, which is the whole point: matching them is `id === id`. The id
 * identifies a pattern, not a material; the legend maps pattern → material. */
export interface HatchFamily {
  /** Content hash of the quantized signature: `h-a{angle}p{pitch}w{penW}`.
   * Derived from geometry alone — stable across calls, crops, and sessions. */
  id: string;
  angle_deg: number;
  pitch_px: number;
  pen_w_px: number;
  rows: number;
  segments: number;
  /** Tight bbox over the instance's members, image px [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  /** Member segment indices into the sheet's segs/meta arrays. */
  memberIdx: number[];
}

/** The context view of the sweep (issue #29): every periodic family on the
 * sheet as an instance record with its (angle, pitch, pen-width) signature —
 * in IMAGE PX (ws = 1), the frame every tool speaks. Pure and deterministic;
 * same input, same ids. */
export function hatchFamilies(segs: number[], meta: Uint8Array): HatchFamily[] {
  const { runs } = sweepHatchRuns(segs, meta, 1);
  const q = (v: number, step: number): number => Math.round(v / step) * step;
  return runs.map((r) => {
    const a = q(r.angleDeg, HATCH_ID_ANGLE_Q), p = q(r.pitch, HATCH_ID_PITCH_Q);
    return {
      id: `h-a${a.toFixed(1)}p${p.toFixed(1)}w${r.modalW}`,
      angle_deg: +r.angleDeg.toFixed(2),
      pitch_px: +r.pitch.toFixed(2),
      pen_w_px: r.modalW,
      rows: r.rowCount,
      segments: r.memberIdx.length,
      bbox: r.bbox.map((v) => +v.toFixed(1)) as [number, number, number, number],
      memberIdx: r.memberIdx,
    };
  });
}

// ── 3. boundary mask ───────────────────────────────────────────────────────
// Segments (image px) → Uint8Array raster at ws = maskDim/imageDim. Single-px
// Bresenham; coincident endpoints round to the same cell so chained walls stay
// continuous. Without meta the mask is bit-identical to the original (every
// cell 1). With meta, wall cells carry bit 1 and suspected-hatch cells bit 2 —
// a cell crossed by both keeps bit 1, so hard always wins.
export function buildMask(segs: number[], imgW: number, imgH: number, maxDim = MASK_MAX_DIM, meta: Uint8Array | null = null): MaskObj {
  const ws = Math.min(1, maxDim / Math.max(imgW, imgH, 1));
  const mw = Math.max(2, Math.ceil(imgW * ws)), mh = Math.max(2, Math.ceil(imgH * ws));
  const mask = new Uint8Array(mw * mh);
  const soft = meta ? classifyHatchSegs(segs, meta, ws) : null;
  let softCount = 0;
  for (let i = 0, si = 0; i + 3 < segs.length; i += 4, si++) {
    const v = soft && soft[si] ? 2 : 1;
    if (v === 2) softCount++;
    let x0 = Math.round(segs[i] * ws), y0 = Math.round(segs[i + 1] * ws);
    const x1 = Math.round(segs[i + 2] * ws), y1 = Math.round(segs[i + 3] * ws);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) {
      if (x0 >= 0 && y0 >= 0 && x0 < mw && y0 < mh) mask[y0 * mw + x0] |= v;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
  }
  return { mask, mw, mh, ws, softCount };
}

// ── 3b. opening seal (door / window gaps) ──────────────────────────────────
// Bridge hard-wall gaps up to a door/window-sized max so a room with an open
// doorway still encloses. Soft (hatch) bits are left alone — only bit-1 walls
// are sealed. Callers convert real opening length → mask px via openingGapPx.
// Safety lives in floodRegionSealed: sealed is preferred when it encloses; if
// sealing still can't enclose, the unsealed result stands.
//
// Implementation is O(mw·mh) axis-aligned gap fill (not iterated morph-close):
// a 4 ft door on a large sheet can be 80+ mask px, and radius-R morph-close is
// O(R·mw·mh) — multi-second UI freezes on every click. Row/column gap bridging
// closes the same door/window openings in one pass. Sealed masks are
// WeakMap-cached per source mask.

/** Image/mask conversion: max opening in feet → mask pixels (0 if scale unknown). */
export function openingGapPx(upp: number, ws: number, maxOpeningFt: number = OPENING_MAX_FT): number {
  if (!(upp > 0) || !(ws > 0) || !(maxOpeningFt > 0)) return 0;
  return Math.max(1, Math.round((maxOpeningFt / upp) * ws));
}

/** Fill open runs of length 1…maxGap between hard pixels on each row, then each col. */
function sealAxisGaps(hard: Uint8Array, mw: number, mh: number, maxGap: number): Uint8Array {
  const out = hard.slice();
  for (let y = 0; y < mh; y++) {
    const row = y * mw;
    let prev = -1;
    for (let x = 0; x < mw; x++) {
      if (!hard[row + x]) continue;
      if (prev >= 0) {
        const g = x - prev - 1;
        if (g > 0 && g <= maxGap) for (let i = prev + 1; i < x; i++) out[row + i] = 1;
      }
      prev = x;
    }
  }
  for (let x = 0; x < mw; x++) {
    let prev = -1;
    for (let y = 0; y < mh; y++) {
      if (!hard[y * mw + x]) continue;
      if (prev >= 0) {
        const g = y - prev - 1;
        if (g > 0 && g <= maxGap) for (let i = prev + 1; i < y; i++) out[i * mw + x] = 1;
      }
      prev = y;
    }
  }
  return out;
}

// Sealed-mask cache: same vector/raster mask + gap → reuse across clicks.
const sealedCache = new WeakMap<Uint8Array, Map<number, MaskObj>>();

/** Copy the mask with hard (bit-1) walls closed across gaps ≤ maxGapMaskPx.
 *  Soft (bit-2) hatch cells are preserved; hard always wins where both land. */
export function sealOpenings(maskObj: MaskObj, maxGapMaskPx: number): MaskObj {
  const { mask, mw, mh, ws, softCount } = maskObj;
  const gap = Math.max(0, Math.floor(maxGapMaskPx));
  if (gap < 1) return { mask: mask.slice(), mw, mh, ws, softCount };

  let byGap = sealedCache.get(mask);
  const hit = byGap?.get(gap);
  if (hit) return hit;

  const hard = new Uint8Array(mw * mh);
  for (let i = 0; i < hard.length; i++) if (mask[i] & 1) hard[i] = 1;
  // Axis-aligned bridge only — doors/windows in plan are almost always H/V.
  // (Iterated morph-close at door radius was O(R·mw·mh) and froze the UI.)
  const closed = sealAxisGaps(hard, mw, mh, gap);
  const out = new Uint8Array(mw * mh);
  for (let i = 0; i < out.length; i++) {
    const soft = mask[i] & 2;
    out[i] = closed[i] ? (1 | soft) : soft;
  }
  const result: MaskObj = { mask: out, mw, mh, ws, softCount };
  if (!byGap) { byGap = new Map(); sealedCache.set(mask, byGap); }
  byGap.set(gap, result);
  return result;
}

// ── 4. flood fill ──────────────────────────────────────────────────────────
// Scanline fill from an image-px seed. `barrier` picks which mask bits block:
// 3 = walls + hatch (the strict original behavior), 1 = walls only. hardHits/
// softHits count blocking encounters so the caller can tell a wall-bounded
// region from a hatch-bounded one.
function floodPass(maskObj: MaskObj, ix: number, iy: number, barrier: number): FloodResult {
  const { mask, mw, mh, ws } = maskObj;
  let sx = Math.round(ix * ws), sy = Math.round(iy * ws);
  if (sx < 0 || sy < 0 || sx >= mw || sy >= mh) return { status: "boundary" };
  if (mask[sy * mw + sx] & barrier) {
    // nudge: nearest open cell within 3 px (clicks often land on hatch lines)
    let found: Point | null = null;
    for (let r = 1; r <= 3 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = sx + dx, ny = sy + dy;
        if (nx >= 0 && ny >= 0 && nx < mw && ny < mh && !(mask[ny * mw + nx] & barrier)) { found = [nx, ny]; break; }
      }
    }
    if (!found) return { status: "boundary" };
    sx = found[0]; sy = found[1];
  }
  const region = new Uint8Array(mw * mh);
  const cap = Math.floor(mw * mh * LEAK_FRACTION);
  let count = 0, leaked = false, hardHits = 0, softHits = 0;
  let bx0 = sx, bx1 = sx, by0 = sy, by1 = sy;
  const stack: number[][] = [[sx, sy]];
  while (stack.length) {
    const popped = stack.pop() as number[];
    const px = popped[0], py = popped[1];
    let x0 = px;
    while (x0 > 0 && !(mask[py * mw + x0 - 1] & barrier) && !region[py * mw + x0 - 1]) x0--;
    if (x0 > 0 && (mask[py * mw + x0 - 1] & barrier)) { if (mask[py * mw + x0 - 1] & 1) hardHits++; else softHits++; }
    let x1 = px;
    while (x1 < mw - 1 && !(mask[py * mw + x1 + 1] & barrier) && !region[py * mw + x1 + 1]) x1++;
    if (x1 < mw - 1 && (mask[py * mw + x1 + 1] & barrier)) { if (mask[py * mw + x1 + 1] & 1) hardHits++; else softHits++; }
    if (x0 === 0 || x1 === mw - 1 || py === 0 || py === mh - 1) leaked = true;
    if (x0 < bx0) bx0 = x0; if (x1 > bx1) bx1 = x1; if (py < by0) by0 = py; if (py > by1) by1 = py;
    let upOpen = false, downOpen = false;
    for (let x = x0; x <= x1; x++) {
      const idx = py * mw + x;
      if (region[idx]) { upOpen = downOpen = false; continue; }
      region[idx] = 1; count++;
      if (py > 0) {
        const u = idx - mw;
        if (!(mask[u] & barrier) && !region[u]) { if (!upOpen) { stack.push([x, py - 1]); upOpen = true; } }
        else { if (mask[u] & barrier) { if (mask[u] & 1) hardHits++; else softHits++; } upOpen = false; }
      }
      if (py < mh - 1) {
        const d = idx + mw;
        if (!(mask[d] & barrier) && !region[d]) { if (!downOpen) { stack.push([x, py + 1]); downOpen = true; } }
        else { if (mask[d] & barrier) { if (mask[d] & 1) hardHits++; else softHits++; } downOpen = false; }
      }
    }
    if (count > cap) return { status: "leak" };
  }
  if (leaked) return { status: "leak" };
  // hatch/text slivers: plenty of cells but no room-like thickness
  if (count < TINY_PX || bx1 - bx0 + 1 < MIN_THICK || by1 - by0 + 1 < MIN_THICK) return { status: "tiny", count };
  return { status: "ok", region, count, mw, mh, ws, hardHits, softHits };
}

// The escalating fill. Pass 1 is the strict mask (walls + hatch — exactly the
// original behavior; masks with no soft cells never go further). When the strict
// pass is bounded by hatch, re-flood with hatch transparent (pass 2). Three tiers
// keyed off how much of the strict fill's boundary is soft (hatch) vs hard (wall):
//   • trapped (tiny/boundary): strict found no room — escalate UNBOUNDED (any
//     clean re-flood beats nothing).
//   • predominantly soft (≥ HATCH_BOUND_FRAC, e.g. a lone tile-grid cell): the
//     strict fill is a sliver of the real room — escalate UNBOUNDED.
//   • moderate ([HATCH_ESCALATE_FRAC, HATCH_BOUND_FRAC)): where real hatch-lined
//     rooms sit (issue #32 measured max ~0.63, so the 0.70 gate never fired).
//     Escalate GROW-BUT-VERIFY: accept walls-only only if it stays a clean "ok"
//     AND grows the area ≤ HATCH_GROWTH_MAX×. A misclassified wall then either
//     leaks or balloons and is discarded — the escalation can never do worse
//     than the strict pass.
//   • lightly soft (< escalateFrac) or a leak: strict result stands
//     (removing linework only leaks more).
// `sensitivity` (0..1) dials the moderate tier's escalateFrac/growthMax via
// escalationParams; the default is the calibrated Balanced preset.
export function floodRegion(maskObj: MaskObj, ix: number, iy: number, sensitivity: number = SENS_BALANCED): FloodResult {
  const r1 = floodPass(maskObj, ix, iy, 3);
  if (!maskObj.softCount) return r1;
  if (r1.status === "leak") return r1;
  const { escalateFrac, growthMax } = escalationParams(sensitivity);
  let growthCap = Infinity;                            // unbounded unless we're in the moderate band
  if (r1.status === "ok") {
    const blocks = (r1.hardHits || 0) + (r1.softHits || 0);
    const softFrac = blocks ? (r1.softHits || 0) / blocks : 0;
    if (softFrac < escalateFrac) return r1;            // lightly hatch-bounded ⇒ strict is right
    if (softFrac < HATCH_BOUND_FRAC) growthCap = growthMax; // moderate ⇒ grow-but-verify
  }
  const r2 = floodPass(maskObj, ix, iy, 1);
  if (r2.status === "ok" && (r1.status !== "ok" || r2.count <= r1.count * growthCap)) {
    r2.hatchFiltered = true;
    return r2;
  }
  return r1;
}

/** Flood with door/window gap sealing. Tries the normal escalating fill first.
 *  Sealing runs only when needed — a leak, or an oversized "ok" that is likely
 *  a door-connected floor plate — so already-closed rooms stay a single cheap
 *  flood (no full-sheet seal on every click). Prefer the sealed result when it
 *  encloses and is smaller; otherwise the unsealed result stands. */
export function floodRegionSealed(
  maskObj: MaskObj, ix: number, iy: number,
  sensitivity: number = SENS_BALANCED, maxGapMaskPx: number = 0,
): FloodResult {
  const r1 = floodRegion(maskObj, ix, iy, sensitivity);
  if (!(maxGapMaskPx >= 1)) return r1;
  // Modest enclosed fills are already the room — skip the seal pass.
  const sheet = maskObj.mw * maskObj.mh;
  if (r1.status === "ok" && r1.count <= sheet * 0.06) return r1;
  if (r1.status !== "ok" && r1.status !== "leak") return r1;
  const sealed = sealOpenings(maskObj, maxGapMaskPx);
  const r2 = floodRegion(sealed, ix, iy, sensitivity);
  if (r2.status === "ok" && (r1.status !== "ok" || r2.count < r1.count * 0.9)) {
    r2.openingsSealed = true;
    return r2;
  }
  return r1;
}

// ── 5. contour trace + simplify ────────────────────────────────────────────
// Moore-neighbor trace of the region's OUTER boundary, then closed-ring RDP.
// Returns image-px vertices.
export function traceRegion(reg: RegionResult, epsMaskPx = 1.5): Point[] {
  return mooreTrace(reg.region, reg.mw, reg.mh, reg.ws, epsMaskPx);
}

/** Moore-neighbor contour of 1-cells in a bitmap (room region or a hole mask). */
function mooreTrace(
  bitmap: Uint8Array, mw: number, mh: number, ws: number, epsMaskPx: number,
): Point[] {
  let s = -1;
  for (let i = 0; i < bitmap.length; i++) if (bitmap[i]) { s = i; break; }
  if (s < 0) return [];
  const sx = s % mw, sy = (s / mw) | 0;
  const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < mw && y < mh && !!bitmap[y * mw + x];
  const N = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const pts: Point[] = [];
  let cx = sx, cy = sy, dir = 6;
  const maxSteps = mw * mh * 4;
  for (let step = 0; step < maxSteps; step++) {
    pts.push([cx, cy]);
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8;
      const nx = cx + N[d][0], ny = cy + N[d][1];
      if (at(nx, ny)) { cx = nx; cy = ny; dir = d; found = true; break; }
    }
    if (!found) break;
    if (cx === sx && cy === sy && pts.length > 2) break;
  }
  const ring = rdpClosed(pts, epsMaskPx);
  return ring.map(([x, y]) => [x / ws, y / ws] as Point);
}

/** Mark exterior (non-region cells reachable from the mask border), then return
 *  each remaining enclosed non-region component as a 1-bitmap RegionResult. */
export function findRegionHoles(reg: RegionResult): RegionResult[] {
  const { region, mw, mh, ws } = reg;
  const exterior = new Uint8Array(mw * mh);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * mw + x;
    if (exterior[i] || region[i]) return;
    exterior[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < mw; x++) { push(x, 0); push(x, mh - 1); }
  for (let y = 0; y < mh; y++) { push(0, y); push(mw - 1, y); }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % mw, y = (i / mw) | 0;
    if (x > 0) push(x - 1, y);
    if (x < mw - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < mh - 1) push(x, y + 1);
  }
  const seen = new Uint8Array(mw * mh);
  const holes: RegionResult[] = [];
  for (let i = 0; i < region.length; i++) {
    if (region[i] || exterior[i] || seen[i]) continue;
    // BFS this hole component
    const hole = new Uint8Array(mw * mh);
    const q: number[] = [i];
    seen[i] = 1;
    let count = 0;
    while (q.length) {
      const j = q.pop() as number;
      hole[j] = 1; count++;
      const x = j % mw, y = (j / mw) | 0;
      const tryN = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) return;
        const k = ny * mw + nx;
        if (seen[k] || region[k] || exterior[k]) return;
        seen[k] = 1;
        q.push(k);
      };
      tryN(x - 1, y); tryN(x + 1, y); tryN(x, y - 1); tryN(x, y + 1);
    }
    if (count >= TINY_PX) holes.push({ region: hole, mw, mh, ws, count });
  }
  return holes;
}

export interface TraceHolesOpts {
  /** Units per IMAGE px (feet or meters per px — same unit the report uses). */
  upp: number;
  minSf?: number;
  maxFrac?: number;
  epsMaskPx?: number;
}

/** Outer contour plus size-gated interior holes (vanity, toilet, column, shaft).
 *  Hole area is measured in the caller's real unit² via upp. */
export function traceRegionWithHoles(
  reg: RegionResult, opts: TraceHolesOpts,
): { outer: Point[]; holes: Point[][] } {
  const eps = opts.epsMaskPx ?? 1.5;
  const minSf = opts.minSf ?? CUTOUT_MIN_SF;
  const maxFrac = opts.maxFrac ?? CUTOUT_MAX_FRAC;
  const outer = mooreTrace(reg.region, reg.mw, reg.mh, reg.ws, eps);
  if (outer.length < 3 || !(opts.upp > 0)) return { outer, holes: [] };
  const parentSf = ringArea(outer) * opts.upp * opts.upp;
  if (!(parentSf > 0)) return { outer, holes: [] };
  const maxSf = parentSf * maxFrac;
  const cellImg = 1 / reg.ws;
  const cellSf = cellImg * cellImg * opts.upp * opts.upp;
  const holes: Point[][] = [];
  for (const h of findRegionHoles(reg)) {
    const sf = (h.count || 0) * cellSf;
    if (sf < minSf || sf > maxSf) continue;
    const ring = mooreTrace(h.region, h.mw, h.mh, h.ws, eps);
    if (ring.length >= 3) holes.push(ring);
  }
  return { outer, holes };
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (!L) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / L;
}
function rdpOpen(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts.slice();
  let imax = 0, dmax = -1;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) { const d = perpDist(pts[i], a, b); if (d > dmax) { dmax = d; imax = i; } }
  if (dmax <= eps) return [a, b];
  const left = rdpOpen(pts.slice(0, imax + 1), eps);
  const right = rdpOpen(pts.slice(imax), eps);
  return left.slice(0, -1).concat(right);
}
// Closed ring: anchor at the two mutually-farthest-ish points (first vertex and
// the vertex farthest from it), simplify each half, rejoin.
export function rdpClosed(pts: Point[], eps: number): Point[] {
  if (pts.length < 4) return pts.slice();
  let split = 0, dmax = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > dmax) { dmax = d; split = i; }
  }
  const h1 = rdpOpen(pts.slice(0, split + 1), eps);
  const h2 = rdpOpen(pts.slice(split).concat([pts[0]]), eps);
  const ring = h1.slice(0, -1).concat(h2.slice(0, -1));
  return ring.length >= 3 ? ring : pts.slice();
}

// ── 5b. overlap + union (proposal multi-click merge) ───────────────────────
// When the estimator clicks again and the new fill overlaps an existing
// proposal region of the same kind, coalesce into one ring instead of stacking
// duplicate spaces. Proper edge crossings + interior samples detect real
// area overlap; shared walls (collinear edges / endpoints) do not merge.

function segOrient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** True iff closed rings A and B share interior area (not merely a wall edge). */
export function polygonsOverlap(a: Point[], b: Point[]): boolean {
  if (!a || a.length < 3 || !b || b.length < 3) return false;
  let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [x, y] of a) { if (x < ax0) ax0 = x; if (y < ay0) ay0 = y; if (x > ax1) ax1 = x; if (y > ay1) ay1 = y; }
  for (const [x, y] of b) { if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; }
  if (ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0) return false;
  // Strict interior only — vertices on a shared wall must not count as overlap.
  for (const [x, y] of a) if (strictlyInside(x, y, b)) return true;
  for (const [x, y] of b) if (strictlyInside(x, y, a)) return true;
  for (let i = 0; i < a.length; i++) {
    const [x0, y0] = a[i], [x1, y1] = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const [u0, v0] = b[j], [u1, v1] = b[(j + 1) % b.length];
      const o1 = segOrient(x0, y0, x1, y1, u0, v0);
      const o2 = segOrient(x0, y0, x1, y1, u1, v1);
      const o3 = segOrient(u0, v0, u1, v1, x0, y0);
      const o4 = segOrient(u0, v0, u1, v1, x1, y1);
      // Strict signs only — shared endpoints / collinear wall edges stay false.
      if (((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0)) && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true;
    }
  }
  return false;
}

function pointInPolyImg(x: number, y: number, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function distToSegImg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** pointInPoly and clearly off the boundary (shared walls / corners). */
function strictlyInside(x: number, y: number, pts: Point[], eps = 0.75): boolean {
  if (!pointInPolyImg(x, y, pts)) return false;
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const di = distToSegImg(x, y, ax, ay, bx, by);
    if (di < d) d = di;
  }
  return d > eps;
}

/** Scanline-fill a closed ring (mask-space floats) into a 0/1 bitmap (OR). */
function rasterFillPoly(mask: Uint8Array, mw: number, mh: number, poly: Point[]): void {
  const n = poly.length;
  if (n < 3) return;
  for (let y = 0; y < mh; y++) {
    const ys = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % n];
      if ((y0 > ys) === (y1 > ys)) continue;
      xs.push(x0 + (ys - y0) * (x1 - x0) / (y1 - y0));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let xL = Math.ceil(xs[k]), xR = Math.floor(xs[k + 1]);
      if (xL < 0) xL = 0;
      if (xR >= mw) xR = mw - 1;
      const row = y * mw;
      for (let x = xL; x <= xR; x++) mask[row + x] = 1;
    }
  }
}

/** Shared raster setup for boolean polygon ops → mask + world→mask mapping. */
function rasterSetup(polys: Point[][], maxDim = 1200): { mask: Uint8Array; mw: number; mh: number; ws: number; ox: number; oy: number } | null {
  const rings = polys.filter((p) => p && p.length >= 3);
  if (!rings.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of rings) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
  }
  if (!(maxX > minX) || !(maxY > minY)) return null;
  const pad = 2;
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const ws = Math.min(1, maxDim / span);
  const mw = Math.max(4, Math.ceil((maxX - minX) * ws) + pad * 2);
  const mh = Math.max(4, Math.ceil((maxY - minY) * ws) + pad * 2);
  const ox = minX - pad / ws, oy = minY - pad / ws;
  return { mask: new Uint8Array(mw * mh), mw, mh, ws, ox, oy };
}

function localPoly(poly: Point[], ox: number, oy: number, ws: number): Point[] {
  return poly.map(([x, y]) => [(x - ox) * ws, (y - oy) * ws] as Point);
}

function traceMask(mask: Uint8Array, mw: number, mh: number, ws: number, ox: number, oy: number, epsMaskPx: number): Point[] | null {
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
  if (count < TINY_PX) return null;
  const ring = mooreTrace(mask, mw, mh, 1, epsMaskPx); // ws=1 → mask-px verts
  if (ring.length < 3) return null;
  return ring.map(([x, y]) => [x / ws + ox, y / ws + oy] as Point);
}

/** Greedy maximal-rectangle cover of a 0/1 mask → image-px quads (exact trim for holes). */
function maskToMaxRectPolys(
  mask: Uint8Array, mw: number, mh: number, ws: number, ox: number, oy: number, minMaskPx = 2,
): Point[][] {
  const used = new Uint8Array(mw * mh);
  const polys: Point[][] = [];
  for (let y = 0; y < mh; y++) {
    let x = 0;
    while (x < mw) {
      const i = y * mw + x;
      if (!mask[i] || used[i]) { x++; continue; }
      let x1 = x;
      while (x1 < mw && mask[y * mw + x1] && !used[y * mw + x1]) x1++;
      let y1 = y + 1;
      outer: while (y1 < mh) {
        for (let xx = x; xx < x1; xx++) {
          if (!mask[y1 * mw + xx] || used[y1 * mw + xx]) break outer;
        }
        y1++;
      }
      for (let yy = y; yy < y1; yy++) {
        for (let xx = x; xx < x1; xx++) used[yy * mw + xx] = 1;
      }
      if (x1 - x >= minMaskPx && y1 - y >= minMaskPx) {
        const px0 = x / ws + ox, py0 = y / ws + oy;
        const px1 = x1 / ws + ox, py1 = y1 / ws + oy;
        polys.push([[px0, py0], [px1, py0], [px1, py1], [px0, py1]]);
      }
      x = x1;
    }
  }
  return polys;
}

function closestBridgeIndices(outer: Point[], inner: Point[]): { oi: number; ii: number } {
  let oi = 0, ii = 0, dmin = Infinity;
  for (let i = 0; i < outer.length; i++) {
    for (let j = 0; j < inner.length; j++) {
      const d = Math.hypot(outer[i][0] - inner[j][0], outer[i][1] - inner[j][1]);
      if (d < dmin) { dmin = d; oi = i; ii = j; }
    }
  }
  return { oi, ii };
}

/** One ring tracing a frame (outer minus one interior hole) in image px. */
function framePolygon(outer: Point[], inner: Point[], epsMaskPx: number): Point[] | null {
  if (outer.length < 3 || inner.length < 3) return null;
  const { oi, ii } = closestBridgeIndices(outer, inner);
  const oSeq = [...outer.slice(oi), ...outer.slice(0, oi)];
  const innerRev = [...inner].reverse();
  const iiRev = inner.length - 1 - ii;
  const iSeq = [...innerRev.slice(iiRev), ...innerRev.slice(0, iiRev)];
  const ring = [...oSeq, inner[ii], ...iSeq, oSeq[0]];
  if (!(epsMaskPx > 0)) return ring.length >= 3 ? ring : null;
  const cleaned = rdpClosed(ring, epsMaskPx);
  return cleaned.length >= 3 ? cleaned : null;
}

/** Cutter fully inside parent with clearance from the outer edge (interior punch). */
export function cutterStrictlyInsideParent(a: Point[], b: Point[], edgeInsetPx = 2.5): boolean {
  const cx = b.reduce((s, p) => s + p[0], 0) / b.length;
  const cy = b.reduce((s, p) => s + p[1], 0) / b.length;
  if (!pointInPolyImg(cx, cy, a)) return false;
  for (const [x, y] of b) {
    if (!pointInPolyImg(x, y, a)) return false;
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      if (distToSegImg(x, y, a[i][0], a[i][1], a[j][0], a[j][1]) < edgeInsetPx) return false;
    }
  }
  return true;
}

function maskRingToImagePoly(
  mask: Uint8Array, mw: number, mh: number, ws: number, ox: number, oy: number, epsMaskPx: number,
): Point[] | null {
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
  if (count < TINY_PX) return null;
  const reg: RegionResult = { region: mask, mw, mh, ws, count };
  const outer = mooreTrace(mask, mw, mh, ws, epsMaskPx).map(([x, y]) => [x / ws + ox, y / ws + oy] as Point);
  if (outer.length < 3) return null;
  const holes = findRegionHoles(reg);
  if (!holes.length) return null;
  let best = holes[0];
  for (const h of holes) if ((h.count || 0) > (best.count || 0)) best = h;
  const inner = mooreTrace(best.region, best.mw, best.mh, best.ws, epsMaskPx)
    .map(([x, y]) => [x / ws + ox, y / ws + oy] as Point);
  if (inner.length < 3) return null;
  return framePolygon(outer, inner, epsMaskPx);
}

/** Boolean subtract B from A → one or more floor rings that exactly cover A−B in image px. */
export function subtractPolygonsToPolys(a: Point[], b: Point[], epsMaskPx = 0.5): Point[][] {
  if (!a || a.length < 3) return [];
  if (!b || b.length < 3) return [a.map(([x, y]) => [x, y] as Point)];
  const aRing = a.map(([x, y]) => [x, y] as Point);
  const bRing = b.map(([x, y]) => [x, y] as Point);
  // Interior punch — exact parent + cutter rings so the hole matches the child mask.
  if (cutterStrictlyInsideParent(aRing, bRing)) {
    const frame = framePolygon(aRing, bRing, 0);
    if (frame && frame.length >= 3) return [frame];
  }
  const trimEps = Math.min(epsMaskPx, 0.75);
  const setup = rasterSetup([a, b], MASK_MAX_DIM);
  if (!setup) return [];
  const { mask, mw, mh, ws, ox, oy } = setup;
  rasterFillPoly(mask, mw, mh, localPoly(a, ox, oy, ws));
  const cut = new Uint8Array(mw * mh);
  rasterFillPoly(cut, mw, mh, localPoly(b, ox, oy, ws));
  for (let i = 0; i < mask.length; i++) if (cut[i]) mask[i] = 0;
  let pixels = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) pixels++;
  if (pixels < TINY_PX) return [];
  const pixelArea = pixels / (ws * ws);
  const bcx = bRing.reduce((s, p) => s + p[0], 0) / bRing.length;
  const bcy = bRing.reduce((s, p) => s + p[1], 0) / bRing.length;
  const tryExactFrame = () => {
    if (!pointInPolyImg(bcx, bcy, aRing)) return null;
    return framePolygon(aRing, bRing, 0);
  };
  const traced = traceMask(mask, mw, mh, ws, ox, oy, trimEps);
  if (traced && traced.length >= 3) {
    const traceArea = ringArea(traced);
    if (traceArea <= pixelArea * 1.08 && traceArea >= pixelArea * 0.92) return [traced];
    if (traceArea > pixelArea * 1.05) {
      const exact = tryExactFrame();
      if (exact && exact.length >= 3) return [exact];
      const frame = maskRingToImagePoly(mask, mw, mh, ws, ox, oy, trimEps);
      if (frame && frame.length >= 3) return [frame];
    }
  } else {
    const exact = tryExactFrame();
    if (exact && exact.length >= 3) return [exact];
    const frame = maskRingToImagePoly(mask, mw, mh, ws, ox, oy, trimEps);
    if (frame && frame.length >= 3) return [frame];
  }
  return maskToMaxRectPolys(mask, mw, mh, ws, ox, oy);
}

/** Boolean union of overlapping closed rings → one outer contour in image px. */
export function unionPolygons(polys: Point[][], epsMaskPx = 1.5): Point[] | null {
  const rings = polys.filter((p) => p && p.length >= 3);
  if (!rings.length) return null;
  if (rings.length === 1) return rings[0].map(([x, y]) => [x, y] as Point);
  const setup = rasterSetup(rings, MASK_MAX_DIM);
  if (!setup) return null;
  const { mask, mw, mh, ws, ox, oy } = setup;
  for (const poly of rings) rasterFillPoly(mask, mw, mh, localPoly(poly, ox, oy, ws));
  return traceMask(mask, mw, mh, ws, ox, oy, epsMaskPx);
}

/** Boolean difference A − B → one outer contour in image px (null if empty). */
export function differencePolygons(a: Point[], b: Point[], epsMaskPx = 1.5): Point[] | null {
  if (!a || a.length < 3) return null;
  if (!b || b.length < 3) return a.map(([x, y]) => [x, y] as Point);
  const setup = rasterSetup([a, b]);
  if (!setup) return null;
  const { mask, mw, mh, ws, ox, oy } = setup;
  rasterFillPoly(mask, mw, mh, localPoly(a, ox, oy, ws));
  // Punch B out of A.
  const cut = new Uint8Array(mw * mh);
  rasterFillPoly(cut, mw, mh, localPoly(b, ox, oy, ws));
  for (let i = 0; i < mask.length; i++) if (cut[i]) mask[i] = 0;
  return traceMask(mask, mw, mh, ws, ox, oy, epsMaskPx);
}

/** Boolean intersection A ∩ B → one outer contour in image px (null if empty). */
export function intersectPolygons(a: Point[], b: Point[], epsMaskPx = 0.75): Point[] | null {
  if (!a || a.length < 3 || !b || b.length < 3) return null;
  const setup = rasterSetup([a, b], MASK_MAX_DIM);
  if (!setup) return null;
  const { mask, mw, mh, ws, ox, oy } = setup;
  rasterFillPoly(mask, mw, mh, localPoly(a, ox, oy, ws));
  const bMask = new Uint8Array(mw * mh);
  rasterFillPoly(bMask, mw, mh, localPoly(b, ox, oy, ws));
  for (let i = 0; i < mask.length; i++) mask[i] = mask[i] && bMask[i] ? 1 : 0;
  return traceMask(mask, mw, mh, ws, ox, oy, Math.min(epsMaskPx, 0.75));
}

// ── 6. vertex snap + cleanup ───────────────────────────────────────────────
// Pull traced corners onto true PDF endpoints (the ruling: "vertices snapped").
// Collapses any post-snap duplicates; refuses a snap set that would degenerate
// the ring.
export function snapVertices(poly: Point[], nearest: NearestFn, tolPx = 6, minGapPx = 2): Point[] {
  const snapped: Point[] = poly.map(([x, y]) => {
    const hit = nearest(x, y, tolPx);
    return hit ? [hit[0], hit[1]] as Point : [x, y] as Point;
  });
  const out: Point[] = [];
  for (const p of snapped) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > minGapPx) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= minGapPx) out.pop();
  return out.length >= 3 ? out : poly;
}

// Shoelace in whatever px the ring is in (caller multiplies by upp²).
export function ringArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// ── 7. wall-ink flood (mirror of room flood — fills ink, not void) ─────────
// Wall Trace clicks on wall poché / heavy linework and floods the connected
// ink component. Rooms become holes when the ink region is traced with
// traceRegionWithHoles. Guards against dimension/grid bleed via line-weight
// prefilter (buildWallMask) + a separate leak cap.

export const WALL_LEAK_FRACTION = 0.15;   // Balanced default — one wing shouldn't exceed ~15% of sheet ink
export const WALL_TINY_PX = 20;
export const WALL_MIN_THICK = 3;
export const WALL_GROWTH_MAX = 2.5;
/** Long axis-aligned strokes above this fraction of the sheet side are treated as grid (not wall ink). */
export const WALL_GRID_SPAN_FRAC = 0.72;
/** Max device pen width for the grid-span rule — heavier strokes stay wall. */
export const WALL_GRID_MAX_DEVW = 3;

const WALL_SENS_ANCHORS: Array<[number, number, number, number]> = [
  [SENS_STRICT, 3, 0.10, 1.5],       // heavier pen only, tight leak cap
  [SENS_BALANCED, 2, WALL_LEAK_FRACTION, WALL_GROWTH_MAX],
  [SENS_AGGRESSIVE, 1, 0.22, 3.5],   // hairlines included, looser cap
];

/** Sensitivity → min device pen width, leak fraction, hatch-escalation growth cap. */
export function wallSensitivityParams(sensitivity: number): { minDevW: number; leakFraction: number; growthMax: number } {
  const s = Math.max(0, Math.min(1, Number.isFinite(sensitivity) ? sensitivity : SENS_BALANCED));
  let a = WALL_SENS_ANCHORS[0], b = WALL_SENS_ANCHORS[WALL_SENS_ANCHORS.length - 1];
  for (let i = 1; i < WALL_SENS_ANCHORS.length; i++) {
    if (s <= WALL_SENS_ANCHORS[i][0]) { a = WALL_SENS_ANCHORS[i - 1]; b = WALL_SENS_ANCHORS[i]; break; }
  }
  const t = b[0] === a[0] ? 0 : (s - a[0]) / (b[0] - a[0]);
  return {
    minDevW: Math.round(a[1] + (b[1] - a[1]) * t),
    leakFraction: a[2] + (b[2] - a[2]) * t,
    growthMax: a[3] + (b[3] - a[3]) * t,
  };
}

/** Wall-only mask: plot segments at or above minDevW device pen width.
 *  Solid poché fills (SEG_FILLONLY) always plot — they're wall ink, not hatch. */
export function buildWallMask(
  segs: number[], imgW: number, imgH: number,
  maxDim = MASK_MAX_DIM, meta: Uint8Array | null = null, minDevW = 2,
): MaskObj {
  const ws = Math.min(1, maxDim / Math.max(imgW, imgH, 1));
  const mw = Math.max(2, Math.ceil(imgW * ws)), mh = Math.max(2, Math.ceil(imgH * ws));
  const mask = new Uint8Array(mw * mh);
  const soft = meta ? classifyHatchSegs(segs, meta, ws) : null;
  let softCount = 0;
  const minW = Math.max(1, Math.floor(minDevW));
  for (let i = 0, si = 0; i + 3 < segs.length; i += 4, si++) {
    const flags = meta ? meta[si] : 0;
    if (flags & SEG_CLIP) continue;
    // Door swings are bezier chords — they bridge openings and must not be wall ink.
    if (flags & SEG_CURVE) continue;
    const devW = flags >> 4;
  // poché fills are always wall ink; thin strokes must clear the weight gate
    if (!(flags & SEG_FILLONLY) && devW < minW) continue;
    const sx0 = segs[i], sy0 = segs[i + 1], sx1 = segs[i + 2], sy1 = segs[i + 3];
    const dx = sx1 - sx0, dy = sy1 - sy0;
    const lenImg = Math.hypot(dx, dy);
    if (!(flags & SEG_FILLONLY) && lenImg > 0) {
      let ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
      if (ang > 90) ang = 180 - ang;
      const axis = ang <= 4 || ang >= 86;
      const spanLim = Math.max(imgW, imgH) * WALL_GRID_SPAN_FRAC;
      if (axis && lenImg >= spanLim && devW <= WALL_GRID_MAX_DEVW) continue;
    }
    const v = soft && soft[si] ? 2 : 1;
    if (v === 2) softCount++;
    let x0 = Math.round(sx0 * ws), y0 = Math.round(sy0 * ws);
    const x1 = Math.round(sx1 * ws), y1 = Math.round(sy1 * ws);
    const bdx = Math.abs(x1 - x0), bdy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = bdx + bdy;
    for (;;) {
      if (x0 >= 0 && y0 >= 0 && x0 < mw && y0 < mh) mask[y0 * mw + x0] |= v;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= bdy) { e += bdy; x0 += sx; }
      if (e2 <= bdx) { e += bdx; y0 += sy; }
    }
  }
  return { mask, mw, mh, ws, softCount };
}

/** 4-connected flood among ink pixels (mask bit & inkBits). */
function floodInkPass(maskObj: MaskObj, ix: number, iy: number, inkBits: number, leakFraction: number): FloodResult {
  const { mask, mw, mh, ws } = maskObj;
  const ink = (idx: number) => (mask[idx] & inkBits) !== 0;
  let sx = Math.round(ix * ws), sy = Math.round(iy * ws);
  if (sx < 0 || sy < 0 || sx >= mw || sy >= mh) return { status: "boundary" };
  if (!ink(sy * mw + sx)) {
    let found: Point | null = null;
    for (let r = 1; r <= 3 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = sx + dx, ny = sy + dy;
        if (nx >= 0 && ny >= 0 && nx < mw && ny < mh && ink(ny * mw + nx)) { found = [nx, ny]; break; }
      }
    }
    if (!found) return { status: "boundary" };
    sx = found[0]; sy = found[1];
  }
  const region = new Uint8Array(mw * mh);
  const cap = Math.floor(mw * mh * leakFraction);
  let count = 0, leaked = false;
  let bx0 = sx, bx1 = sx, by0 = sy, by1 = sy;
  const stack: number[][] = [[sx, sy]];
  while (stack.length) {
    const popped = stack.pop() as number[];
    const px = popped[0], py = popped[1];
    let x0 = px;
    while (x0 > 0 && ink((py * mw + x0 - 1)) && !region[py * mw + x0 - 1]) x0--;
    let x1 = px;
    while (x1 < mw - 1 && ink(py * mw + x1 + 1) && !region[py * mw + x1 + 1]) x1++;
    if (x0 === 0 || x1 === mw - 1 || py === 0 || py === mh - 1) leaked = true;
    if (x0 < bx0) bx0 = x0; if (x1 > bx1) bx1 = x1; if (py < by0) by0 = py; if (py > by1) by1 = py;
    let upOpen = false, downOpen = false;
    for (let x = x0; x <= x1; x++) {
      const idx = py * mw + x;
      if (region[idx]) { upOpen = downOpen = false; continue; }
      region[idx] = 1; count++;
      if (py > 0) {
        const u = idx - mw;
        if (ink(u) && !region[u]) { if (!upOpen) { stack.push([x, py - 1]); upOpen = true; } }
        else upOpen = false;
      }
      if (py < mh - 1) {
        const d = idx + mw;
        if (ink(d) && !region[d]) { if (!downOpen) { stack.push([x, py + 1]); downOpen = true; } }
        else downOpen = false;
      }
    }
    if (count > cap) return { status: "leak" };
  }
  if (leaked) return { status: "leak" };
  if (count < WALL_TINY_PX || bx1 - bx0 + 1 < WALL_MIN_THICK || by1 - by0 + 1 < WALL_MIN_THICK) return { status: "tiny", count };
  return { status: "ok", region, count, mw, mh, ws };
}

// ── 7b. door-neck break (thin bridge removal on hard ink) ───────────────────
// Removes door-width ink bridges so wall floods don't jump openings. Unlike
// morph-open, this keeps thin poché bands (2–3 mask px) intact — only strips
// pixels that are thin in both axes (header lines / swing chords).

function runLengths(hard: Uint8Array, mw: number, mh: number): { hRun: Uint16Array; vRun: Uint16Array } {
  const hRun = new Uint16Array(mw * mh);
  const vRun = new Uint16Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const row = y * mw;
    let x = 0;
    while (x < mw) {
      if (!hard[row + x]) { x++; continue; }
      let x1 = x;
      while (x1 < mw && hard[row + x1]) x1++;
      const len = x1 - x;
      for (let i = x; i < x1; i++) hRun[row + i] = len;
      x = x1;
    }
  }
  for (let x = 0; x < mw; x++) {
    let y = 0;
    while (y < mh) {
      const i = y * mw + x;
      if (!hard[i]) { y++; continue; }
      let y1 = y;
      while (y1 < mh && hard[y1 * mw + x]) y1++;
      const len = y1 - y;
      for (let j = y; j < y1; j++) vRun[j * mw + x] = len;
      y = y1;
    }
  }
  return { hRun, vRun };
}

/** Strip hard ink runs ≤ maxGap that are thin in both axes (door bridges). */
function breakAxisBridges(hard: Uint8Array, mw: number, mh: number, maxGap: number): Uint8Array {
  const gap = Math.max(1, Math.floor(maxGap));
  const { hRun, vRun } = runLengths(hard, mw, mh);
  const out = hard.slice();
  for (let y = 0; y < mh; y++) {
    const row = y * mw;
    let x = 0;
    while (x < mw) {
      if (!hard[row + x]) { x++; continue; }
      let x1 = x;
      while (x1 < mw && hard[row + x1]) x1++;
      const hLen = x1 - x;
      if (hLen <= gap) {
        for (let i = x; i < x1; i++) {
          const idx = row + i;
          if (vRun[idx] <= gap) out[idx] = 0;
        }
      }
      x = x1;
    }
  }
  for (let x = 0; x < mw; x++) {
    let y = 0;
    while (y < mh) {
      const i = y * mw + x;
      if (!hard[i]) { y++; continue; }
      let y1 = y;
      while (y1 < mh && hard[y1 * mw + x]) y1++;
      const vLen = y1 - y;
      if (vLen <= gap) {
        for (let j = y; j < y1; j++) {
          const idx = j * mw + x;
          if (hRun[idx] <= gap) out[idx] = 0;
        }
      }
      y = y1;
    }
  }
  return out;
}

const wallOpenCache = new WeakMap<Uint8Array, Map<number, MaskObj>>();

/** Break door-width ink bridges on hard wall ink; soft hatch bits preserved. */
export function breakWallOpenings(maskObj: MaskObj, maxGapMaskPx: number): MaskObj {
  const { mask, mw, mh, ws, softCount } = maskObj;
  const gap = Math.max(0, Math.floor(maxGapMaskPx));
  if (gap < 1) return { mask: mask.slice(), mw, mh, ws, softCount };
  let byGap = wallOpenCache.get(mask);
  const hit = byGap?.get(gap);
  if (hit) return hit;

  const hard = new Uint8Array(mw * mh);
  for (let i = 0; i < hard.length; i++) if (mask[i] & 1) hard[i] = 1;
  const opened = breakAxisBridges(hard, mw, mh, gap);
  const out = new Uint8Array(mw * mh);
  for (let i = 0; i < out.length; i++) {
    const soft = mask[i] & 2;
    out[i] = (opened[i] ? 1 : 0) | soft;
  }
  const result: MaskObj = { mask: out, mw, mh, ws, softCount };
  if (!byGap) { byGap = new Map(); wallOpenCache.set(mask, byGap); }
  byGap.set(gap, result);
  return result;
}

/** Wall flood mask: optional door-neck break before ink flood. Cached per source mask + gap. */
export function prepareWallFloodMask(maskObj: MaskObj, maxGapMaskPx: number = 0): MaskObj {
  return breakWallOpenings(maskObj, maxGapMaskPx);
}

/** Flood connected wall ink from a click. Pass 1 = hard walls (bit 1); if tiny
 *  and the mask has soft hatch, escalate to bits 1|2 with grow-but-verify. */
export function floodWallInk(
  maskObj: MaskObj, ix: number, iy: number,
  sensitivity: number = SENS_BALANCED, maxGapMaskPx: number = 0,
): FloodResult {
  const work = maxGapMaskPx >= 1 ? prepareWallFloodMask(maskObj, maxGapMaskPx) : maskObj;
  const { leakFraction, growthMax } = wallSensitivityParams(sensitivity);
  const r1 = floodInkPass(work, ix, iy, 1, leakFraction);
  if (!work.softCount) return r1;
  if (r1.status === "leak") return r1;
  if (r1.status === "ok") return r1;
  const r2 = floodInkPass(work, ix, iy, 3, leakFraction);
  if (r2.status === "ok" && (r1.status !== "ok" || r2.count <= (r1.count || 0) * growthMax)) {
    r2.hatchFiltered = true;
    return r2;
  }
  return r1;
}
