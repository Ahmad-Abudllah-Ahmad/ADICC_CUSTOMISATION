// Material library ↔ condition-line patch builders (pure, tested).
import {
  materialKind,
  groutParamsEqual,
  GROUT_DEFAULTS,
  groutDerivedFields,
  groutNote,
} from "./coverage.js";

const LIB_SCALAR = ["name", "unit", "per", "basis", "round", "note", "kind"];

/** Load gate for the browser-global material_library record. */
export function sanitizeMaterialLibrary(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = item.id;
    if (typeof id !== "string" || !id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...item });
  }
  return out;
}

/** Copy transferable fields from a library entry or condition line. */
export function libFields(m) {
  const out = {
    name: m.name || "",
    unit: m.unit || "",
    per: m.per || 0,
    basis: m.basis || "area",
    round: m.round !== false,
    note: m.note || "",
  };
  if (m.kind) out.kind = m.kind;
  if (m.grout) out.grout = { ...m.grout };
  return out;
}

function nameClassification(name) {
  return materialKind({ name });
}

/** Drop kind when a rename changes the name's classification (name drives presets). */
export function renameReclassified(m, oldName = null) {
  const next = { ...m };
  if (!oldName || oldName === m.name) return next;
  if (m.grout) return next;

  const oldC = nameClassification(oldName);
  const newC = nameClassification(m.name);
  if (oldC === newC) return next;
  if (m.kind && newC === m.kind) return next;

  if ("kind" in next) {
    const { kind, ...rest } = next;
    return rest;
  }
  return next;
}

function isDerivedGroutNote(grout, note) {
  if (!grout || !note) return false;
  return note === groutNote({ ...GROUT_DEFAULTS, ...grout });
}

/** Detach grout geometry when per/note are hand-edited on a grout line. */
function detachGroutOnRateEdit(m, patch) {
  if (!m.grout) return m;
  if (patch.grout != null) return m;

  const perChanged = patch.per != null && patch.per !== m.per;
  const noteChanged = patch.note != null && patch.note !== m.note;
  if (!perChanged && !noteChanged) return m;

  const { grout, ...rest } = m;
  const next = { ...rest };
  if (perChanged) next.per = patch.per;
  if (noteChanged) next.note = patch.note;
  else if (perChanged && isDerivedGroutNote(grout, m.note)) next.note = "";
  return next;
}

/** Apply a patch to a condition material line. */
export function matEditPatch(m, patch) {
  let next = detachGroutOnRateEdit(m, patch);
  next = { ...next, ...patch };

  if (patch.name != null && !m.grout) {
    if (Object.prototype.hasOwnProperty.call(patch, "kind")) {
      if (patch.kind === undefined && "kind" in next) {
        const { kind, ...rest } = next;
        next = rest;
      }
    } else {
      next = renameReclassified(next, m.name);
    }
  }

  return next;
}

/** Whether a linked line field differs from its library entry. */
export function matFieldOverridden(m, lm, field) {
  if (!lm) return false;
  if (field === "grout") return !groutParamsEqual(m.grout, lm.grout);
  if (field === "round") return (m.round !== false) !== (lm.round !== false);
  const L = libFields(lm);
  if (field === "per") return (Number(m.per) || 0) !== L.per;
  if (field === "basis") return (m.basis || "area") !== L.basis;
  return String(m[field] || "") !== String(L[field] || "");
}

/** Push library values onto all linked condition lines. */
export function libPushPatch(m, lm) {
  const fields = libFields(lm);
  let next = { ...m, ...fields, lib_id: m.lib_id };
  if (!lm.grout && m.grout) {
    const { grout, ...rest } = next;
    next = rest;
  }
  if (!("kind" in lm) && "kind" in next) {
    const { kind, ...rest } = next;
    next = rest;
  }
  return next;
}

/** Revert one field on a linked line from its library entry. */
export function libRevertPatch(m, lm, field) {
  if (field === "name") {
    if (m.grout) return { name: lm.name };
    const patch = { name: lm.name };
    if (lm.kind) patch.kind = lm.kind;
    else if (m.kind) patch.kind = undefined;
    return patch;
  }

  if (field === "per" || field === "note" || field === "grout") {
    if (lm.grout) {
      const grout = { ...lm.grout };
      const derived = groutDerivedFields({ ...GROUT_DEFAULTS, ...grout });
      return { ...m, grout, ...(derived || { per: lm.per, note: lm.note }) };
    }
    if (field === "grout" || m.grout) {
      const patch = { per: lm.per, note: lm.note };
      if (m.grout) patch.grout = undefined;
      return { ...m, ...patch };
    }
    const L = libFields(lm);
    return { [field]: L[field] };
  }

  const L = libFields(lm);
  return { [field]: L[field] };
}

/** Patch a library entry (per/note edits detach grout geometry). */
export function libEntryPatch(x, patch) {
  let next = detachGroutOnRateEdit(x, patch);
  next = { ...next, ...patch };

  if (patch.grout) {
    const derived = groutDerivedFields({ ...GROUT_DEFAULTS, ...patch.grout });
    if (derived) Object.assign(next, derived);
    next.grout = { ...patch.grout };
    return next;
  }

  if (patch.name != null && !x.grout) {
    next = renameReclassified(next, x.name);
  }

  return next;
}

/** Deep-copy a template/seed material into a live condition line. */
export function instantiateMaterial(m, id) {
  const out = { ...m, id, round: m.round !== false };
  if (m.grout) out.grout = { ...m.grout };
  else delete out.grout;
  return out;
}
