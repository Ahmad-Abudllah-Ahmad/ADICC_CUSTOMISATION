// Derive a project display name from uploaded files or a folder pick.

const STRIP_EXT = /\.[^.]+$/;

/** @param {FileList|File[]} fileList */
export function projectNameFromFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return "Untitled project";

  const first = files[0];
  const rel = (first.webkitRelativePath || "").replace(/\\/g, "/");
  if (rel.includes("/")) {
    const top = rel.split("/").filter(Boolean)[0];
    if (top) return top;
  }

  if (files.length === 1) {
    const stem = first.name.replace(STRIP_EXT, "").trim();
    return stem || first.name;
  }

  const stem = first.name.replace(STRIP_EXT, "").trim();
  return stem || "Untitled project";
}

export const DEFAULT_PROJECT_NAMES = new Set([
  "",
  "untitled project",
  "untitled",
  "adicc project",
]);

/** @param {string} name */
export function isDefaultProjectName(name) {
  return DEFAULT_PROJECT_NAMES.has(String(name || "").trim().toLowerCase());
}
