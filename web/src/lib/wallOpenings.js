// Door / window openings deducted from wall face area.
// Stored on the shape as additive `openings[]` (annotations JSON) — no DB schema.
// Internal units: feet (same as the rest of takeoff math).

const MM_PER_FT = 304.8;
const M_PER_FT = MM_PER_FT / 1000; // metres per foot — matches lib/units.ts

/**
 * Parse schedule size text into opening width/height in feet.
 * Accepts forms like "W 1100 × H 2200 mm", "1100x2200 mm", "900 × 2100".
 * @param {string|null|undefined} sizeStr
 * @returns {{ width_ft: number, height_ft: number, width_mm: number, height_mm: number }|null}
 */
export function parseOpeningSize(sizeStr) {
  const s = String(sizeStr || "").trim();
  if (!s) return null;
  const m =
    s.match(/W\s*([0-9]+(?:\.[0-9]+)?)\s*[×xX]\s*H\s*([0-9]+(?:\.[0-9]+)?)/i) ||
    s.match(/([0-9]+(?:\.[0-9]+)?)\s*[×xX]\s*([0-9]+(?:\.[0-9]+)?)\s*mm/i) ||
    s.match(/([0-9]+(?:\.[0-9]+)?)\s*mm\s*[×xX]\s*([0-9]+(?:\.[0-9]+)?)\s*mm/i) ||
    s.match(/([0-9]+(?:\.[0-9]+)?)\s*[×xX]\s*([0-9]+(?:\.[0-9]+)?)\s*m(?!m)\b/i) ||
    s.match(/^([0-9]+(?:\.[0-9]+)?)\s*[×xX]\s*([0-9]+(?:\.[0-9]+)?)$/);
  if (!m) return null;
  const wMm = Number(m[1]);
  const hMm = Number(m[2]);
  if (!(wMm > 0) || !(hMm > 0)) return null;
  // Metres suffix (e.g. "1.1 × 2.2 m") — values are already in metres.
  if (/m(?!m)\b/i.test(s) && !/mm/i.test(s)) {
    return {
      width_mm: wMm * 1000,
      height_mm: hMm * 1000,
      width_ft: wMm / M_PER_FT,
      height_ft: hMm / M_PER_FT,
    };
  }
  // Schedule sizes are millimetres unless a bare pair is already tiny (< 40 → treat as feet).
  const looksMm = /mm/i.test(s) || /W\s*\d/i.test(s) || wMm >= 40 || hMm >= 40;
  if (looksMm) {
    return {
      width_mm: wMm,
      height_mm: hMm,
      width_ft: wMm / MM_PER_FT,
      height_ft: hMm / MM_PER_FT,
    };
  }
  return {
    width_mm: wMm * MM_PER_FT,
    height_mm: hMm * MM_PER_FT,
    width_ft: wMm,
    height_ft: hMm,
  };
}

/** Sum of opening face areas (SF). */
export function openingsDeductSf(openings = []) {
  let sf = 0;
  for (const o of openings || []) {
    const w = Number(o.width_ft) || 0;
    const h = Number(o.height_ft) || 0;
    if (w > 0 && h > 0) sf += w * h;
  }
  return +sf.toFixed(2);
}

/**
 * Opening deduct for a linear wall run (surface_area): cap each opening to the
 * traced run length and wall height so a door cutout cannot zero-out net face
 * when the bbox spans the full run but the leaf is shorter.
 */
export function openingsDeductSfLinear(openings = [], lfFt = 0, wallHFt = 0) {
  const lf = Math.max(0, Number(lfFt) || 0);
  const hWall = Math.max(0, Number(wallHFt) || 0);
  const defaultDoorWFt = 3;
  const defaultDoorHFt = 7;
  const normalized = [];
  for (const o of openings || []) {
    let w = Math.max(0, Number(o.width_ft) || 0);
    let h = Math.max(0, Number(o.height_ft) || 0);
    if (lf > 0) {
      w = Math.min(w, lf);
      // Legacy cutout stored the full run as opening width — use a typical door width.
      if (o.source === "cutout" && w >= lf * 0.9) w = Math.min(defaultDoorWFt, lf);
    }
    if (o.source === "cutout" && hWall > 0 && h >= hWall * 0.95) {
      // Cutout bbox defaults to full wall height — treat as door leaf.
      h = Math.min(defaultDoorHFt, hWall);
    }
    // Schedule/manual: deduct door leaf W×H (not wall height × run length).
    if (w > 0 && h > 0) normalized.push({ w, h });
  }
  // Combined opening width along a linear run cannot exceed traced LF.
  if (lf > 0 && normalized.length > 1) {
    let totalW = normalized.reduce((n, item) => n + item.w, 0);
    if (totalW > lf) {
      const scale = lf / totalW;
      for (const item of normalized) item.w *= scale;
    }
  }
  let sf = normalized.reduce((n, item) => n + item.w * item.h, 0);
  const gross = lf > 0 && hWall > 0 ? lf * hWall : sf;
  return +Math.min(sf, gross).toFixed(2);
}

/**
 * Opening deduct for a floor mask perimeter wall face: each door deducts its leaf
 * W×H, capped to its share of the ring (width / perimeter LF × gross) so a border
 * door cannot zero-out the whole patch when gross is small.
 */
export function openingsDeductSfFloorPerim(openings = [], perimLfFt = 0, wallHFt = 0) {
  const lf = Math.max(0, Number(perimLfFt) || 0);
  const hWall = Math.max(0, Number(wallHFt) || 0);
  const gross = lf > 0 && hWall > 0 ? lf * hWall : 0;
  if (!(gross > 0) || !(lf > 0)) return 0;
  const defaultDoorWFt = 3;
  const defaultDoorHFt = 7;
  let sf = 0;
  for (const o of openings || []) {
    let w = Math.max(0, Number(o.width_ft) || 0);
    let h = Math.max(0, Number(o.height_ft) || 0);
    w = Math.min(w, lf);
    if (o.source === "cutout" && w >= lf * 0.9) w = Math.min(defaultDoorWFt, lf);
    if (hWall > 0) h = Math.min(h, hWall);
    if (o.source === "cutout" && hWall > 0 && h >= hWall * 0.95) {
      h = Math.min(defaultDoorHFt, hWall);
    }
    if (!(w > 0) || !(h > 0)) continue;
    const share = w / lf;
    sf += Math.min(w * h, gross * share);
  }
  return +Math.min(sf, gross).toFixed(2);
}

/** Net wall face after opening deducts (never negative). */
export function netWallFaceSf(grossSf, openings) {
  return +Math.max(0, (Number(grossSf) || 0) - openingsDeductSf(openings)).toFixed(2);
}

/** Axis-aligned bbox of a ring → [x0,y0,x1,y1] or null. */
function ringBBox(ring) {
  if (!Array.isArray(ring) || !ring.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) {
    if (!p || p.length < 2) continue;
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return [x0, y0, x1, y1];
}

/**
 * BBox intersection of cutout ∩ wall as a rectangle ring (fallback when
 * boolean intersection is empty). Cutouts that extend past the wall must not
 * use the full cutout height as opening width.
 * @param {number[][]} cutterPx
 * @param {number[][]} wallPx
 * @returns {number[][]|null}
 */
export function bboxIntersectRing(cutterPx, wallPx) {
  const a = ringBBox(cutterPx);
  const b = ringBBox(wallPx);
  if (!a || !b) return null;
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/**
 * Plan cutout ring (preferably cutout∩wall) → opening W×H for wall face deduct.
 * Width = longer plan side of the clipped ring (span along the wall).
 * Height defaults to wall height (edit down to door leaf H in the openings UI).
 * @param {number[][]} cutterPx image-px ring
 * @param {number} upp feet per image px
 * @param {number} wallHeightFt
 * @returns {{ width_ft: number, height_ft: number }|null}
 */
export function openingDimsFromCutoutPx(cutterPx, upp, wallHeightFt) {
  if (!Array.isArray(cutterPx) || cutterPx.length < 3) return null;
  const u = Number(upp) || 0;
  const hWall = Math.max(0, Number(wallHeightFt) || 0);
  if (!(u > 0) || !(hWall > 0)) return null;
  const box = ringBBox(cutterPx);
  if (!box) return null;
  const sideA = (box[2] - box[0]) * u;
  const sideB = (box[3] - box[1]) * u;
  // Along a thin wall the clipped ring is short across thickness and long along
  // the opening — take the longer side as clear width.
  const width_ft = Math.max(sideA, sideB);
  if (!(width_ft > 0)) return null;
  return { width_ft: +width_ft.toFixed(4), height_ft: +hWall.toFixed(4) };
}
