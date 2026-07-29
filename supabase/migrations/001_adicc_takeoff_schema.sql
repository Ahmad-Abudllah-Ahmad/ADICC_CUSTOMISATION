-- ADICC CUSTOMISATION — OpenTakeoff persistence schema
-- Mirrors opentakeoff.takeoff_canvas.v1 payload with normalized tables for
-- masks (shapes), parent/child holes, merge/delete audit, BOQ, and live totals.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Projects ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL DEFAULT 'Untitled Project',
  units           TEXT NOT NULL DEFAULT 'imperial' CHECK (units IN ('imperial', 'metric')),
  client_info     JSONB NOT NULL DEFAULT '{}',
  condition_columns JSONB NOT NULL DEFAULT '[]',
  shape_labels    JSONB NOT NULL DEFAULT '[]',
  palette         JSONB NOT NULL DEFAULT '[]',
  sheet_levels    JSONB NOT NULL DEFAULT '{}',
  file_folders    JSONB NOT NULL DEFAULT '{}',
  symbol_notes    JSONB NOT NULL DEFAULT '{}',
  provenance_counters JSONB NOT NULL DEFAULT '{"shapes_deleted":{}}',
  sheet_group     JSONB NOT NULL DEFAULT '[]',
  last_group      JSONB NOT NULL DEFAULT '[]',
  sheet_tabs      JSONB NOT NULL DEFAULT '[]',
  schema_version  TEXT NOT NULL DEFAULT 'opentakeoff.takeoff_canvas.v1',
  annotations     JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects (updated_at DESC);

-- ── Conditions (finish tags / takeoff types) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS conditions (
  id              TEXT NOT NULL,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  finish_tag      TEXT NOT NULL,
  color           TEXT,
  fill            TEXT,
  hatch           TEXT,
  multiplier      NUMERIC NOT NULL DEFAULT 1,
  waste_pct       NUMERIC NOT NULL DEFAULT 0,
  height_ft       NUMERIC,
  thickness_in    NUMERIC,
  labor_type      TEXT,
  subfloor_type   TEXT,
  description     TEXT,
  spec            JSONB NOT NULL DEFAULT '{}',
  attrs           JSONB NOT NULL DEFAULT '{}',
  materials       JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_conditions_project ON conditions (project_id);

-- ── Sheet scales ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_sheets (
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sheet_id        TEXT NOT NULL,
  units_per_px    NUMERIC,
  scale_source    TEXT,
  PRIMARY KEY (project_id, sheet_id)
);

-- ── Shapes / masks (parent polygons) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shapes (
  id              TEXT NOT NULL,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sheet_id        TEXT NOT NULL,
  condition_id    TEXT NOT NULL,
  measure_role    TEXT NOT NULL CHECK (measure_role IN (
                    'floor_area', 'deduct', 'surface_area', 'linear', 'count'
                  )),
  verts_norm      JSONB NOT NULL,
  computed        JSONB NOT NULL DEFAULT '{}',
  origin          JSONB NOT NULL DEFAULT '{}',
  label           TEXT,
  height_ft       NUMERIC,
  height_override BOOLEAN NOT NULL DEFAULT false,
  curved          BOOLEAN NOT NULL DEFAULT false,
  area_sf         NUMERIC GENERATED ALWAYS AS ((computed->>'area_sf')::numeric) STORED,
  perimeter_lf    NUMERIC GENERATED ALWAYS AS ((computed->>'perimeter_lf')::numeric) STORED,
  count_ea        NUMERIC GENERATED ALWAYS AS ((computed->>'count')::numeric) STORED,
  holes_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_shapes_project ON shapes (project_id);
CREATE INDEX IF NOT EXISTS idx_shapes_sheet ON shapes (project_id, sheet_id);
CREATE INDEX IF NOT EXISTS idx_shapes_condition ON shapes (project_id, condition_id);
CREATE INDEX IF NOT EXISTS idx_shapes_active ON shapes (project_id) WHERE deleted_at IS NULL;

-- ── Shape holes (child trim rings — parent/child mask relationship) ─────────
CREATE TABLE IF NOT EXISTS shape_holes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shape_id        TEXT NOT NULL,
  hole_index      INT NOT NULL,
  verts_norm      JSONB NOT NULL,
  area_sf         NUMERIC,
  perimeter_lf    NUMERIC,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, shape_id, hole_index),
  FOREIGN KEY (project_id, shape_id) REFERENCES shapes(project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shape_holes_parent ON shape_holes (project_id, shape_id);

-- ── Shape events (create, geom, merge, delete, hole changes) ────────────────
CREATE TABLE IF NOT EXISTS shape_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL CHECK (event_type IN (
                        'create', 'update', 'delete', 'merge', 'geom',
                        'hole_add', 'hole_remove', 'reassign'
                      )),
  shape_id            TEXT,
  related_shape_ids   TEXT[] NOT NULL DEFAULT '{}',
  sheet_id            TEXT,
  condition_id        TEXT,
  measure_role        TEXT,
  area_sf_before      NUMERIC,
  area_sf_after       NUMERIC,
  perimeter_lf_before NUMERIC,
  perimeter_lf_after  NUMERIC,
  holes_count_before  INT,
  holes_count_after   INT,
  payload             JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shape_events_project ON shape_events (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shape_events_shape ON shape_events (project_id, shape_id);

-- ── BOQ lines ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boq_lines (
  id              TEXT NOT NULL,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shape_id        TEXT,
  manual          BOOLEAN NOT NULL DEFAULT false,
  sheet_id        TEXT,
  condition_id    TEXT,
  room            TEXT,
  room_manual     BOOLEAN NOT NULL DEFAULT false,
  description     TEXT,
  notes           TEXT,
  unit            TEXT,
  qty_override    TEXT,
  rate            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_boq_lines_shape ON boq_lines (project_id, shape_id);

-- ── Markups ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS markups (
  id              TEXT NOT NULL,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sheet_id        TEXT NOT NULL,
  type            TEXT NOT NULL,
  geometry        JSONB NOT NULL DEFAULT '{}',
  text            TEXT,
  style           JSONB NOT NULL DEFAULT '{}',
  rfi_id          TEXT,
  created_at      TIMESTAMPTZ,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_markups_project ON markups (project_id);

-- ── RFIs ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rfis (
  id              TEXT NOT NULL,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number          TEXT,
  subject         TEXT,
  question        TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  metadata        JSONB NOT NULL DEFAULT '{}',
  sheet_id        TEXT,
  created_at      TIMESTAMPTZ,
  PRIMARY KEY (project_id, id)
);

-- ── Materialized totals (recomputed on every sync) ──────────────────────────
CREATE TABLE IF NOT EXISTS project_totals (
  project_id      UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  shape_count     INT NOT NULL DEFAULT 0,
  floor_sf        NUMERIC NOT NULL DEFAULT 0,
  wall_sf         NUMERIC NOT NULL DEFAULT 0,
  border_sf       NUMERIC NOT NULL DEFAULT 0,
  lf              NUMERIC NOT NULL DEFAULT 0,
  ea              NUMERIC NOT NULL DEFAULT 0,
  total_sf        NUMERIC NOT NULL DEFAULT 0,
  by_sheet        JSONB NOT NULL DEFAULT '{}',
  by_condition    JSONB NOT NULL DEFAULT '{}',
  by_room         JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_shape_holes_updated_at ON shape_holes;
CREATE TRIGGER trg_shape_holes_updated_at
  BEFORE UPDATE ON shape_holes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_boq_lines_updated_at ON boq_lines;
CREATE TRIGGER trg_boq_lines_updated_at
  BEFORE UPDATE ON boq_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Row Level Security (development — tighten with auth in production) ───────
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE shapes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shape_holes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shape_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE boq_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE markups ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfis ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_totals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "adicc_anon_all_projects" ON projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "adicc_anon_all_conditions" ON conditions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "adicc_anon_all_project_sheets" ON project_sheets FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "adicc_anon_all_shapes" ON shapes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "adicc_anon_all_shape_holes" ON shape_holes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "adicc_anon_all_shape_events" ON shape_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "adicc_anon_all_boq_lines" ON boq_lines FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "adicc_anon_all_markups" ON markups FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "adicc_anon_all_rfis" ON rfis FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "adicc_anon_all_project_totals" ON project_totals FOR ALL USING (true) WITH CHECK (true);
