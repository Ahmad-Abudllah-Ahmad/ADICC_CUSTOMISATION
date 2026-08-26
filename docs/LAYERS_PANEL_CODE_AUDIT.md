# Layers panel — source-read code audit

**Scope:** `web/` Layers panel that docks beside the Measure Rail (the UI people call “measure trail”).  
**Method:** Every claim below is taken from the file contents that were opened and searched. Folder/file names were not treated as proof of behavior. If a feature is not in this document, it was not found in the scanned sources.

**Audit date:** 2026-08-26  
**Repo path:** `D:\Spark AI\ADICC_CUSTOMISATION-AI-ML`

---

## 1. What was actually opened

These files were read in full or in the cited regions. Nothing else is asserted.

| File | What it is in the source |
|---|---|
| `web/src/components/LayersIllustratorPanel.jsx` | Live Layers UI. File header: “Adobe-Illustrator-style Layers panel wired to live takeoff shapes.” |
| `web/src/lib/layerTree.js` | Tree build, group forest, hide/lock maps, pick helpers, persist slice. |
| `web/src/pages/TakeoffCanvas.jsx` | State, keyboard, canvas hit-test, hide/lock/group/delete/rename/move, Measure Rail mount, persist/hydrate. |
| `web/src/components/LayersSidebar.jsx` | Older layers list. File header: “previous layers list… Live UI is LayersIllustratorPanel.” **No `import` of this file exists anywhere in the repo.** |
| `web/src/lib/canvasTools.js` | Tool catalog: which tools mint a Layers leaf. |
| `web/src/lib/canvasConstants.js` | `MEASURE_TOOLS` (rail buttons + letter shortcuts). |
| `web/src/lib/shapeCommands.js` | Shape undo command types. No `layer_*` command type. |
| `web/src/lib/summaryTree.js` | Summary tree reads `hiddenShapeIds` only (no lock, no forest). |
| `web/src/components/SummaryPanel.jsx` | Second consumer of the same hide map. |
| `web/src/styles/app.css` | `.measure-rail-chrome`, `.left-panel-slot`, `.left-window`, `.ill-*` |
| `web/src/brand/icons.jsx` | `layers`, `lock`, `unlock` glyphs. |
| `web/test/layerTree.test.ts` | Unit tests for `layerTree.js` + a string pin that TakeoffCanvas autosave deps include layer state. |
| `web/test/canvasTools.test.ts` | Pins tool → Layers kind; pins `CHROME_IDS` includes `"layers"` with `createsLayer: false`. |
| `web/package.json` | Dependency `"react-arborist": "^3.16.0"`. |
| `docs/USER_GUIDE.md` §9 + §15 | User-facing Layers + shortcut tables. |
| `FEATURES.md`, `README.md`, `CHANGELOG.md` | Product copy about Layers. |
| `web/src/components/TakeoffFeatureGuide.jsx` | In-app guide “Layers & left panel” steps. |

Also searched (no Layers-panel implementation found):

| Search | Result |
|---|---|
| `measure trail` / `MeasureTrail` | No matches. The docked chrome class is `measure-rail-chrome`. USER_GUIDE: “The **layers** icon docks the Layers list beside the Measure Rail.” |
| `LayersSidebar` import | Zero imports. File is unused. |
| `web/src/lib/totals.js` + `hiddenShape` / `isHiddenId` | No matches. Report math does not read hide/lock. |
| `web/src/components/ReportPanel.jsx` + hide/lock maps | No matches. |
| `web/src/lib/store.js` / `cloudStore.js` / `google/` / `sync/` + `layer_tree` | No special-case keys. Persistence is the generic annotations payload. |
| `web/src/lib/agentTools.js` | Tools: `list_sheets`, `read_sheet_text`, `read_schedule`, `view_region`, `one_click`, `get_conditions`, `create_condition`, `propose_shapes`, `ask_drawings`. No hide/lock/group tool. |
| `web/src/lib/voiceIntent.ts` | No layer / group / hide / lock intents. |
| `mcp/src` + `layer_tree` / `layerForest` / `Layers` | No matches. |

---

## 2. Where the panel lives (Measure Rail, not a left-desk tab)

Measure Rail is portaled to `document.body` as `.measure-rail-chrome` (`TakeoffCanvas.jsx` ~10955–11058).

**Button order inside `.canvas-glass-cluster` (source order):**

1. ADICC logo — drag handle (`beginMeasureRailDrag`)
2. Reset rail position (`resetMeasureRailPos`)
3. Divider (`.canvas-rail-rule`)
4. **Layers** — `railBtn(toggleLayersPanel, <Icon name="layers" />, "Layers panel", illLayersOpen)`
5. Divider
6. Every `MEASURE_TOOLS` entry (One-Click, Wall Trace, Wall Area, Area, Rect, Linear, Curve, Surface, Count)
7. Divider
8. Sheet invert (only when `!isEmbedded`)

Below that column: Sheets FAB, then Chat button.

**Open/close**

```486:493:web/src/pages/TakeoffCanvas.jsx
  const toggleLayersPanel = useCallback(() => {
    setLeftPanelPresentation("dock");
    setIllLayersOpen((open) => {
      const next = !open;
      if (next) setLeftTab(null);
      return next;
    });
  }, []);
```

- `illLayersOpen` starts `false`.
- Opening Layers forces `leftTab` to `null` (closes Files / Sheets / Markups / Stamps / RFIs / Summary desk).
- Opening any `leftTab` closes Layers (`useEffect` at line 599).
- Sheets FAB also `setIllLayersOpen(false)`.
- Host `adicc:canvas-subnav` for a desk tab also `setIllLayersOpen(false)`.
- `leftTab === "layers"` is remapped to `"files"` (lines 494–495). `"layers"` is **not** in `LP_TAB_ORDER` (`["summary","files","sheets","markup","stamp","rfi"]`).
- Host secondary-nav can open desk tabs only (`LP_TAB_ORDER.includes(action)`). **Host navbar cannot open Layers.**

The panel renders in the shared `.left-panel-slot` next to the rail:

```11053:11056:web/src/pages/TakeoffCanvas.jsx
          {layersMotion.shown && (
            <div className={`left-window${layersMotion.entered ? " is-open" : ""}`}>
              {renderLiveLayersPanel({ onClose: () => setIllLayersOpen(false) })}
```

`useOpenMotion(illLayersOpen)` (default 360 ms): mount closed → two `rAF` → `.is-open`; on close, drop `entered` then unmount after 360 ms (`prefers-reduced-motion: reduce` skips delay). CSS: `.left-window` slides `translate3d(-18px,0,0)` + fade.

CSS (`.left-panel-slot` comment in `app.css`): Files desk and Layers share one slot so they never sit side-by-side. Open width `min(360px, calc(100vw - 78px))`. No stage scrim. Slot `pointer-events: none` until a window is open.

`Alt+Shift+1` toggles **the whole Measure Rail** (`toolbarChrome.measureVisible`), not Layers. Layers button + docked panel live inside that chrome, so hiding the rail hides the open Layers panel too.

`embedded` on `LayersIllustratorPanel` exists (`embedded` hides the titlebar). The live call is `renderLiveLayersPanel({ onClose })` only — **`embedded` is never `true`**. Titlebar (title, hamburger, ×) is shown. `closeOnOutside` is therefore `true`.

---

## 3. What is a “layer” in this code

A Layers **leaf** is a committed takeoff **shape** (`shapes[]`).  
A Layers **folder** is either:

- a **group** in `layerForest` (`{ id, kind:"group", name, sheetKey, children[], hidden?, locked? }`), or
- a **sheet folder** synthesized by `buildLayerTree` when `sheetKeys.length > 1`. Sheet node id is `sheet::<key>` (`sheetNodeId`).

`canvasTools.js` contract (comments + `createsLayer`):

- Arming a tool (`setTool`) creates no leaf.
- A leaf appears only after a shape commit.
- Markup / stamp / highlighter / cloud / callout / text / highlight / zone / select / pan / calibrate / check / gallery / chrome ids (`files`, `layers`, `invert`, …) have `createsLayer: false`.

`kindFromRole`:

| `measure_role` | Panel `kind` | `KIND` color / unit |
|---|---|---|
| `count` | `count` | `#b8860b` / `ea` |
| `linear`, `surface_area` | `line` | `#a0402a` / `LF` |
| everything else (`floor_area`, `wall_area`, `deduct`, unknown) | `area` | `#1e6b4a` / `SF` |

`ROLE_LABEL` (display names): `floor_area→Mask`, `wall_area→Wall area`, `deduct→Cutout`, `linear→Line`, `surface_area→Wall line`, `count→Count`.

Default leaf **name** (`leaf()` in `layerTree.js`):

1. `shape.label` if set
2. else `detectedRoom · finish_tag` if both exist
3. else `detectedRoom · role` if room exists
4. else `finish_tag · role` (`finish_tag` is `"—"` when missing)

`roomForShape` is passed from TakeoffCanvas as  
`(s) => detectRoomName(s, boqDetectCtx, shapes) || s.room_detected || s.room || ""`.  
`shapeMeta` prop exists on the panel and in `leaf()`; **TakeoffCanvas never passes `shapeMeta`.**

**Paint color** (`layerPaintColor`): `appearance_override && shape.color` → else condition `color` → else kind fallback. Folder color is unanimous child paint, else `KIND.group` / `KIND.sheet` `#1a5276`.

**Metric** (`shapeMetric`): count → `N ea`; linear/surface_area → perimeter in display units; else area; else perimeter; else `""`. Group/sheet metric is `summariseNodes` (sum by unit, joined with ` · `).

**Which shapes appear in the panel** (`layerPanelShapes`): shapes whose `sheet_id` matches an **open** `groupKeys` entry (`openTabs` / `sheetGroup` / current `sheetKey`), plus the AI-detect reveal filter (unrevealed floor masks on AI floor plans are omitted; deducts stay if the sheet has any reveal). Hidden shapes **still appear** in the panel (dimmed). Markup never appears.

Empty tree copy: `"Draw on the sheet — each takeoff becomes a layer."`

---

## 4. Session state (TakeoffCanvas)

| State | Persist? | Meaning |
|---|---|---|
| `illLayersOpen` | no | Panel open flag |
| `hiddenShapeIds` | yes → `layer_hidden` | `{ [id]: true }` for shape ids and `sheet::<key>` |
| `lockedShapeIds` | yes → `layer_locked` | same shape for lock + `sheet::<key>` |
| `layerForest` | yes → `layer_tree` | nested groups only (not sheet folders) |
| `layerPickIds` | **no** | `{ [shapeId]: true }` multi-pick. Cleared on hydrate. Pruned when `shapes` lose ids. |
| `layerTargetSheetRef` | no | last sheet aimed by a panel select / sheet-folder click; used by New Group |

`layerPersistSlice` **omits empty objects**. Hydrate (`hydrate`):

```2435:2439:web/src/pages/TakeoffCanvas.jsx
      const live = new Set((a.shapes || []).map((s) => s.id).filter(Boolean));
      setHiddenShapeIds(sanitizeLayerIdMap(a.layer_hidden, live));
      setLockedShapeIds(sanitizeLayerIdMap(a.layer_locked, live));
      setLayerForest(sanitizeForest(a.layer_tree, live));
      setLayerPickIds({});
```

`sanitizeLayerIdMap` keeps only truthy entries whose id is a live shape **or** a `sheet::` key. Stale shape ids drop. `sanitizeForest` rebuilds via `forestFromFlat` and drops children that are neither a group id nor a live shape id.

Autosave `useEffect` deps include `layerForest`, `hiddenShapeIds`, `lockedShapeIds` (pinned by `layerTree.test.ts`). `store.saveAnnotations(payload)` writes the whole payload; store code has no layer-specific field names.

---

## 5. `layerTree.js` — every exported function (behavior as written)

| Export | What the code does |
|---|---|
| `ROLE_LABEL`, `KIND` | Display tables above |
| `kindFromRole` / `kindOf` | Role → kind; unknown kind → `KIND.line` |
| `layerPaintColor` | Paint precedence above |
| `isFolderKind` | `kind === "group" \|\| kind === "sheet"` |
| `sheetNodeId` / `sheetKeyFromNodeId` | `sheet::` prefix |
| `shapeMetric` | Qty string |
| `shapeIdsOnFocusSheet` | Shape ids on `focusSheetKey` or `sheetKeys[0]` |
| `summariseNodes` | Sum metrics by unit |
| `cloneForest` | Shallow clone + copied `children` arrays |
| `forestFromFlat` | Accepts either nested forest or old `{ shapeIds }` groups |
| `sanitizeForest` | Hydrate prune |
| `sanitizeLayerIdMap` | Hydrate prune for hide/lock maps |
| `collectIdsForLayerToggle` | Expand click ids → `{ shapeIds, groupIds, sheetIds }` |
| `layerPersistSlice` | Additive persist keys |
| `activeLayerPickIds` | If `!selectedId`, return `{}` (stale picks must not paint chrome) |
| `togglePickIds` | Ctrl-click: if every row id is already in, drop them; else add |
| `rangePickIds` | Shift-click: union of visible rows from `fromIndex` to `toIndex` inclusive. Invalid from-index falls back to to-index |
| `isolateOtherIds` / `isIsolatedTo` | Alt-eye / Alt-lock solo math |
| `picksForPrimarySelect` | If `id` already in current picks, keep the multi-pick; else `{ [id]: true }` |
| `isHiddenId` | `hiddenShapeIds[id]` **or** `hiddenShapeIds[sheet::<sheetId>]`. **Does not walk `forest` / `group.hidden`.** |
| `isLockedId` | `lockedShapeIds[id]` **or** sheet flag **or** walk `parentOf` while `forest[p].locked`. |
| `parentOf` / `descendantShapeIds` / `isDescendant` / `topMostIds` | Forest walk |
| `liftSelection` | If every descendant of a group is selected, keep the group id instead of leaves |
| `groupSelection` | Needs `newId` and ≥2 top-most ids. Refuses mixed `sheet_id` when `shapeById` is passed. Inserts new group at first parent’s index of the first member |
| `ungroupNodes` | Splices children into parent, deletes group. No-op if nothing was a group |
| `moveNodes` | Drag-drop. `destParentId` that is a `sheet::` id becomes `null` (root). Refuses drop into self/descendant, mixed sheets, dest group on another sheet |
| `addEmptyGroup` | `{ children: [] }` |
| `renameGroup` | Trim; empty string keeps old name |
| `setGroupFlag` | Sets/deletes `hidden` or `locked` on a group object |
| `buildLayerTree` | 0–1 sheet → flat roots (groups then ungrouped). ≥2 sheets → sheet folders. Cycle guard via `visiting` |
| `shapeIdsUnder` / `findNode` | Walk built tree nodes |

---

## 6. Live panel UI (`LayersIllustratorPanel.jsx`) — every control

Library: `react-arborist` `Tree`. `openByDefault`, `rowHeight={32}`, `indent={14}`, `overscanCount={8}`, `disableMultiSelection={false}`. Size from `ResizeObserver` on `.ill-body` (min 180×120).

### 6.1 Titlebar (only when `embedded === false`)

- Title text `Layers`
- Hamburger → panel context menu
- Close → `onClose` (`setIllLayersOpen(false)`)

### 6.2 Toolbar

- **Group** — `disabled` unless `pickIds.length >= 2`. Tip: `Group (Ctrl+Shift+G)`
- **Ungroup** — enabled if any pick id is a group id **or** `parentOf(layerForest, id)` is set. Tip: `Ungroup (Ctrl+Shift+U)`

`canUngroup` uses `layerForest[id]` — pick ids are **shape ids**, so a fully selected group is usually represented as its descendant shape ids, not the group id. Ungroup still works because `parentOf(layerForest, shapeId)` is true for grouped shapes.

### 6.3 Row chrome (left → right)

| Control | Click | Alt-click | Other |
|---|---|---|---|
| Eye | Toggle hide for that row’s shapes (folder also passes the folder id) | Solo that row: hide others, show keep. If already isolated (`isIsolatedTo`), show **all** | Titles: “Hide · Alt-click to solo” / “Show · Alt-click to show all” |
| Lock | Toggle lock the same expansion | Lock others / if already isolated, unlock **all** | Titles: “Lock · Alt-click to lock others” / “Unlock · Alt-click to unlock all” |
| Color strip | none | — | `d.color` or kind color |
| Tree guides | none | — | trunk / tee / elbow / blank from ancestor siblings |
| Triangle (folders only) | `node.toggle()` | `openDeep(node)` — open this folder and all nested folders | Leaves get an empty spacer |
| Folder glyph | none | — | Folder SVG for group/sheet only. Leaves have no kind thumbnail |
| Name | row select (see 6.4) | Alt+name = pick that row’s shapes only (`selectRow` alt branch) | Double-click → inline rename (`node.edit()`), **blocked for `kind === "sheet"`**. Drag handle is the name (unless sheet or locked) |
| Metric chip | none | — | |
| Target “meatball” | same as row select | modifiers work | Double ring when “targeted” (Illustrator rule in comments) |
| Selection square | none | — | full = this row / every descendant picked; part = partial folder pick |

Rename input: Enter `node.submit`, Escape `node.reset`, blur `node.reset` (cancel). Sheet rows cannot rename.

### 6.4 Row pick (`selectRow`)

After click: `panelRef.focus({ preventScroll: true })`.

| Modifier | Result |
|---|---|
| none | Replace pick with that row’s shape ids; set anchor |
| Ctrl / Meta | `togglePickIds` |
| Shift | `rangePickIds` over **currently visible** arborist rows from last anchor to this row |
| Alt (no Ctrl/Shift) | Replace pick with that row’s shape ids (same as plain click in this handler) |

`onSelect` from arborist is a **no-op** (`onTreeSelect = () => {}`). Comment in source: arborist pointerdown exclusive-select used to wipe the pick before Ctrl/Shift ran. **Mouse pick is `selectRow` only. Arrow keys still move arborist focus.**

Visual “selected” uses `selectedSet` (from props) **or** `node.isSelected` (arborist internal). Keyboard focus can light `node.isSelected` without calling `onSelectIds`.

Selecting a sheet folder passes `{ sheetKey }` so `selectLayerIds` stores `layerTargetSheetRef`.

### 6.5 Drag and drop

`disableDrag`: sheet rows, or `locked`.  
`disableDrop`: dest must be root, or a group/sheet that is not locked. Drop on a leaf is refused.

`onMove` → `moveLayerTree` → `moveNodes`. Sheet dest becomes `null` (ungroup to that sheet’s root in the forest). Shapes keep their `sheet_id`; dropping on another sheet folder does **not** move geometry to the other sheet — it only removes forest parent.

### 6.6 Search

Footer magnifier toggles `searchOpen`. Input placeholder `"Find layers…"`. Filters arborist via `searchTerm={q}` on **name** substring (case-insensitive). Escape in the find field or panel Escape (when search is open and target is not `.ill-find`) clears and closes search.

There is **no** `Ctrl/Cmd+F` handler in this file.

### 6.7 Footer

- Count: `N Layer(s)` + if sheet folders exist ` · N Sheet(s)` else if groups exist ` · N Group(s)`
- Search toggle
- `+` New Group → `onNewGroup`
- Trash → delete current pick (disabled when empty)

### 6.8 Context menus

**Row menu** (right-click; if that row isn’t in the pick, it selects that row first):

- New Group
- Duplicate (disabled if no pick)
- Delete (disabled if no pick, `danger`)
- Group (`hint: "Ctrl+Shift+G"`)
- Ungroup (`hint: "Ctrl+Shift+U"`)
- Rename (disabled for sheet)
- Show / Hide
- Lock / Unlock

**Panel menu** (hamburger):

- New Group
- Collapse all (`treeRef.closeAll()`)
- Select all (`shapeIdsOnFocusSheet`)
- Delete hidden (disabled if `hiddenShapeCount === 0`)

Menu is a fixed `div.ill-menu`, clamped to the viewport. Closes on outside pointerdown or window resize.

### 6.9 Outside click

When `closeOnOutside` (live path: true): capture `pointerdown` on `window`. Ignore if target is inside the panel, inside `.ill-menu`, or `button[aria-label='Layers panel']`. Else `onClose()`.

### 6.10 Props the live canvas actually passes

`shapes={layerPanelShapes}`, `condById`, `hiddenShapeIds`, `lockedShapeIds`, `layerForest`, `sheetKeys={groupKeys}`, `sheetLabel={tabLabel}`, `focusSheetKey={focusKey}`, `selectedIds={selectedLayerIds}`, `units`, `sheetMatch={aiFloorSheetKeysMatch}`, `roomForShape`, and all `on*` handlers listed in §7.  
Not passed: `embedded`, `shapeMeta`.

---

## 7. Canvas wiring — every callback (TakeoffCanvas)

### 7.1 `selectLayerIds(ids, opts)`

- Filters to live shape ids
- Sets `layerTargetSheetRef` from `opts.sheetKey` or first shape’s sheet
- `selectShape(first, picks)` — also sets tool to `"select"`
- `setFocusKey` to that sheet
- `flyToShape(first)` — opens the sheet if needed, then `centerOnShape`

Empty list → `selectShape(null)`.

### 7.2 `toggleHideIds(ids, hidden?)`

`collectIdsForLayerToggle` → write `hiddenShapeIds` for `[...ids, ...shapeIds, ...sheetIds]`.  
If `hidden` omitted, toggle = “not every shape id is already hidden”.  
Also `setGroupFlag(..., "hidden")` for expanded group ids.

### 7.3 `toggleLockIds(ids, locked?)`

Same pattern for `lockedShapeIds` + `setGroupFlag(..., "locked")`.

### 7.4 `groupLayerSelection`

`liftSelection` → if `< 2` return. New id `uid("lg")`, name `"Group"`.  
`groupSelection(..., { shapeById })` — mixed sheets no-op (`next === layerForest`).  
Then `selectShape(members[0], picks)`.

### 7.5 `ungroupLayerSelection`

`ungroupNodes` on lifted ids. Then `setLayerPickIds({})` (clears pick; does **not** call `selectShape(null)`).

### 7.6 `deleteLayerIds`

Skips locked. `dispatchShape({ type: "delete", ids })`. Cleans hide/lock/pick maps for those ids. Clears primary select if it was deleted.

### 7.7 `duplicateLayerIds`

Unlocked only → `clipEntry` each → `pasteClipboard()`. Paste mints **new** ids via `add`. Copies verts, condition, role, height, openings, label, origin. **Does not copy group membership.** New shapes are ungrouped.

### 7.8 `renameLayer(id, name, kind)`

- `kind === "group"` → `renameGroup` (not a shape command)
- else → `dispatchShape({ type: "label", ids: [id], value })` (this **is** on the undo stack)

### 7.9 `newLayerGroup`

Sheet = `layerTargetSheetRef` or `focusKey` or `groupKeys[0]`, resolved through `aiFloorSheetKeysMatch`. Empty group named `"Group"`.

### 7.10 `moveLayerTree`

`moveNodes` with `shapeById`. Not undoable (plain `setLayerForest`).

---

## 8. How hide / lock / pick change the canvas

### Hide (`isHiddenId`)

Used to:

- Filter SVG takeoff paths (`TakeoffCanvas.jsx` ~12165)
- Skip hit-testing (~4200)
- Build `drawableShapes` → `visibleShapesMeasured` → `conditionTotals` for **HUD + Takeoffs drawer “this sheet” numbers** (~9103–9113)

Not used by:

- `ReportPanel` / `totals.js` (no hide filter found)
- Zone check (`shapesInZone(shapes, …)` uses full `shapes`)
- Persistence of quantities (`shapes[]` still has the geometry)

USER_GUIDE §9 says “Hide and lock do not change quantities.” That matches **Report**. It does **not** match the HUD/Takeoffs path, which totals `drawableShapes` (hidden omitted).

New shapes committed while a **sheet folder** is hidden/locked inherit that flag (`dispatchShape` `add` copies sheet flags onto the new id, ~932–942).

### Lock (`shapeIsLocked` → `isLockedId`)

Blocks, when the source check is present:

- Vertex / hole / edge handles of the selected shape (~4079, ~12252)
- Move drag of the selected shape or any group member (~4182, ~4271)
- Wall-run join (~4219)
- Vertex-drag start (~4319)
- Copy (`copySelected` returns if primary is locked)
- Duplicate (locked ids filtered out)
- Flip
- Subtract (locked filtered)
- Delete (`deleteSelected` / `deleteLayerIds` / cutout remove)
- Reassign condition / label
- Height patch (`patchShapeHeight`)
- Drag in the Layers tree (`disableDrag` / `disableDrop` on locked folders)

Lock does **not** remove the shape from the SVG (it still draws). Locked name is muted in the panel.

### Pick / group move

`layerGroupIdsFor(shapeId)`: if the shape has a forest parent, **all descendants of that parent** (the whole sibling group), else `[shapeId]`.

`moveIdsFor`: if more than one pick, union of `layerGroupIdsFor` for each pick; else the single-shape group.

Canvas click on a grouped shape (no modifier) sets pick to the whole parent group (`setLayerPickFromShape`) and can arm a **group move**. Live preview writes every member’s verts; pointer-up dispatches **one `geom`/`move` command per member** (~5085–5104). Those are separate undo steps.

`selectedLayerIds` for the panel: keys of `activeLayerPickIds(selectedId, layerPickIds)`, else `[selectedId]`. If `selectedId` is null, picks are forced empty for chrome (`activeLayerPickIds`).

`selectedLayerGroupMemberIds` paints selection chrome on every picked id (or the parent group when there is no multi-pick).

---

## 9. Keyboard and pointer map

Two listeners matter: **window** (TakeoffCanvas) and **panel** (`ill-panel` `tabIndex={0}` `onKeyDown`).

### 9.1 Exists — Layers-specific (verified handlers)

| Input | Where | What the code runs |
|---|---|---|
| Click Layers rail button | Measure Rail | `toggleLayersPanel` |
| Click rail button again | same | close |
| Outside pointerdown | panel effect | close (exceptions: panel, menu, Layers button) |
| Panel × | titlebar | `onClose` |
| `Ctrl/Cmd+Shift+G` | **window** and **panel** | `groupLayerSelection` (panel only if `canGroup`) |
| `Ctrl/Cmd+Shift+U` | **window** and **panel** | `ungroupLayerSelection` (panel only if `canUngroup`) |
| `Ctrl/Cmd+A` | **panel only**, not in an `input` | select all shapes on **focused sheet** |
| `Delete` / `Backspace` | **panel**, not in an `input` | `deleteLayerIds` via `deleteSelection` (`stopPropagation`) |
| `Delete` / `Backspace` | **window** (canvas focused) | existing cascade: pop poly → … → `deleteSelected` (uses `layerPickIds`, skips locked) |
| `Escape` | panel, search open | close search |
| `Escape` | window | does **not** close Layers; `selectShape(null)` clears pick |
| Click / Ctrl-click / Shift-click / Alt-click row | panel | §6.4 |
| Alt-click eye / lock / triangle | panel | solo / lock-others / expand-all-nested |
| Double-click name | panel | rename (not sheets) |
| Enter / Escape | rename field | submit / cancel |
| Drag name onto group | arborist `onMove` | `moveNodes` |
| Right-click row / hamburger | panel | context menus |
| Canvas Select + Shift-click shape | window pointer | add to pick (`toggle` only if Ctrl/Meta without Shift) |
| Canvas Select + Ctrl/Cmd-click shape | window pointer | `togglePickIds` (deducts use cutout multi-select instead) |
| `Ctrl/Cmd+D` | window | `duplicateSelected` (all unlocked picks, else selected) |
| `Ctrl/Cmd+C` | window | `copySelected` — **primary `selectedId` only**, not the full pick |
| `Ctrl/Cmd+V` | window | paste clipboard |

### 9.2 Exists on Measure Rail but is **not** a Layers shortcut

These are on the same rail and steal letters. They do not open Layers.

| Key | Arms (`LETTER_TO_TOOL` / extra handlers) |
|---|---|
| `O` | oneclick |
| `W` | walltrace |
| `U` | wallarea |
| `A` | area |
| `R` | rect |
| **`L`** | **linear** (not Layers) |
| `Q` | curve |
| `S` | surface |
| `C` | count |
| `V` | select |
| `P` / `H` | pan (`h`/`p` handled before the letter map; `⇧H` is highlighter) |
| `D` / `⇧D` / `⇧Q` | deduct family |
| `K` | check |
| `G` | gallery (`setView("gallery")`, also closes left tab) |
| `1`–`9` | condition palette |
| `Alt+Shift+1` | hide/show **entire Measure Rail** |
| `Alt+Shift+2` | Workspace Bar |
| `Alt+Shift+3` | Takeoffs drawer |

`TOOL_SPEC.layers` is chrome: `creates: "none"`, **no `shortcut` field**.

`menuDepthRef > 0` (a toolbar menu is open) pauses letter and digit shortcuts. Layers panel does **not** increment `menuDepthRef`. Opening Layers does **not** pause `O`/`A`/`L`/…

### 9.3 Documented or labeled, but **no matching handler found**

| Label / doc | Search result |
|---|---|
| Letter key to open/close Layers | None. `L` is Linear. |
| `Ctrl/Cmd+F` find layers | No handler. Search is the footer button only. |
| `F2` rename | No handler. Rename is double-click or context menu. |
| Arrow keys change the **app** pick | Arborist moves focus only; `onSelect` is empty. |
| Space / Enter activate row | Not in `onKeyDown`. |
| `Ctrl+G` Group | Canvas context menu **label** is `"Ctrl+G"` (`TakeoffCanvas.jsx` ~13014). Real handler is **Ctrl+Shift+G**. No `Ctrl+G` group handler. |
| `Shift+X` Subtract | Context menu hint `"Shift+X"`. **No** `key === "x"` / Shift+X listener in TakeoffCanvas. Function `subtractSelectedShapes` exists; only the menu click calls it. |
| Lock from canvas context menu | Menu has Hide/Show, Group, Ungroup, Delete. **No Lock item.** |
| Host navbar “Layers” | Host message only accepts `LP_TAB_ORDER`. Layers is not in that list. |
| Voice command for layers | None in `voiceIntent.ts`. |
| Agent tool for layers | None in `agentTools.js`. |
| MCP layer ops | None under `mcp/src`. |

### 9.4 USER_GUIDE §15 vs this source (Layers rows)

USER_GUIDE table that **matches** the panel handlers:

- Layers click / `⌘`-click / `⇧`-click / `⌥`-click name / `⌥`-click eye / `⌥`-click lock / `⌥`-click triangle / `⌘A` (panel-focused)
- `⇧⌘G` / `⇧⌘U`
- Canvas Shift-click add / `⌘`-click toggle

USER_GUIDE does **not** list a key to open Layers (correct — there isn’t one).

### 9.5 In-app guide vs this source

`TakeoffFeatureGuide.jsx` “Layers & left panel” claims:

- “open condition edit; delete shapes; **separate wall lines at corners**”
- “**Per-line wall heights and door-opening rows in the layer detail**”

Those wall-segment chips and “Separate” live in **`LayersSidebar.jsx` only** (lines 203–240). That component is **not imported**. The live `LayersIllustratorPanel` has **no** wall-segment UI, **no** condition-edit swatch, **no** Separate.

Guide also says “left-rail layers icon **(2nd)**”. Source order is logo, reset, **then** Layers (third circle button). CHANGELOG “2nd from top” is the same older count (before Reset was inserted under the logo).

---

## 10. Dead / leftover code (confirmed unused)

`web/src/components/LayersSidebar.jsx` — complete previous UI:

- Checkbox multi-pick
- Group / Ungroup buttons
- Hide / delete per row
- Sheet accordion (`layersSheetOpen`)
- Condition-color button → `onOpenConditionEdit`
- Wall segment index chips + “Separate”
- Flat `layerGroups` / `shapeToLayerGroup` (not `layerForest`)

No importer. Do not copy this file if the goal is **current** Measure Rail behavior.

`leftTab === "layers"` remap is leftover from when Layers was a desk tab (CHANGELOG: “the duplicate Layers tab … is gone”).

---

## 11. Undo / copy / persist — what is on the command stack

`shapeCommands.js` types: `add`, `geom`, `reassign`, `label`, `delete`, `replace`, `review`.  
**No command for forest / hide / lock.**

| Action | Undo (`⌘Z`)? | How |
|---|---|---|
| Delete shape from panel or canvas | yes | `delete`; inverse re-adds **same ids** |
| Rename a **shape** (double-click leaf) | yes | `label` |
| Rename a **group** | **no** | `setLayerForest` |
| Group / Ungroup / New Group / drag reorder | **no** | `setLayerForest` |
| Hide / Show / Solo / Lock / Unlock | **no** | maps + optional `group.hidden`/`locked` |
| Duplicate / paste | yes (the `add`) | new ids, **not** re-inserted into the old group |
| Move a group on canvas | yes, **one `geom` per member** | `⌘Z` undoes one member per press |
| Copy (`⌘C`) | n/a | primary shape only |

CHANGELOG: “Deleting a grouped shape and `⌘Z` puts it back in the group.” That works because **delete does not prune `layerForest` children**. `buildLayerTree` skips missing ids (`byId.get` → `null`). Undo restores the same id; the child id is still in the group. `sanitizeForest` only runs on **hydrate**, so a mid-session delete leaves tombstone ids in the in-memory forest (and in the next autosave) until the next load prunes them if still missing.

`deleteSelected` (canvas Delete) does **not** strip `hiddenShapeIds` / `lockedShapeIds`. `deleteLayerIds` (panel Delete) does. After canvas Delete, stale hide/lock keys sit until hydrate `sanitizeLayerIdMap`.

---

## 12. Other surfaces that share hide (not the Layers panel)

`SummaryPanel` receives the same `hiddenShapeIds` and `onToggleHideIds`. Eye on floor / type / code / shape calls `onToggleHideIds(ids)` **without** a boolean → canvas auto-toggles. Summary tree (`summaryTree.js`) only checks `hiddenShapeIds[id]` (not `sheet::`, not lock, not forest).

This is a second hide UI over the same map, grouped by floor/type/code — not a second Layers tree.

---

## 13. Tests that actually cover Layers

`web/test/layerTree.test.ts` (opened): kind mapping, metrics, tree build, paint, multi-sheet folders, group/ungroup/nest/move, lock inheritance in the **built tree**, sanitize maps/forest, persist slice, pick helpers, isolate/solo, autosave dep string pin.

`web/test/canvasTools.test.ts`: arming ≠ leaf; each shape tool’s `layerKind`; markup/chrome never create a leaf.

**Not tested:** `LayersIllustratorPanel` (no component test), TakeoffCanvas hide→SVG/HUD, lock→hit-test, keyboard handlers, `LayersSidebar` (dead).

---

## 14. CSS inventory (live classes)

`web/src/styles/app.css`:

- Rail / dock: `.measure-rail-chrome`, `.canvas-left-stack`, `.canvas-glass-cluster`, `.canvas-circle-btn`, `.canvas-rail-rule`, `.left-panel-slot`, `.left-window`
- Panel: `.ill-panel`, `.ill-panel.is-embedded`, `.ill-titlebar`, `.ill-title`, `.ill-toolbar`, `.ill-tool`, `.ill-body`, `.ill-scroll`, `.ill-row` (+ `.is-sel` `.is-hidden` `.is-locked` `.is-top`), `.ill-eye`, `.ill-lock`, `.ill-selstrip`, `.ill-indent`, `.ill-guide*`, `.ill-disc`, `.ill-thumb`, `.ill-name`, `.ill-rename`, `.ill-metric`, `.ill-end`, `.ill-target`, `.ill-selsquare`, `.ill-foot`, `.ill-find`, `.ill-menu*`
- SVG presentation colors in the row are live paint hex from JS, not CSS variables (AGENTS.md rule). Chrome uses tokens (`--surface-pop`, `--cobalt`, …).

`tokens.css` has **no** layer-specific token names.

---

## 15. What is implemented vs not (checklist)

### Implemented in the live Measure Rail Layers panel

- Open/close from rail icon; mutual exclusion with left desk
- Slide/fade dock, outside-click close, × close
- One row per takeoff on open sheets; sheet folders when ≥2 sheets
- Name, metric, live paint strip + selection square + meatball
- Hide / show (shape, group, sheet folder); Alt-solo
- Lock / unlock (shape, group, sheet); Alt-lock-others
- Nested groups; Group / Ungroup buttons + `Ctrl+Shift+G/U`
- New empty group (`+` / menu)
- Drag nest / reorder (not sheets, not locked)
- Rename group (forest) and rename shape (`label` command)
- Search by name
- Collapse all; Select all (focus sheet)
- Delete selected; Delete hidden
- Duplicate selected (paste as new ungrouped shapes)
- Click → select + fly-to + arm Select
- Ctrl/Shift/Alt pick; canvas Shift/Ctrl multi-pick
- Group move on canvas; selection chrome on all members
- Persist `layer_tree` / `layer_hidden` / `layer_locked`
- Inherit hide/lock for new shapes on a hidden/locked sheet
- AI-detect filter so unrevealed masks stay out of the list
- Markup excluded

### Not implemented (searched, not present)

- Keyboard shortcut to **open/close** Layers
- Host navbar Layers item
- `Ctrl+F`, `F2`, arrow-key pick commit, Space/Enter activate
- Lock / hide on `⌘Z`
- Group / ungroup / reorder / new group on `⌘Z`
- Copy/paste/duplicate **preserving group**
- `⌘C` of the full multi-pick (only `selectedId`)
- Lock item on the **canvas** context menu
- Working `Shift+X` / `Ctrl+G` (labels only)
- Condition editor, wall-segment heights, “Separate” **inside this panel**
- Markup rows in Layers
- Reorder leaves that are not inside a group (ungrouped leaves have no parent group to `moveNodes` into except another group/sheet)
- Cross-sheet groups (refused)
- Agent / voice / MCP control of the tree
- Panel `embedded` mode in the live app
- `shapeMeta` from the canvas
- Persistence of `layerPickIds` / expanded/collapsed tree / search query / panel open
- Component tests for the React panel

### Asymmetry in the hide vs lock model (in the source)

- Canvas hide: `isHiddenId` = map + sheet flag only.
- Canvas lock: `isLockedId` = map + sheet flag + **ancestor `group.locked`**.
- Built tree: ancestor lock is forced onto leaves (`ancestorLocked`); ancestor `group.hidden` is **not** forced onto leaves the same way — leaf hidden is only the id map / sheet flag. Group row `hidden` is `g.hidden || all children hidden`.

If a payload had `group.hidden: true` without child ids in `layer_hidden`, the folder can look hidden in the panel while the canvas still draws the children. The live click path writes **both** the map and the flag, so this is a hydrate/partial-state hole, not the normal click path.

---

## 16. Improvements that follow from this code (not new-product guesses)

These are gaps or contradictions **inside the current wiring**, useful if you copy the behavior elsewhere.

1. **Open shortcut** — rail-only open. `L` is taken by Linear. Any copy needs an explicit unused combo (or a toolbar chord). None exists today.
2. **Undo for tree/hide/lock** — everything except shape delete/rename is `setState` only. Copying “Illustrator Layers” without an undo story will surprise users; the shape stack already exists and is unused here.
3. **Group move = N undos** — one `dispatchShape` per member. A single group-move command (or a batched inverse) is not in the code.
4. **`⌘C` vs Duplicate** — Duplicate uses the pick; Copy uses one id. Same clip format. Easy to align.
5. **Duplicate/paste drops groups** — `clipEntry` has no forest fields.
6. **Canvas Delete vs panel Delete** — only panel delete scrubs hide/lock maps.
7. **Context-menu shortcut lies** — `Ctrl+G` and `Shift+X` are labels without handlers.
8. **Arrow keys** — arborist focus ≠ `layerPickIds`. Either wire `onSelect` for keyboard or ignore `node.isSelected` in the row class.
9. **`Ctrl+A` only when the panel is focused** — canvas-focused `⌘A` is browser select-all. If you copy the panel, document that or add a window handler gated on `illLayersOpen`.
10. **HUD vs Report vs USER_GUIDE** — hide changes live totals, not Report. Docs say neither changes. Pick one rule and implement it in both places.
11. **`isHiddenId` should match `isLockedId`** if you want group.hidden to hide the canvas without relying on duplicated shape ids.
12. **Dead `LayersSidebar.jsx`** — wall-segment / condition-edit still described in `TakeoffFeatureGuide`. Either delete the guide lines or port those rows; do not assume they exist in the live panel.
13. **Host cannot open Layers** — if the copy target is the ADICC host navbar, you must add an `action` (it is not in `LP_TAB_ORDER`).
14. **`embedded` unused** — the prop is the path to drop the titlebar into another chrome. Live app never uses it.
15. **No `menuDepthRef` while Layers is focused** — letter tools still fire (`O`, `A`, `L`, …) with the panel open unless the event target is INPUT. Focusing the panel (`tabIndex=0`) does not block them; only typing in Find/rename does.

---

## 17. What to copy if you want the **same** behavior elsewhere

Reuse these, do not re-derive from filenames:

1. **Pure logic:** `web/src/lib/layerTree.js` (all exports in §5). Tests: `web/test/layerTree.test.ts`.
2. **UI:** `web/src/components/LayersIllustratorPanel.jsx` + `react-arborist` + CSS block `/* Layers panel — ADICC… */` in `app.css` (`.ill-*`).
3. **Icons:** `layers`, `lock`, `unlock`, plus existing `eye` / `eyeOff` / `plus` / `trash` / `search` / `edit` / `duplicate` / `close` / `chevron*`.
4. **Host state (minimum):** `hiddenShapeIds`, `lockedShapeIds`, `layerForest`, `layerPickIds`, `illLayersOpen`, `layerTargetSheetRef`.
5. **Host functions:** the ten callbacks in §7 plus `selectShape` / `flyToShape` / `dispatchShape` / `shapeIsLocked` / `layerGroupIdsFor` / `moveIdsFor` / `picksForPrimarySelect` / `activeLayerPickIds`.
6. **Persist:** spread `layerPersistSlice(...)` into the annotations payload; hydrate with `sanitize*`.
7. **Canvas filters:** `isHiddenId` on draw + hit-test; `isLockedId` on every mutate path you care about (the list in §8 is the current set).
8. **Keyboard:** window `Ctrl+Shift+G/U`; panel `Ctrl+A`, Delete, Escape-for-search; **no** open-panel key.
9. **Do not copy** `LayersSidebar.jsx` unless you want the old checkbox + wall-segment UI.

`renderLiveLayersPanel` in TakeoffCanvas (~10495–10522) is the exact prop list to clone.

---

## 18. Measure Rail interaction (for a copy next to another rail)

- Layers is **not** a measure tool. It is chrome (`TOOL_SPEC.layers`).
- It sits in the same cluster as measure tools and uses the same `railBtn` (no shortcut badge). Measure tools use `measureRailBtn` with `.canvas-rail-kbd`.
- Opening Layers does not change `tool`.
- Closing Layers does not change `tool`.
- Dragging the rail (logo handle) moves the whole chrome including the docked `.left-panel-slot`.
- `pointer-events: none` on the chrome wrapper; the cluster and open `.left-window.is-open` set `pointer-events: auto`.

---

## 19. File / symbol index (for navigation)

```
web/src/components/LayersIllustratorPanel.jsx   live UI
web/src/lib/layerTree.js                        forest + maps + tree
web/src/pages/TakeoffCanvas.jsx                 host (state ~484–599, persist ~2435/3348,
                                                keys ~3800–3801, pick/hit ~4179–4260,
                                                ops ~7945–8138, render ~10495/11013/11053)
web/src/lib/canvasTools.js                      createsLayer / layerKind
web/src/lib/canvasConstants.js                  MEASURE_TOOLS
web/src/styles/app.css                          .ill-* .left-window .measure-rail-chrome
web/src/brand/icons.jsx                         layers / lock / unlock
web/src/components/LayersSidebar.jsx            UNUSED previous UI
web/src/components/SummaryPanel.jsx             shared hide map only
web/src/lib/summaryTree.js                      hidden flag on summary rows
web/test/layerTree.test.ts
web/test/canvasTools.test.ts
```

---

*End of audit. If a behavior is not listed above, it was not found in the files in §1.*
