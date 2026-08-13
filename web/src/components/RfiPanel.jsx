// RfiPanel — the RFI register (Request For Information). A docked, project-global
// panel (unlike the sheet-scoped markup panel): every RFI with number, subject,
// status chip, and linked-markup count; filter by status; edit every field;
// close / void / delete; and fly to a linked markup on any sheet.
//
// State lives in the PARENT (TakeoffCanvas) — this view holds only local filter
// state. The status→response_date auto-stamp is the parent's job (onUpdateRfi),
// so the view never computes a date. Contract:
//   <RfiPanel rfis markups onUpdateRfi(id,patch) onDeleteRfi(id) onFlyTo(markup)
//             sheetLabel={tabLabel} onClose />
import React, { useMemo, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { RFI_STATUSES, rfiStatus, linkedMarkups } from "../lib/rfi.js";
import ConfirmDeleteModal from "./ConfirmDeleteModal.jsx";

const PRIORITIES = ["low", "normal", "high"];

export default function RfiPanel({ docked = false, rfis = [], markups = [], onUpdateRfi, onDeleteRfi, onFlyTo, sheetLabel, onClose }) {
  const [filter, setFilter] = useState("all"); // "all" | status id
  const [pendingDelete, setPendingDelete] = useState(null);
  const shown = useMemo(
    () => (filter === "all" ? rfis : rfis.filter((r) => rfiStatus(r.status).id === filter)),
    [rfis, filter],
  );

  const up = (r, patch) => onUpdateRfi && onUpdateRfi(r.id, patch);

  const chip = (id, label) => (
    <button key={id} type="button" className={`lp-chip${filter === id ? " is-on" : ""}`} onClick={() => setFilter(id)}>
      {label}
    </button>
  );

  const outer = docked
    ? { display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "auto", background: "transparent", fontSize: 12.5 }
    : { position: "absolute", left: 14, top: 14, width: 372, maxHeight: "calc(100% - 28px)", overflow: "auto", background: "var(--paper-bright)", border: "1px solid var(--cobalt)", boxShadow: "var(--shadow-pop)", zIndex: 9, fontSize: 12.5 };

  return (
    <div style={outer}>
      {!docked && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)", background: "var(--cobalt)", color: "var(--accent-contrast)" }}>
          <strong style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Icon name="rfi" size={15} />RFIs · {rfis.length}</strong>
          <button type="button" className="lp-tab-close" onClick={onClose} title="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "10px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
        {chip("all", `All ${rfis.length}`)}
        {RFI_STATUSES.map((s) => chip(s.id, `${s.label} ${rfis.filter((r) => rfiStatus(r.status).id === s.id).length}`))}
      </div>

      {rfis.length === 0 && (
        <div style={{ padding: "14px 12px", color: "var(--ink-muted)", fontSize: 13, lineHeight: 1.45 }}>
          No RFIs yet — select a cloud, callout, or note in the markup panel and press <b>Raise RFI</b>.
        </div>
      )}
      {rfis.length > 0 && shown.length === 0 && (
        <div style={{ padding: "14px 12px", color: "var(--ink-muted)", fontSize: 13 }}>No RFIs with this status.</div>
      )}

      {shown.map((r) => {
        const st = rfiStatus(r.status);
        const linked = linkedMarkups(r, markups);
        return (
          <div key={r.id} className="lp-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, color: "var(--cobalt)" }}>{String(r.number ?? "")}</span>
              <span style={{ padding: "2px 8px", borderRadius: 999, background: st.color, color: "#fff", fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>{st.label}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>{linked.length} linked</span>
              <button type="button" className="lp-icon-btn is-danger" onClick={() => setPendingDelete(r)}
                title="Delete this RFI (hard remove; clears links)">
                <Icon name="trash" size={13} />
              </button>
            </div>

            <label className="lp-label">Subject</label>
            <input name="rfi-subject" className="lp-field" value={r.subject || ""} onChange={(e) => up(r, { subject: e.target.value })} placeholder="Short subject" />

            <label className="lp-label" style={{ marginTop: 4 }}>Question</label>
            <textarea name="rfi-question" className="lp-field" value={r.question || ""} onChange={(e) => up(r, { question: e.target.value })} rows={2} placeholder="What are you asking?" style={{ resize: "vertical" }} />

            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="lp-label">Status</label>
                <select name="rfi-status" className="lp-field" value={st.id} onChange={(e) => up(r, { status: e.target.value })}>
                  {RFI_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="lp-label">Priority</label>
                <select name="rfi-priority" className="lp-field" value={r.priority || "normal"} onChange={(e) => up(r, { priority: e.target.value })}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="lp-label">Ball in court</label>
                <input name="rfi-to" className="lp-field" value={r.to || ""} onChange={(e) => up(r, { to: e.target.value })} placeholder="Architect / GC…" />
              </div>
              <div style={{ flex: 1 }}>
                <label className="lp-label">Opened</label>
                <input name="rfi-date" className="lp-field" value={r.date || ""} onChange={(e) => up(r, { date: e.target.value })} placeholder="YYYY-MM-DD" />
              </div>
            </div>

            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11.5 }}>
                <input name="rfi-cost-impact" type="checkbox" checked={!!r.cost_impact} onChange={(e) => up(r, { cost_impact: e.target.checked })} />cost impact
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11.5 }}>
                <input name="rfi-schedule-impact" type="checkbox" checked={!!r.schedule_impact} onChange={(e) => up(r, { schedule_impact: e.target.checked })} />schedule impact
              </label>
            </div>

            <label className="lp-label">Response</label>
            <textarea name="rfi-response" className="lp-field" value={r.response || ""} onChange={(e) => up(r, { response: e.target.value })} rows={2} placeholder="The answer, once received" style={{ resize: "vertical" }} />
            <label className="lp-label" style={{ marginTop: 4 }}>Response date</label>
            <input name="rfi-response-date" className="lp-field" value={r.response_date || ""} onChange={(e) => up(r, { response_date: e.target.value })} placeholder="auto-stamps when set to Answered" />

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <button type="button" className="lp-btn-ghost" onClick={() => up(r, { status: "closed" })} disabled={st.id === "closed"}
                style={{ padding: "4px 9px", fontSize: 11 }}>Close</button>
              <button type="button" className="lp-btn-ghost" onClick={() => up(r, { status: "void" })} disabled={st.id === "void"}
                style={{ padding: "4px 9px", fontSize: 11, color: "var(--c-danger)" }}>Void</button>
              <span style={{ flex: 1 }} />
              {linked.length === 0
                ? <span style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>no linked markups</span>
                : linked.map((m) => (
                  <button key={m.id} type="button" className="lp-btn" onClick={() => onFlyTo && onFlyTo(m)} title={`Fly to this ${m.type} on ${sheetLabel ? sheetLabel(m.sheet_id) : m.sheet_id}`}
                    style={{ padding: "4px 8px", fontSize: 11, color: "var(--cobalt)", borderColor: "var(--cobalt)" }}>
                    <Icon name="target" size={11} />{sheetLabel ? sheetLabel(m.sheet_id) : m.sheet_id}
                  </button>
                ))}
            </div>
          </div>
        );
      })}

      {pendingDelete && (
        <ConfirmDeleteModal
          title={`Delete ${pendingDelete.number}?`}
          body="Linked markups keep their annotation but lose the RFI link."
          confirmLabel="Delete"
          onConfirm={() => { onDeleteRfi && onDeleteRfi(pendingDelete.id); setPendingDelete(null); }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
