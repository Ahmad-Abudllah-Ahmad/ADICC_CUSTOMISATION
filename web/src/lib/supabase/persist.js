// Sync OpenTakeoff annotations payload ↔ normalized Supabase tables.
import { supabase } from "./client.js";
import { deleteAllProjectFiles } from "./projectFiles.js";
import { conditionTotals } from "../totals.js";
import { round2 } from "../totals.js";
import { pricedConditionTotals, pricedGrandTotals } from "../pricing.js";
import { ANN_SCHEMA, emptyAnnotations } from "../store.js";
import { parseSheetKey } from "../sheetKey.ts";

const shapeSnapshot = new Map(); // projectId -> Map(shapeId -> snapshot)

/** A1108/A1109 masks were stored with bare filenames; live sheets use folder paths. */
const AI_FLOOR_SHEET_FIX = new Set([
  "a1108-4th floor plan.pdf",
  "a1109-5th & 6th floor plan.pdf",
]);

function sheetBasename(sheetId) {
  return parseSheetKey(String(sheetId || "")).file.replace(/^.*[/\\]/, "").toLowerCase();
}

function needsAiFloorSheetFix(sheetId) {
  return AI_FLOOR_SHEET_FIX.has(sheetBasename(sheetId));
}

/** Resolve bare A1108/A1109 ids to the project’s canonical sheet path (file_folders keys). */
export function resolveAiFloorSheetId(sheetId, fileFolders = {}) {
  if (!sheetId || !needsAiFloorSheetFix(sheetId)) return sheetId;
  const { page } = parseSheetKey(sheetId);
  const base = sheetBasename(sheetId);
  const folderKey = Object.keys(fileFolders || {}).find(
    (k) => k.split("/").pop()?.toLowerCase() === base,
  );
  if (!folderKey) return sheetId;
  return page > 1 ? `${folderKey}#${page}` : folderKey;
}

export function normalizeAiFloorShapeSheetIds(shapes, fileFolders = {}) {
  if (!Array.isArray(shapes) || !shapes.length) return shapes || [];
  let changed = false;
  const next = shapes.map((s) => {
    if (!s || !needsAiFloorSheetFix(s.sheet_id)) return s;
    const sheet_id = resolveAiFloorSheetId(s.sheet_id, fileFolders);
    if (sheet_id === s.sheet_id) return s;
    changed = true;
    return { ...s, sheet_id };
  });
  return changed ? next : shapes;
}

/** Match view key to stored shape sheet_id (exact or A1108/A1109 basename + page). */
export function aiFloorSheetKeysMatch(shapeSheetId, viewKey) {
  if (!shapeSheetId || !viewKey) return false;
  if (shapeSheetId === viewKey) return true;
  if (!needsAiFloorSheetFix(shapeSheetId) && !needsAiFloorSheetFix(viewKey)) return false;
  const a = parseSheetKey(shapeSheetId);
  const b = parseSheetKey(viewKey);
  return sheetBasename(shapeSheetId) === sheetBasename(viewKey) && a.page === b.page;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function holesCount(s) {
  return Array.isArray(s.holes_norm) ? s.holes_norm.length : 0;
}

function areaOf(s) {
  return num(s?.computed?.area_sf) ?? 0;
}

function lfOf(s) {
  return num(s?.computed?.perimeter_lf) ?? 0;
}

function markupGeometry(m) {
  const g = {};
  for (const k of ["rect", "at", "target", "from", "to", "pts", "path", "vb", "w", "r", "fill", "rev"]) {
    if (m[k] !== undefined) g[k] = m[k];
  }
  return g;
}

function markupStyle(m) {
  const s = {};
  for (const k of ["color", "line_style", "weight"]) {
    if (m[k] !== undefined) s[k] = m[k];
  }
  return s;
}

function rfiMetadata(r) {
  const { id, number, subject, question, status, sheet_id, ...rest } = r;
  return rest;
}

function computeTotals(conditions, shapes, boqLines, pricingOpts = {}) {
  const condTotals = conditionTotals(conditions, shapes);
  const { materialRates = [], projectSettings = {}, displayUnits = "metric" } = pricingOpts;
  const priced = materialRates.length
    ? pricedConditionTotals(condTotals, materialRates, displayUnits, projectSettings)
    : condTotals;
  const costGrand = materialRates.length ? pricedGrandTotals(priced, projectSettings) : null;
  const byConditionCost = {};
  if (materialRates.length) {
    for (const t of priced) {
      byConditionCost[t.id] = {
        finish_tag: t.finish_tag,
        material_ext: t.material_ext || 0,
        labour_ext: t.labour_ext || 0,
        line_total: t.line_total || 0,
      };
    }
  }
  let floor = 0, wall = 0, border = 0, lf = 0, ea = 0;
  const byCondition = {};
  const bySheet = {};

  for (const t of condTotals) {
    floor += t.floor_sf || 0;
    wall += t.wall_sf || 0;
    border += t.border_sf || 0;
    lf += t.lf || 0;
    ea += t.ea || 0;
    byCondition[t.id] = {
      finish_tag: t.finish_tag,
      shape_count: t.shape_count,
      floor_sf: t.floor_sf,
      wall_sf: t.wall_sf,
      lf: t.lf,
      ea: t.ea,
      total_sf: t.total_sf,
    };
  }

  for (const s of shapes) {
    const sid = s.sheet_id;
    if (!bySheet[sid]) bySheet[sid] = { shape_count: 0, floor_sf: 0, wall_sf: 0, lf: 0, ea: 0 };
    bySheet[sid].shape_count += 1;
    const cp = s.computed || {};
    switch (s.measure_role) {
      case "deduct": bySheet[sid].floor_sf -= cp.area_sf || 0; break;
      case "floor_area": bySheet[sid].floor_sf += cp.area_sf || 0; break;
      case "surface_area": bySheet[sid].wall_sf += cp.area_sf || 0; break;
      case "wall_area":
        bySheet[sid].wall_sf += cp.wall_face_sf || cp.area_sf || 0;
        break;
      case "linear":
        bySheet[sid].lf += cp.perimeter_lf || 0;
        bySheet[sid].floor_sf += cp.area_sf || 0;
        break;
      case "count": bySheet[sid].ea += cp.count || 1; break;
      default: break;
    }
  }

  const byRoom = {};
  for (const line of boqLines || []) {
    const room = (line.room || "").trim() || "Unassigned";
    if (!byRoom[room]) byRoom[room] = { line_count: 0, floor_sf: 0, wall_sf: 0 };
    byRoom[room].line_count += 1;
  }
  for (const s of shapes) {
    const cp = s.computed || {};
    const key = `shape::${s.id}`;
    const line = (boqLines || []).find((l) => l.id === key || l.shape_id === s.id);
    const room = (line?.room || "").trim() || "Unassigned";
    if (!byRoom[room]) byRoom[room] = { line_count: 0, floor_sf: 0, wall_sf: 0 };
    switch (s.measure_role) {
      case "deduct": byRoom[room].floor_sf -= cp.area_sf || 0; break;
      case "floor_area": byRoom[room].floor_sf += cp.area_sf || 0; break;
      case "surface_area": byRoom[room].wall_sf += cp.area_sf || 0; break;
      case "wall_area": byRoom[room].wall_sf += cp.wall_face_sf || cp.area_sf || 0; break;
      default: break;
    }
  }

  return {
    shape_count: shapes.length,
    floor_sf: round2(floor),
    wall_sf: round2(wall),
    border_sf: round2(border),
    lf: round2(lf),
    ea,
    total_sf: round2(floor + wall + border),
    by_sheet: bySheet,
    by_condition: byCondition,
    by_room: byRoom,
    ...(costGrand ? {
      material_cost: costGrand.material_cost,
      labour_cost: costGrand.labour_cost,
      equipment_cost: costGrand.equipment_cost,
      sub_cost: costGrand.sub_cost,
      subtotal: costGrand.subtotal,
      markup_amount: costGrand.markup_amount,
      grand_total: costGrand.grand_total,
      by_condition_cost: byConditionCost,
    } : {}),
  };
}

function diffShapeEvents(projectId, shapes) {
  const prev = shapeSnapshot.get(projectId) || new Map();
  const next = new Map();
  const events = [];
  const nextIds = new Set(shapes.map((s) => s.id));

  for (const s of shapes) {
    const snap = {
      area_sf: areaOf(s),
      perimeter_lf: lfOf(s),
      holes_count: holesCount(s),
      sheet_id: s.sheet_id,
      condition_id: s.condition_id,
      measure_role: s.measure_role,
      verts: JSON.stringify(s.verts_norm),
    };
    next.set(s.id, snap);
    const old = prev.get(s.id);
    if (!old) {
      events.push({
        project_id: projectId,
        event_type: "create",
        shape_id: s.id,
        sheet_id: s.sheet_id,
        condition_id: s.condition_id,
        measure_role: s.measure_role,
        area_sf_after: snap.area_sf,
        perimeter_lf_after: snap.perimeter_lf,
        holes_count_after: snap.holes_count,
        payload: { origin: s.origin || {} },
      });
    } else if (old.verts !== snap.verts || old.area_sf !== snap.area_sf
      || old.holes_count !== snap.holes_count || old.condition_id !== snap.condition_id) {
      const holeDelta = snap.holes_count - old.holes_count;
      let eventType = "geom";
      if (old.condition_id !== snap.condition_id) eventType = "reassign";
      else if (holeDelta > 0) eventType = "hole_add";
      else if (holeDelta < 0) eventType = "hole_remove";
      events.push({
        project_id: projectId,
        event_type: eventType,
        shape_id: s.id,
        sheet_id: s.sheet_id,
        condition_id: s.condition_id,
        measure_role: s.measure_role,
        area_sf_before: old.area_sf,
        area_sf_after: snap.area_sf,
        perimeter_lf_before: old.perimeter_lf,
        perimeter_lf_after: snap.perimeter_lf,
        holes_count_before: old.holes_count,
        holes_count_after: snap.holes_count,
        payload: {},
      });
    }
  }

  for (const [id, old] of prev) {
    if (!nextIds.has(id)) {
      events.push({
        project_id: projectId,
        event_type: "delete",
        shape_id: id,
        sheet_id: old.sheet_id,
        condition_id: old.condition_id,
        measure_role: old.measure_role,
        area_sf_before: old.area_sf,
        perimeter_lf_before: old.perimeter_lf,
        holes_count_before: old.holes_count,
        payload: {},
      });
    }
  }

  shapeSnapshot.set(projectId, next);
  return events;
}

/** Seed diff baseline after load so the first save does not re-log every shape as create. */
export function seedShapeSnapshot(projectId, shapes) {
  const next = new Map();
  for (const s of shapes || []) {
    next.set(s.id, {
      area_sf: areaOf(s),
      perimeter_lf: lfOf(s),
      holes_count: holesCount(s),
      sheet_id: s.sheet_id,
      condition_id: s.condition_id,
      measure_role: s.measure_role,
      verts: JSON.stringify(s.verts_norm),
    });
  }
  shapeSnapshot.set(projectId, next);
}

// Upsert defensively: if the live schema is missing a column the client
// tries to write (e.g. an optional field whose migration hasn't been applied
// to this environment yet), PostgREST rejects the WHOLE request with
// PGRST204 ("Could not find the 'x' column ... in the schema cache") — which
// previously aborted the entire sync before shapes/holes/BOQ lines ever
// reached the database, so newly drawn/edited/deleted polygon points were
// silently lost. Retry with that one column dropped from every affected row
// (never touching the schema itself) so the rest of the save — most
// importantly the shapes geometry, which is also fully preserved inside
// `annotations` — still goes through.
const MISSING_COLUMN_RE = /Could not find the '([^']+)' column/i;

// Columns this environment rejected, remembered per table so a schema gap is
// discovered once and then stripped up front — later saves send a payload the
// live table accepts on the first try instead of re-failing every time.
const unknownColumns = new Map();

function withoutColumns(rowOrRows, drop) {
  if (!drop.size) return rowOrRows;
  const strip = (row) => {
    const out = {};
    for (const key of Object.keys(row)) if (!drop.has(key)) out[key] = row[key];
    return out;
  };
  return Array.isArray(rowOrRows) ? rowOrRows.map(strip) : strip(rowOrRows);
}

async function upsertResilient(table, rowOrRows, onConflict) {
  let drop = unknownColumns.get(table);
  if (!drop) unknownColumns.set(table, (drop = new Set()));
  for (;;) {
    const { error } = await supabase.from(table).upsert(withoutColumns(rowOrRows, drop), { onConflict });
    if (!error) return;
    const missing = error.code === "PGRST204" ? error.message?.match(MISSING_COLUMN_RE)?.[1] : null;
    // Nothing new to strip (unrelated failure, or the same column again) — surface it.
    if (!missing || drop.has(missing)) throw error;
    drop.add(missing);
  }
}

async function upsertProjectRow(projectRow) {
  await upsertResilient("projects", projectRow, "id");
}

async function replaceChildRows(table, projectId, rows, onConflict) {
  await supabase.from(table).delete().eq("project_id", projectId);
  if (rows.length) await upsertResilient(table, rows, onConflict);
}

/** Load project annotations from Supabase (falls back to stored JSON blob). */
export async function loadProjectFromSupabase(projectId) {
  if (!supabase || !projectId) return null;

  const { data: proj, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!proj) return null;

  const ann = proj.annotations;
  if (ann && typeof ann === "object" && ann.schema === ANN_SCHEMA) {
    const payload = { ...ann, schema: ANN_SCHEMA };
    // Prefer column file_folders when the JSON blob lacks it (older saves).
    if ((!payload.file_folders || !Object.keys(payload.file_folders).length) && proj.file_folders) {
      payload.file_folders = proj.file_folders;
    }
    payload.shapes = normalizeAiFloorShapeSheetIds(payload.shapes, payload.file_folders);
    return { payload, updated_at: proj.updated_at };
  }

  const [
    { data: conditions },
    { data: sheets },
    { data: shapes },
    { data: markups },
    { data: rfis },
    { data: boqLines },
  ] = await Promise.all([
    supabase.from("conditions").select("*").eq("project_id", projectId),
    supabase.from("project_sheets").select("*").eq("project_id", projectId),
    supabase.from("shapes").select("*").eq("project_id", projectId).is("deleted_at", null),
    supabase.from("markups").select("*").eq("project_id", projectId),
    supabase.from("rfis").select("*").eq("project_id", projectId),
    supabase.from("boq_lines").select("*").eq("project_id", projectId),
  ]);

  const { data: holes } = await supabase
    .from("shape_holes")
    .select("*")
    .eq("project_id", projectId)
    .order("hole_index");

  const holesByShape = {};
  for (const h of holes || []) {
    if (!holesByShape[h.shape_id]) holesByShape[h.shape_id] = [];
    holesByShape[h.shape_id][h.hole_index] = h.verts_norm;
  }

  const payload = {
    schema: ANN_SCHEMA,
    project_name: proj.name,
    ...(proj.units === "metric" ? { units: "metric" } : {}),
    client_info: proj.client_info || {},
    condition_columns: proj.condition_columns || [],
    shape_labels: proj.shape_labels || [],
    palette: proj.palette || [],
    sheet_levels: proj.sheet_levels || {},
    file_folders: proj.file_folders || {},
    symbol_notes: proj.symbol_notes || {},
    provenance_counters: proj.provenance_counters || { shapes_deleted: {} },
    sheet_group: proj.sheet_group || [],
    last_group: proj.last_group || [],
    sheet_tabs: proj.sheet_tabs || [],
    conditions: (conditions || []).map((c) => ({
      id: c.id,
      finish_tag: c.finish_tag,
      color: c.color,
      fill: c.fill,
      hatch: c.hatch,
      multiplier: Number(c.multiplier) || 1,
      waste_pct: Number(c.waste_pct) || 0,
      height_ft: c.height_ft,
      thickness_in: c.thickness_in,
      laborType: c.labor_type,
      subfloorType: c.subfloor_type,
      description: c.description,
      spec: c.spec || {},
      attrs: c.attrs || {},
      materials: c.materials || [],
      created_at: c.created_at,
      updated_at: c.updated_at,
    })),
    sheets: (sheets || []).map((s) => ({
      sheet_id: s.sheet_id,
      units_per_px: s.units_per_px,
      ...(s.scale_source ? { scale_source: s.scale_source } : {}),
    })),
    shapes: normalizeAiFloorShapeSheetIds((shapes || []).map((s) => ({
      id: s.id,
      sheet_id: s.sheet_id,
      condition_id: s.condition_id,
      measure_role: s.measure_role,
      verts_norm: s.verts_norm,
      ...(holesByShape[s.id]?.length ? { holes_norm: holesByShape[s.id].filter(Boolean) } : {}),
      computed: s.computed || {},
      origin: s.origin || {},
      label: s.label,
      height_ft: s.height_ft,
      height_override: s.height_override,
      ...(Array.isArray(s.segment_heights_ft) ? { segment_heights_ft: s.segment_heights_ft } : {}),
      ...(s.origin?.segment_heights_ft && !s.segment_heights_ft ? { segment_heights_ft: s.origin.segment_heights_ft } : {}),
      curved: s.curved,
      created_at: s.created_at,
      updated_at: s.updated_at,
    })), proj.file_folders || {}),
    markups: (markups || []).map((m) => ({
      id: m.id,
      sheet_id: m.sheet_id,
      type: m.type,
      text: m.text,
      rfi_id: m.rfi_id,
      created_at: m.created_at,
      ...(m.geometry || {}),
      ...(m.style || {}),
    })),
    rfis: (rfis || []).map((r) => ({
      id: r.id,
      number: r.number,
      subject: r.subject,
      question: r.question,
      status: r.status,
      sheet_id: r.sheet_id,
      ...(r.metadata || {}),
      created_at: r.created_at,
    })),
    boq_lines: (boqLines || []).map((l) => ({
      id: l.id,
      shape_id: l.shape_id,
      manual: l.manual,
      sheet_id: l.sheet_id,
      condition_id: l.condition_id,
      room: l.room,
      room_manual: l.room_manual,
      description: l.description,
      notes: l.notes,
      unit: l.unit,
      qty_override: l.qty_override,
      rate: l.rate,
      rate_material: l.rate_material,
      rate_labour: l.rate_labour,
      rate_equipment: l.rate_equipment,
      rate_sub: l.rate_sub,
      material_rate_id: l.material_rate_id,
      amount: l.amount,
    })),
  };

  return { payload, updated_at: proj.updated_at };
}

/** Remove all takeoff data for a project (shapes, BOQ, sheets, audit log). */
export async function clearProjectDataInSupabase(projectId) {
  if (!supabase || !projectId) return;

  const childTables = [
    "shape_events",
    "shape_holes",
    "shapes",
    "boq_lines",
    "markups",
    "rfis",
    "conditions",
    "project_sheets",
  ];
  for (const table of childTables) {
    const { error } = await supabase.from(table).delete().eq("project_id", projectId);
    if (error) throw error;
  }
  const { error: totErr } = await supabase.from("project_totals").delete().eq("project_id", projectId);
  if (totErr) throw totErr;

  await deleteAllProjectFiles(projectId);

  const empty = { ...emptyAnnotations(), project_name: "ADICC Project" };
  seedShapeSnapshot(projectId, []);
  await syncProjectToSupabase(projectId, empty);
}

/** Create a new Supabase project row; returns UUID. */
export async function createSupabaseProject(name = "Untitled Project") {
  if (!supabase) throw new Error("Supabase is not configured");
  let { data, error } = await supabase
    .from("projects")
    .insert({ name, annotations: {}, last_opened_at: new Date().toISOString() })
    .select("id")
    .single();
  // Graceful fallback when migration 002 hasn't been applied yet.
  if (error?.message?.includes("last_opened_at")) {
    ({ data, error } = await supabase
      .from("projects")
      .insert({ name, annotations: {} })
      .select("id")
      .single());
  }
  if (error) throw error;
  return data.id;
}

/** Permanently delete a project and all related rows. */
export async function deleteSupabaseProject(projectId) {
  if (!supabase || !projectId) return;

  const childTables = [
    "shape_events",
    "shape_holes",
    "shapes",
    "boq_lines",
    "markups",
    "rfis",
    "conditions",
    "project_sheets",
  ];
  for (const table of childTables) {
    const { error } = await supabase.from(table).delete().eq("project_id", projectId);
    if (error) throw error;
  }
  const { error: totErr } = await supabase.from("project_totals").delete().eq("project_id", projectId);
  if (totErr) throw totErr;
  await deleteAllProjectFiles(projectId);
  shapeSnapshot.delete(projectId);
  const { error: projErr } = await supabase.from("projects").delete().eq("id", projectId);
  if (projErr) throw projErr;
}

/** Rename a project in the database (name + annotations.project_name). */
export async function renameSupabaseProject(projectId, name) {
  if (!supabase || !projectId) throw new Error("Missing project");
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("Project name cannot be empty");

  const { data: proj, error: loadErr } = await supabase
    .from("projects")
    .select("annotations")
    .eq("id", projectId)
    .maybeSingle();
  if (loadErr) throw loadErr;

  const ann = (proj?.annotations && typeof proj.annotations === "object")
    ? { ...proj.annotations, project_name: trimmed }
    : { project_name: trimmed };

  const { error } = await supabase
    .from("projects")
    .update({ name: trimmed, annotations: ann, updated_at: new Date().toISOString() })
    .eq("id", projectId);
  if (error) throw error;
}

/** Sync full annotations payload to normalized Supabase tables. */
export async function syncProjectToSupabase(projectId, payload, pricingOpts = {}) {
  if (!supabase || !projectId) return;

  const fileFolders = payload.file_folders || {};
  const shapes = normalizeAiFloorShapeSheetIds(payload.shapes || [], fileFolders);
  const annPayload = shapes === (payload.shapes || []) ? payload : { ...payload, shapes };
  const conditions = payload.conditions || [];
  const markups = payload.markups || [];
  const rfis = payload.rfis || [];
  const boqLines = payload.boq_lines || [];
  const sheets = payload.sheets || [];

  const events = diffShapeEvents(projectId, shapes);
  const totals = computeTotals(conditions, shapes, boqLines, pricingOpts);

  const projectRow = {
    id: projectId,
    name: payload.project_name || "Untitled Project",
    units: payload.units === "metric" ? "metric" : "imperial",
    currency: payload.currency || pricingOpts.projectSettings?.currency || "AED",
    markup_pct: Number(payload.markup_pct ?? pricingOpts.projectSettings?.markup_pct) || 0,
    overhead_pct: Number(payload.overhead_pct ?? pricingOpts.projectSettings?.overhead_pct) || 0,
    client_info: payload.client_info || {},
    condition_columns: payload.condition_columns || [],
    shape_labels: payload.shape_labels || [],
    palette: payload.palette || [],
    schema_version: ANN_SCHEMA,
    annotations: annPayload,
    updated_at: new Date().toISOString(),
  };

  await upsertProjectRow(projectRow);

  await replaceChildRows("conditions", projectId, conditions.map((c) => ({
    project_id: projectId,
    id: c.id,
    finish_tag: c.finish_tag || "?",
    color: c.color,
    fill: c.fill,
    hatch: c.hatch,
    multiplier: c.multiplier ?? 1,
    waste_pct: c.waste_pct ?? 0,
    height_ft: c.height_ft,
    thickness_in: c.thickness_in,
    labor_type: c.laborType,
    subfloor_type: c.subfloorType,
    description: c.description || c.spec?.description,
    spec: c.spec || {},
    attrs: c.attrs || {},
    materials: c.materials || [],
    created_at: c.created_at,
    updated_at: c.updated_at,
  })), "project_id,id");

  await replaceChildRows("project_sheets", projectId, sheets.map((s) => ({
    project_id: projectId,
    sheet_id: s.sheet_id,
    units_per_px: s.units_per_px,
    scale_source: s.scale_source,
  })), "project_id,sheet_id");

  const shapeRows = shapes.map((s) => ({
    project_id: projectId,
    id: s.id,
    sheet_id: s.sheet_id,
    condition_id: s.condition_id,
    measure_role: s.measure_role,
    verts_norm: s.verts_norm,
    computed: s.computed || {},
    origin: {
      ...(s.origin || {}),
      ...(Array.isArray(s.segment_heights_ft) ? { segment_heights_ft: s.segment_heights_ft } : {}),
    },
    label: s.label,
    height_ft: s.height_ft,
    height_override: !!s.height_override,
    curved: !!s.curved,
    holes_count: holesCount(s),
    created_at: s.created_at,
    updated_at: s.updated_at,
    deleted_at: null,
  }));
  await replaceChildRows("shapes", projectId, shapeRows, "project_id,id");

  const holeRows = [];
  for (const s of shapes) {
    const rings = s.holes_norm || [];
    rings.forEach((ring, hole_index) => {
      if (!Array.isArray(ring) || ring.length < 3) return;
      holeRows.push({
        project_id: projectId,
        shape_id: s.id,
        hole_index,
        verts_norm: ring,
      });
    });
  }
  await replaceChildRows("shape_holes", projectId, holeRows, "project_id,shape_id,hole_index");

  await replaceChildRows("markups", projectId, markups.map((m) => ({
    project_id: projectId,
    id: m.id,
    sheet_id: m.sheet_id,
    type: m.type,
    geometry: markupGeometry(m),
    text: m.text,
    style: markupStyle(m),
    rfi_id: m.rfi_id,
    created_at: m.created_at,
  })), "project_id,id");

  await replaceChildRows("rfis", projectId, rfis.map((r) => ({
    project_id: projectId,
    id: r.id,
    number: r.number,
    subject: r.subject,
    question: r.question,
    status: r.status || "open",
    metadata: rfiMetadata(r),
    sheet_id: r.sheet_id,
    created_at: r.created_at,
  })), "project_id,id");

  await replaceChildRows("boq_lines", projectId, (boqLines || []).map((l) => ({
    project_id: projectId,
    id: l.id,
    shape_id: l.shape_id,
    manual: !!l.manual,
    sheet_id: l.sheet_id,
    condition_id: l.condition_id,
    room: l.room,
    room_manual: !!l.room_manual,
    description: l.description,
    notes: l.notes,
    unit: l.unit,
    qty_override: l.qty_override != null ? String(l.qty_override) : null,
    rate: l.rate != null ? String(l.rate) : null,
    rate_material: l.rate_material != null ? Number(l.rate_material) : null,
    rate_labour: l.rate_labour != null ? Number(l.rate_labour) : null,
    rate_equipment: l.rate_equipment != null ? Number(l.rate_equipment) : null,
    rate_sub: l.rate_sub != null ? Number(l.rate_sub) : null,
    material_rate_id: l.material_rate_id || null,
    amount: l.amount != null ? Number(l.amount) : null,
  })), "project_id,id");

  if (events.length) {
    const { error: evErr } = await supabase.from("shape_events").insert(events);
    if (evErr) throw evErr;
  }

  await upsertResilient("project_totals", {
    project_id: projectId,
    shape_count: totals.shape_count,
    floor_sf: totals.floor_sf,
    wall_sf: totals.wall_sf,
    border_sf: totals.border_sf,
    lf: totals.lf,
    ea: totals.ea,
    total_sf: totals.total_sf,
    by_sheet: totals.by_sheet,
    by_condition: totals.by_condition,
    by_room: totals.by_room,
    material_cost: totals.material_cost ?? 0,
    labour_cost: totals.labour_cost ?? 0,
    equipment_cost: totals.equipment_cost ?? 0,
    sub_cost: totals.sub_cost ?? 0,
    subtotal: totals.subtotal ?? 0,
    markup_amount: totals.markup_amount ?? 0,
    grand_total: totals.grand_total ?? 0,
    by_condition_cost: totals.by_condition_cost ?? {},
    updated_at: new Date().toISOString(),
  }, "project_id");
}
