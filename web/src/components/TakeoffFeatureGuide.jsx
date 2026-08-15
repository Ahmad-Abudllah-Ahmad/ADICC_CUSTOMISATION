// ADICC Takeoff feature guide — flow overview from the AIDS toolbar info button.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../brand/icons.jsx";

const FLOW = [
  {
    phase: "Setup",
    steps: [
      { title: "Project & files", desc: "Upload PDFs, folders, zip plan sets, or DWG. Browse the Files tab; open sheets as workspace tabs." },
      { title: "Sheets workspace", desc: "Open multiple sheets, compare side-by-side (2–4), assign levels, and Close all from the Sheets tab." },
      { title: "Scale & units", desc: "Calibrate two known points, pick a standard scale, or check a printed dimension (K). Toggle metric (m) or imperial (ft)." },
      { title: "Conditions", desc: "Finish tags, colors, hatch, height, waste %, and materials. Hotkeys 1–9 switch the active condition; edit appearance from the toolbar." },
      { title: "Import schedule", desc: "Pull finish codes and quantities from a schedule PDF into conditions for faster setup." },
    ],
  },
  {
    phase: "Layers & left panel",
    steps: [
      { title: "Layers list", desc: "Every measured shape listed by sheet — open from the left-rail layers icon (2nd). Masks, wall areas, lines, counts, and cutouts with condition tags." },
      { title: "Show / hide", desc: "Toggle layer visibility on the canvas without deleting quantities; re-show hidden layers anytime." },
      { title: "Select & group", desc: "Ctrl/Cmd-click toggles, Shift-click ranges, Alt-click eye solos. Group related shapes (Ctrl+Shift+G); ungroup with Ctrl+Shift+U." },
      { title: "Fly to & edit", desc: "Click a layer to select and fly to it; open condition edit; delete shapes; separate wall lines at corners." },
      { title: "Wall segments", desc: "Per-line wall heights and door-opening rows in the layer detail — scrolls when more than five lines." },
      { title: "Markups tab", desc: "Clouds, callouts, text notes, and highlights — browse, show/hide all markups, and fly to each item." },
      { title: "Stamps tab", desc: "Reusable click-to-place annotations; import SVG stamps into your library." },
      { title: "RFIs tab", desc: "Raise, track, and export Requests For Information linked to the project." },
    ],
  },
  {
    phase: "Draw & measure",
    steps: [
      { title: "Mode", desc: "Select (V) to edit shapes; Pan (P) or right-click / Space to move the sheet while measuring." },
      { title: "Measure tools", desc: "One-Click (O), Area (A), Rectangle (R), Linear (L), Curve (Q), Surface (S), Count (C), Wall Trace (W), Wall Area (U)." },
      { title: "Cut out", desc: "Deduct voids from floor or wall quantities — shape (D), rectangle (⇧D), or curved line (⇧Q)." },
      { title: "Markup tools", desc: "Cloud, callout, text, highlight box, and freehand highlighter (H) — annotations only, not quantities." },
      { title: "Edit", desc: "Copy, paste, duplicate, flip, undo points, finish trace (↵), phase/area labels, and delete selected shapes." },
    ],
  },
  {
    phase: "Aids & view",
    steps: [
      { title: "45° guides", desc: "Lock traces to 45°/90° while drawing; hold ⇧ for angle constraint on the fly." },
      { title: "Snap", desc: "Snap to plan linework and corners (beta) for faster, accurate vertices." },
      { title: "Render", desc: "Hi-res sheet render plus fill and wall-trace sensitivity for one-click and AI detection." },
      { title: "Canvas view", desc: "Zoom (+/−), fit sheet, and dark negative print (☾)." },
      { title: "Live readout", desc: "Running floor/wall totals, per-segment heights, and door-opening deductions on the selected wall." },
    ],
  },
  {
    phase: "Quantities & output",
    steps: [
      { title: "Estimation bar", desc: "Live take-off value with sparkline — updates as quantities and rates change across the project." },
      { title: "Auto-Takeoff", desc: "AI detects floor finishes from plan masks; review, check regions, and apply to conditions." },
      { title: "Takeoffs panel", desc: "Docked right-rail conditions list with per-condition totals, drag-reorder, and sheet-scoped quantities." },
      { title: "BOQ", desc: "Bill of quantities from detected finishes and manual detail lines; fly to each row on the sheet." },
      { title: "Estimate & rates", desc: "Project estimate breakdown; material rate library for pricing every finish and condition." },
      { title: "Finishes schedule", desc: "Finish-code schedule view tied to conditions and detected areas." },
      { title: "Report & export", desc: "STACK-style breakdown; marked-set PDF with takeoff burned in; full report with materials and RFIs." },
      { title: "Revisions", desc: "Save snapshots, compare any two revisions, buy-list deltas, CSV export, and restore." },
      { title: "AI assistant", desc: "Agent panel for takeoff tasks; Drawings Chat to query plans; voice commands for hands-free measuring." },
    ],
  },
];

export default function TakeoffFeatureGuide() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const [panelStyle, setPanelStyle] = useState(null);

  const placePanel = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const w = 380;
    const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
    setPanelStyle({
      position: "fixed",
      top: r.bottom + 8,
      left,
      width: w,
      maxHeight: "min(78vh, 580px)",
      zIndex: 100000,
      overflowY: "auto",
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    placePanel();
    const onReflow = () => placePanel();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
          ref={btnRef}
          type="button"
          className={`angle-dial-btn${open ? " is-on" : ""}`}
          onClick={() => setOpen((v) => !v)}
          data-tip={open ? undefined : "Feature guide"}
          aria-label="ADICC Takeoff feature guide"
          aria-expanded={open}
        >
          <Icon name="info" size={14} />
        </button>
      {open && panelStyle && createPortal(
        <div ref={panelRef} className="toolbar-glass-popover takeoff-feature-guide" style={{ ...panelStyle, borderRadius: 12, padding: "12px 14px 14px", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", boxShadow: "var(--shadow-2)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "light-dark(var(--cobalt), #ffffff)" }}>ADICC Takeoff</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", marginTop: 2 }}>Feature flow</div>
            </div>
            <button type="button" onClick={() => setOpen(false)} title="Close" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
          </div>
          {FLOW.map((block, bi) => (
            <div key={block.phase} style={{ marginTop: bi ? 12 : 0 }}>
              {bi > 0 && (
                <div style={{ display: "flex", justifyContent: "center", margin: "0 0 10px", color: "var(--cobalt)", fontSize: 14, fontWeight: 700, lineHeight: 1 }} aria-hidden="true">↓</div>
              )}
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: 6 }}>{block.phase}</div>
              <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                {block.steps.map((step, si) => (
                  <li key={step.title} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: 999, background: "var(--cobalt)", color: "var(--accent-contrast)", fontFamily: "var(--f-mono)", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
                      {FLOW.slice(0, bi).reduce((n, b) => n + b.steps.length, 0) + si + 1}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", lineHeight: 1.25 }}>{step.title}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.4, marginTop: 2 }}>{step.desc}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
