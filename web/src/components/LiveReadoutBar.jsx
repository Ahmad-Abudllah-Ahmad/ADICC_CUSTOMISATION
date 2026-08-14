// Live readout — condition totals, in-progress measure, wall openings.
// Default: glass pill in the toolbar. overlay: floating canvas text (scale-HUD language).
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../brand/icons.jsx";
import { M_PER_FT, areaVal, areaUnit, lenVal, lenUnit, calInputToFeet } from "../lib/units";
import { openLen } from "../lib/geometry.js";
import WallSegmentHeightsEditor from "./WallSegmentHeightsEditor.jsx";

const doorScheduleTriggerStyle = {
  width: "100%",
  marginBottom: 6,
  fontSize: 11,
  padding: "3px 4px",
  border: "1px solid var(--ink-faint)",
  background: "var(--paper)",
  textAlign: "left",
  cursor: "pointer",
  fontFamily: "inherit",
  color: "var(--ink)",
  display: "block",
  boxSizing: "border-box",
};

/** Portaled menu — native <select> fails inside toolbar glass/backdrop on some laptops. */
function DoorSchedulePicker({ options, onPick }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState(null);

  const placeMenu = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setMenuStyle({
      position: "fixed",
      left: r.left,
      top: r.bottom + 2,
      width: r.width,
      maxHeight: Math.max(120, Math.min(280, window.innerHeight - r.bottom - 12)),
      zIndex: 10000,
      overflowY: "auto",
      overscrollBehavior: "contain",
      background: "var(--paper-bright)",
      border: "1px solid var(--ink-faint)",
      boxShadow: "var(--shadow-2)",
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    placeMenu();
    const onReflow = () => placeMenu();
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
        aria-label="Prefill opening from door schedule"
        aria-haspopup="listbox"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={doorScheduleTriggerStyle}
      >
        Add from door schedule…
      </button>
      {open && menuStyle && createPortal(
        <div ref={menuRef} data-door-schedule-menu role="listbox" style={menuStyle}>
          {options.map((o) => (
            <button
              key={o.tag}
              type="button"
              role="option"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onPick(o);
                setOpen(false);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                border: "none",
                borderBottom: "1px solid var(--ink-faint)",
                background: "transparent",
                cursor: "pointer",
                fontSize: 11,
                fontFamily: "var(--f-mono)",
                color: "var(--ink)",
              }}
            >
              {o.tag}{o.size ? ` · ${o.size}` : ""}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export default function LiveReadoutBar({
  overlay = false,
  tool,
  aCond,
  activeCond,
  units,
  unitsPerPx,
  poly,
  liveUpp,
  liveArea,
  livePerim,
  zoneTraceCross,
  condH,
  proposal,
  wallProposal,
  ocSel,
  selShape,
  doorScheduleOptions,
  condRow,
  condMult,
  condTotal,
  wallTotal,
  floorBeforeDeduction = 0,
  floorAfterDeduction = 0,
  wallBeforeDeduction = 0,
  wallAfterDeduction = 0,
  borderTotal,
  lfTotal,
  countTotal,
  vertTotal,
  sheetFloorSf,
  sheetWallSf,
  visibleShapeCount,
  groupKeyCount,
  zoomScale,
  onSetShapeHeight,
  onClearShapeHeight,
  wallSegmentRows = [],
  onSetSegmentHeight,
  onFlyToWallSegment,
  activeWallSegment = null,
  onAddWallOpening,
  onStartWallCutout,
  onUpdateWallOpening,
  onRemoveWallOpening,
  onFlyToWallOpening,
}) {
  const num = (v, d = 1) => v.toLocaleString(undefined, { maximumFractionDigits: d });
  const fa = (sf, d = 1) => `${num(areaVal(sf, units), d)} ${areaUnit(units)}`;
  const fl = (lf, d = 1) => `${num(lenVal(lf, units), d)} ${lenUnit(units)}`;

  const showWallOpenings = selShape?.measure_role === "surface_area" || selShape?.measure_role === "wall_area";

  const expandedWall = showWallOpenings && wallSegmentRows.length > 1;

  const hasLive = !!(
    (tool === "oneclick" && proposal?.regions.length)
    || (tool === "walltrace" && wallProposal?.regions.length)
    || ((tool === "surface" || tool === "wallarea") && poly.length >= 2 && liveUpp)
    || (tool === "zone" && poly.length >= 1)
    || (liveArea != null && poly.length >= 3)
    || (tool !== "oneclick" && proposal?.regions.length > 0)
    || (tool !== "walltrace" && wallProposal?.regions.length > 0)
    || showWallOpenings
    || floorBeforeDeduction > 0 || floorAfterDeduction !== 0
    || wallBeforeDeduction > 0 || wallAfterDeduction > 0
  );

  if (overlay && !hasLive) return null;

  return (
    <div
      className={`live-readout-stack${overlay ? " live-readout-stack--overlay" : ""}${overlay && hasLive ? " has-focus" : ""}${expandedWall ? " is-wide" : ""}`}
      style={overlay ? undefined : { position: "absolute", top: 0, left: 0, zIndex: showWallOpenings ? 200 : 25, overflow: "visible", width: expandedWall ? 320 : 268, minWidth: expandedWall ? 300 : 220, maxWidth: expandedWall ? 360 : 280, fontVariantNumeric: "tabular-nums" }}
    >
      <div
        className={overlay ? "live-readout-bar live-readout-bar--overlay" : "toolbar-glass-pill live-readout-bar"}
        style={overlay ? undefined : {
          display: "flex",
          flexDirection: "column",
          borderRadius: showWallOpenings ? "14px 14px 0 0" : 14,
          padding: "3px 10px 6px",
          minHeight: 72,
          height: "auto",
          overflow: "visible",
          borderBottom: showWallOpenings ? "none" : undefined,
        }}
      >
        <div>
          {tool === "oneclick" && proposal?.regions.length ? (() => {
            const pos = proposal.regions.filter((r) => r.kind === "pos");
            const neg = proposal.regions.filter((r) => r.kind === "neg");
            const sf = pos.reduce((n, r) => n + r.area_sf, 0) - neg.reduce((n, r) => n + r.area_sf, 0);
            return (
              <>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--cobalt)" }}>{num(areaVal(sf, units))} <span style={{ fontSize: 13, fontWeight: 600 }}>{areaUnit(units)} selected</span></div>
                <div style={{ fontSize: 12.5, color: "var(--ink-secondary)", marginTop: 2 }}>{pos.length} space{pos.length === 1 ? "" : "s"}{neg.length ? ` − ${neg.length} cutout${neg.length === 1 ? "" : "s"}` : ""}{units === "metric" ? "" : ` · ${num(sf / 9)} SY`}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 4 }}>{ocSel ? "drag to move · Delete drops this point · Esc deselects" : "hover a fill to edit: drag a corner or edge · shift-click an edge adds a point"}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>click adds a space · ⌥-click carves a cutout · ⏎ Create · ⌫ undo · Esc cancel</div>
                {proposal.regions.some((r) => r.rt) && (
                  <div style={{ fontSize: 11.5, color: "var(--c-warning)", marginTop: 4 }}>Traced from scan pixels — verify edges before Create.</div>
                )}
              </>
            );
          })() : tool === "walltrace" && wallProposal?.regions.length ? (() => {
            const face = wallProposal.regions.reduce((n, r) => n + r.wall_face_sf, 0);
            const fp = wallProposal.regions.reduce((n, r) => n + r.footprint_sf, 0);
            const vol = wallProposal.regions.reduce((n, r) => n + r.volume_cf, 0);
            return (
              <>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--cobalt)" }}>{num(areaVal(face, units))} <span style={{ fontSize: 13, fontWeight: 600 }}>{areaUnit(units)} face</span></div>
                <div style={{ fontSize: 12.5, color: "var(--ink-secondary)", marginTop: 2 }}>{num(areaVal(fp, units))} {areaUnit(units)} footprint · {num(vol, 1)} CF · {wallProposal.regions.length} network{wallProposal.regions.length === 1 ? "" : "s"}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 4 }}>click adds a wall island · ⏎ Create · Esc cancel</div>
                {wallProposal.regions.some((r) => r.hf) && (
                  <div style={{ fontSize: 11.5, color: "var(--c-warning)", marginTop: 4 }}>Hatch-filled walls included — verify edges before Create.</div>
                )}
              </>
            );
          })() : (tool === "surface" || tool === "wallarea") && poly.length >= 2 && liveUpp ? (
            (() => {
              const liveLF = openLen(poly) * liveUpp;
              return condH > 0 ? (
                <>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ink)" }}>{num(areaVal(liveLF * condH, units))} <span style={{ fontSize: 13, fontWeight: 600 }}>{areaUnit(units)} wall</span></div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-secondary)", marginTop: 2 }}>{fl(liveLF)} × {num(condH, 2)} ft</div>
                </>
              ) : <div style={{ fontSize: 12.5, color: "var(--c-danger)" }}>Set a height for {aCond?.finish_tag || "this condition"} — H in the condition editor</div>;
            })()
          ) : tool === "zone" && poly.length >= 1 ? (
            zoneTraceCross ? (
              <span style={{ color: "var(--c-danger)", fontSize: 12.5 }}>Zone on one sheet — that point landed on a different sheet. Finish is disabled; Esc or Undo last point to fix it.</span>
            ) : (
              <>
                {liveArea != null && poly.length >= 3 && <div style={{ fontSize: 22, fontWeight: 700, color: "var(--cobalt)" }}>{num(areaVal(liveArea, units))} <span style={{ fontSize: 13, fontWeight: 600 }}>{areaUnit(units)} in zone</span></div>}
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 4 }}>⏎, double-click, or the Finish button closes the zone and lists everything inside · Esc cancels</div>
              </>
            )
          ) : liveArea != null && poly.length >= 3 ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 700, color: tool === "deduct" ? "var(--c-danger)" : "var(--ink)" }}>{tool === "deduct" ? "−" : ""}{num(areaVal(liveArea, units))} <span style={{ fontSize: 13, fontWeight: 600 }}>{areaUnit(units)}</span></div>
              <div style={{ fontSize: 12.5, color: "var(--ink-secondary)", marginTop: 2 }}>{units === "metric" ? `${fl(livePerim)} perim` : `${num(liveArea / 9)} SY  ·  ${num(livePerim)} LF perim`}</div>
              {condH > 0 && <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>@H {num(condH, 2)}′: {fa(livePerim * condH)} vert{units === "metric" ? "" : ` · ${num((liveArea * condH) / 27)} CY`}</div>}
            </>
          ) : null}
          {tool !== "oneclick" && proposal?.regions.length > 0 && (() => {
            const pos = proposal.regions.filter((r) => r.kind === "pos");
            const neg = proposal.regions.filter((r) => r.kind === "neg");
            const sf = pos.reduce((n, r) => n + r.area_sf, 0) - neg.reduce((n, r) => n + r.area_sf, 0);
            return (
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--divider-soft)" }}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--ink-muted)" }}>Pending rooms</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--cobalt)", marginTop: 2 }}>{num(areaVal(sf, units))} {areaUnit(units)} · {pos.length} space{pos.length === 1 ? "" : "s"}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>Switch to One-Click (O) or press Create rooms</div>
              </div>
            );
          })()}
          {tool !== "walltrace" && wallProposal?.regions.length > 0 && (() => {
            const face = wallProposal.regions.reduce((n, r) => n + r.wall_face_sf, 0);
            return (
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--divider-soft)" }}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--ink-muted)" }}>Pending walls</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--cobalt)", marginTop: 2 }}>{num(areaVal(face, units))} {areaUnit(units)} face · {wallProposal.regions.length} network{wallProposal.regions.length === 1 ? "" : "s"}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>Switch to Wall Trace (W) or press Create walls</div>
              </div>
            );
          })()}
          {showWallOpenings && (
            <div className="live-readout-interactive" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, marginBottom: 6 }}>
              {selShape?.measure_role === "surface_area" && wallSegmentRows.length > 1 ? (
                <WallSegmentHeightsEditor
                  compact
                  rows={wallSegmentRows}
                  units={units}
                  condH={condH}
                  activeIndex={activeWallSegment}
                  onSetHeight={onSetSegmentHeight}
                  onFlyToSegment={onFlyToWallSegment}
                />
              ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }} title="Height for THIS wall only. ↺ returns to the condition height.">
                <Icon name="height" size={12} />
                <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>wall H</span>
                <input name="shape-height-ft" type="number" min="0" step="0.25" value={selShape.height_ft ?? ""}
                  onChange={(e) => onSetShapeHeight(e.target.value)}
                  style={{ width: 48, padding: "2px 4px", border: "1px solid var(--ink-faint)", fontSize: 12 }} />
                {condH > 0 && Number(selShape.height_ft) !== condH && (
                  <button type="button" onClick={onClearShapeHeight} title="Set this wall to the condition height" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: 0 }}>↺</button>
                )}
              </div>
              </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
                <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--ink-muted)" }}>Door openings</span>
                <button
                  type="button"
                  onClick={() => {
                    if (selShape?.measure_role === "wall_area" && onStartWallCutout) onStartWallCutout();
                    else onAddWallOpening({ source: "cutout" });
                  }}
                  title={selShape?.measure_role === "wall_area"
                    ? "Add a custom cutout — click two points on the wall area line (snaps to that line)"
                    : "Add a custom wall cutout (W × H) subtracted from wall face"}
                  style={{ border: "1px solid var(--ink-faint)", background: "var(--paper)", fontSize: 11, padding: "1px 7px", cursor: "pointer" }}
                >
                  + Add
                </button>
              </div>
            </div>
          )}
          {(floorBeforeDeduction > 0 || floorAfterDeduction !== 0 || wallBeforeDeduction > 0 || wallAfterDeduction > 0) && (
            <div style={{ marginTop: 3, display: "flex", flexDirection: showWallOpenings ? "column" : "row", flexWrap: "wrap", alignItems: "baseline", gap: showWallOpenings ? 2 : "0 8px" }}>
              {(floorBeforeDeduction > 0 || floorAfterDeduction !== 0) && (
                <div style={{ fontSize: 11.5, lineHeight: 1.35, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "0 4px" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.35, color: "var(--ink-muted)" }}>Floor</span>
                  <span style={{ fontWeight: 700 }}>{fa(floorBeforeDeduction)}</span>
                  <span style={{ color: "var(--ink-muted)", fontWeight: 500 }}>→</span>
                  <span style={{ fontWeight: 700 }}>{fa(floorAfterDeduction)}</span>
                  {units === "imperial" && floorAfterDeduction > 0 && (
                    <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--ink-secondary)" }}>({num(floorAfterDeduction / 9)} SY)</span>
                  )}
                </div>
              )}
              {!showWallOpenings && (floorBeforeDeduction > 0 || floorAfterDeduction !== 0) && (wallBeforeDeduction > 0 || wallAfterDeduction > 0) && (
                <span style={{ fontWeight: 500, color: "var(--ink-muted)" }}>|</span>
              )}
              {(wallBeforeDeduction > 0 || wallAfterDeduction > 0) && (
                <div style={{ fontSize: 11.5, lineHeight: 1.35, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "0 4px" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.35, color: "var(--ink-muted)" }}>Wall</span>
                  <span style={{ fontWeight: 700 }}>{fa(wallBeforeDeduction)}</span>
                  <span style={{ color: "var(--ink-muted)", fontWeight: 500 }}>→</span>
                  <span style={{ fontWeight: 700 }}>{fa(wallAfterDeduction)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {showWallOpenings && (
        <div
          className={`live-readout-interactive live-readout-wall-openings${overlay ? "" : " toolbar-glass-pill"}`}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 200,
            borderRadius: "0 0 14px 14px",
            padding: "8px 10px 10px",
            overflow: "visible",
            borderTop: "1px solid var(--divider-soft)",
            marginTop: -1,
            background: "var(--paper-bright)",
            backdropFilter: "none",
            WebkitBackdropFilter: "none",
            userSelect: "auto",
            WebkitUserSelect: "auto",
            isolation: "isolate",
          }}
        >
          {doorScheduleOptions.length > 0 && (
            <DoorSchedulePicker
              options={doorScheduleOptions}
              onPick={(opt) => onAddWallOpening({
                tag: opt.tag,
                kind: opt.kind || "door",
                size: opt.size || "",
                symbol_id: opt.symbol_id || "",
                source: "schedule",
              })}
            />
          )}
          {(selShape.openings || []).length === 0 && (
            <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>No openings — wall face is full height × length.</div>
          )}
          {(selShape.openings || []).map((opn, opnIdx) => {
            const wDisp = units === "metric" ? (Number(opn.width_ft) || 0) * M_PER_FT : (Number(opn.width_ft) || 0);
            const hDisp = units === "metric" ? (Number(opn.height_ft) || 0) * M_PER_FT : (Number(opn.height_ft) || 0);
            const dimUnit = units === "metric" ? "m" : "ft";
            const cutN = (selShape.openings || []).filter((o) => o.source === "cutout").length;
            const cutIdx = opn.source === "cutout"
              ? (selShape.openings || []).slice(0, opnIdx + 1).filter((o) => o.source === "cutout").length
              : 0;
            const openingLabel = opn.source === "cutout"
              ? (cutN > 1 ? `custom cut ${cutIdx}` : "custom cut")
              : (opn.tag || "Door");
            return (
              <div key={opn.id} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                <button
                  type="button"
                  title={opn.source === "cutout" ? "Go to this cutout on the plan" : "Go to this door on the plan"}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFlyToWallOpening(opn, selShape); }}
                  style={{
                    border: "none", background: "none", padding: 0, cursor: "pointer",
                    fontSize: 11, fontWeight: 700, minWidth: 28, color: "var(--cobalt)",
                    textDecoration: "underline", textUnderlineOffset: 2, fontFamily: "inherit",
                  }}
                >
                  {openingLabel}
                </button>
                <input
                  name={`opening-w-${opn.id}`}
                  type="number"
                  min="0"
                  step={units === "metric" ? 0.01 : 0.05}
                  value={Number.isFinite(wDisp) ? +wDisp.toFixed(units === "metric" ? 3 : 2) : ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const ft = units === "metric" ? calInputToFeet(parseFloat(raw) || 0, units) : Math.max(0, parseFloat(raw) || 0);
                    onUpdateWallOpening(opn.id, {
                      width_ft: ft,
                      ...(opn.source === "cutout" ? {} : { source: "manual" }),
                    });
                  }}
                  title={`Opening width (${dimUnit})`}
                  style={{ width: 52, padding: "2px 4px", border: "1px solid var(--ink-faint)", fontSize: 11 }}
                />
                <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>×</span>
                <input
                  name={`opening-h-${opn.id}`}
                  type="number"
                  min="0"
                  step={units === "metric" ? 0.01 : 0.05}
                  value={Number.isFinite(hDisp) ? +hDisp.toFixed(units === "metric" ? 3 : 2) : ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const ft = units === "metric" ? calInputToFeet(parseFloat(raw) || 0, units) : Math.max(0, parseFloat(raw) || 0);
                    onUpdateWallOpening(opn.id, {
                      height_ft: ft,
                      ...(opn.source === "cutout" ? {} : { source: "manual" }),
                    });
                  }}
                  title={`Opening height (${dimUnit})`}
                  style={{ width: 52, padding: "2px 4px", border: "1px solid var(--ink-faint)", fontSize: 11 }}
                />
                <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>{dimUnit}</span>
                <button
                  type="button"
                  onClick={() => onRemoveWallOpening(opn.id)}
                  title="Remove opening"
                  style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: "0 2px", fontSize: 14, lineHeight: 1 }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
