// Supabase client — enabled when VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are set.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL || "";
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
export const supabase = url && key ? createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
}) : null;

export function isSupabaseConfigured() {
  return !!supabase;
}

export const SUPABASE_PROJECT_KEY = "adicc_supabase_project_id";

/** Project id from the URL only — used to decide home vs canvas routing. */
export function getSupabaseProjectIdFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get("db") || "";
  } catch {
    return "";
  }
}

export function getSupabaseProjectId() {
  try {
    const fromUrl = getSupabaseProjectIdFromUrl();
    if (fromUrl) return fromUrl;
    return localStorage.getItem(SUPABASE_PROJECT_KEY) || "";
  } catch {
    return "";
  }
}

export function setSupabaseProjectId(id) {
  try {
    if (id) localStorage.setItem(SUPABASE_PROJECT_KEY, id);
    else localStorage.removeItem(SUPABASE_PROJECT_KEY);
  } catch { /* private mode */ }
}
