// Floating, draggable, resizable shell for docked side panels (Rates / Estimate / BOQ).
// Panels keep their own chrome; drag from [data-float-drag], resize from edge handles.
import React, { useCallback, useEffect, useRef, useState } from "react";

const HANDLES = [
  { key: "n", cursor: "ns-resize", style: { top: 0, left: 8, right: 8, height: 6 } },
  { key: "s", cursor: "ns-resize", style: { bottom: 0, left: 8, right: 8, height: 6 } },
  { key: "e", cursor: "ew-resize", style: { top: 8, right: 0, bottom: 8, width: 6 } },
  { key: "w", cursor: "ew-resize", style: { top: 8, left: 0, bottom: 8, width: 6 } },
  { key: "ne", cursor: "nesw-resize", style: { top: 0, right: 0, width: 10, height: 10 } },
  { key: "nw", cursor: "nwse-resize", style: { top: 0, left: 0, width: 10, height: 10 } },
  { key: "se", cursor: "nwse-resize", style: { bottom: 0, right: 0, width: 12, height: 12 } },
  { key: "sw", cursor: "nesw-resize", style: { bottom: 0, left: 0, width: 10, height: 10 } },
];

let floatZ = 60;

function clampRect(r, minW, minH) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.min(Math.max(minW, r.w), vw - 16);
  const h = Math.min(Math.max(minH, r.h), vh - 16);
  const x = Math.min(Math.max(8 - w + 48, r.x), vw - 48);
  const y = Math.min(Math.max(8, r.y), vh - 40);
  return { x, y, w, h };
}

/**
 * @param {{
 *   children: React.ReactNode,
 *   defaultRect: { x: number, y: number, w: number, h: number },
 *   minW?: number,
 *   minH?: number,
 * }} props
 */
export default function FloatingWindow({
  children,
  defaultRect,
  minW = 320,
  minH = 240,
  shellClassName = "",
}) {
  const [rect, setRect] = useState(() => clampRect(defaultRect, minW, minH));
  const [z, setZ] = useState(() => { floatZ += 1; return floatZ; });
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const minRef = useRef({ minW, minH });
  minRef.current = { minW, minH };

  const bringFront = useCallback(() => {
    floatZ += 1;
    setZ(floatZ);
  }, []);

  useEffect(() => {
    const onResize = () => setRect((r) => clampRect(r, minRef.current.minW, minRef.current.minH));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const beginSession = (session) => {
    const move = (ev) => {
      const { minW: mw, minH: mh } = minRef.current;
      if (session.mode === "drag") {
        setRect(clampRect({
          x: ev.clientX - session.ox,
          y: ev.clientY - session.oy,
          w: session.w,
          h: session.h,
        }, mw, mh));
        return;
      }
      const dx = ev.clientX - session.sx;
      const dy = ev.clientY - session.sy;
      let { x, y, w, h } = session;
      const edge = session.mode;
      if (edge.includes("e")) w = session.w + dx;
      if (edge.includes("s")) h = session.h + dy;
      if (edge.includes("w")) { x = session.x + dx; w = session.w - dx; }
      if (edge.includes("n")) { y = session.y + dy; h = session.h - dy; }
      setRect(clampRect({ x, y, w, h }, mw, mh));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onShellDown = (e) => {
    e.stopPropagation();
    bringFront();
    if (e.button !== 0) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("button, a, input, select, textarea, label, [data-float-no-drag]")) return;
    if (!t.closest("[data-float-drag]")) return;
    e.preventDefault();
    const r = rectRef.current;
    beginSession({
      mode: "drag",
      ox: e.clientX - r.x,
      oy: e.clientY - r.y,
      w: r.w,
      h: r.h,
    });
  };

  const startResize = (edge) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    bringFront();
    const r = rectRef.current;
    beginSession({
      mode: edge,
      sx: e.clientX,
      sy: e.clientY,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
    });
  };

  return (
    <div
      role="dialog"
      className={shellClassName || undefined}
      onPointerDown={onShellDown}
      style={{
        position: "fixed",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex: z,
        display: "flex",
        flexDirection: "column",
        background: "var(--paper-bright)",
        border: "1px solid var(--ink-faint)",
        borderRadius: 10,
        boxShadow: "0 14px 40px rgba(14, 26, 46, 0.22)",
        overflow: "hidden",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {children}
      </div>
      {HANDLES.map((h) => (
        <div
          key={h.key}
          onPointerDown={startResize(h.key)}
          style={{
            position: "absolute",
            ...h.style,
            cursor: h.cursor,
            zIndex: 2,
            touchAction: "none",
          }}
        />
      ))}
    </div>
  );
}
