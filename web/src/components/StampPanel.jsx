// StampPanel — the stamp palette (the tool-chest, #40). A docked, project-
// global panel (like the RFI register, unlike the sheet-scoped markup panel):
// the browser-global stamp library, one row per stamp with a live geometric
// preview. Click "Place" to arm a stamp — the next canvas click(s) drop it as
// normal, editable markups. Save the selected markup as a new stamp; export /
// import the whole library as JSON so a crew shares one standard set.
//
// The library and every mutation live in the PARENT (TakeoffCanvas); this view
// is pure presentation. Contract:
//   <StampPanel library armedStamp selectedMarkup
//     onArm(stamp) onSaveSelected(markup) onDelete(id) onRename(id,name)
//     onExport() onImport(file) onImportSvg(file) onClose />
import React, { useMemo, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { arrowheadPath } from "../lib/geometry.js";
import { transformPath } from "../lib/svgpath.js";
import ConfirmDeleteModal from "./ConfirmDeleteModal.jsx";

// Live preview of a stamp's elements in a small box. Element coords are OFFSETS
// (fractions of sheet w/h) from the anchor; K maps them into preview px, so a
// north arrow reads as an arrow, an approval stamp as a labeled box.
function StampPreview({ elements = [], w = 54, h = 34 }) {
  const K = 190, cx = w / 2, cy = h / 2;
  const mx = (dx) => cx + dx * K, my = (dy) => cy + dy * K;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ flex: "none", background: "var(--well)", border: "1px solid var(--ink-faint)", borderRadius: 6 }}>
      {elements.map((el, i) => {
        const col = el.color || "#1f3fc7";
        if (el.type === "arrow" && el.from && el.to) {
          const [fx, fy] = [mx(el.from[0]), my(el.from[1])], [tx, ty] = [mx(el.to[0]), my(el.to[1])];
          return <g key={i}><line x1={fx} y1={fy} x2={tx} y2={ty} stroke={col} strokeWidth={1.4} /><path d={arrowheadPath(fx, fy, tx, ty, 5)} fill={col} /></g>;
        }
        if (el.type === "bubble" && el.at) {
          return <g key={i}><circle cx={mx(el.at[0])} cy={my(el.at[1])} r={Math.max(4, (Number(el.r) || 0.02) * K)} fill="none" stroke={col} strokeWidth={1.4} />{el.text ? <text x={mx(el.at[0])} y={my(el.at[1])} fill={col} fontSize={8} fontWeight="700" textAnchor="middle" dominantBaseline="central">{el.text}</text> : null}</g>;
        }
        if ((el.type === "highlight" || el.type === "cloud") && el.rect) {
          const x0 = mx(Math.min(el.rect[0][0], el.rect[1][0])), y0 = my(Math.min(el.rect[0][1], el.rect[1][1]));
          const x1 = mx(Math.max(el.rect[0][0], el.rect[1][0])), y1 = my(Math.max(el.rect[0][1], el.rect[1][1]));
          return <g key={i}><rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={el.type === "highlight" ? col + "22" : "none"} stroke={col} strokeWidth={1.2} strokeDasharray={el.type === "cloud" ? "2 1.5" : undefined} />{el.text ? <text x={(x0 + x1) / 2} y={(y0 + y1) / 2} fill={col} fontSize={6} fontWeight="700" textAnchor="middle" dominantBaseline="central">{el.text}</text> : null}</g>;
        }
        if ((el.type === "callout" || el.type === "text") && el.at) {
          return <g key={i}>{el.type === "callout" && el.target ? <line x1={mx(el.target[0])} y1={my(el.target[1])} x2={mx(el.at[0])} y2={my(el.at[1])} stroke={col} strokeWidth={1.2} /> : null}<text x={mx(el.at[0])} y={my(el.at[1])} fill={col} fontSize={9} fontWeight="700" textAnchor="middle" dominantBaseline="central">{el.text || "T"}</text></g>;
        }
        if (el.type === "svg" && el.path && Array.isArray(el.vb)) {
          // vector symbol — fit the viewBox into ~80% of the thumbnail (a proper
          // preview of imported art, not the tiny K-scaled mark the primitives use).
          const [vw, vh] = el.vb;
          if (!(vw > 0 && vh > 0)) return null;
          const s = Math.min((w * 0.8) / vw, (h * 0.8) / vh);
          const bw = vw * s, bh = vh * s, x0 = (w - bw) / 2, y0 = (h - bh) / 2;
          const fillOn = el.fill && el.fill !== "none";
          return <path key={i} d={transformPath(el.path, (lx, ly) => [x0 + lx * s, y0 + ly * s])} fill={fillOn ? el.fill : "none"} stroke={col} strokeWidth={1} strokeLinejoin="round" />;
        }
        return null;
      })}
    </svg>
  );
}

export default function StampPanel({ docked = false, library = { stamps: [], sets: [] }, armedStamp, selectedMarkup, onArm, onSaveSelected, onDelete, onRename, onExport, onImport, onImportSvg, onClose }) {
  const [setFilter, setSetFilter] = useState("all");   // "all" | set id
  const [editId, setEditId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const fileRef = useRef(null);

  const stampById = useMemo(() => new Map(library.stamps.map((s) => [s.id, s])), [library.stamps]);
  const shown = useMemo(() => {
    if (setFilter === "all") return library.stamps;
    const set = library.sets.find((s) => s.id === setFilter);
    return set ? set.stampIds.map((id) => stampById.get(id)).filter(Boolean) : [];
  }, [setFilter, library.stamps, library.sets, stampById]);

  const chip = (id, label) => (
    <button key={id} type="button" className={`lp-chip${setFilter === id ? " is-on" : ""}`} onClick={() => setSetFilter(id)}>
      {label}
    </button>
  );

  const outer = docked
    ? { display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "auto", background: "transparent", fontSize: 12.5 }
    : { position: "absolute", left: 14, top: 14, width: 340, maxHeight: "calc(100% - 28px)", overflow: "auto", background: "var(--paper-bright)", border: "1px solid var(--cobalt)", boxShadow: "var(--shadow-pop)", zIndex: 9, fontSize: 12.5 };
  // shared file input (both header modes wire the same import flow)
  const fileInput = (
    <input name="stamp-import-file" ref={fileRef} type="file" accept="application/json,.json,image/svg+xml,.svg" style={{ display: "none" }}
      onChange={(e) => { const f = e.target.files?.[0]; if (f) { const isSvg = /\.svg$/i.test(f.name) || f.type === "image/svg+xml"; if (isSvg) onImportSvg?.(f); else onImport(f); } e.target.value = ""; }} />
  );

  return (
    <div style={outer}>
      {docked ? (
        // docked: no blue title bar / ×; Export/Import become a slim light toolbar
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
          <button type="button" className="lp-btn-ghost" onClick={onExport} title="Export the stamp library as JSON">
            <Icon name="document" size={13} />Export
          </button>
          <button type="button" className="lp-btn-ghost" onClick={() => fileRef.current?.click()} title="Import a stamp library (.json, merges) or a vector symbol (.svg, added as a stamp)">
            <Icon name="plus" size={13} />Import
          </button>
          {fileInput}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)", background: "var(--cobalt)", color: "var(--accent-contrast)" }}>
          <strong>Stamps · palette</strong>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" className="lp-btn-ghost" onClick={onExport} title="Export the stamp library as JSON" style={{ color: "var(--accent-contrast)", borderColor: "rgba(255,255,255,.5)", background: "transparent" }}>Export</button>
            <button type="button" className="lp-btn-ghost" onClick={() => fileRef.current?.click()} title="Import a stamp library (.json, merges) or a vector symbol (.svg, added as a stamp)" style={{ color: "var(--accent-contrast)", borderColor: "rgba(255,255,255,.5)", background: "transparent" }}>Import</button>
            {fileInput}
            <button type="button" className="lp-tab-close" onClick={onClose} title="Close">
              <Icon name="close" size={14} />
            </button>
          </span>
        </div>
      )}

      <div style={{ padding: "10px 12px", color: "var(--ink-muted)", fontSize: 12, lineHeight: 1.45 }}>
        {armedStamp
          ? <span><b style={{ color: "var(--cobalt)" }}>“{armedStamp.name}” armed</b> — click the plan to place it. Esc to cancel.</span>
          : <span>Click <b>Place</b> on a stamp, then click the plan. Placed stamps are normal, editable markups.</span>}
      </div>

      {/* set filter — the model carries StampSets; the palette groups by them */}
      {library.sets.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 12px 10px" }}>
          {chip("all", "All")}
          {library.sets.map((s) => chip(s.id, s.name || "Set"))}
        </div>
      )}

      {/* define: save the selected markup as a new stamp */}
      <div style={{ padding: "0 12px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
        <button type="button" className="lp-btn" onClick={() => selectedMarkup && onSaveSelected(selectedMarkup)} disabled={!selectedMarkup}
          title={selectedMarkup ? "Save the selected markup as a reusable stamp" : "Select a markup on the canvas first"}
          style={{ width: "100%", color: selectedMarkup ? "var(--cobalt)" : "var(--ink-muted)" }}>
          <Icon name="plus" size={12} /> Save selected markup as stamp
        </button>
      </div>

      {shown.length === 0 && <div style={{ padding: "14px 12px", color: "var(--ink-muted)", fontSize: 13 }}>No stamps here yet.</div>}
      {shown.map((s) => {
        const armed = armedStamp?.id === s.id;
        return (
          <div key={s.id} className={`lp-row${armed ? " is-armed" : ""}`}>
            <StampPreview elements={s.elements} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {editId === s.id ? (
                <input name="stamp-rename" className="lp-field" autoComplete="off" autoFocus defaultValue={s.name}
                  onKeyDown={(e) => { if (e.key === "Enter") { onRename(s.id, e.currentTarget.value); setEditId(null); } else if (e.key === "Escape") setEditId(null); }}
                  onBlur={(e) => { onRename(s.id, e.currentTarget.value); setEditId(null); }}
                  style={{ padding: "5px 8px" }} />
              ) : (
                <div style={{ fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name}>{s.name}</div>
              )}
              <div style={{ fontSize: 10.5, color: "var(--ink-muted)", marginTop: 2 }}>{s.elements.length} element{s.elements.length === 1 ? "" : "s"}</div>
            </div>
            <button type="button" className={armed ? "lp-btn is-on" : "lp-btn"} onClick={() => onArm(s)} title="Arm this stamp for placement" style={armed ? undefined : { color: "var(--cobalt)", borderColor: "var(--cobalt)" }}>
              {armed ? "Armed" : "Place"}
            </button>
            <button type="button" className="lp-icon-btn" onClick={() => setEditId((id) => (id === s.id ? null : s.id))} title="Rename stamp">
              <Icon name="edit" size={13} />
            </button>
            <button type="button" className="lp-icon-btn is-danger" onClick={() => setPendingDelete(s)} title="Delete stamp">
              <Icon name="trash" size={13} />
            </button>
          </div>
        );
      })}

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete this stamp?"
          body={`“${pendingDelete.name}” will be removed from the library. Placed copies on the plan stay as markups.`}
          confirmLabel="Delete"
          onConfirm={() => { onDelete(pendingDelete.id); setPendingDelete(null); }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
