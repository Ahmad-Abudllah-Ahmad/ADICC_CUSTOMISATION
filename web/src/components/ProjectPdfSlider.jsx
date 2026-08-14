// Auto-scrolling sheet preview strip for a Supabase project on the home list.
// Renders the first page of each plan (PDF/image) and slides them continuously.
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_SHEETS = 12;
const THUMB_WIDTH = 200;
const THUMB_HEIGHT = 170;
const SCROLL_PX_PER_SEC = 36;

function isImageName(name, contentType) {
  const n = String(name || "").toLowerCase();
  const t = String(contentType || "").toLowerCase();
  return t.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|tif{1,2})$/i.test(n);
}

function isPdfName(name, contentType) {
  const n = String(name || "").toLowerCase();
  const t = String(contentType || "").toLowerCase();
  return t.includes("pdf") || n.endsWith(".pdf");
}

async function bytesToThumbUrl(bytes, fileName, contentType) {
  if (isImageName(fileName, contentType)) {
    const blob = new Blob([bytes], { type: contentType || "image/png" });
    return URL.createObjectURL(blob);
  }
  if (!isPdfName(fileName, contentType)) return null;
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(THUMB_WIDTH / base.width, THUMB_HEIGHT / base.height) * (window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: Math.max(0.2, scale) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.72);
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}

/**
 * @param {{ projectId: string, sheetCount?: number }} props
 */
export default function ProjectPdfSlider({ projectId, sheetCount = 0 }) {
  const [thumbs, setThumbs] = useState([]);
  const [failed, setFailed] = useState(false);
  const trackRef = useRef(null);
  const offsetRef = useRef(0);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  const urlsRef = useRef([]);

  useEffect(() => {
    if (!projectId) return undefined;
    let live = true;
    setFailed(false);
    setThumbs([]);

    (async () => {
      try {
        const { listProjectFiles, downloadProjectFile, sheetListNameFromRow } = await import("../lib/supabase/projectFiles.js");
        const rows = await listProjectFiles(projectId);
        if (!live) return;
        const plans = rows
          .filter((r) => isPdfName(r.file_name, r.content_type) || isImageName(r.file_name, r.content_type))
          .slice(0, MAX_SHEETS);
        if (!plans.length) {
          setFailed(true);
          return;
        }

        const next = [];
        for (const row of plans) {
          if (!live) return;
          try {
            const bytes = await downloadProjectFile(
              projectId,
              row.file_name,
              row.storage_path,
              row.folder_path || ""
            );
            if (!live) return;
            const url = await bytesToThumbUrl(bytes, row.file_name, row.content_type);
            if (!live) return;
            if (url) {
              urlsRef.current.push(url);
              next.push({
                key: sheetListNameFromRow(row) || row.file_name,
                url,
                label: row.file_name,
              });
              setThumbs([...next]);
            }
          } catch {
            /* skip unreadable sheet */
          }
        }
        if (live && !next.length) setFailed(true);
      } catch {
        if (live) setFailed(true);
      }
    })();

    return () => {
      live = false;
      for (const u of urlsRef.current) {
        if (String(u).startsWith("blob:")) URL.revokeObjectURL(u);
      }
      urlsRef.current = [];
    };
  }, [projectId]);

  // Continuous horizontal slide (duplicated track for seamless loop).
  useEffect(() => {
    if (thumbs.length < 2) return undefined;
    const tick = (ts) => {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = Math.min(48, ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      const el = trackRef.current;
      if (el) {
        const half = el.scrollWidth / 2;
        if (half > 0) {
          offsetRef.current = (offsetRef.current + SCROLL_PX_PER_SEC * dt) % half;
          el.style.transform = `translateX(${-offsetRef.current}px)`;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      lastTsRef.current = 0;
      offsetRef.current = 0;
    };
  }, [thumbs.length]);

  const loop = useMemo(() => (thumbs.length ? [...thumbs, ...thumbs] : thumbs), [thumbs]);

  if (failed && !thumbs.length) {
    return (
      <div className="home-project-preview" aria-hidden="true">
        <div className="home-project-preview-msg">
          {sheetCount > 0 ? "Sheet previews unavailable" : "No plan sheets yet"}
        </div>
      </div>
    );
  }

  if (!thumbs.length) {
    return (
      <div className="home-project-preview" aria-busy="true">
        <div className="home-project-preview-msg">Reading sheets…</div>
      </div>
    );
  }

  return (
    <div
      className="home-project-preview"
      onClick={(e) => e.stopPropagation()}
      aria-label="Auto-scrolling plan sheet previews"
    >
      <div ref={trackRef} className="home-project-preview-track">
        {loop.map((t, i) => (
          <div
            key={`${t.key}-${i}`}
            className="home-project-preview-sheet"
            title={t.label}
          >
            <img
              src={t.url}
              alt={t.label}
              draggable={false}
              style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
            />
          </div>
        ))}
      </div>
      <div className="home-project-preview-fade" />
    </div>
  );
}
