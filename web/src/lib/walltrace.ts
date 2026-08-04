// Wall Trace — one-click connected wall network detection for BOQ costing.
// Clicks wall ink → flood connected ink → trace outer contour + room holes →
// footprint / face area / volume quantities.

import {
  type Point,
  type MaskObj,
  type FloodResult,
  type RegionResult,
  buildWallMask,
  floodWallInk,
  traceRegionWithHoles,
  snapVertices,
  ringArea,
  SENS_BALANCED,
  wallSensitivityParams,
  type NearestFn,
} from "./oneclick";

export type WallTraceStatus = "ok" | "leak" | "tiny" | "boundary" | "no_scale" | "no_ring";

export interface WallTraceQuantities {
  footprint_sf: number;
  perimeter_lf: number;
  wall_face_sf: number;
  volume_cf: number;
  area_sf: number;
}

export interface WallTraceOk {
  status: "ok";
  outer: Point[];
  holes: Point[][];
  flood: FloodResult & { status: "ok" };
  hatchFiltered?: boolean;
  quantities: WallTraceQuantities;
}

export type WallTraceResult =
  | WallTraceOk
  | { status: Exclude<WallTraceStatus, "ok">; message: string; count?: number };

export interface WallTraceOpts {
  upp: number;
  heightFt: number;
  sensitivity?: number;
  nearest?: NearestFn;
  snapTolPx?: number;
  epsMaskPx?: number;
  /** Door-sized neck break in mask px (from openingGapPx). */
  maxGapMaskPx?: number;
}

/** Closed-ring perimeter in image px (sum of edge lengths). */
export function ringPerimeter(pts: Point[]): number {
  if (!pts || pts.length < 2) return 0;
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}

/** Wall trace quantities from outer ring + holes (image px rings). */
export function wallQuantitiesFromRings(
  outer: Point[],
  holes: Point[][],
  upp: number,
  heightFt: number,
): WallTraceQuantities {
  let footprintPx = ringArea(outer);
  for (const h of holes) footprintPx -= ringArea(h);
  footprintPx = Math.max(0, footprintPx);
  let perimPx = ringPerimeter(outer);
  for (const h of holes) perimPx += ringPerimeter(h);
  const footprint_sf = +(footprintPx * upp * upp).toFixed(2);
  const perimeter_lf = +(perimPx * upp).toFixed(2);
  const h = Math.max(0, Number(heightFt) || 0);
  const wall_face_sf = +(perimeter_lf * h).toFixed(2);
  const volume_cf = +(footprint_sf * h).toFixed(2);
  return {
    footprint_sf,
    perimeter_lf,
    wall_face_sf,
    volume_cf,
    area_sf: wall_face_sf,
  };
}

function failMessage(status: string, count?: number): string {
  switch (status) {
    case "leak":
      return "That wall network reaches the sheet edge or grabbed too much linework (dimensions/grid?). Try Strict sensitivity, or click a more enclosed wall band.";
    case "tiny":
      return `Landed on thin linework (${count ?? 0} px) — zoom in and click solid wall poché, or use Surface Area (S).`;
    case "boundary":
      return "Click directly on a wall line or filled poché band.";
    default:
      return "Couldn't trace that wall — use Surface Area (S) or Linear (L).";
  }
}

/** Build a wall-weight-gated mask from sheet segments (image px). */
export function buildWallMaskFromSegs(
  segs: number[],
  imgW: number,
  imgH: number,
  meta: Uint8Array | null,
  sensitivity: number = SENS_BALANCED,
): MaskObj {
  const { minDevW } = wallSensitivityParams(sensitivity);
  return buildWallMask(segs, imgW, imgH, undefined, meta, minDevW);
}

/** Full wall-trace pipeline after a successful ink flood. */
export function traceWallRegion(
  flood: FloodResult & { status: "ok" },
  opts: WallTraceOpts,
): WallTraceOk | { status: "no_ring" } {
  const { upp, heightFt, nearest, snapTolPx = 7, epsMaskPx = 1.5 } = opts;
  const reg: RegionResult = {
    region: flood.region,
    mw: flood.mw,
    mh: flood.mh,
    ws: flood.ws,
    count: flood.count,
  };
  const { outer: rawOuter, holes: rawHoles } = traceRegionWithHoles(reg, { upp, epsMaskPx, maxFrac: 0.98 });
  const snapRing = (ring: Point[]) =>
    nearest ? snapVertices(ring, nearest, snapTolPx) : ring;
  const outer = snapRing(rawOuter);
  const holes = rawHoles.map((h) => snapRing(h));
  if (outer.length < 3) return { status: "no_ring" };
  const quantities = wallQuantitiesFromRings(outer, holes, upp, heightFt);
  return {
    status: "ok",
    outer,
    holes,
    flood,
    hatchFiltered: flood.hatchFiltered,
    quantities,
  };
}

/** Click image px → flood wall ink → trace → quantities. */
export function wallTraceAtPoint(
  maskObj: MaskObj,
  ix: number,
  iy: number,
  opts: WallTraceOpts,
): WallTraceResult {
  const { upp, heightFt, sensitivity = SENS_BALANCED, maxGapMaskPx = 0 } = opts;
  if (!(upp > 0)) return { status: "no_scale", message: "Set the scale for this sheet first." };
  if (!(heightFt > 0)) return { status: "no_scale", message: "Set a wall height on the active condition (H in the condition editor)." };
  const f = floodWallInk(maskObj, ix, iy, sensitivity, maxGapMaskPx);
  if (f.status !== "ok") {
    return { status: f.status, message: failMessage(f.status, f.count), count: f.count };
  }
  const traced = traceWallRegion(f, opts);
  if (traced.status !== "ok") {
    return { status: "no_ring", message: "Couldn't outline that wall network — try Surface Area (S)." };
  }
  return traced;
}
