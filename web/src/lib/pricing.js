// ADICC pricing engine — pure functions for rate resolution and cost rollups.
// Imports only num.js and units.ts to stay cycle-free and unit-testable.
import { round2 } from "./num.js";
import { M2_PER_SF, M_PER_FT, M3_PER_CF } from "./units";

/** Normalize a material/finish name for fuzzy catalog lookup. */
export function normalizeRateKey(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Convert internal qty (SF/LF in feet) to display-unit qty for rate join. */
export function qtyToDisplayUnit(qty, unit, displayUnits = "metric") {
  const n = Number(qty) || 0;
  const u = String(unit || "").toLowerCase();
  if (u === "ea" || u === "each" || u === "nr" || u === "no") return n;
  if (u === "m²" || u === "m2" || u === "sqm") {
    return displayUnits === "metric" ? n * M2_PER_SF : n;
  }
  if (u === "m" || u === "lm") {
    return displayUnits === "metric" ? n * M_PER_FT : n;
  }
  if (u === "sf" || u === "sq ft" || u === "sqft") {
    return displayUnits === "metric" ? n * M2_PER_SF : n;
  }
  if (u === "lf" || u === "lm") {
    return displayUnits === "metric" ? n * M_PER_FT : n;
  }
  if (u === "m³" || u === "m3" || u === "cum" || u === "cu m") {
    return displayUnits === "metric" ? n * M3_PER_CF : n;
  }
  if (u === "cf" || u === "cu ft" || u === "cuft" || u === "ft3" || u === "ft³") {
    return displayUnits === "metric" ? n * M3_PER_CF : n;
  }
  // SY → m²
  if (u === "sy") return displayUnits === "metric" ? n * 9 * M2_PER_SF : n * 9;
  return n;
}

/**
 * Resolve a catalog row by finish tag, material name, or code.
 * @param {Array<Record<string, any>>} catalog
 * @param {{ finishTag?: string, materialName?: string, unit?: string }} query
 */
export function resolveRate(catalog, query = {}) {
  if (!catalog?.length) return null;
  const tag = normalizeRateKey(query.finishTag);
  const mat = normalizeRateKey(query.materialName);
  const unit = String(query.unit || "").toLowerCase();

  const score = (row) => {
    let s = 0;
    const code = normalizeRateKey(row.code);
    const name = normalizeRateKey(row.name);
    if (tag && (code === tag || name.includes(tag) || tag.includes(code))) s += 80;
    if (mat && (name.includes(mat) || mat.includes(name))) s += 60;
    if (unit && String(row.unit || "").toLowerCase() === unit) s += 10;
    return s;
  };

  let best = null;
  let bestScore = 0;
  for (const row of catalog) {
    const sc = score(row);
    if (sc > bestScore) {
      bestScore = sc;
      best = row;
    }
  }
  return bestScore >= 40 ? best : null;
}

/**
 * Compute extended costs for one line.
 * @param {{ qty: number, rate?: Record<string, any>, wastePct?: number }} args
 */
export function lineCost({ qty, rate, wastePct }) {
  const q = Math.max(0, Number(qty) || 0);
  const waste = wastePct != null ? wastePct : (rate?.waste_pct ?? 0);
  const w = 1 + Math.max(0, Number(waste) || 0) / 100;
  const qNet = round2(q * w);
  const rm = Number(rate?.rate_material) || 0;
  const rl = Number(rate?.rate_labour) || 0;
  const re = Number(rate?.rate_equipment) || 0;
  const rs = Number(rate?.rate_sub) || 0;
  const material_ext = round2(qNet * rm);
  const labour_ext = round2(qNet * rl);
  const equipment_ext = round2(qNet * re);
  const sub_ext = round2(qNet * rs);
  const line_total = round2(material_ext + labour_ext + equipment_ext + sub_ext);
  return { qty: qNet, material_ext, labour_ext, equipment_ext, sub_ext, line_total };
}

/** Apply markup and overhead percentages to a subtotal. */
export function applyMarkup(subtotal, { markup_pct = 0, overhead_pct = 0 } = {}) {
  const base = Number(subtotal) || 0;
  const overhead = round2(base * (Number(overhead_pct) || 0) / 100);
  const afterOverhead = base + overhead;
  const markup = round2(afterOverhead * (Number(markup_pct) || 0) / 100);
  return {
    subtotal: round2(base),
    overhead_amount: overhead,
    markup_amount: markup,
    grand_total: round2(afterOverhead + markup),
  };
}

/**
 * Price one mask row (primary qty × resolved rate).
 * @param {{ qty: number, unit: string, finish_tag?: string, description?: string }} row
 */
export function priceMaskRow(row, catalog, displayUnits = "metric", projectSettings = {}) {
  const rate = resolveRate(catalog, {
    finishTag: row.finish_tag,
    materialName: row.description,
    unit: row.unit,
  });
  const displayQty = qtyToDisplayUnit(row.qty, row.unit, displayUnits);
  const costs = rate
    ? lineCost({ qty: displayQty, rate, wastePct: projectSettings.waste_pct ?? rate.waste_pct })
    : { qty: displayQty, material_ext: 0, labour_ext: 0, equipment_ext: 0, sub_ext: 0, line_total: 0 };
  const unitRate = rate
    ? (Number(rate.rate_material) || 0) + (Number(rate.rate_labour) || 0)
      + (Number(rate.rate_equipment) || 0) + (Number(rate.rate_sub) || 0)
    : 0;
  return {
    ...costs,
    rate: round2(unitRate),
    amount: costs.line_total,
    currency: rate?.currency || projectSettings.currency || "AED",
    priced_from: rate ? (rate.source === "tender_boq" ? `Tender BOQ${rate.source_ref ? ` · ${rate.source_ref}` : ""}` : rate.name) : null,
    material_rate_id: rate?.id || null,
    rate_row: rate || null,
  };
}

/**
 * Priced wrapper over conditionTotals rows — primary takeoff qty × finish rate,
 * then supporting materials with catalog rates.
 * @param {Array<Record<string, any>>} rows conditionTotals() output
 * @param {Array<Record<string, any>>} catalog material_rates rows
 */
export function pricedConditionTotals(rows, catalog, displayUnits = "metric", projectSettings = {}) {
  return rows.map((r) => {
    const materials = [];

    // Primary finish from measured takeoff (SF / LF / EA) — matches BOQ qty × rate.
    let pQty = 0;
    let pUnit = "SF";
    if ((Number(r.total_sf) || 0) !== 0 || (Number(r.floor_sf) || 0) !== 0 || (Number(r.wall_sf) || 0) !== 0) {
      pQty = Number(r.total_sf) || ((Number(r.floor_sf) || 0) + (Number(r.wall_sf) || 0) + (Number(r.border_sf) || 0));
      pUnit = "SF";
    } else if (Number(r.lf) || 0) {
      pQty = Number(r.lf) || 0;
      pUnit = "LF";
    } else if (Number(r.ea) || 0) {
      pQty = Number(r.ea) || 0;
      pUnit = "EA";
    }
    if (pQty || r.finish_tag) {
      const rate = resolveRate(catalog, { finishTag: r.finish_tag, unit: pUnit });
      const displayQty = qtyToDisplayUnit(pQty, pUnit, displayUnits);
      const costs = rate
        ? lineCost({ qty: displayQty, rate, wastePct: r.waste_pct ?? projectSettings.waste_pct })
        : { qty: displayQty, material_ext: 0, labour_ext: 0, equipment_ext: 0, sub_ext: 0, line_total: 0 };
      const unitLabel = rate?.unit
        || (pUnit === "SF" ? (displayUnits === "metric" ? "m²" : "SF")
          : pUnit === "LF" ? (displayUnits === "metric" ? "m" : "LF")
            : "EA");
      materials.push({
        name: rate?.name || r.finish_tag || "Finish",
        unit: unitLabel,
        per: 0,
        basis: pUnit === "LF" ? "linear" : pUnit === "EA" ? "count" : "area",
        qty: costs.qty,
        material_ext: costs.material_ext,
        labour_ext: costs.labour_ext,
        equipment_ext: costs.equipment_ext,
        sub_ext: costs.sub_ext,
        line_total: costs.line_total,
        rate_row: rate || null,
        primary: true,
      });
    }

    for (const m of (r.materials || [])) {
      const rate = resolveRate(catalog, { materialName: m.name, unit: m.unit });
      const displayQty = qtyToDisplayUnit(m.qty, m.unit || "m²", displayUnits);
      const costs = rate ? lineCost({ qty: displayQty, rate, wastePct: r.waste_pct }) : null;
      materials.push({ ...m, ...(costs || {}), rate_row: rate || null });
    }

    const material_ext = round2(materials.reduce((n, m) => n + (m.material_ext || 0), 0));
    const labour_ext = round2(materials.reduce((n, m) => n + (m.labour_ext || 0), 0));
    const equipment_ext = round2(materials.reduce((n, m) => n + (m.equipment_ext || 0), 0));
    const sub_ext = round2(materials.reduce((n, m) => n + (m.sub_ext || 0), 0));
    const line_total = round2(material_ext + labour_ext + equipment_ext + sub_ext);
    return { ...r, materials, material_ext, labour_ext, equipment_ext, sub_ext, line_total };
  });
}

/** Grand cost totals across priced condition rows. */
export function pricedGrandTotals(rows, projectSettings = {}) {
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  const subtotal = round2(sum("line_total"));
  const split = applyMarkup(subtotal, projectSettings);
  return {
    material_cost: round2(sum("material_ext")),
    labour_cost: round2(sum("labour_ext")),
    equipment_cost: round2(sum("equipment_ext")),
    sub_cost: round2(sum("sub_ext")),
    subtotal: split.subtotal,
    overhead_amount: split.overhead_amount,
    markup_amount: split.markup_amount,
    grand_total: split.grand_total,
  };
}

/** Sum priced mask rows for project HUD. */
export function pricedMaskTotal(maskRows, projectSettings = {}) {
  const subtotal = round2(maskRows.reduce((n, r) => n + (r.amount || 0), 0));
  return applyMarkup(subtotal, projectSettings);
}
