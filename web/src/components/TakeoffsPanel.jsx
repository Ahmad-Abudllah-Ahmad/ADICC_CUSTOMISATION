// TakeoffsPanel — the docked conditions panel on the canvas's right edge
// (reflows the canvas, not an overlay): every condition with its running
// totals and inline properties, plus the template Library, material-library
// Materials (#47/#48), and custom Columns tabs. Extracted from TakeoffCanvas
// and memoized so canvas-only renders (the
// ~11Hz transform mirror during pan/zoom, crosshair churn) skip this whole
// subtree — every callback prop the canvas passes is identity-stable.
//
// View state lives HERE (active tab, filter, collapsed tag-family groups, the
// ⌘/⇧ multi-select, bulk-waste draft): search keystrokes and bulk inputs
// re-render only the panel. Three couplings reach back to the canvas:
//   · `epoch` — hydrate (mount load or snapshot Load) bumps it and an effect
//     clears filter/collapsed-groups/selection IN PLACE. An effect, not a
//     `key` remount: the active tab and resize width survive a snapshot load
//     exactly as they did when this state lived in the canvas.
//   · `clearSelectionRef` — the canvas owns activateCondition (panel rows, the
//     compact strip, and the 1–9 hotkeys all funnel through it); plain
//     activation dismisses a live bulk selection through this ref.
//   · bulk MUTATIONS stay in the canvas: onBulkWaste/onBulkColor/onBulkDelete
//     take the LIVE id set computed here. Liveness derives from the conditions
//     prop (`liveChecked`), so a checked id deleted elsewhere is inert by
//     construction — the canvas never needs to prune this selection.
//
// The panel stays MOUNTED while collapsed (open=false renders null), so all of
// that transient state survives a collapse/expand round-trip.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../brand/icons.jsx";
import { attrValue, columnLabel } from "../lib/conditionColumns.js";
import { SPEC_FIELDS } from "../lib/reportColumns.js";
import { num } from "../lib/num.js";
import { areaVal, areaUnit, lenVal, lenUnit } from "../lib/units";
import { HATCHES, PALETTE, NO_FILL, HatchSwatch } from "./hatches.jsx";
import { LINE_STYLES, LINE_STYLE_IDS, WEIGHT_STEPS, snapWeight } from "../lib/lineStyles.js";
import { materialKind, MATERIAL_PRESETS, GROUT_DEFAULTS, groutDerivedFields, showsGroutCalc, showsGroutDeriveAffordance } from "../lib/coverage.js";
import { draftCommitValue, blurCommitValue, blurCommitNonNegative } from "../lib/draftInput.js";

export const PANEL_MIN_W = 240;
export const PANEL_MAX_W = 560;
export const clampPanelW = (w) => Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, w));

// drag-and-drop payload type carrying a condition id — a condition row here is
// a drag SOURCE, the top-bar quick-access palette (TakeoffCanvas) is the drop
// TARGET. Custom MIME so a condition drag never looks like a file drop.
export const CONDITION_DND_MIME = "application/x-opentakeoff-condition";

// tag family = the text before the dash (CPT-1 → CPT) — the grouping key for
// the panel's grouped view. VIEW-ONLY, like sort and search: the conditions
// array order is canonical (1–9 hotkeys are positional and the payload
// serializes it), so nothing here ever reorders the array itself.
const tagFamily = (t) => (String(t || "").split("-")[0].trim().toUpperCase() || "—");
// one module-level collator — localeCompare builds a fresh collator per CALL
// (~56× slower, benchmarked), and natCompare runs n·log n per sorted view
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const natCompare = (a, b) => coll.compare(String(a), String(b));

// shared style atoms — these were re-declared at every call site (one even
// fresh per matLib row per render); hoisted so identical controls can't drift
const ip = { padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 };
const btnAddFull = { width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-soft)", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const btnClearX = { border: "none", background: "none", color: "var(--ink-muted)", cursor: "pointer", fontSize: 13, padding: 0 };

// Per-material-kind coverage presets (adhesive trowel notches, mortar trowels)
// and the grout-from-tile-geometry calculator live in lib/coverage.js —
// vendor-neutral, generic rates; always verify against the product data sheet.

// The fraction formatter (inFrac) and derivation-note builder moved to
// lib/coverage.js with the rest of the grout math so they're pure and tested.

// One grout tile-geometry input. Keeps the RAW string in local state while the
// field is being edited — clamping/coercing inside onChange made the joint
// field untypeable (every keystroke through "0." snapped to the 0.03125 min)
// and wiped the leading "0" of decimals in the tile fields. The commit/clamp
// decision rules live in lib/draftInput.js (pure, tested): typing commits only
// a fully valid in-range value; blur clamps an out-of-range value into range
// and abandons an empty/invalid draft, so the last good committed value
// redisplays.
function GroutParamInput({ name, value, title, min = 0, max, width = 52, override, onCommit }) {
  const [draft, setDraft] = useState(null);   // raw text mid-edit; null = mirror the committed value
  return (
    <input name={name} type="text" inputMode="decimal" title={title}
      value={draft ?? (value > 0 ? String(value) : "")}
      onChange={(e) => { const t = e.target.value; setDraft(t); const v = draftCommitValue(t, min, max); if (v != null) onCommit(v); }}
      onBlur={() => {
        const v = blurCommitValue(draft, min, max);
        if (v != null) onCommit(v);
        setDraft(null);
      }}
      className={override ? "is-override" : undefined}
      style={{ width }} />
  );
}

// Draft-buffered input for the Materials tab's name + per + note fields:
// keeps the raw text local while editing and commits ONLY on blur/Enter —
// every commit there flows through libEntryPatch, where a CHANGED per/note
// detaches a grout entry's tile geometry and a name edit re-classifies the
// entry's kind, so committing per keystroke destroyed the geometry (or the
// classification) on the transient values of a select-all-retype ("5" of
// "512") or a clear-and-retype, silently and with no undo. In number mode an
// empty/unparseable draft on blur is ABANDONED and the last good value
// redisplays (blurCommitNonNegative, the GroutParamInput/blurCommitValue
// philosophy) — clearing the per field must not commit 0 and take the
// geometry with it; an intentional 0 can still be typed as "0". Text drafts
// commit as-is (clearing a name/note is a legitimate edit).
function LibDraftInput({ name, value, number, placeholder, width, onCommitText }) {
  const [draft, setDraft] = useState(null);   // raw text mid-edit; null = mirror the committed value
  return (
    <input name={name} type={number ? "number" : "text"} min={number ? 0 : undefined} step={number ? "any" : undefined}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft != null) {
          if (number) { const v = blurCommitNonNegative(draft); if (v != null) onCommitText(String(v)); }
          else onCommitText(draft);
        }
        setDraft(null);
      }}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur(); }}
      placeholder={placeholder} style={{ ...ip, width }} />
  );
}

// Coverage preset picker — shared by the condition-line editor and the
// Materials tab so a library "Adhesive" and an attached line offer the same
// notch/roller list. Renders nothing when the kind has no preset table.
function CoveragePresetSelect({ material: m, onPick }) {
  const presets = (m.basis || "area") === "area" ? MATERIAL_PRESETS[materialKind(m)] : undefined;
  if (!presets) return null;
  const current = presets.some((t) => t.label === m.note) ? m.note : "";
  return (
    <PaperSelect
      name="coverage-preset"
      ariaLabel="Coverage preset"
      placeholder="Preset"
      value={current}
      options={[{ value: "", label: "Preset" }, ...presets.map((t) => ({ value: t.label, label: t.label, hint: t.per }))]}
      renderOption={(o, inTrigger) => (inTrigger || !o.hint ? o.label : `${o.label} · ${o.hint}`)}
      onChange={(v) => { const t = presets.find((x) => x.label === v); if (t) onPick({ note: t.label, per: t.per }); }}
    />
  );
}

// Editable supporting-materials rows for a condition (coverage-derived order qty).
function MaterialsEditor({ materials, onAdd, onUpdate, onRemove, library, libById, overridden, onRevert, onAttach, onPromote }) {
  const rv = (m, f) => (
    <button type="button" className="tp-row-icon" onClick={() => onRevert(m, f)} title="Revert this field to the library value" aria-label="Revert to library">
      <Icon name="undo" size={12} />
    </button>
  );
  return (
    <>
      {(materials || []).map((m) => {
        const lm = libById ? libById[m.lib_id] : null;
        const ov = (f) => (lm && overridden ? overridden(m, lm, f) : false);
        const g = { ...GROUT_DEFAULTS, ...(m.grout || {}) };
        const setGrout = (patch) => {
          const grout = { ...g, ...patch };
          onUpdate(m.id, { grout, ...(groutDerivedFields(grout) || {}) });
        };
        const gi = (key, title, extra) => (
          <GroutParamInput name={`grout-${key}`} value={g[key]} title={title} override={ov("grout")}
            onCommit={(v) => setGrout({ [key]: v })} {...extra} />
        );
        return (
          <div key={m.id} className="tp-mat-line">
            <div className="tp-mat-id">
              {lm ? <span className="tp-mat-linked" title={`Linked to “${lm.name}” in the material library`}>Lib</span> : null}
              <input name="material-name" className={`tp-mat-tag${ov("name") ? " is-override" : ""}`} value={m.name} onChange={(e) => onUpdate(m.id, { name: e.target.value })} placeholder="Material" />
              {ov("name") && rv(m, "name")}
              <span className="tp-mat-actions">
                {!lm && onPromote && (
                  <button type="button" className="tp-row-icon" onClick={() => onPromote(m)} title="Save this material to the library" aria-label="Save to library">
                    <Icon name="product" size={14} />
                  </button>
                )}
                <button type="button" className="tp-row-icon is-danger" onClick={() => onRemove(m.id)} title="Remove this material" aria-label="Remove material">
                  <Icon name="trash" size={14} />
                </button>
              </span>
            </div>
            <div className="tp-mat-look">
              <div className="tp-mat-formula">
                <span className="tp-mat-k">1</span>
                <input name="material-unit" value={m.unit} onChange={(e) => onUpdate(m.id, { unit: e.target.value })} placeholder="unit" className={ov("unit") ? "is-override" : undefined} style={{ width: 44 }} />
                {ov("unit") && rv(m, "unit")}
                <span className="tp-mat-k">per</span>
                <input name="material-per" type="text" inputMode="decimal" value={m.per || ""} onChange={(e) => onUpdate(m.id, { per: Math.max(0, parseFloat(e.target.value) || 0) })} placeholder="0" className={ov("per") ? "is-override" : undefined} style={{ width: 48 }} />
                {ov("per") && rv(m, "per")}
              </div>
              <div className="tp-mat-stroke">
                <div className="tp-mat-stroke-row">
                  <PaperSelect
                    name="material-basis"
                    ariaLabel="Coverage basis"
                    value={m.basis || "area"}
                    options={[
                      { value: "area", label: "Floor SF" },
                      { value: "linear", label: "Linear LF" },
                      { value: "count", label: "Each" },
                    ]}
                    onChange={(v) => onUpdate(m.id, { basis: v })}
                  />
                  {ov("basis") && rv(m, "basis")}
                  <CoveragePresetSelect material={m} onPick={(patch) => onUpdate(m.id, patch)} />
                </div>
                <label className={`tp-mat-round${ov("round") ? " is-override" : ""}`} title="Round up to whole units">
                  <input name="material-round" type="checkbox" checked={m.round !== false} onChange={(e) => onUpdate(m.id, { round: e.target.checked })} />
                  Round up
                </label>
                {ov("round") && rv(m, "round")}
              </div>
            </div>
            <div className="tp-mat-note">
              <input name="material-note" value={m.note || ""} onChange={(e) => onUpdate(m.id, { note: e.target.value })} placeholder="Note" className={ov("note") ? "is-override" : undefined} />
              {ov("note") && rv(m, "note")}
            </div>
            {showsGroutCalc(m) && (
              <div className="tp-mat-grout">
                <span>Tile</span>
                {gi("tileL", "Tile length (in)")}
                <span>×</span>
                {gi("tileW", "Tile width (in)")}
                <span>×</span>
                {gi("tileT", "Tile thickness (in)")}
                <span>in · joint</span>
                {gi("joint", "Joint width (in)", { min: 0.03125, max: 0.5, width: 56 })}
                <span>· bag</span>
                {gi("bagLbs", "Bag size (lbs)")}
                <span>lb</span>
                {ov("grout") && rv(m, "grout")}
              </div>
            )}
            {showsGroutDeriveAffordance(m) && (
              <div className="tp-mat-grout">
                <button type="button" className="tp-mat-text-btn" onClick={() => setGrout({})}
                  title="Start the grout calculator with standard tile geometry">
                  Derive from tile
                </button>
                {ov("grout") && rv(m, "grout")}
              </div>
            )}
          </div>
        );
      })}
      <div className="tp-mat-add">
        <button type="button" className="tp-mat-text-btn" onClick={onAdd}>
          <Icon name="plus" size={12} />
          Material
        </button>
        {onAttach && (library || []).length > 0 && (
          <PaperSelect
            name="attach-material"
            ariaLabel="Attach from library"
            placeholder="From library"
            value=""
            options={[{ value: "", label: "From library" }, ...(library || []).map((lm) => ({ value: lm.id, label: lm.name || "(unnamed)" }))]}
            onChange={(v) => { if (v) onAttach(v); }}
          />
        )}
      </div>
    </>
  );
}

// Per-condition custom-column assignment — one select per defined column.
// Unassigned = attrs key absent; a value deleted from the vocabulary
// keeps the condition's string, shown as "<value> (removed)".
function ColumnSelects({ columns, cond, onAssign }) {
  return (
    <>
      {columns.map((cc) => {
        const v = attrValue(cond?.attrs, cc.id);   // the shared assigned-value rule (hydrate sanitizes, this keeps the display consistent)
        return (
          <label key={cc.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginRight: 12, marginBottom: 6 }}>
            <span style={{ color: "var(--ink-soft)", fontWeight: 600 }}>{columnLabel(cc)}</span>
            <select name="assign-column-value" value={v} onChange={(e) => onAssign(cc.id, e.target.value)} style={{ ...ip, background: "var(--paper-bright)" }}>
              <option value="">Unassigned</option>
              {cc.values.map((val) => <option key={val} value={val}>{val}</option>)}
              {v && !cc.values.includes(v) && <option value={v}>{v} (removed)</option>}
            </select>
          </label>
        );
      })}
    </>
  );
}

// add-value input for the column manager — local draft state, commit on Enter/+
function AddValueInput({ onAdd }) {
  const [v, setV] = useState("");
  const commit = () => { const t = v.trim(); if (t) onAdd(t); setV(""); };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <input name="column-add-value" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && commit()} placeholder="add value" style={{ ...ip, width: 90 }} />
      <button onClick={commit} title="Add this value to the list"
        style={{ padding: "2px 7px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>+</button>
    </span>
  );
}

/** Native <select> option lists cannot be themed. Closed trigger stays the
 *  existing paper chip; the open list is a portaled paper menu. */
function PaperSelect({ name, value, options, onChange, ariaLabel, renderOption, placeholder }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState(null);
  const current = options.find((o) => String(o.value) === String(value))
    || (placeholder != null ? { value: "", label: placeholder } : options[0]);

  const placeMenu = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const maxH = Math.max(120, Math.min(240, window.innerHeight - 16));
    const estH = Math.min(options.length * 32 + 10, maxH);
    const flip = window.innerHeight - r.bottom < estH + 8 && r.top > estH;
    setMenuStyle({
      left: Math.max(8, Math.min(r.left, window.innerWidth - 168)),
      top: flip ? r.top - estH - 4 : r.bottom + 4,
      minWidth: Math.max(r.width, 132),
      maxHeight: maxH,
    });
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    placeMenu();
    const onReflow = () => placeMenu();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      const t = e.target;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
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
        name={name}
        className={`cond-paper-select${placeholder != null && String(value) === "" ? " is-placeholder" : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span className="cond-paper-select-label">{current ? (renderOption ? renderOption(current, true) : current.label) : ""}</span>
        <span className="cond-paper-select-caret" aria-hidden>
          <Icon name="chevronDown" size={10} />
        </span>
      </button>
      {open && menuStyle && createPortal(
        <div ref={menuRef} className="cond-paper-menu" role="listbox" aria-label={ariaLabel} style={menuStyle}>
          {options.map((o) => {
            const on = String(o.value) === String(value);
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={on}
                className={`cond-paper-menu-item${on ? " is-on" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {renderOption ? renderOption(o, false) : o.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

function lineStyleMark(dash, weight = 1.5) {
  return (
    <svg className="cond-paper-mark" width="36" height="10" viewBox="0 0 36 10" aria-hidden>
      <line
        x1="2" y1="5" x2="34" y2="5"
        stroke="currentColor"
        strokeWidth={weight}
        strokeLinecap="square"
        strokeDasharray={dash && dash.length ? dash.join(" ") : undefined}
      />
    </svg>
  );
}

function NoFillMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <rect x="1.2" y="1.2" width="9.6" height="9.6" fill="none" stroke="currentColor" strokeWidth="1" />
      <line x1="2.2" y1="9.8" x2="9.8" y2="2.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function EnterSaveNumber({ name, value, min = 0, integer = false, width, onCommit }) {
  const [draft, setDraft] = useState(null);
  const commit = (raw) => {
    const n = integer ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(n)) return;
    onCommit(Math.max(min, n));
  };
  return (
    <input
      name={name}
      type="text"
      inputMode="decimal"
      className="cond-plain-num"
      value={draft ?? String(value ?? "")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft != null) { commit(draft); setDraft(null); } }}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur(); }}
      style={{ width, padding: "3px 5px" }}
    />
  );
}

// Appearance editor for ONE condition — tag, ×N, waste, line/fill color, hatch,
// line style, height, thickness, and custom-column assignment. This is the row
// that "used to live in its own toolbar row above the canvas"; extracted here so
// the docked panel AND the restored top-bar band render the SAME editor (one
// source of truth, like the app's single activateCondition path). Owns only its
// hatch-popover open state; everything else flows through the passed handlers.
export function ConditionAppearanceEditor({ cond: c, onUpdateCond, onSetCondParam, onAssignAttr, conditionColumns = [], layout = "stack" }) {
  const [hatchOpen, setHatchOpen] = useState(false);
  const hatchBtnRef = useRef(null);
  const hatchMenuRef = useRef(null);
  const [hatchMenuStyle, setHatchMenuStyle] = useState(null);
  const hatchId = c.hatch || "solid";
  const hatchLabel = (HATCHES.find((h) => h.id === hatchId) || {}).label || "Solid";
  const isRow = layout === "row";
  const rule = () => <span aria-hidden className="condition-appearance-rule" />;

  const placeHatchMenu = () => {
    const btn = hatchBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const w = 196;
    setHatchMenuStyle({
      left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
      top: r.bottom + 4,
    });
  };

  useLayoutEffect(() => {
    if (!hatchOpen) return undefined;
    placeHatchMenu();
    const onReflow = () => placeHatchMenu();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [hatchOpen]);

  useEffect(() => {
    if (!hatchOpen) return undefined;
    const onDown = (e) => {
      const t = e.target;
      if (hatchBtnRef.current?.contains(t) || hatchMenuRef.current?.contains(t)) return;
      setHatchOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setHatchOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [hatchOpen]);

  return (
    <div className={`condition-appearance-editor${isRow ? " is-row" : ""}`}>
      <div className="cond-edit-id">
        <input
          name="condition-finish-tag"
          className="cond-edit-tag"
          value={c.finish_tag}
          onChange={(e) => onUpdateCond({ finish_tag: e.target.value })}
          title="Rename this condition / finish tag"
        />
        <span className="cond-edit-unit" title="Multiply this condition by N identical units (measure one, ×N)">
          <span className="cond-edit-k">×</span>
          <EnterSaveNumber name="condition-multiplier" value={c.multiplier || 1} min={1} integer width={40}
            onCommit={(v) => onUpdateCond({ multiplier: v })} />
        </span>
        <span className="cond-edit-unit" title="Waste % — a flooring allowance added on top of the measured quantity in the Report. You choose it per condition (e.g. ~8% straight-lay LVP, ~15% diagonal, ~20% herringbone).">
          <span className="cond-edit-k">Waste</span>
          <EnterSaveNumber name="condition-waste-pct" value={c.waste_pct ?? 0} min={0} width={40}
            onCommit={(v) => onUpdateCond({ waste_pct: v })} />
          <span className="cond-edit-k">%</span>
        </span>
        <span className="cond-edit-unit" title="Height (ft) — the default for NEW wall traces (SF = LF × H) and the vertical-SF display on floor areas. Walls keep the height they were drawn at — select a wall to change just that one.">
          <Icon name="height" size={13} />
          <input name="condition-height-ft" type="text" inputMode="decimal" className="cond-plain-num" value={c.height_ft ?? ""} placeholder="ft"
            onChange={(e) => onSetCondParam("height_ft", e.target.value)} style={{ width: 44 }} />
        </span>
        <span className="cond-edit-unit" title="Thickness (in) — a Linear run with thickness also computes border/feature-strip SF = LF × T/12. Changing it re-flows existing linear runs.">
          <Icon name="thickness" size={13} />
          <input name="condition-thickness-in" type="text" inputMode="decimal" className="cond-plain-num" value={c.thickness_in ?? ""} placeholder="in"
            onChange={(e) => onSetCondParam("thickness_in", e.target.value)} style={{ width: 40 }} />
        </span>
      </div>
      {isRow && rule()}
      <div className="cond-edit-look">
        <div className="cond-edit-palettes">
          <div className="cond-edit-palette">
            <span className="cond-edit-k">Line</span>
            <div className="cond-edit-swatches">
              {PALETTE.map((p) => (
                <button key={p} type="button" title={p} aria-label={p} aria-pressed={c.color === p}
                  className={`cond-edit-swatch${c.color === p ? " is-on" : ""}`}
                  style={{ background: p }}
                  onClick={() => onUpdateCond({ color: p })} />
              ))}
            </div>
          </div>
          <div className="cond-edit-palette">
            <span className="cond-edit-k">Fill</span>
            <div className="cond-edit-swatches">
              <button type="button" title="No fill" aria-label="No fill" aria-pressed={c.fill === NO_FILL}
                className={`cond-edit-swatch is-none${c.fill === NO_FILL ? " is-on" : ""}`}
                onClick={() => onUpdateCond({ fill: NO_FILL })}>
                <NoFillMark />
              </button>
              {PALETTE.map((p) => (
                <button key={p} type="button" title={p} aria-label={`Fill ${p}`} aria-pressed={c.fill === p}
                  className={`cond-edit-swatch is-fill${c.fill === p ? " is-on" : ""}`}
                  style={{ background: p }}
                  onClick={() => onUpdateCond({ fill: p })} />
              ))}
            </div>
          </div>
        </div>
        <div className="cond-edit-stroke">
          <button
            ref={hatchBtnRef}
            type="button"
            className={`cond-edit-hatch${hatchOpen ? " is-on" : ""}`}
            title={`Hatch pattern — ${hatchLabel}`}
            aria-label="Hatch pattern"
            aria-expanded={hatchOpen}
            onClick={() => setHatchOpen((v) => !v)}
          >
            <span className="cond-edit-hatch-swatch"><HatchSwatch type={hatchId} line={c.color} fill={c.fill} /></span>
            <span className="cond-edit-hatch-label">{hatchLabel}</span>
            <span className="cond-paper-select-caret" aria-hidden><Icon name="chevronDown" size={10} /></span>
          </button>
          {hatchOpen && hatchMenuStyle && createPortal(
            <div ref={hatchMenuRef} className="cond-edit-hatch-menu" style={hatchMenuStyle} role="listbox" aria-label="Hatch pattern">
              {HATCHES.map((h) => {
                const hOn = hatchId === h.id;
                return (
                  <button key={h.id} type="button" title={h.label} aria-label={h.label} aria-pressed={hOn}
                    className={`cond-edit-hatch-opt${hOn ? " is-on" : ""}`}
                    onClick={() => { onUpdateCond({ hatch: h.id }); setHatchOpen(false); }}>
                    <HatchSwatch type={h.id} line={c.color} fill={c.fill} />
                  </button>
                );
              })}
            </div>,
            document.body,
          )}
          <div className="cond-edit-stroke-row">
            <PaperSelect
              name="condition-line-style"
              ariaLabel="Line style"
              value={c.line_style || "solid"}
              options={LINE_STYLE_IDS.map((id) => ({ value: id, label: LINE_STYLES[id].label, dash: LINE_STYLES[id].dash }))}
              onChange={(v) => onUpdateCond({ line_style: v })}
              renderOption={(o, compact) => compact ? lineStyleMark(o.dash) : <>{lineStyleMark(o.dash)}{o.label}</>}
            />
            <PaperSelect
              name="condition-line-weight"
              ariaLabel="Line weight"
              value={String(snapWeight(c.weight))}
              options={WEIGHT_STEPS.map((wv) => ({ value: String(wv), label: `${wv}×`, weight: wv }))}
              onChange={(v) => onUpdateCond({ weight: Number(v) })}
              renderOption={(o, compact) => compact ? o.label : <>{lineStyleMark(null, Math.max(1, o.weight))}{o.label}</>}
            />
          </div>
        </div>
      </div>
      {conditionColumns.length > 0 && isRow && rule()}
      {conditionColumns.length > 0 && (
        <div className="cond-edit-cols" title="Classify this condition — the Report can group and export by these (manage columns in the Columns tab)">
          <ColumnSelects columns={conditionColumns} cond={c} onAssign={onAssignAttr} />
        </div>
      )}
      {!isRow && c.spec && typeof c.spec === "object" && !Array.isArray(c.spec) && (
        <div className="cond-edit-spec">
          <span className="cond-edit-spec-k"
            title="Product spec imported from the finish schedule — editable; shown as read-only columns in the Report / CSV / XLSX">Spec</span>
          {SPEC_FIELDS.map(({ field, header }) => (
            <label key={field}>
              <span>{header}</span>
              <input name={`condition-spec-${field}`} value={c.spec[field] || ""}
                onChange={(e) => onUpdateCond({ spec: { ...c.spec, [field]: e.target.value } })} />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function TakeoffsPanel({
  open, width, multiSheet, units = "imperial",
  conditions, activeCond, visRowById, conditionColumns, shapeLabels = [], templates, palette = [],
  matLib, matLibById, linkedCountById,
  panelPrefs, onPanelPrefs, reassigning, epoch, clearSelectionRef,
  onActivate, onSetActive, onLocate,
  onAddCondition, onDeleteCondition, onUpdateCond, onSetCondParam, onAssignAttr,
  onAddMaterial, onUpdateMaterial, onRemoveMaterial,
  onBulkWaste, onBulkColor, onBulkDelete,
  onSaveTemplate, onApplyTemplate, onRenameTemplate, onDeleteTemplate,
  onAttachLibMaterial, onPromoteMaterial, onRevertMatField, matFieldOverridden,
  onUpdateLibMaterial, onPushLibUpdate, onDeleteLibMaterial, onAddLibMaterial,
  onAddColumn, onRenameColumn, onDeleteColumn, onAddColumnValue, onRemoveColumnValue, onRenameColumnValue,
  onAddLabel, onRenameLabel, onRemoveLabel,
  onToggleCollapse, onHoldGesture, onTogglePin,
}) {
  const [panelTab, setPanelTab] = useState("takeoffs");       // "takeoffs" | "library" | "materials" | "columns"
  const [condQuery, setCondQuery] = useState("");             // live filter over the condition list (transient, never persisted)
  const [matLibQuery, setMatLibQuery] = useState("");         // Materials tab search (transient; describes the browser-global library, so hydrate/epoch leaves it alone)
  const [closedGroups, setClosedGroups] = useState(() => new Set()); // collapsed tag-family groups in the grouped view
  // multi-select for bulk edit — VIEW STATE ONLY, never persisted. ⌘/ctrl-click
  // toggles a row into the set, ⇧-click ranges from the last toggle in the
  // current view order, plain click clears (and activates, as always).
  const [checkedConds, setCheckedConds] = useState(() => new Set());
  const [bulkWaste, setBulkWaste] = useState("");
  const checkAnchorRef = useRef(null);
  const [panelMatOpen, setPanelMatOpen] = useState(false);    // supporting-materials editor expanded inline under the active row
  const rootRef = useRef(null);   // panel root — mid-drag width writes bypass React
  const dragRef = useRef(null);   // { sx, sw, w } — w is the live width during the drag

  // hydrate (mount load or snapshot Load) replaced the conditions this view
  // state described — a checked set / range anchor / filter / collapsed groups
  // aimed at the PRE-load list would misfire on ids that happen to survive.
  // Cleared in place so panelTab (and the width pref) survive, matching the
  // pre-extraction behavior. On mount this is a no-op (fresh state).
  useEffect(() => {
    setCheckedConds((s) => (s.size ? new Set() : s));
    checkAnchorRef.current = null;
    setCondQuery("");
    setClosedGroups((s) => (s.size ? new Set() : s));
  }, [epoch]);

  // the canvas's activateCondition (rows, strip, 1–9 hotkeys) dismisses a live
  // bulk selection — it reaches this view state through the shared ref
  useEffect(() => {
    if (!clearSelectionRef) return undefined;
    clearSelectionRef.current = () => {
      setCheckedConds((s) => (s.size ? new Set() : s));
      checkAnchorRef.current = null;
    };
    return () => { clearSelectionRef.current = null; };
  }, [clearSelectionRef]);

  // ── condition list: VIEW-ONLY search / natural sort / grouping ────────────
  // Rows are wrapped as { c } so the view transforms (filter/sort/group) never
  // touch the condition objects; the hotkey badge now reflects palette order,
  // resolved per row from the palette prop (no original-index bookkeeping).
  const condQ = condQuery.trim().toLowerCase();
  const matQ = matLibQuery.trim().toLowerCase();   // Materials tab filter — hoisted so the row map below computes it once, not per row
  // the one finish-tag match rule — condView's filter and searchMiss must
  // agree on what "matches" means, or a row could show while the "no match"
  // message also shows (or vice versa)
  const matchesQuery = useCallback((c) => (c.finish_tag || "").toLowerCase().includes(condQ), [condQ]);
  const condView = useMemo(() => {
    let v = conditions.map((c) => ({ c }));
    // the ACTIVE condition is force-included past the filter: hotkeys, the
    // strip, and applyTemplate can activate a row the query hides, and the
    // properties editor lives only in the active row — it must stay reachable
    if (condQ) v = v.filter(({ c }) => matchesQuery(c) || c.id === activeCond);
    if (panelPrefs.az) v = [...v].sort((a, b) => natCompare(a.c.finish_tag, b.c.finish_tag));
    return v;
  }, [conditions, condQ, matchesQuery, activeCond, panelPrefs.az]);
  const condGroups = useMemo(() => {
    if (!panelPrefs.group) return [{ name: null, items: condView }];
    const by = new Map();
    for (const it of condView) {
      const fam = tagFamily(it.c.finish_tag);
      if (!by.has(fam)) by.set(fam, []);
      by.get(fam).push(it);
    }
    return [...by.entries()].sort((a, b) => natCompare(a[0], b[0])).map(([name, items]) => ({ name, items }));
  }, [condView, panelPrefs.group]);
  // "no match" keys on the QUERY missing, not on an empty view — the forced-in
  // active row would otherwise hide the message forever (includes("") is true)
  const searchMiss = conditions.length > 0 && !condView.some(({ c }) => matchesQuery(c));

  // the one "which rows does a collapsed group show" rule — a collapsed
  // group still renders its ACTIVE row: hotkeys, the strip, and applyTemplate
  // can activate a condition the view hides, and the editor lives only in
  // that row. Shared by the ⇧-range order below AND the render, below, so
  // they can never disagree on what's visible.
  const groupVisibleItems = useCallback(
    (g) => (g.name != null && closedGroups.has(g.name) ? g.items.filter((it) => it.c.id === activeCond) : g.items),
    [closedGroups, activeCond]
  );
  // bulk selection helpers — ranges follow the DISPLAYED order (current view,
  // skipping collapsed groups — except the active row, which a collapsed group
  // still renders, so ⇧-ranges anchored on or through it must see it too)
  const visibleCondOrder = useMemo(
    () => condGroups.flatMap((g) => groupVisibleItems(g).map((it) => it.c.id)),
    [condGroups, groupVisibleItems]
  );
  // bulk actions run on the LIVE intersection — checkedConds is view state and
  // deletes elsewhere (or a stale set) must never inflate a count or a patch
  const liveChecked = conditions.filter((c) => checkedConds.has(c.id));
  const liveIds = () => new Set(liveChecked.map((c) => c.id));
  const toggleChecked = (id) => {
    setCheckedConds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    checkAnchorRef.current = id;
  };
  const rangeCheck = (id) => {
    const a = checkAnchorRef.current;
    const ai = a ? visibleCondOrder.indexOf(a) : -1, bi = visibleCondOrder.indexOf(id);
    if (ai < 0 || bi < 0) { toggleChecked(id); return; }
    const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
    setCheckedConds((s) => { const n = new Set(s); for (let k = lo; k <= hi; k++) n.add(visibleCondOrder[k]); return n; });
  };
  const applyBulkWaste = () => {
    const v = Math.max(0, parseFloat(bulkWaste));
    if (!Number.isFinite(v)) return;
    onBulkWaste(liveIds(), v);
  };
  const bulkDelete = () => {
    if (!liveChecked.length) return;
    // canvas opens the themed confirm; selection clears after confirm via clearSelectionRef
    onBulkDelete(liveIds());
  };

  // Resize by dragging the panel's left edge. Mid-drag the width lives in a
  // ref and goes straight to the panel root's DOM style — NO pref commit per
  // move (each one re-rendered the whole canvas tree and re-wrote
  // localStorage). The canvas's detail-crop gesture window is held per move
  // (onHoldGesture, like wheel zoom) and state commits ONCE on release, so the
  // persistence effect and the detail crop fire once per drag.
  const onResizeDown = (e) => {
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sw: width, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e) => {
    const d = dragRef.current; if (!d) return;
    if (e.buttons === 0) { onResizeEnd(e); return; }   // release happened off-window — a missed pointerup must not leave a phantom drag
    onHoldGesture();
    d.w = clampPanelW(d.sw + (d.sx - e.clientX));
    if (rootRef.current) rootRef.current.style.width = `${d.w}px`;
  };
  // shared by pointerup / pointercancel / lostpointercapture — any way the
  // gesture ends, the width commits exactly once
  const onResizeEnd = (e) => {
    const d = dragRef.current; if (!d) return;
    dragRef.current = null;
    onPanelPrefs((p) => (p.w === d.w ? p : { ...p, w: d.w }));
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
  };

  const aCond = conditions.find((c) => c.id === activeCond);

  // unit-system display edge (mirrors the canvas HUD): internal math stays feet
  const fa = (sf) => `${num(areaVal(sf, units))} ${areaUnit(units)}`;
  const fl = (lf) => `${num(lenVal(lf, units))} ${lenUnit(units)}`;

  const renderCondRow = (c) => {
    const row = visRowById.get(c.id);
    const mult = c.multiplier || 1;
    const sf = row?.floor_sf || 0, lf = row?.lf || 0, ea = row?.ea || 0, wsf = row?.wall_sf || 0;
    const shapeCount = row?.shape_count || 0;
    const on = c.id === activeCond;
    const matOn = on && panelMatOpen;
    const checked = checkedConds.has(c.id);
    const pinIdx = palette.indexOf(c.id);        // position in the top-bar palette (−1 = not pinned)
    const pinned = pinIdx >= 0;
    // 1–9 hotkey badge follows the same rule as the keys (and the strip): palette
    // order when the palette is curated, condition-array order as the fallback
    // when nothing is pinned so the badge never under-advertises a working key
    const hIdx = palette.length ? pinIdx : conditions.findIndex((x) => x.id === c.id);
    const hot = hIdx >= 0 && hIdx < 9;
    return (
      <div key={c.id} data-cond-id={c.id} className={`takeoffs-panel-glass-row${on ? " is-active" : ""}${checked ? " is-checked" : ""}`} style={{ borderTop: "1px solid var(--ink-faint)" }}>
        <div draggable
          onDragStart={(e) => { e.dataTransfer.setData(CONDITION_DND_MIME, c.id); e.dataTransfer.effectAllowed = "copy"; }}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) { toggleChecked(c.id); return; }
            if (e.shiftKey) { rangeCheck(c.id); return; }
            onActivate(c.id);
          }}
          onDoubleClick={() => onLocate(c.id)}
          title={reassigning ? "Reassign selected shape to this condition" : "Make this the active condition (double-click zooms to its takeoffs · ⌘-click / ⇧-click selects for bulk edit · drag to the top-bar palette for one-click access)"}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", cursor: "pointer", outline: reassigning ? "1px dashed var(--cobalt)" : "none", outlineOffset: -3, userSelect: "none" }}>
          {hot && <span title={pinned ? `Palette shortcut — press ${hIdx + 1} to activate` : `Press ${hIdx + 1} to activate (pin to lock this number)`} style={{ fontSize: 9, fontFamily: "var(--f-mono,monospace)", color: pinned ? "var(--cobalt)" : "var(--ink-soft)", fontWeight: 700, border: `1px solid ${pinned ? "var(--cobalt)" : "var(--ink-faint)"}`, borderRadius: 3, padding: "0 3px", flexShrink: 0 }}>{hIdx + 1}</span>}
          <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: on ? 700 : 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.finish_tag}{mult > 1 ? <span style={{ color: "var(--ink-soft)", fontWeight: 600 }}> ×{mult}</span> : null}</div>
            {(sf || wsf || lf || ea) ? (
              <div style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 11, color: "var(--ink-soft)", fontWeight: 600 }}>
                {sf ? fa(sf) : ""}{wsf ? `${sf ? " · " : ""}${fa(wsf)} wall` : ""}{lf ? `${sf || wsf ? " · " : ""}${fl(lf)}` : ""}{ea ? `${sf || wsf || lf ? " · " : ""}${num(ea, 0)} EA` : ""}
              </div>
            ) : null}
          </div>
          <div className="tp-row-actions">
            <span className="tp-row-metric" title={`${shapeCount} takeoff${shapeCount === 1 ? "" : "s"}`}>
              <Icon name="takeoff" size={14} />
              <span>{shapeCount}</span>
            </span>
            <button type="button" className="tp-row-icon" onClick={(e) => { e.stopPropagation(); onLocate(c.id); }} title="Zoom the canvas to this condition's takeoffs" aria-label="Zoom to takeoffs">
              <Icon name="target" size={14} />
            </button>
            <button type="button" className={`tp-row-icon${matOn ? " is-on" : ""}`} onClick={(e) => { e.stopPropagation(); onSetActive(c.id); setPanelMatOpen((v) => (on ? !v : true)); }}
              title="Supporting Materials — labor, subfloor & materials for this condition" aria-label="Supporting materials" aria-pressed={!!matOn}>
              <Icon name="product" size={14} />
              {c.materials?.length ? <span className="tp-row-icon-n">{c.materials.length}</span> : null}
            </button>
            <button type="button" className={`tp-row-icon${pinned ? " is-on" : ""}`} onClick={(e) => { e.stopPropagation(); onTogglePin(c.id); }}
              title={pinned ? "Unpin from the top-bar palette" : (palette.length >= 9 ? "Palette is full (9)" : "Pin to the top-bar palette for one-click access")}
              aria-label={pinned ? "Unpin from palette" : "Pin to palette"} aria-pressed={!!pinned}>
              <Icon name="pin" size={14} />
            </button>
            <button type="button" className="tp-row-icon is-danger" onClick={(e) => { e.stopPropagation(); onDeleteCondition(c.id); }} title="Delete this condition (and its takeoffs)" aria-label="Delete condition">
              <Icon name="trash" size={14} />
            </button>
          </div>
        </div>
        {/* properties for the ACTIVE condition — the appearance editing that
            used to live in its own toolbar row above the canvas. Extracted to
            ConditionAppearanceEditor so the docked panel AND the top-bar band
            render the same editor from one source of truth. */}
        {on && <ConditionAppearanceEditor cond={c} onUpdateCond={onUpdateCond} onSetCondParam={onSetCondParam} onAssignAttr={onAssignAttr} conditionColumns={conditionColumns} />}
        {matOn && (
          <div className="takeoffs-panel-glass-materials">
            <div className="tp-mat-id">
              <label className="tp-mat-unit">
                <span className="tp-mat-k">Labor</span>
                <input name="condition-labor-type" value={c.laborType || ""} placeholder="Glue-down, float…"
                  onChange={(e) => onUpdateCond({ laborType: e.target.value })} />
              </label>
              <label className="tp-mat-unit">
                <span className="tp-mat-k">Subfloor</span>
                <input name="condition-subfloor-type" value={c.subfloorType || ""} placeholder="Ply, slab, OSB…"
                  onChange={(e) => onUpdateCond({ subfloorType: e.target.value })} />
              </label>
            </div>
            <MaterialsEditor materials={c.materials} onAdd={onAddMaterial} onUpdate={onUpdateMaterial} onRemove={onRemoveMaterial}
              library={matLib} libById={matLibById} overridden={matFieldOverridden} onRevert={onRevertMatField}
              onAttach={onAttachLibMaterial} onPromote={onPromoteMaterial} />
          </div>
        )}
      </div>
    );
  };

  if (!open) return null;
  const panelTabs = [
    { id: "takeoffs", short: "Takeoffs", title: `Takeoffs · ${multiSheet ? "these sheets" : "this sheet"}`, n: 0 },
    { id: "library", short: "Library", title: `Library${templates.length ? ` (${templates.length})` : ""}`, n: templates.length },
    { id: "materials", short: "Materials", title: `Materials${matLib.length ? ` (${matLib.length})` : ""}`, n: matLib.length },
    { id: "columns", short: "Columns", title: `Columns${conditionColumns.length ? ` (${conditionColumns.length})` : ""}`, n: conditionColumns.length },
  ];
  const activeTabLabel = panelTabs.find((t) => t.id === panelTab)?.title || "Takeoffs";
  return (
    <div ref={rootRef} className="takeoffs-panel-glass" style={{ width, flexShrink: 0, display: "flex", fontSize: 12.5 }}>
      <div onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd} onLostPointerCapture={onResizeEnd}
        title="Drag to resize"
        className="takeoffs-panel-glass-resize"
        style={{ width: 8, flexShrink: 0, cursor: "col-resize", touchAction: "none" }} />
      <div className="takeoffs-panel-glass-inner" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "row" }}>
        <nav aria-label="Takeoffs panel sections" className="takeoffs-panel-glass-tabs" style={{ width: 104, flexShrink: 0, display: "flex", flexDirection: "column" }}>
          {panelTabs.map((t) => (
            <button key={t.id} type="button" className={`takeoffs-panel-glass-tab${panelTab === t.id ? " is-active" : ""}`} onClick={() => setPanelTab(t.id)} aria-label={t.title}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, width: "100%", padding: "12px 14px 12px 16px", border: "none", cursor: "pointer", fontWeight: panelTab === t.id ? 700 : 600, fontSize: 11, fontFamily: "var(--f-mono)", letterSpacing: "0.02em", textAlign: "left", lineHeight: 1.25 }}>
              <span>{t.short}</span>
              {t.n ? <span className="takeoffs-panel-glass-tab-n">{t.n}</span> : null}
            </button>
          ))}
        </nav>
        <div className="takeoffs-panel-glass-body" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div className="takeoffs-panel-glass-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 12px", flexShrink: 0 }}>
          <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: "0.06em", fontWeight: 700, lineHeight: 1.35 }}>{activeTabLabel}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <button type="button" className={`takeoffs-panel-glass-strip${panelPrefs.strip ? " is-on" : ""}`} onClick={() => onPanelPrefs((p) => ({ ...p, strip: !p.strip }))}
              aria-label="Compact strip — also show the conditions as a horizontal strip above the canvas"
              style={{ fontSize: 9.5, fontFamily: "var(--f-mono)", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", padding: "2px 8px", lineHeight: 1.4, borderRadius: 999 }}>strip</button>
            <button type="button" className="takeoffs-panel-glass-close" onClick={onToggleCollapse} aria-label="Close panel"
              style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: "0 2px" }}>×</button>
          </span>
        </div>
        {panelTab === "takeoffs" && <>
        <div className="takeoffs-panel-glass-actions" style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--ink-faint)", flexShrink: 0 }}>
          <input name="condition-filter" className="takeoffs-panel-glass-filter" value={condQuery} onChange={(e) => setCondQuery(e.target.value)} placeholder="filter conditions…"
            style={{ flex: 1, minWidth: 0, padding: "4px 8px", borderRadius: 999, fontSize: 12 }} />
          {condQuery && <button type="button" className="takeoffs-panel-glass-clear" onClick={() => setCondQuery("")} aria-label="Clear the filter" style={btnClearX}>×</button>}
          <button type="button" className={`takeoffs-panel-glass-toggle${panelPrefs.az ? " is-on" : ""}`} onClick={() => onPanelPrefs((p) => ({ ...p, az: !p.az }))}
            aria-label="Natural sort by tag (CT-2 before CT-10) — a view; hotkeys 1–9 keep their original numbering"
            style={{ padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: 10.5, fontFamily: "var(--f-mono)", lineHeight: 1.4 }}>A→Z</button>
          <button type="button" className={`takeoffs-panel-glass-toggle${panelPrefs.group ? " is-on" : ""}`} onClick={() => onPanelPrefs((p) => ({ ...p, group: !p.group }))}
            aria-label="Group by tag family (the text before the dash: CPT, LVT, CT…)"
            style={{ padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: 10.5, fontFamily: "var(--f-mono)", lineHeight: 1.4 }}>≡ grp</button>
        </div>
        {/* bulk actions — appear while a ⌘/⇧ multi-selection is live
            (liveChecked: the count never claims ids the list lost) */}
        {liveChecked.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", borderBottom: "1px solid var(--ink-faint)", background: "var(--tint-select)", flexShrink: 0, flexWrap: "wrap", fontSize: 11 }}>
            <strong style={{ color: "var(--cobalt)" }}>{liveChecked.length} selected</strong>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title="Set the waste % on every selected condition">
              <span style={{ color: "var(--ink)", fontWeight: 600 }}>Waste</span>
              <input name="bulk-waste" type="number" min="0" step="1" value={bulkWaste} onChange={(e) => setBulkWaste(e.target.value)} placeholder="%"
                onKeyDown={(e) => e.key === "Enter" && applyBulkWaste()}
                style={{ width: 44, padding: "2px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 11 }} />
              <button onClick={applyBulkWaste} title="Apply waste % to the selection" style={{ padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 11 }}>✓</button>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title="Set the line color on every selected condition">
              {PALETTE.map((p) => <button key={p} title={p} onClick={() => onBulkColor(liveIds(), p)} style={{ width: 13, height: 13, borderRadius: 3, background: p, border: "1px solid var(--ink-faint)", cursor: "pointer", padding: 0 }} />)}
            </span>
            <button onClick={bulkDelete} title="Delete every selected condition (and their takeoffs)"
              style={{ padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Delete</button>
            <button onClick={() => setCheckedConds(new Set())} title="Clear the selection"
              style={{ marginLeft: "auto", padding: "2px 6px", border: "none", background: "none", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>✕</button>
          </div>
        )}
        <div className="takeoffs-panel-glass-scroll" style={{ flex: 1, overflow: "auto" }}>
          {conditions.length === 0 && <div style={{ padding: "12px", color: "var(--ink-muted)" }}>No conditions yet — add one and start tracing.</div>}
          {condGroups.map((g) => (
            <React.Fragment key={g.name ?? "_all"}>
              {g.name != null && (
                <div className="takeoffs-panel-glass-group" onClick={() => setClosedGroups((s) => { const n = new Set(s); if (n.has(g.name)) n.delete(g.name); else n.add(g.name); return n; })}
                  title="Collapse / expand this tag family"
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderTop: "1px solid var(--ink-faint)", cursor: "pointer", fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", userSelect: "none" }}>
                  <span style={{ width: 10, color: "var(--ink-soft)" }}>{closedGroups.has(g.name) ? "▸" : "▾"}</span>
                  <span style={{ fontWeight: 700, color: "var(--ink)" }}>{g.name}</span>
                  <span>· {g.items.length}</span>
                </div>
              )}
              {/* groupVisibleItems: a collapsed group still renders its
                  ACTIVE row (see the shared rule above visibleCondOrder) */}
              {groupVisibleItems(g).map(({ c }) => renderCondRow(c))}
            </React.Fragment>
          ))}
          {searchMiss && <div style={{ padding: "12px", color: "var(--ink-muted)" }}>No conditions match “{condQuery}”.</div>}
          <div style={{ padding: "6px 12px", borderTop: "1px solid var(--ink-faint)" }}>
            <button onClick={onAddCondition} style={{ width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--ink-muted)" }}>+ condition</button>
          </div>
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)", color: "var(--ink-muted)", fontSize: 10.5 }}>
            Select a shape on the plan, then ⧉ Copy / ⎘ Paste (⌘C / ⌘V) — it lands on the sheet under your cursor.
            <br />⌫ undo point · Esc cancel · scroll = zoom · pan mid-measure: press-and-drag (a click without dragging places the point).
          </div>
        </div>
        </>}
        {/* Library tab — reusable condition templates, browser-wide */}
        {panelTab === "library" && (
          <div style={{ flex: 1, overflow: "auto" }}>
            <div style={{ padding: "8px 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
              Reusable condition templates, shared across every plan in this browser. A fresh workspace seeds from this library (built-in flooring defaults when it's empty).
            </div>
            <div style={{ padding: "6px 12px 10px" }}>
              <button onClick={onSaveTemplate} disabled={!aCond}
                title="Snapshot the active condition (appearance, waste, H/T, materials) into the library"
                style={{ width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: aCond ? "pointer" : "default", fontSize: 12, color: aCond ? "var(--ink)" : "var(--ink-faint)" }}>
                + save {aCond?.finish_tag || "the active condition"} to the library
              </button>
            </div>
            {templates.length === 0 && <div style={{ padding: "2px 12px 12px", color: "var(--ink-muted)" }}>No templates yet — make a condition the way you like it, then save it here.</div>}
            {templates.map((t, idx) => (
              <div key={`${t.finish_tag}-${idx}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={t.hatch || "solid"} line={t.color} fill={t.fill} /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.finish_tag}</div>
                  <div style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, color: "var(--ink-muted)" }}>
                    {t.waste_pct || 0}% waste{t.height_ft != null ? ` · H ${t.height_ft}′` : ""}{t.thickness_in != null ? ` · T ${t.thickness_in}″` : ""}{t.materials?.length ? ` · ${t.materials.length} material${t.materials.length === 1 ? "" : "s"}` : ""}
                  </div>
                </div>
                <button onClick={() => { onApplyTemplate(t); setPanelTab("takeoffs"); }} title="Add a condition from this template to the takeoff"
                  style={{ flexShrink: 0, padding: "3px 8px", borderRadius: 0, border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Apply</button>
                <button onClick={() => onRenameTemplate(idx)} title="Rename this template"
                  style={{ flexShrink: 0, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                <button onClick={() => onDeleteTemplate(idx)} title="Remove this template from the library"
                  style={{ flexShrink: 0, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
              </div>
            ))}
          </div>
        )}
        {/* Materials tab — the material library (#47/#48): canonical
            consumables shared across every plan in this browser. Conditions
            COPY on attach (lib_id link); edits here never propagate unless
            explicitly pushed to linked lines. */}
        {panelTab === "materials" && (
          <div style={{ flex: 1, overflow: "auto", fontSize: 11.5 }}>
            <div style={{ padding: "8px 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
              Reusable materials, browser-wide. Attaching one to a condition copies its values and keeps a link — edits here only reach linked lines when you push them.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px 8px" }}>
              <input name="material-library-filter" value={matLibQuery} onChange={(e) => setMatLibQuery(e.target.value)} placeholder="filter materials…"
                style={{ flex: 1, minWidth: 0, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
              {matLibQuery && <button onClick={() => setMatLibQuery("")} title="Clear the filter" style={btnClearX}>×</button>}
            </div>
            {matLib.length === 0 && <div style={{ padding: "2px 12px 12px", color: "var(--ink-muted)" }}>No library materials yet — add one below, or save a condition material with the box icon.</div>}
            {matLib.filter((lm) => !matQ || (lm.name || "").toLowerCase().includes(matQ)).map((lm) => {
              const n = linkedCountById[lm.id] || 0;
              return (
                <div key={lm.id} style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {/* name is draft-buffered like per/note (round-3 finding 3): a per-keystroke
                        commit routes every transient value through libEntryPatch's rename
                        re-classification, where a select-all-retype walks the entry's kind
                        through arbitrary intermediate classifications */}
                    <LibDraftInput name="library-material-name" value={lm.name} placeholder="Material (e.g. Adhesive)" width={150}
                      onCommitText={(t) => onUpdateLibMaterial(lm.id, { name: t })} />
                    <span style={{ color: "var(--ink-soft)", fontWeight: 600 }}>1</span>
                    <input name="library-material-unit" value={lm.unit} onChange={(e) => onUpdateLibMaterial(lm.id, { unit: e.target.value })} placeholder="unit" style={{ ...ip, width: 54 }} />
                    <span style={{ color: "var(--ink-soft)", fontWeight: 600 }}>per</span>
                    <LibDraftInput name="library-material-per" number value={lm.per || ""} placeholder="0" width={62}
                      onCommitText={(t) => onUpdateLibMaterial(lm.id, { per: Math.max(0, parseFloat(t) || 0) })} />
                    <select name="library-material-basis" value={lm.basis || "area"} onChange={(e) => onUpdateLibMaterial(lm.id, { basis: e.target.value })} style={{ ...ip, background: "var(--paper-bright)" }}>
                      <option value="area">floor SF</option>
                      <option value="linear">linear LF</option>
                      <option value="count">each</option>
                    </select>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ink-muted)" }} title="Round up to whole units">
                      <input name="library-material-round" type="checkbox" checked={lm.round !== false} onChange={(e) => onUpdateLibMaterial(lm.id, { round: e.target.checked })} />round up
                    </label>
                    <CoveragePresetSelect material={lm} onPick={(patch) => onUpdateLibMaterial(lm.id, patch)} />
                    <LibDraftInput name="library-material-note" value={lm.note || ""} placeholder="note" width={120}
                      onCommitText={(t) => onUpdateLibMaterial(lm.id, { note: t })} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
                    <span style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, color: "var(--ink-muted)" }}>{n ? `⛓ ${n} linked line${n === 1 ? "" : "s"}` : "not linked yet"}</span>
                    <div style={{ flex: 1 }} />
                    {n > 0 && (
                      <button onClick={() => onPushLibUpdate(lm.id)} title="Replace the values on every linked condition line with these library values (overrides included)"
                        style={{ padding: "2px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 11 }}>update linked ({n})</button>
                    )}
                    <button onClick={() => onDeleteLibMaterial(lm.id)} title="Remove from the library — linked lines keep their values, only the link is removed"
                      style={{ padding: "2px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
                  </div>
                </div>
              );
            })}
            <div style={{ padding: "6px 12px", borderTop: matLib.length ? "1px solid var(--ink-faint)" : "none" }}>
              <button onClick={onAddLibMaterial} style={btnAddFull}>+ add library material</button>
            </div>
          </div>
        )}
        {/* Columns tab — the custom-columns manager (#31/#33): project-level
            vocabulary; per-condition assignment lives in the active row's
            properties on the Takeoffs tab */}
        {panelTab === "columns" && (
          <div style={{ flex: 1, overflow: "auto", fontSize: 11.5 }}>
            {/* Shape labels (#110) — a flat project-level vocabulary; each shape
                carries at most one label. Lives here rather than a 5th panel tab:
                it's the degenerate single-column case. */}
            <details open style={{ borderBottom: "2px solid var(--ink-faint)" }}>
              <summary style={{ padding: "8px 12px 4px", cursor: "pointer", fontWeight: 600, fontSize: 11.5 }}>
                Shape labels{shapeLabels.length ? ` (${shapeLabels.length})` : ""}
              </summary>
              <div style={{ padding: "0 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
                Phase / area labels (e.g. Phase 1, East Wing) for grouping the Report by shape.
              </div>
              <div style={{ padding: "2px 12px 10px", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {shapeLabels.map((v) => (
                  <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 3px 2px 8px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 11.5, color: "var(--ink)" }}>
                    {v}
                    <button onClick={() => onRenameLabel(v)} title="Rename this label — labeled shapes follow"
                      style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                    <button onClick={() => onRemoveLabel(v)} title="Remove from the list — labeled shapes keep the value (shown ungrouped in the Report)"
                      style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
                  </span>
                ))}
                <AddValueInput onAdd={onAddLabel} />
              </div>
            </details>
            <div style={{ padding: "8px 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
              Custom columns (e.g. CSI Division) classify conditions for report grouping and exports. Columns and values apply to the whole project; assign values on a condition in the Takeoffs tab.
            </div>
            {conditionColumns.length === 0 && <div style={{ padding: "2px 12px 8px", color: "var(--ink-muted)" }}>Add a column, e.g. CSI Division.</div>}
            {conditionColumns.map((cc) => (
              <div key={cc.id} style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <input name="column-name" value={cc.name} onChange={(e) => onRenameColumn(cc.id, e.target.value)} placeholder="Column name (e.g. CSI Division)"
                    style={{ padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12, flex: 1, minWidth: 0 }} />
                  <button onClick={() => onDeleteColumn(cc.id)} title="Delete this column (whole project)"
                    style={{ flexShrink: 0, padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 12 }}>✕ column</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {cc.values.map((v) => (
                    <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 3px 2px 8px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 11.5, color: "var(--ink)" }}>
                      {v}
                      <button onClick={() => onRenameColumnValue(cc.id, v)} title="Rename this value — assigned conditions follow"
                        style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                      <button onClick={() => onRemoveColumnValue(cc.id, v)} title="Remove from the list — conditions keep the value, shown as (removed)"
                        style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
                    </span>
                  ))}
                  <AddValueInput onAdd={(v) => onAddColumnValue(cc.id, v)} />
                </div>
              </div>
            ))}
            <div style={{ padding: "6px 12px", borderTop: conditionColumns.length ? "1px solid var(--ink-faint)" : "none" }}>
              <button onClick={onAddColumn} style={btnAddFull}>+ add column</button>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

export default React.memo(TakeoffsPanel);
