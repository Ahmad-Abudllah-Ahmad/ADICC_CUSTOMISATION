// Per-segment wall heights for surface_area (Wall Area line) runs.
// Stored on shape.segment_heights_ft and mirrored in origin.segment_heights_ft
// (origin is persisted to Supabase JSON — no schema migration).

export function defaultWallHeightFt(shape, condHeightFt = 0) {
  if (shape?.height_override === true) return Math.max(0, Number(shape.height_ft) || 0);
  return Math.max(0, Number(shape?.height_ft) || Number(condHeightFt) || 0);
}

export function readSegmentHeightsRaw(shape) {
  if (Array.isArray(shape?.segment_heights_ft)) return shape.segment_heights_ft;
  if (Array.isArray(shape?.origin?.segment_heights_ft)) return shape.origin.segment_heights_ft;
  return null;
}

/** One height (ft) per line segment — open runs: verts − 1; closed loops: verts (includes return leg). */
export function segmentHeightsForShape(shape, condHeightFt = 0) {
  const v = shape?.verts_norm?.length || 0;
  const closed = !!(shape?.origin?.closed_loop);
  const n = closed ? Math.max(0, v) : Math.max(0, v - 1);
  if (n === 0) return [];
  const defaultH = defaultWallHeightFt(shape, condHeightFt);
  const raw = readSegmentHeightsRaw(shape);
  if (!raw?.length) return Array(n).fill(defaultH);
  return Array.from({ length: n }, (_, i) => {
    if (i < raw.length && raw[i] != null && raw[i] !== "") {
      return Math.max(0, Number(raw[i]) || 0);
    }
    return defaultH;
  });
}

export function withSegmentHeights(shape, heights) {
  const seg = heights.map((h) => Math.max(0, Number(h) || 0));
  return {
    ...shape,
    segment_heights_ft: seg,
    height_override: true,
    origin: { ...(shape.origin || {}), segment_heights_ft: seg },
  };
}

export function grossFaceFromSegments(ptsPx, segHeightsFt, upp, closedLoop = false) {
  let lf = 0;
  let gross = 0;
  for (let i = 1; i < ptsPx.length; i++) {
    const segLf = Math.hypot(ptsPx[i][0] - ptsPx[i - 1][0], ptsPx[i][1] - ptsPx[i - 1][1]) * upp;
    const h = segHeightsFt[i - 1] || 0;
    lf += segLf;
    gross += segLf * h;
  }
  if (closedLoop && ptsPx.length >= 3) {
    const last = ptsPx.length - 1;
    const segLf = Math.hypot(ptsPx[0][0] - ptsPx[last][0], ptsPx[0][1] - ptsPx[last][1]) * upp;
    const h = segHeightsFt[last] || 0;
    lf += segLf;
    gross += segLf * h;
  }
  return {
    perimeter_lf: +lf.toFixed(2),
    gross_face_sf: +gross.toFixed(2),
    avg_height_ft: lf > 0 ? gross / lf : 0,
  };
}

export function wallSegmentRows(shape, imgW, imgH, upp, condHeightFt = 0) {
  if (!shape?.verts_norm?.length || shape.measure_role !== "surface_area") return [];
  const pts = shape.verts_norm.map(([nx, ny]) => [nx * imgW, ny * imgH]);
  const hs = segmentHeightsForShape(shape, condHeightFt);
  const closed = !!(shape?.origin?.closed_loop);
  const segCount = closed ? pts.length : pts.length - 1;
  const rows = [];
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = closed && i === segCount - 1 ? pts[0] : pts[i + 1];
    const lf = Math.hypot(b[0] - a[0], b[1] - a[1]) * upp;
    const h = hs[i] || 0;
    rows.push({
      index: i,
      label: `Line ${i + 1}`,
      lf: +lf.toFixed(2),
      height_ft: h,
      face_sf: +(lf * h).toFixed(2),
    });
  }
  return rows;
}

export function concatSegmentHeightsForMerge(shapes, condById, targetSegCount, fallbackH) {
  let merged = [];
  for (const s of shapes) {
    const condH = Number(condById[s.condition_id]?.height_ft) || 0;
    merged.push(...segmentHeightsForShape(s, condH));
  }
  const need = Math.max(0, targetSegCount);
  if (merged.length > need) merged = merged.slice(0, need);
  while (merged.length < need) merged.push(fallbackH);
  return merged;
}
