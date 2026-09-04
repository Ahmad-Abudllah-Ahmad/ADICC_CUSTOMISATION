// Supabase project listing + navigation helpers for the Plan set recents UI.
import { supabase } from "./client.js";
import { getCurrentUserId } from "./auth.js";
import { getProjectOwnerId, isVisibleInProjectList } from "./ownership.js";

/** @typedef {{ id: string, name: string, sheetCount: number, shapeCount: number, floorSf: number, lastOpenedAt: string|null, updatedAt: string|null, createdAt: string|null }} ProjectSummary */

function sheetCountFromAnnotations(annotations) {
  if (!annotations || typeof annotations !== "object") return 0;
  const tabs = annotations.sheet_tabs;
  if (Array.isArray(tabs) && tabs.length) return tabs.length;
  const sheets = annotations.sheets;
  if (Array.isArray(sheets)) return sheets.length;
  return 0;
}

function summarizeRow(row) {
  const totals = Array.isArray(row.project_totals) ? row.project_totals[0] : row.project_totals;
  return {
    id: row.id,
    name: row.name || "Untitled project",
    sheetCount: sheetCountFromAnnotations(row.annotations),
    shapeCount: totals?.shape_count ?? 0,
    floorSf: totals?.floor_sf ?? 0,
    lastOpenedAt: row.last_opened_at || null,
    updatedAt: row.updated_at || null,
    createdAt: row.created_at || null,
  };
}

/** List saved projects for the Plan set recents panel. */
export async function listProjectSummaries({ search = "", limit = 48 } = {}) {
  if (!supabase) return [];

  let query = supabase
    .from("projects")
    .select(`
      id,
      name,
      created_at,
      updated_at,
      last_opened_at,
      annotations,
      client_info,
      project_totals ( shape_count, floor_sf )
    `)
    .limit(limit);

  const needle = search.trim();
  if (needle) query = query.ilike("name", `%${needle.replace(/[%_]/g, "")}%`);

  query = query.order("last_opened_at", { ascending: false, nullsFirst: false });

  let { data, error } = await query;
  if (error?.message?.includes("last_opened_at")) {
    query = supabase
      .from("projects")
      .select(`
        id,
        name,
        created_at,
        updated_at,
        annotations,
        client_info,
        project_totals ( shape_count, floor_sf )
      `)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (needle) query = query.ilike("name", `%${needle.replace(/[%_]/g, "")}%`);
    ({ data, error } = await query);
  }
  if (error) throw error;
  const userId = await getCurrentUserId();
  return (data || [])
    .filter((row) => isVisibleInProjectList(row, userId))
    .map(summarizeRow)
    .filter((p) => !p.name?.toLowerCase().includes("arch. drawings part ii"));
}

export { deleteSupabaseProject, renameSupabaseProject } from "./persist.js";

/** Mark a project as recently opened (best-effort). */
export async function touchProjectOpened(projectId) {
  if (!supabase || !projectId) return;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("projects")
    .update({ last_opened_at: now })
    .eq("id", projectId);
  // Column may be missing if migration 002 hasn't been applied — non-fatal.
  if (error && !error.message?.includes("last_opened_at")) {
    console.warn("[ADICC] touchProjectOpened:", error.message);
  }
}

/** Navigate to a Supabase-backed project. Uses client routing when `navigate` is passed. */
export function navigateToSupabaseProject(projectId, navigate) {
  if (!projectId) return;
  try {
    localStorage.setItem("adicc_supabase_project_id", projectId);
  } catch { /* private mode */ }
  // Keep the app's current mount path. In the ADICC production iframe that is
  // `/takeoff/`; forcing `/` would navigate the frame into the parent Next app.
  const url = new URL(window.location.href);
  url.searchParams.set("db", projectId);
  url.searchParams.delete("project");
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (typeof navigate === "function") {
    navigate(path);
    return;
  }
  window.location.assign(url.toString());
}

/** Navigate to a Supabase-backed project (full reload remounts canvas + store). */
export function openSupabaseProject(projectId) {
  navigateToSupabaseProject(projectId);
}

/** Return to the home screen (recent projects list). */
export function goSupabaseHome() {
  const url = new URL(window.location.href);
  url.searchParams.delete("db");
  url.searchParams.delete("project");
  window.location.assign(url.toString());
}
