// Estimate worksheet — StackCT-style unit-cost breakdown with material/labour split.
import React, { useMemo, useState } from "react";
import { conditionTotals, sheetGroupedRows } from "../lib/totals.js";
import { pricedConditionTotals, pricedGrandTotals } from "../lib/pricing.js";
import { money } from "../lib/num.js";

export default function EstimatePanel({
  open,
  onClose,
  conditions = [],
  shapes = [],
  materialRates = [],
  units = "metric",
  projectSettings = {},
  projectName = "",
  sheetLabel = (k) => k,
  sheetLevels = {},
}) {
  const currency = projectSettings.currency || "AED";

  // Project rollup (ungrouped) — buy quantities / grand total stay accurate.
  const pricedRows = useMemo(
    () => pricedConditionTotals(conditionTotals(conditions, shapes).filter((r) => r.shape_count > 0), materialRates, units, projectSettings),
    [conditions, shapes, materialRates, units, projectSettings],
  );
  const grand = useMemo(() => pricedGrandTotals(pricedRows, projectSettings), [pricedRows, projectSettings]);

  // Floor-wise display slices (same grouping as BOQ / report by sheet).
  const floors = useMemo(() => (
    sheetGroupedRows(conditions, shapes).map((g) => {
      const priced = pricedConditionTotals(g.rows, materialRates, units, projectSettings);
      const level = sheetLevels[g.sheet_id];
      const sheet = typeof sheetLabel === "function" ? sheetLabel(g.sheet_id) : g.sheet_id;
      const title = level ? `${level} · ${sheet}` : sheet;
      const subtotal = priced.reduce((n, r) => n + (r.line_total || 0), 0);
      return { sheet_id: g.sheet_id, title, priced, subtotal };
    })
  ), [conditions, shapes, materialRates, units, projectSettings, sheetLabel, sheetLevels]);

  const [collapsed, setCollapsed] = useState({});
  const revealed = (id) => !collapsed[id];
  const toggleFloor = (id) => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  if (!open) return null;

  const th = { textAlign: "left", padding: "6px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)", borderBottom: "1px solid var(--ink-faint)", whiteSpace: "nowrap" };
  const td = { padding: "5px 8px", fontSize: 12, borderBottom: "1px solid var(--ink-faint)" };

  return (
    <aside style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--paper-bright)", overflow: "hidden", minHeight: 0 }}>
      <header data-float-drag style={{ padding: "12px 14px", borderBottom: "1px solid var(--ink-faint)", display: "flex", alignItems: "center", cursor: "grab", userSelect: "none", flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--cobalt)" }}>Estimate</div>
          <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{projectName || "Unit-cost worksheet"}</div>
        </div>
        <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "var(--ink-muted)" }}>×</button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {!floors.length ? (
          <div style={{ padding: 16, color: "var(--ink-muted)", fontSize: 12.5 }}>No takeoffs to estimate yet.</div>
        ) : floors.map((floor) => {
          const openFloor = revealed(floor.sheet_id);
          return (
            <div key={floor.sheet_id} style={{ marginBottom: 12, border: "1px solid var(--ink-faint)" }}>
              <button
                type="button"
                onClick={() => toggleFloor(floor.sheet_id)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 8, justify: "space-between",
                  padding: "10px 12px", border: "none", background: "var(--paper-cream)",
                  cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "var(--ink)",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--cobalt)", width: 12 }}>{openFloor ? "▾" : "▸"}</span>
                  <span style={{ fontWeight: 700, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{floor.title}</span>
                </span>
                <span style={{ fontFamily: "var(--f-mono)", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{money(floor.subtotal, currency)}</span>
              </button>

              {openFloor && (
                <div style={{ padding: 8 }}>
                  {floor.priced.map((row) => (
                    <div key={row.id} style={{ marginBottom: 12, border: "1px solid var(--ink-faint)" }}>
                      <div style={{ padding: "8px 10px", background: "var(--paper-bright)", fontWeight: 700, fontSize: 12, display: "flex", justifyContent: "space-between" }}>
                        <span>{row.finish_tag}</span>
                        <span style={{ fontFamily: "var(--f-mono)" }}>{money(row.line_total, currency)}</span>
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>
                            <th style={th}>Material</th>
                            <th style={th}>Qty</th>
                            <th style={th}>Mat ext</th>
                            <th style={th}>Lab ext</th>
                            <th style={th}>Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(row.materials || []).map((m, i) => (
                            <tr key={i}>
                              <td style={td}>{m.name}</td>
                              <td style={td}>{m.qty} {m.unit}</td>
                              <td style={td}>{money(m.material_ext || 0, currency)}</td>
                              <td style={td}>{money(m.labour_ext || 0, currency)}</td>
                              <td style={td}>{money((m.line_total || 0), currency)}</td>
                            </tr>
                          ))}
                          {!row.materials?.length && (
                            <tr><td colSpan={5} style={{ ...td, color: "var(--ink-muted)", fontStyle: "italic" }}>No supporting materials on this condition</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <footer style={{ padding: "12px 14px", borderTop: "1px solid var(--ink-faint)", fontSize: 12, flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Material</span><span>{money(grand.material_cost, currency)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Labour</span><span>{money(grand.labour_cost, currency)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Equipment</span><span>{money(grand.equipment_cost, currency)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Subcontract</span><span>{money(grand.sub_cost, currency)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, color: "var(--ink-muted)" }}>
          <span>Markup ({projectSettings.markup_pct || 0}%)</span><span>{money(grand.markup_amount, currency)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 14, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--ink-faint)" }}>
          <span>Grand total</span><span style={{ color: "var(--cobalt)" }}>{money(grand.grand_total, currency)}</span>
        </div>
      </footer>
    </aside>
  );
}
