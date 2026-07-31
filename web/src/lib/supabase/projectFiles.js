// Plan file bytes — Supabase Storage + project_files metadata (folder structure at scale).
import { supabase } from "./client.js";

export const PLANS_BUCKET = "project-plans";
/** Transfers split one HTTP/2 connection's bandwidth, so the right fan-out depends
 *  on what limits each request. Small plans are latency-bound — the round-trip
 *  dwarfs the bytes, so many at once costs nothing and hides the latency. Multi-MB
 *  plans are bandwidth-bound: piling those up just makes every one finish late.
 *  Both lanes run together, so a folder of thumbnails never waits behind a 40 MB set. */
const SMALL_FILE_BYTES = 2 * 1024 * 1024;
const SMALL_LANE_CONCURRENCY = 12;
const LARGE_LANE_CONCURRENCY = 3;
/** Land metadata while a big upload is still running, not only at the end — whichever
 *  of the two limits trips first, so a slow lane still checkpoints on time. */
const META_FLUSH_EVERY = 75;
const META_FLUSH_MS = 1500;
/** Below this a batch uploads faster than the resume scan would list. */
const PRESCAN_MIN_FILES = 20;
/** Backoff for rate limits / transient network failures on 1000+ file sets. */
const RETRY_DELAYS_MS = [400, 1200, 3000];
/** Postgres upsert batch size (one round-trip per chunk). */
const DB_UPSERT_CHUNK = 100;
/** PostgREST page size for project file manifests (5–12 GB projects can be 500+ files). */
const LIST_PAGE = 1000;
/** Supabase Storage `list()` max per request (values above 100 are capped server-side). */
const STORAGE_LIST_PAGE = 100;
/** Folders listed at once while walking the tree — a deep set is dozens of round-trips,
 *  and they only depend on their parent, so a level fans out instead of trickling. */
const STORAGE_WALK_CONCURRENCY = 8;
const PROGRESS_TICK = 10;

/** Keys mirror the upload tree, so the same basename in two folders can't overwrite. */
export function storageObjectPath(projectId, fileName, folderPath = "") {
  const base = String(fileName || "file").replace(/\\/g, "/").split("/").pop() || "file";
  const fp = normalizeFolderPath(folderPath);
  return fp ? `${projectId}/${fp}/${base}` : `${projectId}/${base}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errStatus(err) {
  return Number(err?.statusCode ?? err?.status ?? err?.originalError?.status ?? NaN);
}

function isTransientError(err) {
  const status = errStatus(err);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const msg = String(err?.message || "").toLowerCase();
  return /timeout|network|fetch failed|failed to fetch|econnreset|socket|too many/.test(msg);
}

/** A missing object answers 400/404 — retrying or signing it just burns requests. */
function isMissingObjectError(err) {
  const status = errStatus(err);
  if (status === 404 || status === 400) return true;
  const msg = String(err?.message || "").toLowerCase();
  return /not found|does not exist|no such/.test(msg);
}

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientError(e)) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
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
  if (error && isMissingObjectError(error)) throw error;
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

const SELECT_ATTEMPTS = [
  { select: "file_name, folder_path, byte_size, content_type, storage_path", orderByFolder: true },
  { select: "file_name, folder_path, byte_size, mime_type, storage_path", orderByFolder: true },
  { select: "file_name, byte_size, storage_path", orderByFolder: false },
  { select: "file_name, storage_path", orderByFolder: false },
];
/** The schema doesn't change mid-session — remember which select this database
 *  accepts so later manifest reads don't re-pay the failed probes. */
let workingSelect = null;

async function queryAllProjectFileRows(projectId) {
  const attempts = workingSelect
    ? [workingSelect, ...SELECT_ATTEMPTS.filter((a) => a !== workingSelect)]
    : SELECT_ATTEMPTS;
  let cfg = attempts[0];
  let probe = await queryProjectFilesPage(projectId, 0, cfg.select, cfg.orderByFolder);
  for (let i = 1; i < attempts.length && probe.error; i++) {
    cfg = attempts[i];
    probe = await queryProjectFilesPage(projectId, 0, cfg.select, cfg.orderByFolder);
  }
  if (probe.error) throw probe.error;
  workingSelect = cfg;

  const all = [];
  let from = 0;
  let page = probe.data;
  for (;;) {
    if (!page?.length) break;
    all.push(...page.map(normalizeProjectFileRow));
    from += page.length;
    const res = await queryProjectFilesPage(projectId, from, cfg.select, cfg.orderByFolder);
    if (res.error) throw res.error;
    page = res.data;
  }
  return all;
}

/** @param {{ onReconciled?: (rows: Array<object>) => void }} [opts] When given, the
 *  Storage walk runs in the background and hands back the reconciled manifest —
 *  the caller renders from Postgres alone instead of waiting on the whole tree.
 *  @returns {Promise<Array<{ file_name: string, folder_path: string, byte_size: number, content_type: string|null, storage_path: string }>>} */
export async function listProjectFiles(projectId, { onReconciled } = {}) {
  if (!supabase || !projectId) return [];
  const dbRows = await queryAllProjectFileRows(projectId);

  const walk = async () => {
    try {
      return await collectStoragePlanRows(projectId);
    } catch (e) {
      console.warn("[ADICC] storage manifest walk", e?.message || e);
      return [];
    }
  };

  if (!onReconciled) return mergeDbAndStorageManifest(dbRows, await walk());
  void walk().then((storageRows) => {
    onReconciled(mergeDbAndStorageManifest(dbRows, storageRows));
  });
  return dbRows;
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

/** Objects and subfolders directly under one folder of the project tree. */
async function listStorageFolder(projectId, folderPath) {
  const listPath = folderPath ? `${projectId}/${folderPath}` : projectId;
  const fp = normalizeFolderPath(folderPath);
  const files = [];
  const folders = [];
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
        folders.push(fp ? `${fp}/${o.name}` : o.name);
        continue;
      }
      files.push(normalizeProjectFileRow({
        file_name: o.name,
        folder_path: fp,
        byte_size: Number(o.metadata?.size) || 0,
        mime_type: o.metadata?.mimetype || null,
        storage_path: fp ? `${projectId}/${fp}/${o.name}` : `${projectId}/${o.name}`,
      }));
    }
    offset += data.length;
  }
  return { files, folders };
}

/** Walk Storage under `{projectId}/` so plans appear even if project_files rows are
 *  missing. Breadth-first: a whole level is listed in parallel, so a 9-folder tree
 *  costs a few round-trips of depth instead of one per folder end to end. */
async function collectStoragePlanRows(projectId) {
  if (!supabase || !projectId) return [];
  const out = [];
  let frontier = [""];
  while (frontier.length) {
    const next = [];
    await runPool(frontier, async (folderPath) => {
      const { files, folders } = await listStorageFolder(projectId, folderPath);
      out.push(...files);
      next.push(...folders);
    }, STORAGE_WALK_CONCURRENCY);
    frontier = next;
  }
  return out;
}

/** Object sizes directly under one folder — no recursion, so a resume scan costs
 *  a couple of round-trips per folder instead of walking the whole bucket. */
async function listFolderObjectSizes(projectId, folderPath) {
  const listPath = folderPath ? `${projectId}/${folderPath}` : projectId;
  const sizes = new Map();
  for (let offset = 0; ; ) {
    const { data, error } = await supabase.storage.from(PLANS_BUCKET).list(listPath, {
      limit: STORAGE_LIST_PAGE,
      offset,
    });
    if (error || !data?.length) break;
    for (const o of data) {
      if (!o.name || o.metadata?.size == null) continue;
      sizes.set(`${listPath}/${o.name}`, Number(o.metadata.size) || 0);
    }
    offset += data.length;
  }
  return sizes;
}

function mergeDbAndStorageManifest(dbRows, storageRows) {
  const byKey = new Map();
  for (const r of dbRows || []) byKey.set(manifestRowKey(r), r);
  // Only trust the walk to prove absence when it actually returned objects.
  const walked = (storageRows || []).length > 0;
  if (walked) {
    const seen = new Set(storageRows.map((r) => manifestRowKey(r)));
    for (const [key, row] of byKey) byKey.set(key, { ...row, in_storage: seen.has(key) });
  }
  for (const r of storageRows || []) {
    const key = manifestRowKey(r);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r, in_storage: true });
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
    const name = sheetListNameFromRow(r);
    const fp = normalizeFolderPath(r.folder_path) || name.split("/").slice(0, -1).join("/");
    if (fp) m[name] = fp;
  }
  return m;
}

/** The folder-relative path — the one identity shared by Storage, Postgres and
 *  the local cache, so `06 ELECTRICAL/AC LAYOUT.pdf` and `02 ID/AC LAYOUT.pdf`
 *  stay two distinct sheets instead of overwriting each other. */
export function sheetRelPath(fileName, folderPath) {
  const base = String(fileName || "file").replace(/\\/g, "/").split("/").pop() || "file";
  const fp = normalizeFolderPath(folderPath);
  return fp ? `${fp}/${base}` : base;
}

/** Derived from the storage key, so legacy flat rows resolve too. */
export function sheetListNameFromRow(row) {
  const fromKey = String(row.storage_path || "").split("/").slice(1).join("/");
  return fromKey || sheetRelPath(row.file_name, row.folder_path);
}

/** Display label — the sidebar and tabs show the sheet, not its whole path. */
export function sheetBaseName(name) {
  return String(name || "").split("/").pop() || String(name || "");
}

function metaRow(projectId, fileName, path, folderPath, mimeType, byteLength) {
  const mt = mimeType || "application/pdf";
  return {
    project_id: projectId,
    // The relative path, not the basename: the (project_id, file_name) key would
    // otherwise collapse every same-named sheet across folders into one row.
    file_name: sheetRelPath(fileName, folderPath),
    storage_path: path,
    folder_path: normalizeFolderPath(folderPath),
    content_type: mt,
    byte_size: byteLength,
    updated_at: new Date().toISOString(),
  };
}

/** Optional columns differ by migration, and one unknown column fails the whole
 *  statement — so widest first, then drop back until the write lands. Sets without
 *  `updated_at` matter: a trigger-managed column can reject an explicit value. */
const META_COLUMN_SETS = [
  ["folder_path", "content_type", "byte_size", "updated_at"],
  ["folder_path", "content_type", "byte_size"],
  ["folder_path", "mime_type", "byte_size"],
  ["folder_path", "byte_size"],
  ["content_type", "byte_size"],
  ["byte_size"],
  [],
];

function metaPayload(row, columns) {
  const out = {
    project_id: row.project_id,
    file_name: row.file_name,
    storage_path: row.storage_path,
  };
  for (const col of columns) {
    if (col === "mime_type") out.mime_type = row.content_type;
    else if (col === "folder_path") out.folder_path = row.folder_path ?? "";
    else out[col] = row[col];
  }
  return out;
}

/** The conflict target is (project_id, file_name); the same key twice in one
 *  statement makes Postgres abort with "cannot affect row a second time". */
function dedupeByConflictKey(rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(`${row.project_id}\u0000${row.file_name}`, row);
  return [...byKey.values()];
}

function metaErrorText(err) {
  const parts = [err?.message, err?.details, err?.hint, err?.code].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(" · ") : "project_files write failed";
}

async function upsertMetaChunk(chunk) {
  let lastErr = null;
  for (const columns of META_COLUMN_SETS) {
    const { error } = await supabase.from("project_files")
      .upsert(chunk.map((row) => metaPayload(row, columns)), { onConflict: "project_id,file_name" });
    if (!error) return null;
    lastErr = error;
  }
  return lastErr;
}

async function upsertProjectFileMetaBatch(rows) {
  if (!supabase || !rows.length) return;
  const unique = dedupeByConflictKey(rows);
  for (let i = 0; i < unique.length; i += DB_UPSERT_CHUNK) {
    const chunk = unique.slice(i, i + DB_UPSERT_CHUNK);
    const chunkErr = await upsertMetaChunk(chunk);
    if (!chunkErr) continue;
    if (chunk.length === 1) throw new Error(metaErrorText(chunkErr));
    // Retry singly so one rejected row can't strand the rest of the chunk.
    let rowErr = null;
    for (const row of chunk) rowErr = (await upsertMetaChunk([row])) || rowErr;
    if (rowErr) throw new Error(metaErrorText(rowErr));
  }
}

export async function upsertProjectFile(projectId, fileName, bytes, { folderPath = "", mimeType = "application/pdf" } = {}) {
  if (!supabase || !projectId) return;
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const path = storageObjectPath(projectId, fileName, folderPath);
  await withRetry(async () => {
    const { error } = await supabase.storage.from(PLANS_BUCKET).upload(path, body, {
      upsert: true,
      contentType: mimeType || "application/pdf",
    });
    if (error) throw error;
  });
  await upsertProjectFileMetaBatch([
    metaRow(projectId, fileName, path, folderPath, mimeType, body.byteLength),
  ]);
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

/** @param {string} sheetName folder-relative path, as listSheets reports it */
export async function deleteProjectFile(projectId, sheetName) {
  if (!supabase || !projectId) return;
  const rel = String(sheetName || "").replace(/^\/+/, "");
  // Match on the storage key so a same-named sheet in another folder is untouched;
  // the flat key covers rows written before paths carried their folder.
  const paths = [...new Set([`${projectId}/${rel}`, storageObjectPath(projectId, rel)])];
  await supabase.storage.from(PLANS_BUCKET).remove(paths);
  const { error } = await supabase.from("project_files").delete()
    .eq("project_id", projectId).in("storage_path", paths);
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

/** Two pools at once, split on transfer size: the wide lane keeps small plans
 *  flowing at full rate while the narrow lane moves the heavy ones without them
 *  fighting each other for the same upstream. */
async function runSizeAwarePool(items, sizeOf, worker) {
  if (!items.length) return;
  const small = [];
  const large = [];
  for (const item of items) (Number(sizeOf(item)) >= SMALL_FILE_BYTES ? large : small).push(item);
  await Promise.all([
    runPool(small, worker, SMALL_LANE_CONCURRENCY),
    runPool(large, worker, LARGE_LANE_CONCURRENCY),
  ]);
}

/** Download missing plan bytes into the scoped local IndexedDB cache (parallel, large-set safe).
 *  @param {{ priority?: string[] }} [opts] Sheet names to fetch first — the plans already
 *  on screen shouldn't queue behind a thousand the user may never open. */
export async function hydrateLocalPlansFromDb(projectId, localStore, { onProgress, rows: prefetchedRows, priority } = {}) {
  const rows = prefetchedRows || await listProjectFiles(projectId);
  if (!rows.length) return { rows, fileFolders: {} };

  const localSheets = await localStore.listSheets();
  const have = new Set(localSheets.map((s) => s.name));
  // in_storage === false means the walk proved there are no bytes — don't chase it.
  const missing = rows.filter((r) => !have.has(sheetListNameFromRow(r)) && r.in_storage !== false);
  const wanted = new Set(priority || []);
  if (wanted.size) {
    missing.sort((a, b) =>
      Number(wanted.has(sheetListNameFromRow(b))) - Number(wanted.has(sheetListNameFromRow(a))));
  }
  let done = 0;
  const total = missing.length;
  let lastTick = 0;

  await runSizeAwarePool(missing, (row) => row.byte_size, async (row) => {
    const sheetName = sheetListNameFromRow(row);
    try {
      const bytes = await downloadProjectFile(projectId, row.file_name, row.storage_path, row.folder_path);
      const file = new File([bytes], sheetBaseName(sheetName), { type: row.content_type || "application/pdf" });
      await localStore.addPdf(file, { key: sheetName });
    } catch (e) {
      console.warn(`[ADICC] skip cloud plan "${sheetName}"`, e?.message || e);
    }
    done += 1;
    if (onProgress && (done === total || done - lastTick >= PROGRESS_TICK)) {
      lastTick = done;
      onProgress(`Syncing plans from database (${done}/${total})…`);
    }
  });

  return { rows, fileFolders: fileFoldersFromProjectFiles(rows) };
}

/** Fire-and-forget hydration — project opens immediately; bytes fill cache in the background. */
export function hydrateLocalPlansFromDbBackground(projectId, localStore, opts = {}) {
  return hydrateLocalPlansFromDb(projectId, localStore, opts).catch((e) => {
    console.warn("[ADICC] background plan hydrate", e);
  });
}

/** Upload many files after local ingest (Storage parallel + batched Postgres metadata).
 *  Per-file isolation: one rejected object can't strand the other 1000. Re-running
 *  the same folder skips objects already stored at the same size, so it gap-fills. */
export async function uploadProjectFilesBatch(projectId, files, { folderFor, onProgress } = {}) {
  const total = files.length;
  if (!total) return;

  const folderOf = (file) => normalizeFolderPath(typeof folderFor === "function" ? folderFor(file) : "");

  // Resume scan: only the folders this batch touches, listed in parallel.
  const storedSizes = new Map();
  if (total >= PRESCAN_MIN_FILES) {
    onProgress?.("Checking what's already saved…");
    const folders = [...new Set(files.map(folderOf))];
    await runPool(folders, async (fp) => {
      try {
        for (const [path, size] of await listFolderObjectSizes(projectId, fp)) {
          storedSizes.set(path, size);
        }
      } catch (e) {
        console.warn("[ADICC] resume scan", fp, e?.message || e);
      }
    }, STORAGE_WALK_CONCURRENCY);
  }

  const pendingMeta = [];
  const failed = [];
  let dbError = "";
  let done = 0;
  let lastTick = 0;
  let lastFlushAt = Date.now();
  // One repaint per percent: on 1000+ files a tick every couple of files spends the
  // main thread re-rendering instead of feeding the connection.
  const tickEvery = Math.max(2, Math.floor(total / 100));

  const flushMeta = async () => {
    if (!pendingMeta.length) return;
    const chunk = pendingMeta.splice(0, pendingMeta.length);
    lastFlushAt = Date.now();
    try {
      await withRetry(() => upsertProjectFileMetaBatch(chunk));
    } catch (e) {
      dbError = dbError || (e?.message || String(e));
      for (const row of chunk) failed.push(row.file_name);
      console.warn("[ADICC] project_files upsert", e?.message || e);
    }
  };

  try {
    await runSizeAwarePool(files, (file) => file.size, async (file) => {
      const folderPath = folderOf(file);
      const path = storageObjectPath(projectId, file.name, folderPath);
      const mime = file.type || "application/pdf";
      try {
        const byteLength = file.size;
        if (!(byteLength > 0 && storedSizes.get(path) === byteLength)) {
          await withRetry(async () => {
            // The File itself, not an ArrayBuffer: the browser streams it off disk, so a
            // 40 MB plan never has to be copied into the JS heap before its first byte ships.
            const { error } = await supabase.storage.from(PLANS_BUCKET).upload(path, file, {
              upsert: true,
              contentType: mime,
            });
            if (error) throw error;
          });
        }
        pendingMeta.push(metaRow(projectId, file.name, path, folderPath, mime, byteLength));
        if (pendingMeta.length >= META_FLUSH_EVERY || Date.now() - lastFlushAt >= META_FLUSH_MS) {
          await flushMeta();
        }
      } catch (e) {
        failed.push(file.name);
        console.warn(`[ADICC] upload failed "${file.name}"`, e?.message || e);
      }
      done += 1;
      if (onProgress && (done === total || done - lastTick >= tickEvery)) {
        lastTick = done;
        onProgress(`Saving to database (${done}/${total})…`);
      }
    });
  } finally {
    await flushMeta();
  }

  if (failed.length) {
    throw new Error(dbError
      ? `${failed.length} of ${total} files reached storage but not the database — ${dbError}`
      : `${failed.length} of ${total} files didn't save (first: ${failed[0]}). Upload the folder again to finish the rest.`);
  }
}
