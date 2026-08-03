-- ADICC pricing catalog + cost rollups on project totals and BOQ lines.
-- material_rates is GLOBAL (not project-scoped) — never delete via replaceChildRows.

CREATE TABLE IF NOT EXISTS material_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'material'
    CHECK (category IN ('material', 'labour', 'equipment', 'subcontract')),
  unit TEXT NOT NULL DEFAULT 'm²',
  rate_material NUMERIC NOT NULL DEFAULT 0,
  rate_labour NUMERIC NOT NULL DEFAULT 0,
  rate_equipment NUMERIC NOT NULL DEFAULT 0,
  rate_sub NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AED',
  waste_pct NUMERIC NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'tender_boq', 'import')),
  source_ref TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_material_rates_code ON material_rates (code);
CREATE INDEX IF NOT EXISTS idx_material_rates_name ON material_rates (lower(name));

-- Project-level estimate settings
ALTER TABLE projects ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'AED';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS markup_pct NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS overhead_pct NUMERIC NOT NULL DEFAULT 0;

-- Priced BOQ line columns (numeric; legacy TEXT rate kept)
ALTER TABLE boq_lines ADD COLUMN IF NOT EXISTS rate_material NUMERIC;
ALTER TABLE boq_lines ADD COLUMN IF NOT EXISTS rate_labour NUMERIC;
ALTER TABLE boq_lines ADD COLUMN IF NOT EXISTS rate_equipment NUMERIC;
ALTER TABLE boq_lines ADD COLUMN IF NOT EXISTS rate_sub NUMERIC;
ALTER TABLE boq_lines ADD COLUMN IF NOT EXISTS material_rate_id UUID REFERENCES material_rates(id) ON DELETE SET NULL;
ALTER TABLE boq_lines ADD COLUMN IF NOT EXISTS amount NUMERIC;

-- Cost rollups on project_totals
ALTER TABLE project_totals ADD COLUMN IF NOT EXISTS material_cost NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE project_totals ADD COLUMN IF NOT EXISTS labour_cost NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE project_totals ADD COLUMN IF NOT EXISTS equipment_cost NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE project_totals ADD COLUMN IF NOT EXISTS sub_cost NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE project_totals ADD COLUMN IF NOT EXISTS subtotal NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE project_totals ADD COLUMN IF NOT EXISTS markup_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE project_totals ADD COLUMN IF NOT EXISTS grand_total NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE project_totals ADD COLUMN IF NOT EXISTS by_condition_cost JSONB NOT NULL DEFAULT '{}';

DROP TRIGGER IF EXISTS trg_material_rates_updated_at ON material_rates;
CREATE TRIGGER trg_material_rates_updated_at
  BEFORE UPDATE ON material_rates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE material_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "adicc_anon_all_material_rates" ON material_rates FOR ALL USING (true) WITH CHECK (true);
