// File ingest — turn anything a contractor drops (a plan PDF, a scan or
// screenshot image, or a .zip plan set straight off a bid platform) into the
// PDF "sheets" the canvas already knows how to render.
//
// Everything happens in the browser: zips are unpacked and images are wrapped
// into a one-page PDF locally — nothing is uploaded. Because every input becomes
// a PDF, the rest of the app (sheets, scale, One-Click, render) is unchanged.
//
//   ingestFiles(fileList, { onProgress }) -> { pdfs: File[], skipped: [{name, reason}] }
//
// The returned File objects are all application/pdf, ready for store.addPdf().
// fflate (unzip) and pdf-lib (image→PDF) are loaded on demand — only when a user
// actually drops a zip or image — so they never weigh down the initial page load.

const PDF_EXT = /\.pdf$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const ZIP_EXT = /\.zip$/i;
const DWG_EXT = /\.dwg$/i;

// Guardrails against hostile archives
// Everything here runs in the user's browser tab, so an unbounded archive is a
// local denial-of-service — a wedged or OOM-killed tab. Three caps bound one
// ingest: recursion depth into nested zips, total decompressed bytes, and total
// entries expanded. The entry cap catches what the byte cap can't — an archive
// of millions of tiny or zero-byte files drains no byte budget but still wedges
// the tab on sheer iteration. Past any limit an entry is reported as skipped.
// All three are overridable via ingestFiles opts so the caps are cheap to test.
const MAX_ZIP_DEPTH = 8;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB of decompressed output
const MAX_TOTAL_ENTRIES = 10_000;               // files expanded across one ingest

const isPdf = (name, type = "") => PDF_EXT.test(name) || type === "application/pdf";
const isImage = (name, type = "") => IMAGE_EXT.test(name) || (type || "").startsWith("image/");
const isZip = (name, type = "") => ZIP_EXT.test(name) || /zip/i.test(type);
const isDwg = (name, type = "") => DWG_EXT.test(name) || type === "image/vnd.dwg" || type === "application/acad" || type === "application/x-acad";

const baseName = (path) => path.split("/").pop() || path;

// DWG files begin with "AC10…" (R2000+) even when the extension is missing/wrong.
async function looksLikeDwg(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 6).arrayBuffer());
    if (head.length < 4) return false;
    const sig = String.fromCharCode(head[0], head[1], head[2], head[3]);
    return sig.startsWith("AC10") || sig.startsWith("AC1");
  } catch { return false; }
}

// macOS / Windows archive cruft and hidden files inside zips
const isJunk = (path) =>
  path.endsWith("/") ||
  /(^|\/)__MACOSX\//.test(path) ||
  /(^|\/)\._/.test(path) ||
  /(^|\/)\.DS_Store$/i.test(path) ||
  /(^|\/)Thumbs\.db$/i.test(path);

// First-bytes sniff so a mislabeled or extension-less zip still works (PK\x03\x04).
async function looksLikeZip(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } catch { return false; }
}

// Decompress only the entries we can use (saves memory on big plan sets); report
// anything else as skipped via onSkip rather than silently dropping it.
//
// `budget` tracks the decompressed bytes AND the entry count still allowed for
// this whole ingest. fflate runs the filter per entry, reading originalSize from
// the zip's CENTRAL DIRECTORY (authoritative even for data-descriptor entries
// whose local header declares 0), and caps each entry's output buffer to that
// declared size. So refusing an entry whose declared size blows the budget is
// what stops a real zip bomb — which must declare its true size to inflate to
// it. A dishonest header that UNDER-declares can't OOM either: fflate clamps the
// output to the declared size, yielding a truncated file, not a runaway alloc.
// The entry-count half covers what bytes can't: an archive of countless tiny or
// zero-byte files, each of which passes the byte check but drowns us in work.
async function unzipBytes(bytes, onSkip, budget) {
  const { unzip } = await import("fflate");
  return new Promise((resolve, reject) => {
    unzip(bytes, {
      filter: (f) => {
        if (isJunk(f.name)) return false;
        const bn = baseName(f.name);
        if (!(isPdf(bn) || isImage(bn) || isZip(bn) || isDwg(bn))) { onSkip?.(bn, "unsupported type"); return false; }
        if (budget.entries <= 0) { onSkip?.(bn, "too many files"); return false; }
        const size = f.originalSize || 0;
        if (size > budget.bytes) { onSkip?.(bn, "archive too large"); return false; }
        budget.bytes -= size;
        budget.entries -= 1;
        return true;
      },
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// Wrap a raster image into a single-page PDF at its native pixel size so it flows
// through the same pdf.js path as a real plan. JPG/PNG embed directly; webp/gif/
// bmp are decoded by the browser and re-encoded as PNG.
async function imageToPdf(file) {
  const { PDFDocument } = await import("pdf-lib");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await PDFDocument.create();
  let img, w, h;
  if (/\.jpe?g$/i.test(file.name) || file.type === "image/jpeg") {
    img = await doc.embedJpg(bytes); w = img.width; h = img.height;
  } else if (/\.png$/i.test(file.name) || file.type === "image/png") {
    img = await doc.embedPng(bytes); w = img.width; h = img.height;
  } else {
    const bmp = await createImageBitmap(new Blob([bytes], { type: file.type || "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    img = await doc.embedPng(new Uint8Array(await blob.arrayBuffer())); w = bmp.width; h = bmp.height;
  }
  doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  const name = baseName(file.name).replace(IMAGE_EXT, "") + ".pdf";
  return new File([await doc.save()], name, { type: "application/pdf" });
}

const RENDER_SCALE = 2.0;
const safeFilePart = (s) => String(s).replace(/[\\/:*?"<>|]/g, "-").trim();

/** Drawing titles (or sheet numbers) per 1-based page, when readable. */
async function readSheetLabels(pdfBytes, pageCount, onProgress) {
  const labels = {};
  if (pageCount <= 1) return labels;
  let ocr = null;
  try {
    const pdfjsLib = await import("pdfjs-dist");
    const { extractDrawingTitle, extractSheetNumber, parseDrawingTitleFromOcr } = await import("./sheets.ts");
    const { pdfjsWorkerSrc } = await import("./pdfWorkerSrc.js");
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerSrc();
    const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
    for (let n = 1; n <= pageCount; n++) {
      try {
        onProgress?.(`Reading drawing title (page ${n}/${pageCount})…`);
        const page = await pdf.getPage(n);
        const tc = await page.getTextContent();
        const vp = page.getViewport({ scale: RENDER_SCALE });
        let title = extractDrawingTitle(tc, vp);
        if (!title) {
          try {
            if (!ocr) {
              const { createSheetTitleOcr } = await import("./sheetTitleOcr.js");
              ocr = await createSheetTitleOcr();
            }
            if (ocr) {
              const text = await ocr.readPage(page, vp);
              title = parseDrawingTitleFromOcr(text);
            }
          } catch { /* OCR is best-effort */ }
        }
        if (title) labels[n] = title;
        else {
          const num = extractSheetNumber(tc, vp);
          if (num) labels[n] = num;
        }
      } catch { /* skip unreadable page */ }
    }
    await pdf.destroy?.();
  } catch { /* fall back to numeric page suffixes */ }
  finally {
    try { await ocr?.terminate?.(); } catch { /* ignore */ }
  }
  return labels;
}

/** Multi-page plan PDFs become one file per page, named from the drawing title. */
async function expandPdfPages(file, onProgress) {
  try {
    const { PDFDocument } = await import("pdf-lib");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = src.getPageCount();
    if (pageCount <= 1) return [file];

    const bn = baseName(file.name);
    onProgress?.(`Splitting ${bn} (${pageCount} pages)…`);
    const stem = bn.replace(/\.pdf$/i, "");
    const labels = await readSheetLabels(bytes, pageCount, onProgress);
    const out = [];
    for (let i = 0; i < pageCount; i++) {
      const doc = await PDFDocument.create();
      const [copied] = await doc.copyPages(src, [i]);
      doc.addPage(copied);
      const pageNum = i + 1;
      const title = labels[pageNum];
      const name = title
        ? `${safeFilePart(title)}.pdf`
        : `${stem} - ${pageNum}.pdf`;
      out.push(new File([await doc.save()], name, { type: "application/pdf" }));
    }
    return out;
  } catch {
    return [file];
  }
}

let libredwgPromise = null;
async function getLibreDwg() {
  if (!libredwgPromise) {
    libredwgPromise = (async () => {
      const { LibreDwg } = await import("@mlightcad/libredwg-web");
      const root = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
      return LibreDwg.create(`${root}libredwg/`);
    })().catch((e) => {
      libredwgPromise = null;
      throw e;
    });
  }
  return libredwgPromise;
}

// LibreDWG returns a DIB (no 'BM' header); browsers need a full BMP container to decode it.
function dibToBmp(dib) {
  const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const biSize = view.getUint32(0, true);
  const biBitCount = view.getUint16(14, true);
  const colorTableSize = biBitCount <= 8 ? (4 * (1 << biBitCount)) : 0;
  const pixelOffset = 14 + biSize + colorTableSize;
  const fileSize = 14 + dib.length;
  const header = new Uint8Array(14);
  header[0] = 0x42; header[1] = 0x4D;
  header[2] = fileSize & 0xff; header[3] = (fileSize >> 8) & 0xff;
  header[4] = (fileSize >> 16) & 0xff; header[5] = (fileSize >> 24) & 0xff;
  header[10] = pixelOffset & 0xff; header[11] = (pixelOffset >> 8) & 0xff;
  header[12] = (pixelOffset >> 16) & 0xff; header[13] = (pixelOffset >> 24) & 0xff;
  const out = new Uint8Array(fileSize);
  out.set(header, 0);
  out.set(dib, 14);
  return out;
}

function collectDwgEntities(db) {
  const out = [...(db?.entities || [])];
  if (out.length) return out;
  for (const br of db?.tables?.BLOCK_RECORD?.entries || []) {
    if (br.name === "*Model_Space" && br.entities?.length) return br.entities;
  }
  for (const br of db?.tables?.BLOCK_RECORD?.entries || []) {
    if (br.entities?.length) out.push(...br.entities);
  }
  return out;
}

function dwgEntityBounds(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const e of entities) {
    if (e.isVisible === false) continue;
    switch (e.type) {
      case "LINE":
        add(e.startPoint?.x, e.startPoint?.y); add(e.endPoint?.x, e.endPoint?.y);
        break;
      case "CIRCLE":
      case "ARC":
        add(e.center?.x - e.radius, e.center?.y - e.radius);
        add(e.center?.x + e.radius, e.center?.y + e.radius);
        break;
      case "LWPOLYLINE":
      case "POLYLINE":
        for (const v of e.vertices || []) add(v.x, v.y);
        break;
      case "ELLIPSE":
        add(e.center?.x - (e.majorAxis?.x || 0), e.center?.y - (e.majorAxis?.y || 0));
        add(e.center?.x + (e.majorAxis?.x || 0), e.center?.y + (e.majorAxis?.y || 0));
        break;
      case "SPLINE":
        for (const p of e.controlPoints || e.fitPoints || []) add(p.x, p.y);
        break;
      default:
        break;
    }
  }
  if (!Number.isFinite(minX)) return null;
  const pad = Math.max(maxX - minX, maxY - minY, 1) * 0.05;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

// Minimal vector fallback when libredwg's SVG converter chokes on complex entities.
function entitiesToSvg(db) {
  const entities = collectDwgEntities(db);
  if (!entities.length) return null;
  const b = dwgEntityBounds(entities);
  if (!b) return null;
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const map = (x, y) => `${x - b.minX},${b.maxY - y}`;
  const parts = [];
  for (const e of entities) {
    if (e.isVisible === false) continue;
    const stroke = "#111827";
    switch (e.type) {
      case "LINE":
        if (e.startPoint && e.endPoint) {
          parts.push(`<line x1="${e.startPoint.x - b.minX}" y1="${b.maxY - e.startPoint.y}" x2="${e.endPoint.x - b.minX}" y2="${b.maxY - e.endPoint.y}" stroke="${stroke}" stroke-width="1"/>`);
        }
        break;
      case "CIRCLE":
        if (e.center && e.radius) {
          parts.push(`<circle cx="${e.center.x - b.minX}" cy="${b.maxY - e.center.y}" r="${e.radius}" fill="none" stroke="${stroke}" stroke-width="1"/>`);
        }
        break;
      case "ARC":
        if (e.center && e.radius != null && e.startAngle != null && e.endAngle != null) {
          const cx = e.center.x - b.minX, cy = b.maxY - e.center.y, r = e.radius;
          const x1 = cx + r * Math.cos(e.startAngle), y1 = cy - r * Math.sin(e.startAngle);
          const x2 = cx + r * Math.cos(e.endAngle), y2 = cy - r * Math.sin(e.endAngle);
          let delta = e.endAngle - e.startAngle;
          while (delta <= 0) delta += Math.PI * 2;
          const large = delta > Math.PI ? 1 : 0;
          parts.push(`<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 0 ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="1"/>`);
        }
        break;
      case "LWPOLYLINE":
      case "POLYLINE": {
        const verts = e.vertices || [];
        if (verts.length >= 2) {
          const d = verts.map((v, i) => `${i ? "L" : "M"} ${map(v.x, v.y)}`).join(" ");
          parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1"/>`);
        }
        break;
      }
      default:
        break;
    }
  }
  if (!parts.length) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`;
}

async function svgStringToPdf(svg, outName) {
  const { PDFDocument } = await import("pdf-lib");
  let w = 2400, h = 1800;
  const vb = svg.match(/viewBox=["']([^"']+)["']/);
  if (vb) {
    const p = vb[1].trim().split(/[\s,]+/).map(Number);
    if (p.length >= 4 && p[2] > 0 && p[3] > 0) { w = p[2]; h = p[3]; }
  } else {
    const wm = svg.match(/\bwidth=["']([\d.]+)/), hm = svg.match(/\bheight=["']([\d.]+)/);
    if (wm) w = parseFloat(wm[1]);
    if (hm) h = parseFloat(hm[1]);
  }
  const maxPx = 8192;
  const scale = Math.min(1, maxPx / Math.max(w, h));
  const cw = Math.max(1, Math.ceil(w * scale)), ch = Math.max(1, Math.ceil(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    ctx.drawImage(img, 0, 0, cw, ch);
  } finally {
    URL.revokeObjectURL(url);
  }
  const pngBlob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!pngBlob) throw new Error("Could not rasterize the drawing");
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const doc = await PDFDocument.create();
  const embedded = await doc.embedPng(pngBytes);
  doc.addPage([w, h]).drawImage(embedded, { x: 0, y: 0, width: w, height: h });
  const base = baseName(outName);
  const pdfName = PDF_EXT.test(base) ? base : `${base.replace(DWG_EXT, "")}.pdf`;
  return new File([await doc.save()], pdfName, { type: "application/pdf" });
}

async function thumbToPdf(thumb, outName) {
  if (!thumb?.data?.length) return null;
  // DwgThumbnailImageType: BMP=2, WMF=3, PNG=6
  let wrapped;
  if (thumb.type === 6) wrapped = await imageToPdf(new File([thumb.data], "preview.png", { type: "image/png" }));
  else wrapped = await imageToPdf(new File([dibToBmp(thumb.data)], "preview.bmp", { type: "image/bmp" }));
  return new File([await wrapped.arrayBuffer()], outName, { type: "application/pdf" });
}

// AutoCAD DWG → SVG (LibreDWG/wasm) → raster PDF so the existing pdf.js canvas path opens it.
// SVG conversion can throw on complex entities (tables, multileaders, etc.); fall back to the
// embedded DWG preview bitmap when available.
async function dwgToPdf(file) {
  const { Dwg_File_Type } = await import("@mlightcad/libredwg-web");
  const libredwg = await getLibreDwg();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dwgPtr = libredwg.dwg_read_data(bytes, Dwg_File_Type.DWG);
  if (!dwgPtr) throw new Error("Could not read this DWG file");
  const outName = baseName(file.name).replace(DWG_EXT, "") + ".pdf";
  try {
    const db = libredwg.convert(dwgPtr);
    let svg = null;
    try { svg = libredwg.dwg_to_svg(db); } catch { /* fall through to preview bitmap */ }
    if (svg && svg.length > 80) return svgStringToPdf(svg, outName);
    svg = entitiesToSvg(db);
    if (svg && svg.length > 80) return svgStringToPdf(svg, outName);
    const thumbPdf = await thumbToPdf(libredwg.dwg_bmp(dwgPtr), outName);
    if (thumbPdf) return thumbPdf;
    throw new Error("Drawing is empty or uses unsupported entities");
  } finally {
    libredwg.dwg_free(dwgPtr);
  }
}

export async function ingestFiles(
  fileList,
  {
    onProgress,
    maxZipDepth = MAX_ZIP_DEPTH,
    maxTotalBytes = MAX_TOTAL_BYTES,
    maxTotalEntries = MAX_TOTAL_ENTRIES,
  } = {},
) {
  const incoming = Array.from(fileList || []);
  const pdfs = [];
  const skipped = [];
  const used = new Set();
  // Shared across every (possibly nested) archive in this ingest, so a bomb
  // split over many entries or sibling zips still hits one combined ceiling.
  const budget = { bytes: maxTotalBytes, entries: maxTotalEntries };

  // store keys by name; de-dupe within the batch so two "A1.pdf" from different
  // zip folders don't overwrite each other
  const uniqueName = (name) => {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = name, i = 2;
    while (used.has(n.toLowerCase())) n = `${stem} (${i++})${ext}`;
    used.add(n.toLowerCase());
    return n;
  };
  const pushPdf = (file) => {
    const name = uniqueName(file.name);
    pdfs.push(name === file.name ? file : new File([file], name, { type: "application/pdf" }));
  };
  const pushPdfFile = async (file) => {
    const expanded = await expandPdfPages(file, onProgress);
    for (const p of expanded) pushPdf(p);
  };

  async function process(file, depth) {
    const name = file.name || "file";
    try {
      if (isPdf(name, file.type)) { await pushPdfFile(file); return; }
      if (isDwg(name, file.type) || (await looksLikeDwg(file))) { onProgress?.(`Converting ${baseName(name)}…`); pushPdf(await dwgToPdf(file)); return; }
      if (isImage(name, file.type)) { onProgress?.(`Converting ${baseName(name)}…`); pushPdf(await imageToPdf(file)); return; }
      if (isZip(name, file.type) || (await looksLikeZip(file))) {
        // Stop runaway recursion from self-nesting archives before we even read
        // the bytes — a zip that contains itself would otherwise loop forever.
        if (depth >= maxZipDepth) { skipped.push({ name: baseName(name), reason: "nested too deep" }); return; }
        onProgress?.(`Unzipping ${baseName(name)}…`);
        const entries = await unzipBytes(new Uint8Array(await file.arrayBuffer()),
          (bn, reason) => skipped.push({ name: bn, reason }), budget);
        const paths = Object.keys(entries);
        if (!paths.length) { skipped.push({ name: baseName(name), reason: "no plans found in zip" }); return; }
        for (const path of paths) {
          const bn = baseName(path);
          if (isPdf(bn)) await pushPdfFile(new File([entries[path]], bn, { type: "application/pdf" }));
          else if (isDwg(bn)) { onProgress?.(`Converting ${bn}…`); pushPdf(await dwgToPdf(new File([entries[path]], bn))); }
          else if (isImage(bn)) { onProgress?.(`Converting ${bn}…`); pushPdf(await imageToPdf(new File([entries[path]], bn))); }
          else if (isZip(bn)) await process(new File([entries[path]], bn, { type: "application/zip" }), depth + 1);
        }
        return;
      }
      skipped.push({ name: baseName(name), reason: "unsupported type" });
    } catch (e) {
      skipped.push({ name: baseName(name), reason: (e && e.message) || "couldn't read" });
    }
  }

  const yieldToUi = () => new Promise((resolve) => {
    if (typeof globalThis.scheduler?.yield === "function") {
      globalThis.scheduler.yield().then(resolve, () => setTimeout(resolve, 0));
      return;
    }
    setTimeout(resolve, 0);
  });
  for (let i = 0; i < incoming.length; i++) {
    await process(incoming[i], 0);
    if (incoming.length > 100 && i % 16 === 15) await yieldToUi();
    else if (incoming.length > 12 && i % 4 === 3) await yieldToUi();
  }
  return { pdfs, skipped };
}
