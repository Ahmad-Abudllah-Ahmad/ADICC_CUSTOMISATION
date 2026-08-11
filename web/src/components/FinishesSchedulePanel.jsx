// Finishes Schedule — tabular view from parsed A0002-style schedule KB (floating window).
import React, { useMemo } from "react";
import { Icon } from "../brand/icons.jsx";
import { finishesLegendEntries } from "../lib/symbolScheduleKb";

const th = {
  padding: "6px 8px",
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--ink-muted)",
  borderBottom: "1px solid var(--ink)",
  borderRight: "1px solid var(--ink-faint)",
  background: "var(--paper-cream)",
  textAlign: "left",
  verticalAlign: "top",
  whiteSpace: "nowrap",
};

const td = {
  padding: "6px 8px",
  fontSize: 11,
  lineHeight: 1.35,
  borderBottom: "1px solid var(--ink-faint)",
  borderRight: "1px solid var(--ink-faint)",
  verticalAlign: "top",
};

function MarkCell({ tag }) {
  if (!tag) return <td style={{ ...td, fontFamily: "var(--f-mono)", color: "var(--ink-muted)" }}>—</td>;
  return (
    <td style={{ ...td, fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: 10.5, color: "var(--cobalt)", whiteSpace: "nowrap" }}>
      {tag}
    </td>
  );
}

function normRoomKey(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 48);
}

function splitRoomNo(roomName) {
  const m = (roomName || "").match(/^(\d{1,2})\.\s*(.+)$/);
  if (m) return { no: m[1].padStart(2, "0"), name: m[2].trim() };
  return { no: "—", name: (roomName || "").trim() || "—" };
}

/** Prefer room-scoped KB rows, forward-fill floor band from schedule order (source_bbox.y). */
function resolveFinishesRows(scheduleKb) {
  if (!scheduleKb) return [];
  const iter = scheduleKb instanceof Map ? scheduleKb.entries() : Object.entries(scheduleKb || {});
  const best = new Map();
  for (const [rawKey, e] of iter) {
    if (e.kind !== "finish" || !e.room_name?.trim()) continue;
    const rk = `${normRoomKey(e.room_name)}::${e.tag}`;
    const hasFloorKey = String(rawKey).includes("#");
    const prev = best.get(rk);
    const score = (x, keyed) => (keyed ? 4 : 0) + (x.floors?.length || 0) + (x.description?.length || 0) / 200;
    if (!prev || score(e, hasFloorKey) > score(prev, prev._keyed)) {
      best.set(rk, { ...e, _keyed: hasFloorKey });
    }
  }
  const sorted = [...best.values()].sort((a, b) => (a.source_bbox?.y ?? 0) - (b.source_bbox?.y ?? 0));
  let floorCtx = "";
  const mapped = sorted.map((e) => {
    if (e.floors?.trim()) floorCtx = e.floors.trim();
    const { no, name } = splitRoomNo(e.room_name);
    const { _keyed, ...row } = e;
    return { ...row, floorLabel: e.floors?.trim() || floorCtx || "", roomNo: no, spaceName: name };
  });
  const nums = mapped.map((r) => r.roomNo).filter((n) => n !== "—").map((n) => parseInt(n, 10));
  const defaultFloor = mapped.some((r) => r.floorLabel) ? "" : (nums.length && Math.max(...nums) <= 24 ? "GROUND FLOOR" : "Schedule");
  return mapped.map((r) => ({ ...r, floorLabel: r.floorLabel || defaultFloor }));
}

function groupRowsByFloor(rows) {
  const groups = [];
  let cur = null;
  for (const row of rows) {
    const floor = row.floorLabel?.trim() || "Schedule";
    if (!cur || cur.floor !== floor) {
      cur = { floor, rows: [] };
      groups.push(cur);
    }
    cur.rows.push(row);
  }
  return groups;
}

/** A0002-style floor band colours — Ground / Podium / 1st / mid-rise / penthouse. */
function floorBandColors(floor) {
  const up = (floor || "").toUpperCase().replace(/\s+/g, " ");
  if (/\bGROUND\b/.test(up)) {
    return { bg: "#d8f0dc", border: "#2e9b4a", text: "#1a5c2e", rowTint: "#f3faf4" };
  }
  if (/\bPODIUM\b/.test(up)) {
    return { bg: "#d6e8ff", border: "#2f6fd6", text: "#1a3f7a", rowTint: "#f2f7ff" };
  }
  if (/\bPENT\b|\bPENTHOUSE\b/.test(up)) {
    return { bg: "#f8d4e8", border: "#d63384", text: "#7a1f4f", rowTint: "#fdf3f8" };
  }
  if (/\d+(?:ST|ND|RD|TH)\s*-\s*\d+(?:ST|ND|TH)/.test(up)) {
    return { bg: "#ffe8cc", border: "#e07b1a", text: "#8a4500", rowTint: "#fff8f0" };
  }
  if (/\b1ST\b/.test(up) && /\bFLOOR\b/.test(up)) {
    return { bg: "#fff4c9", border: "#d4a017", text: "#7a5a00", rowTint: "#fffdf2" };
  }
  if (/\bBASEMENT\b/.test(up)) {
    return { bg: "#e4e6ea", border: "#6c757d", text: "#343a40", rowTint: "#f6f7f8" };
  }
  if (up === "SCHEDULE" || !up.trim()) {
    return { bg: "#d8f0dc", border: "#2e9b4a", text: "#1a5c2e", rowTint: "#f3faf4" };
  }
  return { bg: "#eef2ff", border: "#4c6ef5", text: "#1c3280", rowTint: "#f6f8ff" };
}

export default function FinishesSchedulePanel({ open, onClose, scheduleKb, sourceTitle }) {
  const rows = useMemo(() => (open ? resolveFinishesRows(scheduleKb) : []), [open, scheduleKb]);
  const legend = useMemo(() => (open ? finishesLegendEntries(scheduleKb) : []), [open, scheduleKb]);
  const groups = useMemo(() => groupRowsByFloor(rows), [rows]);

  const sheetLabel = sourceTitle || rows[0]?.source_title || rows[0]?.source_sheet || "";

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--paper-bright)", overflow: "hidden", minHeight: 0 }}>
      <header data-float-drag style={{ padding: "12px 14px", borderBottom: "1px solid var(--ink-faint)", display: "flex", alignItems: "center", gap: 8, cursor: "grab", userSelect: "none", flexShrink: 0 }}>
        <Icon name="spec" size={16} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase" }}>Finishes Schedule</div>
          {sheetLabel ? (
            <div style={{ fontSize: 10.5, color: "var(--ink-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sheetLabel}</div>
          ) : null}
        </div>
        <button type="button" onClick={onClose} title="Close Finishes Schedule" style={{ border: "none", background: "transparent", color: "var(--ink-muted)", fontSize: 18, cursor: "pointer", padding: "0 4px" }}>×</button>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
        <div style={{ flex: 1, overflow: "auto", minWidth: 0, padding: "10px 12px" }}>
          {!rows.length ? (
            <div style={{ padding: "20px 8px", color: "var(--ink-muted)", fontSize: 13, lineHeight: 1.5 }}>
              No finishes schedule found. Upload a finishes schedule sheet (e.g. A0002) — room rows, floor marks, and legend codes populate from parsed PDF text.
            </div>
          ) : (
            groups.map((g) => {
              const band = floorBandColors(g.floor);
              return (
              <div key={g.floor} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "stretch", marginBottom: 6, borderRadius: 4, overflow: "hidden", border: `1px solid ${band.border}` }}>
                  <div style={{ width: 6, flexShrink: 0, background: band.border }} aria-hidden="true" />
                  <div style={{ flex: 1, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: band.text, padding: "5px 10px", background: band.bg }}>
                    {g.floor}
                  </div>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${band.border}`, tableLayout: "fixed", borderLeft: `4px solid ${band.border}` }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, width: "5%", background: band.bg, color: band.text, borderBottom: `1px solid ${band.border}` }}>No.</th>
                      <th style={{ ...th, width: "12%", background: band.bg, color: band.text, borderBottom: `1px solid ${band.border}` }}>Space name</th>
                      <th style={{ ...th, width: "24%", background: band.bg, color: band.text, borderBottom: `1px solid ${band.border}` }}>Floor finish</th>
                      <th style={{ ...th, width: "6%", background: band.bg, color: band.text, borderBottom: `1px solid ${band.border}` }}>Mark</th>
                      <th style={{ ...th, width: "6%", background: band.bg, color: band.text, borderBottom: `1px solid ${band.border}` }}>Skirting</th>
                      <th style={{ ...th, width: "6%", background: band.bg, color: band.text, borderBottom: `1px solid ${band.border}` }}>Wall</th>
                      <th style={{ ...th, width: "6%", background: band.bg, color: band.text, borderBottom: `1px solid ${band.border}` }}>Ceiling</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((row) => (
                      <tr key={`${g.floor}-${row.room_name}-${row.tag}`} style={{ background: band.rowTint }}>
                        <td style={{ ...td, fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: 10.5, color: band.text, textAlign: "center", background: band.bg }}>{row.roomNo}</td>
                        <td style={{ ...td, fontWeight: 600 }}>{row.spaceName}</td>
                        <td style={td}>{row.description || "—"}</td>
                        <MarkCell tag={row.tag} />
                        <MarkCell tag={row.skirting_tag} />
                        <MarkCell tag={row.wall_tag} />
                        <MarkCell tag={row.ceiling_tag} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
            })
          )}
        </div>

        {legend.length > 0 && (
          <aside style={{ width: 220, flexShrink: 0, borderLeft: "1px solid var(--ink-faint)", overflow: "auto", padding: "10px 10px 12px", background: "var(--paper-cream)" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: 8 }}>
              Materials legend
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {legend.map((item) => (
                <div key={item.tag} style={{ fontSize: 10.5, lineHeight: 1.35 }}>
                  <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, color: "var(--cobalt)" }}>{item.tag}</span>
                  {item.description ? (
                    <div style={{ color: "var(--ink-secondary)", marginTop: 2 }}>{item.description}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
