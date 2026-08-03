// Parse CSV / XLSX into material_rates row objects for RatesPanel import.
// XLSX uses fflate (already a dependency) — no SheetJS.

import { unzipSync, strFromU8 } from "fflate";

const HEADER_ALIASES = {
  code: ["code", "item", "item_code", "item code"],
  name: ["name", "description", "desc", "material", "item description"],
  category: ["category", "type", "cost_type"],
  unit: ["unit", "uom", "units"],
  rate_material: ["rate_material", "material", "mat", "material_rate", "material rate", "rate"],
  rate_labour: ["rate_labour", "rate_labor", "labour", "labor", "lab", "labour_rate", "labor_rate"],
  rate_equipment: ["rate_equipment", "equipment", "equip", "equipment_rate"],
  rate_sub: ["rate_sub", "subcontract", "sub", "sub_rate"],
  currency: ["currency", "curr"],
  waste_pct: ["waste_pct", "waste", "waste %", "waste%"],
};

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== "") return row[k];
  }
  return "";
}

/** Map a loose header-keyed object → material_rates payload. */
export function mapImportRow(row, sourceRef = "") {
  const lower = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [String(k).trim().toLowerCase(), v]),
  );
  const name = String(pick(lower, HEADER_ALIASES.name)).trim();
  if (!name) return null;
  const category = String(pick(lower, HEADER_ALIASES.category) || "material").toLowerCase();
  return {
    code: String(pick(lower, HEADER_ALIASES.code)).trim() || null,
    name,
    category: ["material", "labour", "equipment", "subcontract"].includes(category) ? category : "material",
    unit: String(pick(lower, HEADER_ALIASES.unit) || "m²").trim() || "m²",
    rate_material: Number(pick(lower, HEADER_ALIASES.rate_material)) || 0,
    rate_labour: Number(pick(lower, HEADER_ALIASES.rate_labour)) || 0,
    rate_equipment: Number(pick(lower, HEADER_ALIASES.rate_equipment)) || 0,
    rate_sub: Number(pick(lower, HEADER_ALIASES.rate_sub)) || 0,
    currency: String(pick(lower, HEADER_ALIASES.currency) || "AED").trim() || "AED",
    waste_pct: Number(pick(lower, HEADER_ALIASES.waste_pct)) || 0,
    source: "import",
    source_ref: sourceRef || null,
  };
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** @param {string} text */
export function parseCsvRates(text, sourceRef = "") {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length < 2) throw new Error("CSV needs a header row and at least one data row");
  const headers = splitCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line).map((c) => c.replace(/^"|"$/g, ""));
    const obj = Object.fromEntries(headers.map((h, i) => [h, cols[i] || ""]));
    const mapped = mapImportRow(obj, sourceRef);
    if (mapped) rows.push(mapped);
  }
  return rows;
}

function xmlText(el) {
  return (el?.textContent || "").trim();
}

function parseSharedStrings(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const nodes = [...doc.getElementsByTagName("si")];
  return nodes.map((si) => {
    const ts = [...si.getElementsByTagName("t")];
    return ts.map((t) => xmlText(t)).join("");
  });
}

function colIndex(ref) {
  const m = String(ref).match(/^([A-Z]+)/i);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheetRows(xml, shared) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const rowEls = [...doc.getElementsByTagName("row")];
  const grid = [];
  for (const rowEl of rowEls) {
    const cells = [...rowEl.getElementsByTagName("c")];
    const row = [];
    for (const c of cells) {
      const ref = c.getAttribute("r") || "";
      const idx = colIndex(ref);
      while (row.length < idx) row.push("");
      const t = c.getAttribute("t");
      const vEl = c.getElementsByTagName("v")[0];
      let val = xmlText(vEl);
      if (t === "s") val = shared[Number(val)] ?? "";
      else if (t === "inlineStr") {
        const tEl = c.getElementsByTagName("t")[0];
        val = xmlText(tEl);
      }
      row[idx] = val;
    }
    grid.push(row);
  }
  return grid;
}

/** @param {ArrayBuffer} buf */
export function parseXlsxRates(buf, sourceRef = "") {
  const files = unzipSync(new Uint8Array(buf));
  const sharedPath = Object.keys(files).find((k) => /xl\/sharedStrings\.xml$/i.test(k));
  const sheetPath = Object.keys(files).find((k) => /xl\/worksheets\/sheet1\.xml$/i.test(k))
    || Object.keys(files).find((k) => /xl\/worksheets\/sheet\d+\.xml$/i.test(k));
  if (!sheetPath) throw new Error("No worksheet found in this XLSX file");
  const shared = sharedPath ? parseSharedStrings(strFromU8(files[sharedPath])) : [];
  const grid = parseSheetRows(strFromU8(files[sheetPath]), shared);
  if (grid.length < 2) throw new Error("XLSX needs a header row and at least one data row");
  const headers = grid[0].map((h) => String(h || "").trim().toLowerCase());
  const rows = [];
  for (const cells of grid.slice(1)) {
    if (!cells.some((c) => String(c || "").trim())) continue;
    const obj = Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
    const mapped = mapImportRow(obj, sourceRef);
    if (mapped) rows.push(mapped);
  }
  return rows;
}

/**
 * @param {File} file
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function parseRatesFile(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    if (name.endsWith(".xls") && !name.endsWith(".xlsx")) {
      throw new Error("Legacy .xls is not supported — save as .xlsx or .csv and try again");
    }
    return parseXlsxRates(await file.arrayBuffer(), file.name);
  }
  return parseCsvRates(await file.text(), file.name);
}
