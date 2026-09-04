// Project ownership without schema migration — stored in existing client_info JSONB.
// Legacy rows: no adicc_owner_id → shared with everyone (current behavior).
// New rows: client_info.adicc_owner_id = creator's auth uid → private to that user.

export const PROJECT_OWNER_KEY = "adicc_owner_id";

/** @param {{ client_info?: Record<string, unknown> } | null | undefined} proj */
export function getProjectOwnerId(proj) {
  const ci = proj?.client_info;
  if (!ci || typeof ci !== "object") return null;
  const id = ci[PROJECT_OWNER_KEY];
  return typeof id === "string" && id.length ? id : null;
}

/** Legacy shared project — visible to all authenticated users in the list. */
export function isSharedProject(proj) {
  return !getProjectOwnerId(proj);
}

/** Whether this user may open/save/delete the project. Legacy = anyone (incl. anon read). */
export function canAccessProject(proj, userId) {
  const ownerId = getProjectOwnerId(proj);
  if (!ownerId) return true;
  return !!userId && ownerId === userId;
}

/** List filter: show shared legacy + own private projects. */
export function isVisibleInProjectList(proj, userId) {
  const ownerId = getProjectOwnerId(proj);
  if (!ownerId) return true;
  return !!userId && ownerId === userId;
}

export function accessDeniedMessage(proj, userId) {
  const ownerId = getProjectOwnerId(proj);
  if (!ownerId) return null;
  if (!userId) return "Sign in to open this project.";
  if (ownerId !== userId) return "You do not have access to this project.";
  return null;
}
