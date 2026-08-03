# ADICC — Drawings Q&A (RAG) + BOQ pricing

This fork of OpenTakeoff integrates the ADICC Volume 4 drawings assistant and AED material-rate estimating into the takeoff canvas.

## UI (in the canvas toolbar)

| Button | What it does |
|--------|----------------|
| **Drawings** | Citation-grounded Q&A over the Volume 4 corpus. Tap a citation chip to open the **Source** sidebar with file path, quote, and PDF page preview. |
| **Rates** | Material rates catalog (AED). Code should match the condition finish tag (e.g. `CPT-1`). Import CSV / XLSX supported. |
| **BOQ** | Per-mask quantities with live rate × amount when rates are loaded. |
| **Estimate** | Unit-cost worksheet (material / labour / equipment / subcontract + markup). |

There is **no separate chat frontend** — Drawings Q&A lives only in this app (`web/src/components/DrawingsChatPanel.jsx`).

## Run locally

### 1. Takeoff canvas

```bash
cd web
cp .env.local.example .env.local   # set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY if using cloud
npm install
npm run dev                        # http://localhost:5173
```

Vite proxies `/rag/*` → `http://127.0.0.1:8001` (see `web/vite.config.js`). The optional `/ai` proxy stays on port 8000 for the BYO AI sandbox.

### 2. RAG API (sibling backend)

The FastAPI ingest + retrieval service lives next to this repo in the ADICC workspace (`../backend` when cloned as `ADICC/takeoff`). Start it on **8001**:

```bash
cd ../backend
.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

Health: `GET http://127.0.0.1:8001/health` and `GET http://localhost:5173/rag/health`.

### 3. Supabase (rates + takeoff persistence)

Apply migrations in order under `supabase/migrations/`, including `005_adicc_pricing.sql` for `material_rates` and cost columns.

## Mapping masks → rates

1. Add a rate with **Code** = finish tag (e.g. `CPT-1`).
2. Create / select a condition with the same finish tag.
3. Draw masks on that condition — hover / BOQ / Estimate use `qty × rate`.
