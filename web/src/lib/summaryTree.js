// Hierarchical Summary Tree — Floor (Level) → Item Type → Item Code (Finish Tag) → Shapes
// Pure logic for the Summary Table / Panel requested in Client POC feedback.

import { round2 } from "./totals.js";
import { areaUnit, lenUnit, areaVal, lenVal } from "./units";
import { parseSheetKey } from "./sheetKey";
import { floorLabelFromSheetId } from "./boqDetect.js";

/**
 * Resolves the floor level name for a sheet.
 */
export function resolveFloorLevel(sheetId, sheetLevels = {}, sheetLabel = null) {
  if (!sheetId) return "Unassigned Level";
  if (sheetLevels?.[sheetId]) return sheetLevels[sheetId];
  const parsed = parseSheetKey(sheetId);
  if (sheetLevels?.[parsed.file]) return sheetLevels[parsed.file];
  const base = String(sheetId || "").replace(/^.*[/\\]/, "").split("#")[0].toLowerCase();
  for (const [k, v] of Object.entries(sheetLevels || {})) {
    const kb = String(k).replace(/^.*[/\\]/, "").split("#")[0].toLowerCase();
    if (kb === base) return v;
  }
  for (const [k, v] of Object.entries(sheetLevels || {})) {
    const kt = parseSheetKey(k);
    if (kt.file === parsed.file || kt.file.split("/").pop() === parsed.file.split("/").pop()) return v;
  }
  const fromFile = floorLabelFromSheetId(sheetId);
  if (fromFile) return fromFile;
  const label = typeof sheetLabel === "function" ? sheetLabel(sheetId) : sheetId;
  const m = String(label).match(/(\d+(?:st|nd|rd|th))(?:\s*(?:&|and)\s*(\d+(?:st|nd|rd|th)))?\s*floor/i);
  if (m) return m[2] ? `${m[1]} & ${m[2]} Floor` : `${m[1]} Floor`;
  return label || "Unassigned Level";
}

/**
 * Maps measurement role to standardized item category.
 */
export function categorizeMeasureRole(role) {
  switch (role) {
    case "floor_area":
    case "deduct":
      return { key: "floor", label: "Floor Finishes", defaultUnit: "SF", isArea: true };
    case "surface_area":
    case "wall_area":
      return { key: "wall", label: "Wall Finishes", defaultUnit: "SF", isArea: true };
    case "linear":
      return { key: "linear", label: "Skirting / Linear", defaultUnit: "LF", isLen: true };
    case "count":
      return { key: "count", label: "Count / Fixtures", defaultUnit: "EA", isCount: true };
    default:
      return { key: "other", label: "Other Measurements", defaultUnit: "EA" };
  }
}

/**
 * Natural comparator for floor sorting (Ground Floor < 1st Floor < 2nd Floor < 10th Floor < Roof).
 */
export function compareFloorLevels(a, b) {
  const norm = (s) => {
    const str = String(s || "").trim().toLowerCase();
    if (str.includes("basement") || str.includes("b1") || str.includes("b2")) return -100;
    if (str.includes("ground") || str.includes("g floor") || str === "g") return 0;
    const m = str.match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
    if (str.includes("roof") || str.includes("penthouse")) return 999;
    return 500;
  };
  const na = norm(a);
  const nb = norm(b);
  if (na !== nb) return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Computes shape display quantity based on measurement role and units.
 */
function computeShapeQty(shape, units = "imperial") {
  const role = shape.measure_role;
  const cp = shape.computed || {};
  let raw = 0;
  let unit = areaUnit(units);

  if (role === "floor_area" || role === "deduct") {
    raw = cp.area_sf || 0;
    unit = areaUnit(units);
    const converted = areaVal(raw, units);
    return { raw, qty: converted, unit };
  }
  if (role === "surface_area" || role === "wall_area") {
    raw = cp.wall_face_sf || cp.area_sf || 0;
    unit = areaUnit(units);
    const converted = areaVal(raw, units);
    return { raw, qty: converted, unit };
  }
  if (role === "linear") {
    raw = cp.perimeter_lf || 0;
    unit = lenUnit(units);
    const converted = lenVal(raw, units);
    return { raw, qty: converted, unit };
  }
  if (role === "count") {
    raw = cp.count || 1;
    unit = "EA";
    return { raw, qty: raw, unit };
  }
  raw = cp.area_sf || cp.perimeter_lf || cp.count || 0;
  return { raw, qty: raw, unit };
}

/**
 * Builds the 3-level hierarchical summary tree:
 * Floor (Level) → Item Type → Item Code (Finish Tag) → Shapes
 *
 * @param {Object} [options]
 * @param {any[]} [options.shapes] Live takeoff shapes
 * @param {any[]} [options.conditions] Available conditions/finishes
 * @param {Record<string, string>} [options.sheetLevels] Map of sheet ID to floor level name
 * @param {((id: string) => string)|null} [options.sheetLabel] Sheet label resolver
 * @param {Record<string, boolean>|Set<string>} [options.hiddenShapeIds] Map/Set of hidden shape IDs
 * @param {string} [options.units] "imperial" | "metric"
 * @param {any[]} [options.boqLines] Optional BOQ line metadata
 * @param {((shape: any) => string)|null} [options.roomForShape] Room name resolver (e.g. detectRoomName)
 * @returns {any[]} Tree of Floor nodes
 */
export function buildSummaryTree({
  shapes = [],
  conditions = [],
  sheetLevels = {},
  sheetLabel = null,
  hiddenShapeIds = {},
  units = "imperial",
  boqLines = [],
  roomForShape = null,
} = {}) {
  const condMap = new Map((conditions || []).map((c) => [c.id, c]));
  const boqMetaMap = new Map((boqLines || []).map((l) => [l.id || `shape::${l.shape_id}`, l]));
  const isHidden = (id) => (hiddenShapeIds instanceof Set ? hiddenShapeIds.has(id) : !!hiddenShapeIds[id]);

  // Group by Floor
  const floorMap = new Map();

  for (const s of shapes || []) {
    if (!s || !s.id) continue;
    const floor = resolveFloorLevel(s.sheet_id, sheetLevels, sheetLabel);
    if (!floorMap.has(floor)) {
      floorMap.set(floor, {
        id: `floor::${floor}`,
        level: floor,
        shapes: [],
        sheet_ids: new Set(),
      });
    }
    const fl = floorMap.get(floor);
    fl.shapes.push(s);
    if (s.sheet_id) fl.sheet_ids.add(s.sheet_id);
  }

  // Sort floors logically (Ground, 1st, 2nd, etc.)
  const sortedFloors = [...floorMap.values()].sort((a, b) => compareFloorLevels(a.level, b.level));

  return sortedFloors.map((fl) => {
    // Group shapes by Category (Item Type)
    const catMap = new Map();

    for (const s of fl.shapes) {
      const cat = categorizeMeasureRole(s.measure_role);
      if (!catMap.has(cat.key)) {
        catMap.set(cat.key, {
          id: `floor::${fl.level}::type::${cat.key}`,
          typeKey: cat.key,
          label: cat.label,
          shapes: [],
        });
      }
      catMap.get(cat.key).shapes.push(s);
    }

    const typeOrder = ["floor", "wall", "linear", "count", "other"];
    const sortedTypes = [...catMap.values()].sort(
      (a, b) => typeOrder.indexOf(a.typeKey) - typeOrder.indexOf(b.typeKey)
    );

    let floorTotalQty = 0;
    const floorShapeIds = [];

    const typeNodes = sortedTypes.map((tn) => {
      // Group by Item Code (Finish Tag / Code)
      const codeMap = new Map();

      for (const s of tn.shapes) {
        floorShapeIds.push(s.id);
        const cond = condMap.get(s.condition_id);
        const code = (cond?.finish_tag || cond?.name || "Unassigned").trim();
        const condId = s.condition_id || "unassigned";
        const key = `${condId}::${code}`;

        if (!codeMap.has(key)) {
          codeMap.set(key, {
            id: `floor::${fl.level}::type::${tn.typeKey}::code::${key}`,
            code,
            condition_id: s.condition_id || null,
            color: cond?.color || "#888888",
            hatch: cond?.hatch || null,
            description: cond?.description || "",
            unit: tn.typeKey === "linear" ? lenUnit(units) : tn.typeKey === "count" ? "EA" : areaUnit(units),
            shapes: [],
          });
        }

        const q = computeShapeQty(s, units);
        const boqMeta = boqMetaMap.get(`shape::${s.id}`);
        const detectedRoom = typeof roomForShape === "function" ? roomForShape(s) : "";
        const rawRoom = (boqMeta?.room || detectedRoom || s.room || s.room_name || s.room_detected || "").trim();
        const roomName = /^DETAIL\s+\d/i.test(rawRoom) ? "" : rawRoom;

        codeMap.get(key).shapes.push({
          id: s.id,
          sheet_id: s.sheet_id,
          role: s.measure_role,
          room: roomName,
          qty: q.qty,
          rawQty: q.raw,
          unit: q.unit,
          hidden: isHidden(s.id),
        });
      }

      // Compute code totals
      const codeNodes = [...codeMap.values()]
        .map((cn) => {
          const total_qty = round2(cn.shapes.reduce((sum, item) => sum + (item.qty || 0), 0));
          const shape_ids = cn.shapes.map((x) => x.id);
          const allHidden = shape_ids.length > 0 && shape_ids.every((id) => isHidden(id));
          const someHidden = shape_ids.some((id) => isHidden(id));
          return {
            ...cn,
            total_qty,
            shape_ids,
            shapes_count: cn.shapes.length,
            hidden: allHidden,
            indeterminate: someHidden && !allHidden,
          };
        })
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

      const typeTotalQty = round2(codeNodes.reduce((sum, c) => sum + c.total_qty, 0));
      const typeShapeIds = codeNodes.flatMap((c) => c.shape_ids);
      const allTypeHidden = typeShapeIds.length > 0 && typeShapeIds.every((id) => isHidden(id));
      const someTypeHidden = typeShapeIds.some((id) => isHidden(id));

      floorTotalQty += typeTotalQty;

      return {
        id: tn.id,
        typeKey: tn.typeKey,
        label: tn.label,
        unit: tn.typeKey === "linear" ? lenUnit(units) : tn.typeKey === "count" ? "EA" : areaUnit(units),
        total_qty: typeTotalQty,
        shape_ids: typeShapeIds,
        shapes_count: typeShapeIds.length,
        hidden: allTypeHidden,
        indeterminate: someTypeHidden && !allTypeHidden,
        children: codeNodes,
      };
    });

    const allFloorHidden = floorShapeIds.length > 0 && floorShapeIds.every((id) => isHidden(id));
    const someFloorHidden = floorShapeIds.some((id) => isHidden(id));

    return {
      id: fl.id,
      level: fl.level,
      sheet_ids: [...fl.sheet_ids],
      shape_ids: floorShapeIds,
      shapes_count: floorShapeIds.length,
      total_qty: round2(floorTotalQty),
      hidden: allFloorHidden,
      indeterminate: someFloorHidden && !allFloorHidden,
      children: typeNodes,
    };
  });
}
