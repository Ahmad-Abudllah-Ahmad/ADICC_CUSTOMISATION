// Per-project FIFO save queue — serializes Supabase writes so concurrent autosaves
// and multi-tab sessions never interleave delete+upsert cycles.

const chains = new Map();

/**
 * Run `fn` after all prior saves for this project finish. Failures do not block
 * the queue (the next save still runs).
 * @template T
 * @param {string} projectId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function enqueueProjectSave(projectId, fn) {
  if (!projectId) return fn();
  const prev = chains.get(projectId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(fn);
  chains.set(projectId, next);
  return next.finally(() => {
    if (chains.get(projectId) === next) chains.delete(projectId);
  });
}

/** Test hook — drain any in-flight chain for a project. */
export function waitForProjectSave(projectId) {
  return chains.get(projectId) || Promise.resolve();
}
