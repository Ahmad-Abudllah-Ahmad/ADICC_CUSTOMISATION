// Plan file bytes — Supabase Storage + project_files metadata (folder structure at scale).
import { supabase } from "./client.js";

export const PLANS_BUCKET = "project-plans";
/** Parallel Storage I/O — tuned for large folder uploads (hundreds of PDFs). */
const UPLOAD_CONCURRENCY = 10;
const DOWNLOAD_CONCURRENCY = 10;
/** Postgres upsert batch size (one round-trip per chunk). */
const DB_UPSERT_CHUNK = 100;
/** PostgREST page size for project file manifests (5–12 GB projects can be 500+ files). */
const LIST_PAGE = 1000;
/** Supabase Storage `list()` max per request (values above 100 are capped server-side). */
const STORAGE_LIST_PAGE = 100;
const PROGRESS_TICK = 10;

export function storageObjectPath(projectId, fileName) {
  const base = String(fileName || "file").replace(/\\/g, "/").split("/").pop() || "file";
  return `${projectId}/${base}`;
}

/** Earlier builds encoded the filename segment — keep for download fallback. */
function legacyEncodedStoragePath(projectId, fileName) {
  const base = String(fileName || "file").replace(/\\/g, "/").split("/").pop() || "file";
  return `${projectId}/${encodeURIComponent(base)}`;
}

function downloadPathCandidates(projectId, fileName, storagePath, folderPath = "") {
  const base = String(fileName || "file").replace(/\\/g, "/").split("/").pop() || "file";
  const paths = [];
  if (storagePath?.trim()) paths.push(storagePath.trim());
  const fp = normalizeFolderPath(folderPath);
  if (fp) {
    paths.push(`${projectId}/${fp}/${base}`);
    paths.push(`${projectId}/${fp}/${encodeURIComponent(base)}`);
  }
  paths.push(storageObjectPath(projectId, fileName));
  paths.push(legacyEncodedStoragePath(projectId, fileName));
  return [...new Set(paths)];
}

async function downloadStorageAtPath(path) {
  const { data, error } = await supabase.storage.from(PLANS_BUCKET).download(path);
  if (!error && data) return new Uint8Array(await data.arrayBuffer());
  const { data: signed, error: signErr } = await supabase.storage
    .from(PLANS_BUCKET)
    .createSignedUrl(path, 120);
  if (!signErr && signed?.signedUrl) {
    const res = await fetch(signed.signedUrl);
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  }
  throw error || signErr || new Error("Storage download failed");
}

function normalizeFolderPath(folderPath) {
  return (folderPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function normalizeProjectFileRow(row) {
  return {
    file_name: row.file_name,
    folder_path: row.folder_path ?? "",
    byte_size: Number(row.byte_size) || 0,
    content_type: row.content_type ?? row.mime_type ?? null,
    storage_path: row.storage_path,
  };
}

async function queryProjectFilesPage(projectId, from, select, orderByFolder, pageSize = LIST_PAGE) {
  let q = supabase
    .from("project_files")
    .select(select)
    .eq("project_id", projectId);
  if (orderByFolder) q = q.order("folder_path", { ascending: true });
  q = q.order("file_name", { ascending: true });
  return q.range(from, from + pageSize - 1);
}

/** @returns {Promise<Array<{ file_name: string, folder_path: string, byte_size: number, content_type: string|null, storage_path: string }>>} */
export async function listProjectFiles(projectId) {
  if (!supabase || !projectId) return [];
  const selectAttempts = [
    { select: "file_name, folder_path, byte_size, content_type, storage_path", orderByFolder: true },
    { select: "file_name, folder_path, byte_size, mime_type, storage_path", orderByFolder: true },
    { select: "file_name, byte_size, storage_path", orderByFolder: false },
    { select: "file_name, storage_path", orderByFolder: false },
  ];
  let cfg = selectAttempts[0];
  let probe = await queryProjectFilesPage(projectId, 0, cfg.select, cfg.orderByFolder);
  for (let i = 1; i < selectAttempts.length && probe.error; i++) {
    cfg = selectAttempts[i];
    probe = await queryProjectFilesPage(projectId, 0, cfg.select, cfg.orderByFolder);
  }
  if (probe.error) throw probe.error;

  const all = [];
  let from = 0;
  let usedProbe = false;
  for (;;) {
    let data;
    let error = null;
    if (!usedProbe && probe.data?.length) {
      data = probe.data;
      usedProbe = true;
    } else {
      const res = await queryProjectFilesPage(projectId, from, cfg.select, cfg.orderByFolder);
      data = res.data;
      error = res.error;
    }
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data.map(normalizeProjectFileRow));
    from += data.length;
  }
  let storageRows = [];
  try {
    storageRows = await collectStoragePlanRows(projectId);
  } catch (e) {
    console.warn("[ADICC] storage manifest walk", e?.message || e);
  }
  return mergeDbAndStorageManifest(all, storageRows);
}

function storageEntryIsFolder(entry) {
  if (entry?.metadata != null) return false;
  if (entry?.id != null) return false;
  const name = entry?.name || "";
  if (/\.(pdf|png|jpe?g|gif|webp|dwg|tif{1,2}|bmp)$/i.test(name)) return false;
  return true;
}

function manifestRowKey(row) {
  const sp = (row.storage_path || "").trim();
  if (sp) return sp;
  const fp = normalizeFolderPath(row.folder_path);
  return fp ? `${fp}/${row.file_name}` : row.file_name;
}

/** Walk Storage under `{projectId}/` so plans appear even if project_files rows are missing. */
async function collectStoragePlanRows(projectId, folderPath = "") {
  if (!supabase || !projectId) return [];
  const listPath = folderPath ? `${projectId}/${folderPath}` : projectId;
  const out = [];
  for (let offset = 0; ; ) {
    const { data, error } = await supabase.storage.from(PLANS_BUCKET).list(listPath, {
      limit: STORAGE_LIST_PAGE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      console.warn("[ADICC] storage list", listPath, error.message || error);
      break;
    }
    if (!data?.length) break;
    for (const o of data) {
      if (!o.name || o.name === ".emptyFolderPlaceholder") continue;
      if (storageEntryIsFolder(o)) {
        const childFolder = folderPath ? `${folderPath}/${o.name}` : o.name;
        out.push(...await collectStoragePlanRows(projectId, childFolder));
        continue;
      }
      const fp = normalizeFolderPath(folderPath);
      const storage_path = fp ? `${projectId}/${fp}/${o.name}` : `${projectId}/${o.name}`;
      out.push(normalizeProjectFileRow({
        file_name: o.name,
        folder_path: fp,
        byte_size: Number(o.metadata?.size) || 0,
        mime_type: o.metadata?.mimetype || null,
        storage_path,
      }));
    }
    offset += data.length;
  }
  return out;
}

function mergeDbAndStorageManifest(dbRows, storageRows) {
  const byKey = new Map();
  for (const r of dbRows || []) byKey.set(manifestRowKey(r), r);
  for (const r of storageRows || []) {
    const key = manifestRowKey(r);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
      continue;
    }
    if (!prev.storage_path?.trim() && r.storage_path) {
      byKey.set(key, { ...prev, storage_path: r.storage_path });
    }
    if (!prev.folder_path?.trim() && r.folder_path) {
      byKey.set(key, { ...byKey.get(key), folder_path: r.folder_path });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const fa = (a.folder_path || "").localeCompare(b.folder_path || "", undefined, { sensitivity: "base" });
    if (fa !== 0) return fa;
    return a.file_name.localeCompare(b.file_name, undefined, { sensitivity: "base" });
  });
}

export function fileFoldersFromProjectFiles(rows) {
  const m = {};
  for (const r of rows) {
    const fp = (r.folder_path || "").trim();
    if (!fp) continue;
    const norm = normalizeFolderPath(fp);
    m[r.file_name] = norm;
    m[sheetListNameFromRow(r)] = norm;
  }
  return m;
}

/** Sidebar / listSheets label — disambiguates same basename in different folders. */
export function sheetListNameFromRow(row) {
  const fp = normalizeFolderPath(row.folder_path);
  return fp ? `${fp}/${row.file_name}` : row.file_name;
}

function metaRow(projectId, fileName, path, folderPath, mimeType, byteLength) {
  const mt = mimeType || "application/pdf";
  return {
    project_id: projectId,
    file_name: fileName,
    storage_path: path,
    folder_path: normalizeFolderPath(folderPath),
    content_type: mt,
    byte_size: byteLength,
    updated_at: new Date().toISOString(),
  };
}

/** Postgres column sets differ by migration — try until one upsert succeeds. */
const META_UPSERT_VARIANTS = [
  (row) => ({
    project_id: row.project_id,
    file_name: row.file_name,
    storage_path: row.storage_path,
    folder_path: row.folder_path ?? "",
    content_type: row.content_type,
    byte_size: row.byte_size,
    updated_at: row.updated_at,
  }),
  (row) => ({
    project_id: row.project_id,
    file_name: row.file_name,
    storage_path: row.storage_path,
    content_type: row.content_type,
    byte_size: row.byte_size,
    updated_at: row.updated_at,
  }),
  (row) => ({
    project_id: row.project_id,
    file_name: row.file_name,
    storage_path: row.storage_path,
    folder_path: row.folder_path ?? "",
    mime_type: row.content_type,
    byte_size: row.byte_size,
    updated_at: row.updated_at,
  }),
  (row) => ({
    project_id: row.project_id,
    file_name: row.file_name,
    storage_path: row.storage_path,
    mime_type: row.content_type,
    byte_size: row.byte_size,
    updated_at: row.updated_at,
  }),
  (row) => ({
    project_id: row.project_id,
    file_name: row.file_name,
    storage_path: row.storage_path,
    byte_size: row.byte_size,
    updated_at: row.updated_at,
  }),
];

async function upsertProjectFileMetaBatch(rows) {
  if (!supabase || !rows.length) return;
  for (let i = 0; i < rows.length; i += DB_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + DB_UPSERT_CHUNK);
    let lastErr = null;
    for (const mapRow of META_UPSERT_VARIANTS) {
      const payload = chunk.map(mapRow);
      const { error } = await supabase.from("project_files").upsert(payload, {
        onConflict: "project_id,file_name",
      });
      if (!error) {
        lastErr = null;
        break;
      }
      lastErr = error;
    }
    if (lastErr) throw lastErr;
  }
}

export async function upsertProjectFile(projectId, fileName, bytes, { folderPath = "", mimeType = "application/pdf" } = {}) {
  if (!supabase || !projectId) return;
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const path = storageObjectPath(projectId, fileName);
  const { error: upErr } = await supabase.storage.from(PLANS_BUCKET).upload(path, body, {
    upsert: true,
    contentType: mimeType || "application/pdf",
  });
  if (upErr) throw upErr;
  await upsertProjectFileMetaBatch([{
    project_id: projectId,
    file_name: fileName,
    storage_path: path,
    folder_path: normalizeFolderPath(folderPath),
    content_type: mimeType || "application/pdf",
    byte_size: body.byteLength,
    updated_at: new Date().toISOString(),
  }]);
}

export async function downloadProjectFile(projectId, fileName, storagePath, folderPath = "") {
  if (!supabase || !projectId) throw new Error("Supabase not configured");
  const candidates = downloadPathCandidates(projectId, fileName, storagePath, folderPath);
  let lastErr;
  for (const path of candidates) {
    try {
      return await downloadStorageAtPath(path);
    } catch (e) {
      lastErr = e;
    }
  }
  const detail = lastErr?.message || String(lastErr || "");
  throw new Error(detail ? `Could not load plan from cloud storage: ${detail}` : "Could not load plan from cloud storage");
}

export async function deleteProjectFile(projectId, fileName) {
  if (!supabase || !projectId) return;
  const path = storageObjectPath(projectId, fileName);
  await supabase.storage.from(PLANS_BUCKET).remove([path]);
  const { error } = await supabase.from("project_files").delete()
    .eq("project_id", projectId).eq("file_name", fileName);
  if (error) throw error;
}

export async function deleteAllProjectFiles(projectId) {
  if (!supabase || !projectId) return;
  const rows = await listProjectFiles(projectId);
  const paths = rows.map((r) => r.storage_path || storageObjectPath(projectId, r.file_name));
  if (paths.length) {
    for (let i = 0; i < paths.length; i += 100) {
      await supabase.storage.from(PLANS_BUCKET).remove(paths.slice(i, i + 100));
    }
  }
  const { error } = await supabase.from("project_files").delete().eq("project_id", projectId);
  if (error) throw error;
}

async function runPool(items, worker, concurrency) {
  if (!items.length) return;
  let i = 0;
  const n = Math.min(concurrency, items.length);
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/** Download missing plan bytes into the scoped local IndexedDB cache (parallel, large-set safe). */
export async function hydrateLocalPlansFromDb(projectId, localStore, { onProgress, rows: prefetchedRows } = {}) {
  const rows = prefetchedRows || await listProjectFiles(projectId);
  if (!rows.length) return { rows, fileFolders: {} };

  const localSheets = await localStore.listSheets();
  const have = new Set(localSheets.map((s) => s.name));
  const missing = rows.filter((r) => !have.has(r.file_name));
  let done = 0;
  const total = missing.length;
  let lastTick = 0;

  await runPool(missing, async (row) => {
    try {
      const bytes = await downloadProjectFile(projectId, row.file_name, row.storage_path, row.folder_path);
      await localStore.addPdf(new File([bytes], row.file_name, { type: row.content_type || "application/pdf" }));
    } catch (e) {
      console.warn(`[ADICC] skip cloud plan "${row.file_name}"`, e?.message || e);
    }
    done += 1;
    if (onProgress && (done === total || done - lastTick >= PROGRESS_TICK)) {
      lastTick = done;
      onProgress(`Syncing plans from database (${done}/${total})…`);
    }
  }, DOWNLOAD_CONCURRENCY);

  return { rows, fileFolders: fileFoldersFromProjectFiles(rows) };
}

/** Fire-and-forget hydration — project opens immediately; bytes fill cache in the background. */
export function hydrateLocalPlansFromDbBackground(projectId, localStore, opts = {}) {
  return hydrateLocalPlansFromDb(projectId, localStore, opts).catch((e) => {
    console.warn("[ADICC] background plan hydrate", e);
  });
}

/** Upload many files after local ingest (Storage parallel + batched Postgres metadata). */
export async function uploadProjectFilesBatch(projectId, files, { folderFor, onProgress } = {}) {
  const total = files.length;
  if (!total) return;
  const pendingMeta = [];
  let done = 0;
  let lastTick = 0;

  const flushMeta = async () => {
    if (!pendingMeta.length) return;
    const chunk = pendingMeta.splice(0, pendingMeta.length);
    await upsertProjectFileMetaBatch(chunk);
  };

  await runPool(files, async (file) => {
    const bytes = await file.arrayBuffer();
    const path = storageObjectPath(projectId, file.name);
    const { error: upErr } = await supabase.storage.from(PLANS_BUCKET).upload(path, bytes, {
      upsert: true,
      contentType: file.type || "application/pdf",
    });
    if (upErr) throw upErr;
    pendingMeta.push(metaRow(
      projectId,
      file.name,
      path,
      typeof folderFor === "function" ? folderFor(file) : "",
      file.type || "application/pdf",
      bytes.byteLength,
    ));
    if (pendingMeta.length >= DB_UPSERT_CHUNK) await flushMeta();
    done += 1;
    if (onProgress && total > 3 && (done === total || done - lastTick >= PROGRESS_TICK)) {
      lastTick = done;
      onProgress(`Saving to database (${done}/${total})…`);
    }
  }, UPLOAD_CONCURRENCY);

  await flushMeta();
}
