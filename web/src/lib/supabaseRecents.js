// Browser-local Supabase project recents — supplements DB last_opened_at for
// instant reordering within this browser without waiting on a round-trip.

const RECENTS_KEY = "adicc_recent_supabase_projects";
const RECENTS_MAX = 24;

export function browserStorage() {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch { /* blocked site data */ }
  return { getItem: () => null, setItem: () => {} };
}

/** @typedef {{ id: string, name: string, openedAt?: number }} SupabaseRecent */

export function createSupabaseRecents(storage = browserStorage()) {
  return {
    /** @returns {SupabaseRecent[]} */
    list() {
      let parsed;
      try {
        parsed = JSON.parse(storage.getItem(RECENTS_KEY));
      } catch {
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((e) => e && typeof e.id === "string" && typeof e.name === "string")
        .map((e) => ({ id: e.id, name: e.name, openedAt: Number(e.openedAt) || 0 }));
    },
    /** @param {{ id: string, name: string }} entry */
    remember({ id, name }) {
      const rest = this.list().filter((e) => e.id !== id);
      const next = [{ id, name, openedAt: Date.now() }, ...rest].slice(0, RECENTS_MAX);
      try { storage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* noop */ }
    },
    /** @param {string} id */
    forget(id) {
      const next = this.list().filter((e) => e.id !== id);
      try { storage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* noop */ }
    },
    /** @param {string} id @param {string} name */
    rename(id, name) {
      const next = this.list().map((e) => (e.id === id ? { ...e, name } : e));
      try { storage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* noop */ }
    },
    /** Drop recents whose id is not in the DB anymore. @param {Set<string>|string[]} validIds */
    pruneMissing(validIds) {
      const keep = validIds instanceof Set ? validIds : new Set(validIds);
      const next = this.list().filter((e) => keep.has(e.id));
      try { storage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* noop */ }
    },
  };
}

/**
 * Merge DB project summaries with browser recents — recents-first, then the rest
 * sorted by last_opened_at / updated_at.
 * @param {import("./supabase/projects.js").ProjectSummary[]} fromDb
 * @param {SupabaseRecent[]} recents
 * @param {string} [needle] lowercase search
 */
export function mergeProjectLists(fromDb, recents, needle = "") {
  const byId = new Map(fromDb.map((p) => [p.id, p]));
  const q = needle.trim().toLowerCase();
  const matches = (p) => !q || p.name.toLowerCase().includes(q);

  const ordered = [];
  const seen = new Set();

  for (const r of recents) {
    const row = byId.get(r.id) || { id: r.id, name: r.name, sheetCount: 0, shapeCount: 0, lastOpenedAt: r.openedAt ? new Date(r.openedAt).toISOString() : null, updatedAt: null };
    if (!matches(row)) continue;
    ordered.push(row);
    seen.add(r.id);
  }

  const rest = fromDb
    .filter((p) => !seen.has(p.id) && matches(p))
    .sort((a, b) => {
      const ao = a.lastOpenedAt || a.updatedAt || "";
      const bo = b.lastOpenedAt || b.updatedAt || "";
      return bo.localeCompare(ao);
    });

  return [...ordered, ...rest];
}
