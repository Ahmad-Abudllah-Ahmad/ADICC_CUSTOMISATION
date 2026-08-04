# Wall Trace — one-click wall network detection

## Tool

**Measure → Wall Trace** (shortcut **W**). Click solid wall ink (filled poché or heavy linework). The tool floods the **connected wall network** touching that point, traces the outer building contour, and treats enclosed rooms as **holes** inside the wall band.

Review the dashed preview, then **Create (⏎)** to commit. Use **Deduct** afterward to split mixed wall types onto different conditions/rates.

## Quantities

Each committed shape uses `measure_role: "wall_area"` and reports:

| Field | Meaning | BOQ / report |
|-------|---------|----------------|
| `wall_face_sf` | Total wall face area (outer + hole perimeters × height) | Rolls into **Wall SF** (same as Surface Area tool) |
| `footprint_sf` | Plan footprint of wall ink (outer − rooms) | **Wall Footprint SF** column (opt-in) |
| `volume_cf` | Footprint × height | **Wall Volume CF** column (opt-in); price with `m³` / `CF` rates |

Set **height (H)** on the condition before tracing — required for face area and volume.

## Algorithm

1. **Line-weight mask** — only heavy strokes + solid poché; long axis-aligned thin grid-span lines are dropped.
2. **Door swings excluded** — bezier door arcs are not wall ink (they used to bridge openings).
3. **Door-neck break** — thin ink bridges at door scale are stripped before the flood (poché bands stay intact).
4. **Ink flood** — 4-connected fill on wall pixels from the click.
5. **Contour** — Moore trace + RDP; rooms become holes inside the wall band.
6. **Guards** — leak cap rejects oversized networks (**Render → Wall** sensitivity).

## Manual Wall Area (U)

Trace wall poché by hand when one-click trace is wrong or unavailable:

1. Set scale + condition height.
2. **Measure → Wall Area** (or **U**).
3. Click corners around the wall footprint (outer boundary).
4. **Enter** to finish — footprint, face area, and volume are computed.
5. Select the wall → **Deduct (D)** to carve room openings as holes.

## Limitations

- Walls drawn as **two parallel lines with no fill** between them may trace as thin lines rather than the full wall band. Use **Surface Area (S)** or ensure poché/hatch fill on the drawing.
- One click selects the **whole connected network** — use Deduct to carve sections for different wall types.

## Related

- Room one-click: **One-Click Area (O)** — floods void inside walls.
- Manual wall footprint: **Wall Area (U)** — polygon trace with footprint / face / volume.
- Manual wall run: **Surface Area (S)** — polyline × height.
- Pricing: `material_rates` with unit `m²` (face), `m³` (volume), or `CF`.
