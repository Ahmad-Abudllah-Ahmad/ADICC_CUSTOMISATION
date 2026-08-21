// Hover card — BOQ summary for a masked area; double-click mask to pin, then open BOQ.
import React, { useState } from "react";
import { areaUnit, lenUnit, areaVal, lenVal } from "../lib/units";

const num = (v, d = 2) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });
const dash = "—";

function BoqField({ label, value, mono = true, allowZero = false, bold = false, color = "var(--ink)", indent = false }) {
  const empty = value == null || value === "" || (!allowZero && value === 0);
  return (
    <div style={{ display: "grid", gridTemplateColumns: indent ? "12px 70px 1fr" : "80px 1fr", gap: 6, alignItems: "baseline" }}>
      {indent && <span style={{ color: "var(--ink-muted)", fontSize: 10 }}>↳</span>}
      <span style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: bold ? 700 : 500 }}>{label}</span>
      <span style={{ fontFamily: mono ? "var(--f-mono)" : "inherit", fontSize: 11.5, color: empty ? "var(--ink-faint)" : color, fontWeight: bold ? 700 : (empty ? 400 : 600), textAlign: "right" }}>
        {empty ? dash : value}
      </span>
    </div>
  );
}

/** Takeoff math is feet/SF; convert for display when project units are metric. */
function displayArea(sf, units) {
  return areaVal(Number(sf) || 0, units);
}
function displayLen(lf, units) {
  return lenVal(Number(lf) || 0, units);
}
function displayQty(qty, unit, units) {
  const u = String(unit || "").toLowerCase();
  if (u.includes("m²") || u.includes("m2") || u === "sf" || u === "sq ft" || u === "sqft") {
    return displayArea(qty, units);
  }
  if (u === "m" || u === "lf" || u === "lm") return displayLen(qty, units);
  return Number(qty) || 0;
}

function FinishDetailRow({ label, value }) {
  const empty = !value;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: 6, alignItems: "baseline" }}>
      <span style={{ fontSize: 10.5, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ color: empty ? "var(--ink-faint)" : "var(--ink)", lineHeight: 1.35, fontSize: 11.5 }}>{empty ? dash : value}</span>
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
  onDeductDoor,
  onMove,
  onClose,
  onPointerEnter,
  onPointerLeave,
  onOpenFinishSource,
  onUpdateHeight,
  onUpdateRate,
}) {
  const [showFinishDetails, setShowFinishDetails] = useState(false);
  const [rateInput, setRateInput] = useState(data?.rate != null ? String(data.rate) : "");

  if (!data) return null;
  const aU = areaUnit(units);
  const lU = lenUnit(units);

  const doorRefs = (data.schedule_refs || []).filter(
    (r) => (r.kind === "door" || r.kind === "window") && r.symbol_id,
  );

  const isFloorMask = data.role === "floor_area";
  const showWall = data.role === "surface_area" || data.role === "wall_area" || isFloorMask;
  const showFloor = isFloorMask || data.role === "deduct" || (Number(data.floor_sf) || 0) > 0;
  const showCeiling = isFloorMask || (Number(data.floor_sf) || 0) > 0;

  const floorGross = Number(data.floor_gross_sf) || Number(data.floor_sf) || 0;
  const floorOpenings = Number(data.floor_openings_sf) || 0;
  const floorNet = Number(data.floor_net_sf) || Number(data.floor_sf) || 0;

  const wallGross = Number(data.gross_wall_sf) || 0;
  const doorsDeduct = Number(data.doors_deduct_sf) || 0;
  const windowsDeduct = Number(data.windows_deduct_sf) || 0;
  const wallNet = Number(data.wall_sf) || 0;

  const ceilingGross = Number(data.ceiling_gross_sf) || floorGross;
  const ceilingOpenings = Number(data.ceiling_openings_sf) || floorOpenings;
  const ceilingNet = Number(data.ceiling_net_sf) || floorNet;

  const skirtingGross = Number(data.skirting_gross_lf) || Number(data.lf) || 0;
  const skirtingDeduct = Number(data.skirting_door_deduct_lf) || 0;
  const skirtingNet = Number(data.skirting_net_lf) || Math.max(0, skirtingGross - skirtingDeduct);

  const finishDetails = isFloorMask ? data.finish_details : null;
  const finishFieldRows = finishDetails
    ? [
      ["Room name", finishDetails.room_name],
      ["Type", finishDetails.type],
      ["Floor finish", finishDetails.floor_finish],
      ["Skirting", finishDetails.skirting],
      ["Wall finishes", finishDetails.wall_finishes],
      ["Ceiling", finishDetails.ceiling],
      ["Size / opening", finishDetails.size],
      ["Fire rating", finishDetails.fire_rating],
      ["Floors", finishDetails.floors],
      ["Manufacturer", finishDetails.manufacturer],
      ["Style", finishDetails.style],
      ["Color", finishDetails.color],
      ["Remarks", finishDetails.remarks],
    ]
    : [];

  const currentRate = rateInput !== "" ? Number(rateInput) : (data.rate != null ? Number(data.rate) : 0);
  const computedAmount = currentRate > 0 ? +(displayQty(data.qty, data.unit, units) * currentRate).toFixed(2) : (data.amount || 0);

  return (
    <div
      data-hover-scroll
      style={{
        position: "absolute", left, top, zIndex: 12, width: 280,
        maxHeight: pinned ? "min(520px, calc(100vh - 100px))" : "min(460px, calc(100vh - 100px))",
        overflowY: "auto",
        overscrollBehavior: "contain",
        background: "var(--paper-bright)", border: pinned ? "2px solid var(--cobalt)" : "1px solid var(--ink)",
        boxShadow: "var(--shadow-2)", pointerEvents: "auto", fontFamily: "var(--f-body)",
        fontSize: 12, color: "var(--ink)",
        borderRadius: 4,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {/* Header */}
      <div
        title="Drag to move"
        style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px 6px", borderBottom: "1px solid var(--ink-faint)", cursor: "grab", userSelect: "none" }}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target.closest("button, input")) return;
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
            Takeoff Item{pinned ? " · Pinned" : ""}
          </div>
          {data.room ? (
            <div style={{ fontFamily: "var(--f-display)", fontWeight: 700, fontSize: 14, lineHeight: 1.25, marginBottom: 2 }}>{data.room}</div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-muted)", fontStyle: "italic", marginBottom: 2 }}>Room not detected</div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: data.color, flexShrink: 0 }} />
            <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: 12, letterSpacing: "0.04em", color: "var(--cobalt)", background: "rgba(31, 63, 199, 0.08)", padding: "1px 6px", borderRadius: 3 }}>
              {data.finish_tag || dash}
            </span>
            {data.needs_review && (
              <span
                title={data.review_reason || "Please review"}
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  color: "var(--c-warning, #d97706)",
                  background: "rgba(217, 119, 6, 0.12)",
                  border: "1px solid rgba(217, 119, 6, 0.3)",
                  borderRadius: 3,
                  padding: "1px 4px",
                }}
              >
                ⚠ Review
              </span>
            )}
          </div>
          {data.description && (
            <div style={{ fontSize: 10.5, color: "var(--ink-muted)", marginTop: 3, lineHeight: 1.3 }}>
              {data.description}
            </div>
          )}
        </div>
        {pinned ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); onClose?.(); }} title="Close"
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-muted)", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
        ) : (
          <span style={{ fontSize: 9.5, color: "var(--ink-muted)", whiteSpace: "nowrap" }}>dbl-click pin</span>
        )}
      </div>

      {/* Blueprint 6-Tier Breakdown */}
      <div style={{ padding: "8px 12px", display: "grid", gap: 8 }}>
        {/* 1. Floor Area */}
        {showFloor && (
          <div style={{ background: "rgba(0,0,0,0.02)", padding: "6px 8px", borderRadius: 4, border: "1px solid var(--ink-faint)", display: "grid", gap: 3 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--cobalt)", display: "flex", justifyContent: "space-between" }}>
              <span>* Floor Area</span>
              <span style={{ fontFamily: "var(--f-mono)" }}>{num(displayArea(floorNet, units))} {aU}</span>
            </div>
            {floorOpenings > 0 && (
              <>
                <BoqField label="Gross Area" value={`${num(displayArea(floorGross, units))} ${aU}`} indent allowZero />
                <BoqField label="Openings" value={`−${num(displayArea(floorOpenings, units))} ${aU}`} indent color="var(--c-danger, #b03a26)" allowZero />
                <BoqField label="Area Net" value={`${num(displayArea(floorNet, units))} ${aU}`} indent bold allowZero />
              </>
            )}
          </div>
        )}

        {/* 2. Wall Area */}
        {showWall && (
          <div style={{ background: "rgba(0,0,0,0.02)", padding: "6px 8px", borderRadius: 4, border: "1px solid var(--ink-faint)", display: "grid", gap: 3 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--cobalt)", display: "flex", justifyContent: "space-between" }}>
              <span>* Wall Area</span>
              <span style={{ fontFamily: "var(--f-mono)" }}>{num(displayArea(wallNet, units))} {aU}</span>
            </div>
            <BoqField label="Gross Area" value={`${num(displayArea(wallGross, units))} ${aU}`} indent allowZero />
            {doorsDeduct > 0 && (
              <BoqField label="Doors" value={`−${num(displayArea(doorsDeduct, units))} ${aU}`} indent color="var(--c-danger, #b03a26)" allowZero />
            )}
            {windowsDeduct > 0 && (
              <BoqField label="Windows" value={`−${num(displayArea(windowsDeduct, units))} ${aU}`} indent color="var(--c-danger, #b03a26)" allowZero />
            )}
            <BoqField label="Area Net" value={`${num(displayArea(wallNet, units))} ${aU}`} indent bold allowZero />

            {/* Height Presets */}
            {onUpdateHeight && (
              <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px dashed var(--ink-faint)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                  <span style={{ fontSize: 9.5, color: "var(--ink-muted)", fontWeight: 600 }}>Wall Height:</span>
                  <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, fontWeight: 700, color: "var(--cobalt)" }}>
                    {data.height_ft ? `${num(displayLen(data.height_ft, units))} ${lU}` : ""}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                  {(units === "metric"
                    ? [
                        { label: "2.4m", ft: 2.4 / 0.3048 },
                        { label: "2.7m", ft: 2.7 / 0.3048 },
                        { label: "3.0m", ft: 3.0 / 0.3048 },
                        { label: "3.5m", ft: 3.5 / 0.3048 },
                        { label: "4.0m", ft: 4.0 / 0.3048 },
                      ]
                    : [
                        { label: "8'", ft: 8 },
                        { label: "9'", ft: 9 },
                        { label: "10'", ft: 10 },
                        { label: "12'", ft: 12 },
                        { label: "14'", ft: 14 },
                      ]
                  ).map((p) => {
                    const isActive = data.height_ft && Math.abs(data.height_ft - p.ft) < 0.15;
                    return (
                      <button
                        key={p.label}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onUpdateHeight(p.ft);
                        }}
                        style={{
                          padding: "2px 5px",
                          fontSize: 9,
                          fontWeight: isActive ? 700 : 500,
                          borderRadius: 3,
                          border: isActive ? "1px solid var(--cobalt)" : "1px solid var(--ink-faint)",
                          background: isActive ? "var(--cobalt)" : "var(--paper-cream)",
                          color: isActive ? "var(--accent-contrast, #fff)" : "var(--ink)",
                          cursor: "pointer",
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 3. Ceiling Area */}
        {showCeiling && (
          <div style={{ background: "rgba(0,0,0,0.02)", padding: "6px 8px", borderRadius: 4, border: "1px solid var(--ink-faint)", display: "grid", gap: 3 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--cobalt)", display: "flex", justifyContent: "space-between" }}>
              <span>* Ceiling Area</span>
              <span style={{ fontFamily: "var(--f-mono)" }}>{num(displayArea(ceilingNet, units))} {aU}</span>
            </div>
            {ceilingOpenings > 0 && (
              <>
                <BoqField label="Gross Area" value={`${num(displayArea(ceilingGross, units))} ${aU}`} indent allowZero />
                <BoqField label="Opening" value={`−${num(displayArea(ceilingOpenings, units))} ${aU}`} indent color="var(--c-danger, #b03a26)" allowZero />
                <BoqField label="Area Net" value={`${num(displayArea(ceilingNet, units))} ${aU}`} indent bold allowZero />
              </>
            )}
          </div>
        )}

        {/* 4. Skirting (Net LM) */}
        {skirtingGross > 0 && (
          <div style={{ background: "rgba(0,0,0,0.02)", padding: "6px 8px", borderRadius: 4, border: "1px solid var(--ink-faint)", display: "grid", gap: 3 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--cobalt)", display: "flex", justifyContent: "space-between" }}>
              <span>* Skirting</span>
              <span style={{ fontFamily: "var(--f-mono)" }}>{num(displayLen(skirtingNet, units))} {lU}</span>
            </div>
            <BoqField label="Perimeter" value={`${num(displayLen(skirtingGross, units))} ${lU}`} indent allowZero />
            {skirtingDeduct > 0 && (
              <BoqField label="Opening" value={`−${num(displayLen(skirtingDeduct, units))} ${lU}`} indent color="var(--c-danger, #b03a26)" allowZero />
            )}
            <BoqField label="Net LM" value={`${num(displayLen(skirtingNet, units))} ${lU}`} indent bold allowZero />
          </div>
        )}

        {/* 5. Door / Window Mark Itemization */}
        {((data.doors && data.doors.length > 0) || (data.windows && data.windows.length > 0)) && (
          <div style={{ display: "grid", gap: 4 }}>
            {data.doors?.map((d, i) => (
              <div key={`d-${i}`} style={{ fontSize: 10.5, display: "flex", justifyContent: "space-between", color: "var(--ink)" }}>
                <span>* Door <b>{d.tag}</b></span>
                <span style={{ fontFamily: "var(--f-mono)", color: "var(--c-danger, #b03a26)" }}>
                  −{num(displayArea(d.sf, units))} {aU}
                </span>
              </div>
            ))}
            {data.windows?.map((w, i) => (
              <div key={`w-${i}`} style={{ fontSize: 10.5, display: "flex", justifyContent: "space-between", color: "var(--ink)" }}>
                <span>* Window <b>{w.tag}</b></span>
                <span style={{ fontFamily: "var(--f-mono)", color: "var(--c-danger, #b03a26)" }}>
                  −{num(displayArea(w.sf, units))} {aU}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 6. Quantity & Manual Costing */}
        <div style={{ borderTop: "1px solid var(--ink-faint)", paddingTop: 6, display: "grid", gap: 5 }}>
          <BoqField label="Takeoff Qty" value={`${num(displayQty(data.qty, data.unit, units))} ${data.unit}`} bold />

          <div style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>Unit Rate</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="number"
                step="any"
                placeholder="0.00"
                value={rateInput}
                onChange={(e) => {
                  setRateInput(e.target.value);
                  onUpdateRate?.(e.target.value);
                }}
                style={{
                  width: "100%",
                  padding: "3px 6px",
                  fontSize: 11.5,
                  fontFamily: "var(--f-mono)",
                  textAlign: "right",
                  border: "1px solid var(--ink-faint)",
                  borderRadius: 3,
                  background: "var(--paper-bright)",
                }}
              />
              <span style={{ fontSize: 10, color: "var(--ink-muted)", fontWeight: 600 }}>{data.currency || "AED"}</span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: 6, alignItems: "baseline", background: "rgba(31, 63, 199, 0.05)", padding: "4px 6px", borderRadius: 3 }}>
            <span style={{ fontSize: 10, color: "var(--cobalt)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>Total Cost</span>
            <span style={{ fontFamily: "var(--f-mono)", fontSize: 13, fontWeight: 700, color: "var(--cobalt)", textAlign: "right" }}>
              {computedAmount > 0 ? `${num(computedAmount)} ${data.currency || "AED"}` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Door cut actions */}
      {doorRefs.length > 0 && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)", display: "grid", gap: 6 }}>
          {doorRefs.slice(0, 4).map((ref) => (
            <div key={ref.symbol_id || `${ref.tag}-${ref.source}`} style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
              {onDeductDoor && (data.role === "surface_area" || data.role === "wall_area") && (
                <button
                  type="button"
                  title={`Cut out ${ref.tag} from this wall — deducts opening from wall face`}
                  onClick={(e) => { e.stopPropagation(); onDeductDoor(ref); }}
                  style={{
                    flex: 1, minWidth: 0,
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                    padding: "6px 4px",
                    border: "1px solid var(--cobalt)", borderRadius: 4,
                    background: "var(--cobalt)", color: "var(--accent-contrast, #fff)",
                    cursor: "pointer", fontWeight: 600, fontSize: 10, fontFamily: "inherit",
                  }}
                >
                  Cut out · {ref.tag}
                </button>
              )}
              <button
                type="button"
                title={`Open ${ref.tag} on plan`}
                onClick={(e) => { e.stopPropagation(); onOpenDoorDetect?.(ref); }}
                style={{
                  flex: 1, minWidth: 0,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                  padding: "6px 4px",
                  border: "1px solid var(--ink-faint)", borderRadius: 4,
                  background: "var(--paper)", color: "var(--ink)",
                  cursor: "pointer", fontWeight: 600, fontSize: 10, fontFamily: "inherit",
                }}
              >
                {ref.kind === "window" ? "Window" : "Door"}
                <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700 }}>· {ref.tag}</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Finish Details collapsible */}
      {isFloorMask && finishDetails && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowFinishDetails((v) => !v); }}
            style={{
              display: "block", width: "100%", padding: "6px 12px", border: "none",
              borderTop: "1px solid var(--ink-faint)", background: showFinishDetails ? "var(--paper-cream)" : "transparent",
              fontSize: 10, color: "var(--ink)", fontWeight: 600, textAlign: "center",
              cursor: "pointer", fontFamily: "inherit",
            }}
          >
            {showFinishDetails ? "Hide schedule specs" : "View schedule specs"}
          </button>
          {showFinishDetails && (
            <div style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)", display: "grid", gap: 5, background: "var(--paper-shadow)" }}>
              {finishFieldRows.map(([label, value]) => (
                <FinishDetailRow key={label} label={label} value={value} />
              ))}
              {finishDetails.source && (
                <div style={{ marginTop: 4, paddingTop: 6, borderTop: "1px solid var(--ink-faint)" }}>
                  <div style={{ fontSize: 9.5, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>Source</div>
                  {finishDetails.source_sheet && onOpenFinishSource ? (
                    <button type="button" onClick={(e) => { e.stopPropagation(); onOpenFinishSource(finishDetails); }}
                      title="Open finish schedule PDF"
                      style={{
                        display: "block", width: "100%", textAlign: "left", padding: 0, border: "none",
                        background: "transparent", cursor: "pointer", fontSize: 11, color: "var(--ink)",
                        lineHeight: 1.35, fontFamily: "inherit", textDecoration: "underline", textUnderlineOffset: 2,
                      }}>
                      {finishDetails.source}
                    </button>
                  ) : (
                    <span style={{ fontSize: 11, color: "var(--ink)", lineHeight: 1.35 }}>{finishDetails.source}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Open in BOQ Button */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpenBoq?.(); }}
        style={{
          display: "block", width: "100%", padding: "8px 12px", border: "none",
          borderTop: "1px solid var(--ink-faint)", background: pinned ? "var(--paper-cream)" : "var(--paper-bright)",
          fontSize: 11, color: "var(--cobalt)", fontWeight: 700, textAlign: "center",
          cursor: "pointer", fontFamily: "inherit",
        }}
      >
        Open in BOQ (B) →
      </button>
    </div>
  );
}
