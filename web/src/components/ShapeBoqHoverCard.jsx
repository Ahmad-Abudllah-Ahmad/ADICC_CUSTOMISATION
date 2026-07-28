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
  onClose,
  onPointerEnter,
  onPointerLeave,
}) {
  if (!data) return null;
  const aU = areaUnit(units);
  const lU = lenUnit(units);

  return (
    <div
      style={{
        position: "absolute", left, top, zIndex: 12, width: 248,
        background: "var(--paper-bright)", border: pinned ? "2px solid var(--cobalt)" : "1px solid var(--ink)",
        boxShadow: "var(--shadow-2)", pointerEvents: "auto", fontFamily: "var(--f-body)",
        fontSize: 12, color: "var(--ink)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px 6px", borderBottom: "1px solid var(--ink-faint)" }}>
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
      </div>
      {data.schedule_refs?.length > 0 && (
        <div style={{ padding: "6px 12px 4px", borderTop: "1px solid var(--ink-faint)", maxHeight: 120, overflowY: "auto" }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)", marginBottom: 4 }}>
            From schedules · {data.schedule_refs.length}
          </div>
          {data.schedule_refs.slice(0, 2).map((ref) => (
            <div key={`${ref.tag}-${ref.source}`} style={{ fontSize: 10.5, lineHeight: 1.35, marginBottom: 4 }}>
              <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, color: "var(--cobalt)" }}>{ref.tag}</span>
              {ref.description ? (
                <span style={{ color: "var(--ink-muted)" }}> — {ref.description.length > 48 ? `${ref.description.slice(0, 48)}…` : ref.description}</span>
              ) : null}
              <div style={{ fontSize: 9.5, color: "var(--ink-faint)" }}>{ref.source}</div>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpenBoq?.(); }}
        style={{
          display: "block", width: "100%", padding: "8px 12px", border: "none",
          borderTop: "1px solid var(--ink-faint)", background: pinned ? "var(--paper-cream)" : "transparent",
          fontSize: 10.5, color: "var(--cobalt)", fontWeight: 600, textAlign: "center",
          cursor: "pointer", fontFamily: "inherit",
        }}
      >
        Open in BOQ →
      </button>
    </div>
  );
}
