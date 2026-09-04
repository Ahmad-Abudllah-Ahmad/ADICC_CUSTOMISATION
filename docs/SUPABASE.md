# ADICC CUSTOMISATION — Supabase Database

PostgreSQL schema for real-time takeoff persistence (masks, holes, merges, BOQ, totals).

## Setup

1. Copy `web/.env.example` → `web/.env.local` and set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

2. Apply migrations in **Supabase Dashboard → SQL Editor** (in order):
   - `supabase/migrations/001_adicc_takeoff_schema.sql`
   - `supabase/migrations/002_project_recents.sql` (adds `last_opened_at` for the Plan set recents list)

3. Start the app: `cd web && npm run dev`

## Past projects (Plan set screen)

When Supabase is configured, the empty Plan set view lists **past projects** from the `projects` table with a search bar. Projects are sorted by `last_opened_at` (falling back to `updated_at`). Opening a project sets `?db=<uuid>` and reloads the canvas with that project's data.

Browser-local recents (`adicc_recent_supabase_projects` in localStorage) supplement DB ordering for instant reorder within this browser.

## Schema overview

| Table | Purpose |
|-------|---------|
| `projects` | Project metadata + full `annotations` JSON backup; `last_opened_at` for recents |
| `conditions` | Finish tags / takeoff types |
| `project_sheets` | Per-sheet scale (`units_per_px`) |
| `shapes` | Mask polygons (parent) with computed areas |
| `shape_holes` | Child trim rings (`holes_norm`) per parent shape |
| `shape_events` | Audit log: create, geom, merge, delete, hole add/remove |
| `boq_lines` | BOQ rows (auto + manual) |
| `markups` | Clouds, callouts, highlights |
| `rfis` | RFI register |
| `project_totals` | Live aggregates: floor SF, wall SF, LF, EA by sheet/condition |

## Real-time sync

When Supabase env vars are set, the app uses `supabaseStore.js`:

- **Load**: reads from Supabase (with IndexedDB cache)
- **Save**: 250ms debounced autosave → local IndexedDB + normalized Supabase tables
- **Events**: shape diffs logged to `shape_events` (create/update/delete/hole changes)
- **Totals**: recomputed on every save into `project_totals`

Project UUID is stored in `localStorage` (`adicc_supabase_project_id`) or via URL `?db=<uuid>`.

## Security note

Current RLS policies allow anon access for development. Per-user isolation for new projects uses `client_info.adicc_owner_id` (no extra migration). Tighten with Supabase Auth + RLS before public production.

Never commit `.env.local` or database passwords to git.
