// Floating PDF source viewer — opens a schedule/detail sheet region in a
// draggable, scrollable window so the user can verify the hover fields
// against the original drawing without leaving the takeoff canvas.

import React, { useEffect, useRef, useState } from "react";
import { RENDER_SCALE, parseSheetKey } from "../lib/sheets";

/**
 * @param {{
 *   sheetId: string,
 *   title?: string,
 *   bbox?: { x: number, y: number, w: number, h: number } | null,
 *   getDoc: (file: string) => Promise<any>,
 *   onClose: () => void,
 * }} props
 */
export default function SymbolSourceViewer({ sheetId, title, bbox, getDoc, onClose }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const [pos, setPos] = useState({ left: 72, top: 72 });
  const [status, setStatus] = useState("loading");
  const [err, setErr] = useState("");
  const [zoom, setZoom] = useState(1);
  const [canvasSize, setCanvasSize] = useState(null);
  const prevZoomRef = useRef(1);

  useEffect(() => {
    let cancelled = false;
    let task = null;
    (async () => {
      setStatus("loading");
      setErr("");
      setZoom(1);
      prevZoomRef.current = 1;
      try {
        const { file, page: pn } = parseSheetKey(sheetId);
        const pdf = await getDoc(file);
        if (cancelled) return;
        const pageNum = Math.min(Math.max(1, pn), pdf.numPages || 1);
        const page = await pdf.getPage(pageNum);
        if (cancelled) return;
        // Render a bit denser than base so schedule text stays readable
        const scale = Math.min(RENDER_SCALE * 1.15, 2.4);
        const viewport = page.getViewport({ scale });
        const cv = canvasRef.current;
        if (!cv) return;
        cv.width = Math.ceil(viewport.width);
        cv.height = Math.ceil(viewport.height);
        setCanvasSize({ w: Math.ceil(viewport.width), h: Math.ceil(viewport.height) });
        const ctx = cv.getContext("2d", { alpha: false });
        task = page.render({ canvasContext: ctx, viewport });
        await task.promise;
        if (cancelled) return;
        setStatus("ready");
        // Scroll the highlighted region into view
        const sc = wrapRef.current;
        if (sc && bbox) {
          const sx = (bbox.x / RENDER_SCALE) * scale;
          const sy = (bbox.y / RENDER_SCALE) * scale;
          const sw = (bbox.w / RENDER_SCALE) * scale;
          const sh = (bbox.h / RENDER_SCALE) * scale;
          sc.scrollLeft = Math.max(0, sx - 40);
          sc.scrollTop = Math.max(0, sy - 40);
          // Draw highlight overlay on a second pass
          ctx.save();
          ctx.strokeStyle = "#1f3fc7";
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(sx, sy, Math.max(sw, 24), Math.max(sh, 24));
          ctx.fillStyle = "rgba(31,63,199,.08)";
          ctx.fillRect(sx, sy, Math.max(sw, 24), Math.max(sh, 24));
          ctx.restore();
        }
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setErr(String(e?.message || e));
        }
      }
    })();
    return () => {
      cancelled = true;
      try { task?.cancel(); } catch { /* done */ }
    };
  }, [sheetId, bbox, getDoc]);

  useEffect(() => {
    const sc = wrapRef.current;
    if (!sc || !canvasSize || prevZoomRef.current === zoom) return;
    const ratio = zoom / prevZoomRef.current;
    sc.scrollLeft = sc.scrollLeft * ratio + (sc.clientWidth * (ratio - 1)) / 2;
    sc.scrollTop = sc.scrollTop * ratio + (sc.clientHeight * (ratio - 1)) / 2;
    prevZoomRef.current = zoom;
  }, [zoom, canvasSize]);

  const onHeadDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {
      ox: e.clientX - pos.left,
      oy: e.clientY - pos.top,
    };
    const move = (ev) => {
      if (!dragRef.current) return;
      setPos({
        left: Math.max(8, ev.clientX - dragRef.current.ox),
        top: Math.max(8, ev.clientY - dragRef.current.oy),
      });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onBodyDown = (e) => {
    if (e.button !== 0) return;
    const sc = wrapRef.current;
    if (!sc) return;
    e.preventDefault();
    const sx = sc.scrollLeft;
    const sy = sc.scrollTop;
    const ox = e.clientX;
    const oy = e.clientY;
    sc.style.cursor = "grabbing";
    const move = (ev) => {
      sc.scrollLeft = sx - (ev.clientX - ox);
      sc.scrollTop = sy - (ev.clientY - oy);
    };
    const up = () => {
      sc.style.cursor = "grab";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = -e.deltaY * 0.0025;
      setZoom((z) => Math.min(4, Math.max(0.25, Number((z + delta).toFixed(2)))));
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Symbol source sheet"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: 80,
        width: "min(720px, calc(100vw - 32px))",
        height: "min(560px, calc(100vh - 48px))",
        display: "flex",
        flexDirection: "column",
        background: "var(--paper-bright)",
        border: "1px solid var(--ink)",
        boxShadow: "0 12px 40px rgba(14,26,46,.28)",
        fontFamily: "var(--f-body)",
        color: "var(--ink)",
      }}
    >
      <div
        onPointerDown={onHeadDown}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          borderBottom: "1px solid var(--ink-faint)",
          cursor: "grab",
          userSelect: "none",
          background: "var(--paper-cream, var(--paper-bright))",
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: "var(--f-display)", fontWeight: 700, fontSize: 13, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title || sheetId}
          </div>
          <div style={{ fontSize: 10.5, color: "var(--ink-muted)", marginTop: 1 }}>
            Source sheet · drag to move · scroll or zoom to explore
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginRight: 6 }}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setZoom((z) => Math.max(0.25, Number((z - 0.25).toFixed(2)))); }}
            title="Zoom Out (−)"
            style={{ border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", color: "var(--ink)", fontSize: 13, fontWeight: 700, width: 24, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0 }}
          >
            −
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setZoom(1); }}
            title="Reset Zoom (100%)"
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 11, fontFamily: "var(--f-mono)", fontWeight: 600, color: "var(--ink)", minWidth: 42, textAlign: "center", padding: "2px 4px", userSelect: "none" }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2)))); }}
            title="Zoom In (+)"
            style={{ border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", color: "var(--ink)", fontSize: 13, fontWeight: 700, width: 24, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0 }}
          >
            +
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          style={{ border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", color: "var(--ink)", fontSize: 14, lineHeight: 1, padding: "4px 8px" }}
        >
          ×
        </button>
      </div>
      <div
        ref={wrapRef}
        onPointerDown={onBodyDown}
        onWheel={onWheel}
        style={{ flex: 1, overflow: "auto", background: "#e8e4dc", position: "relative", cursor: "grab" }}
      >
        {status === "loading" && (
          <div style={{ padding: 24, fontSize: 12, color: "var(--ink-muted)" }}>Loading sheet…</div>
        )}
        {status === "error" && (
          <div style={{ padding: 24, fontSize: 12, color: "var(--c-danger)" }}>Couldn’t open sheet — {err}</div>
        )}
        <canvas
          ref={canvasRef}
          style={{
            display: "block",
            margin: 12,
            boxShadow: "0 2px 12px rgba(0,0,0,.18)",
            width: canvasSize ? `${canvasSize.w * zoom}px` : undefined,
            height: canvasSize ? `${canvasSize.h * zoom}px` : undefined,
            transformOrigin: "0 0",
          }}
        />
      </div>
    </div>
  );
}
