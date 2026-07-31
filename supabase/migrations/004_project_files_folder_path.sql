-- Folder structure for plan uploads (relative path from project root, e.g. "05 STRUCTURAL/2. Drawings/DWG").

ALTER TABLE project_files
  ADD COLUMN IF NOT EXISTS folder_path TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_project_files_folder ON project_files (project_id, folder_path);
