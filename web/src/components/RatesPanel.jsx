// Material rates catalog — add/edit materials and unit rates (AED, metric).
import React, { useCallback, useEffect, useState } from "react";
import { money } from "../lib/num.js";
import { parseRatesFile } from "../lib/ratesImport.js";
import { deleteMaterialRate, importMaterialRates, listMaterialRates, upsertMaterialRate } from "../lib/supabase/pricing.js";

const CATEGORIES = ["material", "labour", "equipment", "subcontract"];

const emptyRow = () => ({
  id: "",
  code: "",
  name: "",
  category: "material",
  unit: "m²",
  rate_material: 0,
  rate_labour: 0,
  rate_equipment: 0,
  rate_sub: 0,
  currency: "AED",
  waste_pct: 0,
  source: "manual",
  notes: "",
});

function Field({ label, hint, children }) {
  return (
    <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)" }}>
        {label}
      </span>
      {children}
      {hint ? <span style={{ fontSize: 9.5, color: "var(--ink-faint)", lineHeight: 1.3 }}>{hint}</span> : null}
    </label>
  );
}

export default function RatesPanel({ open, onClose, onRatesChange }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [draft, setDraft] = useState(emptyRow());
  const [error, setError] = useState("");
  const [importMsg, setImportMsg] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await listMaterialRates();
      setRows(data);
      onRatesChange?.(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onRatesChange]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const saveDraft = async () => {
    setError("");
    setImportMsg("");
    try {
      await upsertMaterialRate(draft);
      setDraft(emptyRow());
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onImportFile = async (file) => {
    setError("");
    setImportMsg("");
    setImporting(true);
    try {
      const mapped = await parseRatesFile(file);
      if (!mapped.length) throw new Error("No usable rows found — need a Name/Description column");
      await importMaterialRates(mapped);
      setImportMsg(`Imported ${mapped.length} rate${mapped.length === 1 ? "" : "s"} from ${file.name}`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  if (!open) return null;

  const th = { textAlign: "left", padding: "6px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)", borderBottom: "1px solid var(--ink-faint)" };
  const td = { padding: "5px 8px", fontSize: 12, borderBottom: "1px solid var(--ink-faint)" };
  const inp = { width: "100%", padding: "6px 8px", border: "1px solid var(--ink-faint)", fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" };

  return (
    <aside style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--paper-bright)", overflow: "hidden", minHeight: 0 }}>
      <header data-float-drag style={{ padding: "12px 14px", borderBottom: "1px solid var(--ink-faint)", display: "flex", alignItems: "center", gap: 8, cursor: "grab", userSelect: "none", flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--cobalt)" }}>Material Rates</div>
          <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>AED catalog — used for live estimates</div>
        </div>
        <label style={{ fontSize: 11, color: "var(--cobalt)", cursor: importing ? "default" : "pointer", fontWeight: 600, opacity: importing ? 0.6 : 1 }}>
          {importing ? "Importing…" : "Import CSV / XLSX"}
          <input
            type="file"
            accept=".csv,.txt,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            disabled={importing}
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onImportFile(f); e.target.value = ""; }}
          />
        </label>
        <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "var(--ink-muted)" }}>×</button>
      </header>

      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-cream)", fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.45 }}>
        Set <strong style={{ color: "var(--ink)" }}>Code</strong> to match the condition finish tag on the canvas
        (e.g. both <span style={{ fontFamily: "var(--f-mono)" }}>CPT-1</span>). Masks using that condition then pick up these rates automatically.
      </div>

      <div style={{ padding: 12, borderBottom: "1px solid var(--ink-faint)", display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 8 }}>
          <Field label="Code" hint="Match finish tag, e.g. CPT-1">
            <input value={draft.code} onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))} style={inp} placeholder="CPT-1" />
          </Field>
          <Field label="Name *" hint="Shown in catalog and reports">
            <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} style={inp} placeholder="Carpet tile CPT-1" />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.8fr", gap: 8 }}>
          <Field label="Category" hint="Cost bucket for the estimate">
            <select value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))} style={inp}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Unit" hint="m², m, EA…">
            <input value={draft.unit} onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))} style={inp} placeholder="m²" />
          </Field>
          <Field label="Waste %" hint="Extra order qty">
            <input type="number" min={0} step="any" value={draft.waste_pct} onChange={(e) => setDraft((d) => ({ ...d, waste_pct: Number(e.target.value) }))} style={inp} />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
          <Field label="Material rate (AED)" hint="AED per unit — supply / product">
            <input type="number" min={0} step="any" value={draft.rate_material} onChange={(e) => setDraft((d) => ({ ...d, rate_material: Number(e.target.value) }))} style={inp} />
          </Field>
          <Field label="Labour rate (AED)" hint="AED per unit — install labour">
            <input type="number" min={0} step="any" value={draft.rate_labour} onChange={(e) => setDraft((d) => ({ ...d, rate_labour: Number(e.target.value) }))} style={inp} />
          </Field>
          <Field label="Equipment rate (AED)" hint="AED per unit — plant / tools">
            <input type="number" min={0} step="any" value={draft.rate_equipment} onChange={(e) => setDraft((d) => ({ ...d, rate_equipment: Number(e.target.value) }))} style={inp} />
          </Field>
          <Field label="Subcontract rate (AED)" hint="AED per unit — specialist trade">
            <input type="number" min={0} step="any" value={draft.rate_sub} onChange={(e) => setDraft((d) => ({ ...d, rate_sub: Number(e.target.value) }))} style={inp} />
          </Field>
        </div>

        <button type="button" onClick={saveDraft} disabled={!draft.name.trim()} style={{ padding: "9px 12px", background: "var(--cobalt)", color: "var(--paper-bright)", border: "none", fontWeight: 600, cursor: draft.name.trim() ? "pointer" : "default", fontSize: 11, opacity: draft.name.trim() ? 1 : 0.5 }}>
          {draft.id ? "Update material" : "Add material"}
        </button>
        {importMsg && <div style={{ fontSize: 11, color: "var(--cobalt)" }}>{importMsg}</div>}
        {error && <div style={{ fontSize: 11, color: "var(--danger, #c00)" }}>{error}</div>}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading ? <div style={{ padding: 12, fontSize: 12, color: "var(--ink-muted)" }}>Loading…</div> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Name / Code</th>
                <th style={th}>Unit</th>
                <th style={th}>Material</th>
                <th style={th}>Labour</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ ...td, color: "var(--ink-muted)", fontStyle: "italic" }}>
                    No rates yet — add above or import a CSV / XLSX.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    {r.code && <div style={{ fontSize: 10, color: "var(--ink-muted)", fontFamily: "var(--f-mono)" }}>{r.code}</div>}
                  </td>
                  <td style={td}>{r.unit}</td>
                  <td style={td}>{money(r.rate_material, r.currency)}</td>
                  <td style={td}>{money(r.rate_labour, r.currency)}</td>
                  <td style={td}>
                    <button type="button" onClick={() => setDraft({ ...emptyRow(), ...r })} style={{ fontSize: 10, marginRight: 6, cursor: "pointer" }}>Edit</button>
                    <button type="button" onClick={async () => { await deleteMaterialRate(r.id); reload(); }} style={{ fontSize: 10, cursor: "pointer", color: "var(--danger, #c00)" }}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </aside>
  );
}
