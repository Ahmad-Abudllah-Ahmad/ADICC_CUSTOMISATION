// Per-segment height editor — shared by Condition popup and Live readout bar.
import React from "react";
import { Icon } from "../brand/icons.jsx";
import { lenVal, lenUnit } from "../lib/units";

export default function WallSegmentHeightsEditor({
  rows = [],
  units = "imperial",
  condH = 0,
  compact = false,
  activeIndex = null,
  onSetHeight,
  onFlyToSegment,
  onClearAll,
}) {
  if (!rows.length) return null;
  const num = (v, d = 2) => v.toLocaleString(undefined, { maximumFractionDigits: d });
  const fl = (lf) => `${num(lenVal(lf, units), 2)} ${lenUnit(units)}`;

  const list = (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: compact ? 3 : 5,
      ...(rows.length > 5 ? {
        maxHeight: compact ? 168 : 200,
        overflowY: "auto",
        overflowX: "hidden",
      } : {}),
    }}>
      {rows.map((row) => {
        const isActive = activeIndex === row.index;
        return (
          <div
            key={row.index}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: compact ? "2px 0" : "4px 0",
              borderBottom: compact ? "none" : "1px solid var(--ink-faint)",
            }}
          >
            <button
              type="button"
              onClick={() => onFlyToSegment?.(row.index)}
              title={`Go to ${row.label} on the plan`}
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                background: "none",
                cursor: "pointer",
                padding: 0,
                textAlign: "left",
                fontSize: compact ? 11 : 11.5,
                fontWeight: isActive ? 700 : 600,
                color: isActive ? "var(--cobalt)" : "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.label} · {fl(row.lf)}
            </button>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              <Icon name="height" size={compact ? 11 : 12} />
              <input
                name={`wall-seg-h-${row.index}`}
                type="number"
                min="0"
                step="0.25"
                value={row.height_ft ?? ""}
                onChange={(e) => onSetHeight?.(row.index, e.target.value)}
                title={`Height for ${row.label}`}
                style={{
                  width: compact ? 58 : 48,
                  minWidth: compact ? 58 : 48,
                  padding: compact ? "4px 8px" : "2px 4px",
                  border: `1px solid ${isActive ? "var(--cobalt)" : "var(--ink-faint)"}`,
                  fontSize: 12,
                  fontFamily: "var(--f-mono)",
                  boxSizing: "border-box",
                }}
              />
            </span>
          </div>
        );
      })}
    </div>
  );

  if (compact) return list;

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--ink-faint)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--ink-muted)" }}>
          Wall line heights
        </span>
        {condH > 0 && onClearAll && (
          <button type="button" onClick={onClearAll} title="Reset all segments to the condition height"
            style={{ border: "none", background: "none", cursor: "pointer", fontSize: 10, color: "var(--ink-muted)", padding: 0 }}>
            ↺ all
          </button>
        )}
      </div>
      {list}
    </div>
  );
}
