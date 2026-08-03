// Supabase CRUD for the global material_rates pricing catalog.
import { supabase } from "./client.js";

/** @returns {Promise<Array<Record<string, any>>>} */
export async function listMaterialRates() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("material_rates")
    .select("*")
    .order("name");
  if (error) throw error;
  return data || [];
}

/**
 * @param {Record<string, any>} row
 * @returns {Promise<Record<string, any>>}
 */
export async function upsertMaterialRate(row) {
  if (!supabase) throw new Error("Supabase is not configured");
  const payload = {
    ...(row.id ? { id: row.id } : {}),
    code: row.code || null,
    name: String(row.name || "").trim(),
    category: row.category || "material",
    unit: row.unit || "m²",
    rate_material: Number(row.rate_material) || 0,
    rate_labour: Number(row.rate_labour) || 0,
    rate_equipment: Number(row.rate_equipment) || 0,
    rate_sub: Number(row.rate_sub) || 0,
    currency: row.currency || "AED",
    waste_pct: Number(row.waste_pct) || 0,
    source: row.source || "manual",
    source_ref: row.source_ref || null,
    notes: row.notes || null,
    updated_at: new Date().toISOString(),
  };
  if (!payload.name) throw new Error("Material name is required");
  const { data, error } = await supabase
    .from("material_rates")
    .upsert(payload, { onConflict: "id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** @param {string} id */
export async function deleteMaterialRate(id) {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.from("material_rates").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Bulk import from parsed spreadsheet rows.
 * @param {Array<Record<string, any>>} rows
 */
export async function importMaterialRates(rows) {
  const out = [];
  for (const row of rows) {
    out.push(await upsertMaterialRate({ ...row, source: row.source || "import" }));
  }
  return out;
}
