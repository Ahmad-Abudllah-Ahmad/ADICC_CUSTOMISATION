-- Plan file bytes (PDF, DWG, etc.) — metadata in Postgres, blobs in Storage.

CREATE TABLE IF NOT EXISTS project_files (
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  mime_type     TEXT,
  byte_size     BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, file_name)
);

CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files (project_id);

DROP TRIGGER IF EXISTS trg_project_files_updated_at ON project_files;
CREATE TRIGGER trg_project_files_updated_at
  BEFORE UPDATE ON project_files FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE project_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "adicc_anon_all_project_files" ON project_files FOR ALL USING (true) WITH CHECK (true);

-- Private bucket for plan uploads (100 MiB per object — raise in dashboard if needed).
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('project-plans', 'project-plans', false, 104857600)
ON CONFLICT (id) DO UPDATE SET file_size_limit = EXCLUDED.file_size_limit;

CREATE POLICY "adicc_anon_select_project_plans" ON storage.objects
  FOR SELECT USING (bucket_id = 'project-plans');

CREATE POLICY "adicc_anon_insert_project_plans" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'project-plans');

CREATE POLICY "adicc_anon_update_project_plans" ON storage.objects
  FOR UPDATE USING (bucket_id = 'project-plans');

CREATE POLICY "adicc_anon_delete_project_plans" ON storage.objects
  FOR DELETE USING (bucket_id = 'project-plans');
