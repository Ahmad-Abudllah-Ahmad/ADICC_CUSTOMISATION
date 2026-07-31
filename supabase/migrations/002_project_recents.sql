-- Track when projects were last opened (for recents list on Plan set screen).
-- updated_at reflects saves; last_opened_at reflects user navigation.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_projects_last_opened_at
  ON projects (last_opened_at DESC NULLS LAST);

-- Backfill from updated_at so existing projects appear in recents immediately.
UPDATE projects
SET last_opened_at = updated_at
WHERE last_opened_at IS NULL;
