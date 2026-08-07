// Hover card — BOQ summary for a masked area; double-click mask to pin, then open BOQ.
import React from "react";
import { areaUnit, lenUnit } from "../lib/units";

const num = (v, d = 2) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });
const dash = "—";

function BoqField({ label, value, mono = true }) {
  const empty = value == null || value === "" || value === 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "52px 1fr", gap: 6, alignItems: "baseline" }}>
      <span style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ fontFamily: mono ? "var(--f-mono)" : "inherit", fontSize: 11.5, color: empty ? "var(--ink-faint)" : "var(--ink)", fontWeight: empty ? 400 : 600 }}>
        {empty ? dash : value}
      </span>
    </div>
  );
}

export default function ShapeBoqHoverCard({
  data,
  left,
  top,
  units = "imperial",
  pinned = false,
  onOpenBoq,
  onOpenDoorDetect,
  onMove,
  onClose,
  onPointerEnter,
  onPointerLeave,
}) {
  if (!data) return null;
  const aU = areaUnit(units);
  const lU = lenUnit(units);
  const doorRefs = (data.schedule_refs || []).filter(
    (r) => (r.kind === "door" || r.kind === "window") && r.symbol_id,
  );

  return (
    <div
      data-hover-scroll
      style={{
        position: "absolute", left, top, zIndex: 12, width: 248,
        maxHeight: pinned ? "min(420px, calc(100vh - 120px))" : undefined,
        overflowY: pinned ? "auto" : undefined,
        overscrollBehavior: "contain",
        background: "var(--paper-bright)", border: pinned ? "2px solid var(--cobalt)" : "1px solid var(--ink)",
        boxShadow: "var(--shadow-2)", pointerEvents: "auto", fontFamily: "var(--f-body)",
        fontSize: 12, color: "var(--ink)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div
        title="Drag to move"
        style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px 6px", borderBottom: "1px solid var(--ink-faint)", cursor: "grab", userSelect: "none" }}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target.closest("button")) return;
          e.preventDefault();
          e.stopPropagation();
          const ox = e.clientX - left;
          const oy = e.clientY - top;
          const move = (ev) => {
            onMove?.(ev.clientX - ox, ev.clientY - oy);
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--cobalt)", marginBottom: 4 }}>
            BOQ · Mask{pinned ? " · Pinned" : ""}
          </div>
          {data.room ? (
            <div style={{ fontFamily: "var(--f-display)", fontWeight: 700, fontSize: 14, lineHeight: 1.25, marginBottom: 2 }}>{data.room}</div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-muted)", fontStyle: "italic", marginBottom: 2 }}>Room not detected</div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: data.color, flexShrink: 0 }} />
            <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: 12, letterSpacing: "0.04em" }}>{data.finish_tag || dash}</span>
          </div>
        </div>
        {pinned ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); onClose?.(); }} title="Close"
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-muted)", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
        ) : (
          <span style={{ fontSize: 10, color: "var(--ink-muted)", whiteSpace: "nowrap" }}>dbl-click to pin</span>
        )}
      </div>
      <div style={{ padding: "8px 12px", display: "grid", gap: 5 }}>
        <BoqField label="Floor" value={data.floor_sf ? `${num(data.floor_sf)} ${aU}` : null} />
        <BoqField label="Wall" value={data.wall_sf ? `${num(data.wall_sf)} ${aU}` : null} />
        <BoqField label="LF" value={data.lf ? `${num(data.lf)} ${lU}` : null} />
        <BoqField label="EA" value={data.ea ? num(data.ea, 0) : null} />
        <BoqField label="Qty" value={`${num(data.qty)} ${data.unit}`} />
        {data.rate != null && data.rate > 0 && (
          <BoqField label="Rate" value={`${num(data.rate)} ${data.currency || "AED"}`} />
        )}
        {data.amount != null && data.amount > 0 && (
          <BoqField label="Amount" value={`${num(data.amount)} ${data.currency || "AED"}`} />
        )}
        {data.priced_from && (
          <div style={{ fontSize: 9.5, color: "var(--ink-muted)", fontStyle: "italic" }}>{data.priced_from}</div>
        )}
      </div>
      {doorRefs.length > 0 && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)", display: "grid", gap: 6 }}>
          {doorRefs.slice(0, 4).map((ref) => (
            <button
              key={ref.symbol_id || `${ref.tag}-${ref.source}`}
              type="button"
              title={`Open ${ref.tag} details`}
              onClick={(e) => { e.stopPropagation(); onOpenDoorDetect?.(ref); }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: "100%", padding: "7px 10px",
                border: "1px solid var(--cobalt)", borderRadius: 6,
                background: "var(--cobalt)", color: "var(--accent-contrast, #fff)",
                cursor: "pointer", fontWeight: 600, fontSize: 11.5, fontFamily: "inherit",
              }}
            >
              {ref.kind === "window" ? "Window detect" : "Door detect"}
              <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, opacity: 0.9 }}>· {ref.tag}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpenBoq?.(); }}
        style={{
          display: "block", width: "100%", padding: "8px 12px", border: "none",
          borderTop: "1px solid var(--ink-faint)", background: pinned ? "var(--paper-cream)" : "transparent",
          fontSize: 10.5, color: "var(--ink)", fontWeight: 600, textAlign: "center",
          cursor: "pointer", fontFamily: "inherit",
        }}
      >
        Open in BOQ →
      </button>
    </div>
  );
}
