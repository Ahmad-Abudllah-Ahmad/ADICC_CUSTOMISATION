// Supabase-backed store — Postgres is source of truth; IndexedDB is local cache.
import { createLocalStore, ANN_SCHEMA, emptyAnnotations } from "./store.js";
import {
  isSupabaseConfigured,
  getSupabaseProjectId,
  getSupabaseProjectIdFromUrl,
  setSupabaseProjectId,
} from "./supabase/client.js";
import {
  loadProjectFromSupabase,
  syncProjectToSupabase,
  createSupabaseProject,
  seedShapeSnapshot,
  clearProjectDataInSupabase,
} from "./supabase/persist.js";
import {
  listProjectFiles,
  upsertProjectFile,
  downloadProjectFile,
  deleteProjectFile,
  hydrateLocalPlansFromDb,
  uploadProjectFilesBatch,
  fileFoldersFromProjectFiles,
  sheetListNameFromRow,
} from "./supabase/projectFiles.js";
import { touchProjectOpened, openSupabaseProject } from "./supabase/projects.js";
import { createSupabaseRecents, browserStorage } from "./supabaseRecents.js";

let lastRemoteUpdatedAt = null;
/** Session cache — avoids repeated manifest queries while the gallery/sidebar refreshes. */
let cachedPlanManifest = null;
let cachedPlanManifestProjectId = null;
/** Dedupes concurrent manifest fetches (mount listSheets vs loadAnnotations). */
let manifestFetchPromise = null;
let manifestFetchProjectId = null;

function invalidatePlanManifestCache() {
  cachedPlanManifest = null;
  cachedPlanManifestProjectId = null;
  manifestFetchPromise = null;
  manifestFetchProjectId = null;
}

function mergeRemoteAndLocalSheetNames(localList, rows) {
  const names = new Set((rows || []).map((r) => sheetListNameFromRow(r)));
  for (const s of localList || []) names.add(s.name);
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => ({ name }));
}

function findManifestRow(rows, name) {
  if (!rows?.length || !name) return undefined;
  return rows.find((r) => sheetListNameFromRow(r) === name || r.file_name === name);
}

async function ensurePlanManifest(projectId) {
  if (!projectId) return [];
  if (cachedPlanManifestProjectId === projectId && cachedPlanManifest) {
    return cachedPlanManifest;
  }
  if (manifestFetchProjectId === projectId && manifestFetchPromise) {
    return manifestFetchPromise;
  }
  manifestFetchProjectId = projectId;
  manifestFetchPromise = listProjectFiles(projectId)
    .then((rows) => {
      cachedPlanManifest = rows;
      cachedPlanManifestProjectId = projectId;
      manifestFetchPromise = null;
      manifestFetchProjectId = null;
      return rows;
    })
    .catch((e) => {
      manifestFetchPromise = null;
      manifestFetchProjectId = null;
      throw e;
    });
  return manifestFetchPromise;
}

async function ensureProjectId() {
  const fromUrl = (() => {
    try { return new URLSearchParams(window.location.search).get("db"); }
    catch { return null; }
  })();
  if (fromUrl) {
    setSupabaseProjectId(fromUrl);
    return fromUrl;
  }
  let id = getSupabaseProjectId();
  if (id) return id;
  id = await createSupabaseProject("ADICC Project");
  setSupabaseProjectId(id);
  return id;
}

function remoteHasData(payload) {
  return !!(payload?.shapes?.length || payload?.conditions?.length
    || payload?.markups?.length || payload?.boq_lines?.length);
}

/** @param {string|null} [projectId] Supabase project UUID — scopes local IndexedDB cache */
export function createSupabaseStore(projectId = null) {
  const scope = projectId || getSupabaseProjectIdFromUrl() || getSupabaseProjectId() || null;
  if (scope && cachedPlanManifestProjectId && cachedPlanManifestProjectId !== scope) {
    invalidatePlanManifestCache();
  }
  const local = createLocalStore(scope);

  return {
    ...local,

    /** Load plan manifest from Postgres before canvas mount (new browser / recents). */
    async prefetchPlanManifest() {
      if (!isSupabaseConfigured()) return [];
      const pid = scope || (await ensureProjectId());
      invalidatePlanManifestCache();
      return ensurePlanManifest(pid);
    },

    async listSheets() {
      const localList = await local.listSheets();
      if (!isSupabaseConfigured()) return localList;
      try {
        const pid = await ensureProjectId();
        const rows = await ensurePlanManifest(pid);
        if (!rows.length) return localList;
        return mergeRemoteAndLocalSheetNames(localList, rows);
      } catch (e) {
        console.warn("[ADICC] listProjectFiles", e);
        return localList;
      }
    },

    async loadPdfData(name) {
      try {
        return await local.loadPdfData(name);
      } catch (localErr) {
        if (!isSupabaseConfigured()) throw localErr;
        const pid = await ensureProjectId();
        let row = cachedPlanManifestProjectId === pid && cachedPlanManifest
          ? findManifestRow(cachedPlanManifest, name)
          : undefined;
        if (!row) {
          const rows = await ensurePlanManifest(pid);
          row = findManifestRow(rows, name);
        }
        const bytes = await downloadProjectFile(
          pid,
          name,
          row?.storage_path,
          row?.folder_path,
        );
        const mime = row?.content_type || "application/pdf";
        await local.addPdf(new File([bytes], name, { type: mime }));
        return bytes;
      }
    },

    async addPdf(file, opts = {}) {
      const res = await local.addPdf(file);
      if (!isSupabaseConfigured() || opts.skipRemote) return res;
      const projectId = await ensureProjectId();
      const bytes = await file.arrayBuffer();
      await upsertProjectFile(projectId, file.name, bytes, {
        folderPath: opts.folderPath || "",
        mimeType: file.type || "application/pdf",
      });
      invalidatePlanManifestCache();
      return res;
    },

    /** Save many plans to Storage + project_files after a folder ingest (batched). */
    async persistPlansBatch(files, folderFor, onProgress) {
      if (!isSupabaseConfigured() || !files?.length) return;
      const projectId = await ensureProjectId();
      await uploadProjectFilesBatch(projectId, files, { folderFor, onProgress });
      invalidatePlanManifestCache();
    },

    async removePdf(name) {
      await local.removePdf(name);
      if (!isSupabaseConfigured()) return;
      try {
        await deleteProjectFile(await ensureProjectId(), name);
        invalidatePlanManifestCache();
      } catch (e) {
        console.warn("[ADICC] deleteProjectFile", e);
      }
    },

    async loadAnnotations() {
      if (!isSupabaseConfigured()) return local.loadAnnotations();

      const projectId = await ensureProjectId();
      let remote;
      try {
        remote = await loadProjectFromSupabase(projectId);
      } catch (e) {
        console.error("[ADICC Supabase load]", e);
        const cached = await local.loadAnnotations();
        if (remoteHasData(cached)) return cached;
        throw e;
      }

      let payload = remote?.payload || { ...emptyAnnotations() };

      try {
        const projectIdForPlans = projectId;
        invalidatePlanManifestCache();
        const rows = await ensurePlanManifest(projectIdForPlans);
        cachedPlanManifest = rows;
        cachedPlanManifestProjectId = projectIdForPlans;
        const fileFolders = fileFoldersFromProjectFiles(rows);
        if (fileFolders && Object.keys(fileFolders).length) {
          payload = {
            ...payload,
            file_folders: { ...fileFolders, ...(payload.file_folders || {}) },
          };
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("adicc:plan-manifest-ready"));
        }
        void hydrateLocalPlansFromDb(projectIdForPlans, local, { rows })
          .then((result) => {
            cachedPlanManifest = result.rows;
            cachedPlanManifestProjectId = projectIdForPlans;
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("adicc:plan-manifest-ready"));
            }
          })
          .catch((e) => {
            console.warn("[ADICC] background plan hydrate", e);
          });
      } catch (e) {
        console.warn("[ADICC] hydrate plans from DB", e);
      }

      if (remote?.payload) {
        lastRemoteUpdatedAt = remote.updated_at;
        seedShapeSnapshot(projectId, payload.shapes || []);
        await local.saveAnnotations(payload);
        const name = payload.project_name || "ADICC Project";
        createSupabaseRecents(browserStorage()).remember({ id: projectId, name });
        touchProjectOpened(projectId).catch(() => {});
        return payload;
      }

      seedShapeSnapshot(projectId, []);
      await local.saveAnnotations(payload);
      return payload;
    },

    async saveAnnotations(payload) {
      if (!isSupabaseConfigured()) return local.saveAnnotations({ ...payload, schema: ANN_SCHEMA });

      const wrapped = { ...payload, schema: ANN_SCHEMA };
      const projectId = await ensureProjectId();
      await syncProjectToSupabase(projectId, wrapped);
      lastRemoteUpdatedAt = new Date().toISOString();
      await local.saveAnnotations(wrapped);
      createSupabaseRecents(browserStorage()).remember({
        id: projectId,
        name: wrapped.project_name || "ADICC Project",
      });
    },

    /** Wipe remote + local project takeoff data; templates/libraries unchanged. */
    async resetProjectData() {
      const projectId = await ensureProjectId();
      await clearProjectDataInSupabase(projectId);
      await local.clearProjectWorkspace();
      const empty = emptyAnnotations();
      await local.saveAnnotations(empty);
      lastRemoteUpdatedAt = new Date().toISOString();
      return empty;
    },

    /** Create a new empty Supabase project and navigate to it. */
    async createNewProject(name = "Untitled project") {
      const id = await createSupabaseProject(name);
      setSupabaseProjectId(id);
      createSupabaseRecents(browserStorage()).remember({ id, name });
      await touchProjectOpened(id);
      openSupabaseProject(id);
    },

    getSupabaseProjectId: () => getSupabaseProjectId(),
    getLastRemoteSync: () => lastRemoteUpdatedAt,
  };
}

export { isSupabaseConfigured };
