// Supabase-backed store — offline-first: IndexedDB cache + real-time Postgres mirror.
import { createLocalStore, ANN_SCHEMA, emptyAnnotations } from "./store.js";
import {
  isSupabaseConfigured,
  getSupabaseProjectId,
  setSupabaseProjectId,
} from "./supabase/client.js";
import {
  loadProjectFromSupabase,
  syncProjectToSupabase,
  createSupabaseProject,
} from "./supabase/persist.js";

let syncQueue = Promise.resolve();
let lastRemoteUpdatedAt = null;

function enqueueSync(fn) {
  syncQueue = syncQueue.then(fn).catch((e) => {
    console.error("[ADICC Supabase sync]", e);
  });
  return syncQueue;
}

async function ensureProjectId() {
  let id = getSupabaseProjectId();
  if (id) return id;
  id = await createSupabaseProject("ADICC Project");
  setSupabaseProjectId(id);
  return id;
}

/** @param {string|null} [folderId] Drive folder scope for local cache */
export function createSupabaseStore(folderId = null) {
  const local = createLocalStore(folderId);

  return {
    ...local,

    async loadAnnotations() {
      if (!isSupabaseConfigured()) return local.loadAnnotations();

      const projectId = await ensureProjectId();
      const [localAnn, remote] = await Promise.all([
        local.loadAnnotations(),
        loadProjectFromSupabase(projectId).catch(() => null),
      ]);

      if (!remote?.payload) {
        const hasLocal = (localAnn.shapes?.length || localAnn.conditions?.length);
        if (hasLocal) {
          enqueueSync(() => syncProjectToSupabase(projectId, { ...localAnn, schema: ANN_SCHEMA }));
        }
        return localAnn.shapes?.length ? localAnn : emptyAnnotations();
      }

      lastRemoteUpdatedAt = remote.updated_at;
      const remoteHasData = remote.payload.shapes?.length || remote.payload.conditions?.length;
      const localHasData = localAnn.shapes?.length || localAnn.conditions?.length;

      if (localHasData && !remoteHasData) {
        enqueueSync(() => syncProjectToSupabase(projectId, { ...localAnn, schema: ANN_SCHEMA }));
        return localAnn;
      }

      await local.saveAnnotations(remote.payload);
      return remote.payload;
    },

    async saveAnnotations(payload) {
      const wrapped = { ...payload, schema: ANN_SCHEMA };
      await local.saveAnnotations(wrapped);

      if (!isSupabaseConfigured()) return;

      const projectId = await ensureProjectId();
      enqueueSync(async () => {
        await syncProjectToSupabase(projectId, wrapped);
        lastRemoteUpdatedAt = new Date().toISOString();
      });
    },

    getSupabaseProjectId: () => getSupabaseProjectId(),
    getLastRemoteSync: () => lastRemoteUpdatedAt,
  };
}

export { isSupabaseConfigured };
