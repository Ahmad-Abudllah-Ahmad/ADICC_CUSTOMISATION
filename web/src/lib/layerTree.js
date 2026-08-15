// Illustrator Layers tree: live takeoff shapes as leaves + a nested group forest.
// Shape geometry stays in shapes[]; groups are { id, name, sheetKey, children[] }
// where children are group ids or shape ids. Sheets wrap as folders only when
// more than one sheet is open.

import { areaVal, areaUnit, lenVal, lenUnit } from "./units";
import { num } from "./num.js";

export const ROLE_LABEL = {
  floor_area: "Mask",
  wall_area: "Wall area",
  deduct: "Cutout",
  linear: "Line",
  surface_area: "Wall line",
  count: "Count",
};

export const KIND = {
  sheet: { label: "Sheet", color: "#1a5276", unit: "" },
  group: { label: "Group", color: "#1a5276", unit: "" },
  line: { label: "Line", color: "#a0402a", unit: "LF" },
  area: { label: "Area", color: "#1e6b4a", unit: "SF" },
  count: { label: "Count", color: "#b8860b", unit: "ea" },
};

export function kindFromRole(role) {
  if (role === "count") return "count";
  if (role === "linear" || role === "surface_area") return "line";
  return "area";
}

export function kindOf(n) {
  return KIND[n?.kind] || KIND.line;
}

/** Live paint for a Layers row: appearance override → condition → kind fallback. */
export function layerPaintColor(shape, condById) {
  if (shape?.appearance_override && shape.color) return shape.color;
  const cond = condById?.[shape?.condition_id];
  if (cond?.color) return cond.color;
  return kindOf({ kind: kindFromRole(shape?.measure_role) }).color;
}

function folderPaintColor(children, fallback) {
  const leaves = [];
  const walk = (n) => {
    if (!n) return;
    if (isFolderKind(n.kind)) (n.children || []).forEach(walk);
    else leaves.push(n);
  };
  (children || []).forEach(walk);
  if (!leaves.length) return fallback;
  const first = String(leaves[0].color || "").trim().toLowerCase();
  if (!first) return fallback;
  return leaves.every((n) => String(n.color || "").trim().toLowerCase() === first)
    ? leaves[0].color
    : fallback;
}

export function isFolderKind(kind) {
  return kind === "group" || kind === "sheet";
}

export function sheetNodeId(key) {
  return `sheet::${key}`;
}

export function sheetKeyFromNodeId(id) {
  return String(id || "").startsWith("sheet::") ? String(id).slice(7) : null;
}

function roundQty(v) {
  return num(v, 1);
}

export function shapeMetric(shape, units = "imperial") {
  const cp = shape?.computed || {};
  if (shape?.measure_role === "count") return `${cp.count ?? 1} ea`;
  if (shape?.measure_role === "linear" || shape?.measure_role === "surface_area") {
    if (cp.perimeter_lf != null) return `${roundQty(lenVal(cp.perimeter_lf, units))} ${lenUnit(units)}`;
  }
  if (cp.area_sf != null) return `${roundQty(areaVal(cp.area_sf, units))} ${areaUnit(units)}`;
  if (cp.perimeter_lf != null) return `${roundQty(lenVal(cp.perimeter_lf, units))} ${lenUnit(units)}`;
  return "";
}

function shapesOnSheet(shapes, sheetKey, sheetMatch) {
  return shapes.filter((s) => {
    if (!sheetKey) return true;
    if (s.sheet_id === sheetKey) return true;
    return typeof sheetMatch === "function" && sheetMatch(s.sheet_id, sheetKey);
  });
}

/** Panel "Select all" — focused sheet only, so Group cannot wrap a second sheet. */
export function shapeIdsOnFocusSheet(shapes, focusSheetKey, sheetMatch, sheetKeys = []) {
  const key = focusSheetKey || sheetKeys[0];
  return shapesOnSheet(shapes || [], key, sheetMatch).map((s) => s.id);
}

function leaf(shape, condById, hiddenShapeIds, lockedShapeIds, units) {
  const cond = condById?.[shape.condition_id];
  const role = ROLE_LABEL[shape.measure_role] || shape.measure_role;
  const tag = cond?.finish_tag || "—";
  const kind = kindFromRole(shape.measure_role);
  const name = shape.label ? String(shape.label) : `${tag} · ${role}`;
  const sheetFlag = shape.sheet_id ? sheetNodeId(shape.sheet_id) : null;
  return {
    id: shape.id,
    name,
    kind,
    hidden: !!hiddenShapeIds?.[shape.id] || !!(sheetFlag && hiddenShapeIds?.[sheetFlag]),
    locked: !!lockedShapeIds?.[shape.id] || !!(sheetFlag && lockedShapeIds?.[sheetFlag]),
    metric: shapeMetric(shape, units),
    color: layerPaintColor(shape, condById),
  };
}

function folderHidden(children) {
  const leaves = [];
  const walk = (n) => {
    if (isFolderKind(n.kind)) (n.children || []).forEach(walk);
    else leaves.push(n);
  };
  children.forEach(walk);
  return leaves.length > 0 && leaves.every((n) => n.hidden);
}

function folderLocked(children, selfLocked) {
  if (selfLocked) return true;
  const leaves = [];
  const walk = (n) => {
    if (isFolderKind(n.kind)) (n.children || []).forEach(walk);
    else leaves.push(n);
  };
  children.forEach(walk);
  return leaves.length > 0 && leaves.every((n) => n.locked);
}

export function summariseNodes(nodes) {
  const totals = {};
  const add = (n) => {
    if (isFolderKind(n.kind)) { (n.children || []).forEach(add); return; }
    const m = String(n.metric || "").trim();
    if (!m) return;
    const parts = m.split(/\s+/);
    const unit = parts.pop();
    const v = parseFloat(String(parts.join("")).replace(/,/g, ""));
    if (!unit || !Number.isFinite(v)) return;
    totals[unit] = (totals[unit] || 0) + v;
  };
  (nodes || []).forEach(add);
  return Object.entries(totals)
    .map(([u, v]) => `${roundQty(v)} ${u}`)
    .join(" \u00B7 ");
}

// ── nested forest (groups only; leaves are shape ids in children[]) ──────────

export function cloneForest(forest) {
  const next = {};
  for (const [id, g] of Object.entries(forest || {})) {
    next[id] = { ...g, children: [...(g.children || [])] };
  }
  return next;
}

export function forestFromFlat(layerGroups) {
  const next = {};
  for (const g of Object.values(layerGroups || {})) {
    if (!g?.id) continue;
    next[g.id] = {
      id: g.id,
      kind: "group",
      name: g.name || g.label || "Group",
      sheetKey: g.sheetKey || g.sheet_id || "",
      children: [...(g.children || g.shapeIds || [])],
      ...(g.hidden ? { hidden: true } : {}),
      ...(g.locked ? { locked: true } : {}),
    };
  }
  return next;
}

export function sanitizeForest(raw, liveShapeIds) {
  const live = liveShapeIds instanceof Set ? liveShapeIds : new Set(liveShapeIds || []);
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const next = forestFromFlat(src);
  for (const g of Object.values(next)) {
    g.children = (g.children || []).filter((cid) => next[cid] || live.has(cid));
  }
  return next;
}

/** Else-clear id→true maps for hide/lock. Arrays, primitives, and stale ids drop.
 *  `sheet::<key>` flags stay — they hide/lock a whole sheet folder, including
 *  an empty one, and survive until the takeoff is replaced. */
export function sanitizeLayerIdMap(raw, liveIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const next = {};
  for (const [id, on] of Object.entries(raw)) {
    if (on && (live.has(id) || sheetKeyFromNodeId(id))) next[id] = true;
  }
  return next;
}

/** Expand a Layers hide/lock click into shape ids + group ids + sheet folder ids. */
export function collectIdsForLayerToggle(ids, { forest, shapes, sheetMatch } = {}) {
  const shapeIds = [];
  const groupIds = [];
  const sheetIds = [];
  for (const id of ids || []) {
    const sk = sheetKeyFromNodeId(id);
    if (sk) {
      sheetIds.push(id);
      for (const s of shapesOnSheet(shapes || [], sk, sheetMatch)) {
        if (s.id) shapeIds.push(s.id);
      }
      continue;
    }
    if (forest?.[id]) {
      groupIds.push(id);
      shapeIds.push(...descendantShapeIds(forest, id));
      continue;
    }
    if (id) shapeIds.push(id);
  }
  return {
    shapeIds: [...new Set(shapeIds)],
    groupIds: [...new Set(groupIds)],
    sheetIds: [...new Set(sheetIds)],
  };
}

/** Omit-when-empty additive keys for buildPayload (sheet_levels convention). */
export function layerPersistSlice({ layerForest, hiddenShapeIds, lockedShapeIds } = {}) {
  const out = {};
  if (layerForest && typeof layerForest === "object" && !Array.isArray(layerForest) && Object.keys(layerForest).length) {
    out.layer_tree = layerForest;
  }
  if (hiddenShapeIds && Object.keys(hiddenShapeIds).length) out.layer_hidden = hiddenShapeIds;
  if (lockedShapeIds && Object.keys(lockedShapeIds).length) out.layer_locked = lockedShapeIds;
  return out;
}

/** Stale panel/canvas picks must not paint chrome after the primary selection is cleared. */
export function activeLayerPickIds(selectedId, layerPickIds) {
  if (!selectedId) return {};
  return layerPickIds && typeof layerPickIds === "object" && !Array.isArray(layerPickIds) ? layerPickIds : {};
}

/** Ctrl/Cmd-click: add or drop a row's shapes from the pick set. */
export function togglePickIds(currentIds, rowIds) {
  const cur = Array.isArray(currentIds) ? currentIds.filter(Boolean) : [];
  const row = Array.isArray(rowIds) ? rowIds.filter(Boolean) : [];
  const set = new Set(cur);
  const allIn = row.length > 0 && row.every((id) => set.has(id));
  if (allIn) row.forEach((id) => set.delete(id));
  else row.forEach((id) => set.add(id));
  return [...set];
}

/** Shift-click: every visible row between two indices, inclusive. */
export function rangePickIds(rowShapeIds, fromIndex, toIndex) {
  const rows = Array.isArray(rowShapeIds) ? rowShapeIds : [];
  if (!rows.length) return [];
  let a = fromIndex;
  let b = toIndex;
  if (!Number.isInteger(a) || a < 0) a = b;
  if (!Number.isInteger(b) || b < 0) b = a;
  if (!Number.isInteger(a) || a < 0 || !Number.isInteger(b) || b < 0) return [];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out = [];
  for (let i = lo; i <= hi && i < rows.length; i++) {
    for (const id of rows[i] || []) if (id) out.push(id);
  }
  return [...new Set(out)];
}

/** Ids to hide/lock so only `keepIds` stay on. */
export function isolateOtherIds(allIds, keepIds) {
  const keep = new Set(Array.isArray(keepIds) ? keepIds : []);
  return (Array.isArray(allIds) ? allIds : []).filter((id) => id && !keep.has(id));
}

/** True when everything outside `keepIds` is already hidden and the keep set is shown. */
export function isIsolatedTo(allIds, keepIds, hiddenMap) {
  const keep = new Set(Array.isArray(keepIds) ? keepIds : []);
  const hidden = hiddenMap && typeof hiddenMap === "object" ? hiddenMap : {};
  const others = (Array.isArray(allIds) ? allIds : []).filter((id) => id && !keep.has(id));
  if (!others.length || !keep.size) return false;
  return others.every((id) => hidden[id]) && [...keep].every((id) => !hidden[id]);
}

/** Fly-to / commit: keep a panel multi-pick if the new primary is already in it; else pick just that id. */
export function picksForPrimarySelect(id, currentPicks) {
  if (!id) return {};
  const picks = currentPicks && typeof currentPicks === "object" && !Array.isArray(currentPicks) ? currentPicks : {};
  if (picks[id]) return picks;
  return { [id]: true };
}

export function isHiddenId(id, { hiddenShapeIds, sheetId } = {}) {
  if (!id) return false;
  if (hiddenShapeIds?.[id]) return true;
  if (sheetId && hiddenShapeIds?.[sheetNodeId(sheetId)]) return true;
  return false;
}

export function isLockedId(id, { lockedShapeIds, forest, sheetId } = {}) {
  if (!id) return false;
  if (lockedShapeIds?.[id]) return true;
  if (sheetId && lockedShapeIds?.[sheetNodeId(sheetId)]) return true;
  let p = parentOf(forest, id);
  while (p) {
    if (forest[p]?.locked) return true;
    p = parentOf(forest, p);
  }
  return false;
}

export function parentOf(forest, id) {
  for (const g of Object.values(forest || {})) {
    if ((g.children || []).includes(id)) return g.id;
  }
  return null;
}

export function descendantShapeIds(forest, id) {
  const out = [];
  const walk = (nid) => {
    const g = forest?.[nid];
    if (!g) { if (nid) out.push(nid); return; }
    for (const c of g.children || []) walk(c);
  };
  walk(id);
  return out;
}

export function isDescendant(forest, ancestorId, nodeId) {
  if (!ancestorId || !nodeId) return false;
  if (ancestorId === nodeId) return true;
  const g = forest?.[ancestorId];
  if (!g) return false;
  for (const c of g.children || []) {
    if (c === nodeId || isDescendant(forest, c, nodeId)) return true;
  }
  return false;
}

export function topMostIds(forest, ids) {
  const set = new Set(ids || []);
  return [...set].filter((id) => {
    let p = parentOf(forest, id);
    while (p) {
      if (set.has(p)) return false;
      p = parentOf(forest, p);
    }
    return true;
  });
}

/** If every descendant of a group is selected, keep the group id instead of its leaves. */
export function liftSelection(forest, shapeIds) {
  const set = new Set(shapeIds || []);
  const fully = Object.keys(forest || {}).filter((gid) => {
    const desc = descendantShapeIds(forest, gid);
    return desc.length > 0 && desc.every((id) => set.has(id));
  });
  const topGroups = topMostIds(forest, fully);
  const used = new Set();
  for (const gid of topGroups) descendantShapeIds(forest, gid).forEach((id) => used.add(id));
  const rest = [...set].filter((id) => !used.has(id));
  return [...topGroups, ...rest];
}

function nodeSheetKey(forest, id, shapeById) {
  if (forest?.[id]) return forest[id].sheetKey || "";
  return shapeById?.get?.(id)?.sheet_id || "";
}

function removeFromParent(forest, id) {
  const p = parentOf(forest, id);
  if (!p || !forest[p]) return;
  forest[p] = { ...forest[p], children: (forest[p].children || []).filter((c) => c !== id) };
}

export function groupSelection(forest, selectedIds, { newId, name, sheetKey, shapeById } = {}) {
  if (!newId) return forest;
  const next = cloneForest(forest);
  const top = topMostIds(next, selectedIds).filter((id) => id !== newId);
  if (top.length < 2) return forest;
  if (shapeById) {
    const sheets = new Set(top.map((id) => nodeSheetKey(next, id, shapeById)).filter(Boolean));
    if (sheets.size > 1) return forest;
  }
  const firstParent = parentOf(next, top[0]);
  let insertAt = 0;
  if (firstParent && next[firstParent]) {
    insertAt = Math.max(0, (next[firstParent].children || []).indexOf(top[0]));
  }
  for (const id of top) removeFromParent(next, id);
  next[newId] = {
    id: newId,
    kind: "group",
    name: name || "Group",
    sheetKey: sheetKey || "",
    children: [...top],
  };
  if (firstParent && next[firstParent]) {
    const kids = [...(next[firstParent].children || [])];
    const at = Math.min(insertAt, kids.length);
    kids.splice(at, 0, newId);
    next[firstParent] = { ...next[firstParent], children: kids };
  }
  return next;
}

export function ungroupNodes(forest, selectedIds) {
  const next = cloneForest(forest);
  const top = topMostIds(next, selectedIds);
  let changed = false;
  for (const id of top) {
    const g = next[id];
    if (!g) continue;
    const kids = [...(g.children || [])];
    const parentId = parentOf(next, id);
    if (parentId && next[parentId]) {
      const sibs = [...(next[parentId].children || [])];
      const at = Math.max(0, sibs.indexOf(id));
      const without = sibs.filter((c) => c !== id);
      without.splice(at, 0, ...kids);
      next[parentId] = { ...next[parentId], children: without };
    }
    delete next[id];
    changed = true;
  }
  return changed ? next : forest;
}

export function moveNodes(forest, dragIds, destParentId, index, { shapeById } = {}) {
  const next = cloneForest(forest);
  const top = topMostIds(next, dragIds);
  if (!top.length) return forest;
  const dest = destParentId && !sheetKeyFromNodeId(destParentId) ? destParentId : null;
  if (dest) {
    if (!next[dest]) return forest;
    for (const id of top) {
      if (id === dest || isDescendant(next, id, dest)) return forest;
    }
  }
  if (shapeById) {
    const sheets = new Set(top.map((id) => nodeSheetKey(next, id, shapeById)).filter(Boolean));
    if (dest) {
      const want = next[dest].sheetKey || "";
      if (want && [...sheets].some((sk) => sk !== want)) return forest;
    }
    if (sheets.size > 1) return forest;
  }
  const oldParent = dest ? parentOf(next, top[0]) : null;
  let at = index;
  if (dest && oldParent === dest && Number.isFinite(index)) {
    const oldKids = next[dest].children || [];
    const removedBefore = top.filter((id) => {
      const i = oldKids.indexOf(id);
      return i !== -1 && i < index;
    }).length;
    at = index - removedBefore;
  }
  for (const id of top) removeFromParent(next, id);
  if (!dest) return next;
  const kids = [...(next[dest].children || [])];
  const slot = Math.min(Math.max(0, Number.isFinite(at) ? at : kids.length), kids.length);
  kids.splice(slot, 0, ...top);
  next[dest] = { ...next[dest], children: kids };
  return next;
}

export function addEmptyGroup(forest, { id, name, sheetKey } = {}) {
  if (!id) return forest;
  const next = cloneForest(forest);
  next[id] = { id, kind: "group", name: name || "Group", sheetKey: sheetKey || "", children: [] };
  return next;
}

export function renameGroup(forest, id, name) {
  if (!forest?.[id]) return forest;
  return { ...forest, [id]: { ...forest[id], name: String(name || "").trim() || forest[id].name } };
}

export function setGroupFlag(forest, id, flag, value) {
  if (!forest?.[id]) return forest;
  const g = { ...forest[id] };
  if (value) g[flag] = true;
  else delete g[flag];
  return { ...forest, [id]: g };
}

function expandChild(id, forest, byId, hiddenShapeIds, lockedShapeIds, units, condById, visiting, ancestorLocked) {
  const g = forest[id];
  if (g) {
    if (visiting.has(id)) return null;
    visiting.add(id);
    const selfLocked = ancestorLocked || !!g.locked;
    const children = (g.children || [])
      .map((cid) => expandChild(cid, forest, byId, hiddenShapeIds, lockedShapeIds, units, condById, visiting, selfLocked))
      .filter(Boolean);
    visiting.delete(id);
    return {
      id: g.id,
      name: g.name || "Group",
      kind: "group",
      children,
      hidden: !!g.hidden || folderHidden(children),
      locked: folderLocked(children, selfLocked),
      metric: summariseNodes(children),
      color: folderPaintColor(children, KIND.group.color),
    };
  }
  const s = byId.get(id);
  if (!s) return null;
  const n = leaf(s, condById, hiddenShapeIds, lockedShapeIds, units);
  if (ancestorLocked) n.locked = true;
  return n;
}

function sheetChildren(sheetKey, shapes, forest, condById, hiddenShapeIds, lockedShapeIds, units, sheetMatch) {
  const list = shapesOnSheet(shapes, sheetKey, sheetMatch);
  const byId = new Map(list.map((s) => [s.id, s]));
  const claimed = new Set();
  const walkClaim = (id) => {
    claimed.add(id);
    const g = forest[id];
    if (g) (g.children || []).forEach(walkClaim);
  };
  const roots = Object.values(forest).filter((g) => (g.sheetKey === sheetKey) && !parentOf(forest, g.id));
  for (const g of Object.values(forest).filter((g) => g.sheetKey === sheetKey)) {
    walkClaim(g.id);
    (g.children || []).forEach(walkClaim);
  }
  const visiting = new Set();
  const folders = roots
    .map((g) => expandChild(g.id, forest, byId, hiddenShapeIds, lockedShapeIds, units, condById, visiting))
    .filter(Boolean);
  const ungrouped = list.filter((s) => !claimed.has(s.id)).map((s) => leaf(s, condById, hiddenShapeIds, lockedShapeIds, units));
  return [...folders, ...ungrouped];
}

export function buildLayerTree({
  sheetKeys = [],
  sheetLabel = (k) => k,
  shapes = [],
  layerForest,
  layerGroups = {},
  condById = {},
  hiddenShapeIds = {},
  lockedShapeIds = {},
  units = "imperial",
  sheetMatch,
} = {}) {
  const forest = layerForest && typeof layerForest === "object"
    ? layerForest
    : forestFromFlat(layerGroups);
  const keys = sheetKeys.length ? sheetKeys : [...new Set(shapes.map((s) => s.sheet_id).filter(Boolean))];
  if (keys.length <= 1) {
    const key = keys[0];
    return key ? sheetChildren(key, shapes, forest, condById, hiddenShapeIds, lockedShapeIds, units, sheetMatch) : [];
  }
  return keys.map((key) => {
    const children = sheetChildren(key, shapes, forest, condById, hiddenShapeIds, lockedShapeIds, units, sheetMatch);
    const sid = sheetNodeId(key);
    return {
      id: sid,
      name: sheetLabel(key) || key,
      kind: "sheet",
      children,
      hidden: !!hiddenShapeIds?.[sid] || folderHidden(children),
      locked: !!lockedShapeIds?.[sid] || folderLocked(children, false),
      metric: summariseNodes(children),
      color: folderPaintColor(children, KIND.sheet.color),
    };
  });
}

export function shapeIdsUnder(node) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (isFolderKind(n.kind)) (n.children || []).forEach(walk);
    else if (n.id) out.push(n.id);
  };
  walk(node);
  return out;
}

export function findNode(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    if (n.children) {
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}
