# ADICC CUSTOMISATION — Supabase Database

PostgreSQL schema for real-time takeoff persistence (masks, holes, merges, BOQ, totals).

## Setup

1. Copy `web/.env.example` → `web/.env.local` and set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

2. Apply the schema in **Supabase Dashboard → SQL Editor**:
   - Paste contents of `supabase/migrations/001_adicc_takeoff_schema.sql`
   - Run

3. Start the app: `cd web && npm run dev`

## Schema overview

| Table | Purpose |
|-------|---------|
| `projects` | Project metadata + full `annotations` JSON backup |
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

Current RLS policies allow anon access for development. Tighten with Supabase Auth before production.

Never commit `.env.local` or database passwords to git.
