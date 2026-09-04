// Shared project access gate for persist + file operations.
import { supabase } from "./client.js";
import { getCurrentUserId } from "./auth.js";
import { canAccessProject, accessDeniedMessage } from "./ownership.js";

/** Throws if the signed-in user may not access this project. No-op when row missing. */
export async function assertProjectAccessById(projectId) {
  if (!supabase || !projectId) return;

  const { data: proj, error } = await supabase
    .from("projects")
    .select("client_info")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!proj) return;

  const userId = await getCurrentUserId();
  if (!canAccessProject(proj, userId)) {
    throw new Error(accessDeniedMessage(proj, userId) || "Access denied.");
  }
}
