// Merge local takeoff payloads with the latest remote snapshot before write.
// No schema changes — union-by-id with updated_at tie-break, plus explicit local deletes.

function entityTs(entity) {
  const raw = entity?.updated_at || entity?.created_at;
  if (!raw) return 0;
  const n = Date.parse(String(raw));
  return Number.isFinite(n) ? n : 0;
}

/** Shape ids the client removed since its last successful save baseline. */
export function computeLocalShapeDeletes(shapeSnapshot, projectId, localShapes) {
  const prev = shapeSnapshot.get(projectId);
  if (!prev?.size) return new Set();
  const localIds = new Set((localShapes || []).map((s) => s?.id).filter(Boolean));
  const deleted = new Set();
  for (const id of prev.keys()) {
    if (!localIds.has(id)) deleted.add(id);
  }
  return deleted;
}

function mergeById(localArr, remoteArr, localDeletes, { key = "id" } = {}) {
  const byKey = new Map();
  for (const item of remoteArr || []) {
    const k = item?.[key];
    if (!k || localDeletes.has(k)) continue;
    byKey.set(k, item);
  }
  for (const item of localArr || []) {
    const k = item?.[key];
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev || entityTs(item) >= entityTs(prev)) byKey.set(k, item);
  }
  return [...byKey.values()];
}

function unionOrdered(localArr, remoteArr) {
  const seen = new Set();
  const out = [];
  for (const item of [...(localArr || []), ...(remoteArr || [])]) {
    if (typeof item !== "string" || !item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function mergeObjects(localObj, remoteObj) {
  return { ...(remoteObj || {}), ...(localObj || {}) };
}

function mergeProvCounters(localPc, remotePc) {
  const sd = { ...(remotePc?.shapes_deleted || {}) };
  for (const [k, v] of Object.entries(localPc?.shapes_deleted || {})) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    sd[k] = Math.max(Number(sd[k]) || 0, n);
  }
  return { shapes_deleted: sd };
}

/**
 * Merge remote canonical payload into the local save without dropping concurrent edits.
 * @param {object} local
 * @param {object} remote
 * @param {Set<string>} localShapeDeletes
 */
export function mergeTakeoffPayload(local, remote, localShapeDeletes = new Set()) {
  if (!remote || typeof remote !== "object") return local;

  const merged = {
    ...remote,
    ...local,
    shapes: mergeById(local.shapes, remote.shapes, localShapeDeletes),
    conditions: mergeById(local.conditions, remote.conditions, new Set()),
    markups: mergeById(local.markups, remote.markups, new Set()),
    rfis: mergeById(local.rfis, remote.rfis, new Set()),
    boq_lines: mergeById(local.boq_lines, remote.boq_lines, new Set()),
    sheets: mergeById(local.sheets, remote.sheets, new Set(), { key: "sheet_id" }),
    sheet_tabs: unionOrdered(local.sheet_tabs, remote.sheet_tabs),
    sheet_group: unionOrdered(local.sheet_group, remote.sheet_group),
    last_group: (local.last_group?.length ? local.last_group : remote.last_group) || [],
    file_folders: mergeObjects(local.file_folders, remote.file_folders),
    file_display_names: mergeObjects(local.file_display_names, remote.file_display_names),
    sheet_levels: mergeObjects(local.sheet_levels, remote.sheet_levels),
    symbol_notes: mergeObjects(local.symbol_notes, remote.symbol_notes),
    provenance_counters: mergeProvCounters(local.provenance_counters, remote.provenance_counters),
    client_info: mergeObjects(local.client_info, remote.client_info),
    shape_labels: (local.shape_labels?.length ? local.shape_labels : remote.shape_labels) || [],
    condition_columns: (local.condition_columns?.length ? local.condition_columns : remote.condition_columns) || [],
    palette: unionOrdered(local.palette, remote.palette),
    project_name: local.project_name || remote.project_name,
  };

  return merged;
}
