// Stash files picked on the home screen across an in-app navigation to the
// canvas (File objects can't survive a full page reload).
/** @type {{ files: File[], projectName: string|null }|null} */
let pending = null;

/** @param {FileList|File[]} fileList @param {string|null} [projectName] */
export function stashPendingIngest(fileList, projectName = null) {
  pending = { files: Array.from(fileList || []), projectName: projectName || null };
}

/** @returns {{ files: File[], projectName: string|null }|null} */
export function consumePendingIngest() {
  const p = pending;
  pending = null;
  return p;
}
