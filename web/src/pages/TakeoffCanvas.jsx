// Takeoff Canvas — Phase 1 (+ pan/zoom + standard scales).
// Persistent, condition-driven 2D takeoff. Pick a color-coded condition (finish
// tag), click to trace areas; each shape computes SF + perimeter from geometry ×
// calibrated scale. Drawings + scale autosave per project and reload on return.
// Commit sums each condition into ScopeItem.measure and re-runs the takeoff.
//
// Pan/zoom is written DIRECTLY to the DOM (tfRef → style.transform) so dragging
// never triggers a React render — smooth on large sheets. Panning is always at
// hand on every input device: left-drag on open canvas pans (Select), a held
// draw-click that moves becomes a pan, middle-drag / right-drag / Space-drag /
// Pan tool pan always, and continuous trackpad scroll pans both axes. A
// discrete mouse-wheel notch zooms (glided), pinch (ctrl-wheel) zooms, ⇧-wheel
// pans. Geometry math reads tfRef (always current), so drawing stays accurate.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useNavigate } from "react-router-dom";
import * as pdfjsLib from "pdfjs-dist";
import { pdfjsWorkerSrc } from "../lib/pdfWorkerSrc.js";
import { store, isStaleTabError, STALE_TAB_MESSAGE, projectIdFromUrl } from "../lib/store.js";
import { isSupabaseConfigured } from "../lib/supabaseStore.js";
import { aiFloorSheetKeysMatch } from "../lib/supabase/persist.js";
import { goSupabaseHome } from "../lib/supabase/projects.js";
import { consumePendingIngest } from "../lib/pendingIngest.js";
import { isDefaultProjectName, projectNameFromFiles } from "../lib/projectNaming.js";
import { seedStampLibrary, instantiateStamp, markupToStampElement } from "../lib/stamps.js";
import { extractSvgPrimitives, svgToStamp } from "../lib/svgImport.js";
import { transformPath, svgPlacedBox } from "../lib/svgpath.js";
import { ingestFiles } from "../lib/ingest.js";
import ToolMenu from "../components/ToolMenu.jsx";
import PlanNavigator from "../components/PlanNavigator.jsx";
import ReportPanel from "../components/ReportPanel.jsx";
import RevisionsPanel from "../components/RevisionsPanel.jsx";
import TakeoffsPanel, { clampPanelW, CONDITION_DND_MIME, ConditionAppearanceEditor } from "../components/TakeoffsPanel.jsx";
import { HATCHES, PALETTE, NO_FILL, HatchPattern, HatchSwatch } from "../components/hatches.jsx";
import { Icon } from "../brand/icons.jsx";
import { RENDER_SCALE, MAX_GROUP, STANDARD_SCALES, parseSheetKey, compareSheetKeys, extractSheetNumber, detectScale, extractRegionText } from "../lib/sheets";
import { normalizeLoadedGroups } from "../lib/sheetGroups";
import { isCanvasBusy } from "../lib/canvasBusy";
import { parseSchedule, rowToSeed } from "../lib/scheduleParse";
import { normalizeScanRows, postScanWithRetry, SCAN_ENDPOINT, scanRasterScale } from "../lib/scheduleScan";
import { normalizeTag } from "../lib/scheduleEdit";
import {
  extractPlanSymbols, extractRoomLabels, buildPlanSymbolIndex, enrichSymbolsWithSchedule,
  resolveSymbolFields, hitPlanSymbol, symbolNoteKey, SYMBOL_KIND_LABEL,
} from "../lib/planSymbols";
import {
  classifySheetByName, extractScheduleKbFromSheet, buildScheduleKb, lookupScheduleRoomHighlight,
} from "../lib/symbolScheduleKb";
import SymbolSourceViewer from "../components/SymbolSourceViewer.jsx";
import { isGoogleConfigured, isSignedIn, isAllowedDomain, getAccessToken, orgDomainHint } from "../lib/google/auth.js";
import { extractVectorGeometry, buildMask, floodRegionSealed, traceRegion, traceRegionWithHoles, snapVertices, ringArea, MASK_MAX_DIM, SENS_STRICT, SENS_BALANCED, SENS_AGGRESSIVE, openingGapPx, polygonsOverlap, unionPolygons, intersectPolygons, subtractPolygonsToPolys } from "../lib/oneclick";
import { buildWallMaskFromSegs, wallTraceAtPoint } from "../lib/walltrace";
import { buildRasterMask, RASTER_MIN_IMG_FRAC, RASTER_MIN_SEGS, RASTER_RDP_EPS } from "../lib/rastermask";
import { conditionTotals, verticalWallSf } from "../lib/totals.js";
import { shapesInZone } from "../lib/zone.js";
import { sanitizeSheetLevels } from "../lib/sheetLevels.js";
import { sanitizeConditionColumns, sanitizeConditionAttrs, renameColumnValue, columnLabel } from "../lib/conditionColumns.js";
import { sanitizeShapeLabels, sanitizeShapeLabelsOnShapes, renameShapeLabel, shapeLabelValue } from "../lib/shapeLabels.js";
import { buildMarkedSetPdf, downloadBytes } from "../lib/markedset.js";
import { loadProfiles } from "../lib/identity.js";
import { resolveBranding, loadBrandingSelection } from "../lib/branding.js";
import { starPath, cloudPath, thinStroke, strokePathD, chiselRibbon, buildSnapGrid, nearestSnap, ANGLE_TOL, angleSnap, closedMetrics, openLen, pointInPoly, hitShape, arrowheadPath, distToSeg, reflectVertsNorm } from "../lib/geometry.js";
import { flattenCurve } from "../lib/curve.js";
import { dashArrayFor, boostForDark, clampWeight, snapWeight, LINE_STYLES, LINE_STYLE_IDS, WEIGHT_STEPS } from "../lib/lineStyles.js";
import { nextRfiNumber } from "../lib/rfi.js";
import { libFields, matFieldOverridden, libPushPatch, libRevertPatch, libEntryPatch, matEditPatch } from "../lib/materials.js";
import RfiPanel from "../components/RfiPanel.jsx";
import StampPanel from "../components/StampPanel.jsx";
import ImportSchedulePanel from "../components/ImportSchedulePanel.jsx";
import BoqPanel from "../components/BoqPanel.jsx";
import SummaryPanel from "../components/SummaryPanel.jsx";
import LayersIllustratorPanel from "../components/LayersIllustratorPanel.jsx";
import {
  addEmptyGroup,
  activeLayerPickIds,
  collectIdsForLayerToggle,
  descendantShapeIds,
  groupSelection,
  isHiddenId,
  isLockedId,
  layerPersistSlice,
  liftSelection,
  moveNodes,
  parentOf,
  picksForPrimarySelect,
  renameGroup,
  sanitizeForest,
  sanitizeLayerIdMap,
  setGroupFlag,
  sheetKeyFromNodeId,
  sheetNodeId,
  togglePickIds,
  ungroupNodes,
} from "../lib/layerTree.js";
import DrawingsChatPanel from "../components/DrawingsChatPanel.jsx";
import OpenSheetsPill from "../components/OpenSheetsPill.jsx";
import RatesPanel from "../components/RatesPanel.jsx";
import EstimatePanel from "../components/EstimatePanel.jsx";
import FinishesSchedulePanel from "../components/FinishesSchedulePanel.jsx";
import FloatingWindow from "../components/FloatingWindow.jsx";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal.jsx";
import AdiccLoadingLogo from "../components/AdiccLoadingLogo.jsx";
import { ChevronLeft, ChevronRight, Contrast, FileStack, Map as MapIcon, Maximize2, Minimize2, Minus, Plus, Redo2, RotateCcw, Scan, Search, Undo2, X } from "lucide-react";
import LiveReadoutBar from "../components/LiveReadoutBar.jsx";
import TakeoffFeatureGuide from "../components/TakeoffFeatureGuide.jsx";
import WallSegmentHeightsEditor from "../components/WallSegmentHeightsEditor.jsx";
import { segmentHeightsForShape, grossFaceFromSegments, wallSegmentRows, withSegmentHeights, concatSegmentHeightsForMerge, defaultWallHeightFt } from "../lib/wallSegmentHeights.js";
import ShapeBoqHoverCard from "../components/ShapeBoqHoverCard.jsx";
import { resolveShapeBoq, rowKey, detectRoomName, gatherShapeScheduleRefs, shapeQuantities, primaryQty, floorLabelFromSheetId } from "../lib/boqDetect.js";
import { parseOpeningSize, openingsDeductSf, openingsDeductSfLinear, netWallFaceSf, openingDimsFromCutoutPx, bboxIntersectRing } from "../lib/wallOpenings.js";
import { queryChat, finishForRoom, sheetKeyForCitation, buildProjectChatContext, buildLiveCountsSummary, answerFromLiveDetections, resolveChatAnswer } from "../lib/rag.js";
import { priceMaskRow, pricedGrandTotals, pricedConditionTotals } from "../lib/pricing.js";
import { money } from "../lib/num.js";
import { listMaterialRates } from "../lib/supabase/pricing.js";
// In-canvas takeoff agent — BYO-key tool-use loop (lib/agentLoop) aiming the
// registry of deterministic tools (lib/agentTools); this file provides the
// CAPABILITIES those tools close over and the review gate their proposals
// pass through. AiSettings is the config surface for the ai.js seam.
import AgentPanel from "../components/AgentPanel.jsx";
import AiSettings from "../components/AiSettings.jsx";
import { AGENT_TOOL_DEFS, executeAgentTool, agentScaleGate } from "../lib/agentTools.js";
import { runAgentLoop } from "../lib/agentLoop.js";
import { runVoiceCommand, isAgentHandoffTrigger, shouldOfferAgentHandoff } from "../lib/voiceActions";
import { createVoiceRecognizerClient } from "../lib/voiceRecognizerClient";
import { startCapture } from "../lib/voiceCapture";
import { aiConfig, isAiConfigured } from "../lib/ai.js";
import { projectHomeFolderId } from "../lib/projectHome.js";
import ThemeToggle from "../components/ThemeToggle.jsx";
import ProjectSwitcherDropdown from "../components/ProjectSwitcherDropdown.jsx";
// Pure data constants (render/zoom budgets, snap tuning, tool descriptors,
// flooring starter conditions) live in lib/canvasConstants.js; the pure
// module-scope helpers (autoRenderScale, invertCanvasPixels, uid, clamp,
// isDangerMsg, instantiateTemplate, seedConditions) in lib/canvasUtil.js.
import {
  PANEL_GAP, MAX_CANVAS_DIM, MAX_CANVAS_AREA,
  DETAIL_ENGAGE, DETAIL_MARGIN, SYNC_MS, GESTURE_MS, DETAIL_STALL_MS, SNAP_CELL,
  MEASURE_TOOLS, CUT_TOOLS, MARKUP_TOOLS, MARKUP_IDS, HL_INKS, HL_SIZES,
} from "../lib/canvasConstants.js";
import { LETTER_TO_TOOL, SHIFT_LETTER_TO_TOOL, canFinishDraw } from "../lib/canvasTools.js";
import { autoRenderScale, invertCanvasPixels, uid, clamp, isDangerMsg, instantiateTemplate, seedConditions } from "../lib/canvasUtil.js";
// Shape provenance policy now lives in ONE place: lib/shapeCommands.js. Every
// meaningful mutation of `shapes` (create / reshape / reassign / relabel /
// delete) is a COMMAND applied through dispatchShape below — the chokepoint
// that stamps created_at / stampEdit centrally, tallies deletion counters, and
// records undo/redo. Explicit NON-edits that must NOT stamp (they rewrite
// shape records without a human touching the geometry) either ride the
// `replace` command (rescaleSheet's computed re-price, hydrate) or stay as raw
// setShapes (the label-vocabulary renames, live drag PREVIEW frames, the
// hydrate-time sanitizers, per-shape height/thickness re-pricing).
// nowIso stays imported for the non-shape records (markups, RFIs, conditions).
import { nowIso, mintUuid } from "../lib/provenance.js";
import { applyShapeCommand, geomSnapshot, vertsEqual, recordCommand } from "../lib/shapeCommands.js";
import { fmtCheckLen, parseLenInput, checkVerdict, M_PER_FT, areaVal, areaUnit, lenVal, lenUnit, calInputToFeet } from "../lib/units";
import * as panelGeom from "../lib/panelGeometry.js";

// Carpet roll width — a run reaching this needs a seam. The live cursor readout
// turns amber at/past it so the estimator sees where seams fall while tracing.
const CARPET_ROLL_FT = 12;
const VIEW_PREFS_KEY = "opentakeoff_view_prefs_v2";
const VIEW_DEFAULTS = {
  estimate: false,
  readout: false,
  rulers: false,
  grid: false,
  scaleBar: true,
};

/** Plan marks that can prefill wall-opening deducts (D/SD doors, CW/GD curtain & glass). */
function isWallOpeningSymbol(sym) {
  if (!sym) return false;
  const tag = String(sym.tag || "").toUpperCase();
  if (!tag) return false;
  if (sym.kind === "door" || sym.kind === "window") return true;
  if (sym.kind === "finish" && /^(CW|GD|LV)-\d/.test(tag)) return true;
  return false;
}
function openingKindForSymbol(sym) {
  const tag = String(sym?.tag || "").toUpperCase();
  if (/^CW/.test(tag)) return "window";
  if (sym?.kind === "window") return "window";
  return "door";
}
function upsertWallOpening(list, opn, anchorThr = 0.025) {
  // Each custom cutout is its own row — never merge/replace another opening.
  if (opn.source === "cutout") return [...list, opn];
  const tagU = String(opn.tag || "").toUpperCase();
  let idx = -1;
  if (tagU) idx = list.findIndex((o) => String(o.tag || "").toUpperCase() === tagU);
  if (idx < 0 && Array.isArray(opn.anchor_norm)) {
    idx = list.findIndex((o) => Array.isArray(o.anchor_norm)
      && Math.hypot(o.anchor_norm[0] - opn.anchor_norm[0], o.anchor_norm[1] - opn.anchor_norm[1]) < anchorThr);
  }
  if (idx >= 0) {
    const next = [...list];
    next[idx] = { ...next[idx], ...opn, id: next[idx].id };
    return next;
  }
  return [...list, opn];
}

// Click-select against a curved line's DRAWN path: flatten the control points and
// hand hitShape a stand-in shape (lib/geometry.js stays byte-identical with Spline's).
function hitShapeC(s, x, y, w, h, thr) {
  if (!s.curved) return hitShape(s, x, y, w, h, thr);
  const flat = flattenCurve((s.verts_norm || []).map(([nx, ny]) => [nx * w, ny * h]));
  return hitShape({ ...s, verts_norm: flat.map(([px, py]) => [px / w, py / h]) }, x, y, w, h, thr);
}

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerSrc();

// Hatch templates, palette, NO_FILL, and the HatchPattern/HatchSwatch pieces
// live in components/hatches.jsx — shared with the TakeoffsPanel.

// Docked Takeoffs panel geometry — per-user UI prefs (localStorage, diff-only
// overrides like the report column prefs), NEVER in the takeoff payload: panel
// width inside buildPayload would show up as noise in every snapshot diff.
// (The width clamp (clampPanelW, wrapping PANEL_MIN_W/PANEL_MAX_W) is exported
// by the panel itself — ONE clamp, so a future range change can't diverge
// between the panel's own drag clamp and the load-time clamp here.)
const PANEL_PREFS_KEY = "opentakeoff_panel";
// The docked panel now starts COLLAPSED: the top-bar palette band (pinned chips
// + the restored active-condition appearance editor) is the primary condition
// surface, so the sidebar stays out of the way until you ask for it — via the
// canvas rail toggle or by double-clicking a palette chip (openConditionInPanel).
// Prefs persist diff-only against these defaults. Because the OLD default was
// open (collapsed:false), a previously-open panel stored no diff and is
// indistinguishable from "never touched", so this flip DOES start those users
// collapsed on first load after the change (a one-time migration, not a per-user
// choice being honored). An explicit COLLAPSE made under the old default is
// preserved; any later toggle re-persists normally.
const PANEL_DEFAULTS = { w: 320, collapsed: true, strip: false, az: false, group: false };
const DRAWINGS_ASK_HINTS = [
  "What scale is sheet A1105?",
  "What STC requirements are in the acoustic report?",
  "Which electrical drawings cover fire alarm?",
  "What door tags appear on the 1st floor plan?",
];
const LP_TAB_ORDER = ["summary", "files", "sheets", "markup", "stamp", "rfi"];
const LP_TAB_LABELS = {
  summary: "Summary",
  files: "Files",
  sheets: "Sheets",
  markup: "Markups",
  stamp: "Stamps",
  rfi: "RFIs",
};
// Top-bar quick-access condition palette: a curated handful (≤9) of pinned
// conditions for one-click activation without leaving the canvas. Palette holds
// condition ids (workspace-scoped), so it persists with the annotation payload,
// not the per-user panel prefs. Capped at 9 so it maps 1:1 onto the 1–9 hotkeys.
const PALETTE_MAX = 9;

// Pure geometry helpers (star/cloud paths, snap grid, angle lock, metrics,
// hit-testing) live in lib/geometry.js — byte-identical with Spline's copy.

// The materials/column editors (MaterialsEditor, ColumnSelects, AddValueInput)
// live in components/TakeoffsPanel.jsx — the panel is their only surface now.

/** Live takeoff-value sparkline — interactive hover shows point + delta. */
function EstimateValueSpark({ series, currency }) {
  const W = 120, H = 40, padX = 4, padY = 4;
  const [hover, setHover] = useState(null);
  const pts = useMemo(() => {
    const raw = (series || []).filter((p) => Number.isFinite(p?.v));
    if (raw.length === 0) return [{ t: Date.now(), v: 0 }];
    return raw;
  }, [series]);
  const mapped = useMemo(() => {
    const n = pts.length;
    const vals = pts.map((p) => p.v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    const span = hi - lo;
    return pts.map((p, i) => {
      const x = padX + (n <= 1 ? (W - padX * 2) / 2 : (i / (n - 1)) * (W - padX * 2));
      const y = padY + (1 - (p.v - lo) / span) * (H - padY * 2);
      return { ...p, x, y, i };
    });
  }, [pts]);
  const lineD = useMemo(() => {
    if (!mapped.length) return "";
    if (mapped.length === 1) return `M${mapped[0].x.toFixed(1)},${mapped[0].y.toFixed(1)}`;
    if (mapped.length === 2) {
      return `M${mapped[0].x.toFixed(1)},${mapped[0].y.toFixed(1)} L${mapped[1].x.toFixed(1)},${mapped[1].y.toFixed(1)}`;
    }
    // Smooth cubic Bezier through points (Catmull-Rom → cubic).
    let d = `M${mapped[0].x.toFixed(1)},${mapped[0].y.toFixed(1)}`;
    for (let i = 0; i < mapped.length - 1; i++) {
      const p0 = mapped[i === 0 ? i : i - 1];
      const p1 = mapped[i];
      const p2 = mapped[i + 1];
      const p3 = mapped[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return d;
  }, [mapped]);
  const trendUp = mapped.length >= 2 && mapped[mapped.length - 1].v >= mapped[0].v;
  const stroke = trendUp ? "var(--c-positive)" : "var(--c-danger)";
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = mapped[0], bestD = Infinity;
    for (const p of mapped) {
      const d = Math.abs(p.x - x);
      if (d < bestD) { bestD = d; best = p; }
    }
    const prev = best.i > 0 ? mapped[best.i - 1] : null;
    const delta = prev ? best.v - prev.v : 0;
    setHover({ ...best, delta, prev });
  };
  return (
    <div className="estimate-spark" onMouseLeave={() => setHover(null)}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="estimate-spark-svg" onMouseMove={onMove} role="img" aria-label="Live takeoff value trend">
        <path d={lineD} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        {mapped.map((p) => (
          <circle key={p.i} cx={p.x} cy={p.y} r={hover?.i === p.i ? 3.2 : 1.6} fill={stroke} stroke="var(--hud-halo, #fff)" strokeWidth="0.8" />
        ))}
        {hover && (
          <line x1={hover.x} y1={padY} x2={hover.x} y2={H - padY} stroke="rgba(31,63,199,0.35)" strokeWidth="1" strokeDasharray="2 2" />
        )}
      </svg>
      {hover && (
        <div className="estimate-spark-tip" style={{ left: Math.min(W - 8, Math.max(8, hover.x)) }}>
          <div className="estimate-spark-tip-val">{money(hover.v || 0, currency)}</div>
          <div className={`estimate-spark-tip-delta${hover.delta > 0 ? " is-up" : hover.delta < 0 ? " is-down" : ""}`}>
            {hover.prev
              ? `${hover.delta > 0 ? "+" : ""}${money(hover.delta, currency)} vs prior`
              : "Start of session"}
          </div>
          <div className="estimate-spark-tip-time">
            {new Date(hover.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </div>
        </div>
      )}
    </div>
  );
}

function useOpenMotion(open, durationMs = 360) {
  const [shown, setShown] = useState(() => !!open);
  const [entered, setEntered] = useState(() => !!open);
  // Enter: mount closed, then flip to open on the next frames so CSS can interpolate.
  // Exit: drop entered immediately, unmount after the transition duration.
  useLayoutEffect(() => {
    if (!open) return undefined;
    setShown(true);
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setEntered(true);
      return undefined;
    }
    setEntered(false);
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
    };
  }, [open]);
  useEffect(() => {
    if (open) return undefined;
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setEntered(false);
    const id = window.setTimeout(() => setShown(false), reduce ? 0 : durationMs);
    return () => window.clearTimeout(id);
  }, [open, durationMs]);
  return { shown, entered };
}

export default function TakeoffCanvas() {
  // Client-only: a single local workspace in this browser (no project id, no backend).
  const [sheets, setSheets] = useState([]);
  const [active, setActive] = useState("");      // active source PDF file name
  const [page, setPage] = useState(1);           // 1-based page within the active PDF
  const [pageCount, setPageCount] = useState(1); // pages in the active PDF
  const [view, setView] = useState("canvas");    // "gallery"/"picker" overlay the canvas (gallery-first on empty projects)
  // Cloud mode = the active store is a Drive-backed cloudStore (it has listFolder;
  // localStore does not). In cloud mode an empty project shows the Drive file
  // PICKER instead of the local drag-in prompt, so we don't auto-download every
  // PDF in the folder (spec books, as-builts). Stable per mount (store is swapped
  // in before the canvas mounts).
  const cloudMode = typeof store.listFolder === "function";
  const supabaseMode = isSupabaseConfigured();
  // Reactive sign-in state: the "browse team projects" toolbar link is a
  // convenience shortcut for someone ALREADY signed in — it must never appear
  // while signed out, or it'd be a second OAuth entry point (a /projects
  // sign-in wall) in the toolbar, breaking the pre-Drive local-first look.
  // Client-side exit back to the project home (`/`) — main.jsx's gate cleanup
  // restores the local store on the way out, so this navigation is safe.
  const navigate = useNavigate();
  // Two distinct exits out of a cloud project, both needed once every sheet is
  // closed: "Close project" always works (it's just leaving `/?project=` for
  // the local canvas — main.jsx's gate cleanup restores the local store), so
  // it's the one guaranteed path out even on deployments with no Projects root
  // configured. "Browse projects" additionally jumps straight to the team's
  // project list at /projects, when the build names one.
  const closeProject = () => navigate("/");
  const browseProjects = projectHomeFolderId() ? () => navigate("/projects") : null;
  const [openTabs, setOpenTabs] = useState([]);   // sheetKeys open as tabs across the top
  const [galleryLabels, setGalleryLabels] = useState({}); // sheetKey → title-block number, all files
  const [pageLabels, setPageLabels] = useState({}); // { pageNum: "A003" } from the title block
  const [sheetGroup, setSheetGroup] = useState([]);   // sheetKeys shown side-by-side; [] = single-sheet mode
  const [sheetLevels, setSheetLevels] = useState({}); // sheetKey → level label ("L1") — persisted (additive `sheet_levels` key); groups the gallery for multi-floor sets
  // sheet PDF name → relative folder path from a Folder upload (webkitRelativePath).
  // Persisted as additive `file_folders` so the Files sidebar can nest plans under
  // expandable folders after reload. Loose single-file opens stay at the root.
  const [fileFolders, setFileFolders] = useState({});
  // Plan-symbol index (door/window/type/finish marks from the PDF text layer).
  // Raw extract lives in a ref (per-sheet); planSymbols is the enriched view
  // (cross-sheet matches + schedule fields). symbolNotes holds manual fills.
  const planSymbolsRawRef = useRef({});
  const roomLabelsRawRef = useRef({});
  const scheduleKbRef = useRef(new Map());   // mark → ScheduleKbEntry from project PDFs
  const [symbolEpoch, setSymbolEpoch] = useState(0);
  const [symbolKbEpoch, setSymbolKbEpoch] = useState(0);
  const [planSymbols, setPlanSymbols] = useState([]);
  const [symbolNotes, setSymbolNotes] = useState({});
  const [symbolHover, setSymbolHover] = useState(null);   // { id, cx, cy } screen-local
  const [symbolFocus, setSymbolFocus] = useState(null);   // pinned PlanSymbol id for editing
  const [symbolSourceView, setSymbolSourceView] = useState(null); // floating PDF viewer target
  const symbolSourceViewRef = useRef(null);
  useEffect(() => { symbolSourceViewRef.current = symbolSourceView; }, [symbolSourceView]);
  const [openFolderPaths, setOpenFolderPaths] = useState({}); // folder path → true when expanded (default collapsed)
  const [filesSearch, setFilesSearch] = useState(""); // Files panel — name filter + highlight
  const [pendingPdfClose, setPendingPdfClose] = useState(null); // filename waiting on confirm — closePdf itself is never changed
  const [pendingMarkupDelete, setPendingMarkupDelete] = useState(null); // markup waiting on confirm — deleteMarkup itself is never changed
  const [pendingTakeoffsConfirm, setPendingTakeoffsConfirm] = useState(null); // Takeoffs drawer destructive action waiting on themed confirm
  const [lastGroup, setLastGroup] = useState([]);     // most recent side-by-side composition — "Regroup" restores it
  const [focusKey, setFocusKey] = useState("");         // panel of the last click — scale/calibrate target in group mode
  const [zoneCheck, setZoneCheck] = useState(null);   // ephemeral zone-check region {key, pts (norm)} — never persisted (buildPayload doesn't read it)
  const [zoneExpand, setZoneExpand] = useState(null); // zone panel: condition id with materials expanded
  // Shared reset for the two zone transients — every site that discards
  // OTHER in-flight measurement state (sheet change, snapshot load, hydrate)
  // must discard this too, or the results panel and glow can outlive the
  // region/shapes they described. See the tool-change effect below for the
  // matching `poly` (pending zone trace) reset, which has its own rule.
  const resetZone = () => { setZoneCheck(null); setZoneExpand(null); };
  const [markups, setMarkups] = useState([]);                // cloud/callout/text annotations (separate from measurement shapes)
  const [markupDraft, setMarkupDraft] = useState(null);      // in-progress markup first point (cloud/callout/highlight)
  // Floating LEFT panel — one at a time: null | "files" | "sheets" | "markup" | "stamp" | "rfi".
  // Layers has its own rail icon. One folder icon opens/closes this desk; tabs switch inside.
  const [leftTab, setLeftTab] = useState(null);
  const leftTabRef = useRef(leftTab);
  const [leftPanelPresentation, setLeftPanelPresentation] = useState("dock");
  const leftPanelPresentationRef = useRef(leftPanelPresentation);
  const [hostPanelAnchorLeft, setHostPanelAnchorLeft] = useState(16);
  const hostMenuRef = useRef(null);
  const measureRailRef = useRef(null);
  const MEASURE_RAIL_POS_KEY = "opentakeoff_measure_rail_pos_v3";
  const [measureRailPos, setMeasureRailPos] = useState(() => {
    try {
      const raw = localStorage.getItem(MEASURE_RAIL_POS_KEY)?.trim();
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return { x: p.x, y: p.y };
    } catch {
      try { localStorage.removeItem(MEASURE_RAIL_POS_KEY); } catch { /* private mode */ }
    }
    return null;
  });
  const measureRailPosRef = useRef(measureRailPos);
  const measureRailDragRef = useRef(null);
  const measureRailDragLiveRef = useRef(null);
  const measureRailDragRafRef = useRef(0);
  const measureRailResettingRef = useRef(false);
  const measureRailDraggingRef = useRef(false);
  const [measureRailResetting, setMeasureRailResetting] = useState(false);
  useEffect(() => { measureRailPosRef.current = measureRailPos; }, [measureRailPos]);
  const [lpTabsOverflow, setLpTabsOverflow] = useState({ start: false, end: false });
  const leftDesk = useOpenMotion(!!leftTab);
  const [illLayersOpen, setIllLayersOpen] = useState(false); // Illustrator-style Layers panel (live shapes)
  const lastLeftTabRef = useRef("files");
  const toggleLayersPanel = useCallback(() => {
    setLeftPanelPresentation("dock");
    setIllLayersOpen((open) => {
      const next = !open;
      if (next) setLeftTab(null);
      return next;
    });
  }, []);
  useEffect(() => { if (leftTab && leftTab !== "layers") lastLeftTabRef.current = leftTab; }, [leftTab]);
  useEffect(() => { if (leftTab === "layers") setLeftTab("files"); }, [leftTab]);
  useEffect(() => {
    leftTabRef.current = leftTab;
    try {
      window.parent?.postMessage({
        source: "opentakeoff",
        type: "adicc:canvas-panel-state",
        panel: leftTab,
      }, "*");
    } catch { /* cross-origin embed */ }
  }, [leftTab]);
  useEffect(() => { leftPanelPresentationRef.current = leftPanelPresentation; }, [leftPanelPresentation]);
  useEffect(() => {
    const el = lpTabsScrollRef.current;
    if (!el || !leftTab) return;
    const wrap = el.closest(".left-panel-glass-tabs");
    const sync = () => {
      const start = el.scrollLeft > 2;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setLpTabsOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
      if (wrap) {
        wrap.classList.toggle("has-overflow-start", start);
        wrap.classList.toggle("has-overflow-end", end);
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    const mo = new MutationObserver(sync);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener("scroll", sync, { passive: true });
    const onWheel = (e) => {
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      e.stopPropagation();
      el.scrollLeft += (e.deltaX || e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const on = el.querySelector(".lp-tab.is-on");
    on?.scrollIntoView({ inline: "nearest", block: "nearest" });
    sync();
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", sync);
      el.removeEventListener("wheel", onWheel);
    };
  }, [leftTab, leftDesk.shown]);
  const shiftLpTabs = (dir) => {
    const el = lpTabsScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(96, el.clientWidth * 0.55), behavior: "smooth" });
  };
  const [sheetsSearch, setSheetsSearch] = useState("");
  const toggleSheetsTab = useCallback(() => {
    const fromHostMenu = leftPanelPresentationRef.current === "menu";
    setLeftPanelPresentation("dock");
    setIllLayersOpen(false);
    setLeftTab((cur) => (cur === "sheets" && !fromHostMenu ? null : "sheets"));
  }, []);
  const leftTabHoldRef = useRef(leftTab);
  if (leftTab) leftTabHoldRef.current = leftTab;
  const deskTab = leftTab || (leftDesk.shown ? leftTabHoldRef.current : null);
  const lpScrollRef = useRef(null);
  const lpTabMotionRef = useRef({ tab: deskTab, animate: false, dir: 1 });
  const [, bumpLpTabMotion] = useState(0);
  if (deskTab && deskTab !== lpTabMotionRef.current.tab) {
    const prev = lpTabMotionRef.current.tab;
    const from = LP_TAB_ORDER.indexOf(prev);
    const to = LP_TAB_ORDER.indexOf(deskTab);
    lpTabMotionRef.current = {
      tab: deskTab,
      dir: from >= 0 && to >= 0 && to < from ? -1 : 1,
      animate: leftDesk.shown && leftDesk.entered && prev != null,
    };
  }
  const hostMenuSwitching = leftPanelPresentation === "menu" && lpTabMotionRef.current.animate;
  useLayoutEffect(() => {
    if (!deskTab) lpTabMotionRef.current = { tab: null, animate: false, dir: 1 };
  }, [deskTab]);
  useEffect(() => {
    if (!lpTabMotionRef.current.animate) return undefined;
    const id = window.setTimeout(() => {
      lpTabMotionRef.current = { ...lpTabMotionRef.current, animate: false };
      bumpLpTabMotion((n) => n + 1);
    }, 280);
    return () => window.clearTimeout(id);
  }, [deskTab]);
  useLayoutEffect(() => {
    if (leftPanelPresentation !== "menu" || !deskTab) return;
    const el = lpScrollRef.current;
    if (el) el.scrollTop = 0;
  }, [deskTab, leftPanelPresentation]);
  const layersMotion = useOpenMotion(illLayersOpen);
  const openGallery = useCallback(() => {
    setLeftTab(null);
    setView("gallery");
  }, []);
  // Layers panel — hide/lock maps + nested group forest (additive `layer_tree`).
  const [hiddenShapeIds, setHiddenShapeIds] = useState({});
  const [lockedShapeIds, setLockedShapeIds] = useState({});
  const [layerPickIds, setLayerPickIds] = useState({});
  const [layerForest, setLayerForest] = useState({});
  const layerTargetSheetRef = useRef(null);
  useEffect(() => { if (leftTab) setIllLayersOpen(false); }, [leftTab]);
  useEffect(() => { if (!openTabs.length) setLeftTab((cur) => (cur === "sheets" ? "files" : cur)); }, [openTabs.length]);
  const [minimapOpen, setMinimapOpen] = useState(() => {
    try { return localStorage.getItem("opentakeoff_minimap") !== "0"; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem("opentakeoff_minimap", minimapOpen ? "1" : "0"); } catch { /* private mode */ } }, [minimapOpen]);
  const [viewPrefs, setViewPrefs] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(VIEW_PREFS_KEY) || "{}");
      const next = { ...VIEW_DEFAULTS };
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const key of Object.keys(VIEW_DEFAULTS)) {
          if (typeof saved[key] === "boolean") next[key] = saved[key];
        }
      }
      return next;
    } catch { return { ...VIEW_DEFAULTS }; }
  });
  useEffect(() => {
    try { localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(viewPrefs)); } catch { /* private mode */ }
  }, [viewPrefs]);
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const viewStateRef = useRef({ ...viewPrefs, minimap: minimapOpen, expanded: canvasExpanded });
  viewStateRef.current = { ...viewPrefs, minimap: minimapOpen, expanded: canvasExpanded };
  const minimapCanvasRef = useRef(null);
  const minimapViewRef = useRef(null);
  const zoomBarRef = useRef(null);
  const [minimapPaintEpoch, setMinimapPaintEpoch] = useState(0);
  const rulerXRef = useRef(null);
  const rulerYRef = useRef(null);
  const minimapScaleRef = useRef(0);
  const minimapLayoutRef = useRef({ boxW: 0, boxH: 0, ox: 0, oy: 0, s: 0 });
  const minimapDragRef = useRef(false);
  const [showMarkups, setShowMarkups] = useState(true);       // markup SVG layer visibility (orthogonal to the export checkbox)
  const [editor, setEditor] = useState(null);                 // inline on-canvas text editor { left, top, value, multiline, commit } (retires window.prompt; screen-space overlay, NOT an SVG child)
  const [panelEditId, setPanelEditId] = useState(null);       // markup id whose text is being edited inline in the markup panel (off-screen fallback for the ✎ button)
  // Stamp library (browser-global, meta store) — reusable annotation stamps
  // dropped click-to-place (#40). armedStamp holds the stamp picked from the
  // palette; while tool==="stamp" each canvas click instantiates it as normal,
  // editable markups. Persist mirrors the template/material library pattern.
  const [stampLib, setStampLib] = useState({ stamps: [], sets: [] });
  const stampLibRef = useRef({ stamps: [], sets: [] });       // readable outside a render (persist merges)
  const [armedStamp, setArmedStamp] = useState(null);         // stamp armed for click-to-place (tool==="stamp")
  // Docked Takeoffs panel (right side, reflows the canvas): width + collapsed
  // persist per user in localStorage as diffs against PANEL_DEFAULTS.
  const [panelPrefs, setPanelPrefs] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || "{}");
      return { ...PANEL_DEFAULTS, ...(p && typeof p === "object" && !Array.isArray(p) ? p : {}) };
    } catch { return { ...PANEL_DEFAULTS }; }
  });
  // The ADICC platform can temporarily clear canvas chrome without touching
  // project data or takeoff state. Visibility is session-only; the existing
  // Takeoffs collapsed preference remains the sole persisted drawer setting.
  const [toolbarChrome, setToolbarChrome] = useState({
    measureVisible: true,
    workspaceVisible: true,
  });
  const toolbarChromeRef = useRef(toolbarChrome);
  const workspaceBarRef = useRef(null);
  toolbarChromeRef.current = toolbarChrome;
  // Panel VIEW state (tab, filter, collapsed groups, ⌘/⇧ multi-select) lives
  // in the TakeoffsPanel component. Two hooks back into it from here:
  const [panelEpoch, setPanelEpoch] = useState(0);   // bumped by hydrate — the panel clears the transients that described the replaced conditions
  const panelSelectionRef = useRef(null);            // the panel registers "dismiss the bulk selection" here; activateCondition calls it
  const [templates, setTemplates] = useState([]);             // condition template library (browser-global, meta store)
  const templatesRef = useRef([]);                            // readable inside hydrate (seeding a fresh workspace)
  const [matLib, setMatLib] = useState([]);                   // material library (browser-global; conditions COPY on attach + carry lib_id)
  const labeledFileRef = useRef("");             // which file we've already title-block-scanned
  const wantSheetRef = useRef(new URLSearchParams(window.location.search).get("sheet") || "");
  const [status, setStatus] = useState("loading");
  const [err, setErr] = useState("");

  const [tool, setTool] = useState("pan");
  const [panelImgs, setPanelImgs] = useState({}); // { sheetKey: {w,h} } rendered bitmap dims per panel
  const [tf, setTf] = useState({ x: 0, y: 0, scale: 1 }); // render mirror of tfRef

  const [scales, setScales] = useState({});
  const [scaleSources, setScaleSources] = useState({}); // scale provenance for the report — typically "calibrated" | "standard" | "detected", but any string a newer build wrote is kept verbatim; sheets that predate the flag export "unknown"
  const [detectedScales, setDetectedScales] = useState({}); // { sheetKey: {upp,label,multi} } read off the plan text
  const [darkMode, setDarkMode] = useState(() => { try { return localStorage.getItem("opentakeoff_dark") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("opentakeoff_dark", darkMode ? "1" : "0"); } catch { /* private mode */ } }, [darkMode]);
  const isEmbedded = typeof window !== "undefined" && window.self !== window.top;
  useEffect(() => {
    if (!isEmbedded) return undefined;
    const onPointerDown = (e) => {
      if (leftPanelPresentationRef.current === "menu" && leftTabRef.current) {
        const menu = hostMenuRef.current;
        const rail = measureRailRef.current;
        if (!menu?.contains(e.target) && !rail?.contains(e.target)) {
          setLeftTab(null);
        }
      }
      try {
        window.parent?.postMessage({ source: "opentakeoff", type: "adicc:host-pointer-down" }, "*");
      } catch { /* cross-origin embed */ }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [isEmbedded]);
  useEffect(() => {
    const onFullscreen = () => {
      const active = !!document.fullscreenElement;
      setCanvasExpanded(active);
      if (isEmbedded) {
        try {
          window.parent?.postMessage({
            source: "opentakeoff",
            type: "adicc:canvas-expand-state",
            active,
          }, "*");
        } catch { /* cross-origin embed */ }
      }
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, [isEmbedded]);
  useEffect(() => {
    const onMsg = (e) => {
      const d = e?.data;
      if (!d || d.source !== "adicc-platform" || d.type !== "adicc:sheet-invert-toggle") return;
      setDarkMode((v) => !v);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  useEffect(() => {
    if (view !== "canvas" || status !== "ready") return;
    try {
      window.parent?.postMessage({ source: "opentakeoff", type: "adicc:sheet-invert-state", active: darkMode }, "*");
    } catch { /* cross-origin embed */ }
  }, [darkMode, view, status]);
  // diff-only prefs (cf. reportColumns): only keys that differ from the
  // defaults persist, so a future default change reaches existing users
  useEffect(() => {
    try {
      const diff = {};
      for (const k of Object.keys(PANEL_DEFAULTS)) if (panelPrefs[k] !== PANEL_DEFAULTS[k]) diff[k] = panelPrefs[k];
      localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(diff));
    } catch { /* private mode */ }
  }, [panelPrefs]);
  const panelW = clampPanelW(Number(panelPrefs.w) || PANEL_DEFAULTS.w);
  const takeoffsOpen = !panelPrefs.collapsed;
  toolbarChromeRef.current = { ...toolbarChrome, takeoffsVisible: takeoffsOpen };
  const toggleTakeoffs = useCallback(() => {
    setPanelPrefs((p) => ({ ...p, collapsed: !p.collapsed }));
  }, []);
  const setToolbarVisible = useCallback((tool, visible) => {
    if (tool === "takeoffs") {
      setPanelPrefs((current) => ({ ...current, collapsed: !visible }));
    } else {
      const key = tool === "measure" ? "measureVisible" : "workspaceVisible";
      setToolbarChrome((current) => ({
        ...current,
        [key]: visible,
      }));
    }
  }, []);
  const [takeoffsShown, setTakeoffsShown] = useState(takeoffsOpen);
  const [takeoffsEntered, setTakeoffsEntered] = useState(takeoffsOpen);
  const takeoffsShownRef = useRef(takeoffsShown);
  takeoffsShownRef.current = takeoffsShown;
  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (takeoffsOpen) {
      setTakeoffsShown(true);
      if (reduce || takeoffsShownRef.current) {
        setTakeoffsEntered(true);
        return undefined;
      }
      let raf2 = 0;
      const raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => setTakeoffsEntered(true));
      });
      return () => {
        window.cancelAnimationFrame(raf1);
        window.cancelAnimationFrame(raf2);
      };
    }
    setTakeoffsEntered(false);
    const id = window.setTimeout(() => setTakeoffsShown(false), reduce ? 0 : 420);
    return () => window.clearTimeout(id);
  }, [takeoffsOpen]);
  // Panel resize lives INSIDE TakeoffsPanel (mid-drag width goes straight to
  // its DOM node; the pref commits ONCE on release via setPanelPrefs). Each
  // committed width change reflows the canvas container — coordinate math is
  // safe (pointer→image reads the rect at event time; the stage transform is
  // anchored top-left, so content stays put and we deliberately do NOT
  // re-fit) — but the hi-res detail crop only re-renders on transform change,
  // so the detail effect also keys on panelW/takeoffsOpen below, and mid-drag
  // the panel holds the gesture window open through this callback (like wheel
  // zoom) so the crop re-renders once per drag, on settle.
  const holdPanelGesture = useCallback(() => { gestureUntilRef.current = performance.now() + GESTURE_MS; }, []);
  // negative view is baked into the canvas PIXELS (invertCanvasPixels), never a
  // CSS filter — track which canvases currently hold inverted pixels (only
  // canvases that finished a render get an entry), + darkMode readable from
  // async render chains
  const canvasInvertedRef = useRef(new Map());
  const darkModeRef = useRef(darkMode);
  const [hiResKeys, setHiResKeys] = useState(() => {        // per-sheet hi-res raster — per user (localStorage)
    try { return JSON.parse(localStorage.getItem("opentakeoff_hires") || "[]"); } catch { return []; }
  });
  const [calib, setCalib] = useState([]);
  const [pendingLen, setPendingLen] = useState("");
  // Display unit system (ft/m toggle beside the scale picker) — DISPLAY LAYER
  // ONLY: all stored takeoff math stays feet (lib/units contract), so toggling
  // never rewrites a shape, a scale, or a coverage rate. Browser default via
  // localStorage; a project that saved a units field overrides on hydrate.
  const [units, setUnits] = useState(() => { try { return localStorage.getItem("opentakeoff_units") === "metric" ? "metric" : "imperial"; } catch { return "imperial"; } });
  useEffect(() => { try { localStorage.setItem("opentakeoff_units", units); } catch { /* private mode */ } }, [units]);
  const [check, setCheck] = useState([]);             // Check tool: 0–2 stage-px points along a printed dimension
  const [checkStated, setCheckStated] = useState(""); // what the drawing says that dimension is
  const [scaleGuide, setScaleGuide] = useState(null); // ephemeral calibrated ruler {key, feet, px, label, at:[x,y]} — never persisted (buildPayload doesn't read it)
  const scaleGuideTimerRef = useRef(0);
  const scaleGuidePreviewRef = useRef(false); // true while the visible guide is a hover PREVIEW of an unaccepted scale — the preview must die with the hover/menu; an accepted bar stays
  const wallAreaLoopCloseRef = useRef(false); // Wall Area: finishShape closes the run back to its first point
  // One-slot revert stash: the scale a quantity-changing rescale replaced
  // ({key, upp, source}). An oops-hatch, not an undo history — ephemeral by
  // design (never persisted): a mistyped recalibrate is caught within a menu
  // click, not archaeologically.
  const [prevScale, setPrevScale] = useState(null);

  const [conditions, setConditions] = useState([]);
  const [conditionColumns, setConditionColumns] = useState([]);  // project-level custom-column vocabulary [{ id, name, values }] — assignments live on c.attrs
  const [shapeLabels, setShapeLabels] = useState([]);  // project-level flat vocabulary of phase/area labels (#110) — assignment lives on shape.label
  const [activeCond, setActiveCond] = useState("");
  const [activeLabel, setActiveLabel] = useState(null);   // session-only active phase/area label (#111) — new traces get it; NOT persisted (absent from buildPayload, reset on hydrate)
  const [palette, setPalette] = useState([]);   // ordered condition ids pinned to the top-bar quick-access palette (≤ PALETTE_MAX)
  const [shapes, setShapes] = useState([]);
  const [poly, setPoly] = useState([]);
  const [proposal, setProposal] = useState(null);  // One-Click selection under review: { key, regions: [{kind:'pos'|'neg', seed, poly, area_sf, perim_lf}] } — panel-LOCAL px
  // ── in-canvas takeoff agent state ──────────────────────────────────────────
  // agentProposals are NOT shapes: committed truth stays committed. Each entry
  // {id, sheet_id, condition_id, measure_role, verts_norm, evidence, seed_norm?,
  //  proposed_ts, area_sf, perim_lf} renders as a DASHED pencil outline until
  // the human accepts (→ dispatchShape add with agent_v1 origin) or rejects
  // (→ dropped LOCALLY — dismissed geometry never rides the contribution wire).
  // Ephemeral by design: never persisted (buildPayload doesn't read them).
  const [agentProposals, setAgentProposals] = useState([]);
  const [agentOpen, setAgentOpen] = useState(false);      // docked right-rail Agent panel
  const [agentLog, setAgentLog] = useState([]);           // streaming run status [{kind, text}]
  const [agentRunning, setAgentRunning] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false); // BYO-key config modal (ai.js seam)
  const agentAbortRef = useRef(null);                     // live AbortController while a run is in flight
  // Live mirror of the render-scope state the agent's capability closures read:
  // the loop runs across many awaits, so closures must read CURRENT state, not
  // the run-click render's. Updated every render (cheap object build).
  const agentStateRef = useRef({ panels: [], scales: {}, scaleSources: {}, detectedScales: {}, conditions: [], status: "loading" });
  useEffect(() => () => agentAbortRef.current?.abort(), []);   // leaving the canvas stops a live agent run
  const [ocSel, setOcSel] = useState(null);        // selected proposal vertex {ri, vi} — Delete removes just that point
  const [ocHover, setOcHover] = useState(-1);      // proposal region under the cursor — handles reveal on hover
  const [selectedId, setSelectedId] = useState(null);   // selected shape (Select tool)
  const [selectedCutoutIds, setSelectedCutoutIds] = useState(() => new Set()); // multi-select for deduct cutouts
  const [cutoutChecks, setCutoutChecks] = useState({}); // checklist id → checked (apply cutouts to parent)
  const [cutoutPanelPos, setCutoutPanelPos] = useState(null); // { left, top } after user drags the floating Cutouts card
  const [cutoutPanelSize, setCutoutPanelSize] = useState({ w: 240, h: 280 }); // floating Cutouts card size
  const [shapeCtxMenu, setShapeCtxMenu] = useState(null); // { x, y, shapeId } canvas-local right-click menu
  const shapeCtxMenuRef = useRef(null);
  shapeCtxMenuRef.current = shapeCtxMenu;
  const [selectMarquee, setSelectMarquee] = useState(null); // { x0, y0, x1, y1 } box selection
  const boxSelectRef = useRef(null);
  const [selVert, setSelVert] = useState(null);         // selected vertex index of the selected shape — Delete removes just that point
  const [wallSegmentFocus, setWallSegmentFocus] = useState(null); // surface_area segment index highlighted from panel
  const [selHole, setSelHole] = useState(null);       // selected trim hole index (holes_norm), null = outer ring
  const [hoverEdge, setHoverEdge] = useState(null);   // { shapeId, i, length, t } — edge length chip follows cursor along the segment (t ∈ [0,1])
  const [selectedMarkupId, setSelectedMarkupId] = useState(null); // selected markup — mutually exclusive with selectedId
  const [wallCutoutDraft, setWallCutoutDraft] = useState(null); // { shapeId, a: [x,y]|null } — linear custom cutout on wall_area only
  const wallCutoutDraftRef = useRef(null);
  wallCutoutDraftRef.current = wallCutoutDraft;
  const [wallCutoutFocus, setWallCutoutFocus] = useState(null); // { a:[x,y], b:[x,y] } stage px — highlight after fly-to
  const wallCutoutFocusTimerRef = useRef(null);
  const [rfis, setRfis] = useState([]);                 // RFI register (Request For Information); linked to markups via markup.rfi_id === rfi.id
  // Deletion provenance: shapes leave no record once filtered out of `shapes`,
  // so every delete COMMAND yields a per-origin-method tally (`counted`, keyed
  // by origin.method, "manual" when absent) that dispatchShape merges here.
  // Serialized as provenance_counters — omit-when-empty — so the corpus can
  // see how much machine output was thrown away, not only what survived.
  const [provCounters, setProvCounters] = useState({ shapes_deleted: {} });
  const countDeleted = (tally) => {
    const keys = Object.keys(tally);
    if (!keys.length) return;
    setProvCounters((pc) => {
      const sd = { ...pc.shapes_deleted };
      for (const k of keys) sd[k] = (sd[k] || 0) + tally[k];
      return { ...pc, shapes_deleted: sd };
    });
  };
  // ── the shape-command chokepoint ──────────────────────────────────────────
  // EVERY meaningful `shapes` mutation dispatches a command; the pure apply
  // (lib/shapeCommands.js) owns the provenance policy, this wrapper owns the
  // React side: setShapes the result, merge the deletion tally, and keep the
  // undo/redo stacks. Stacks live in refs (no render on push); applied against
  // the render's `shapes`, which a discrete event always sees current (the
  // undoLast precedent) — NEVER inside a setShapes updater (updaters can
  // double-run; counting/recording there would double-tally).
  //   record: false — apply + count but keep it off the undo stack (the
  //     condition-cascade deletes: their confirm says "can't be undone", and
  //     undoing the shapes without the condition would resurrect orphans);
  //   reset: true — clear BOTH stacks (hydrate / revision restore / rescale:
  //     a restored timeline starts fresh, and a rescale invalidates every
  //     `computed` the recorded commands froze).
  const undoStackRef = useRef([]);   // [{ cmd, inverse }]
  const redoStackRef = useRef([]);
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const scalesRef = useRef(scales);
  scalesRef.current = scales;
  const scaleSourcesRef = useRef(scaleSources);
  scaleSourcesRef.current = scaleSources;
  function dispatchShape(cmd, { record = true, reset = false, baseShapes = null } = {}) {
    // Stamp floating-Edit draw appearance onto newly committed shapes only.
    let applied = cmd;
    if (cmd?.type === "add" && Array.isArray(cmd.shapes) && drawAppearanceRef.current) {
      const da = drawAppearanceRef.current;
      const app = {};
      for (const k of ["color", "fill", "hatch", "line_style", "weight"]) {
        if (da[k] != null) app[k] = da[k];
      }
      if (Object.keys(app).length) {
        applied = {
          ...cmd,
          shapes: cmd.shapes.map((s) => ({ ...s, ...app, appearance_override: true })),
        };
      }
    }
    const res = applyShapeCommand(baseShapes || shapesRef.current, applied);
    shapesRef.current = res.shapes;
    setShapes(res.shapes);
    if (res.counted) countDeleted(res.counted);
    if (reset) { undoStackRef.current = []; redoStackRef.current = []; }
    else if (record && res.inverse) {
      const st = recordCommand(undoStackRef.current, { cmd: applied, inverse: res.inverse });
      undoStackRef.current = st.undo;
      redoStackRef.current = st.redo;   // a new command discards the redone future
    }
    if (applied.type === "add" && applied.shapes?.length) {
      const hideExtra = {};
      const lockExtra = {};
      for (const s of applied.shapes) {
        if (!s?.id) continue;
        const sheetFlag = s.sheet_id ? sheetNodeId(s.sheet_id) : null;
        if (hiddenShapeIds[s.id] || (sheetFlag && hiddenShapeIds[sheetFlag])) hideExtra[s.id] = true;
        if (lockedShapeIds[s.id] || (sheetFlag && lockedShapeIds[sheetFlag])) lockExtra[s.id] = true;
      }
      if (Object.keys(hideExtra).length) setHiddenShapeIds((h) => ({ ...h, ...hideExtra }));
      if (Object.keys(lockExtra).length) setLockedShapeIds((h) => ({ ...h, ...lockExtra }));
      suggestFinishForNewShapes(applied.shapes, res.shapes);
      if (drawAppearanceRef.current) setDrawAppearance(null);
    }
    return res;
  }

  async function suggestFinishForNewShapes(added, allShapes) {
    const msgs = [];
    for (const s of added) {
      const isFloor = s.measure_role === "floor_area";
      const isWall = s.measure_role === "wall_area";
      if (!isFloor && !isWall) continue;

      const cond = conditions.find((c) => c.id === s.condition_id);
      const finishTag = (cond?.finish_tag || "").trim();
      const room = detectRoomName(s, boqDetectCtx, allShapes);
      const pq = primaryQty(shapeQuantities(s), units);

      const scheduleRefs = gatherShapeScheduleRefs(s, cond, boqDetectCtx, room);
      const primaryRef = scheduleRefs[0];
      let description = primaryRef?.description || cond?.description || "";
      let notes = primaryRef
        ? `${primaryRef.source}: ${primaryRef.tag}${primaryRef.description ? ` — ${primaryRef.description}` : ""}`
        : "";
      let matchedRoom = room;

      if (room) {
        try {
          const result = await finishForRoom(room);
          if (!result.abstained && result.finish_codes?.length) {
            matchedRoom = result.matched_room || room;
            const pick = isWall
              ? (result.finish_codes.find((f) => /wall|paint|plaster|tile|finish|coating|wallpaper/i.test(f.category || "")) || result.finish_codes[0])
              : (result.finish_codes.find((f) => /floor|carpet|tile|vinyl|lvt|finish/i.test(f.category || "")) || result.finish_codes[0]);
            if (pick.material || pick.description) description = pick.material || pick.description;
            notes = `Finish schedule: ${pick.code}${pick.material ? ` — ${pick.material}` : ""}`;
          }
        } catch {
          /* RAG backend optional — ignore when offline */
        }
      }

      const priced = priceMaskRow({
        qty: pq.qty,
        unit: pq.unit,
        finish_tag: finishTag,
        description,
        waste_pct: cond?.waste_pct,
      }, materialRates, units, projectSettings);

      const key = rowKey(s.id);
      setBoqLines((prev) => {
        const i = prev.findIndex((l) => l.id === key);
        const patch = {
          id: key,
          shape_id: s.id,
          manual: false,
          sheet_id: s.sheet_id,
          condition_id: s.condition_id,
          room: matchedRoom || "",
          description,
          notes,
          unit: pq.unit,
        };
        if (priced.material_rate_id && !(i >= 0 && prev[i]?.rate)) {
          patch.rate = priced.rate;
          patch.material_rate_id = priced.material_rate_id;
        }
        if (i >= 0) {
          const next = prev.slice();
          next[i] = { ...next[i], ...patch };
          return next;
        }
        return [...prev, { ...patch, qty_override: "", rate: patch.rate ?? "" }];
      });

      const label = isWall ? "Wall" : "Room";
      if (matchedRoom) msgs.push(`${label}: ${matchedRoom}`);
      if (priced.priced_from) msgs.push(`Rate: ${priced.priced_from}`);
      else if (finishTag || description) msgs.push(`No rate for ${finishTag || description} — set in Rates or BOQ`);
    }
    if (msgs.length) setCommitMsg(msgs.join(" · "));
  }
  // ⌘Z / ⇧⌘Z — apply the recorded inverse (undo) or the exact-restore command
  // (redo). Undoing swaps the entry's cmd for the inverse-of-the-undo before
  // it lands on the redo stack: that command restores the undone state
  // VERBATIM (same ids, same created_at, same stamped updated_at, same array
  // indices) — replaying the ORIGINAL command would re-mint/re-stamp. Neither
  // direction feeds the deletion counters: undo's inverses are structurally
  // count-free (an add's inverse delete rides noCount, a delete's inverse is
  // a restore-add), so a delete is tallied exactly once, at first dispatch —
  // undo never decrements, redo never re-counts.
  function undoShapeCommand() {
    const entry = undoStackRef.current[undoStackRef.current.length - 1];
    if (!entry) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    const res = applyShapeCommand(shapesRef.current, entry.inverse);
    shapesRef.current = res.shapes;
    setShapes(res.shapes);
    redoStackRef.current = [...redoStackRef.current, { cmd: res.inverse, inverse: entry.inverse }];
    setSelVert(null);   // vertex counts may have changed — a stale index must not aim the next ⌫
  }
  function redoShapeCommand() {
    const entry = redoStackRef.current[redoStackRef.current.length - 1];
    if (!entry) return;
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    const res = applyShapeCommand(shapesRef.current, entry.cmd);
    shapesRef.current = res.shapes;
    setShapes(res.shapes);
    undoStackRef.current = [...undoStackRef.current, { cmd: entry.cmd, inverse: res.inverse }];
    setSelVert(null);   // same stale-index guard as undo
  }
  // selecting a shape clears any markup selection and vice-versa — one live
  // selection at a time (bidirectional mutual exclusivity). Passing null clears both.
  // It also dismisses any pinned/hovering plan-symbol card (e.g. a curtain-wall
  // finish-code popup) and any pinned mask BOQ card so neither lingers or blocks
  // hover on other masks after the selection changes (or is cleared).
  const selectShape = (id, picksOverride) => {
    setSelectedId(id); setSelectedMarkupId(null); setSelHole(null); setSelVert(null); setWallSegmentFocus(null);
    setSymbolFocus(null); setSymbolHover(null);
    setShapeBoqFocus(null); shapeBoqPinPosRef.current = null;
    if (!id) {
      setShapeBoqHover(null);
      shapeBoqHoverStickyRef.current = false;
    } else {
      setShapeBoqHover((h) => (h?.id === id ? h : null));
      shapeBoqHoverStickyRef.current = false;
    }
    setLayerPickIds(picksForPrimarySelect(id, picksOverride !== undefined ? picksOverride : layerPickIds));
    setShapeCtxMenu(null);
    if (!id) setSelectedCutoutIds(new Set());
  };
  const selectMarkup = (id) => { setSelectedMarkupId(id); setSelectedId(null); setLayerPickIds({}); };
  const pendingFlyRef = useRef(null);   // fly-to target whose sheet is opening this tick (two-phase center once its bitmap loads)

  const [snapOn, setSnapOn] = useState(false);   // snap-to-vector (beta) — off until calibrated on real plans
  const [angleOn, setAngleOn] = useState(true);  // 45°/90° angle guides (polar tracking) — on by default; ⇧ = hard lock
  // One-Click fill sensitivity (0..1) — how eagerly a fill crosses a room's hatch;
  // per-user pref, defaults to the calibrated Balanced preset.
  const [fillSens, setFillSens] = useState(() => {
    try { const v = parseFloat(localStorage.getItem("opentakeoff_fill_sens")); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : SENS_BALANCED; } catch { return SENS_BALANCED; }
  });
  useEffect(() => { try { localStorage.setItem("opentakeoff_fill_sens", String(fillSens)); } catch { /* private mode */ } }, [fillSens]);
  const [wallSens, setWallSens] = useState(() => {
    try { const v = parseFloat(localStorage.getItem("opentakeoff_wall_sens")); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : SENS_BALANCED; } catch { return SENS_BALANCED; }
  });
  useEffect(() => { try { localStorage.setItem("opentakeoff_wall_sens", String(wallSens)); } catch { /* private mode */ } }, [wallSens]);
  const [wallProposal, setWallProposal] = useState(null); // { key, regions: [{ seed, outer, holes, ...qty }] }
  const [saveState, setSaveState] = useState("idle");
  const [loadError, setLoadError] = useState("");   // annotations load failed — autosave stays disarmed
  // internal state is { text }, minted FRESH on every setCommitMsg call — a
  // byte-identical message (e.g. two "Couldn't open X" in a row) still gets a
  // new object identity, so the effect below (keyed on this object) restarts
  // its clock instead of no-op'ing on an unchanged dep. setCommitMsg(text) is
  // a thin, stable-shaped wrapper so the ~48 call sites below stay untouched.
  const [commitMsgState, setCommitMsgState] = useState({ text: "" });
  const commitMsg = commitMsgState.text;   // misnamed for history; just the message bar
  const setCommitMsg = (text) => setCommitMsgState({ text });
  // transient means transient: every message dismisses itself after ~6s (a
  // repeat message restarts the clock — see above). Three things don't age
  // out on a timer: the stale-tab lockout (STALE_TAB_MESSAGE — sticky until
  // the user reloads; it's the only story this tab has left to tell), any
  // other failure message (isDangerMsg — "Couldn't…"/"Commit failed…" — stays
  // until the NEXT message replaces it, not a clock), and in-progress messages
  // (the file's own "…" convention — "Reading files…", "Building the marked
  // set…", ingestFiles' onProgress strings — which must not vanish mid-op;
  // grep setCommitMsg to see every message and confirm the convention holds).
  useEffect(() => {
    const text = commitMsgState.text;
    if (!text || isDangerMsg(text) || text.endsWith("…")) return;
    const t = setTimeout(() => setCommitMsg(""), 6000);
    return () => clearTimeout(t);
  }, [commitMsgState]);
  const [showReport, setShowReport] = useState(false);  // Reports overlay (STACK-style breakdown + export)
  const [showBoq, setShowBoq] = useState(false);       // BOQ sidebar — floor masked data (right, opposite Files)
  const [showSummary, setShowSummary] = useState(false); // Summary table — hierarchical floor -> type -> code -> qty
  // AI Detection — ONLY A1105–A1109 floor plans. Keep mask DATA intact;
  // those sheets show no masks until the nav button runs, then reveal one-by-one.
  // All other PDFs keep normal always-visible masks + hover (untouched).
  const AI_DETECT_FLOOR_PLAN_FILES = useMemo(() => new Set([
    "a1105-1st floor plan.pdf",
    "a1106-2nd floor plan.pdf",
    "a1107-3rd floor plan.pdf",
    "a1108-4th floor plan.pdf",
    "a1109-5th & 6th floor plan.pdf",
  ]), []);
  const isAiDetectFloorPlan = useCallback((sheetKey) => {
    const file = parseSheetKey(String(sheetKey || "")).file.replace(/^.*[/\\]/, "").toLowerCase();
    return AI_DETECT_FLOOR_PLAN_FILES.has(file);
  }, [AI_DETECT_FLOOR_PLAN_FILES]);
  // Per-sheet reveal counts persist when switching files among A1105–A1109.
  // Clicking AI Detection always restarts the sequential reveal on the viewed sheet.
  const [aiDetectShownBySheet, setAiDetectShownBySheet] = useState({});
  const [, setAiDetectAnimatingKey] = useState(null);
  const aiDetectTimerRef = useRef(null);
  const stopAiDetectReveal = useCallback(() => {
    if (aiDetectTimerRef.current != null) {
      clearInterval(aiDetectTimerRef.current);
      aiDetectTimerRef.current = null;
    }
  }, []);
  useEffect(() => () => stopAiDetectReveal(), [stopAiDetectReveal]);
  // Platform "All projects" → same destination as the former Home control.
  useEffect(() => {
    const onMsg = (e) => {
      const d = e?.data;
      if (!d || d.source !== "adicc-platform" || d.type !== "adicc:home") return;
      goSupabaseHome();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  // Tell the ADICC TopNav a project/sheet canvas is open so "All projects" shows.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get("db") || params.get("project") || "";
    try {
      window.parent?.postMessage({
        source: "opentakeoff",
        type: "adicc:canvas-ready-state",
        ready: false,
      }, "*");
      window.parent?.postMessage({
        source: "opentakeoff",
        type: "adicc:sheets-view",
        active: true,
        projectId,
      }, "*");
    } catch { /* cross-origin embed */ }
    return () => {
      try {
        window.parent?.postMessage({
          source: "opentakeoff",
          type: "adicc:canvas-ready-state",
          ready: false,
        }, "*");
        window.parent?.postMessage({ source: "opentakeoff", type: "adicc:sheets-view", active: false }, "*");
      } catch { /* cross-origin embed */ }
    };
  }, []);
  const [showDrawingsChat, setShowDrawingsChat] = useState(false);
  const [drawingsChatPill, setDrawingsChatPill] = useState(false);   // centered drawings search
  const [drawingsChatDraft, setDrawingsChatDraft] = useState("");
  const [drawingsChatSeed, setDrawingsChatSeed] = useState("");      // question handed to side panel
  const drawingsChatInputRef = useRef(null);
  const closeDrawingsChatPill = useCallback(() => {
    setDrawingsChatPill(false);
    setDrawingsChatDraft("");
  }, []);
  const submitDrawingsAsk = useCallback((raw) => {
    const q = (raw || "").trim();
    if (!q) return;
    setDrawingsChatSeed(q);
    setDrawingsChatDraft("");
    setDrawingsChatPill(false);
    setShowDrawingsChat(true);
  }, []);
  const toggleDrawingsAsk = useCallback(() => {
    if (showDrawingsChat) {
      setShowDrawingsChat(false);
      setDrawingsChatSeed("");
      return;
    }
    setDrawingsChatPill((open) => !open);
    setDrawingsChatDraft("");
  }, [showDrawingsChat]);
  // Dismiss on Escape, or on any click outside the composer — including the
  // left-rail tools, sheets, hamburger, toolbar. The chat trigger is excluded
  // so it can toggle. Draft is discarded (same as Escape): another icon is an
  // explicit leave, not an accidental canvas tap.
  useEffect(() => {
    if (!drawingsChatPill) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closeDrawingsChatPill(); };
    const onPointerDown = (e) => {
      if (e.button != null && e.button !== 0) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest(".drawings-ask-wrap")) return;
      if (t.closest(".drawings-chat-glass-trigger")) return;
      closeDrawingsChatPill();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [drawingsChatPill, closeDrawingsChatPill]);
  const [showRates, setShowRates] = useState(false);
  const [showEstimate, setShowEstimate] = useState(false);
  const [showFinishesSchedule, setShowFinishesSchedule] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteRef = useRef(null);
  useEffect(() => {
    const onMsg = (e) => {
      const d = e?.data;
      if (!d || d.source !== "adicc-platform" || d.type !== "adicc:canvas-subnav") return;
      const action = d.action;
      if (LP_TAB_ORDER.includes(action)) {
        const closesCurrentMenu = leftTabRef.current === action && leftPanelPresentationRef.current === "menu";
        setLeftPanelPresentation(d.presentation === "menu" ? "menu" : "dock");
        if (Number.isFinite(d.anchorLeft)) {
          const anchorLeft = Math.max(0, d.anchorLeft);
          // The slot is always mounted. Write the incoming anchor before React
          // opens it so the first painted menu frame is already under its
          // navbar trigger instead of flashing at the previous/default x.
          hostMenuRef.current?.style.setProperty("--host-menu-left", `${anchorLeft}px`);
          setHostPanelAnchorLeft(anchorLeft);
        }
        setIllLayersOpen(false);
        setLeftTab(closesCurrentMenu ? null : action);
      } else if (action === "close-panel") {
        setLeftTab(null);
      } else if (action === "request-panel-state") {
        try {
          window.parent?.postMessage({
            source: "opentakeoff",
            type: "adicc:canvas-panel-state",
            panel: leftTabRef.current,
          }, "*");
        } catch { /* cross-origin embed */ }
      } else if (action === "tools") {
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const postToolbarState = useCallback(() => {
    const current = toolbarChromeRef.current;
    try {
      window.parent?.postMessage({
        source: "opentakeoff",
        type: "adicc:toolbar-state",
        tools: {
          measure: { visible: current.measureVisible },
          workspace: { visible: current.workspaceVisible },
          takeoffs: { visible: current.takeoffsVisible },
        },
      }, "*");
    } catch { /* cross-origin embed */ }
  }, []);
  useEffect(() => {
    postToolbarState();
  }, [
    postToolbarState,
    toolbarChrome.measureVisible,
    toolbarChrome.workspaceVisible,
    takeoffsOpen,
  ]);
  useLayoutEffect(() => {
    const bar = workspaceBarRef.current;
    const shell = bar?.closest(".app-shell");
    if (!bar || !shell) return undefined;
    const apply = () => {
      shell.style.setProperty("--workspace-chrome-h", `${bar.offsetHeight}px`);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => {
      ro.disconnect();
      shell.style.removeProperty("--workspace-chrome-h");
    };
  }, [status, toolbarChrome.workspaceVisible, view]);
  useEffect(() => {
    const onToolbarControl = (e) => {
      const d = e?.data;
      if (!d || d.source !== "adicc-platform" || d.type !== "adicc:toolbar-control") return;
      if (d.action === "request-state") {
        postToolbarState();
        return;
      }
      if (!["measure", "workspace", "takeoffs"].includes(d.tool)) return;
      const current = toolbarChromeRef.current;
      if (d.action === "toggle-visible") {
        const visible = d.tool === "measure"
          ? current.measureVisible
          : d.tool === "workspace"
            ? current.workspaceVisible
            : current.takeoffsVisible;
        const nextVisible = !visible;
        setToolbarVisible(d.tool, nextVisible);
      }
    };
    window.addEventListener("message", onToolbarControl);
    return () => window.removeEventListener("message", onToolbarControl);
  }, [postToolbarState, setToolbarVisible]);
  const postViewState = useCallback(() => {
    const current = viewStateRef.current;
    try {
      window.parent?.postMessage({
        source: "opentakeoff",
        type: "adicc:view-state",
        views: {
          estimate: current.estimate,
          readout: current.readout,
          minimap: current.minimap,
          rulers: current.rulers,
          grid: current.grid,
          scaleBar: current.scaleBar,
        },
      }, "*");
    } catch { /* cross-origin embed */ }
  }, []);
  useEffect(() => {
    postViewState();
  }, [postViewState, minimapOpen, viewPrefs]);
  useEffect(() => {
    const onViewControl = (e) => {
      const d = e?.data;
      if (!d || d.source !== "adicc-platform") return;
      if (d.type === "adicc:view-control") {
        if (d.action === "request-state") {
          postViewState();
          return;
        }
        const applyViewEnabled = (view, enabled) => {
          if (typeof enabled !== "boolean") return false;
          if (view === "minimap") {
            setMinimapOpen(enabled);
            return true;
          }
          if (["estimate", "readout", "rulers", "grid", "scaleBar"].includes(view)) {
            setViewPrefs((current) => ({ ...current, [view]: enabled }));
            return true;
          }
          return false;
        };
        if (d.action === "set") {
          applyViewEnabled(d.view, d.enabled);
          return;
        }
        if (d.action !== "toggle") return;
        if (d.view === "minimap") {
          setMinimapOpen((visible) => !visible);
          return;
        }
        if (!["estimate", "readout", "rulers", "grid", "scaleBar"].includes(d.view)) return;
        setViewPrefs((current) => ({ ...current, [d.view]: !current[d.view] }));
        return;
      }
      if (d.type === "adicc:canvas-expand-control") {
        setCanvasExpanded(!!d.active);
      }
    };
    window.addEventListener("message", onViewControl);
    return () => window.removeEventListener("message", onViewControl);
  }, [postViewState]);
  useEffect(() => {
    const onViewShortcut = (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return;
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (!digit) return;
      const n = Number(digit);
      e.preventDefault();
      e.stopPropagation();
      if (n <= 3) {
        const tool = n === 1 ? "measure" : n === 2 ? "workspace" : "takeoffs";
        const current = toolbarChromeRef.current;
        const visible = tool === "measure"
          ? current.measureVisible
          : tool === "workspace"
            ? current.workspaceVisible
            : current.takeoffsVisible;
        setToolbarVisible(tool, !visible);
        return;
      }
      if (n === 6) {
        setMinimapOpen((visible) => !visible);
        return;
      }
      const view = n === 4 ? "estimate"
        : n === 5 ? "readout"
        : n === 7 ? "rulers"
        : n === 8 ? "grid"
        : "scaleBar";
      setViewPrefs((current) => ({ ...current, [view]: !current[view] }));
    };
    window.addEventListener("keydown", onViewShortcut);
    return () => window.removeEventListener("keydown", onViewShortcut);
  }, [setToolbarVisible]);
  const [showCondEdit, setShowCondEdit] = useState(false);
  // Floating Condition Edit: appearance for the in-progress draw only (not all CPT-1).
  const [drawAppearance, setDrawAppearance] = useState(null);
  const drawAppearanceRef = useRef(null);
  drawAppearanceRef.current = drawAppearance;
  const [materialRates, setMaterialRates] = useState([]);
  const [projectCurrency] = useState("AED");
  const [markupPct] = useState(0);
  const [overheadPct] = useState(0);
  const [boqFocusShapeId, setBoqFocusShapeId] = useState(null); // filtered BOQ view — one mask
  const [shapeBoqHover, setShapeBoqHover] = useState(null);     // { id, cx, cy } canvas-local hover card
  const [shapeBoqFocus, setShapeBoqFocus] = useState(null);     // pinned shape id — static BOQ card
  const shapeBoqPinPosRef = useRef(null);               // pinned card screen position — survives hover-off
  const shapeBoqHoverStickyRef = useRef(false);       // pointer inside hover card — keep visible
  const pendingFlyShapeRef = useRef(null);             // fly-to shape whose sheet is opening
  const [boqLines, setBoqLines] = useState([]);        // manual BOQ detail rows; persisted in boq_lines
  const [showRevisions, setShowRevisions] = useState(false); // Revisions overlay (save / compare any two, buy-list deltas, CSV, auto-banked restore)
  const [overlapPrompt, setOverlapPrompt] = useState(null); // draw-over-fill dialog: merge vs remove overlap
  const [importRows, setImportRows] = useState(null);        // Import-from-schedule approval rows (null = dialog closed)
  const [scheduleAnchor, setScheduleAnchor] = useState(null); // first marquee corner for the "schedule" tool — ISOLATED from poly so it can never leak into a measure shape
  const [projectName, setProjectName] = useState("");   // optional label for the report header
  const [clientInfo, setClientInfo] = useState({});      // per-project client/job fields for branded output; additive payload field
  const fileInputRef = useRef(null);                    // hidden <input type=file> for "Open PDF"
  const folderInputRef = useRef(null);                  // hidden folder picker — whole project tree upload
  const lpTabsScrollRef = useRef(null);                 // Files panel tab strip — overflow + drag-scroll
  const lpTabsDragRef = useRef(null);                   // { x, sl, moved }
  const lpTabsSkipClickRef = useRef(false);

  const containerRef = useRef(null);
  const stageRef = useRef(null);
  const panelCanvasRefs = useRef(new Map()); // sheetKey → <canvas>
  const panelPaintRef = useRef(new Map());   // sheetKey → { canvas, w, h, inverted } — keep painted tabs across group changes
  const prevHiResJoinRef = useRef("");
  const prevGroupSigRef = useRef("");
  const pageObjsRef = useRef(new Map());     // sheetKey → pdf.js page object (kept for on-demand detail-view re-render)
  const renderScalesRef = useRef(new Map()); // sheetKey → base raster pdf scale (detail view renders at a multiple of it)
  const detailCanvasRef = useRef(null);      // single high-res viewport detail canvas (positioned imperatively)
  const detailTaskRef = useRef(null);        // in-flight detail render task (cancel stale on re-zoom)
  const detailBackRef = useRef(null);        // offscreen back buffer — the visible crop is never wiped mid-render
  const detailKeyRef = useRef("");           // last requested crop — identical re-requests are dropped (sync churn fires the effect several times per settle)
  const detailWatchdogRef = useRef(0);       // recovers a render stuck by a backgrounded/throttled tab (see DETAIL_STALL_MS)
  const renderTasksRef = useRef(new Map());  // sheetKey → pdf.js RenderTask
  const pdfDocsRef = useRef(new Map());      // file name → pdf.js loading task (doc cache)
  const renderSeqRef = useRef(0);            // monotonic token — stale render chains bail out
  // Offscreen copies of finished panel bitmaps so Split / Eye / Close / row
  // focus can keep already-painted sheets on screen instead of wiping the group.
  const stashPanelPaint = (key, canvas) => {
    if (!key || !canvas?.width) return;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    try { copy.getContext("2d").drawImage(canvas, 0, 0); } catch { return; }
    panelPaintRef.current.set(key, {
      canvas: copy, w: canvas.width, h: canvas.height, inverted: !!darkModeRef.current,
    });
  };
  const blitPanelPaint = (key, el) => {
    const cached = panelPaintRef.current.get(key);
    if (!el || !cached?.canvas) return false;
    if (el.width === cached.w && el.height === cached.h && canvasInvertedRef.current.has(el)) return true;
    el.width = cached.w;
    el.height = cached.h;
    try { el.getContext("2d").drawImage(cached.canvas, 0, 0); } catch { return false; }
    canvasInvertedRef.current.set(el, cached.inverted);
    return true;
  };
  const sheetPainted = (key) => {
    if (panelPaintRef.current.get(key)?.w) return true;
    const cv = panelCanvasRefs.current.get(key);
    return !!(cv && cv.width && canvasInvertedRef.current.has(cv));
  };
  const dropSheetPaint = (key) => {
    if (!key) return;
    const cv = panelCanvasRefs.current.get(key);
    if (cv) canvasInvertedRef.current.delete(cv);
    panelPaintRef.current.delete(key);
  };
  const scanBusyRef = useRef(false);         // a paid schedule OCR read is in flight — blocks re-fire from a rapid re-draw
  const panRef = useRef(null);
  const spaceRef = useRef(false);
  const crossVRef = useRef(null);
  const crossHRef = useRef(null);
  const rubberRef = useRef(null);
  const rectRef = useRef(null);
  const cloudRef = useRef(null);       // live cloud preview (first corner → cursor)
  const highlightRef = useRef(null);   // live highlight-box preview (first corner → cursor; own translucent fill, NOT rectRef's condition fill)
  const hlRef = useRef(null);          // in-progress highlighter stroke {pts (stage px), key}
  const hlPathRef = useRef(null);      // live highlighter preview path (imperative, WYSIWYG ink)
  const [hlStyle, setHlStyle] = useState(() => {
    try { return { color: HL_INKS[0], size: 14, tip: "chisel", ...JSON.parse(localStorage.getItem("opentakeoff_hl_style") || "{}") }; }
    catch { return { color: HL_INKS[0], size: 14, tip: "chisel" }; }
  });
  const [showHlPopover, setShowHlPopover] = useState(false);
  useEffect(() => {
    if (tool === "highlighter") setShowHlPopover(true);
    else setShowHlPopover(false);
  }, [tool]);
  useEffect(() => { try { localStorage.setItem("opentakeoff_hl_style", JSON.stringify(hlStyle)); } catch { /* private mode */ } }, [hlStyle]);
  const snapRef = useRef(null);        // current snapped image point (or null)
  const snapGridsRef = useRef(new Map()); // sheetKey → {cell, map} spatial hash of vector endpoints
  const vectorSegsRef = useRef(new Map()); // sheetKey → flat [x1,y1,x2,y2,…] linework segments (One-Click boundary source)
  const segMetaRef = useRef(new Map());    // sheetKey → per-segment meta bytes (hatch classification input)
  const maskCacheRef = useRef(new Map());  // sheetKey → built boundary mask (lazy, dropped on re-render)
  const wallMaskCacheRef = useRef(new Map()); // sheetKey:sens → wall-weight mask
  const sheetStatsRef = useRef(new Map()); // sheetKey → {segCount, imageFrac} — raster-fallback trigger signals
  const rasterMaskCacheRef = useRef(new Map()); // sheetKey → Promise<MaskObj|null> — scan-pixel mask (lazy, shared across clicks)
  const snapMarkRef = useRef(null);    // SVG snap indicator
  const angleRef = useRef(null);       // current angle-locked image point (or null) — the click commits it
  const aimMarkRef = useRef(null);     // four floating liquid-glass pickets thickening the crosshair crossing
  const aimChipRef = useRef(null);     // readout chip by the cursor (locked angle · live segment length)
  const dragRef = useRef(null);        // {kind:'move'|'vertex'|'edge'|'markupMove', shapeId?/markupId?, vIndex?, start:[x,y], orig:verts_norm/markup coords, moved?, prev: grab-time geomSnapshot (shape drags), shape: grab-time shape, lastVerts/lastComputed: latest preview frame — the release commit's geom command payload}
  const ocDragRef = useRef(null);      // One-Click proposal edit drag: {kind:'oc-vertex'|'oc-edge', ri, vi?/i?/j?, oa?, ob?, sx?, sy?} — poly is panel-LOCAL px
  const ocHoverRef = useRef(-1);       // mirror of ocHover (region index under cursor) — compared per-move to avoid stale-closure churn
  const editingRef = useRef(false);    // true while the inline text editor is open — read in moveCrosshair/onPointerDown/wheel (a REF, never per-mousemove state) to suppress the crosshair and freeze pan/zoom
  const editorRef = useRef(null);      // mirror of the open editor object, so finishEditor can commit without a stale-closure race
  const editorInputRef = useRef(null); // the live <input> element (uncontrolled — value read on commit)
  const lastPtrRef = useRef(null);     // last pointer CLIENT coords — paste targets the sheet under the cursor; ALSO the voice-deixis aim (getAimSeed) — the one pointer tracker
  const aimSeqRef = useRef(0);         // bumps with every lastPtrRef write — the deixis freshness clock (no second tracker, just a tick on the existing one)
  const voiceAimMarkRef = useRef(0);   // aim is LIVE for deixis only while aimSeq > this; re-marked at utterance begin (Command box focus / every run) and on canvas-leave + tab-hide, so a parked-off-canvas or refocus ghost seed can never place a trace
  const pendingClickRef = useRef(null); // deferred draw click {p,cx,cy} — drag >5px converts to a pan
  const hoverRef = useRef(null);        // hover tooltip div (DOM-direct like the crosshair)
  const hoverIdRef = useRef("");        // shape id currently described by the tooltip
  const lastMeasureRef = useRef("area"); // last armed measure tool — shown on the Measure menu face
  const lastCutRef = useRef("deduct");
  const lastMarkupRef = useRef("highlighter");
  const prevToolRef = useRef("pan");   // previous armed tool — detects a LEAVE-zone transition so the shared `poly` array only clears when zone itself was left, not on every tool change
  const menuDepthRef = useRef(0);      // >0 while a toolbar menu is open (letter shortcuts pause)
  // ONE stable open/close listener for every toolbar menu — ToolMenu re-fires
  // its onOpenChange effect when the callback identity changes, so an inline
  // arrow here would re-count an open menu on every canvas render
  const onMenuDepth = useCallback((o) => { menuDepthRef.current = Math.max(0, menuDepthRef.current + (o ? 1 : -1)); }, []);
  useEffect(() => {
    if (!paletteOpen) return;
    onMenuDepth(true);
    const placePanel = () => {
      if (paletteRef.current) {
        const r = paletteRef.current.getBoundingClientRect();
        paletteRef.current.style.setProperty("--palette-panel-top", `${r.bottom + 38}px`);
        const shell = paletteRef.current.querySelector(".takeoff-sticky-panel-shell");
        const pill = paletteRef.current.closest(".toolbar-glass-pill");
        if (shell && pill) {
          const pr = pill.getBoundingClientRect();
          shell.style.left = `${window.innerWidth / 2 - pr.left}px`;
        }
      }
    };
    placePanel();
    window.addEventListener("resize", placePanel);
    const onDown = (e) => { if (paletteRef.current && !paletteRef.current.contains(e.target)) setPaletteOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setPaletteOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      onMenuDepth(false);
      window.removeEventListener("resize", placePanel);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [paletteOpen, onMenuDepth]);
  const thumbCacheRef = useRef(new Map()); // sheetKey → thumbnail dataURL — survives gallery close
  const legacyPinnedRef = useRef(null);    // old `pinned` page numbers awaiting their one-shot tab migration
  const tabInitRef = useRef(false);        // snap to the first restored tab exactly once
  const statusRef = useRef("loading");     // mirror for the gallery's thumbnail worker
  const viewRef = useRef("canvas");        // mirror for the keyboard handlers
  // live mirrors of tool/proposal — oneClickAt is an async function whose
  // closure over `tool`/`proposal` goes stale across an `await` (the user can
  // switch tools or start a proposal on another panel while a raster render is
  // in flight); the post-await guards below read these refs, never the
  // closed-over state, so a slow raster resolve can't act on a world that has
  // since moved on.
  const toolRef = useRef(tool);
  const proposalRef = useRef(proposal);
  const hydrated = useRef(false);
  // Autosave stays holstered until a user-originated edit. hydrate() flips every
  // autosave dep to a fresh identity, so the effect fires once on the post-load
  // render with no edit behind it; that lone run arms this and returns instead of
  // writing — otherwise merely opening a shared ?project= link would CREATE
  // annotations.json in the folder (see #68). Error paths that skip hydrate
  // leave BOTH hydrated and this disarmed: the in-memory state is empty there,
  // so arming would let the first edit overwrite the intact saved takeoff with
  // nothing (the loadError banner explains). A revision Restore reuses hydrate() too, but
  // mid-session it runs with this already armed, so a restore saves — unchanged
  // by this fix. (Restoring on a canvas whose mount load FAILED stays disarmed
  // and is not persisted — the #73 gap, which persists on the LEGACY cloud path.
  // On the opted-in local-first path #73 is RETIRED: loadAnnotations returns local
  // and never throws, so the mount always hydrates + arms, and a restore's setStates
  // re-fire this effect with saves armed → the restored payload persists + pushes.)
  const savesArmed = useRef(false);
  // One-shot suppression for a background reconcile (Slice 5). A remote adopt (mount
  // seed / 4c conflict resolution) re-hydrates via onRemoteUpdate mid-session, when
  // saves are already armed — that hydrate would otherwise re-fire the autosave
  // effect and push the just-adopted content back at synced_rev+1 (rev churn on a
  // seed; a spurious conflict + loser-snapshot on an adopt). Set true right before
  // the reconcile hydrate; the autosave effect swallows exactly the next run.
  // INVARIANT (load-bearing): hydrate() must dirty ≥1 autosave dep so this flag is
  // consumed on the very next commit and can't leak into a later REAL edit (it always
  // does — setConditions/setShapes/setClientInfo mint fresh values unconditionally).
  // And hydrate must not spawn a SECOND autosave-triggering commit that outlives the
  // flag — normalizeLoadedGroups keeps the lastGroup-sync effect a no-op for exactly
  // that reason. A future "skip setState if unchanged" optimization on either would
  // reopen an escape; keep both guarantees.
  const suppressNextSave = useRef(false);
  // Slice 5b defer-gate scratch: `busyStateRef` mirrors the state half of the busy
  // predicate every render so computeBusy can read it via a ref (always fresh, stable
  // to capture); `remotePendingRender` marks a reconcile whose RENDER we deferred
  // because the canvas went busy after the store adopted (Case 2), drained on idle.
  const busyStateRef = useRef({});
  const remotePendingRender = useRef(false);
  // Bumped whenever a busy INTERACTION ref clears (drag/editor/scan end) — those don't
  // trigger a render, so the idle-drain (below) can't observe the busy→idle edge from
  // its state deps alone. idleTick is a drain dep so a ref-only idle transition still
  // drains a deferred render (and un-blocks autosave, which stays suppressed while a
  // render is deferred). Without it, suppression could wedge saves indefinitely.
  const [idleTick, setIdleTick] = useState(0);
  // Only meaningful on the opted-in path (the idle-drain no-ops without a bridge), so
  // gate on syncBridge — this keeps the flag-off / anonymous path free of the extra
  // interaction-end re-renders, preserving byte-for-byte legacy behavior (invariant #4).
  const bumpIdle = () => { if (store.syncBridge) setIdleTick((t) => t + 1); };
  const tfRef = useRef({ x: 0, y: 0, scale: 1 });
  const syncRaf = useRef(0);
  const lastSyncRef = useRef(0);       // last tf mirror sync (perf.now) — scheduleSync throttles against it
  const lastSyncedScaleRef = useRef(1); // scale last written into `tf` — scheduleSync skips a translate-only pan tick when this is unchanged
  const gestureUntilRef = useRef(0);   // wheel/pinch activity horizon — the detail view waits it out
  const panRafRef = useRef(0);         // rAF token coalescing drag-pan pointermoves into one transform write per frame
  const saveDataRef = useRef(null);    // latest serialized annotations — flushed on unmount
  const saveStateRef = useRef("idle"); // mirror of saveState for the unmount/beforeunload guard

  // page 1 keeps the bare file name (pre-paging takeoffs still load); pages 2+ → "name#page"
  const sheetKey = page > 1 ? `${active}#${page}` : active;
  // Single-sheet mode: scale chip/calibrate always target the file on screen.
  useEffect(() => {
    if (sheetGroup.length || !sheetKey) return;
    setFocusKey((fk) => (fk === sheetKey ? fk : sheetKey));
  }, [sheetKey, sheetGroup.length]);
  // toggle a sheet in/out of the side-by-side group; first toggle from single
  // mode seeds the group with the sheet currently on screen
  const toggleInGroup = (key) => {
    if (!key) return;
    if (sheetGroup.includes(key)) {
      const f = sheetGroup.filter((k) => k !== key);
      if (f.length >= 2) { setSheetGroup(f); return; }
      const land = f[0];
      setSheetGroup([]);
      if (land) {
        const t = parseSheetKey(land);
        if (t.file !== active) setActive(t.file);
        setPage(t.page);
        setFocusKey(land);
      }
      return;
    }
    if (sheetGroup.length >= MAX_GROUP) {
      setCommitMsg(`Side-by-side holds up to ${MAX_GROUP} sheets — close one first.`);
      return;
    }
    const base = sheetGroup.length ? sheetGroup : (key === sheetKey ? [] : (sheetKey ? [sheetKey] : []));
    if (base.includes(key)) return;
    const nextGroup = [...base, key];
    // A pair needs two different sheets — splitting the only/active sheet with
    // itself would leave an invalid one-sheet group and a confusing "pair" UI.
    if (nextGroup.length < 2) {
      setCommitMsg("Open another sheet to place it side-by-side.");
      return;
    }
    setSheetGroup(nextGroup);
    setFocusKey(key);
  };
  // Ungroup lands you on the sheet you were last working (the focused panel),
  // not whatever sheet the pager held before you grouped — shapes/markups all
  // carry their own sheet_id, so nothing is lost either way.
  const ungroup = () => {
    const k = (focusKey && sheetGroup.includes(focusKey)) ? focusKey : (sheetGroup[0] || sheetKey);
    const t = parseSheetKey(k);
    setSheetGroup([]);
    if (t.file !== active) setActive(t.file);
    setPage(t.page);
  };
  // Regroup restores the last side-by-side composition — the common flow is
  // ungroup, set each sheet's scale one at a time, then want the combined
  // canvas back without re-picking every sheet in the gallery.
  const regroup = () => {
    if (lastGroup.length < 2) return;
    setOpenTabs((t) => { const m = [...t]; for (const k of lastGroup) if (!m.includes(k)) m.push(k); return m; });
    setSheetGroup(lastGroup);
    setFocusKey(lastGroup.includes(sheetKey) ? sheetKey : lastGroup[0]);
  };
  // Row click: if the sheet is already in the side-by-side group, focus that
  // panel (no ungroup, no re-raster). Otherwise switch to that tab alone.
  function goToSheet(key) {
    if (sheetGroup.includes(key)) {
      setFocusKey(key);
      const t = parseSheetKey(key);
      if (t.file !== active) setActive(t.file);
      setPage(t.page);
      const keys = sheetGroup.length ? sheetGroup : (sheetKey ? [sheetKey] : []);
      let xOff = 0, pw = 0, ph = 0;
      for (const k of keys) {
        const dims = panelImgs[k] || { w: 0, h: 0 };
        if (k === key) { pw = dims.w; ph = dims.h; break; }
        if (dims.w) xOff += dims.w + PANEL_GAP;
      }
      const el = containerRef.current;
      if (pw && el) {
        const r = el.getBoundingClientRect();
        const sc = tfRef.current.scale;
        tfRef.current = {
          scale: sc,
          x: r.width / 2 - (xOff + pw / 2) * sc,
          y: r.height / 2 - (ph / 2) * sc,
        };
        if (stageRef.current) {
          stageRef.current.style.transform = `translate(${tfRef.current.x}px, ${tfRef.current.y}px) scale(${sc})`;
        }
      }
      return;
    }
    const t = parseSheetKey(key);
    if (t.file !== active) setActive(t.file);
    setPage(t.page);
    setFocusKey(key);
    setSheetGroup([]);
  }
  // gallery open: every key becomes a tab; side-by-side also groups (2–4)
  function openSheets(keys, sideBySide) {
    if (!keys.length) return;
    setOpenTabs((t) => { const merged = [...t]; for (const k of keys) if (!merged.includes(k)) merged.push(k); return merged; });
    if (sideBySide && keys.length >= 2) { setSheetGroup(keys.slice(0, MAX_GROUP)); setFocusKey(keys[0]); }
    else goToSheet(keys[0]);
    setView("canvas");
  }
  function revealSheetInFilesSidebar(sheetKey) {
    if (!sheetKey) return;
    const folder = fileFolders[parseSheetKey(sheetKey).file];
    if (folder) {
      const segs = folder.split("/").filter(Boolean);
      setOpenFolderPaths((prev) => {
        const next = { ...prev };
        for (let i = 1; i <= segs.length; i++) next[segs.slice(0, i).join("/")] = true;
        return next;
      });
    }
    if (!panelKeySet.has(sheetKey)) {
      openSheets([sheetKey], false);
      return;
    }
    setOpenTabs((t) => (t.includes(sheetKey) ? t : [...t, sheetKey]));
    setFocusKey(sheetKey);
    const t = parseSheetKey(sheetKey);
    if (sheetGroup.length) {
      if (!sheetGroup.includes(sheetKey)) goToSheet(sheetKey);
    } else if (t.file !== active || t.page !== page) {
      goToSheet(sheetKey);
    }
    setView("canvas");
  }
  function openCitationInWorkspace(citation) {
    if (!citation) return;
    const names = sheets.map((s) => s.name);
    const key = sheetKeyForCitation(citation, names, galleryLabels);
    if (!key) {
      const hint = (citation.doc_path || "").split(/[/\\]/).pop() || citation.sheet_id || "source";
      setCommitMsg(`"${hint}" isn't in this project — add the PDF from Files (Volume 4 drawings), then tap the citation again.`);
      return;
    }
    revealSheetInFilesSidebar(key);
    const page = citation.page_no != null && citation.page_no >= 0 ? citation.page_no + 1 : 1;
    setCommitMsg(`Opened ${tabLabel(key)}${page > 1 ? ` (page ${page})` : ""} in workspace.`);
  }
  function closeTab(key) {
    const i = openTabs.indexOf(key);
    const next = openTabs.filter((k) => k !== key);
    setOpenTabs(next);
    dropSheetPaint(key);
    const remainGroup = sheetGroup.filter((k) => k !== key);
    const wasGrouped = remainGroup.length !== sheetGroup.length;
    if (wasGrouped) setSheetGroup(remainGroup.length >= 2 ? remainGroup : []);
    if (!next.length) {
      setActive("");
      setPage(1);
      setSheetGroup([]);
      setPanelImgs({});
      panelPaintRef.current.clear();
      setStatus("ready");
      setView("canvas");
      return;
    }
    if (wasGrouped && remainGroup.length === 1) {
      const land = remainGroup[0];
      const t = parseSheetKey(land);
      if (t.file !== active) setActive(t.file);
      setPage(t.page);
      setFocusKey(land);
      return;
    }
    if (wasGrouped && remainGroup.length >= 2) {
      if (key === sheetKey || key === focusKey) {
        const land = remainGroup[0];
        setFocusKey(land);
        const t = parseSheetKey(land);
        if (t.file !== active) setActive(t.file);
        setPage(t.page);
      }
      return;
    }
    if (key === sheetKey) { const nb = next[Math.min(Math.max(i, 0), next.length - 1)]; if (nb) goToSheet(nb); }
  }
  const tabLabel = (k) => {
    const lvl = sheetLevels[k] ? `${sheetLevels[k]} · ` : "";   // assigned floor/level rides every tab label
    if (galleryLabels[k]) return lvl + galleryLabels[k];
    const t = parseSheetKey(k);
    if (t.file === active && pageLabels[t.page]) return lvl + pageLabels[t.page];
    // Foldered sheets carry their relative path as an id — label the sheet, not the path.
    const base = t.file.split("/").pop().replace(/\.pdf$/i, "");
    return lvl + (t.page > 1 ? `${base} · ${t.page}` : base);
  };

  // ── panels: the ONE rendering model — single-sheet mode is a group of one ──
  // Every coordinate on screen lives in "stage space": panel i's image px plus
  // its xOffset. With one panel xOffset is 0, so stage space IS image space and
  // all the original single-sheet math is unchanged.
  const groupKeys = useMemo(
    () => (openTabs.length === 0 ? [] : (sheetGroup.length ? sheetGroup : (sheetKey ? [sheetKey] : []))),
    [openTabs.length, sheetGroup, sheetKey],
  );
  const groupSig = JSON.stringify(groupKeys);
  let _px = 0;
  const panels = groupKeys.map((key) => {
    const dims = panelImgs[key] || { w: 0, h: 0 };
    const p = { key, ...parseSheetKey(key), img: dims, xOffset: _px };
    if (dims.w) _px += dims.w + PANEL_GAP;
    return p;
  });
  // Pure panel-row math (stage extent, nearest-panel routing, the px→feet
  // scale factors) lives in lib/panelGeometry.js; these thin wrappers bind the
  // live panels/scales so every call site below reads unchanged.
  const stage = panelGeom.stageExtent(panels);
  const panelByKey = (k) => panelGeom.panelByKey(panels, k);
  const panelAt = (sx) => panelGeom.panelAt(panels, sx);
  const panelKeySet = new Set(groupKeys);
  // memoized: feeds the per-condition totals map the memoized TakeoffsPanel
  // takes as a prop — identity must hold across canvas-only renders. Builds
  // its own key set from sheetGroup/sheetKey (what groupKeys/panelKeySet above
  // are themselves derived from) rather than depending on groupSig or the
  // panelKeySet instance above — both are new on every render, so depending on
  // either honestly would recompute every render regardless; these are the
  // real, referentially-stable inputs.
  const visibleShapes = useMemo(() => {
    const keys = sheetGroup.length ? sheetGroup : [sheetKey];
    return shapes.filter((s) => keys.some((k) => k === s.sheet_id || aiFloorSheetKeysMatch(s.sheet_id, k)));
  }, [shapes, sheetGroup, sheetKey]);
  // AI Detection targets the sheet the user is viewing; reveal counts are kept
  // per file so switching among A1105–A1109 keeps already-revealed masks visible.
  const aiDetectViewKey = (sheetGroup.length
    ? ((focusKey && sheetGroup.includes(focusKey)) ? focusKey : (sheetGroup[0] || sheetKey))
    : sheetKey);
  const aiDetectShapeRevealed = useCallback((shape) => {
    if (!shape || !isAiDetectFloorPlan(shape.sheet_id)) return true;
    // Manual cutouts stay visible on top of the parent until the user applies them.
    if (shape.measure_role === "deduct") return true;
    const list = shapes.filter((s) => aiFloorSheetKeysMatch(s.sheet_id, shape.sheet_id) && s.measure_role !== "deduct");
    const idx = list.findIndex((s) => s.id === shape.id);
    const shown = aiDetectShownBySheet[shape.sheet_id]
      ?? Object.entries(aiDetectShownBySheet).find(([k]) => aiFloorSheetKeysMatch(shape.sheet_id, k))?.[1]
      ?? 0;
    return idx >= 0 && idx < shown;
  }, [shapes, aiDetectShownBySheet, isAiDetectFloorPlan]);
  const aiDetectSheetRevealCount = useCallback((shapeSheetId) => (
    aiDetectShownBySheet[shapeSheetId]
      ?? Object.entries(aiDetectShownBySheet).find(([k]) => aiFloorSheetKeysMatch(shapeSheetId, k))?.[1]
      ?? 0
  ), [aiDetectShownBySheet]);
  // BOQ + Estimate follow Auto-Takeoff reveal — totals grow mask-by-mask in real time.
  const boqShapes = useMemo(
    () => shapes.filter((s) => {
      if (!isAiDetectFloorPlan(s.sheet_id)) return true;
      if (s.measure_role === "deduct") return aiDetectSheetRevealCount(s.sheet_id) > 0;
      return aiDetectShapeRevealed(s);
    }),
    [shapes, aiDetectShapeRevealed, isAiDetectFloorPlan, aiDetectSheetRevealCount],
  );
  const visibleRevealedShapes = useMemo(
    () => visibleShapes.filter((s) => aiDetectShapeRevealed(s)),
    [visibleShapes, aiDetectShapeRevealed],
  );
  const drawableShapes = useMemo(
    () => visibleRevealedShapes.filter((s) => !isHiddenId(s.id, { hiddenShapeIds, sheetId: s.sheet_id })),
    [visibleRevealedShapes, hiddenShapeIds],
  );
  const layerPanelShapes = useMemo(
    () => shapes.filter((s) => {
      if (!groupKeys.some((k) => k === s.sheet_id || aiFloorSheetKeysMatch(s.sheet_id, k))) return false;
      if (!isAiDetectFloorPlan(s.sheet_id)) return true;
      if (s.measure_role === "deduct") return aiDetectSheetRevealCount(s.sheet_id) > 0;
      return aiDetectShapeRevealed(s);
    }),
    [shapes, groupKeys, aiDetectShapeRevealed, isAiDetectFloorPlan, aiDetectSheetRevealCount],
  );
  const selectedLayerIds = useMemo(() => {
    const picks = Object.keys(activeLayerPickIds(selectedId, layerPickIds));
    if (picks.length) return picks;
    return selectedId ? [selectedId] : [];
  }, [layerPickIds, selectedId]);
  useEffect(() => {
    const ids = new Set(shapes.map((s) => s.id));
    setLayerPickIds((p) => {
      const next = {};
      for (const [id, on] of Object.entries(p)) if (on && ids.has(id)) next[id] = true;
      return Object.keys(next).length === Object.keys(p).length ? p : next;
    });
  }, [shapes]);
  const runAiDetection = useCallback(() => {
    stopAiDetectReveal();
    setShapeBoqFocus(null);
    setShapeBoqHover(null);
    shapeBoqPinPosRef.current = null;
    shapeBoqHoverStickyRef.current = false;
    if (!aiDetectViewKey || !isAiDetectFloorPlan(aiDetectViewKey)) return;
    const key = aiDetectViewKey;
    // Floor masks only — cutouts stay visible separately and must not pad the reveal count.
    const list = shapes.filter((s) => aiFloorSheetKeysMatch(s.sheet_id, key) && s.measure_role !== "deduct");
    const total = list.length;
    // Click again always restarts reveal on this file from the first mask.
    setAiDetectShownBySheet((prev) => ({ ...prev, [key]: 0 }));
    setAiDetectAnimatingKey(key);
    if (total <= 0) {
      setAiDetectAnimatingKey(null);
      return;
    }
    let n = 0;
    aiDetectTimerRef.current = setInterval(() => {
      n += 1;
      setAiDetectShownBySheet((prev) => ({ ...prev, [key]: n }));
      if (n >= total) {
        stopAiDetectReveal();
        setAiDetectAnimatingKey(null);
      }
    }, 120);
  }, [aiDetectViewKey, shapes, isAiDetectFloorPlan, stopAiDetectReveal]);
  // Stop in-flight animation when switching files — keep each sheet's reveal count.
  useEffect(() => {
    stopAiDetectReveal();
    setAiDetectAnimatingKey(null);
  }, [aiDetectViewKey, stopAiDetectReveal]);
  const visibleMarkups = useMemo(() => {
    const keys = new Set(sheetGroup.length ? sheetGroup : [sheetKey]);
    return markups.filter((m) => keys.has(m.sheet_id));
  }, [markups, sheetGroup, sheetKey]);
  // scale is PER PAGE (plan sets are never one uniform scale) — set it once per
  // sheet and it's remembered. In group mode the scale dropdown and hints target
  // the FOCUSED panel (the one last clicked); single mode focuses the lone panel.
  const focusPanel = (focusKey && groupKeys.includes(focusKey) && panelByKey(focusKey)) || panels[0] || { key: "", file: "", page: 1, img: { w: 0, h: 0 }, xOffset: 0 };
  const unitsPerPx = scales[focusPanel.key] ?? null;
  const labelFor = (p) => (p.file === active && pageLabels[p.page]) || (p.page > 1 ? `Sheet ${p.page}` : p.file);
  // Scale semantics (why geometry divides by factorFor and calibration
  // multiplies back to baseline) are documented on the pure functions in
  // lib/panelGeometry.js; these wrappers bind the live scales/renderScalesRef.
  const hiResOn = (key) => hiResKeys.includes(key);
  const factorFor = (key) => panelGeom.factorFor(renderScalesRef.current, key);
  const uppFor = (key) => panelGeom.uppFor(scales, renderScalesRef.current, key);
  // keep the agent's capability closures reading LIVE state across their awaits
  useEffect(() => {
    agentStateRef.current = { panels, scales, scaleSources, detectedScales, conditions, status };
  });
  const toggleHiRes = () => {
    const k = focusPanel.key;
    setHiResKeys((arr) => {
      const next = arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k];
      try { localStorage.setItem("opentakeoff_hires", JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  };

  // Minimap viewport box — DOM overlay, not painted into the thumbnail. Called
  // from applyTf so a pan (main canvas or minimap drag) moves the box without
  // a React render or a bitmap redraw.
  const paintMinimapView = useCallback(() => {
    const el = minimapViewRef.current;
    const cont = containerRef.current;
    const layout = minimapLayoutRef.current;
    const s = layout.s || minimapScaleRef.current;
    if (!el || !cont || !(s > 0)) return;
    const t = tfRef.current;
    const r = cont.getBoundingClientRect();
    const sc = t.scale || 1;
    const ox = layout.ox || 0;
    const oy = layout.oy || 0;
    el.style.width = `${Math.max(2, (r.width / sc) * s)}px`;
    el.style.height = `${Math.max(2, (r.height / sc) * s)}px`;
    el.style.transform = `translate(${ox + (-t.x / sc) * s}px, ${oy + (-t.y / sc) * s}px)`;
  }, []);

  const rulerMetrics = useMemo(() => {
    if (!unitsPerPx || !focusPanel.key) return { majorPx: 100, label: "100 px divisions" };
    const uppBitmap = unitsPerPx / panelGeom.factorFor(renderScalesRef.current, focusPanel.key);
    const zoom = tf.scale || 1;
    if (!(uppBitmap > 0) || !(zoom > 0)) return { majorPx: 100, label: "100 px divisions" };
    const candidates = units === "metric"
      ? [0.5, 1, 2, 5, 10, 20, 50].map((value) => ({ value, feet: value / M_PER_FT }))
      : [1, 2, 5, 10, 20, 50, 100].map((value) => ({ value, feet: value }));
    const chosen = candidates.find((candidate) => (candidate.feet / uppBitmap) * zoom >= 84)
      || candidates[candidates.length - 1];
    return {
      majorPx: Math.max(24, (chosen.feet / uppBitmap) * zoom),
      label: units === "metric" ? `${chosen.value} m divisions` : `${chosen.value} ft divisions`,
    };
  }, [focusPanel.key, tf.scale, units, unitsPerPx]);

  const paintRulers = useCallback(() => {
    if (!viewPrefs.rulers || !rulerMetrics) return;
    const { x, y } = tfRef.current;
    const major = rulerMetrics.majorPx;
    const mod = (value) => ((value % major) + major) % major;
    for (const [el, offset] of [[rulerXRef.current, mod(x)], [rulerYRef.current, mod(y)]]) {
      if (!el) continue;
      el.style.setProperty("--ruler-major", `${major}px`);
      el.style.setProperty("--ruler-minor", `${major / 10}px`);
      el.style.setProperty("--ruler-offset", `${offset}px`);
    }
  }, [rulerMetrics, viewPrefs.rulers]);

  // ── transform: tfRef is source of truth; write straight to the DOM ─────────
  const applyTf = useCallback(() => {
    const { x, y, scale } = tfRef.current;
    if (stageRef.current) stageRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    paintMinimapView();
    paintRulers();
  }, [paintMinimapView, paintRulers]);
  // Re-apply after every React render so an unrelated re-render mid-drag can't
  // snap the transform back to a stale value.
  useLayoutEffect(() => { applyTf(); });
  // Leading+trailing ~90ms throttle, not per-frame and not trailing-only: the React
  // mirror feeds screen-relative sizes (handle radii, stroke widths, label text, the
  // low-zoom tint switch), so it must track a CONTINUOUS gesture — the old trailing
  // debounce left labels scaling with the stage and shapes flashing sub-pixel until
  // 80ms after the gesture ended. ~11Hz keeps the overlay honest for a trivial render
  // cost; the DOM transform still updates per-event/per-frame.
  const scheduleSync = useCallback(() => {
    if (syncRaf.current) return;                       // a queued tick reads the freshest tfRef
    const wait = Math.max(0, SYNC_MS - (performance.now() - lastSyncRef.current));
    syncRaf.current = setTimeout(() => {
      syncRaf.current = 0; lastSyncRef.current = performance.now();
      const t = tfRef.current;
      // Nothing in the render tree reads tf.x/tf.y — position lives entirely in
      // the CSS transform above. A pure pan (scale unchanged) only needs this
      // mirror when the detail view is engaged (it re-crops from tf on every
      // tick); below DETAIL_ENGAGE it's hidden and reads nothing. Skipping the
      // state write there avoids re-rendering the whole shape/markup overlay
      // (thousands of SVG els at overview zoom) on every ~90ms pan tick — that
      // wasted reconciliation was the zoomed-out pan flicker + toolbar lag.
      if (t.scale === lastSyncedScaleRef.current && t.scale * (window.devicePixelRatio || 1) <= DETAIL_ENGAGE) return;
      lastSyncedScaleRef.current = t.scale;
      setTf({ ...t });
    }, wait);
  }, []);
  const setTfNow = useCallback((next) => { tfRef.current = next; applyTf(); setTf({ ...next }); }, [applyTf]);

  // Minimap thumbnail: fixed stage box, sheet letterboxed inside. Viewport box
  // is a DOM overlay from applyTf — do not list `tf` here or every pan redraws.
  const MINIMAP_FIXED_H = 148;
  const MINIMAP_BEZEL_X = 12;
  useEffect(() => {
    if (!minimapOpen) {
      minimapScaleRef.current = 0;
      minimapLayoutRef.current = { boxW: 0, boxH: 0, ox: 0, oy: 0, s: 0 };
      return;
    }
    const cv = minimapCanvasRef.current;
    if (!cv) return;
    const barW = zoomBarRef.current?.offsetWidth || 276;
    const boxW = Math.max(120, barW - MINIMAP_BEZEL_X);
    const boxH = MINIMAP_FIXED_H;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.style.width = `${boxW}px`;
    cv.style.height = `${boxH}px`;
    cv.width = Math.round(boxW * dpr);
    cv.height = Math.round(boxH * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boxW, boxH);
    ctx.fillStyle = darkMode ? "#0f151f" : "#ffffff";
    ctx.fillRect(0, 0, boxW, boxH);

    if (!stage.w || !stage.h) {
      minimapScaleRef.current = 0;
      minimapLayoutRef.current = { boxW, boxH, ox: 0, oy: 0, s: 0 };
      return;
    }

    const s = Math.min(boxW / stage.w, boxH / stage.h);
    const dispW = Math.max(1, Math.round(stage.w * s));
    const dispH = Math.max(1, Math.round(stage.h * s));
    const ox = Math.floor((boxW - dispW) / 2);
    const oy = Math.floor((boxH - dispH) / 2);
    minimapScaleRef.current = s;
    minimapLayoutRef.current = { boxW, boxH, ox, oy, s };

    for (const p of panels) {
      const src = panelCanvasRefs.current.get(p.key);
      if (!src || !src.width || !src.height) continue;
      try { ctx.drawImage(src, ox + p.xOffset * s, oy, p.img.w * s, p.img.h * s); } catch { /* bitmap not ready */ }
    }
    paintMinimapView();
  }, [minimapOpen, stage.w, stage.h, panels, darkMode, status, minimapPaintEpoch, paintMinimapView]);

  const stagePointFromMinimap = (clientX, clientY) => {
    const cv = minimapCanvasRef.current;
    const layout = minimapLayoutRef.current;
    const s = layout.s || minimapScaleRef.current;
    if (!cv || !(s > 0)) return null;
    const rect = cv.getBoundingClientRect();
    return {
      x: (clientX - rect.left - (layout.ox || 0)) / s,
      y: (clientY - rect.top - (layout.oy || 0)) / s,
    };
  };
  const centerViewOnMinimap = (e) => {
    const cont = containerRef.current;
    const pt = stagePointFromMinimap(e.clientX, e.clientY);
    if (!cont || !pt) return;
    const r = cont.getBoundingClientRect();
    const t = tfRef.current;
    tfRef.current = { scale: t.scale, x: r.width / 2 - pt.x * t.scale, y: r.height / 2 - pt.y * t.scale };
    applyTf();
  };
  const onMinimapPointerDown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    minimapDragRef.current = true;
    centerViewOnMinimap(e);
  };
  const onMinimapPointerMove = (e) => {
    if (!minimapDragRef.current) return;
    centerViewOnMinimap(e);
  };
  const onMinimapPointerUp = (e) => {
    if (!minimapDragRef.current) return;
    minimapDragRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    scheduleSync();
  };

  // ── local PDFs (dropped into this browser) ─────────────────────────────────
  const refreshSheets = useCallback(async () => {
    const list = await store.listSheets();
    setSheets(list);
    return list;
  }, []);
  // Stable props for the Drive picker so its folder-load effect doesn't re-fire
  // (and re-hit Drive) on every canvas re-render. `store` is a module binding
  // read at call time, so [] deps are correct.
  const pickerListFolder = useCallback((id) => store.listFolder(id), []);
  const pickerAddSheets = useCallback((items) => store.addSheets(items), []);
  // Reconcile the canvas after a PDF leaves the working set. For a non-empty
  // result the [sheets] effect already prunes openTabs/sheetGroup, but it can't:
  //   • fix `active` when the CLOSED pdf was the one on screen (it never resets
  //     itself), so move to a surviving sheet; and
  //   • prune anything when the set is now EMPTY — that effect early-returns on
  //     `!sheets.length` (it must, to protect restored tabs during load), so the
  //     last-pdf close would otherwise strand a tab pointing at a deleted file.
  const reconcileAfterRemoval = useCallback((name, list) => {
    if (!list.length) {
      setOpenTabs([]); setSheetGroup([]); setLastGroup([]); setActive(""); setPage(1);
      setPanelImgs({});
      setStatus("ready");
      setView("canvas");
      return;
    }
    if (name === active) { setActive(list[0].name); setPage(1); setSheetGroup([]); }
  }, [active]);
  // Close a PDF: drop it from the working set (cloud: manifest only, file stays
  // in Drive; local: deletes the stored bytes), refresh, then reconcile the view.
  // Shapes on the closed sheets persist in annotations and restore on re-add.
  const closePdf = useCallback(async (name) => {
    await store.removePdf(name);
    setFileFolders((m) => {
      if (!(name in m)) return m;
      const next = { ...m }; delete next[name]; return next;
    });
    reconcileAfterRemoval(name, await refreshSheets());
  }, [refreshSheets, reconcileAfterRemoval]);
  // UI-only gate in front of closePdf — does not change closePdf behavior.
  const requestClosePdf = useCallback((name) => { setPendingPdfClose(name); }, []);
  const confirmClosePdf = useCallback(() => {
    const name = pendingPdfClose;
    setPendingPdfClose(null);
    if (name) closePdf(name);
  }, [pendingPdfClose, closePdf]);
  const cancelClosePdf = useCallback(() => { setPendingPdfClose(null); }, []);
  // Remove-from-project (cloud only): the DESTRUCTIVE variant — delete the Drive
  // file, then drop it from the working set.
  const removeFromProject = useCallback(async (name) => {
    if (typeof store.removeFromProject !== "function") return;
    await store.removeFromProject(name);
    setFileFolders((m) => {
      if (!(name in m)) return m;
      const next = { ...m }; delete next[name]; return next;
    });
    reconcileAfterRemoval(name, await refreshSheets());
  }, [refreshSheets, reconcileAfterRemoval]);
  // open dropped/picked files of any kind: PDFs, images, and .zip plan sets all
  // get turned into PDF sheets (in-browser) by ingestFiles, then stashed locally.
  // Folder picks (webkitRelativePath) keep their relative folders so the Files
  // sidebar can nest them under expandable directory rows.
  async function handleFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    const pathHints = [];
    for (const f of incoming) {
      const rel = (f.webkitRelativePath || "").replace(/\\/g, "/");
      if (!rel.includes("/")) continue;
      const parts = rel.split("/").filter(Boolean);
      if (parts.length < 2) continue;
      const base = parts[parts.length - 1];
      const folder = parts.slice(0, -1).join("/");
      const stem = base.replace(/\.[^.]+$/, "");
      pathHints.push({ folder, base: base.toLowerCase(), stem: stem.toLowerCase() });
    }
    setCommitMsg("Reading files…");
    let pdfs = [], skipped = [];
    try { ({ pdfs, skipped } = await ingestFiles(incoming, { onProgress: setCommitMsg })); }
    catch (e) { setCommitMsg(`Couldn't read those files: ${e.message || e}`); return; }
    if (!pdfs.length) {
      setCommitMsg(skipped.length
        ? `Nothing to open — ${skipped.length} file${skipped.length === 1 ? "" : "s"} skipped. ADICC reads PDF, DWG, images, and .zip plan sets.`
        : "No supported files found. Drop a PDF, DWG, an image, or a .zip plan set.");
      return;
    }
    const folderForPdf = (pdf) => {
      if (!pathHints.length) return "";
      const bn = pdf.name.toLowerCase();
      const stem = pdf.name.replace(/\.pdf$/i, "").replace(/ \(\d+\)$/i, "").toLowerCase();
      const hint = pathHints.find((h) => h.base === bn || h.stem === stem
        || h.base.replace(/\.[^.]+$/, "") === stem
        || h.base.replace(/\.dwg$/i, ".pdf") === bn);
      return hint?.folder || "";
    };
    const batchRemote = pdfs.length > 1 && typeof store.persistPlansBatch === "function";
    // The store returns the sheet id it stored under — folder-relative when a
    // folder upload put two same-named sheets in different directories.
    const sheetNameOf = new Map();
    for (const f of pdfs) {
      try {
        const res = await store.addPdf(f, { folderPath: folderForPdf(f), skipRemote: batchRemote });
        sheetNameOf.set(f, res?.name || f.name);
      } catch (e) { setCommitMsg(`Couldn't open ${f.name}: ${e.message || e}`); }
    }
    if (batchRemote) {
      try {
        await store.persistPlansBatch(pdfs, folderForPdf, setCommitMsg);
      } catch (e) {
        setCommitMsg(`Plans opened locally; database save incomplete: ${e.message || e}`);
      }
    }
    if (pathHints.length) {
      setFileFolders((prev) => {
        const next = { ...prev };
        for (const pdf of pdfs) {
          const folder = folderForPdf(pdf);
          if (folder) next[sheetNameOf.get(pdf) || pdf.name] = folder;
        }
        return next;
      });
      setOpenFolderPaths((prev) => {
        const next = { ...prev };
        for (const pdf of pdfs) {
          const folder = folderForPdf(pdf);
          if (!folder) continue;
          const segs = folder.split("/").filter(Boolean);
          for (let i = 1; i <= segs.length; i++) next[segs.slice(0, i).join("/")] = true;
        }
        return next;
      });
    }
    await refreshSheets();
    const names = pdfs.map((f) => sheetNameOf.get(f) || f.name);
    const tail = skipped.length ? ` · ${skipped.length} skipped` : "";
    if (names.length === 1) {
      setOpenTabs((t) => (t.includes(names[0]) ? t : [...t, names[0]]));
      goToSheet(names[0]);
      setView("canvas");
    } else {
      setView("canvas");
    }
    setCommitMsg(`Opened ${names.length} sheet${names.length === 1 ? "" : "s"}${tail}.`);
    const suggested = projectNameFromFiles(incoming);
    if (suggested && isDefaultProjectName(projectName)) setProjectName(suggested);
  }
  // Plans picked on the home screen before navigation — ingest once the canvas mounts.
  const pendingIngestRef = useRef(false);
  useEffect(() => {
    if (!supabaseMode || pendingIngestRef.current) return;
    const pending = consumePendingIngest();
    if (!pending?.files?.length) return;
    pendingIngestRef.current = true;
    if (pending.projectName) setProjectName(pending.projectName);
    handleFiles(pending.files);
  // handleFiles closes over store + state setters; run once on mount only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabaseMode]);
  // The empty-project landing view (the Drive picker for an empty cloud project,
  // else the gallery) depends on BOTH the sheet list and the annotations (open
  // tabs), which load in two racing mount effects. These flags let whichever
  // finishes LAST make the call exactly once — so the picker never flashes for a
  // project that actually has sheets, and no redundant Drive listing fires.
  const hasSheetsRef = useRef(false);
  const sheetsLoadedRef = useRef(false);
  const noTabsRef = useRef(false);
  useEffect(() => {
    let off = false;
    setStatus("loading");
    store.listSheets()
      .then((list) => {
        if (off) return;
        hasSheetsRef.current = list.length > 0;
        sheetsLoadedRef.current = true;
        setSheets(list);
        if (list.length) {
          if (noTabsRef.current) setStatus("ready");
        } else setStatus("empty");
        // decide the landing only once the annotations effect has also reported
        // no open tabs (see hydrate) — avoids a picker→gallery flash + wasted list
        if (noTabsRef.current) setView("canvas");
      })
      .catch((e) => !off && (setErr(String(e.message || e)), setStatus("error")));
    const onManifest = () => {
      if (off) return;
      store.listSheets().then((list) => {
        if (off) return;
        hasSheetsRef.current = list.length > 0;
        setSheets(list);
      }).catch(() => {});
    };
    window.addEventListener("adicc:plan-manifest-ready", onManifest);
    return () => { off = true; window.removeEventListener("adicc:plan-manifest-ready", onManifest); };
  }, [cloudMode]);
  // Keep hasSheetsRef current so a later re-hydration (a revision Restore after the
  // working set changed) reads the LIVE sheet count, not the mount-time value.
  // The mount sheets effect above also sets it synchronously for the initial
  // landing decision (before this post-render effect runs).
  useEffect(() => { hasSheetsRef.current = sheets.length > 0; }, [sheets]);

  // ── load saved annotations once per project ───────────────────────────────
  // hydrate applies a saved payload to state — shared by the mount load and by
  // Restore in the Revisions panel, so a restored revision walks the same
  // defensive path as a page reload.
  const hydrate = (a) => {
    // Same cross-load-transient gap as the panel epoch bump below: a revision
    // Restore runs in-place with the same sheet keys, so a surviving zoneCheck
    // would immediately re-classify the RESTORED shape set against the
    // pre-load polygon — "correct" math against the wrong region. Reset it
    // unconditionally, mirroring the sheet_group/sheet_levels else-clear rule.
    resetZone();
    // agent proposals are ephemeral review state aimed at the PRE-load
    // conditions/sheets — a loaded/restored timeline starts with none pending
    // (nothing is lost: rejected geometry records nothing by design).
    setAgentProposals([]);
    setProjectName(a.project_name || "");
    // string fields only — a corrupted record must not put an object where
    // the report masthead renders a React child
    setClientInfo(Object.fromEntries(Object.entries(
      a.client_info && typeof a.client_info === "object" && !Array.isArray(a.client_info) ? a.client_info : {}
    ).filter(([, v]) => typeof v === "string")));
    setConditionColumns(sanitizeConditionColumns(a.condition_columns));   // non-array/malformed → [] (unconditional set: snapshot load must not inherit pre-load columns)
    setShapeLabels(sanitizeShapeLabels(a.shape_labels));   // same unconditional-set rule: a snapshot load must not inherit the replaced project's label vocabulary
    setActiveLabel(null);   // active label is session-only — never carry one from the replaced project into a fresh/loaded one
    const conds = sanitizeConditionAttrs(a.conditions || []);   // strips corrupt attrs values so every reader can trust them (the client_info precedent)
    if (conds.length) { setConditions(conds); setActiveCond(conds[0].id); }
    else { const seeded = seedConditions(templatesRef.current); setConditions(seeded); setActiveCond(seeded[0].id); }   // library templates first, flooring defaults as fallback
    // palette holds condition ids — de-dupe (a hand-edited/older payload could
    // repeat one, which would collide React keys and double-map a hotkey), drop
    // any that don't resolve in the loaded set, and cap defensively; a seeded
    // fresh workspace starts with an empty palette
    setPalette(Array.isArray(a.palette) && conds.length ? [...new Set(a.palette)].filter((id) => conds.some((c) => c.id === id)).slice(0, PALETTE_MAX) : []);
    // panel transients reset with the conditions they described — a snapshot
    // Load must not keep a checked set / range anchor / filter / collapsed
    // groups aimed at the PRE-load list (bulk edits would misfire on ids that
    // happen to survive). That state lives in the TakeoffsPanel now: bump its
    // epoch and it clears them in place (panel tab + width survive, as they
    // always did). On the mount load this is a no-op (fresh panel state).
    setPanelEpoch((e) => e + 1);
    // `replace` command + reset: hydrate is a whole-array non-edit (no stamps,
    // no counters) and a loaded/restored timeline starts with EMPTY undo/redo
    // stacks — recorded inverses from the replaced project must never fire here.
    dispatchShape({ type: "replace", shapes: sanitizeShapeLabelsOnShapes(a.shapes || []) }, { reset: true });   // strip a corrupt shape.label at hydrate (identity-preserving); other shape fields untouched
    // normalize hydrated markups: legacy workspaces may hold markups with no id
    // (pre-dating the id field) — seed a stable id + default rfi_id so the new
    // select / edit / delete / move / RFI-link flows (all keyed on m.id) work on them.
    setMarkups(Array.isArray(a.markups) ? a.markups.map((m) => ({ ...m, id: m.id || uid("mk"), rfi_id: m.rfi_id || "" })) : []);
    setRfis(Array.isArray(a.rfis) ? a.rfis : []);   // additive — old saves without rfis load as []
    // additive provenance_counters — unconditional set (the else-clear rule: a
    // snapshot load must not inherit the replaced project's deletion tallies).
    // Object gate mirrors client_info; number filter keeps the counts trustable.
    const pcIn = a.provenance_counters?.shapes_deleted;
    setProvCounters({ shapes_deleted: Object.fromEntries(Object.entries(
      pcIn && typeof pcIn === "object" && !Array.isArray(pcIn) ? pcIn : {}
    ).filter(([, v]) => Number.isFinite(v) && v > 0)) });
    // additive `sheet_levels` key (multi-floor gallery grouping) — old payloads
    // lack it and must clear any pre-load levels (the sheet_group else-clear
    // rule: a snapshot load must not inherit the replaced project's levels).
    // String labels only, mirroring the client_info string-fields gate.
    // Extracted to sanitizeSheetLevels (lib/sheetLevels.js) so this gate has
    // its own unit tests independent of the reducer.
    setSheetLevels(sanitizeSheetLevels(a.sheet_levels));
    {
      const live = new Set((a.shapes || []).map((s) => s.id).filter(Boolean));
      setHiddenShapeIds(sanitizeLayerIdMap(a.layer_hidden, live));
      setLockedShapeIds(sanitizeLayerIdMap(a.layer_locked, live));
      setLayerForest(sanitizeForest(a.layer_tree, live));
      setLayerPickIds({});
    }
    // additive boq_lines — manual BOQ detail persisted with the takeoff
    setBoqLines(Array.isArray(a.boq_lines)
      ? a.boq_lines.filter((l) => l && typeof l === "object" && typeof l.id === "string")
      : []);
    // additive file_folders — sheet name → relative folder path from Folder upload
    {
      const raw = a.file_folders;
      const next = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          if (typeof k === "string" && typeof v === "string" && v.trim()) next[k] = v.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        }
      }
      setFileFolders(next);
      setOpenFolderPaths({}); // collapsed by default — user expands folders manually
    }
    // additive symbol_notes — manual fills for plan marks with no schedule data
    {
      const raw = a.symbol_notes;
      const next = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          if (typeof k !== "string" || !v || typeof v !== "object" || Array.isArray(v)) continue;
          const note = {};
          for (const f of ["room_name", "description", "manufacturer", "style", "color", "size", "remarks", "type"]) {
            if (typeof v[f] === "string" && v[f].trim()) note[f] = v[f].trim();
          }
          if (Object.keys(note).length) next[k] = note;
        }
      }
      setSymbolNotes(next);
    }
    // else-clear matters at runtime (snapshot load): a payload without groups/
    // tabs must not inherit the pre-load ones — autosave would persist a hybrid.
    // In group mode sheetGroup + lastGroup share ONE instance so the lastGroup-sync
    // effect below is a reference-equal no-op — otherwise its follow-up commit would
    // escape the one-shot save suppression and spuriously re-save (see normalizeLoadedGroups).
    const { sheetGroup: grp, lastGroup: lgFinal } = normalizeLoadedGroups(a, MAX_GROUP);
    setSheetGroup(grp);
    setLastGroup(lgFinal);
    // Canvas opens empty — no sheet on the plan until the user picks one.
    setOpenTabs([]);
    setActive("");
    setPage(1);
    setFocusKey("");
    noTabsRef.current = true;
    if (sheetsLoadedRef.current) {
      setView("canvas");
      setStatus(hasSheetsRef.current ? "ready" : "empty");
    }
    const sc = {};
    const src = {};
    for (const s of a.sheets || []) if (s.sheet_id && s.units_per_px) {
      sc[s.sheet_id] = s.units_per_px;
      // provenance is additive — old projects lack it (report shows "unknown").
      // Any non-empty string passes through, not just today's known values: a
      // whitelist would silently strip a future value on load and the next
      // autosave would persist the loss. Display already falls back safely.
      if (typeof s.scale_source === "string" && s.scale_source) src[s.sheet_id] = s.scale_source;
    }
    setScales(sc);
    setScaleSources(src);
    // display units ride the payload (additive) — a metric project opens metric
    // on any machine; payloads without the field keep this browser's toggle
    if (a.units === "metric" || a.units === "imperial") setUnits(a.units);
    // Floor-plan masks (A1105–A1109) start unrevealed every session; reveal is
    // driven only by Auto-Takeoff (not restored from saved payload).
    setAiDetectShownBySheet({});
  };
  useEffect(() => {
    let off = false;
    // templates load BEFORE annotations: hydrate's fresh-workspace seeding
    // reads templatesRef, so the library must be in hand first
    store.loadTemplates().catch(() => []).then((tpl) => {
      if (!off) { templatesRef.current = tpl; setTemplates(tpl); }
      return store.loadMaterialLibrary().catch(() => []);
    }).then((ml) => {
      if (!off) setMatLib(ml);
      return store.loadAnnotations();
    }).then((a) => {
      if (off) return;
      hydrate(a);
      hydrated.current = true;
    }).catch((e) => {
      // stale-tab failure: leave autosave DISARMED (hydrated stays false). If a
      // blocked tab recovered here with hydrated=true, its still-empty defaults
      // would autosave straight over the other tab's real data. The reload
      // message is the whole story for this tab.
      if (isStaleTabError(e)) { setCommitMsg(STALE_TAB_MESSAGE); return; }
      // Cloud project whose saved takeoff couldn't be read (Drive error / unreadable
      // annotations): same rule as a stale tab — leave autosave DISARMED so empty
      // defaults can't overwrite the real project in Drive. (cloudStore tags these.)
      if (e?.name === "CloudLoadError") { setCommitMsg(e.message || "Couldn't load this project from Drive — reload to retry."); return; }
      // Do NOT arm autosave on any other failed load either: the in-memory
      // state is empty, so the first edit would overwrite the intact saved
      // takeoff with nothing. Leave it disarmed (hydrated stays false) and say
      // so in a banner — a reload retries the read.
      setLoadError(String((e && e.message) || e || "unknown error"));
    });
    return () => { off = true; };
    // run-once mount load — hydrate is intentionally not a dep (re-running would
    // re-hydrate over live edits); the cloudMode/ref it now reads are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stamp library — independent of hydrate (it seeds no project state), so it
  // loads on its own. A truly empty library gets the flooring defaults, then
  // persists them once so the seeded set is exportable and survives reloads
  // (the seedConditions precedent, but written back because the library is the
  // asset itself, not a per-project derivation). Re-read on tab focus like the
  // other browser-global records.
  useEffect(() => {
    let off = false;
    store.loadStampLibrary().catch(() => ({ stamps: [], sets: [] })).then((raw) => {
      if (off) return;
      const seeded = seedStampLibrary(raw);
      const wasEmpty = !(raw?.stamps || []).length;
      stampLibRef.current = seeded; setStampLib(seeded);
      if (wasEmpty && seeded.stamps.length) store.saveStampLibrary(seeded).catch(() => { /* seed persists on next edit */ });
    });
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      store.loadStampLibrary().then((lib) => {
        if (JSON.stringify(lib) === JSON.stringify(stampLibRef.current)) return;
        // another tab edited the library — adopt it, INCLUDING an intentional
        // delete-all (an empty library must propagate, not leave stale stamps).
        // The store is shared per-origin, so a persisted empty is a real edit; the
        // first-mount seed self-heals any transient pre-save empty on next focus.
        stampLibRef.current = lib; setStampLib(lib);
        // a cross-tab edit may have removed the armed stamp — don't keep a dangling ref
        setArmedStamp((a) => (a && lib.stamps.some((s) => s.id === a.id) ? a : null));
      }).catch(() => { /* keep what we have */ });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { off = true; document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // library freshness: BOTH browser-global records — the condition template
  // library AND the material library (each sanitized at load, same as the
  // mount effect above) — may have been edited by another tab since our mount
  // load; re-read each on tab focus. Safe to swap in wholesale because every
  // library mutation persists immediately (nothing unsaved lives only in this
  // tab's state). Skip the setState when the freshly loaded list is
  // byte-identical to what we're already holding (a cheap JSON signature
  // compare) — TakeoffsPanel is memoized on these arrays' identity, and an
  // unconditional set would defeat that memo on every tab focus even when
  // nothing actually changed. This NARROWS the multi-tab last-write-wins
  // window on both records; it doesn't close it.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      store.loadTemplates().then((tpl) => {
        if (JSON.stringify(tpl) === JSON.stringify(templatesRef.current)) return;
        templatesRef.current = tpl; setTemplates(tpl);
      }).catch(() => { /* keep what we have */ });
      store.loadMaterialLibrary().then((ml) => {
        setMatLib((cur) => (JSON.stringify(ml) === JSON.stringify(cur) ? cur : ml));
      }).catch(() => { /* keep what we have */ });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // leaving the stamp tool disarms the pending stamp — a stray click under a
  // measure/select tool must never drop a stamp
  useEffect(() => { if (tool !== "stamp") setArmedStamp(null); }, [tool]);
  // One-Click + Wall Trace proposals persist across each other — estimate
  // workflows trace walls then rooms on the same sheet without losing previews.
  // Leaving both tools (or switching to a draw tool) clears pending work.
  const TRACE_PROPOSAL_TOOLS = useMemo(() => new Set(["oneclick", "walltrace"]), []);
  useEffect(() => {
    if (!TRACE_PROPOSAL_TOOLS.has(tool)) {
      setProposal(null);
      setWallProposal(null);
    }
  }, [tool, TRACE_PROPOSAL_TOOLS]);
  // Proposal gone (created, discarded, sheet changed) ⇒ drop any handle selection/hover.
  useEffect(() => { if (!proposal) { setOcSel(null); ocHoverRef.current = -1; setOcHover(-1); } }, [proposal]);
  // Switching to a different shape (or clearing the selection) drops the vertex pick.
  useEffect(() => { setSelVert(null); setSelHole(null); }, [selectedId]);

  // remember every live composition so Regroup works after ANY exit from group
  // mode (Ungroup button, tab click, gallery View) — not just the last Ungroup
  useEffect(() => { if (sheetGroup.length >= 2) setLastGroup(sheetGroup); }, [sheetGroup]);

  // a persisted group may reference a since-deleted file — drop those keys; a
  // group of one collapses back to single-sheet mode
  useEffect(() => {
    if (!sheets.length) return;
    const names = new Set(sheets.map((s) => s.name));
    const liveKeys = (g) => {
      const f = g.filter((k) => names.has(parseSheetKey(k).file));
      return f.length === g.length ? g : (f.length >= 2 ? f : []);
    };
    setSheetGroup(liveKeys);
    setLastGroup(liveKeys);
    // one-shot migration: legacy `pinned` page numbers were relative to the
    // load-time active file (sheets[0]) — they become tabs, then never resurrect
    if (legacyPinnedRef.current) {
      const file = sheets[0].name;
      const tabs = legacyPinnedRef.current.map((n) => (n > 1 ? `${file}#${n}` : file));
      legacyPinnedRef.current = null;
      setOpenTabs((t) => (t.length ? t : tabs));
    }
    setOpenTabs((t) => { const f = t.filter((k) => names.has(parseSheetKey(k).file)); return f.length === t.length ? t : f; });
  }, [sheets]);

  // land on the first restored tab (the sheet-list effect defaults to sheets[0])
  useEffect(() => {
    if (tabInitRef.current || !openTabs.length || !sheets.length) return;
    tabInitRef.current = true;
    const land = sheetGroup.length
      ? (sheetGroup.includes(openTabs[0]) ? openTabs[0] : sheetGroup[0])
      : openTabs[0];
    const t = parseSheetKey(land);
    if (t.file !== active) setActive(t.file);
    setPage(t.page);
    setFocusKey(land);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTabs, sheets]);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { proposalRef.current = proposal; }, [proposal]);
  // Tab hidden ⇒ the voice-deixis aim dies: on return the tracked position
  // predates the refocus (rAF suspended, the pointer may be anywhere), so
  // "this room" must wait for a fresh move — the stale-aim bar (RFC #59).
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "hidden") voiceAimMarkRef.current = aimSeqRef.current; };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // one pdf.js document per file, cached for the life of the project view —
  // the canvas render AND the gallery thumbnails share this cache
  // Bytes come from the local store (IndexedDB); pdf.js needs them up front, so
  // the cache holds a PROMISE of the loading task (not the task itself).
  const docFor = useCallback((file) => {
    let t = pdfDocsRef.current.get(file);
    if (!t) {
      t = store.loadPdfData(file).then((data) => {
        if (!data) throw new Error(`Missing PDF data for ${file}`);
        return pdfjsLib.getDocument({
          data,
          // Some construction PDFs contain unsupported TrueType hint
          // instructions. They are harmless to rendering, so keep pdf.js at
          // error-only verbosity instead of flooding the console.
          verbosity: pdfjsLib.VerbosityLevel.ERRORS,
        });
      });
      pdfDocsRef.current.set(file, t);
    }
    return t.then((task) => task.promise).catch((err) => {
      pdfDocsRef.current.delete(file);
      throw err;
    });
  }, []);

  // dark toggle: flip the pixels of every rendered canvas in place — instant,
  // no pdf.js re-render. Canvases without a map entry haven't rendered yet
  // (their chain applies the current mode when it finishes) — skip those, or
  // difference-fill would paint transparent backing stores white.
  useEffect(() => {
    darkModeRef.current = darkMode;
    const flip = (cv) => {
      if (cv && canvasInvertedRef.current.has(cv) && canvasInvertedRef.current.get(cv) !== darkMode) {
        invertCanvasPixels(cv);
        canvasInvertedRef.current.set(cv, darkMode);
      }
    };
    for (const [, cv] of panelCanvasRefs.current) flip(cv);
    flip(detailCanvasRef.current);
    for (const [, cached] of panelPaintRef.current) {
      if (cached.canvas && cached.inverted !== darkMode) {
        invertCanvasPixels(cached.canvas);
        cached.inverted = darkMode;
      }
    }
    setMinimapPaintEpoch((epoch) => epoch + 1);
  }, [darkMode]);

  // ── render the sheet group (a single sheet is a group of one) ──────────────
  // Two phases: (A) resolve every panel's dimensions — no raster — so the row
  // layout is final before any pixel paints, then (B) raster sequentially left
  // to right. A monotonic token is checked after EVERY await so a stale chain
  // can never paint, resize, or cancel a newer chain's work (the old code had
  // that race between document-load and render).
  //
  // Split / Eye / Close / in-group row focus must NOT blank the canvas: keys
  // that already have a finished bitmap are kept (no setStatus("rendering"),
  // no cache wipe). Only missing keys raster; the full overlay is for a group
  // with nothing painted yet (first open or a true jump to an uncached sheet).
  const renderSheetGroupInputsRef = useRef(null);
  renderSheetGroupInputsRef.current = {
    active,
    docFor,
    fitToView,
    focusKey,
    groupKeys,
    hiResKeys,
    openTabs,
    selectShape,
    sheetKey,
    sheets,
  };
  const hiResSig = hiResKeys.join(" ");
  useEffect(() => {
    const {
      active,
      docFor,
      fitToView,
      focusKey,
      groupKeys,
      hiResKeys,
      openTabs,
      selectShape,
      sheetKey,
      sheets,
    } = renderSheetGroupInputsRef.current;
    const renderSeq = renderSeqRef;
    const renderTasks = renderTasksRef;
    if (!openTabs.length) {
      if (statusRef.current === "loading" || statusRef.current === "rendering") {
        setStatus(sheets.length ? "ready" : "empty");
      }
      return;
    }
    // Tabs restored before `active` is set → groupKeys is empty and we used to
    // return while status stayed "loading" forever. Land on the first tab.
    if (!groupKeys.length) {
      const land = openTabs[0];
      if (land && !active) {
        const t = parseSheetKey(land);
        setActive(t.file);
        setPage(t.page);
      }
      return;
    }
    const hiJoin = hiResKeys.join(" ");
    const prevHi = prevHiResJoinRef.current;
    prevHiResJoinRef.current = hiJoin;
    const compositionChanged = prevGroupSigRef.current !== groupSig;
    prevGroupSigRef.current = groupSig;
    const prevHiSet = new Set(prevHi ? prevHi.split(" ") : []);
    const nextHiSet = new Set(hiResKeys);
    const hiDirty = new Set();
    if (prevHi !== hiJoin) {
      for (const k of groupKeys) {
        if (prevHiSet.has(k) !== nextHiSet.has(k)) hiDirty.add(k);
      }
    }
    for (const k of hiDirty) dropSheetPaint(k);

    const keep = groupKeys.filter((k) => sheetPainted(k) && !hiDirty.has(k));
    const missing = groupKeys.filter((k) => !keep.includes(k));

    const dimFor = (key) => {
      const c = panelPaintRef.current.get(key);
      if (c?.w) return { w: c.w, h: c.h };
      const cv = panelCanvasRefs.current.get(key);
      if (cv?.width) return { w: cv.width, h: cv.height };
      return null;
    };
    const rowExtent = (keys, extra = []) => {
      const byKey = new Map(extra.map((m) => [m.key, m]));
      let rw = 0, rh = 0;
      for (const k of keys) {
        const d = byKey.get(k) || dimFor(k);
        if (!d) continue;
        rw += (rw ? PANEL_GAP : 0) + d.w;
        rh = Math.max(rh, d.h);
      }
      return { rw, rh };
    };
    const liftOverlay = () => {
      if (statusRef.current === "loading" || statusRef.current === "rendering") setStatus("ready");
    };
    const applyKeepLayout = (fit) => {
      const imgs = {};
      for (const k of groupKeys) {
        const d = dimFor(k);
        if (d) imgs[k] = d;
      }
      setPanelImgs((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const k of groupKeys) {
          if (!imgs[k]) continue;
          if (prev[k]?.w !== imgs[k].w || prev[k]?.h !== imgs[k].h) { next[k] = imgs[k]; changed = true; }
        }
        return changed ? next : prev;
      });
      const { rw, rh } = rowExtent(groupKeys);
      requestAnimationFrame(() => {
        for (const k of keep) {
          const el = panelCanvasRefs.current.get(k);
          if (el) blitPanelPaint(k, el);
        }
        if (fit && rw && rh) fitToView(rw, rh);
      });
    };

    if (missing.length === 0) {
      applyKeepLayout(compositionChanged);
      liftOverlay();
      return;
    }

    const blank = keep.length === 0;
    const seq = ++renderSeqRef.current;
    const stale = () => seq !== renderSeqRef.current;
    const dropRuntime = (key) => {
      const rt = renderTasksRef.current.get(key);
      if (rt) { try { rt.cancel(); } catch { /* done */ } renderTasksRef.current.delete(key); }
      snapGridsRef.current.delete(key);
      vectorSegsRef.current.delete(key);
      segMetaRef.current.delete(key);
      maskCacheRef.current.delete(key);
      wallMaskCacheRef.current.delete(key);
      sheetStatsRef.current.delete(key);
      rasterMaskCacheRef.current.delete(key);
      pageObjsRef.current.delete(key);
      renderScalesRef.current.delete(key);
    };

    if (blank) {
      setStatus("rendering"); setErr(""); setPoly([]); setCalib([]); setPendingLen(""); setCheck([]); setCheckStated(""); setScaleGuide(null); setPrevScale(null); selectShape(null); setProposal(null); setWallProposal(null); resetZone();
      try { detailTaskRef.current?.cancel(); } catch { /* done */ }
      if (detailCanvasRef.current) detailCanvasRef.current.style.display = "none";
    } else {
      // A keep bitmap is on screen — chrome stays up (plan). If we arrived from
      // mount "loading", lift it now so the overlay cannot sit on a painted sheet.
      liftOverlay();
      const focusStill = groupKeys.includes(focusKey) || groupKeys.includes(sheetKey);
      if (!focusStill) {
        setPoly([]); setCalib([]); setPendingLen(""); setCheck([]); setCheckStated(""); setScaleGuide(null); setPrevScale(null); selectShape(null); setProposal(null); setWallProposal(null); resetZone();
      }
    }
    for (const k of missing) dropRuntime(k);

    (async () => {
      // phase A — dimensions for missing panels; keep keys reuse cached size
      const metas = [];
      for (const key of missing) {
        const { file, page: pn } = parseSheetKey(key);
        const pdf = await docFor(file); if (stale()) return;
        if (file === active) setPageCount(pdf.numPages || 1);
        const pageNum = Math.min(Math.max(1, pn), pdf.numPages || 1);
        const pageObj = await pdf.getPage(pageNum); if (stale()) return;
        const base = pageObj.getViewport({ scale: 1 });   // page size in PDF points
        // base raster obeys the same budget cap: for oversized pages (image ingest
        // mints 1px=1pt pages) autoRenderScale lands below RENDER_SCALE and wins
        const auto = autoRenderScale(base.width, base.height);
        const rs = hiResKeys.includes(key) ? auto : Math.min(RENDER_SCALE, auto);
        const viewport = pageObj.getViewport({ scale: rs });
        pageObjsRef.current.set(key, pageObj);     // kept for on-demand detail-view re-render
        renderScalesRef.current.set(key, rs);      // base raster scale — detail view renders at a multiple of it
        metas.push({ key, file, pageNum, pageObj, viewport, w: Math.ceil(viewport.width), h: Math.ceil(viewport.height) });
      }
      setPanelImgs((prev) => {
        const next = { ...prev };
        for (const k of keep) {
          const d = dimFor(k);
          if (d) next[k] = d;
        }
        for (const m of metas) next[m.key] = { w: m.w, h: m.h };
        return next;
      });
      const { rw, rh } = rowExtent(groupKeys, metas);
      if (rw && rh) fitToView(rw, rh);
      // phase B — raster missing keys only (keep canvases stay painted)
      for (const m of metas) {
        let canvas = panelCanvasRefs.current.get(m.key);
        for (let t = 0; !canvas && t < 24; t++) {
          await new Promise((r) => requestAnimationFrame(r)); if (stale()) return;
          canvas = panelCanvasRefs.current.get(m.key);
        }
        if (!canvas) continue;
        canvas.width = m.w; canvas.height = m.h;
        // dark: pdf.js paints light pixels progressively — keep the canvas hidden
        // and reveal it already-inverted, or every render flashes white-on-dark
        canvas.style.visibility = darkModeRef.current ? "hidden" : "";
        const rt = m.pageObj.render({ canvasContext: canvas.getContext("2d"), viewport: m.viewport });
        renderTasksRef.current.set(m.key, rt);
        try {
          await rt.promise;
        } catch (e) {
          if (e?.name !== "RenderingCancelledException") console.warn("[render]", e);
        }
        if (darkModeRef.current) invertCanvasPixels(canvas);   // negative view baked into pixels
        canvas.style.visibility = "";
        // Strict Mode / panel remount can swap the <canvas> mid-render — copy
        // onto whatever node is live, then stash that.
        const live = panelCanvasRefs.current.get(m.key);
        if (live && live !== canvas) {
          live.width = canvas.width;
          live.height = canvas.height;
          try { live.getContext("2d").drawImage(canvas, 0, 0); } catch { /* ignore */ }
          canvas = live;
        }
        canvasInvertedRef.current.set(canvas, !!darkModeRef.current);
        stashPanelPaint(m.key, canvas);
        // snap-to-vector index per panel (best-effort; off until the user enables it)
        m.pageObj.getOperatorList().then((ol) => {
          if (stale()) return;
          const { points, segs, meta, imageArea } = extractVectorGeometry(ol, m.viewport.transform, pdfjsLib.OPS);
          snapGridsRef.current.set(m.key, buildSnapGrid(points, SNAP_CELL));
          vectorSegsRef.current.set(m.key, segs);
          segMetaRef.current.set(m.key, meta);
          // raster-fallback trigger signals: how much of the sheet is placed
          // image, and whether the vector linework is dense enough to bound rooms
          sheetStatsRef.current.set(m.key, { segCount: segs.length >> 2, imageFrac: Math.min(1, imageArea / (m.w * m.h)) });
        }).catch(() => {
          if (stale()) return;
          sheetStatsRef.current.set(m.key, { segCount: 0, imageFrac: 1 });
        });
        // read the drawn scale note off this panel's page text (best-effort)
        m.pageObj.getTextContent().then((tc) => {
          if (stale()) return;
          const det = detectScale(tc, m.viewport);
          if (det) setDetectedScales((d) => (d[m.key]?.label === det.label ? d : { ...d, [m.key]: det }));
          // Plan symbols (door/window/type/finish marks) from the same text layer
          try {
            const tokens = extractRegionText(tc, m.viewport, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 });
            planSymbolsRawRef.current = { ...planSymbolsRawRef.current, [m.key]: extractPlanSymbols(tokens) };
            roomLabelsRawRef.current = { ...roomLabelsRawRef.current, [m.key]: extractRoomLabels(tokens) };
            setSymbolEpoch((n) => n + 1);
          } catch { /* best-effort */ }
        }).catch(() => {});
      }
      setMinimapPaintEpoch((epoch) => epoch + 1);
      setStatus("ready");
      // title-block labels — current page now, then once per file scan the rest so
      // the pager + pinned tabs + provenance deep-jump can show real sheet numbers
      const lead = metas.find((m) => m.file === active);
      if (!lead) return;
      lead.pageObj.getTextContent().then((tc) => {
        if (stale()) return;
        const lbl = extractSheetNumber(tc, lead.viewport);
        if (lbl) setPageLabels((m) => (m[lead.pageNum] === lbl ? m : { ...m, [lead.pageNum]: lbl }));
      }).catch(() => {});
      if (labeledFileRef.current !== active) {
        labeledFileRef.current = active;
        setPageLabels((m) => (m[lead.pageNum] ? { [lead.pageNum]: m[lead.pageNum] } : {})); // drop other file's labels
        (async () => {
          const pdf = await docFor(active);
          const found = {};
          for (let n = 1; n <= (pdf.numPages || 1); n++) {
            if (stale()) return;
            if (n === lead.pageNum) continue;
            try {
              const p2 = await pdf.getPage(n);
              const tc = await p2.getTextContent();
              const vp2 = p2.getViewport({ scale: RENDER_SCALE });
              const lbl = extractSheetNumber(tc, vp2);
              if (lbl) { found[n] = lbl; if (Object.keys(found).length % 8 === 0) setPageLabels((m) => ({ ...found, ...m })); }
              const det = detectScale(tc, vp2);
              if (det) {
                const key = n > 1 ? `${active}#${n}` : active;
                setDetectedScales((d) => (d[key]?.label === det.label ? d : { ...d, [key]: det }));
              }
              // Cross-sheet symbol match: index marks on pages not currently open
              try {
                const key = n > 1 ? `${active}#${n}` : active;
                const tokens = extractRegionText(tc, vp2, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 });
                planSymbolsRawRef.current = { ...planSymbolsRawRef.current, [key]: extractPlanSymbols(tokens) };
                roomLabelsRawRef.current = { ...roomLabelsRawRef.current, [key]: extractRoomLabels(tokens) };
                setSymbolEpoch((e) => e + 1);
              } catch { /* best-effort */ }
            } catch { /* skip */ }
          }
          if (!stale() && Object.keys(found).length) setPageLabels((m) => ({ ...found, ...m }));
        })();
      }
    })().catch((e) => {
      if (e?.name === "RenderingCancelledException") return;
      setErr(String(e.message || e));
      if (blank) setStatus("error");
    });
    // cleanup MUST read the LIVE refs, not a mount-time copy: bumping the current
    // renderSeqRef invalidates in-flight renders. Only cancel tasks for keys this
    // chain was rastering — keep-key tasks (already finished) stay put.
    return () => {
      renderSeq.current++;
      for (const k of missing) {
        const rt = renderTasks.current.get(k);
        if (rt) { try { rt.cancel(); } catch { /* done */ } renderTasks.current.delete(k); }
      }
    };
  }, [groupSig, hiResSig]);

  // Liveness watchdog: if status is stuck in "loading" or "rendering", transition to "ready"
  useEffect(() => {
    if (status === "loading" || status === "rendering") {
      const timer = setTimeout(() => {
        if (statusRef.current === "loading" || statusRef.current === "rendering") {
          const groupKeys = sheetGroup.length ? sheetGroup : (active ? [active] : []);
          const anyPainted = groupKeys.some((k) => sheetPainted(k) || panelCanvasRefs.current.has(k));
          if (anyPainted || sheets.length > 0) {
            setStatus("ready");
          }
        }
      }, 1800);
      return () => clearTimeout(timer);
    }
  }, [status, active, sheets.length, sheetGroup]);

  // Rebuild the enriched plan-symbol index whenever extracts, conditions, or
  // the project schedule knowledge-base change.
  useEffect(() => {
    setPlanSymbols(enrichSymbolsWithSchedule(buildPlanSymbolIndex(planSymbolsRawRef.current), {
      conditions,
      kb: scheduleKbRef.current,
      sheetNames: sheets.map((s) => s.name),
      galleryLabels,
    }));
  }, [conditions, symbolEpoch, symbolKbEpoch, sheets, galleryLabels]);

  const roomLabelsBySheet = useMemo(() => {
    void symbolEpoch;
    return { ...roomLabelsRawRef.current };
  }, [symbolEpoch]);
  const scheduleKb = useMemo(() => {
    void symbolKbEpoch;
    return new Map(scheduleKbRef.current);
  }, [symbolKbEpoch]);

  // Stable name set — listSheets / manifest refresh often rebuilds the sheets
  // array with identical names; depending on array identity would cancel the
  // in-flight PDF scan and leave the hover KB empty forever on large projects.
  const sheetsSig = useMemo(
    () => sheets.map((s) => s.name).slice().sort().join("\0"),
    [sheets],
  );

  // Background: scan uploaded PDFs whose filenames look like door / window /
  // finish schedules (or detail sheets) and build a mark → detail knowledge base
  // so hover can show accurate fields from the schedule PDFs themselves.
  useEffect(() => {
    if (!sheetsSig) {
      scheduleKbRef.current = new Map();
      setSymbolKbEpoch((n) => n + 1);
      return;
    }
    const names = sheetsSig.split("\0");
    let cancelled = false;
    (async () => {
      const entries = [];
      // Basename classify (folder names like DETAILS/ must not force class), then
      // door/window/finish first so hover fills before we grind through detail sheets.
      const ranked = names
        .map((name) => {
          const base = name.replace(/\\/g, "/").split("/").pop() || name;
          return { name, base, cls: classifySheetByName(base) };
        })
        .filter((x) => x.cls !== "other")
        .sort((a, b) => {
          const rank = { door_schedule: 0, window_schedule: 1, finish_schedule: 2, detail: 3 };
          return (rank[a.cls] ?? 9) - (rank[b.cls] ?? 9);
        });
      for (const { name, base, cls } of ranked) {
        if (cancelled) return;
        try {
          const pdf = await docFor(name);
          if (cancelled) return;
          const nPages = pdf.numPages || 1;
          for (let n = 1; n <= nPages; n++) {
            if (cancelled) return;
            try {
              const page = await pdf.getPage(n);
              const tc = await page.getTextContent();
              const vp = page.getViewport({ scale: RENDER_SCALE });
              const tokens = extractRegionText(tc, vp, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 });
              const key = n > 1 ? `${name}#${n}` : name;
              entries.push(...extractScheduleKbFromSheet(tokens, { sheet_id: key, file_name: base }));
            } catch { /* skip page */ }
          }
          // Publish after each real schedule sheet so CW/D/finish hover fills
          // without waiting on every DETAIL sheet in a large plan set.
          if (cls === "door_schedule" || cls === "window_schedule" || cls === "finish_schedule") {
            if (cancelled) return;
            scheduleKbRef.current = buildScheduleKb(entries);
            setSymbolKbEpoch((n) => n + 1);
          }
        } catch { /* skip file */ }
      }
      if (cancelled) return;
      scheduleKbRef.current = buildScheduleKb(entries);
      setSymbolKbEpoch((n) => n + 1);
    })();
    return () => { cancelled = true; };
    // docFor is stable (useCallback []); sheetsSig drives the scan
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetsSig]);

  // Room-label index for Auto-Takeoff floor plans — summary names must resolve even
  // when no sheet is open on the canvas (empty-canvas default).
  useEffect(() => {
    if (!sheets.length) return;
    let cancelled = false;
    (async () => {
      for (const { name } of sheets) {
        if (!isAiDetectFloorPlan(name)) continue;
        try {
          const pdf = await docFor(name);
          const nPages = pdf.numPages || 1;
          for (let n = 1; n <= nPages; n++) {
            if (cancelled) return;
            const key = n > 1 ? `${name}#${n}` : name;
            const page = await pdf.getPage(n);
            const tc = await page.getTextContent();
            const vp = page.getViewport({ scale: RENDER_SCALE });
            setPanelImgs((prev) => (prev[key]?.w ? prev : { ...prev, [key]: { w: vp.width, h: vp.height } }));
            if (roomLabelsRawRef.current[key]?.length) continue;
            try {
              const tokens = extractRegionText(tc, vp, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 });
              roomLabelsRawRef.current = { ...roomLabelsRawRef.current, [key]: extractRoomLabels(tokens) };
              setSymbolEpoch((e) => e + 1);
            } catch { /* best-effort */ }
          }
        } catch { /* best-effort */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheets, isAiDetectFloorPlan]);

  // ── detail view: re-render the visible region at the current zoom ───────────
  // The base panel bitmap is the fast first paint and the zoomed-out view. Once
  // zoomed past DETAIL_ENGAGE we overlay a crop of JUST what's on screen (+margin),
  // rendered from the PDF vectors at the current zoom, so linework stays razor-sharp
  // with no giant full-sheet bitmap. `tf` only updates after the ~80ms pan/zoom settle
  // (scheduleSync), so this is naturally debounced. Pixels only — markup is an SVG
  // sibling ABOVE this canvas, and quantities never touch render pixels: both untouched.
  useEffect(() => {
    const cv = detailCanvasRef.current, cont = containerRef.current, fp = focusPanel;
    const hide = () => { if (cv) cv.style.display = "none"; detailKeyRef.current = ""; };
    if (!cv || !cont || status !== "ready" || !fp || !fp.img.w) return hide();
    const t = tfRef.current;
    if (window.__OT_DETAIL_DEBUG) console.log("[detail] tick " + JSON.stringify({ scale: +t.scale.toFixed(2), dpr: window.devicePixelRatio, pan: !!panRef.current, hold: +(gestureUntilRef.current - performance.now()).toFixed(0) }));
    if (t.scale * (window.devicePixelRatio || 1) <= DETAIL_ENGAGE) return hide();
    // Mid-gesture bail: `cv.width = bw` below WIPES the crop and reallocs tens of MB —
    // doing that on every ~90ms sync while pinching/panning would flash the region
    // blank and storm pdf.js with cancelled renders. The previous crop lives in stage
    // space, so leaving it painted keeps it correctly anchored while the gesture runs;
    // scheduleSync self-polls so the settle render is guaranteed once the window expires.
    if (panRef.current || performance.now() < gestureUntilRef.current) { scheduleSync(); return; }
    const pageObj = pageObjsRef.current.get(fp.key), rs = renderScalesRef.current.get(fp.key);
    if (!pageObj || !rs) return hide();

    // visible region of THIS panel, in image px (stage space minus the panel's xOffset)
    const r = cont.getBoundingClientRect();
    let x0 = Math.max((-t.x) / t.scale, fp.xOffset) - fp.xOffset;
    let y0 = Math.max((-t.y) / t.scale, 0);
    let x1 = Math.min((r.width - t.x) / t.scale, fp.xOffset + fp.img.w) - fp.xOffset;
    let y1 = Math.min((r.height - t.y) / t.scale, fp.img.h);
    if (x1 <= x0 || y1 <= y0) return hide();           // panel off-screen
    const mw = (x1 - x0) * DETAIL_MARGIN, mh = (y1 - y0) * DETAIL_MARGIN;
    x0 = Math.max(0, x0 - mw); y0 = Math.max(0, y0 - mh);
    x1 = Math.min(fp.img.w, x1 + mw); y1 = Math.min(fp.img.h, y1 + mh);
    const regW = x1 - x0, regH = y1 - y0;

    // density: enough backing px that the stage's CSS scale (×t.scale) isn't upscaling.
    // Capped by canvas limits, but the region is ~viewport-sized so the cap ~never binds.
    const dpr = window.devicePixelRatio || 1;
    let factor = Math.min(t.scale * dpr, MAX_CANVAS_DIM / regW, MAX_CANVAS_DIM / regH, Math.sqrt(MAX_CANVAS_AREA / (regW * regH)));
    factor = Math.max(1, factor);
    const bw = Math.max(1, Math.round(regW * factor)), bh = Math.max(1, Math.round(regH * factor));

    // pdf scale yielding factor× the base raster density; shift the region's top-left to (0,0)
    const vp = pageObj.getViewport({ scale: rs * factor });
    // Double-buffer: render into an offscreen canvas and swap AFTER the pixels
    // exist. Writing cv.width here would clear the visible crop synchronously
    // while pdf.js paints the replacement async — a crisp→blank→crisp blink on
    // every pan/zoom settle (worse the deeper the zoom, since renders run longer).
    // The old crop is still correctly anchored in stage space, so it stays up
    // until the swap; the back store is released right after (width = 0).
    // one render per distinct crop — the sync loop re-fires this effect several
    // times around a settle with identical inputs, and each redundant pass is a
    // full-viewport pdf.js render (in dark mode plus a full-canvas inversion)
    const renderKey = `${fp.key}|${x0.toFixed(1)},${y0.toFixed(1)}|${bw}x${bh}`;
    if (renderKey === detailKeyRef.current) return;
    detailKeyRef.current = renderKey;
    const back = detailBackRef.current || (detailBackRef.current = document.createElement("canvas"));
    back.width = bw; back.height = bh;
    try { detailTaskRef.current?.cancel(); } catch { /* done */ }
    clearTimeout(detailWatchdogRef.current);
    const rt = pageObj.render({ canvasContext: back.getContext("2d"), viewport: vp, transform: [1, 0, 0, 1, -x0 * factor, -y0 * factor] });
    detailTaskRef.current = rt;
    // Backstop watchdog — NOT the primary fix (that's the visibilitychange retry
    // below, which targets the actual documented cause). This only covers some
    // OTHER wedge with no visibility signal, so it deliberately skips firing while
    // still hidden (retrying then would just wedge the same way) and is tuned long
    // enough to never race a merely slow render.
    detailWatchdogRef.current = setTimeout(() => {
      if (detailTaskRef.current !== rt) return;              // already superseded — nothing to recover
      if (document.visibilityState !== "visible") return;    // still hidden — visibilitychange will recover it on return
      if (detailKeyRef.current === renderKey) detailKeyRef.current = "";   // let the next tick retry this crop
      if (window.__OT_DETAIL_DEBUG) console.log("[detail] stalled, retrying", renderKey);
      scheduleSync();
    }, DETAIL_STALL_MS);
    rt.promise.then(() => {
      clearTimeout(detailWatchdogRef.current);
      if (darkModeRef.current) invertCanvasPixels(back);   // negative view baked into pixels before it's ever visible
      cv.style.left = `${fp.xOffset + x0}px`; cv.style.top = `${y0}px`;
      cv.style.width = `${regW}px`; cv.style.height = `${regH}px`;
      cv.width = bw; cv.height = bh;
      cv.getContext("2d").drawImage(back, 0, 0);           // clear + repaint inside one task: no blank frame
      back.width = back.height = 0;
      canvasInvertedRef.current.set(cv, !!darkModeRef.current);
      cv.style.display = "block"; cv.style.visibility = "";
      if (window.__OT_DETAIL_DEBUG) console.log("[detail] swapped", bw, "x", bh);
    }).catch((e) => {   // RenderingCancelledException on rapid re-zoom is expected
      clearTimeout(detailWatchdogRef.current);
      if (detailKeyRef.current === renderKey) detailKeyRef.current = "";   // let the next tick retry this crop
      if (e?.name !== "RenderingCancelledException") console.error("[detail] render failed:", e);
    });
    // panelW/takeoffsOpen: docking or resizing the Takeoffs panel changes the
    // container rect without a transform change — re-run so the crop resyncs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf, groupSig, status, focusKey, panelW, takeoffsOpen]);

  // Primary recovery for the detail-view stall: a hidden tab can suspend pdf.js's
  // render scheduling indefinitely (the promise above neither resolves nor rejects,
  // no console error — Chrome throttles rAF-gated work in hidden tabs). Retrying the
  // moment the tab is foregrounded again is immediate and, unlike a blind timeout,
  // never fights a render that's just legitimately slow while visible.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible" || !detailKeyRef.current) return;
      detailKeyRef.current = "";   // let the next tick re-request the pending crop
      scheduleSync();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [scheduleSync]);

  // the doc cache holds whole PDFs in the worker — tear it down when the
  // project view unmounts or the project changes
  useEffect(() => () => {
    for (const [, t] of pdfDocsRef.current) { t.then((task) => { try { task.destroy(); } catch { /* already gone */ } }).catch(() => {}); }
    pdfDocsRef.current.clear();
  }, []);

  // provenance deep-jump: if the URL named a sheet (?sheet=A003), jump once its page is known
  useEffect(() => {
    const want = (wantSheetRef.current || "").toUpperCase().replace(/\s+/g, "");
    if (!want) return;
    const hit = Object.entries(pageLabels).find(([, lbl]) => lbl === want);
    if (hit) { setPage(parseInt(hit[0], 10)); wantSheetRef.current = ""; }
  }, [pageLabels]);

  // fly-to phase 2: a pending fly-to whose sheet just finished opening (its panel
  // now has a real bitmap) gets centered here — never on the same tick openSheets
  // was called (dims are still {0,0} then).
  useEffect(() => {
    const m = pendingFlyRef.current;
    if (!m) return;
    // drop a stale pending fly-to: the target sheet failed to render, or the markup
    // was deleted — either way it will never complete, so don't let it fire later.
    if (status === "error" || !markups.some((x) => x.id === m.id)) { pendingFlyRef.current = null; return; }
    if (status !== "ready" || !panelKeySet.has(m.sheet_id)) return;
    const sp = panels.find((p) => p.key === m.sheet_id);
    // once the panel bitmap exists, center (or give up if the markup has no anchor)
    // and clear the ref regardless, so an unanchored markup can't get stuck pending.
    if (sp && sp.img.w) { centerOnMarkup(m); pendingFlyRef.current = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelImgs, groupSig, status]);

  // fly-to phase 2 for BOQ row navigation — same two-phase pattern as markups.
  useEffect(() => {
    const id = pendingFlyShapeRef.current;
    if (!id) return;
    const s = shapes.find((x) => x.id === id);
    if (status === "error" || !s) { pendingFlyShapeRef.current = null; return; }
    if (status !== "ready" || !panelKeySet.has(s.sheet_id)) return;
    const sp = panels.find((p) => p.key === s.sheet_id);
    if (sp && sp.img.w) { centerOnShape(s); pendingFlyShapeRef.current = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelImgs, groupSig, status, shapes]);

  const boqDetectCtx = useMemo(() => ({
    planSymbols, symbolNotes, panelImgs, roomLabelsBySheet, scheduleKb, shapes,
  }), [planSymbols, symbolNotes, panelImgs, roomLabelsBySheet, scheduleKb, shapes]);

  const projectSettings = useMemo(() => ({
    currency: projectCurrency,
    markup_pct: markupPct,
    overhead_pct: overheadPct,
  }), [projectCurrency, markupPct, overheadPct]);

  const pricingCtx = useMemo(() => ({
    catalog: materialRates,
    currency: projectCurrency,
    priceRow: (row) => priceMaskRow(row, materialRates, units, projectSettings),
  }), [materialRates, projectCurrency, units, projectSettings]);

  const projectEstimateTotal = useMemo(() => {
    const rows = pricedConditionTotals(
      conditionTotals(conditions, boqShapes).filter((r) => r.shape_count > 0),
      materialRates,
      units,
      projectSettings,
    );
    return pricedGrandTotals(rows, projectSettings).grand_total;
  }, [conditions, boqShapes, materialRates, units, projectSettings]);

  const [estimateValuePulse, setEstimateValuePulse] = useState(false);
  const [estimateHistory, setEstimateHistory] = useState(() => [{ t: Date.now(), v: 0 }]);
  const prevEstimateTotalRef = useRef(projectEstimateTotal);
  useEffect(() => {
    setEstimateHistory((h) => {
      const last = h[h.length - 1];
      const v = Number(projectEstimateTotal) || 0;
      if (last && Math.abs(last.v - v) < 1e-6) return h;
      const next = [...h, { t: Date.now(), v }];
      return next.length > 28 ? next.slice(next.length - 28) : next;
    });
    if (prevEstimateTotalRef.current === projectEstimateTotal) return;
    prevEstimateTotalRef.current = projectEstimateTotal;
    setEstimateValuePulse(true);
    const t = setTimeout(() => setEstimateValuePulse(false), 480);
    return () => clearTimeout(t);
  }, [projectEstimateTotal]);

  useEffect(() => {
    listMaterialRates().then(setMaterialRates).catch(() => {});
  }, []);

  useEffect(() => {
    if (showRates) listMaterialRates().then(setMaterialRates).catch(() => {});
  }, [showRates]);

  // ── autosave (debounced) ──────────────────────────────────────────────────
  // buildPayload is the single serializer — autosave and snapshots must write
  // identical records for the same state (byte-stability matters downstream).
  const buildPayload = () => {
    // palette holds condition ids; drop any that no longer resolve (defensive —
    // delete already prunes) and omit the key entirely when nothing survives,
    // mirroring the condition_columns omit-when-empty convention.
    const pinned = palette.filter((id) => conditions.some((c) => c.id === id));
    // units is additive and diff-only (the sheet_levels convention): imperial —
    // the default — omits the key, so an old imperial project's payload is
    // byte-identical on round-trip; only a metric project carries the field.
    return { project_name: projectName, ...(units === "metric" ? { units } : {}), currency: projectCurrency, markup_pct: markupPct, overhead_pct: overheadPct, ...(Object.values(clientInfo).some((v) => v && String(v).trim()) ? { client_info: clientInfo } : {}), sheets: Object.entries(scales).map(([sheet_id, units_per_px]) => ({ sheet_id, units_per_px, ...(scaleSources[sheet_id] ? { scale_source: scaleSources[sheet_id] } : {}) })), conditions, ...(conditionColumns.length ? { condition_columns: conditionColumns } : {}), ...(shapeLabels.length ? { shape_labels: shapeLabels } : {}), ...(pinned.length ? { palette: pinned } : {}), shapes, markups, rfis, sheet_group: sheetGroup, last_group: lastGroup, sheet_tabs: openTabs, ...(Object.keys(sheetLevels).length ? { sheet_levels: sheetLevels } : {}), ...(Object.keys(fileFolders).length ? { file_folders: fileFolders } : {}), ...(Object.keys(symbolNotes).length ? { symbol_notes: symbolNotes } : {}), ...(boqLines.length ? { boq_lines: boqLines } : {}), ...(Object.keys(provCounters.shapes_deleted).length ? { provenance_counters: provCounters } : {}), ...layerPersistSlice({ layerForest, hiddenShapeIds, lockedShapeIds }) };
  };
  // Runtime restore of a saved payload — the Revisions panel's Restore lands
  // here. A runtime load (unlike mount) can interrupt work in
  // flight: an unfinished trace/calibration/proposal must not commit into the
  // restored takeoff under a reset activeCond. The check tool and the rescale
  // stash are in that class too — a surviving prevScale would let "Revert
  // scale" re-price the RESTORED takeoff against a scale stashed from the
  // discarded timeline. Zone is in the same class: a surviving zoneCheck would
  // re-classify the RESTORED shape set against the pre-load polygon (hydrate()
  // also resets it, but this caller-side reset covers the pending in-progress
  // trace too). Mid-session, savesArmed is already true, so hydrate's setStates
  // re-fire the autosave effect and the restored payload persists (and pushes,
  // on the sync path) like any other edit.
  const restoreSavedPayload = (payload) => {
    setPoly([]); setCalib([]); setPendingLen(""); selectShape(null); setProposal(null);
    setCheck([]); setCheckStated(""); setScaleGuide(null); setPrevScale(null);
    resetZone();
    hydrate(payload || {});
  };

  // markups MUST be in the deps (a cloud/callout/text or an RFI link is real work);
  // omitting it dropped markup saves and could persist a stale markups array.
  useEffect(() => {
    if (!hydrated.current) return;
    // Swallow the hydration echo: the first run after hydrate() carries no user
    // edit (only the fresh-identity setState from loading). Arm and skip it so a
    // link-open reads without writing; every later run is a real edit and saves.
    if (!savesArmed.current) { savesArmed.current = true; return; }
    // Swallow a reconcile re-hydrate's echo (see suppressNextSave): the adopted
    // content is already canonical locally and on Drive at its own rev — re-pushing
    // it would churn revs (seed) or spuriously conflict + loser-snapshot (adopt).
    if (suppressNextSave.current) { suppressNextSave.current = false; return; }
    // A reconcile adopted a remote winner into local (synced_rev is already advanced)
    // but the canvas is still showing the SUPERSEDED pre-adopt content because we
    // deferred the render while busy (Slice 5b Case 2). Persisting/pushing now would
    // send stale content at the winner's rev and silently clobber it. Skip entirely
    // until the idle-drain re-hydrates the winner; any edits made on this superseded
    // canvas are dropped by that re-hydrate (visible supersession, not silent loss —
    // the co-editing casualty the rollout forbids). The drain clears the flag.
    if (remotePendingRender.current) return;
    const payload = buildPayload();
    saveDataRef.current = payload;          // keep the freshest payload for an unmount flush
    setSaveState("saving");
    const t = setTimeout(() => {
      // A render was deferred AFTER this save was scheduled (its closure captured the
      // pre-adopt payload) → don't push stale over the winner; go idle so the canvas
      // can drain and re-hydrate. Closes the last pre-scheduled-save loss window.
      if (remotePendingRender.current) { setSaveState("idle"); return; }
      store.saveAnnotations(payload).then(() => setSaveState("saved")).catch((e) => {
        if (isStaleTabError(e)) setCommitMsg(STALE_TAB_MESSAGE);
        setSaveState("idle");
      });
    }, 250);   // near real-time — short debounce so every edit lands quickly without thrashing IDB/Drive
    return () => clearTimeout(t);
    // buildPayload is intentionally omitted: this dep list IS the exact set of
    // state it serializes, so listing buildPayload (a new identity each render)
    // would fire a save on every render instead of only on a real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, conditions, conditionColumns, shapeLabels, palette, scales, scaleSources, markups, rfis, provCounters, sheetGroup, sheetLevels, fileFolders, symbolNotes, boqLines, lastGroup, openTabs, projectName, clientInfo, units, layerForest, hiddenShapeIds, lockedShapeIds]);
  useEffect(() => { saveStateRef.current = saveState; }, [saveState]);

  // Flush a pending debounced save on navigate-away (unmount), and warn before a
  // tab close while a save is in flight — so the tail of a tracing session is never lost.
  useEffect(() => {
    // Pin the store this canvas mounted against: on a client-side exit from a
    // cloud project, React runs the PARENT (ProjectGate) cleanup first, which
    // resets the live `store` binding to localStore — flushing through the live
    // binding here would write the cloud project's annotations into the local
    // store. In-life saves keep the live binding (it never swaps mid-mount).
    const mountStore = store;
    const onBeforeUnload = (e) => { if (saveStateRef.current === "saving") { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (hydrated.current && saveStateRef.current === "saving" && saveDataRef.current) {
        mountStore.saveAnnotations(saveDataRef.current).catch(() => {});   // best-effort flush
      }
    };
  }, []);

  // ── Local-first sync bridge (Slices 5a + 5b) ───────────────────────────────
  // On the opted-in path the active store carries a non-enumerable `syncBridge`
  // (main.jsx); on the legacy cloud path (and anonymous local) there is none, so
  // every handler below is a no-op and flag-off behavior is byte-identical.

  // The defer-gate predicate. computeBusy reads ONLY refs (busyStateRef, mirrored
  // from state every render, plus the interaction refs), so it is always fresh yet
  // stable to capture once — no re-registration null window. isCanvasBusy is the
  // pure, unit-tested core (lib/canvasBusy.js); it must report EVERY interaction mode
  // a mid-session re-hydrate would clobber (trace/calibrate/check, One-Click review,
  // a scheduled save, an active drag, the open text editor, an in-flight OCR scan,
  // an agent run and its staged proposals — hydrate() wipes agentProposals and the
  // conditions a mid-run agent minted, so both defer exactly like One-Click review).
  busyStateRef.current = { poly, calib, check, proposal, scaleGuide, prevScale, agentRunning, agentProposals };
  const computeBusy = () => isCanvasBusy({
    ...busyStateRef.current,
    saveState: saveStateRef.current,
    dragging: !!dragRef.current || !!ocDragRef.current,
    editing: editingRef.current,
    scanning: scanBusyRef.current,
  });

  // Register both reconcile handlers ONCE. onRemoteUpdate handles CASE 2: the store
  // adopted remote→local, then the canvas went busy in maybeFlush's ~2-IDB-write gap
  // before this fires. Re-check busy at APPLY time — if busy, DEFER the render (local
  // already equals remote on Drive; the idle-drain below re-hydrates) rather than
  // clobber the in-flight work; else suppress the echo and hydrate. EITHER branch
  // nulls saveDataRef so the unmount flush can't push a pre-adopt payload at a fresh
  // rev over the remote winner. (It does NOT stop an already-scheduled debounced save
  // firing stale — that is the documented residual, active-co-editing-only.)
  useEffect(() => {
    const bridge = store.syncBridge;
    if (!bridge) return;
    bridge.isBusy = computeBusy;
    bridge.onRemoteUpdate = (data) => {
      saveDataRef.current = null;
      if (computeBusy()) { remotePendingRender.current = true; return; }
      remotePendingRender.current = false; // this hydrate satisfies any earlier deferred render
      suppressNextSave.current = true;
      hydrate(data || {});
    };
    return () => { bridge.isBusy = null; bridge.onRemoteUpdate = null; };
    // computeBusy + hydrate are stable for a given mount (they read only refs / call
    // setters), so capture once; listing them would re-register every render, opening
    // a null window where an arriving reconcile is dropped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Idle-drain. When the canvas goes idle, drain BOTH defer paths:
  //   CASE 1 — the store deferred at its own gate (isBusy true → never adopted,
  //     pendingRemote held, local untouched): flushPending() adopts now and fires
  //     onRemoteUpdate → hydrate.
  //   CASE 2 — we deferred the render above: re-read LOCAL (freshest — the adopt, or a
  //     local edit the user saved during the busy window; stashing the remote data
  //     would silently clobber that saved edit) and hydrate.
  // `saveState` is in the deps because the last thing to clear on going idle is usually
  // the debounced save (saving→saved) — and it must gate re-hydrate anyway so a
  // committed trace's pending save lands before we re-read (CRITICAL-b).
  useEffect(() => {
    const bridge = store.syncBridge;
    if (!bridge || computeBusy()) return;
    let alive = true;
    (async () => {
      // Serialize: drain Case 1 FIRST so a store-deferred adopt lands (and its
      // onRemoteUpdate hydrates + clears remotePendingRender) before the Case 2
      // re-read — otherwise the re-read could race the adopt's IDB writes and read
      // stale local.
      await bridge.flushPending?.();
      // Re-check after the awaits: unmounted, or the user went busy again → bail and
      // leave remotePendingRender set so the NEXT idle retries (never a dropped render).
      if (!alive || !remotePendingRender.current || computeBusy()) return;
      try {
        const a = await store.loadAnnotations(); // freshest local: the adopt, or an interim saved edit
        // A concurrent store-side onRemoteUpdate may have hydrated + cleared the flag
        // during the await — don't double-hydrate (Finding 4).
        if (!alive || computeBusy() || !remotePendingRender.current) return;
        remotePendingRender.current = false;      // clear ONLY after a successful read
        suppressNextSave.current = true;
        hydrate(a || {});
      } catch { /* keep remotePendingRender → retry on the next idle, never drop it */ }
    })();
    return () => { alive = false; };
    // computeBusy/hydrate are stable (refs/setters); the deps below ARE the idle-
    // transition triggers. saveState catches the debounced-save clearing; idleTick
    // catches an interaction ref (drag/editor/scan) clearing with no state change.
    // agentRunning/agentProposals: the run finishing or the last proposal being
    // accepted/rejected is a busy→idle edge that must drain a held remote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poly, calib, check, proposal, scaleGuide, prevScale, saveState, idleTick, agentRunning, agentProposals]);

  function fitToView(w, h) {
    const el = containerRef.current;
    if (!el) return setTfNow({ x: 0, y: 0, scale: 1 });
    const r = el.getBoundingClientRect();
    const scale = Math.min((r.width - 40) / w, (r.height - 40) / h, 1);
    setTfNow({ x: (r.width - w * scale) / 2, y: (r.height - h * scale) / 2, scale });
  }

  const toImage = useCallback((cx, cy) => {
    const r = containerRef.current.getBoundingClientRect();
    const t = tfRef.current;
    return [(cx - r.left - t.x) / t.scale, (cy - r.top - t.y) / t.scale];
  }, []);

  // memoized so the wheel-zoom effect can list it as a dep and still bind its
  // listener once — a plain function would give a new identity each render and
  // re-subscribe the (passive:false) wheel handler on every render.
  const zoomAround = useCallback((cx, cy, factor) => {
    const t = tfRef.current;
    const next = clamp(t.scale * factor);
    const k = next / t.scale;
    tfRef.current = { scale: next, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k };
    applyTf(); scheduleSync();
  }, [applyTf, scheduleSync]);

  // Minimap scroll/pinch zooms the main sheet toward the stage point under the cursor.
  const zoomFromMinimap = useCallback((clientX, clientY, factor) => {
    const pt = stagePointFromMinimap(clientX, clientY);
    if (!pt) return;
    const t = tfRef.current;
    zoomAround(t.x + pt.x * t.scale, t.y + pt.y * t.scale, factor);
  }, [zoomAround]);

  // wheel: the DEVICE decides between pan and zoom — no toggle, no mode.
  // Continuous trackpad scroll PANS both axes (the two-finger instinct every
  // Mac user brings); a discrete mouse-wheel notch ZOOMS toward the cursor,
  // glided over a few frames so it doesn't step. Pinch (ctrl/meta) always
  // zooms at its original immediate sensitivity; ⇧+wheel always pans.
  //
  // Device telling: the burst-OPENING event decides. macOS runs mouse wheels
  // through scroll acceleration, so the classic wheelDelta ±120 signature is
  // useless there (measured on real hardware: wheelDeltaY is exactly -3×deltaY
  // for BOTH devices). What separates them is the opening magnitude: a wheel
  // notch LANDS at full delta — |deltaY|≈12 minimum on macOS (acceleration
  // floor), ≈100 on Windows — while a trackpad gesture physically RAMPS from
  // finger contact (|deltaY| 0–2 at burst start, violent flicks included).
  // Line/page deltaMode is always a mouse (Firefox wheels). Classification is
  // carried while events keep arriving <300ms apart, so momentum tails keep
  // panning and a fast spin keeps zooming.
  useEffect(() => {
    if (status !== "ready") return;
    const stage = stageRef.current;
    const cont = containerRef.current;
    if (!stage || !cont) return;
    const wheelChromeSel = ".toolbar-glass-bar,.toolbar-glass-pill,.toolbar-glass-pills-row,.tool-menu-drop-panel,.tool-menu-palette-shell,.tool-menu-anchored-panel,.takeoff-sticky-panel,.canvas-left-stack,.canvas-glass-cluster,.canvas-sheets-fab,.drawings-chat-glass-trigger,.left-window,.left-panel-glass,.left-panel-slot,.canvas-minimap,.canvas-zoom-bar,.chrome-edge-trigger,.takeoffs-drawer-slot,.drawings-ask-wrap,.drawings-chat-center-scrim,.cond-edit-float,.ill-panel,[data-hover-scroll]";
    const inRect = (x, y, r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    const wheelOnSheet = (e) => {
      const x = e.clientX, y = e.clientY;
      // Ignore wheels whose pointer sits outside this iframe (e.g. ADICC TopNav
      // above the embed when the iframe still receives a focused trackpad gesture).
      if (y < 0 || x < 0 || x > window.innerWidth || y > window.innerHeight) return false;
      const cr = cont.getBoundingClientRect();
      // Only the canvas workspace — never the deck toolbar / condition strip above it.
      if (!inRect(x, y, cr)) return false;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !stage.contains(hit)) return false;
      if (hit.closest?.(wheelChromeSel)) return false;
      const tb = document.querySelector(".toolbar-glass-bar");
      if (tb && inRect(x, y, tb.getBoundingClientRect())) return false;
      const leftCol = document.querySelector(".canvas-left-stack")?.parentElement;
      if (leftCol && inRect(x, y, leftCol.getBoundingClientRect())) return false;
      for (const node of document.querySelectorAll(wheelChromeSel)) {
        const r = node.getBoundingClientRect();
        if (inRect(x, y, r)) return false;
      }
      return true;
    };
    let glide = 0, gx = 0, gy = 0, raf = 0;
    let glideOnMinimap = false;
    let kind = "", kindUntil = 0;   // per-burst wheel-device classification
    const wheelKind = (e) => {
      const now = performance.now();
      if (kind && now < kindUntil) { kindUntil = now + 300; return kind; }
      kind = (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 10) ? "mouse" : "trackpad";
      kindUntil = now + 300;
      return kind;
    };
    const step = () => {
      raf = 0;
      const d = Math.abs(glide) < 0.002 ? glide : glide * 0.35;
      glide -= d;
      if (d) {
        if (glideOnMinimap) zoomFromMinimap(gx, gy, Math.exp(d));
        else {
          const r = cont.getBoundingClientRect();
          zoomAround(gx - r.left, gy - r.top, Math.exp(d));
        }
      }
      if (glide) {
        gestureUntilRef.current = performance.now() + GESTURE_MS;  // glide still moving = still a gesture
        raf = requestAnimationFrame(step);
      }
    };
    const onWheel = (e) => {
      if (editingRef.current) return;   // freeze pan/zoom while the inline text editor is pinned to its anchor
      const overMinimap = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".canvas-minimap.is-open");
      if (overMinimap) {
        // Overview is for navigation: scroll / pinch always zooms the sheet.
        e.preventDefault();
        gestureUntilRef.current = performance.now() + GESTURE_MS;
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
        if (e.ctrlKey || e.metaKey) {
          zoomFromMinimap(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
          return;
        }
        glideOnMinimap = true;
        glide += -e.deltaY * unit * 0.0012;
        glide = Math.max(-1.2, Math.min(1.2, glide));
        gx = e.clientX; gy = e.clientY;
        if (!raf) raf = requestAnimationFrame(step);
        return;
      }
      const onSheet = wheelOnSheet(e);
      if (!onSheet) {
        // Trackpad pinch on toolbars/rails must not zoom the sheet or the browser page.
        if (e.ctrlKey || e.metaKey) e.preventDefault();
        return;
      }
      e.preventDefault();
      gestureUntilRef.current = performance.now() + GESTURE_MS;  // detail view waits for wheel quiet
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      glideOnMinimap = false;
      if (e.shiftKey) {
        const t = tfRef.current;
        tfRef.current = { ...t, x: t.x - e.deltaX * unit, y: t.y - e.deltaY * unit };
        applyTf(); scheduleSync();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const r = cont.getBoundingClientRect();
        zoomAround(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
        return;
      }
      if (wheelKind(e) === "trackpad") {
        // two-finger scroll = pan, both axes — the sheet follows the fingers
        const t = tfRef.current;
        tfRef.current = { ...t, x: t.x - e.deltaX * unit, y: t.y - e.deltaY * unit };
        applyTf(); scheduleSync();
        return;
      }
      glide += -e.deltaY * unit * 0.0012;            // one notch (~100) ≈ 12% zoom
      glide = Math.max(-1.2, Math.min(1.2, glide));  // cap queued zoom per direction
      gx = e.clientX; gy = e.clientY;
      if (!raf) raf = requestAnimationFrame(step);
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => { window.removeEventListener("wheel", onWheel, { capture: true }); if (raf) cancelAnimationFrame(raf); };
  }, [applyTf, scheduleSync, zoomAround, zoomFromMinimap, status]);

  // Space = temporary pan (any tool)
  useEffect(() => {
    const down = (e) => { if (e.code === "Space" && !e.repeat && e.target.tagName !== "INPUT") { spaceRef.current = true; if (containerRef.current) containerRef.current.style.cursor = "grab"; } };
    const up = (e) => { if (e.code === "Space") { spaceRef.current = false; if (containerRef.current) containerRef.current.style.cursor = ""; } };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // Single-letter tool shortcuts (STACK-style) — suppressed while typing or
  // while a toolbar menu is open. ⌘-combos and 1–9 live in their own handlers.
  useEffect(() => {
    const onKey = (e) => {
      const tg = e.target.tagName;
      if (tg === "INPUT" || tg === "SELECT" || tg === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (menuDepthRef.current > 0) return;
      if (e.key === "Enter") {
        // router offer confirm takes the key FIRST (RFC #59 slice 5): the
        // offer is the most recent thing the user was told ⏎ does, and it
        // auto-expires — so it can never contest ⏎ for long, and a pending
        // agent-proposal accept resumes the key the moment the offer clears
        if (overlapPrompt) { e.preventDefault(); resolveOverlapPrompt("merge"); return; }
        if (agentOfferFnsRef.current?.pending()) { e.preventDefault(); agentOfferFnsRef.current.confirm(); return; }
        if (tool === "oneclick" && proposal?.regions.length) { e.preventDefault(); createProposal(); return; }
        if (tool === "walltrace" && wallProposal?.regions.length) { e.preventDefault(); createWallProposal(); return; }
        if (canFinishDraw(tool, poly.length, { zoneCross: zoneTraceCross })) { e.preventDefault(); finishShape(); return; }
        // ⏎ with agent proposals pending on a visible sheet = accept them all —
        // the agent's analogue of one-click's Create gate. Only fires when no
        // trace/proposal claimed the key above, so mid-draw ⏎ is untouched.
        if (agentProposals.some((p) => panelKeySet.has(p.sheet_id))) { e.preventDefault(); acceptAllVisibleAgentProposals(); }
        return;
      }
      const lower = e.key.toLowerCase();
      if (viewRef.current === "gallery") return;
      if (lower === "g") { setLeftTab(null); setView("gallery"); return; }
      if (lower === "b") {
        if (selectedId) {
          e.preventDefault();
          openBoqForShape(selectedId);
          return;
        } else {
          e.preventDefault();
          setShowBoq((v) => !v);
          return;
        }
      }
      if (e.shiftKey && SHIFT_LETTER_TO_TOOL[e.key]) { e.preventDefault(); setTool(SHIFT_LETTER_TO_TOOL[e.key]); return; }
      if (lower === "h" || lower === "p") { e.preventDefault(); setTool("pan"); return; }
      if (lower === "v") { e.preventDefault(); setTool("select"); return; }
      const t = LETTER_TO_TOOL[lower];
      if (t) { e.preventDefault(); setTool(t); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, poly, proposal, agentProposals, activeCond, sheetGroup, sheetKey, shapes, scales, selectedId]);
  // ^ shapes/scales joined the deps with the agent accept path (the delete-handler
  //   precedent): ⏎ accept dispatches an `add` against the CURRENT array, so a
  //   shapes change with no other dep change must re-subscribe this handler.

  // remember the last armed measure tool — the Measure menu face shows it
  useEffect(() => { if (MEASURE_TOOLS.some((t) => t.id === tool)) lastMeasureRef.current = tool; }, [tool]);
  useEffect(() => { if (CUT_TOOLS.some((t) => t.id === tool)) lastCutRef.current = tool; }, [tool]);
  useEffect(() => { if (MARKUP_IDS.includes(tool)) lastMarkupRef.current = tool; }, [tool]);
  const hideCrosshair = useCallback(() => {
    for (const ref of [crossVRef, crossHRef, rubberRef, rectRef, cloudRef, highlightRef, snapMarkRef, aimMarkRef, aimChipRef]) if (ref.current) ref.current.style.display = "none";
    if (hlRef.current == null && hlPathRef.current) hlPathRef.current.style.display = "none";
    if (hoverRef.current) hoverRef.current.style.display = "none";
    hoverIdRef.current = "";
    if (!shapeBoqFocus && !shapeBoqHoverStickyRef.current) setShapeBoqHover(null);
    angleRef.current = null;
    if (containerRef.current && !spaceRef.current && !panRef.current) containerRef.current.style.cursor = "";
  }, [shapeBoqFocus]);

  // Number keys 1–9 switch the active condition (material) fast — through
  // activateCondition with reassign:false: a digit press has no visual
  // reassign affordance (unlike the panel row / strip button), so it must
  // never silently move a selected shape's quantities. It still dismisses a
  // live bulk selection, same as every activation surface. When the palette is
  // curated the digits follow PALETTE ORDER (the cobalt badges on the chips);
  // an un-pinned workspace falls back to condition-array order, so the shortcut
  // works out of the box before anyone pins anything.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;   // let ⌘/Ctrl+1..9 (native tab switch) through — mirror the letter handler
      if (menuDepthRef.current > 0) return;              // a toolbar menu is open; digits are paused like the letter shortcuts
      const n = parseInt(e.key, 10);
      if (n < 1 || n > 9) return;
      const id = palette.length ? palette[n - 1] : conditions[n - 1]?.id;
      if (id) activateCondition(id, { reassign: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conditions, palette, tool, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Undo a wrong click: Backspace/Delete (or Cmd/Ctrl+Z) removes the last placed
  // point; Escape cancels the whole in-progress shape.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target.tagName;
      if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA") return;
      if (viewRef.current === "gallery") return;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        if (poly.length) { setPoly((q) => q.slice(0, -1)); }
        else if (ocSel && proposal) { deleteSelectedOcVertex(); }
        else if (proposal?.regions.length) { setProposal((pr) => { const rg = pr.regions.slice(0, -1); return rg.length ? { ...pr, regions: rg } : null; }); }
        else if (selVert != null && selectedId) { deleteSelectedShapeVertex(); }
        else if (selectedCutoutIds.size > 1 || selectedId) { deleteSelected(); }
        else if (selectedMarkupId && showMarkups) { deleteMarkup(selectedMarkupId); setSelectedMarkupId(null); }
        // pop ONLY the armed tool's pending points — calibrate and check both
        // keep two-click state (calib points even render while another tool is
        // armed), and an unguarded pop used to silently cross-slice the other
        // tool's points, on-screen or hidden
        else if (tool === "calibrate") { setCalib((c) => c.slice(0, -1)); }
        else if (tool === "check") { setCheck((c) => c.slice(0, -1)); }
      } else if (e.key === "Escape") { e.preventDefault(); if (showHlPopover) { setShowHlPopover(false); return; } setWallCutoutFocus(null); if (wallCutoutFocusTimerRef.current) { clearTimeout(wallCutoutFocusTimerRef.current); wallCutoutFocusTimerRef.current = null; } if (overlapPrompt) { resolveOverlapPrompt("cancel"); } else if (wallCutoutDraftRef.current) { setWallCutoutDraft(null); if (rubberRef.current) rubberRef.current.style.display = "none"; setCommitMsg("Custom cutout cancelled."); } else if (shapeCtxMenuRef.current) { setShapeCtxMenu(null); } else if (agentOfferFnsRef.current?.pending()) { agentOfferFnsRef.current.dismiss(); } else if (symbolSourceViewRef.current) { setSymbolSourceView(null); } else if (symbolFocus) { setSymbolFocus(null); } else if (tool === "oneclick" && ocSel) { setOcSel(null); } else if (tool === "select" && selVert != null) { setSelVert(null); setSelHole(null); } else { hideCrosshair(); setPoly([]); setCalib([]); setCheck([]); setCheckStated(""); setScaleGuide(null); selectShape(null); setSelectedCutoutIds(new Set()); setMarkupDraft(null); setProposal(null); setWallProposal(null); setArmedStamp(null); setScheduleAnchor(null); resetZone(); hlRef.current = null; if (hlPathRef.current) hlPathRef.current.style.display = "none"; setTool("select"); } }
      // ⌘Z: the drawing context wins — mid-trace it still pops the last placed
      // point (with or without ⇧, matching the old behavior byte-for-byte);
      // only with no trace in progress does the command stack engage
      // (⌘Z = undo, ⇧⌘Z = redo).
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (poly.length) setPoly((q) => q.slice(0, -1));
        else if (e.shiftKey) redoShapeCommand();
        else undoShapeCommand();
      }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") { if (selectedId) { e.preventDefault(); copySelected(); } }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") { if (clipRef.current.length) { e.preventDefault(); pasteClipboard(); } }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { if (selectedId) { e.preventDefault(); duplicateSelected(); } }
      else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "g") { e.preventDefault(); groupLayerSelection(); }
      else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "u") { e.preventDefault(); ungroupLayerSelection(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, selectedId, selVert, selectedMarkupId, showMarkups, poly, proposal, ocSel, shapes, sheetKey, groupSig, scales, focusKey, overlapPrompt, layerPickIds, layerForest]); // eslint-disable-line react-hooks/exhaustive-deps

  // The typed "drawing says" value belongs to ONE completed two-point check.
  // The moment the measurement is no longer complete — third-click restart,
  // Backspace below two points — the stale value must not grade the NEXT span:
  // it would render an instant confident verdict against the previous
  // dimension's number and leave "Recalibrate to this" armed with it.
  useEffect(() => { if (check.length < 2 && checkStated) setCheckStated(""); }, [check.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the check tool discards the whole check: rendering is gated on
  // tool === "check", so surviving state would sit invisible and resurface —
  // stale points AND stale stated value — whenever K is pressed again.
  useEffect(() => { if (tool !== "check" && (check.length || checkStated)) { setCheck([]); setCheckStated(""); } }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the zone tool clears the zone the same way — the outline and its
  // readout are a reading of the armed tool, never surviving state. The
  // in-progress trace itself must go too: `poly` is the SAME shared array
  // area/deduct/linear/surface commit from, so without this, a mid-trace
  // switch away from zone (a single-letter shortcut while zone has none of
  // its own, or the Zone button re-arming "select") leaves real zone points
  // sitting in `poly` for the NEXT tool's Enter/double-click to commit as a
  // persisted, priced shape — the ephemeral tool's own "nothing is saved"
  // contract broken. Only clear `poly` when the PREVIOUS tool was zone
  // (prevToolRef), not on every tool change — poly is shared, and switching
  // e.g. area → linear must not discard a legitimate in-progress trace.
  useEffect(() => {
    if (tool !== "zone") resetZone();
    if (prevToolRef.current === "zone" && tool !== "zone") setPoly([]);
    prevToolRef.current = tool;
  }, [tool]);
  // Draw-mode hairlines live on DOM refs, not React state — leaving Area / One-Click
  // / etc. (Esc, V, the Select button) must hide them immediately or they freeze
  // on the last pointer position with cursor:none still set.
  useEffect(() => {
    if (tool !== "select" && tool !== "pan") return;
    hideCrosshair();
  }, [tool, hideCrosshair]);

  function canFinishCurrentDraw() {
    return canFinishDraw(tool, poly.length, { zoneCross: zoneTraceCross });
  }
  /** Right-click while drawing: finish & save when valid, else cancel preview — tool stays armed. */
  function stopDrawOnRightClick() {
    const polyDraw = tool === "area" || tool === "deduct" || tool === "deduct-curve" || tool === "wallarea" || tool === "linear" || tool === "curve" || tool === "surface" || tool === "zone";
    if (polyDraw && poly.length > 0) {
      if (canFinishCurrentDraw()) finishShape();
      else setPoly([]);
      if (rubberRef.current) rubberRef.current.style.display = "none";
      pendingClickRef.current = null;
      return true;
    }
    if ((tool === "rect" || tool === "deduct-rect") && poly.length > 0) {
      setPoly([]);
      if (rectRef.current) rectRef.current.style.display = "none";
      pendingClickRef.current = null;
      return true;
    }
    return false;
  }

  // ── pointer ────────────────────────────────────────────────────────────────
  function onPointerDown(e) {
    if (status !== "ready") return;
    // inline editor open: the blur that follows this click commits it; swallow the
    // canvas interaction so pan/zoom stays frozen and no stray point is placed
    if (editingRef.current) return;
    if (e.button === 2 && stopDrawOnRightClick()) {
      e.preventDefault();
      return;
    }
    // Pan WITHOUT leaving the draw tool: middle-drag, right-drag, Space-drag, or Pan tool.
    if (tool === "pan" || e.button === 1 || e.button === 2 || spaceRef.current) {
      panRef.current = { sx: e.clientX, sy: e.clientY, ox: tfRef.current.x, oy: tfRef.current.y };
      e.currentTarget.setPointerCapture(e.pointerId);
      if (containerRef.current) containerRef.current.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;   // only left-click places points
    // snapRef/angleRef are drawing-tool aids maintained by moveCrosshair, which
    // bails for the Select tool (:1577) — so in Select they'd be STALE. Select
    // does its own endpoint snap (ocSnap) on drop, so it always uses the raw
    // cursor here; otherwise a stale ref freezes the drag or jumps it on grab.
    // schedule (marquee) wants the raw cursor like select — snapping a corner to
    // a vector vertex would shift the box off the schedule and misread the region
    const rawCursor = tool === "select" || tool === "schedule";
    const p = (!rawCursor && snapOn && snapRef.current) ? snapRef.current
      : (!rawCursor && (tool === "deduct" || tool === "deduct-curve") && snapRef.current) ? snapRef.current
      : (!rawCursor && angleOn && angleRef.current) ? angleRef.current
        : toImage(e.clientX, e.clientY);
    const fp = panelAt(p[0]);
    if (fp.key !== focusKey) setFocusKey(fp.key);
    if (tool === "highlighter") {
      // ink is freehand: raw coords (no snap/angle), drag paints — press-drag pan is
      // intentionally unavailable while armed (space/middle/right-drag still pan)
      const raw = toImage(e.clientX, e.clientY);
      hlRef.current = { pts: [raw], key: panelAt(raw[0]).key };
      if (hlPathRef.current) {
        const el = hlPathRef.current;
        const w = hlStyle.size / tfRef.current.scale;
        el.setAttribute("d", "");
        if (hlStyle.tip === "chisel") { el.setAttribute("fill", hlStyle.color); el.setAttribute("fill-opacity", darkModeRef.current ? 0.42 : 0.32); el.setAttribute("stroke", "none"); }
        else { el.setAttribute("fill", "none"); el.setAttribute("stroke", hlStyle.color); el.setAttribute("stroke-opacity", darkModeRef.current ? 0.42 : 0.32); el.setAttribute("stroke-width", w); el.setAttribute("stroke-linecap", "round"); el.setAttribute("stroke-linejoin", "round"); }
        el.style.display = "block";
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === "select") {
      // Linear custom cutout on wall_area — two clicks snapped to that perimeter only.
      if (wallCutoutDraftRef.current) {
        const draft = wallCutoutDraftRef.current;
        const snapped = snapPointToWallAreaLine(draft.shapeId, p[0], p[1]);
        if (!snapped) {
          setCommitMsg("Snap to the wall area line — custom cutouts only land on that line.");
          return;
        }
        pendingClickRef.current = { p: snapped, cx: e.clientX, cy: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      selectAt(p, e); return;
    }
    // One-Click proposal handles: a press on a corner/edge grip starts an EDIT drag
    // (select+move a vertex, move a whole edge, or Shift-click to insert a point) —
    // it must win here, before the deferred add-a-region click below.
    if (tool === "oneclick" && proposal && oneClickHandleAt(e)) return;
    // every point-placing tool DEFERS to pointer-up: hold-and-drag (mouse left
    // or one-finger trackpad press) pans mid-measurement instead of placing
    pendingClickRef.current = { p, cx: e.clientX, cy: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  // the deferred click — runs on pointer-up when the press didn't become a pan
  function performClick(p, ev) {
    if (scaleGuide) setScaleGuide(null);
    if (wallCutoutDraftRef.current) {
      const draft = wallCutoutDraftRef.current;
      const snapped = snapPointToWallAreaLine(draft.shapeId, p[0], p[1]) || p;
      if (!draft.a) {
        setWallCutoutDraft({ shapeId: draft.shapeId, a: snapped });
        setCommitMsg("Custom cutout — click the second point on the wall area line.");
      } else {
        commitWallCutoutLinear(draft.shapeId, draft.a, snapped);
      }
      return;
    }
    if (tool === "calibrate") setCalib((c) => (c.length >= 2 ? [p] : [...c, p]));
    else if (tool === "check") setCheck((c) => (c.length >= 2 ? [p] : [...c, p]));
    else if (tool === "oneclick") oneClickAt(p, !!(ev && ev.altKey));
    else if (tool === "walltrace") wallTraceAt(p);
    else if (tool === "area" || tool === "deduct" || tool === "deduct-curve" || tool === "wallarea" || tool === "linear" || tool === "curve" || tool === "surface" || tool === "zone") {
      // Join the end — click near the first vertex to close & commit (autosaves via shapes).
      if ((tool === "area" || tool === "deduct" || tool === "wallarea") && poly.length >= 3) {
        const thr = (tool === "area" || tool === "wallarea" ? 18 : 12) / tfRef.current.scale;
        if (Math.hypot(p[0] - poly[0][0], p[1] - poly[0][1]) < thr) {
          if (tool === "wallarea") wallAreaLoopCloseRef.current = true;
          finishShape();
          return;
        }
      }
      let pt = p;
      if (tool === "deduct" || tool === "deduct-curve") {
        const wallSnap = snapDeductToWallLine(p[0], p[1]);
        if (wallSnap) pt = wallSnap;
      } else if ((tool === "wallarea" || tool === "surface") && activeCond) {
        const tp = panelAt(p[0]);
        const joinThr = tool === "wallarea" ? (12 / tfRef.current.scale) : undefined;
        const epOnly = tool === "wallarea";
        const hit = snapPointToSurfaceEndpoints(tp.key, activeCond, null, p[0] - tp.xOffset, p[1], joinThr, epOnly);
        if (hit) pt = [hit[0] + tp.xOffset, hit[1]];
      }
      setPoly((q) => [...q, pt]);
    }
    else if (tool === "count") commitCount(p);
    else if (tool === "rect" || tool === "deduct-rect") {
      if (poly.length === 0) setPoly([p]);
      else { const a = poly[0]; commitPoly([[a[0], a[1]], [p[0], a[1]], [p[0], p[1]], [a[0], p[1]]], tool === "deduct-rect"); setPoly([]); }
    }
    else if (tool === "schedule") {
      // two-click marquee, isolated state: first click drops the anchor, second reads the box
      if (!scheduleAnchor) setScheduleAnchor(p);
      else { importScheduleFromRect(scheduleAnchor, p); setScheduleAnchor(null); setTool("select"); }
    }
    else if (tool === "cloud" || tool === "callout" || tool === "text" || tool === "highlight") placeMarkup(p);
    else if (tool === "stamp") placeStamp(p);
  }
  // Markups carry no verts_norm (cloud rect / callout at+target / text at), so
  // hitShape can't test them — this is a purpose-built bbox/point test in the
  // markup's OWN panel frame. p is stage px. Labels are screen-constant, so their
  // extent divides by the current scale.
  function hitMarkup(m, p, thr) {
    const sp = panelByKey(m.sheet_id);
    if (!sp || !sp.img.w) return false;
    const W = sp.img.w, H = sp.img.h, ox = sp.xOffset;
    const X = p[0], Y = p[1], sc = tfRef.current.scale;
    if (m.type === "cloud" && m.rect) {
      const [[a0, b0], [a1, b1]] = m.rect;
      const x0 = Math.min(a0, a1) * W + ox, x1 = Math.max(a0, a1) * W + ox;
      const y0 = Math.min(b0, b1) * H, y1 = Math.max(b0, b1) * H;
      // a cloud renders hollow (fill="none"), so hit only its border band — a shape
      // (or vertex) enclosed by the cloud must stay clickable through the interior.
      const inX = X >= x0 - thr && X <= x1 + thr, inY = Y >= y0 - thr && Y <= y1 + thr;
      const onV = inX && (Math.abs(Y - y0) <= thr || Math.abs(Y - y1) <= thr);
      const onH = inY && (Math.abs(X - x0) <= thr || Math.abs(X - x1) <= thr);
      return onV || onH;
    }
    if (m.type === "callout" && m.at) {
      const ax = m.at[0] * W + ox, ay = m.at[1] * H;
      const lw = ((m.text?.length || 1) * 7 + 14) / sc;
      if (X >= ax - thr && X <= ax + lw && Y >= ay - 18 / sc - thr && Y <= ay + thr) return true;
      if (m.target) {
        const tx = m.target[0] * W + ox, ty = m.target[1] * H;
        if (Math.hypot(X - tx, Y - ty) < thr * 2) return true;
        if (distToSeg(X, Y, tx, ty, ax, ay) < thr) return true;
      }
      return false;
    }
    if (m.type === "text" && m.at) {
      const ax = m.at[0] * W + ox, ay = m.at[1] * H;
      const lw = ((m.text?.length || 1) * 7 + 14) / sc;
      return X >= ax - thr && X <= ax + lw && Y >= ay - 16 / sc - thr && Y <= ay + thr;
    }
    if (m.type === "highlight" && Array.isArray(m.pts)) {
      // a freehand highlighter stroke — hit the ink band itself (reach = half the
      // stroke width, floored at the shared threshold), never a bounding box, so a
      // stroke over a room shields only what it actually covers.
      if (m.pts.length < 2) return false;
      const w = (m.w || 0.01) * W;
      const reach = Math.max(w / 2, thr);
      const ip = m.pts.map(([nx, ny]) => [nx * W + ox, ny * H]);
      for (let i = 1; i < ip.length; i++) if (distToSeg(X, Y, ip[i - 1][0], ip[i - 1][1], ip[i][0], ip[i][1]) < reach) return true;
      return false;
    }
    if (m.type === "highlight" && m.rect) {
      // a highlight is FILLED and meant to be grabbed — hit its interior (with a
      // small margin) so it selects; precedence in selectAt keeps other markups
      // under it clickable.
      const [[a0, b0], [a1, b1]] = m.rect;
      const x0 = Math.min(a0, a1) * W + ox, x1 = Math.max(a0, a1) * W + ox;
      const y0 = Math.min(b0, b1) * H, y1 = Math.max(b0, b1) * H;
      return X >= x0 - thr && X <= x1 + thr && Y >= y0 - thr && Y <= y1 + thr;
    }
    if (m.type === "arrow" && m.from && m.to) {
      // a stamp-placed leader — hit its shaft (endpoint tolerance folds into the band)
      const fx = m.from[0] * W + ox, fy = m.from[1] * H, tx = m.to[0] * W + ox, ty = m.to[1] * H;
      return distToSeg(X, Y, fx, fy, tx, ty) < thr * 1.5;
    }
    if (m.type === "bubble" && m.at) {
      // a filled circle — hit its disc; r is normalized to sheet WIDTH
      const cx = m.at[0] * W + ox, cy = m.at[1] * H, rad = (Number(m.r) > 0 ? Number(m.r) : 0.02) * W;
      return Math.hypot(X - cx, Y - cy) < rad + thr;
    }
    if (m.type === "svg" && m.at && Array.isArray(m.vb)) {
      // a vector symbol — hit its placed bbox (same uniform scale off the LONGER
      // viewBox extent the renderer uses, so hit size == render size).
      const { bw, bh } = svgPlacedBox(m.vb, m.w, W);
      const cx = m.at[0] * W + ox, cy = m.at[1] * H;
      return X >= cx - bw / 2 - thr && X <= cx + bw / 2 + thr && Y >= cy - bh / 2 - thr && Y <= cy + bh / 2 + thr;
    }
    return false;
  }
  // Select tool: pick a shape (or a vertex of the selected one) and start dragging
  // it. Every shape hit-tests in ITS panel's local frame (stage x minus xOffset).
  function selectAt(p, e) {
    const thr = 8 / tfRef.current.scale;
    // Auto-Takeoff: only revealed masks are selectable/editable (unrevealed stay
    // invisible and must not steal hits or commit geometry).
    let sel = selectedId ? shapes.find((s) => s.id === selectedId) : null;
    if (sel && !aiDetectShapeRevealed(sel)) { selectShape(null); sel = null; }
    const selSp = sel && panelKeySet.has(sel.sheet_id) ? panelByKey(sel.sheet_id) : null;
    setSelVert(null); setSelHole(null);   // default: this press clears the vertex pick (overridden below on a corner/insert hit)
    // 1. Handles of the ALREADY-selected shape win first, so a shape (or vertex)
    //    enclosed by a markup — e.g. a revision cloud drawn around a room — stays
    //    editable rather than being shielded by the markup's hit area. Same edit
    //    model as One-Click proposals: click a corner to select it (Delete removes
    //    just it), drag a corner to move it, drag an edge grip to move the whole
    //    line (both endpoints), Shift-click an edge to insert a new anchor point.
    if (sel && selSp && sel.measure_role !== "count" && !shapeIsLocked(selectedId)) {
      const closed = sel.measure_role !== "linear" && sel.measure_role !== "surface_area";
      // trim-hole grips first — interior removal rings are editable polygons too
      if (closed && sel.holes_norm?.length) {
        for (let hi = sel.holes_norm.length - 1; hi >= 0; hi--) {
          const hpts = sel.holes_norm[hi].map(([nx, ny]) => [nx * selSp.img.w + selSp.xOffset, ny * selSp.img.h]);
          for (let i = 0; i < hpts.length; i++) {
            if (Math.hypot(hpts[i][0] - p[0], hpts[i][1] - p[1]) < thr * 1.6) {
              setSelHole(hi);
              setSelVert(i);
              dragRef.current = { kind: "holeVertex", shapeId: selectedId, holeIndex: hi, vIndex: i, prev: geomSnapshot(sel), shape: sel, gx: e.clientX, gy: e.clientY };
              e.currentTarget.setPointerCapture(e.pointerId); return;
            }
          }
          for (let i = 0; i < hpts.length; i++) {
            const j = (i + 1) % hpts.length;
            const a = hpts[i], b = hpts[j];
            if (Math.hypot((a[0] + b[0]) / 2 - p[0], (a[1] + b[1]) / 2 - p[1]) < thr * 1.4) {
              dragRef.current = {
                kind: "holeEdge", shapeId: selectedId, holeIndex: hi, i, j,
                oaN: [...sel.holes_norm[hi][i]], obN: [...sel.holes_norm[hi][j]], start: p,
                prev: geomSnapshot(sel), shape: sel, gx: e.clientX, gy: e.clientY,
              };
              e.currentTarget.setPointerCapture(e.pointerId); return;
            }
          }
        }
      }
      const pts = sel.verts_norm.map(([nx, ny]) => [nx * selSp.img.w + selSp.xOffset, ny * selSp.img.h]);
      for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]) < thr * 1.6) {
          setSelHole(null);
          setSelVert(i);   // select this corner + arm its move drag
          setWallSegmentFocus(wallSegmentIndexFromVert(sel, i));
          // prev = the grab-time snapshot the commit-on-release geom command
          // stamps/freezes from; gx/gy only gate the live PREVIEW now (the
          // zero-motion no-stamp guard is structural: no motion ⇒ no command)
          dragRef.current = { kind: "vertex", shapeId: selectedId, vIndex: i, prev: geomSnapshot(sel), shape: sel, gx: e.clientX, gy: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId); return;
        }
      }
      // edge grips: drag moves the WHOLE line (both endpoints); Shift-click drops a
      // new anchor point there and drags it out in the same gesture.
      const edges = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < edges; i++) {
        const j = (i + 1) % pts.length;
        const a = pts[i], b = pts[j];
        if (Math.hypot((a[0] + b[0]) / 2 - p[0], (a[1] + b[1]) / 2 - p[1]) < thr * 1.4) {
          if (e.shiftKey) {
            // insert at the EXACT edge midpoint (like One-Click's oneClickHandleAt),
            // not the click point — click imprecision can't kink the edge before drag.
            // The insertion itself is gesture-start LIVE state, not a command
            // (a collinear midpoint changes no quantity and never stamped) —
            // `prev` snapshots the POST-insert shape, so a zero-motion ⇧-click
            // still leaves the unstamped anchor behind exactly as before,
            // while any drag commits ONE stamped geom command on release.
            const va = sel.verts_norm[i], vb = sel.verts_norm[j];
            const nv = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2];
            const vnIns = [...sel.verts_norm.slice(0, i + 1), nv, ...sel.verts_norm.slice(i + 1)];
            const inserted = { ...sel, verts_norm: vnIns, computed: recomputeShape({ ...sel, verts_norm: vnIns }) };
            setShapes((ss) => ss.map((s) => (s.id === sel.id ? inserted : s)));
            setSelVert(i + 1);
            setWallSegmentFocus(i);
            dragRef.current = { kind: "vertex", shapeId: selectedId, vIndex: i + 1, prev: geomSnapshot(inserted), shape: inserted, gx: e.clientX, gy: e.clientY };
          } else {
            dragRef.current = { kind: "edge", shapeId: selectedId, i, j, oaN: [...sel.verts_norm[i]], obN: [...sel.verts_norm[j]], start: p, prev: geomSnapshot(sel), shape: sel, gx: e.clientX, gy: e.clientY };
          }
          e.currentTarget.setPointerCapture(e.pointerId); return;
        }
      }
    }
    // 2. markups render ON TOP of shapes (:2137 > :2093), so a markup hit wins over a
    //    plain shape click — but NOT over the selected shape's handles above.
    //    When the markup layer is hidden (showMarkups false), skip the search
    //    entirely — you can't select/delete/fly-to an invisible markup.
    if (showMarkups) {
      const rev = [...visibleMarkups].reverse();
      // a NON-highlight markup hit beats a highlight at the same point (test
      // highlights last), so a linked cloud/callout under a highlight stays
      // clickable; a highlight still wins over a plain shape (it shields it).
      const mHit = rev.find((m) => m.type !== "highlight" && hitMarkup(m, p, thr))
                || rev.find((m) => m.type === "highlight" && hitMarkup(m, p, thr));
      if (mHit) {
        selectMarkup(mHit.id);
        // arm a move drag — snapshot the markup's current normalized coords (all four
        // shapes: cloud/highlight rect, callout at+target, text at). The move stays a
        // no-op until it passes the threshold in onPointerMove, so a pure click (or the
        // first click of a double-click re-edit) never nudges the markup.
        const orig = (mHit.type === "highlight" && Array.isArray(mHit.pts)) ? { pts: mHit.pts.map((v) => [...v]) }
          : (mHit.type === "cloud" || mHit.type === "highlight") ? { rect: mHit.rect }
          : mHit.type === "callout" ? { at: mHit.at, target: mHit.target }
            : mHit.type === "arrow" ? { from: mHit.from, to: mHit.to }
              : { at: mHit.at };   // text + bubble
        // raw start (markups don't snap/angle-lock; matches the raw tracking point in
        // onPointerMove so the delta can't be contaminated by a stale snap/angle ref)
        dragRef.current = { kind: "markupMove", markupId: mHit.id, sheetId: mHit.sheet_id, start: toImage(e.clientX, e.clientY), orig, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }
    // 3. move the selected shape (or any grouped member) if its body was hit
    if (sel && selSp && !(e.shiftKey || e.ctrlKey || e.metaKey)) {
      const memberIds = moveIdsFor(selectedId);
      const lockedMove = memberIds.some((id) => shapeIsLocked(id));
      for (const mid of memberIds) {
        const msh = mid === selectedId ? sel : shapes.find((s) => s.id === mid);
        const msp = msh && panelKeySet.has(msh.sheet_id) ? panelByKey(msh.sheet_id) : null;
        if (msh && msp && hitShapeC(msh, p[0] - msp.xOffset, p[1], msp.img.w, msp.img.h, thr)) {
          if (lockedMove) return;
          if (memberIds.length > 1) armGroupMoveDrag(msh, p, e, memberIds);
          else dragRef.current = { kind: "move", shapeId: selectedId, start: p, orig: sel.verts_norm, prev: geomSnapshot(sel), shape: sel, gx: e.clientX, gy: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId); return;
        }
      }
    }
    // 4. otherwise pick a shape (or clear the selection)
    // Prefer deduct cutouts (drawn on top) so multi-select / edit hits the overlay first.
    const hit = [...visibleShapes].slice().sort((a, b) => {
      const ad = a.measure_role === "deduct" ? 1 : 0, bd = b.measure_role === "deduct" ? 1 : 0;
      return ad - bd;
    }).reverse().find((s) => {
      if (!aiDetectShapeRevealed(s) || isHiddenId(s.id, { hiddenShapeIds, sheetId: s.sheet_id })) return false;
      const sp = panelByKey(s.sheet_id);
      return hitShapeC(s, p[0] - sp.xOffset, p[1], sp.img.w, sp.img.h, thr);
    });
    if (hit?.measure_role === "deduct" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      setSelectedCutoutIds((prev) => {
        const next = new Set(prev);
        if (next.has(hit.id)) next.delete(hit.id); else next.add(hit.id);
        return next;
      });
      setSelectedId(hit.id); setSelectedMarkupId(null); setSelHole(null); setSelVert(null);
      setLayerPickIds(picksForPrimarySelect(hit.id, layerPickIds));
      setShapeCtxMenu(null);
      revealSheetInFilesSidebar(hit.sheet_id);
      return;
    }
    // Wall area lines — join at endpoints: drag an endpoint onto another run, or click
    // another run while an endpoint is selected; nearby endpoints auto-join on click.
    if (hit?.measure_role === "surface_area" && selectedId && selectedId !== hit.id
      && !shapeIsLocked(selectedId) && !shapeIsLocked(hit.id)) {
      const cur = shapesRef.current.find((s) => s.id === selectedId);
      if (cur?.measure_role === "surface_area"
        && cur.sheet_id === hit.sheet_id
        && cur.condition_id === hit.condition_id) {
        const last = cur.verts_norm.length - 1;
        const endpointSelected = selVert === 0 || selVert === last;
        const shouldJoin = endpointSelected || surfaceEndpointJoin(selectedId, hit.id);
        if (shouldJoin) {
          dragRef.current = null;
          setSelVert(null);
          setSelHole(null);
          joinSurfaceRuns(selectedId, hit.id);
          revealSheetInFilesSidebar(hit.sheet_id);
          return;
        }
      }
    }
    if (hit && tool === "select" && (e.shiftKey || e.ctrlKey || e.metaKey)
        && hit.measure_role !== "deduct") {
      const live = shapesRef.current;
      const cur = Object.keys(layerPickIds).filter((id) => live.some((s) => s.id === id));
      if (selectedId && live.some((s) => s.id === selectedId) && !cur.includes(selectedId)) cur.push(selectedId);
      const next = (e.ctrlKey || e.metaKey) && !e.shiftKey
        ? togglePickIds(cur, [hit.id])
        : [...new Set([...cur, hit.id])];
      const picks = Object.fromEntries(next.map((id) => [id, true]));
      setSelectedCutoutIds(new Set());
      if (next.length) {
        selectShape(next.includes(hit.id) ? hit.id : next[0], picks);
        revealSheetInFilesSidebar(hit.sheet_id);
      } else {
        selectShape(null);
      }
      return;
    }
    if (hit?.measure_role === "deduct") setSelectedCutoutIds(new Set([hit.id]));
    else setSelectedCutoutIds(new Set());
    selectShape(hit ? hit.id : null);
    if (hit) {
      setLayerPickFromShape(hit.id);
      revealSheetInFilesSidebar(hit.sheet_id);
      const el = containerRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        setShapeBoqHover({
          id: hit.id,
          cx: Math.min(e.clientX - r.left + 14, r.width - 260),
          cy: Math.min(e.clientY - r.top + 16, r.height - 220),
        });
      }
      const memberIds = moveIdsFor(hit.id);
      if (shapeIsLocked(hit.id) || memberIds.some((id) => shapeIsLocked(id))) return;
      if (memberIds.length > 1) armGroupMoveDrag(hit, p, e, memberIds);
      else dragRef.current = { kind: "move", shapeId: hit.id, start: p, orig: hit.verts_norm, prev: geomSnapshot(hit), shape: hit, gx: e.clientX, gy: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId); return;
    }
    // 4b. plan symbol (door/type mark) — pin the detail card for review / manual fill
    {
      const panel = panelAt(p[0]);
      if (panel?.img?.w) {
        const sym = hitPlanSymbol(planSymbols, panel.key, p[0] - panel.xOffset, p[1], 6 / tfRef.current.scale);
        if (sym) {
          const r = containerRef.current?.getBoundingClientRect();
          if (r) {
            setSymbolHover({
              id: sym.id,
              cx: Math.min(Math.max(12, e.clientX - r.left + 14), r.width - 280),
              cy: Math.min(Math.max(12, e.clientY - r.top + 16), r.height - 320),
            });
          }
          setSymbolFocus(sym.id);
          return;
        }
      }
      setSymbolFocus(null);
    }
    // 5. open canvas — Shift+drag draws a selection marquee; otherwise drag to pan.
    if (tool === "select" && e.shiftKey) {
      panRef.current = null;
      boxSelectRef.current = { start: p, sx: e.clientX, sy: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    boxSelectRef.current = { start: p, sx: e.clientX, sy: e.clientY };
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: tfRef.current.x, oy: tfRef.current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (containerRef.current) containerRef.current.style.cursor = "grabbing";
  }
  function holesEqual(a, b) {
    const ha = a || [], hb = b || [];
    if (ha.length !== hb.length) return false;
    for (let i = 0; i < ha.length; i++) if (!vertsEqual(ha[i], hb[i])) return false;
    return true;
  }
  // Delete just the selected corner (Delete/⌫), keeping a polygon ≥3 / a run ≥2.
  // At the floor we deselect so the NEXT ⌫ falls through to deleting the whole
  // shape — mirrors the One-Click proposal behavior.
  function deleteSelectedShapeVertex() {
    const sel = shapes.find((s) => s.id === selectedId);
    if (!sel || selVert == null || shapeIsLocked(selectedId)) { setSelVert(null); setSelHole(null); return; }
    const closed = sel.measure_role !== "linear" && sel.measure_role !== "surface_area";
    const min = closed ? 3 : 2;
    if (selHole != null && Array.isArray(sel.holes_norm) && sel.holes_norm[selHole]) {
      const ring = sel.holes_norm[selHole];
      if (selVert >= ring.length) { setSelVert(null); setSelHole(null); return; }
      let holes_norm = sel.holes_norm.map((h) => h.map((v) => [...v]));
      if (ring.length <= min) holes_norm = holes_norm.filter((_, i) => i !== selHole);
      else holes_norm[selHole] = ring.filter((_, j) => j !== selVert);
      dispatchShape({
        type: "geom", id: sel.id, editKind: "vertexDelete",
        verts_norm: sel.verts_norm, holes_norm,
        computed: recomputeShape({ ...sel, holes_norm }), prev: geomSnapshot(sel),
      });
      setSelVert(null); setSelHole(null);
      return;
    }
    if (selVert >= sel.verts_norm.length) { setSelVert(null); setSelHole(null); return; }   // stale index (shape changed under the selection) — never dispatch a no-op edit
    if (sel.verts_norm.length <= min) {
      setCommitMsg(closed ? "A shape needs at least 3 points — ⌫ again deletes the whole shape." : "A run needs at least 2 points — ⌫ again deletes the whole run.");
      setSelVert(null); setSelHole(null); return;
    }
    // dropping a corner is as real an edit as dragging one — the vertexDelete
    // command stamps "vertex" centrally, so a machine shape corrected only
    // this way can't read as a clean accept
    const vn = sel.verts_norm.filter((_, j) => j !== selVert);
    dispatchShape({
      type: "geom", id: sel.id, editKind: "vertexDelete",
      verts_norm: vn, computed: recomputeShape({ ...sel, verts_norm: vn }), prev: geomSnapshot(sel),
    });
    setSelVert(null); setSelHole(null);
  }
  // Geometry from the shape's OWN sheet: its panel's pixel dims × that sheet's
  // scale. This is what makes cross-sheet paste and group-mode edits honest.
  // uppOverride: pass the NEW effective upp when re-pricing right after a
  // setScales — `scales` in this render's closure is still the old map.
  function recomputeShape(s, uppOverride) {
    const sp = panelByKey(s.sheet_id);
    const pts = s.verts_norm.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
    const u = uppOverride ?? (uppFor(s.sheet_id) || 0);
    if (s.measure_role === "count") return { count: 1 };
    if (s.measure_role === "surface_area") {
      const condH = Number(condById[s.condition_id]?.height_ft) || 0;
      const segHs = segmentHeightsForShape(s, condH);
      const closedLoop = !!(s.origin?.closed_loop);
      const { perimeter_lf: LF, gross_face_sf, avg_height_ft } = grossFaceFromSegments(pts, segHs, u, closedLoop);
      const opening_sf = openingsDeductSfLinear(s.openings, LF, avg_height_ft);
      const area_sf = +Math.max(0, gross_face_sf - opening_sf).toFixed(2);
      return { area_sf, perimeter_lf: LF, gross_face_sf, opening_sf };
    }
    if (s.measure_role === "wall_area") {
      const h = s.height_override === true
        ? Number(s.height_ft) || 0
        : Number(s.height_ft) || Number(condById[s.condition_id]?.height_ft) || 0;
      const met = closedMetrics(pts);
      let areaPx = met.area;
      let perimPx = met.perim;
      if (Array.isArray(s.holes_norm) && s.holes_norm.length) {
        for (const hole of s.holes_norm) {
          const hp = hole.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
          areaPx -= ringArea(hp);
          perimPx += closedMetrics(hp).perim;
        }
        areaPx = Math.max(0, areaPx);
      }
      const footprint_sf = +(areaPx * u * u).toFixed(2);
      const perimeter_lf = +(perimPx * u).toFixed(2);
      const gross_face_sf = +(perimeter_lf * h).toFixed(2);
      const opening_sf = openingsDeductSf(s.openings);
      const wall_face_sf = netWallFaceSf(gross_face_sf, s.openings);
      const volume_cf = +(footprint_sf * h).toFixed(2);
      return {
        area_sf: wall_face_sf,
        footprint_sf,
        wall_face_sf,
        volume_cf,
        perimeter_lf,
        gross_face_sf,
        opening_sf,
      };
    }
    if (s.measure_role === "linear") {
      const LF = openLen(s.curved ? flattenCurve(pts) : pts) * u;
      const tIn = Number(condById[s.condition_id]?.thickness_in) || 0;
      return { perimeter_lf: +LF.toFixed(2), area_sf: tIn > 0 ? +((LF * tIn) / 12).toFixed(2) : 0 };
    }
    const met = closedMetrics(pts);
    let area = met.area;
    if (Array.isArray(s.holes_norm) && s.holes_norm.length) {
      for (const hole of s.holes_norm) {
        const hp = hole.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
        area -= ringArea(hp);
      }
      area = Math.max(0, area);
    }
    return { area_sf: +(area * u * u).toFixed(2), perimeter_lf: +(met.perim * u).toFixed(2) };
  }
  function moveCrosshair(e) {
    if (editingRef.current) return;   // inline editor open — no aim crosshair (ref check, never per-mousemove state)
    if (tool === "pan" || tool === "select" || status !== "ready" || !containerRef.current) return;
    // snap-to-vector: nearest PDF endpoint within threshold becomes the active
    // point — looked up in the hovered panel's grid, in that panel's local frame
    let cur = toImage(e.clientX, e.clientY);
    snapRef.current = null;
    if (snapMarkRef.current) snapMarkRef.current.style.display = "none";
    // Cut Out: sticky snap to wall area / wall run lines only (overrides PDF snap).
    if ((tool === "deduct" || tool === "deduct-curve") && !panRef.current) {
      const sc = tfRef.current.scale;
      const wallSnap = snapDeductToWallLine(cur[0], cur[1]);
      if (wallSnap) {
        snapRef.current = wallSnap;
        cur = wallSnap;
        if (snapMarkRef.current) {
          snapMarkRef.current.setAttribute("d", starPath(wallSnap[0], wallSnap[1], 5.5 / sc));
          snapMarkRef.current.style.display = "block";
        }
      }
    } else if (snapOn && !panRef.current && snapGridsRef.current.size) {
      const sc = tfRef.current.scale;
      const sp = panelAt(cur[0]);
      const grid = snapGridsRef.current.get(sp.key);
      // Wall Area: skip PDF corner magnet — join snap below uses its own tight thr.
      const snapThr = tool === "wallarea" ? (11 / sc) : tool === "area" ? (14 / sc) : (11 / sc);
      const hit = grid ? nearestSnap(grid, cur[0] - sp.xOffset, cur[1], snapThr) : null;
      if (hit) {
        const pt = [hit[0] + sp.xOffset, hit[1]];
        snapRef.current = pt; cur = pt;
        if (snapMarkRef.current) { snapMarkRef.current.setAttribute("d", starPath(pt[0], pt[1], 5.5 / sc)); snapMarkRef.current.style.display = "block"; }
      }
    }

    // rubber-band preview: last point → cur (area/deduct/zone); rect preview: corner → cur
    const drawing = (tool === "area" || tool === "deduct" || tool === "deduct-curve" || tool === "wallarea" || tool === "linear" || tool === "curve" || tool === "surface" || tool === "zone");
    if (!snapRef.current && (tool === "wallarea" || tool === "surface") && activeCond && drawing) {
      const sp = panelAt(cur[0]);
      const sc = tfRef.current.scale;
      // Wall Area only: ~2.5 screen-px join magnet (was max(18, 22/scale) — yanked to corners).
      const joinThr = tool === "wallarea" ? (12 / sc) : undefined;
      const epOnly = tool === "wallarea";
      const epSnap = snapPointToSurfaceEndpoints(sp.key, activeCond, null, cur[0] - sp.xOffset, cur[1], joinThr, epOnly);
      if (epSnap) cur = [epSnap[0] + sp.xOffset, epSnap[1]];
    }
    if (tool === "area" && poly.length >= 3) {
      const sc = tfRef.current.scale;
      const closeThr = 18 / sc;
      if (Math.hypot(cur[0] - poly[0][0], cur[1] - poly[0][1]) < closeThr) {
        cur = poly[0];
        snapRef.current = poly[0];
        if (snapMarkRef.current) {
          snapMarkRef.current.setAttribute("d", starPath(poly[0][0], poly[0][1], 5.5 / sc));
          snapMarkRef.current.style.display = "block";
        }
      }
    }
    if (tool === "wallarea" && poly.length >= 3) {
      const sc = tfRef.current.scale;
      const closeThr = 18 / sc;
      if (Math.hypot(cur[0] - poly[0][0], cur[1] - poly[0][1]) < closeThr) {
        cur = poly[0];
        snapRef.current = poly[0];
        if (snapMarkRef.current) {
          snapMarkRef.current.setAttribute("d", starPath(poly[0][0], poly[0][1], 5.5 / sc));
          snapMarkRef.current.style.display = "block";
        }
      }
    }

    // polar tracking: endpoint snap wins (osnap beats polar); otherwise pull the
    // rubber band onto the 45° family. ⇧ forces the lock at any angle. The click
    // path commits angleRef, so the placed vertex is exactly on-axis — not just
    // the preview. The lock reads as a QUIET state change (crosshair brightens,
    // rubber band thickens, chip shows the angle) — no extra chrome on the sheet.
    const anchor = (drawing && poly.length > 0) ? poly[poly.length - 1]
      : (tool === "calibrate" && calib.length === 1 ? calib[0]
      : (tool === "check" && check.length === 1 ? check[0] : null));
    angleRef.current = null;
    let lock = null;
    if (angleOn && anchor && !snapRef.current && !panRef.current) {
      const sc = tfRef.current.scale;
      if (Math.hypot(cur[0] - anchor[0], cur[1] - anchor[1]) >= 12 / sc)
        lock = angleSnap(anchor, cur, e.shiftKey);
      if (lock) { angleRef.current = lock.pt; cur = lock.pt; }
    }

    // the crosshair IS the cursor — re-assert cursor:none every move because the
    // pan/space handlers restore style.cursor to "" (computed auto) on release
    if (!panRef.current && !spaceRef.current && containerRef.current.style.cursor !== "none")
      containerRef.current.style.cursor = "none";

    // aim visuals ride the EFFECTIVE point (locked/snapped), not the raw mouse
    const t = tfRef.current;
    const ex = cur[0] * t.scale + t.x, ey = cur[1] * t.scale + t.y;
    const lockState = lock ? "1" : "";
    for (const [el, prop, val] of [[crossVRef.current, "left", ex], [crossHRef.current, "top", ey]]) {
      if (!el) continue;
      el.style[prop] = `${val}px`; el.style.display = "block";
      if (el.__lock !== lockState) {
        el.__lock = lockState;
        el.style.background = lock ? "var(--canvas-aim-lock)" : "var(--canvas-aim)";
        el.style.boxShadow = lock
          ? "var(--canvas-aim-shadow-lock)"
          : "var(--canvas-aim-shadow)";
      }
    }
    if (aimMarkRef.current) {
      const el = aimMarkRef.current;
      el.style.transform = `translate3d(${ex}px, ${ey}px, 0)`;
      if (el.__lock !== lockState) {
        el.__lock = lockState;
        const star = el.firstChild;
        if (star) {
          star.style.transform = lock ? "scale(1.3)" : "scale(1)";
          star.style.filter = lock ? "var(--canvas-aim-star-shadow-lock)" : "var(--canvas-aim-star-shadow)";
        }
      }
      el.style.display = "block";
    }
    if (aimChipRef.current) {
      const chip = aimChipRef.current;
      let txt = "", over = false;
      if (tool === "check" && check.length === 1) {
        // live length to the cursor while picking the second end of the dimension.
        // No CARPET_ROLL_FT amber here — a dimension string is not a seam plan.
        const u = uppFor(panelAt(check[0][0]).key);
        if (u) txt = fmtCheckLen(Math.hypot(cur[0] - check[0][0], cur[1] - check[0][1]) * u, units) + (lock ? ` · ${lock.deg}°` : "");
      } else if ((tool === "rect" || tool === "deduct-rect") && poly.length === 1 && liveUpp) {
        // rectangle: live W × H + area (SF and SY imperial — carpet is bought in SY)
        const a = poly[0];
        const w = Math.abs(cur[0] - a[0]) * liveUpp, h = Math.abs(cur[1] - a[1]) * liveUpp;
        const sf = w * h;
        txt = `${fmtCheckLen(w, units)} × ${fmtCheckLen(h, units)} · ${num(areaVal(sf, units))} ${areaUnit(units)}${units === "metric" ? "" : ` · ${num(sf / 9)} SY`}`;
        over = w >= CARPET_ROLL_FT - 0.02 || h >= CARPET_ROLL_FT - 0.02;
      } else if (drawing && anchor && liveUpp) {
        // line/polyline: live segment length, ALWAYS (not just under the 45° lock)
        const len = Math.hypot(cur[0] - anchor[0], cur[1] - anchor[1]) * liveUpp;
        txt = lock ? `${lock.deg}° · ${fmtCheckLen(len, units)}` : fmtCheckLen(len, units);
        over = len >= CARPET_ROLL_FT - 0.02;
      } else if (lock) {
        txt = `${lock.deg}°`;
      } else if (snapRef.current) txt = "snap";
      if (txt) {
        if (chip.__t !== txt) { chip.textContent = txt; chip.__t = txt; }
        // 12 ft roll-width cue — the chip goes amber when a run reaches roll width (a seam falls here)
        const os = over ? "1" : "";
        if (chip.__over !== os) {
          chip.__over = os;
          chip.style.background = over ? "var(--c-warning)" : "var(--canvas-chip-bg)";
          chip.style.color = over ? "var(--canvas-chip-warning-ink)" : "var(--canvas-chip-ink)";
          chip.style.borderColor = over ? "var(--c-warning)" : "var(--canvas-chip-border)";
        }
        chip.style.transform = `translate3d(${ex + 14}px, ${ey + 18}px, 0)`;
        chip.style.display = "block";
      } else chip.style.display = "none";
    }
    if (rubberRef.current) {
      if (!panRef.current && drawing && poly.length > 0) {
        const last = poly[poly.length - 1];
        rubberRef.current.setAttribute("x1", last[0]); rubberRef.current.setAttribute("y1", last[1]);
        rubberRef.current.setAttribute("x2", cur[0]); rubberRef.current.setAttribute("y2", cur[1]);
        rubberRef.current.setAttribute("stroke-width", lock ? 3 : 1.5);  // the lock reads in the band itself
        rubberRef.current.style.display = "block";
      } else rubberRef.current.style.display = "none";
    }
    if (rectRef.current) {
      const schedDraw = tool === "schedule" && scheduleAnchor;
      if (!panRef.current && ((tool === "rect" || tool === "deduct-rect") && poly.length === 1 || schedDraw)) {
        const a = schedDraw ? scheduleAnchor : poly[0];
        rectRef.current.setAttribute("x", Math.min(a[0], cur[0])); rectRef.current.setAttribute("y", Math.min(a[1], cur[1]));
        rectRef.current.setAttribute("width", Math.abs(cur[0] - a[0])); rectRef.current.setAttribute("height", Math.abs(cur[1] - a[1]));
        rectRef.current.style.display = "block";
      } else rectRef.current.style.display = "none";
    }
    // live cloud preview: first corner (markupDraft, stage px) → cursor
    if (cloudRef.current) {
      if (!panRef.current && tool === "cloud" && markupDraft) {
        cloudRef.current.setAttribute("d", cloudPath(markupDraft[0], markupDraft[1], cur[0], cur[1]));
        cloudRef.current.style.display = "block";
      } else cloudRef.current.style.display = "none";
    }
    // live highlight preview: a translucent box, first corner → cursor (its own
    // ref, NOT rectRef which carries the active condition fill)
    if (highlightRef.current) {
      if (!panRef.current && tool === "highlight" && markupDraft) {
        highlightRef.current.setAttribute("x", Math.min(markupDraft[0], cur[0]));
        highlightRef.current.setAttribute("y", Math.min(markupDraft[1], cur[1]));
        highlightRef.current.setAttribute("width", Math.abs(cur[0] - markupDraft[0]));
        highlightRef.current.setAttribute("height", Math.abs(cur[1] - markupDraft[1]));
        highlightRef.current.style.display = "block";
      } else highlightRef.current.style.display = "none";
    }
  }
  // Pointer left the canvas: hide the aim chrome AND kill the voice-deixis aim —
  // a pointer parked off-canvas must not leave a ghost seed for "this room".
  // (Other hideCrosshair callers — e.g. the inline editor — keep the aim: the
  // pointer is still parked on the sheet there.)
  function leaveCanvas() {
    hideCrosshair();
    voiceAimMarkRef.current = aimSeqRef.current;
  }
  function describeShape(s) {
    const tag = condById[s.condition_id]?.finish_tag || (s.isProposal ? "Proposal" : "?");
    const a = s.computed?.area_sf || 0, lf = s.computed?.perimeter_lf || 0;
    if (s.measure_role === "count") return `${tag} · ${num(s.computed?.count || 1, 0)} EA`;
    if (s.measure_role === "deduct") return `${tag} · −${fa(a)} deduct`;
    if (s.measure_role === "surface_area") {
      // same height semantics as recomputeShape: an override wins outright (even 0).
      // Heights stay feet in both systems — they're ENTERED in feet everywhere.
      const h = s.height_override === true
        ? Number(s.height_ft) || 0
        : Number(s.height_ft) || Number(condById[s.condition_id]?.height_ft) || 0;
      const opn = s.computed?.opening_sf || 0;
      return `${tag} · ${fa(a)} wall (${fl(lf)} × ${num(h, 2)}′${opn > 0 ? ` − ${fa(opn)} openings` : ""})`;
    }
    if (s.measure_role === "wall_area") {
      const h = s.height_override === true
        ? Number(s.height_ft) || 0
        : Number(s.height_ft) || Number(condById[s.condition_id]?.height_ft) || 0;
      const fp = s.computed?.footprint_sf || 0;
      const vol = s.computed?.volume_cf || 0;
      const opn = s.computed?.opening_sf || 0;
      return `${tag} · ${fa(a)} face${opn > 0 ? ` (− ${fa(opn)} openings)` : ""} · ${fa(fp)} footprint · ${num(vol, 1)} CF (${num(h, 2)}′)`;
    }
    if (s.measure_role === "linear") return `${tag} · ${fl(lf)}${a > 0 ? ` · ${fa(a)} border` : ""}`;
    return `${tag} · ${faSY(a)}`;
  }
  // STACK-style hover readout: small, follows the cursor, gone on hover-off.
  // Prefer a takeoff shape; otherwise a plan symbol (door/type mark) shows its card.
  function updateHover(e) {
    const el = hoverRef.current;
    if (!el) return;
    if (panRef.current || dragRef.current || pendingClickRef.current || status !== "ready" || symbolFocus || shapeBoqFocus) {
      el.style.display = "none"; hoverIdRef.current = "";
      if (!shapeBoqFocus && !shapeBoqHoverStickyRef.current) {
        const keepSelBoq = tool === "select" && selectedId
          && (dragRef.current?.shapeId === selectedId || shapeBoqHover?.id === selectedId);
        if (!keepSelBoq) setShapeBoqHover(null);
      }
      if (!symbolFocus) setSymbolHover(null);
      return;
    }
    const pt = toImage(e.clientX, e.clientY);
    const thr = 8 / tfRef.current.scale;
    let hit = [...visibleShapes].reverse().find((s) => {
      if (!aiDetectShapeRevealed(s)) return false;
      const sp = panelByKey(s.sheet_id);
      return hitShapeC(s, pt[0] - sp.xOffset, pt[1], sp.img.w, sp.img.h, thr);
    });
    if (!hit && proposal && proposal.regions && proposal.regions.length > 0) {
      const sp = panelByKey(proposal.key);
      if (sp && sp.img?.w) {
        const lx = pt[0] - sp.xOffset, ly = pt[1];
        const near = 14 / tfRef.current.scale;
        const hitReg = proposal.regions.find((r) => {
          if (pointInPoly(lx, ly, r.poly)) return true;
          for (let i = 0; i < r.poly.length; i++) {
            const a = r.poly[i], b = r.poly[(i + 1) % r.poly.length];
            const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
            if (Math.hypot(a[0] - lx, a[1] - ly) < near || Math.hypot(mx - lx, my - ly) < near || distToSeg(lx, ly, a[0], a[1], b[0], b[1]) < thr) return true;
          }
          return false;
        });
        if (hitReg) {
          hit = {
            id: "prop_" + proposal.key + "_" + proposal.regions.indexOf(hitReg),
            condition_id: activeCond,
            measure_role: hitReg.kind === "neg" ? "deduct" : "floor_area",
            computed: { area_sf: hitReg.area_sf || 0, perimeter_lf: hitReg.perim_lf || 0 },
            isProposal: true,
          };
        }
      }
    }
    if (!hit && agentProposals && agentProposals.length > 0) {
      const hitAp = [...agentProposals].reverse().find((ap) => {
        const sp = panelByKey(ap.sheet_id);
        if (!sp || !sp.img?.w) return false;
        const lx = pt[0] - sp.xOffset, ly = pt[1];
        const pts = (ap.verts_norm || []).map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
        if (pointInPoly(lx, ly, pts)) return true;
        for (let i = 0; i < pts.length; i++) {
          const j = (i + 1) % pts.length;
          if (distToSeg(lx, ly, pts[i][0], pts[i][1], pts[j][0], pts[j][1]) < thr) return true;
        }
        return false;
      });
      if (hitAp) {
        hit = {
          id: "ap_" + hitAp.id,
          condition_id: hitAp.condition_id,
          measure_role: hitAp.measure_role || "floor_area",
          computed: { area_sf: hitAp.area_sf || 0, perimeter_lf: hitAp.perimeter_lf || 0 },
          isProposal: true,
        };
      }
    }
    // Plan symbols win hover even under a takeoff fill — otherwise a created
    // area mask blocks the symbol card and double-click focus.
    {
      const panel = panelAt(pt[0]);
      if (panel?.img?.w) {
        const sym = hitPlanSymbol(planSymbols, panel.key, pt[0] - panel.xOffset, pt[1], 4 / tfRef.current.scale);
        if (sym) {
          el.style.display = "none"; hoverIdRef.current = "";
          if (!shapeBoqFocus && !shapeBoqHoverStickyRef.current) setShapeBoqHover(null);
          const r = containerRef.current.getBoundingClientRect();
          setSymbolHover({ id: sym.id, cx: e.clientX - r.left + 14, cy: e.clientY - r.top + 16 });
          return;
        }
      }
    }
    if (shapeBoqFocus) {
      el.style.display = "none"; hoverIdRef.current = "";
      return;
    }
    if (hit && selectedId === hit.id && !hit.isProposal) {
      setSymbolHover(null);
      const r = containerRef.current.getBoundingClientRect();
      if (!(isAiDetectFloorPlan(hit.sheet_id) && !aiDetectShapeRevealed(hit))) {
        const cx = Math.min(e.clientX - r.left + 14, r.width - 260);
        const cy = Math.min(e.clientY - r.top + 16, r.height - 220);
        setShapeBoqHover((prev) => (prev?.id === hit.id && prev?.cx === cx && prev?.cy === cy ? prev : { id: hit.id, cx, cy }));
      }
      return;
    }
    if (hit) {
      setSymbolHover(null);
      const r = containerRef.current.getBoundingClientRect();
      if (!hit.isProposal) {
        el.style.display = "none"; hoverIdRef.current = "";
        // A1105–A1109: hover only after that sheet's mask has been revealed.
        if (isAiDetectFloorPlan(hit.sheet_id) && !aiDetectShapeRevealed(hit)) {
          if (!shapeBoqFocus && !shapeBoqHoverStickyRef.current) setShapeBoqHover(null);
          return;
        }
        const cx = Math.min(e.clientX - r.left + 14, r.width - 260);
        const cy = Math.min(e.clientY - r.top + 16, r.height - 220);
        setShapeBoqHover((prev) => (prev?.id === hit.id && prev?.cx === cx && prev?.cy === cy ? prev : { id: hit.id, cx, cy }));
        return;
      }
      if (hoverIdRef.current !== hit.id) { el.textContent = describeShape(hit); hoverIdRef.current = hit.id; }
      el.style.left = `${e.clientX - r.left + 14}px`;
      el.style.top = `${e.clientY - r.top + 16}px`;
      el.style.display = "block";
      return;
    }
    el.style.display = "none"; hoverIdRef.current = "";
    if (!shapeBoqFocus && !shapeBoqHoverStickyRef.current) setShapeBoqHover(null);
    setSymbolHover(null);
  }
  function onPointerMove(e) {
    lastPtrRef.current = [e.clientX, e.clientY];   // paste targets the sheet under the cursor
    aimSeqRef.current++;                           // deixis freshness tick — see getAimSeed
    // Custom cutout draft — live snap + rubber band on the wall_area line only.
    if (wallCutoutDraftRef.current && !panRef.current) {
      let cur = toImage(e.clientX, e.clientY);
      const snapped = snapPointToWallAreaLine(wallCutoutDraftRef.current.shapeId, cur[0], cur[1]);
      if (snapped) cur = snapped;
      const sc = tfRef.current.scale;
      if (snapMarkRef.current) {
        if (snapped) {
          snapMarkRef.current.setAttribute("d", starPath(cur[0], cur[1], 5.5 / sc));
          snapMarkRef.current.style.display = "block";
        } else snapMarkRef.current.style.display = "none";
      }
      const a = wallCutoutDraftRef.current.a;
      if (a && rubberRef.current) {
        rubberRef.current.setAttribute("x1", a[0]);
        rubberRef.current.setAttribute("y1", a[1]);
        rubberRef.current.setAttribute("x2", cur[0]);
        rubberRef.current.setAttribute("y2", cur[1]);
        rubberRef.current.style.display = "block";
      } else if (!a && rubberRef.current) {
        rubberRef.current.style.display = "none";
      }
    }
    if (hlRef.current) {
      // paint: distance-thin at capture, live preview via DOM (no React render per move)
      const st = hlRef.current;
      const q = toImage(e.clientX, e.clientY);
      const last = st.pts[st.pts.length - 1];
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= 2.5 / tfRef.current.scale && st.pts.length < 4000) st.pts.push(q);
      if (hlPathRef.current) {
        const w = hlStyle.size / tfRef.current.scale;
        hlPathRef.current.setAttribute("d", hlStyle.tip === "chisel"
          ? (st.pts.length > 1 ? "M" + chiselRibbon(st.pts, w, 45).map((v) => v.join(",")).join(" L") + " Z" : "")
          : strokePathD(st.pts));
      }
      return;
    }
    if (boxSelectRef.current && (e.shiftKey || !panRef.current)) {
      const cur = toImage(e.clientX, e.clientY);
      if (Math.hypot(e.clientX - boxSelectRef.current.sx, e.clientY - boxSelectRef.current.sy) > 6) {
        setSelectMarquee({ x0: boxSelectRef.current.start[0], y0: boxSelectRef.current.start[1], x1: cur[0], y1: cur[1] });
      }
    }
    moveCrosshair(e);                 // full-page aim guide (draw modes), always tracks hover
    // a held draw-click that moves becomes a pan (point placement waits for up)
    if (pendingClickRef.current && !panRef.current) {
      const pc = pendingClickRef.current;
      if (Math.hypot(e.clientX - pc.cx, e.clientY - pc.cy) > 5) {
        panRef.current = { sx: pc.cx, sy: pc.cy, ox: tfRef.current.x, oy: tfRef.current.y };
        pendingClickRef.current = null;
        if (containerRef.current) containerRef.current.style.cursor = "grabbing";
      }
    }
    updateHover(e);
    // Edge hover detection: when the Select tool is active, check if the cursor is
    // near an edge of ANY visible shape and show that segment's length.
    if (tool === "select" && !panRef.current && !dragRef.current) {
      const _pt = toImage(e.clientX, e.clientY);
      const _thr = 10 / tfRef.current.scale;
      // Check selected shape first, then all visible shapes
      const _candidates = selectedId
        ? [shapes.find((_s) => _s.id === selectedId), ...visibleShapes.filter((_s) => _s.id !== selectedId)]
        : [...visibleShapes].reverse();
      let _foundEdge = false;
      for (const _sel of _candidates) {
        if (!_sel || _sel.measure_role === "count" || !aiDetectShapeRevealed(_sel)) continue;
        const _sp = panelKeySet.has(_sel.sheet_id) ? panelByKey(_sel.sheet_id) : null;
        if (!_sp || !_sp.img?.w) continue;
        const _pts = _sel.verts_norm.map(([nx, ny]) => [nx * _sp.img.w + _sp.xOffset, ny * _sp.img.h]);
        const _closed = _sel.measure_role !== "linear" && _sel.measure_role !== "surface_area";
        const _edgeN = _closed ? _pts.length : _pts.length - 1;
        let _bestD = Infinity, _bestI = -1;
        for (let _i = 0; _i < _edgeN; _i++) {
          const _j = (_i + 1) % _pts.length;
          const _d = distToSeg(_pt[0], _pt[1], _pts[_i][0], _pts[_i][1], _pts[_j][0], _pts[_j][1]);
          if (_d < _thr && _d < _bestD) { _bestD = _d; _bestI = _i; }
        }
        if (_bestI >= 0) {
          const _j = (_bestI + 1) % _pts.length;
          const _ax = _pts[_bestI][0], _ay = _pts[_bestI][1], _bx = _pts[_j][0], _by = _pts[_j][1];
          const _edx = _bx - _ax, _edy = _by - _ay;
          const _elen2 = _edx * _edx + _edy * _edy;
          let _t = _elen2 < 1e-12 ? 0 : ((_pt[0] - _ax) * _edx + (_pt[1] - _ay) * _edy) / _elen2;
          if (_t < 0) _t = 0; else if (_t > 1) _t = 1;
          const _edgePx = Math.sqrt(_elen2);
          const _u = uppFor(_sel.sheet_id) || 0;
          const _len = _edgePx * _u;
          setHoverEdge((prev) => (
            prev && prev.shapeId === _sel.id && prev.i === _bestI && prev.t === _t && prev.length === _len
              ? prev
              : { shapeId: _sel.id, i: _bestI, length: _len, t: _t }
          ));
          // Suppress the BOQ hover card when showing the edge length label (never while pinned or selected).
          if (!shapeBoqFocus && !(tool === "select" && selectedId === _sel.id)) {
            setShapeBoqHover(null);
            shapeBoqHoverStickyRef.current = false;
          }
          _foundEdge = true;
          break;
        }
      }
      if (!_foundEdge) {
        setHoverEdge((prev) => prev ? null : prev);
      }
    } else {
      setHoverEdge((prev) => prev ? null : prev);
    }
    // One-Click proposal editing: dragging a corner/edge grip, else revealing
    // handles on the region under the cursor. Both work in panel-LOCAL px.
    if (ocDragRef.current) { ocDragMove(e); return; }
    if (tool === "oneclick" && proposal && !panRef.current && !pendingClickRef.current) ocHoverUpdate(e);
    if (dragRef.current) {
      const d = dragRef.current;
      // dragRef is armed only by selectAt (Select tool), where snapRef is stale
      // (moveCrosshair bails for Select) — track the RAW cursor; vertex/edge
      // drags apply their own endpoint snap (ocSnap), and a body move is free.
      const p = toImage(e.clientX, e.clientY);
      // Live PREVIEW only — geometry follows the cursor for feel, but nothing
      // stamps here anymore: provenance is applied exactly once, on release,
      // by the geom command in onPointerUp (whose `prev` is the grab-time
      // snapshot — so stampEdit's freeze still reads the TRUE pre-drag ring).
      // The gx/gy gate keeps a plain select-click's zero-delta pointermove
      // from writing any preview state at all: no motion ⇒ no write ⇒ no
      // command ⇒ no stamp — the old d.stamped flag guard, made structural.
      // vn is computed OUTSIDE the updater (from the grab-time snapshot, which
      // is exact: a gesture only ever moves the verts named by the drag ref)
      // and remembered on the ref (d.lastVerts/d.lastComputed) so the release
      // commit and the preview can never disagree.
      if (d.kind === "vertex" || d.kind === "edge" || d.kind === "move" || d.kind === "holeVertex" || d.kind === "holeEdge") {
        if (!d.moved && e.clientX === d.gx && e.clientY === d.gy) return;
        d.moved = true;
        const sp = panelByKey(d.shape.sheet_id);
        let vn;
        let holes;
        if (d.kind === "holeVertex") {
          const [slx, sly] = ocSnap(sp.key, p[0] - sp.xOffset, p[1], !!d.shape.origin?.raster_traced);
          holes = (d.prev.holes_norm || []).map((h) => h.map((v) => [...v]));
          holes[d.holeIndex] = holes[d.holeIndex].map((v, i) => (i === d.vIndex ? [slx / sp.img.w, sly / sp.img.h] : v));
          d.lastHoles = holes;
          d.lastComputed = recomputeShape({ ...d.shape, holes_norm: holes });
          setShapes((ss) => ss.map((s) => (s.id !== d.shapeId ? s : { ...s, holes_norm: holes, computed: d.lastComputed })));
        } else if (d.kind === "holeEdge") {
          const dx = (p[0] - d.start[0]) / sp.img.w, dy = (p[1] - d.start[1]) / sp.img.h;
          const rt = !!d.shape.origin?.raster_traced;
          const snapN = (nx, ny) => { const [lx, ly] = ocSnap(sp.key, nx * sp.img.w, ny * sp.img.h, rt); return [lx / sp.img.w, ly / sp.img.h]; };
          const na = snapN(d.oaN[0] + dx, d.oaN[1] + dy), nb = snapN(d.obN[0] + dx, d.obN[1] + dy);
          holes = (d.prev.holes_norm || []).map((h) => h.map((v) => [...v]));
          holes[d.holeIndex] = holes[d.holeIndex].map((v, i) => (i === d.i ? na : i === d.j ? nb : v));
          d.lastHoles = holes;
          d.lastComputed = recomputeShape({ ...d.shape, holes_norm: holes });
          setShapes((ss) => ss.map((s) => (s.id !== d.shapeId ? s : { ...s, holes_norm: holes, computed: d.lastComputed })));
        } else {
          if (d.kind === "vertex") {
            const [slx, sly] = ocSnap(sp.key, p[0] - sp.xOffset, p[1], !!d.shape.origin?.raster_traced);   // snap the corner to true endpoints (never on a raster-traced shape — see ocSnap)
            let lx = slx, ly = sly;
            if (d.shape.measure_role === "surface_area") {
              const endOnly = d.vIndex === 0 || d.vIndex === d.prev.verts_norm.length - 1;
              const epSnap = snapPointToSurfaceEndpoints(sp.key, d.shape.condition_id, d.shapeId, slx, sly, undefined, endOnly);
              if (epSnap) { lx = epSnap[0]; ly = epSnap[1]; }
            }
            vn = d.prev.verts_norm.map((v, i) => (i === d.vIndex ? [lx / sp.img.w, ly / sp.img.h] : v));
          } else if (d.kind === "edge") {
            // translate BOTH endpoints of the line by the drag delta; each end snaps
            // to the linework independently (normalized → local px → snap → normalized)
            const dx = (p[0] - d.start[0]) / sp.img.w, dy = (p[1] - d.start[1]) / sp.img.h;
            const rt = !!d.shape.origin?.raster_traced;
            const snapN = (nx, ny) => {
              let lx = nx * sp.img.w, ly = ny * sp.img.h;
              const hit = ocSnap(sp.key, lx, ly, rt);
              lx = hit[0]; ly = hit[1];
              if (d.shape.measure_role === "surface_area") {
                const epSnap = snapPointToSurfaceEndpoints(sp.key, d.shape.condition_id, d.shapeId, lx, ly);
                if (epSnap) { lx = epSnap[0]; ly = epSnap[1]; }
              }
              return [lx / sp.img.w, ly / sp.img.h];
            };
            const na = snapN(d.oaN[0] + dx, d.oaN[1] + dy), nb = snapN(d.obN[0] + dx, d.obN[1] + dy);
            vn = d.prev.verts_norm.map((v, i) => (i === d.i ? na : i === d.j ? nb : v));
          } else {
            // start and p are both stage px, so xOffset cancels in the delta —
            // only the normalizing divisor is the shape's own panel
            const dx = (p[0] - d.start[0]) / sp.img.w, dy = (p[1] - d.start[1]) / sp.img.h;
            vn = d.orig.map(([nx, ny]) => [nx + dx, ny + dy]);
            d.lastVerts = vn;
            d.lastComputed = undefined;
            if (d.groupOrigs) {
              d.groupLastVerts = {};
              for (const [id, orig] of Object.entries(d.groupOrigs)) {
                d.groupLastVerts[id] = orig.map(([nx, ny]) => [nx + dx, ny + dy]);
              }
              setShapes((ss) => ss.map((s) => (d.groupLastVerts[s.id]
                ? { ...s, verts_norm: d.groupLastVerts[s.id] }
                : s)));
            } else {
              setShapes((ss) => ss.map((s) => (s.id !== d.shapeId ? s : { ...s, verts_norm: vn })));
            }
          }
          if (d.kind !== "move") {
          d.lastVerts = vn;
          // a translation never re-prices (same lengths/areas) — matches the old
          // move updater, which left `computed` untouched
          d.lastComputed = recomputeShape({ ...d.shape, verts_norm: vn });
          setShapes((ss) => ss.map((s) => (s.id !== d.shapeId ? s
              : { ...s, verts_norm: vn, computed: d.lastComputed })));
          }
        }
      } else if (d.kind === "markupMove") {
        // raw cursor point — markups aren't snapped/angle-locked, and this matches the
        // raw d.start so the delta can't jump from a stale snap/angle ref.
        const mp = toImage(e.clientX, e.clientY);
        // dblclick-safe: stay inert until the pointer travels past the ~5px pan
        // threshold, so a click / first click of a double-click never moves it
        const sc = tfRef.current.scale;
        if (!d.moved && Math.hypot(mp[0] - d.start[0], mp[1] - d.start[1]) < 5 / sc) return;
        d.moved = true;
        const sp = panelByKey(d.sheetId);
        if (!sp || !sp.img.w) return;
        // start and mp are both stage px, so xOffset cancels in the delta; normalize
        // by the markup's OWN panel dims. Live setMarkups each move (mirrors the shape
        // `move` pattern; NOT commit-on-release). Persistence is automatic.
        const dx = (mp[0] - d.start[0]) / sp.img.w, dy = (mp[1] - d.start[1]) / sp.img.h;
        const o = d.orig;
        setMarkups((ms) => ms.map((m) => {
          if (m.id !== d.markupId) return m;
          if (o.pts) return { ...m, pts: o.pts.map(([nx, ny]) => [nx + dx, ny + dy]) };   // highlighter stroke
          if (o.rect) return { ...m, rect: [[o.rect[0][0] + dx, o.rect[0][1] + dy], [o.rect[1][0] + dx, o.rect[1][1] + dy]] };
          if (o.target) return { ...m, at: [o.at[0] + dx, o.at[1] + dy], target: [o.target[0] + dx, o.target[1] + dy] };
          if (o.from) return { ...m, from: [o.from[0] + dx, o.from[1] + dy], to: [o.to[0] + dx, o.to[1] + dy] };
          return { ...m, at: [o.at[0] + dx, o.at[1] + dy] };   // text + bubble
        }));
      }
      return;
    }
    if (!panRef.current) return;
    // rAF-coalesced: pointermove can outrun the display (120Hz+ mice/trackpads) — keep
    // the latest position and write the transform once per frame. Still no React render.
    panRef.current.lx = e.clientX; panRef.current.ly = e.clientY;
    if (!panRafRef.current) panRafRef.current = requestAnimationFrame(() => {
      panRafRef.current = 0;
      const pr = panRef.current; if (!pr) return;
      tfRef.current = { ...tfRef.current, x: pr.ox + (pr.lx - pr.sx), y: pr.oy + (pr.ly - pr.sy) };
      applyTf();
      scheduleSync();   // keeps the tf mirror (labels/strokes) honest during long pans
    });
  }
  function onPointerUp(e) {
    if (hlRef.current) {
      const st = hlRef.current;
      hlRef.current = null;
      if (hlPathRef.current) hlPathRef.current.style.display = "none";
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      if (st.pts.length >= 2) {
        const tp = panelByKey(st.key) || panelAt(st.pts[0][0]);
        const pts = thinStroke(st.pts, 2.5 / tfRef.current.scale)
          .map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]);
        // width as a FRACTION of panel width — the stroke scales with the plan like ink,
        // and survives raster-budget changes (screen px ÷ scale ÷ panel width at draw time)
        addMarkup({ type: "highlight", pts, color: hlStyle.color,
                    w: (hlStyle.size / tfRef.current.scale) / tp.img.w, tip: hlStyle.tip }, tp.key);
      }
      return;
    }
    if (pendingClickRef.current) {
      const { p } = pendingClickRef.current;
      pendingClickRef.current = null;
      performClick(p, e);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      return;
    }
    if (ocDragRef.current) {
      ocDragRef.current = null;
      bumpIdle();
      // Drag may have pulled one proposal region into another — coalesce now
      // (not mid-drag) so the preview stays fluid and the merge is one step.
      let didMerge = false;
      flushSync(() => {
        setProposal((pr) => {
          if (!pr) return pr;
          const { regions, changed } = coalesceOverlappingProposalRegions(pr.regions, pr.key);
          if (!changed) return pr;
          didMerge = true;
          return { ...pr, regions };
        });
      });
      if (didMerge) {
        setOcSel(null);
        setCommitMsg("Merged overlapping selection into one — review, then ⏎ creates.");
      }
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      return;
    }
    if (dragRef.current) {
      const d = dragRef.current;
      dragRef.current = null;
      bumpIdle();
      // Commit-on-gesture-end: ONE geom command per drag, and only when the
      // geometry actually moved off the grab-time snapshot (a drag that snapped
      // back exactly is not an edit — no command, no stamp). The command's
      // canonical result supersedes the live-preview frames; `prev` carries the
      // grab-time verts/computed/provenance so the stamp freezes the true
      // pre-drag ring and undo restores it exactly. (pointercancel routes here
      // too, so an interrupted drag still lands as a stamped command, never as
      // orphaned preview state.)
      if ((d.kind === "vertex" || d.kind === "edge" || d.kind === "move" || d.kind === "holeVertex" || d.kind === "holeEdge")
          && (d.lastVerts || d.lastHoles || d.groupLastVerts)) {
        if (d.groupLastVerts && d.groupPrevs) {
          for (const id of (d.groupIds || Object.keys(d.groupLastVerts))) {
            const prev = d.groupPrevs[id];
            const lastVerts = d.groupLastVerts[id];
            if (!prev || !lastVerts || vertsEqual(lastVerts, prev.verts_norm)) continue;
            const res = dispatchShape({
              type: "geom", id, editKind: "move",
              verts_norm: lastVerts,
              prev,
            });
            const edited = res.shapes.find((s) => s.id === id);
            if (edited && !edited.holes_norm?.length && (edited.measure_role === "floor_area" || edited.measure_role === "deduct")) {
              const tp = panelByKey(edited.sheet_id);
              const w = tp?.img?.w, h = tp?.img?.h;
              if (w > 0 && h > 0) {
                const editedPoly = edited.verts_norm.map(([nx, ny]) => [nx * w, ny * h]);
                mergeIntoExistingShapes(editedPoly, edited.sheet_id, edited.condition_id, edited.measure_role, edited.id, res.shapes, "move");
              }
            }
          }
        } else {
        const vertsChanged = d.lastVerts && !vertsEqual(d.lastVerts, d.prev.verts_norm);
        const holesChanged = d.lastHoles && !holesEqual(d.lastHoles, d.prev.holes_norm || []);
        if (vertsChanged || holesChanged) {
          const res = dispatchShape({
            type: "geom", id: d.shapeId, editKind: d.kind === "holeVertex" || d.kind === "holeEdge" ? "vertex" : d.kind,
            verts_norm: d.lastVerts || d.prev.verts_norm,
            ...(holesChanged ? { holes_norm: d.lastHoles } : {}),
            ...(d.lastComputed !== undefined ? { computed: d.lastComputed } : {}),
            prev: d.prev,
          });
          // Shapes with trim holes stay one parent — never auto-merge into neighbors.
          const edited = res.shapes.find((s) => s.id === d.shapeId);
          if (edited && !edited.holes_norm?.length && (edited.measure_role === "floor_area" || edited.measure_role === "deduct")) {
            const tp = panelByKey(edited.sheet_id);
            const w = tp?.img?.w, h = tp?.img?.h;
            if (w > 0 && h > 0) {
              const editedPoly = edited.verts_norm.map(([nx, ny]) => [nx * w, ny * h]);
              mergeIntoExistingShapes(editedPoly, edited.sheet_id, edited.condition_id, edited.measure_role, edited.id, res.shapes, d.kind);
            }
          }
          // Wall Area / Surface: dragging an endpoint onto another run joins them.
          if (edited && edited.measure_role === "surface_area" && (d.kind === "vertex" || d.kind === "edge")) {
            tryMergeSurfaceRun(edited.id);
            for (const s of shapesRef.current) {
              if (s.sheet_id === edited.sheet_id && s.condition_id === edited.condition_id && s.measure_role === "surface_area") {
                if (tryCloseSurfaceLoopAtEndpoints(s.id)) break;
              }
            }
            setSelVert(null);
            setSelHole(null);
          }
        }
        }
      }
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      return;
    }
    if (selectMarquee) {
      const minX = Math.min(selectMarquee.x0, selectMarquee.x1);
      const maxX = Math.max(selectMarquee.x0, selectMarquee.x1);
      const minY = Math.min(selectMarquee.y0, selectMarquee.y1);
      const maxY = Math.max(selectMarquee.y0, selectMarquee.y1);
      const boxedIds = [];
      for (const s of visibleShapes) {
        const sp = panelByKey(s.sheet_id);
        if (!sp?.img?.w || !Array.isArray(s.verts_norm)) continue;
        const pts = s.verts_norm.map(([nx, ny]) => [nx * sp.img.w + sp.xOffset, ny * sp.img.h]);
        const sMinX = Math.min(...pts.map((pt) => pt[0]));
        const sMaxX = Math.max(...pts.map((pt) => pt[0]));
        const sMinY = Math.min(...pts.map((pt) => pt[1]));
        const sMaxY = Math.max(...pts.map((pt) => pt[1]));
        if (sMinX <= maxX && sMaxX >= minX && sMinY <= maxY && sMaxY >= minY) {
          boxedIds.push(s.id);
        }
      }
      if (boxedIds.length) {
        const picks = Object.fromEntries(boxedIds.map((id) => [id, true]));
        selectShape(boxedIds[0], picks);
      }
      setSelectMarquee(null);
      boxSelectRef.current = null;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      return;
    }
    boxSelectRef.current = null;
    if (panRef.current) {
      panRef.current = null;
      setTf({ ...tfRef.current });   // sync once at end
      if (containerRef.current) containerRef.current.style.cursor = spaceRef.current ? "grab" : "";
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    }
  }

  // Calibrated ruler bar — shows for a few seconds whenever a scale is accepted
  // (scale menu standard pick, the plan-says item, calibration, check-tool
  // recalibrate) so a grossly wrong scale is visually obvious against known
  // elements (a door is ~3′). Takes the NEW upp as an argument — never read
  // `scales` right after setScales (stale closure). Ephemeral: never persisted,
  // dismissed by the next action. `preview` marks a HOVER preview of a scale
  // that was never accepted — it must additionally die with the hover/menu
  // (clearPreviewGuide), while an accepted bar rides out its 8 s.
  function showScaleGuide(key, uppStored, label, preview = false) {
    const p = panelByKey(key);
    if (!p?.img.w || !containerRef.current) return;
    scaleGuidePreviewRef.current = preview;
    const uppBitmap = uppStored / factorFor(key);   // feet per bitmap px, matches uppFor math
    const z = tfRef.current.scale;
    // round guide length picked so the bar is legible (≥160 screen px) at the current zoom
    const CAND = units === "metric" ? [1, 2, 5, 10, 20, 50, 100].map((m) => m / M_PER_FT) : [2, 5, 10, 20, 50, 100, 200];
    const feet = CAND.find((f) => (f / uppBitmap) * z >= 160) ?? CAND[CAND.length - 1];
    const r = containerRef.current.getBoundingClientRect();
    const t = tfRef.current;
    const cx = Math.min(Math.max(((r.width / 2) - t.x) / t.scale, p.xOffset + p.img.w * 0.1), p.xOffset + p.img.w * 0.9);
    const cy = Math.min(Math.max(((r.height * 0.78) - t.y) / t.scale, p.img.h * 0.1), p.img.h * 0.92);
    setScaleGuide({ key, feet, px: feet / uppBitmap, label, at: [cx, cy] });
    clearTimeout(scaleGuideTimerRef.current);
    scaleGuideTimerRef.current = setTimeout(() => setScaleGuide(null), 8000);
  }
  useEffect(() => { setScaleGuide(null); scaleGuidePreviewRef.current = false; }, [tool, groupSig]);
  useEffect(() => () => clearTimeout(scaleGuideTimerRef.current), []);
  // Kill a hover-preview guide (and only a preview — an accepted bar stays).
  // Fired on hover-out of the plan-says item AND whenever the scale menu
  // closes (item click, Escape, outside click — the item button unmounts
  // without a mouseleave, so hover-out alone can't be trusted). Stable
  // identity: it feeds the menu's onOpenChange effect via onScaleMenuDepth.
  const clearPreviewGuide = useCallback(() => {
    if (!scaleGuidePreviewRef.current) return;
    scaleGuidePreviewRef.current = false;
    clearTimeout(scaleGuideTimerRef.current);
    setScaleGuide(null);
  }, []);
  const onScaleMenuDepth = useCallback((o) => { onMenuDepth(o); if (!o) clearPreviewGuide(); }, [onMenuDepth, clearPreviewGuide]);

  // Every user-facing scale acceptance goes through here: store the new scale
  // AND re-price the committed shapes on that sheet. `computed` is priced at
  // draw time, so without this a rescale left every existing SF/LF at the old
  // scale (the same staleness pasteClipboard calls "the legacy bug") — glaring
  // now that the check tool's one-tap recalibrate makes late rescales routine.
  // Hydrate bypasses this on purpose: saved computed matches the saved scale.
  function rescaleSheet(key, upp) {
    // stash the scale this rescale replaces, but only when it actually changes
    // committed quantities (sheet had a scale, the scale moved, shapes exist on
    // it) — that's the case worth a one-step revert (the Scale menu surfaces it)
    const prior = scales[key];
    if (prior === upp) return; // re-picking the active scale — no reprice churn, no stash (mirrors the MCP guard)
    if (prior != null && shapes.some((sh) => sh.sheet_id === key)) {
      setPrevScale({ key, upp: prior, source: scaleSources[key] || "standard" });
    }
    setScales((s) => ({ ...s, [key]: upp }));
    // STRICT panel lookup — the panelByKey wrapper falls back to panels[0], so
    // it can't detect an off-canvas sheet: a future off-canvas caller would
    // silently re-price that sheet's shapes against the wrong panel's bitmap
    // dims (and factorFor of a never-rastered key). Off-canvas the scale is
    // still stored above; the shapes keep their (now old-scale) computed until
    // a caller reprices them on canvas — wrong-but-visible beats silently-wrong.
    const sp = panels.find((p) => p.key === key);
    if (!sp?.img?.w) return; // sheet not on canvas — can't re-price without its bitmap dims
    const uEff = upp / factorFor(key);
    // count shapes keep their computed: EA has no upp dependency at all, and
    // recomputeShape's count branch would clobber a hand-edited / hydrated
    // fractional count (supported data — see totals.js accumulateRole) to 1.
    // A rescale re-price is a whole-array NON-edit (`replace`: no stamps, no
    // counters) and it RESETS both undo stacks: every recorded command froze
    // `computed` at the old scale, and undoing one afterwards would resurrect
    // stale quantities.
    dispatchShape({
      type: "replace",
      shapes: shapes.map((sh) => (sh.sheet_id === key && sh.measure_role !== "count" ? { ...sh, computed: recomputeShape(sh, uEff) } : sh)),
    }, { reset: true });
  }

  // Revert the last quantity-changing rescale (the one-slot stash above): runs
  // the same rescaleSheet back — which re-stashes the scale being replaced, so
  // a revert is itself revertible (a two-way toggle, not a history).
  function revertScale() {
    const pv = prevScale;
    if (!pv) return;
    rescaleSheet(pv.key, pv.upp);
    setScaleSources((s) => ({ ...s, [pv.key]: pv.source }));
    showScaleGuide(pv.key, pv.upp, STANDARD_SCALES.find((x) => Math.abs(x.upp - pv.upp) < 1e-9)?.label || pv.source);
  }

  async function applyAutoscale(key, { force = false } = {}) {
    const mayApply = () => {
      if (force) return true;
      if (scalesRef.current[key] != null) return false;
      const src = scaleSourcesRef.current[key];
      return !(src === "standard" || src === "calibrated" || src === "detected");
    };
    if (!mayApply()) return;
    let det = detectedScales[key];
    if (!det) {
      const pageObj = pageObjsRef.current.get(key);
      const rs = renderScalesRef.current.get(key);
      if (pageObj && rs != null) {
        try {
          const tc = await pageObj.getTextContent();
          const vp = pageObj.getViewport({ scale: rs });
          det = detectScale(tc, vp);
          if (det) setDetectedScales((d) => (d[key]?.label === det.label ? d : { ...d, [key]: det }));
        } catch { /* best-effort */ }
      }
    }
    if (!mayApply()) return;
    if (det) {
      rescaleSheet(key, det.upp);
      setScaleSources((s) => ({ ...s, [key]: "autoscale" }));
      showScaleGuide(key, det.upp, det.label);
      setCommitMsg(`Autoscale — ${det.label}. Change it anytime from the scale menu.`);
      return;
    }
    const fbLabel = units === "metric" ? "1:100" : '1/8" = 1\'-0"';
    const fb = STANDARD_SCALES.find((s) => s.label === fbLabel);
    if (fb) {
      if (!mayApply()) return;
      rescaleSheet(key, fb.upp);
      setScaleSources((s) => ({ ...s, [key]: "autoscale" }));
      showScaleGuide(key, fb.upp, fb.label);
      setCommitMsg(`Autoscale — applied ${fb.label} as default. Change it if your plan uses a different scale.`);
      return;
    }
    setCommitMsg("Autoscale couldn't detect a scale — pick one from Standard or calibrate two points.");
  }
  const applyAutoscaleRef = useRef(applyAutoscale);
  applyAutoscaleRef.current = applyAutoscale;

  const autoscaleTriedRef = useRef(new Set());
  useEffect(() => {
    if (status !== "ready" || !focusPanel?.key) return;
    const key = focusPanel.key;
    if (scales[key] != null || autoscaleTriedRef.current.has(key)) return;
    const src = scaleSources[key];
    if (src === "standard" || src === "calibrated" || src === "detected") return;
    autoscaleTriedRef.current.add(key);
    void applyAutoscaleRef.current(key);
  }, [status, focusPanel?.key, scales, scaleSources]);

  function applyCalibration() {
    const feet = calInputToFeet(parseFloat(pendingLen), units);   // metric users type meters; stored scale stays feet
    if (!(feet > 0) || calib.length !== 2) return;
    const pa = panelAt(calib[0][0]), pb = panelAt(calib[1][0]);
    if (pa.key !== pb.key) {
      setCommitMsg("Calibrate on one sheet — those two clicks landed on different sheets.");
      setCalib([]); setPendingLen(""); return;
    }
    const px = Math.hypot(calib[1][0] - calib[0][0], calib[1][1] - calib[0][1]);
    if (px <= 0) return;
    // store at BASELINE resolution — the auto hi-res raster has factorFor× denser pixels
    const toBase = factorFor(pa.key);
    rescaleSheet(pa.key, (feet / px) * toBase); // per page — remembered for this sheet
    setScaleSources((s) => ({ ...s, [pa.key]: "calibrated" }));
    showScaleGuide(pa.key, (feet / px) * toBase, "calibrated");
    setCalib([]); setPendingLen("");
  }

  // Check tool's one-tap recalibrate: the measured span IS a calibration line —
  // same math as applyCalibration, sourced from the check points + stated value.
  function recalibrateFromCheck() {
    const feet = parseLenInput(checkStated, units);
    if (!(feet > 0) || check.length !== 2) return;
    const pa = panelAt(check[0][0]);
    if (panelAt(check[1][0])?.key !== pa?.key) return; // cross-panel span — the UI hides the button, but keep the function safe standalone
    const px = Math.hypot(check[1][0] - check[0][0], check[1][1] - check[0][1]);
    if (px <= 0) return;
    const toBase = factorFor(pa.key);
    rescaleSheet(pa.key, (feet / px) * toBase);
    setScaleSources((s) => ({ ...s, [pa.key]: "calibrated" }));
    showScaleGuide(pa.key, (feet / px) * toBase, "calibrated");
    setCheck([]); setCheckStated("");
  }

  function mergeIntoExistingShapes(newPoly, sheetId, condId, role, keepId = null, currentShapes = null, editKind = "vertex") {
    const pool = currentShapes || shapesRef.current;
    if (!newPoly || newPoly.length < 3) return null;
    if (role !== "floor_area" && role !== "deduct") return null;
    const tp = panelByKey(sheetId);
    const w = tp?.img?.w, h = tp?.img?.h;
    if (!(w > 0 && h > 0)) return null;
    const toNorm = (poly) => poly.map(([x, y]) => [x / w, y / h]);
    const toPx = (norm) => norm.map(([nx, ny]) => [nx * w, ny * h]);
    const polyOf = (s) => toPx(s.verts_norm);
    const holesTouch = (aPx, bPx, tol = 3) => {
      if (polygonsOverlap(aPx, bPx)) return true;
      let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const [x, y] of aPx) { ax0 = Math.min(ax0, x); ay0 = Math.min(ay0, y); ax1 = Math.max(ax1, x); ay1 = Math.max(ay1, y); }
      for (const [x, y] of bPx) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
      if (ax1 + tol < bx0 || bx1 + tol < ax0 || ay1 + tol < by0 || by1 + tol < ay0) return false;
      for (const [x, y] of bPx) if (pointInPoly(x, y, aPx)) return true;
      for (const [x, y] of aPx) if (pointInPoly(x, y, bPx)) return true;
      return false;
    };
    const unionRingsPx = (rings) => {
      const valid = rings.filter((r) => r && r.length >= 3);
      if (!valid.length) return null;
      if (valid.length === 1) return valid[0].map(([x, y]) => [x, y]);
      let uni = unionPolygons(valid, 0.5) || unionPolygons(valid, 0);
      if (uni && uni.length >= 3) return uni;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of valid) for (const [x, y] of r) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      if (!(x1 > x0 && y1 > y0)) return null;
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    };
    const coalesceHolesPx = (ringsPx) => {
      let list = ringsPx.map((r) => r.map(([x, y]) => [x, y]));
      let changed = true;
      while (changed && list.length > 1) {
        changed = false;
        outer: for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            if (!holesTouch(list[i], list[j])) continue;
            const uni = unionRingsPx([list[i], list[j]]);
            if (!uni) continue;
            list = [...list.slice(0, i), ...list.slice(i + 1, j), ...list.slice(j + 1), uni];
            changed = true;
            break outer;
          }
        }
      }
      return list;
    };
    const victims = pool.filter((s) =>
      s.sheet_id === sheetId
      && s.condition_id === condId
      && s.measure_role === role
      && (keepId ? s.id !== keepId : true)
      && polygonsOverlap(newPoly, polyOf(s)));
    if (!victims.length) return null;
    const cx = newPoly.reduce((s, p) => s + p[0], 0) / newPoly.length;
    const cy = newPoly.reduce((s, p) => s + p[1], 0) / newPoly.length;
    const pickPrimary = (list) => list.slice().sort((a, b) => {
      const ah = (a.holes_norm?.length || 0) > 0, bh = (b.holes_norm?.length || 0) > 0;
      return (bh - ah) || (ringArea(polyOf(b)) - ringArea(polyOf(a)));
    })[0];
    const containing = victims.filter((v) => pointInPoly(cx, cy, polyOf(v)));
    const primary = keepId
      ? (pool.find((s) => s.id === keepId) || victims[0])
      : (pickPrimary(containing) || pickPrimary(victims));
    const others = victims.filter((v) => v.id !== primary.id);
    const uni = unionPolygons([newPoly, ...victims.map(polyOf)], 0.5) || unionPolygons([newPoly, ...victims.map(polyOf)], 0);
    if (!uni || uni.length < 3) return null;
    let holePx = [];
    for (const v of [primary, ...others]) {
      for (const ring of (v.holes_norm || [])) holePx.push(toPx(ring));
    }
    const trimmed = [];
    for (const ring of holePx) {
      if (!holesTouch(ring, newPoly) && !polygonsOverlap(ring, newPoly)) { trimmed.push(ring); continue; }
      const pieces = subtractPolygonsToPolys(ring, newPoly);
      if (!pieces.length) continue;
      for (const p of pieces) if (ringArea(p) > 4) trimmed.push(p);
    }
    holePx = coalesceHolesPx(trimmed);
    const vn = toNorm(uni);
    const holes_norm = holePx.map(toNorm);
    if (others.length) dispatchShape({ type: "delete", ids: others.map((v) => v.id) });
    dispatchShape({
      type: "geom", id: primary.id, editKind,
      verts_norm: vn,
      holes_norm,
      computed: recomputeShape({ ...primary, verts_norm: vn, holes_norm }),
      prev: geomSnapshot(primary),
    });
    selectShape(primary.id);
    setCommitMsg("Merged overlapping takeoffs into one.");
    return primary;
  }

  // Overlap victims for a pending draw — same filter mergeIntoExistingShapes uses.
  function overlapVictimsFor(newPoly, sheetId, condId, role) {
    if (!newPoly || newPoly.length < 3) return [];
    // Cutout overlays stack independently on the parent until Apply — never merge them.
    if (role === "deduct") return [];
    if (role !== "floor_area" && role !== "deduct") return [];
    const tp = panelByKey(sheetId);
    const w = tp?.img?.w, h = tp?.img?.h;
    if (!(w > 0 && h > 0)) return [];
    const polyOf = (s) => s.verts_norm.map(([nx, ny]) => [nx * w, ny * h]);
    return shapesRef.current.filter((s) =>
      s.sheet_id === sheetId
      && s.condition_id === condId
      && s.measure_role === role
      && polygonsOverlap(newPoly, polyOf(s)));
  }

  // Carve newPoly out of each overlapping takeoff — trim the parent fill/mask so
  // the overlapping region is physically removed (never a deduct overlay).
  // Returns true when the parent geometry changed.
  function removeOverlapFromVictims(newPoly, sheetId, victims) {
    const tp = panelByKey(sheetId);
    const w = tp?.img?.w, h = tp?.img?.h;
    if (!(w > 0 && h > 0) || !victims.length) return false;
    const toNorm = (poly) => poly.map(([x, y]) => [x / w, y / h]);
    const toPx = (norm) => norm.map(([nx, ny]) => [nx * w, ny * h]);
    // Adjacent/touching holes must coalesce — polygonsOverlap is strict-interior only.
    const holesTouch = (aPx, bPx, tol = 3) => {
      if (polygonsOverlap(aPx, bPx)) return true;
      let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const [x, y] of aPx) { ax0 = Math.min(ax0, x); ay0 = Math.min(ay0, y); ax1 = Math.max(ax1, x); ay1 = Math.max(ay1, y); }
      for (const [x, y] of bPx) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
      if (ax1 + tol < bx0 || bx1 + tol < ax0 || ay1 + tol < by0 || by1 + tol < ay0) return false;
      for (const [x, y] of bPx) if (pointInPoly(x, y, aPx)) return true;
      for (const [x, y] of aPx) if (pointInPoly(x, y, bPx)) return true;
      return false;
    };
    const unionRingsPx = (rings) => {
      const valid = rings.filter((r) => r && r.length >= 3);
      if (!valid.length) return null;
      if (valid.length === 1) return valid[0].map(([x, y]) => [x, y]);
      let uni = unionPolygons(valid, 0.5) || unionPolygons(valid, 0);
      if (uni && uni.length >= 3) return uni;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of valid) for (const [x, y] of r) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      if (!(x1 > x0 && y1 > y0)) return null;
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    };
    const coalesceHolesPx = (ringsPx) => {
      let list = ringsPx.map((r) => r.map(([x, y]) => [x, y]));
      let changed = true;
      while (changed && list.length > 1) {
        changed = false;
        outer: for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            if (!holesTouch(list[i], list[j])) continue;
            const uni = unionRingsPx([list[i], list[j]]);
            if (!uni) continue;
            list = [...list.slice(0, i), ...list.slice(i + 1, j), ...list.slice(j + 1), uni];
            changed = true;
            break outer;
          }
        }
      }
      return list;
    };
    const primaryTrimVictim = (pool) => {
      const cx = newPoly.reduce((s, p) => s + p[0], 0) / newPoly.length;
      const cy = newPoly.reduce((s, p) => s + p[1], 0) / newPoly.length;
      const scored = pool.map((v) => {
        const outer = toPx(v.verts_norm);
        return {
          v,
          area: ringArea(outer),
          contains: pointInPoly(cx, cy, outer),
          hasHoles: (v.holes_norm?.length || 0) > 0,
        };
      });
      const pick = (list) => list.slice().sort((a, b) => (b.hasHoles - a.hasHoles) || (b.area - a.area))[0]?.v;
      return pick(scored.filter((s) => s.contains)) || pick(scored);
    };
    const mergeHoleIntoList = (prevHoles, cutterPx, outerPx) => {
      const holes = coalesceHolesPx((prevHoles || []).map((h) => toPx(h.map((v) => [...v])))).map(toNorm);
      if (cutterPx.every(([x, y]) => holes.some((h) => pointInPoly(x, y, toPx(h))))) return holes;
      const cutterRemovesFill = cutterPx.some(([x, y]) => pointInPoly(x, y, outerPx)
        && !holes.some((h) => pointInPoly(x, y, toPx(h))));
      const mergeIdx = new Set();
      for (let i = 0; i < holes.length; i++) {
        if (holesTouch(toPx(holes[i]), cutterPx)) mergeIdx.add(i);
      }
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (let i = 0; i < holes.length; i++) {
          if (!mergeIdx.has(i)) continue;
          for (let j = 0; j < holes.length; j++) {
            if (mergeIdx.has(j)) continue;
            if (holesTouch(toPx(holes[i]), toPx(holes[j]))) { mergeIdx.add(j); expanded = true; }
          }
        }
      }
      if (!mergeIdx.size) {
        const next = cutterRemovesFill ? coalesceHolesPx([...holes.map(toPx), cutterPx]) : coalesceHolesPx(holes.map(toPx));
        return next.map(toNorm);
      }
      const mergePx = [cutterPx, ...[...mergeIdx].map((i) => toPx(holes[i]))];
      const keep = holes.filter((_, i) => !mergeIdx.has(i)).map(toPx);
      const uni = unionRingsPx(mergePx);
      if (!uni) {
        const next = cutterRemovesFill ? coalesceHolesPx([...holes.map(toPx), cutterPx]) : coalesceHolesPx(holes.map(toPx));
        return next.map(toNorm);
      }
      return coalesceHolesPx([...keep, uni]).map(toNorm);
    };
    // Keep wall_area parents as wall_area when punching cutouts (Wall Trace / Wall Area).
    const trimRole = (live) => (
      live.measure_role === "deduct" ? "deduct"
        : live.measure_role === "wall_area" ? "wall_area"
          : "floor_area"
    );
    const applyInteriorTrim = (live, cutterPx, outerPx) => {
      const role = trimRole(live);
      const holes_norm = mergeHoleIntoList(live.holes_norm, cutterPx, outerPx);
      if (holesEqual(holes_norm, live.holes_norm || [])) return false;
      dispatchShape({
        type: "geom", id: live.id, editKind: "vertex",
        verts_norm: live.verts_norm,
        holes_norm,
        computed: recomputeShape({ ...live, measure_role: role, holes_norm }),
        prev: geomSnapshot(live),
      });
      return true;
    };
    const applyTrimPolys = (live, polys, cutterPx, outerPx) => {
      if (live.holes_norm?.length) return applyInteriorTrim(live, cutterPx, outerPx);
      const role = trimRole(live);
      const vnPolys = polys.map((poly) => toNorm(poly));
      if (polys.length === 1) {
        dispatchShape({
          type: "geom", id: live.id, editKind: "vertex",
          verts_norm: vnPolys[0],
          holes_norm: [],
          computed: recomputeShape({ ...live, measure_role: role, verts_norm: vnPolys[0], holes_norm: [] }),
          prev: geomSnapshot(live),
        });
        return true;
      }
      return false;
    };
    const toDelete = [];
    let carved = false;
    const primary = primaryTrimVictim(victims);
    if (!primary) return false;
    // Drop stray inner masks fully inside the parent — Remove trims one parent, never spawns siblings.
    for (const v of victims) {
      if (v.id === primary.id) continue;
      const innerPx = toPx(v.verts_norm);
      const outerPx = toPx(primary.verts_norm);
      if (innerPx.every(([x, y]) => pointInPoly(x, y, outerPx)) && polygonsOverlap(innerPx, newPoly)) {
        toDelete.push(v.id);
        carved = true;
      }
    }
    const live = shapesRef.current.find((s) => s.id === primary.id) || primary;
    const existing = toPx(live.verts_norm);
    const before = ringArea(existing);
    const overlapPoly = intersectPolygons(existing, newPoly);
    const overlapArea = overlapPoly && overlapPoly.length >= 3 ? ringArea(overlapPoly) : 0;
    const childCx = newPoly.reduce((s, p) => s + p[0], 0) / newPoly.length;
    const childCy = newPoly.reduce((s, p) => s + p[1], 0) / newPoly.length;
    const childOnParent = newPoly.length >= 3 && pointInPoly(childCx, childCy, existing);
    const cutter = childOnParent
      ? newPoly
      : ((overlapPoly && overlapPoly.length >= 3)
        ? overlapPoly
        : (polygonsOverlap(existing, newPoly) ? newPoly : null));
    if (cutter) {
      const sampleRing = (poly) => {
        const pts = [...poly];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        }
        return pts;
      };
      const parentUnderNew = sampleRing(existing).every(([x, y]) => pointInPoly(x, y, newPoly));
      const cutterInside = cutter.every(([x, y]) => pointInPoly(x, y, existing));
      const interiorPunch = cutterInside && !parentUnderNew;
      const overlapPx = overlapArea > 1 ? overlapArea : (childOnParent ? Math.min(ringArea(newPoly), before) : 0);
      if (parentUnderNew || overlapPx >= before * 0.98) {
        toDelete.push(live.id);
        carved = true;
      } else if (interiorPunch || live.holes_norm?.length) {
        if (applyInteriorTrim(live, cutter, existing)) carved = true;
      } else {
        const remainder = subtractPolygonsToPolys(existing, cutter);
        const remainArea = remainder.reduce((n, p) => n + ringArea(p), 0);
        if (!remainder.length || remainArea <= 1) {
          toDelete.push(live.id);
          carved = true;
        } else if (applyTrimPolys(live, remainder, cutter, existing)) {
          carved = true;
        } else if (applyInteriorTrim(live, cutter, existing)) {
          carved = true;
        }
      }
    }
    if (toDelete.length) dispatchShape({ type: "delete", ids: [...new Set(toDelete)] });
    setCommitMsg(toDelete.includes(primary.id)
      ? "Removed the overlapping takeoff."
      : carved
        ? "Removed the overlapping part from the existing takeoff."
        : "No overlap could be removed.");
    return carved || toDelete.length > 0;
  }

  function resolveOverlapPrompt(choice) {
    const p = overlapPrompt;
    setOverlapPrompt(null);
    if (!p || choice === "cancel") {
      if (p?.source === "oneclick") setProposal(null);
      if (p) setCommitMsg("Overlapping draw discarded.");
      return;
    }
    if (p.source === "poly") {
      // Cut Out over a parent floor mask: Merge keeps the deduct overlay (visible
      // until Apply); Remove punches the parent immediately (existing trim path).
      if (p.cutoutOverParent) {
        if (choice === "merge") {
          const met = closedMetrics(p.points);
          const upp = uppFor(p.sheetId);
          dispatchShape({ type: "add", shapes: [{
            sheet_id: p.sheetId, condition_id: p.condId, measure_role: "deduct",
            verts_norm: p.points.map(([x, y]) => [(x - p.xOffset) / p.imgW, y / p.imgH]),
            computed: { area_sf: +(met.area * upp * upp).toFixed(2), perimeter_lf: +(met.perim * upp).toFixed(2) },
            ...(p.label ? { label: p.label } : {}),
            origin: { method: "manual" },
          }] });
          setCommitMsg("Cutout kept on top of the parent mask — apply it when ready.");
          return;
        }
        if (choice === "remove") {
          const wallVictims = (p.victims || []).filter((v) => v.measure_role === "wall_area" || v.measure_role === "surface_area");
          const floorVictims = (p.victims || []).filter((v) => v.measure_role === "floor_area");
          // Wall face is perimeter×H — punching holes increases face. Door/opening
          // cutouts on walls become openings[] deducts (W×H) instead.
          if (wallVictims.length) {
            applyWallCutoutAsOpening(p.newPoly, p.sheetId, wallVictims);
          } else if (floorVictims.length) {
            removeOverlapFromVictims(p.newPoly, p.sheetId, floorVictims);
          }
          setPoly([]);
          return;
        }
      }
      if (choice === "merge") {
        if (!mergeIntoExistingShapes(p.newPoly, p.sheetId, p.condId, p.role)) {
          // Merge failed unexpectedly — fall through to a plain add.
          const met = closedMetrics(p.points);
          const upp = uppFor(p.sheetId);
          dispatchShape({ type: "add", shapes: [{
            sheet_id: p.sheetId, condition_id: p.condId, measure_role: p.role,
            verts_norm: p.points.map(([x, y]) => [(x - p.xOffset) / p.imgW, y / p.imgH]),
            computed: { area_sf: +(met.area * upp * upp).toFixed(2), perimeter_lf: +(met.perim * upp).toFixed(2) },
            ...(p.label ? { label: p.label } : {}),
            origin: { method: "manual" },
          }] });
        }
        return;
      }
      if (choice === "remove") {
        removeOverlapFromVictims(p.newPoly, p.sheetId, p.victims);
        setPoly([]);
        return;
      }
    }
    if (p.source === "oneclick") {
      if (choice === "merge") {
        commitOneClickRegions(p.prop, p.direct, { forceMerge: true });
        setProposal(null);
        return;
      }
      if (choice === "remove") {
        for (const r of p.prop.regions) {
          if (r.kind === "neg") continue;
          const victims = overlapVictimsFor(r.poly, p.prop.key, p.condId, "floor_area");
          if (victims.length) removeOverlapFromVictims(r.poly, p.prop.key, victims);
        }
        setProposal(null);
        return;
      }
    }
  }

  // A shape belongs to the panel of its FIRST point — verts normalize against
  // that panel's dims, quantities use that sheet's scale.
  function commitPoly(points, asDeduct) {
    if (points.length < 3) return;
    const tp = panelAt(points[0][0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    // Cut Out over wall lines: pull vertices onto the wall area / wall run when nearby.
    if (asDeduct) {
      const projected = points.map((pt) => snapDeductToWallLine(pt[0], pt[1], 28));
      const hitN = projected.filter(Boolean).length;
      if (hitN >= Math.max(2, Math.ceil(points.length * 0.5))) {
        points = points.map((pt, i) => projected[i] || pt);
      }
    }
    const role = asDeduct ? "deduct" : "floor_area";
    const newPoly = points.map(([x, y]) => [x - tp.xOffset, y]);
    const victims = overlapVictimsFor(newPoly, tp.key, activeCond, role);
    if (victims.length) {
      setOverlapPrompt({
        source: "poly",
        points, role, newPoly,
        sheetId: tp.key, condId: activeCond,
        xOffset: tp.xOffset, imgW: tp.img.w, imgH: tp.img.h,
        label: activeLabel || undefined,
        victims,
        tag: condById[activeCond]?.finish_tag || "this condition",
      });
      return;
    }
    // Cut Out only — finishing a deduct over a parent floor or wall mask offers Merge / Remove.
    // Wall Area / Surface (open linear runs) count as wall parents when the cutout sits near the run.
    if (asDeduct && tp.img?.w) {
      const w = tp.img.w, h = tp.img.h;
      const polyOf = (s) => s.verts_norm.map(([nx, ny]) => [nx * w, ny * h]);
      const nearOpenWall = (wallPts, cutterPx, thr = 28) => {
        if (!wallPts || wallPts.length < 2 || !cutterPx?.length) return false;
        let cx = 0, cy = 0;
        for (const [x, y] of cutterPx) { cx += x; cy += y; }
        cx /= cutterPx.length; cy /= cutterPx.length;
        const samples = [[cx, cy], ...cutterPx];
        for (const [x, y] of samples) {
          for (let i = 1; i < wallPts.length; i++) {
            if (distToSeg(x, y, wallPts[i - 1][0], wallPts[i - 1][1], wallPts[i][0], wallPts[i][1]) < thr) return true;
          }
        }
        return false;
      };
      const parentVictims = shapesRef.current.filter((s) => {
        if (s.sheet_id !== tp.key) return false;
        if (s.measure_role === "floor_area" || s.measure_role === "wall_area") {
          return polygonsOverlap(newPoly, polyOf(s));
        }
        if (s.measure_role === "surface_area") return nearOpenWall(polyOf(s), newPoly);
        return false;
      });
      if (parentVictims.length) {
        setOverlapPrompt({
          source: "poly",
          cutoutOverParent: true,
          points, role: "deduct", newPoly,
          sheetId: tp.key, condId: activeCond,
          xOffset: tp.xOffset, imgW: tp.img.w, imgH: tp.img.h,
          label: activeLabel || undefined,
          victims: parentVictims,
          tag: condById[activeCond]?.finish_tag || "this condition",
        });
        return;
      }
    }
    const met = closedMetrics(points);
    // id + created_at are minted by the add command — the ONE creation gate
    dispatchShape({ type: "add", shapes: [{
      sheet_id: tp.key, condition_id: activeCond,
      measure_role: asDeduct ? "deduct" : "floor_area",
      verts_norm: points.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]),
      computed: { area_sf: +(met.area * upp * upp).toFixed(2), perimeter_lf: +(met.perim * upp).toFixed(2) },
      ...(activeLabel ? { label: activeLabel } : {}),
      origin: { method: "manual" },
    }] });
  }
  function commitLinear(points, curved = false) {
    if (points.length < 2) return;
    const tp = panelAt(points[0][0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    // curved: verts stay the clicked CONTROL points (drag one → re-smooths);
    // length always comes from the flattened spline
    const LF = openLen(curved ? flattenCurve(points) : points) * upp;
    const tIn = Number(aCond?.thickness_in) || 0; // borders/feature strips: SF = LF × T/12
    dispatchShape({ type: "add", shapes: [{
      sheet_id: tp.key, condition_id: activeCond, measure_role: "linear",
      ...(curved ? { curved: true } : {}),
      verts_norm: points.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]),
      computed: { perimeter_lf: +LF.toFixed(2), area_sf: tIn > 0 ? +((LF * tIn) / 12).toFixed(2) : 0 },
      ...(activeLabel ? { label: activeLabel } : {}),
      origin: { method: "manual" },
    }] });
  }
  // ── Wall Area / Surface open-run join ─────────────────────────────────────
  // Screen-aware endpoint tolerance — a few px miss at any zoom still counts.
  function surfaceJoinThr() {
    return Math.max(18, 22 / (tfRef.current?.scale || 1));
  }
  function closestPointOnSegPx(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    return { x, y, t, d: Math.hypot(px - x, py - y) };
  }
  function nearestPointOnPolylinePx(pts, px, py) {
    if (!pts || pts.length < 2) return null;
    let best = null;
    for (const ei of [0, pts.length - 1]) {
      const d = Math.hypot(px - pts[ei][0], py - pts[ei][1]);
      if (!best || d < best.d) best = { d, point: [pts[ei][0], pts[ei][1]], kind: "endpoint", index: ei };
    }
    for (let i = 1; i < pts.length; i++) {
      const hit = closestPointOnSegPx(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      const interior = hit.t > 0.02 && hit.t < 0.98;
      if (!best || hit.d < best.d) {
        best = interior
          ? { d: hit.d, point: [hit.x, hit.y], kind: "segment", segIndex: i }
          : { d: hit.d, point: [hit.x, hit.y], kind: "endpoint", index: hit.t < 0.5 ? i - 1 : i };
      }
    }
    return best;
  }
  function dedupeRunPx(pts, eps = 0.5) {
    if (!pts.length) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (Math.hypot(pts[i][0] - out[out.length - 1][0], pts[i][1] - out[out.length - 1][1]) > eps) out.push(pts[i]);
    }
    return out;
  }
  function mergeSurfacePolylinesAt(a, b, thr) {
    const dPt = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    let best = null;
    for (const ai of [0, a.length - 1]) {
      for (const bi of [0, b.length - 1]) {
        const d = dPt(a[ai], b[bi]);
        if (d < thr && (!best || d < best.d)) best = { ai, bi, d };
      }
    }
    if (!best) return null;
    const anchor = [a[best.ai][0], a[best.ai][1]];
    const aPts = a.map((p) => [p[0], p[1]]);
    const bPts = b.map((p, i) => (i === best.bi ? anchor : [p[0], p[1]]));
    const { ai, bi } = best;
    if (ai === aPts.length - 1 && bi === 0) return dedupeRunPx([...aPts.slice(0, -1), ...bPts]);
    if (ai === aPts.length - 1 && bi === bPts.length - 1) return dedupeRunPx([...aPts.slice(0, -1), ...bPts.slice(0, -1).reverse()]);
    if (ai === 0 && bi === 0) return dedupeRunPx([...aPts.slice(1).reverse(), ...bPts]);
    if (ai === 0 && bi === bPts.length - 1) return dedupeRunPx([...bPts.slice(0, -1), ...aPts.slice(1)]);
    return null;
  }
  // Snap onto peer run endpoints OR any point along a peer segment (T-attach).
  // `thrOverride` — Wall Area live-draw uses a tight radius so corners don't yank from far away.
  // `endpointsOnly` — when dragging a run endpoint, prefer joining at another run's end.
  // `returnMeta` — return { point, shapeId } so callers can auto-join the snapped peer.
  function snapPointToSurfaceEndpoints(sheetKey, condId, excludeId, lx, ly, thrOverride, endpointsOnly = false, returnMeta = false) {
    const thr = thrOverride != null ? thrOverride : surfaceJoinThr();
    const tp = panelByKey(sheetKey);
    if (!tp?.img?.w) return null;
    let best = null;
    for (const s of shapesRef.current) {
      if (s.sheet_id !== sheetKey || s.condition_id !== condId || s.measure_role !== "surface_area") continue;
      if (excludeId && s.id === excludeId) continue;
      const pts = s.verts_norm.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
      if (endpointsOnly && pts.length >= 2) {
        for (const p of [pts[0], pts[pts.length - 1]]) {
          const d = Math.hypot(p[0] - lx, p[1] - ly);
          if (d < thr && (!best || d < best.d)) best = { d, point: p, shapeId: s.id };
        }
        continue;
      }
      const hit = nearestPointOnPolylinePx(pts, lx, ly);
      if (hit && hit.d < thr && (!best || hit.d < best.d)) best = { ...hit, shapeId: s.id };
    }
    if (!best) return null;
    return returnMeta ? { point: best.point, shapeId: best.shapeId } : best.point;
  }
  // Custom cutout linear — snap ONLY to the selected wall_area perimeter (closed ring).
  function snapPointToWallAreaLine(shapeId, stageX, stageY) {
    const wall = shapesRef.current.find((s) => s.id === shapeId);
    if (!wall || wall.measure_role !== "wall_area") return null;
    const tp = panelByKey(wall.sheet_id);
    if (!tp?.img?.w) return null;
    const lx = stageX - tp.xOffset, ly = stageY;
    const pts = (wall.verts_norm || []).map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
    if (pts.length < 2) return null;
    const closed = pts.length >= 3
      && (Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) > 0.5);
    const ring = closed ? [...pts, pts[0]] : pts;
    const thr = 8 / tfRef.current.scale;
    const hit = nearestPointOnPolylinePx(ring, lx, ly);
    if (!hit || hit.d > thr) return null;
    return [hit.point[0] + tp.xOffset, hit.point[1]];
  }
  // Cut Out (deduct) — sticky snap onto wall area / wall run lines only (not PDF vectors).
  function snapDeductToWallLine(stageX, stageY, thrPx = 18) {
    const thr = thrPx / (tfRef.current.scale || 1);
    const sp = panelAt(stageX);
    if (!sp?.img?.w) return null;
    const lx = stageX - sp.xOffset, ly = stageY;
    const walls = shapesRef.current.filter((s) =>
      s.sheet_id === sp.key
      && (s.measure_role === "wall_area" || s.measure_role === "surface_area")
      && (s.verts_norm || []).length >= 2);
    if (!walls.length) return null;
    const preferred = selectedId ? walls.find((s) => s.id === selectedId) : null;
    const ordered = preferred ? [preferred, ...walls.filter((s) => s.id !== preferred.id)] : walls;
    let best = null;
    for (const wall of ordered) {
      const pts = wall.verts_norm.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
      const closed = wall.measure_role === "wall_area" && pts.length >= 3
        && (Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) > 0.5);
      const ring = closed ? [...pts, pts[0]] : pts;
      const hit = nearestPointOnPolylinePx(ring, lx, ly);
      if (!hit || hit.d > thr) continue;
      if (!best || hit.d < best.d) best = { d: hit.d, point: [hit.point[0] + sp.xOffset, hit.point[1]] };
    }
    return best ? best.point : null;
  }
  function chainSurfacePolylines(polys, thr) {
    let chains = polys.map((p) => p.map((q) => [q[0], q[1]]));
    let changed = true;
    let guard = 0;
    while (changed && chains.length > 1 && guard++ < 64) {
      changed = false;
      outer: for (let i = 0; i < chains.length; i++) {
        for (let j = i + 1; j < chains.length; j++) {
          const merged = mergeSurfacePolylinesAt(chains[i], chains[j], thr);
          if (!merged) continue;
          chains = [...chains.slice(0, i), ...chains.slice(i + 1, j), ...chains.slice(j + 1), merged];
          changed = true;
          break outer;
        }
      }
    }
    return chains;
  }
  function surfaceRunsNear(a, b, thr) {
    const dPt = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const ae = [a[0], a[a.length - 1]], be = [b[0], b[b.length - 1]];
    for (const pa of ae) for (const pb of be) {
      if (dPt(pa, pb) < thr) return true;
    }
    return false;
  }
  // Merge 2+ touching surface_area runs on the same sheet/condition into one polyline.
  function tryMergeSurfaceRun(primaryId) {
    const primary = shapesRef.current.find((s) => s.id === primaryId);
    if (!primary || primary.measure_role !== "surface_area") return false;
    const tp = panelByKey(primary.sheet_id);
    if (!tp?.img?.w) return false;
    const thr = surfaceJoinThr();
    const toPx = (s) => s.verts_norm.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
    const peers = shapesRef.current.filter((s) =>
      s.sheet_id === primary.sheet_id
      && s.condition_id === primary.condition_id
      && s.measure_role === "surface_area");
    const cluster = [];
    const used = new Set();
    const queue = [primary];
    while (queue.length) {
      const cur = queue.pop();
      if (used.has(cur.id)) continue;
      used.add(cur.id);
      cluster.push(cur);
      const curPx = toPx(cur);
      for (const s of peers) {
        if (used.has(s.id)) continue;
        const pts = toPx(s);
        if (pts.length >= 2 && surfaceRunsNear(curPx, pts, thr)) queue.push(s);
      }
    }
    if (cluster.length < 2) return false;
    const pxById = new Map(cluster.map((s) => [s.id, toPx(s)]));
    const chained = chainSurfacePolylines([...pxById.values()], thr);
    const mergedPts = chained[0];
    if (!mergedPts || mergedPts.length < 2) {
      const aligned = shapesRef.current.map((s) => {
        const px = pxById.get(s.id);
        if (!px) return s;
        const vn = px.map(([x, y]) => [x / tp.img.w, y / tp.img.h]);
        const next = { ...s, verts_norm: vn };
        return { ...next, computed: recomputeShape(next) };
      });
      shapesRef.current = aligned;
      setShapes(aligned);
      selectShape(primaryId);
      setSelVert(null);
      return false;
    }
    const keep = cluster.find((s) => s.id === primaryId)
      || cluster.slice().sort((a, b) => (b.verts_norm?.length || 0) - (a.verts_norm?.length || 0))[0];
    const others = cluster.filter((s) => s.id !== keep.id);
    const vn = mergedPts.map(([x, y]) => [x / tp.img.w, y / tp.img.h]);
    const openings = [
      ...(keep.openings || []),
      ...others.flatMap((s) => s.openings || []),
    ];
    const fallbackH = defaultWallHeightFt(keep, Number(condById[keep.condition_id]?.height_ft) || 0);
    const mergedSegH = concatSegmentHeightsForMerge(cluster, condById, vn.length - 1, fallbackH);
    const drop = new Set(others.map((s) => s.id));
    const nextShapes = shapesRef.current
      .filter((s) => !drop.has(s.id))
      .map((s) => {
        if (s.id !== keep.id) return s;
        const next = withSegmentHeights({ ...s, verts_norm: vn, openings }, mergedSegH);
        return { ...next, computed: recomputeShape(next) };
      });
    shapesRef.current = nextShapes;
    setShapes(nextShapes);
    selectShape(keep.id);
    setSelVert(null);
    const upp = uppFor(primary.sheet_id) || 0;
    const h = keep.height_override === true
      ? Number(keep.height_ft) || 0
      : Number(keep.height_ft) || Number(condById[keep.condition_id]?.height_ft) || 0;
    setCommitMsg(`Merged ${cluster.length} wall runs into one — ${fl(openLen(mergedPts) * upp)} × ${num(h, 2)}′.`);
    return true;
  }
  function surfaceEndpointJoin(idA, idB) {
    const a = shapesRef.current.find((s) => s.id === idA);
    const b = shapesRef.current.find((s) => s.id === idB);
    if (!a || !b || a.measure_role !== "surface_area" || b.measure_role !== "surface_area") return false;
    if (a.sheet_id !== b.sheet_id || a.condition_id !== b.condition_id) return false;
    const tp = panelByKey(a.sheet_id);
    if (!tp?.img?.w) return false;
    const thr = surfaceJoinThr();
    const toPx = (s) => s.verts_norm.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
    const aPx = toPx(a), bPx = toPx(b);
    if (aPx.length < 2 || bPx.length < 2) return false;
    const dPt = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    for (const pa of [aPx[0], aPx[aPx.length - 1]]) for (const pb of [bPx[0], bPx[bPx.length - 1]]) {
      if (dPt(pa, pb) < thr) return true;
    }
    return false;
  }
  function tryCloseSurfaceLoopAtEndpoints(shapeId) {
    const s = shapesRef.current.find((x) => x.id === shapeId);
    if (!s || s.measure_role !== "surface_area" || s.origin?.closed_loop) return false;
    const tp = panelByKey(s.sheet_id);
    const vn = s.verts_norm || [];
    if (!tp?.img?.w || vn.length < 3) return false;
    const w = tp.img.w, h = tp.img.h;
    const d = Math.hypot((vn[0][0] - vn[vn.length - 1][0]) * w, (vn[0][1] - vn[vn.length - 1][1]) * h);
    if (d >= surfaceJoinThr()) return false;
    const next = shapesRef.current.map((sh) => {
      if (sh.id !== shapeId) return sh;
      const updated = { ...sh, origin: { ...(sh.origin || {}), closed_loop: true } };
      return { ...updated, computed: recomputeShape(updated) };
    });
    shapesRef.current = next;
    setShapes(next);
    return true;
  }
  // Join two separate wall runs — connect at endpoints only; geometry of each run stays intact.
  function joinSurfaceRuns(idA, idB) {
    const a = shapesRef.current.find((s) => s.id === idA);
    const b = shapesRef.current.find((s) => s.id === idB);
    if (!a || !b || a.measure_role !== "surface_area" || b.measure_role !== "surface_area") return false;
    if (a.sheet_id !== b.sheet_id || a.condition_id !== b.condition_id) return false;
    const tp = panelByKey(a.sheet_id);
    if (!tp?.img?.w) return false;
    const thr = surfaceJoinThr();
    const dPt = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const toPx = (s) => s.verts_norm.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
    let aPx = toPx(a), bPx = toPx(b);
    if (aPx.length < 2 || bPx.length < 2) return false;
    let best = null;
    for (const ai of [0, aPx.length - 1]) {
      for (const bi of [0, bPx.length - 1]) {
        const d = dPt(aPx[ai], bPx[bi]);
        if (d < thr && (!best || d < best.d)) best = { ai, bi, d };
      }
    }
    if (!best) return false;
    const anchor = [aPx[best.ai][0], aPx[best.ai][1]];
    aPx[best.ai] = anchor;
    bPx[best.bi] = anchor;
    const newAVn = aPx.map(([x, y]) => [x / tp.img.w, y / tp.img.h]);
    const newBVn = bPx.map(([x, y]) => [x / tp.img.w, y / tp.img.h]);
    const next = shapesRef.current.map((s) => {
      if (s.id === idA) {
        const n = { ...s, verts_norm: newAVn };
        return { ...n, computed: recomputeShape(n) };
      }
      if (s.id === idB) {
        const n = { ...s, verts_norm: newBVn };
        return { ...n, computed: recomputeShape(n) };
      }
      return s;
    });
    shapesRef.current = next;
    setShapes(next);
    tryMergeSurfaceRun(idA);
    for (const s of shapesRef.current) {
      if (s.sheet_id === a.sheet_id && s.condition_id === a.condition_id && s.measure_role === "surface_area") {
        if (tryCloseSurfaceLoopAtEndpoints(s.id)) break;
      }
    }
    return true;
  }

  // Surface Area / Wall Area — open linear wall run in plan; SF = traced LF × H.
  function commitSurface(points) {
    if (points.length < 2) return;
    const tp = panelAt(points[0][0]);
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const h = Number(aCond?.height_ft) || 0;
    if (!(h > 0)) { setCommitMsg(`Set a height for ${aCond?.finish_tag || "this condition"} (H in the condition editor) — Wall Area = traced LF × height.`); return; }
    let local = points.map(([x, y]) => [x - tp.xOffset, y]);
    const snappedPeerIds = new Set();
    for (const idx of [0, local.length - 1]) {
      // Wall Area: keep the same tight draw thr so finish doesn't yank ends to far corners.
      const joinThr = tool === "wallarea" ? (12 / tfRef.current.scale) : undefined;
      const epOnly = tool === "wallarea";
      const hit = snapPointToSurfaceEndpoints(tp.key, activeCond, null, local[idx][0], local[idx][1], joinThr, epOnly, tool === "wallarea");
      if (hit?.point) {
        local[idx] = [hit.point[0], hit.point[1]];
        if (hit.shapeId) snappedPeerIds.add(hit.shapeId);
      } else if (hit && !hit.shapeId) {
        local[idx] = [hit[0], hit[1]];
      }
    }
    const isLoop = tool === "wallarea" && wallAreaLoopCloseRef.current && local.length >= 3;
    wallAreaLoopCloseRef.current = false;
    const segN = isLoop ? local.length : Math.max(0, local.length - 1);
    const segH = Array(segN).fill(h);
    const draft = {
      sheet_id: tp.key, condition_id: activeCond, measure_role: "surface_area", height_ft: h,
      verts_norm: local.map(([x, y]) => [x / tp.img.w, y / tp.img.h]),
      ...(segN > 0 ? { segment_heights_ft: segH } : {}),
      ...(activeLabel ? { label: activeLabel } : {}),
      origin: { method: "manual", ...(segN > 0 ? { segment_heights_ft: segH } : {}), ...(isLoop ? { closed_loop: true } : {}) },
    };
    const beforeIds = new Set(shapesRef.current.map((s) => s.id));
    const res = dispatchShape({ type: "add", shapes: [{
      ...draft,
      computed: recomputeShape(draft),
    }] });
    const added = res.shapes.find((s) => !beforeIds.has(s.id) && s.measure_role === "surface_area");
    // Wall Area: auto-join only when an endpoint snapped to a peer run (completing a loop after separate).
    // Other runs stay separate — no blind merge on Enter.
    if (added && tool === "wallarea" && snappedPeerIds.size) {
      let primaryId = added.id;
      for (const peerId of snappedPeerIds) {
        if (peerId === primaryId) continue;
        if (surfaceEndpointJoin(primaryId, peerId)) joinSurfaceRuns(primaryId, peerId);
        if (shapesRef.current.some((s) => s.id === primaryId)) continue;
        const merged = shapesRef.current.find((s) =>
          s.sheet_id === tp.key && s.condition_id === activeCond && s.measure_role === "surface_area" && snappedPeerIds.has(s.id));
        if (merged) primaryId = merged.id;
      }
    } else if (added && tool !== "wallarea") tryMergeSurfaceRun(added.id);
  }
  function commitCount(p) {
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const tp = panelAt(p[0]);
    dispatchShape({ type: "add", shapes: [{
      sheet_id: tp.key, condition_id: activeCond, measure_role: "count",
      verts_norm: [[(p[0] - tp.xOffset) / tp.img.w, p[1] / tp.img.h]], computed: { count: 1 }, ...(activeLabel ? { label: activeLabel } : {}), origin: { method: "manual" },
    }] });
  }

  // ── One-Click Area — click inside a room; the linework bounds it ──────────
  // Flood-fill on a downscaled raster of THIS panel's vector segments (the same
  // op-list walk that feeds snap), traced + RDP-simplified, vertices snapped to
  // true PDF endpoints. Clicks accumulate a PROPOSAL the estimator reviews:
  // click = add a space, ⌥-click = carve an enclosed cutout (column/shaft) —
  // a carve must sit INSIDE a selected space, and mints a deduct. Nothing is a
  // takeoff until Create (⏎) — the gate where provenance is minted (origin on
  // each shape). Mask + proposal live in panel-LOCAL px; a proposal is bound to
  // one panel and dies on sheet change (render effect resets it).
  function ensureMask(key) {
    let mo = maskCacheRef.current.get(key);
    if (!mo) {
      const segs = vectorSegsRef.current.get(key);
      const dims = panelImgs[key];
      if (!segs || !segs.length || !dims?.w) return null;
      mo = buildMask(segs, dims.w, dims.h, MASK_MAX_DIM, segMetaRef.current.get(key));
      maskCacheRef.current.set(key, mo);
    }
    return mo;
  }
  // Scan-pixel mask for sheets with no usable linework: a fresh dedicated pdf.js
  // render at mask scale — NEVER the panel canvas (dark mode bakes an inversion
  // into those pixels, and a hi-res panel is a 100MB+ readback) — thresholded by
  // rastermask.ts. Cached as a promise so concurrent clicks share one render.
  function ensureRasterMask(key) {
    let pr = rasterMaskCacheRef.current.get(key);
    if (!pr) {
      const pageObj = pageObjsRef.current.get(key), dims = panelImgs[key];
      if (!pageObj || !dims?.w) return Promise.resolve(null);
      const rs = renderScalesRef.current.get(key) || RENDER_SCALE;
      const ws = Math.min(1, MASK_MAX_DIM / Math.max(dims.w, dims.h, 1));
      const mw = Math.max(2, Math.ceil(dims.w * ws)), mh = Math.max(2, Math.ceil(dims.h * ws));
      // distinct namespace from the panel's own renderTasksRef entry (keyed by
      // `key` alone) so registering this task can't clobber — or get clobbered
      // by — the panel's primary render; group-switch cleanup cancels both.
      const taskKey = `${key}:raster`;
      pr = (async () => {
        const cv = document.createElement("canvas");
        cv.width = mw; cv.height = mh;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("2d canvas context unavailable"); // caught below like any other render failure — clear message over a cryptic null-deref
        const rt = pageObj.render({ canvasContext: ctx, viewport: pageObj.getViewport({ scale: rs * ws }), background: "#ffffff" });
        renderTasksRef.current.set(taskKey, rt);
        try {
          await rt.promise;
        } finally {
          renderTasksRef.current.delete(taskKey);
        }
        const px = ctx.getImageData(0, 0, mw, mh);
        cv.width = cv.height = 0;   // drop the backing store
        return buildRasterMask(px.data, mw, mh, ws);
      })().catch(() => {
        // A rejection here (pdf.js render failure — worker restart, a lazily-
        // fetched embedded image erroring; getImageData allocation failure
        // under memory pressure; a buildRasterMask throw) must NOT be cached
        // as a resolved-null forever — that would make every future click on
        // this sheet show the permanent failure message even though a retry
        // would succeed. Evict so the next ensureRasterMask call rebuilds.
        rasterMaskCacheRef.current.delete(key);
        return null;
      });
      rasterMaskCacheRef.current.set(key, pr);
    }
    return pr;
  }
  // Build one-click region(s) from a flood result — the trace/snap/metrics
  // core shared VERBATIM by the stage path (proposeRegion) and the voice-deixis
  // direct-commit path (settleRegion), so an aimed utterance and an aimed click
  // can never trace differently. Raster differences: a looser RDP eps (scan
  // contours wobble) and NO vertex snapping — there are no true endpoints on a
  // scan, and pulling room corners onto the title-block's vector corners would
  // corrupt the ring. Positive clicks also auto-carve enclosed islands
  // (vanity/toilet/column) as neg cutouts. null = no scale, or ring collapsed.
  function buildOneClickRegions(f, tp, local, negative, raster) {
    const upp = uppFor(tp.key);
    if (!upp) return null;
    const eps = raster ? RASTER_RDP_EPS : 1.5;
    const snapRing = (ring) => {
      if (raster) return ring;
      const grid = snapGridsRef.current.get(tp.key);
      return snapVertices(ring, (x, y, d) => (grid ? nearestSnap(grid, x, y, d) : null), 7);
    };
    const mk = (kind, ring, seed, autoCutout) => {
      if (ring.length < 3) return null;
      const poly = snapRing(ring);
      if (poly.length < 3) return null;
      return {
        kind,
        seed,
        poly,
        poly0: poly.map(([x, y]) => [x, y]),
        ...(!raster && fillSens !== SENS_BALANCED ? { sens: fillSens } : {}),
        area_sf: +(ringArea(poly) * upp * upp).toFixed(2),
        perim_lf: +(closedMetrics(poly).perim * upp).toFixed(2),
        hf: !!f.hatchFiltered,
        rt: !!raster,
        os: !!f.openingsSealed,
        ...(autoCutout ? { autoCutout: true } : {}),
      };
    };
    if (negative) {
      const ring = snapRing(traceRegion(f, eps));
      const region = mk("neg", ring, local, false);
      return region ? [region] : null;
    }
    const { outer, holes } = traceRegionWithHoles(f, { upp, epsMaskPx: eps });
    const pos = mk("pos", outer, local, false);
    if (!pos) return null;
    const out = [pos];
    for (const hole of holes) {
      // seed = hole centroid (panel-local) so provenance / dedup have a point inside
      let sx = 0, sy = 0;
      for (const [x, y] of hole) { sx += x; sy += y; }
      const seed = [sx / hole.length, sy / hole.length];
      const neg = mk("neg", hole, seed, true);
      if (neg) out.push(neg);
    }
    return out;
  }
  // The propose tail (physical clicks): stage the region(s) for the Create (⏎)
  // gate. Duplicate/carve checks run inside a FUNCTIONAL setProposal so a
  // click racing the first raster render can't clobber state.
  function committedFloorAt(tp, local, condId, negative) {
    const role = negative ? "deduct" : "floor_area";
    const w = tp.img.w, h = tp.img.h;
    if (!(w > 0 && h > 0)) return false;
    const toPx = (norm) => norm.map(([nx, ny]) => [nx * w, ny * h]);
    return shapesRef.current.some((s) => {
      if (s.sheet_id !== tp.key || s.condition_id !== condId || s.measure_role !== role) return false;
      const outer = toPx(s.verts_norm);
      if (!pointInPoly(local[0], local[1], outer)) return false;
      if (s.holes_norm?.some((hole) => pointInPoly(local[0], local[1], toPx(hole)))) return false;
      return true;
    });
  }
  function proposeRegion(f, tp, local, negative, raster) {
    const regions = buildOneClickRegions(f, tp, local, negative, raster);
    if (!regions || !regions.length) {
      if (uppFor(tp.key)) setCommitMsg("Couldn't trace that space — trace it with Area (A).");
      return;
    }
    if (!negative && committedFloorAt(tp, local, activeCond, false)) {
      setCommitMsg("That room is already masked on this condition — pick another space or a different finish.");
      return;
    }
    // Decide accept/dup/carve-reject INSIDE the functional updater, against
    // its own authoritative `prev` — not proposalRef, which only catches up
    // on the next render's passive-effect flush (a macrotask). proposeRegion
    // can resume after an await (the raster path shares a cached
    // ensureRasterMask promise across concurrent clicks on the same panel),
    // and two continuations on that shared promise resume as back-to-back
    // MICROTASK reactions with no render/effect flush able to run in
    // between — so a second click's dedup check would read proposalRef from
    // BEFORE the first click's setProposal landed and wrongly pass.
    //
    // setCommitMsg still must not be called from inside the updater itself
    // — React may invoke it more than once (StrictMode double-invoke, or a
    // discarded concurrent render), and firing a message from inside one
    // would announce a decision that never lands. So the verdict is stashed
    // in this scope-local `outcome` var (a plain reassignment, not a
    // setState call) and acted on AFTER setProposal returns.
    //
    // That read is wrapped in flushSync rather than just trusted to be
    // synchronous: React's "run the updater eagerly, at dispatch time" fast
    // path is an internal bail-out optimization, not a public guarantee, and
    // it does NOT reliably apply here — proposeRegion's raster call always
    // resumes from a promise continuation (after `await ensureRasterMask`),
    // never a discrete DOM event, so React defers the updater to the next
    // render instead of running it inline (confirmed against the real
    // shared-promise race in this file: `outcome` read back as undefined
    // every time, in both dev and a production build, with or without a
    // second racing click). flushSync forces that render to happen, and
    // this updater to run, before setProposal returns, so `outcome` is
    // always populated by the time it's read below — for the ordinary
    // single-click case AND for two clicks racing the same shared promise
    // (the second call's setProposal, and its read of `outcome`, still runs
    // strictly after the first call's flushSync has fully committed).
    const primary = regions[0];
    const autoCutouts = regions.filter((r) => r.autoCutout).length;
    let outcome;
    flushSync(() => {
      setProposal((prev) => {
        const rs = prev && prev.key === tp.key ? prev.regions : [];
        if (rs.some((r) => r.kind === primary.kind && pointInPoly(local[0], local[1], r.poly))) {
          outcome = "dup";
          return prev;
        }
        if (negative && !rs.some((r) => r.kind === "pos" && pointInPoly(local[0], local[1], r.poly))) {
          outcome = "needsPos";
          return prev;
        }
        // Skip auto-cutouts that already sit inside an existing neg, or whose
        // seed isn't inside any pos we're keeping (including the new primary).
        // Overlapping same-kind regions coalesce into one ring (multi-click
        // partial fills → a single space / cutout), not a stack of duplicates.
        const merged = [...rs];
        const uppNow = uppFor(tp.key) || 0;
        const absorb = (region) => {
          const parts = [region.poly];
          let wasAuto = !!region.autoCutout;
          let any = false;
          // Fold every same-kind region that overlaps the growing union (transitive).
          for (;;) {
            const hit = [];
            for (let i = 0; i < merged.length; i++) {
              if (merged[i].kind !== region.kind) continue;
              if (parts.some((p) => polygonsOverlap(merged[i].poly, p))) hit.push(i);
            }
            if (!hit.length) break;
            any = true;
            for (const i of hit) {
              parts.push(merged[i].poly);
              if (merged[i].autoCutout) wasAuto = true;
            }
            for (let k = hit.length - 1; k >= 0; k--) merged.splice(hit[k], 1);
          }
          if (!any) { merged.push(region); return false; }
          const uni = unionPolygons(parts);
          if (!uni || uni.length < 3) { merged.push(region); return false; }
          const area_sf = +(ringArea(uni) * uppNow * uppNow).toFixed(2);
          const perim_lf = +(closedMetrics(uni).perim * uppNow).toFixed(2);
          merged.push({
            ...region,
            poly: uni,
            poly0: uni.map(([x, y]) => [x, y]),
            area_sf,
            perim_lf,
            seed: region.seed,
            ...(wasAuto ? { autoCutout: true } : {}),
          });
          return true;
        };
        const posPolys = () => merged.filter((r) => r.kind === "pos").map((r) => r.poly);
        let didMerge = false;
        for (const region of regions) {
          if (region.kind === "pos") {
            if (absorb(region)) didMerge = true;
            continue;
          }
          if (merged.some((r) => r.kind === "neg" && pointInPoly(region.seed[0], region.seed[1], r.poly))) continue;
          if (!posPolys().some((poly) => pointInPoly(region.seed[0], region.seed[1], poly))) continue;
          if (absorb(region)) didMerge = true;
        }
        // Drop cutouts whose seed no longer sits in any remaining pos (e.g. a
        // merged pos no longer covers an old auto-carve).
        for (let i = merged.length - 1; i >= 0; i--) {
          const r = merged[i];
          if (r.kind !== "neg") continue;
          if (!posPolys().some((poly) => pointInPoly(r.seed[0], r.seed[1], poly))) merged.splice(i, 1);
        }
        outcome = didMerge ? "merged" : "added";
        return { key: tp.key, regions: merged };
      });
    });
    if (outcome === "dup") setCommitMsg(negative ? "That cutout is already carved." : "Already selected — ⌥-click carves an enclosed cutout; ⏎ creates.");
    else if (outcome === "needsPos") setCommitMsg("⌥-click carves an enclosed area INSIDE the selection (a column or shaft) — click its room first.");
    else if (outcome === "merged") setCommitMsg("Merged overlapping selection into one — review, then ⏎ creates.");
    else if (!negative && autoCutouts > 0) setCommitMsg(`Auto-carved ${autoCutouts} cutout${autoCutouts === 1 ? "" : "s"} (fixture/column) — review, then ⏎ creates.`);
    else setCommitMsg("");
  }
  // `direct` (voice deixis, RFC #59): { conditionId, label } — the human aimed
  // the crosshair, so the flood COMMITS in one step through settleRegion →
  // commitOneClickRegions (the same gate ⏎ drives) instead of staging a
  // proposal, and every exit returns { ok, message } so the voice outcome can
  // speak it — a deixis trace never no-ops silently. The condition rides BY
  // VALUE because the utterance armed it in this same handler (the activeCond
  // closure is a render behind). Click callers ignore the return value; their
  // message surface stays setCommitMsg, unchanged.
  async function oneClickAt(p, negative, direct) {
    const say = (message) => { setCommitMsg(message); return { ok: false, message }; };
    const tp = panelAt(p[0]);
    const upp = uppFor(tp.key);
    if (!upp) return say(`Set the scale for ${labelFor(tp)} first.`);
    if (!(direct ? direct.conditionId : activeCond)) return say("Pick or add a condition first.");
    // a click may EXTEND a same-sheet proposal; voice deixis commits whole and
    // must never swallow a selection the human is still reviewing — ANY pending
    // proposal rejects the utterance
    if (proposal && (direct || proposal.key !== tp.key)) {
      return say(direct
        ? "Finish the pending one-click selection first — ⏎ creates it, Esc discards."
        : `Finish the selection on ${labelFor(panelByKey(proposal.key))} first — ⏎ creates it, Esc discards.`);
    }
    const local = [p[0] - tp.xOffset, p[1]];
    // Trigger policy: vector is exact and always wins where it works — including
    // the fork's hatch escalation (fillSens), which runs untouched here. The
    // raster path engages only where vectors can't bound the room — a scan
    // wrapper (big placed image, near-zero linework) runs raster PRIMARY; a
    // mixed sheet (big image UNDER real linework) retries on pixels only after
    // the vector flood fails. A pure-vector sheet never touches pixels.
    const stats = sheetStatsRef.current.get(tp.key);
    const rasterEligible = !!stats && stats.imageFrac >= RASTER_MIN_IMG_FRAC;
    const vectorViable = !!stats && stats.segCount >= RASTER_MIN_SEGS;
    if (!rasterEligible || vectorViable) {
      const mo = ensureMask(tp.key);
      if (!mo && !rasterEligible) return say("Still reading this sheet's linework — try again in a second.");
      if (mo) {
        const gap = openingGapPx(upp, mo.ws);
        const f = floodRegionSealed(mo, local[0], local[1], fillSens, gap);
        if (f.status === "ok") return settleRegion(f, tp, local, negative, false, direct);
        if (!rasterEligible) {
          return say(f.status === "leak"
            ? "That space isn't enclosed on the plan linework — the fill spilled past a gap wider than a door/window. Click a more enclosed spot, or trace it with Area (A)."
            : "Landed in dense linework (hatching/text). Zoom in and click an open spot, or trace it with Area (A).");
        }
      }
    }
    setCommitMsg("Reading the scan…");
    const seq = renderSeqRef.current;
    const rmo = await ensureRasterMask(tp.key);
    if (seq !== renderSeqRef.current) {   // sheet group changed mid-render — the new sheet must not be left showing a stale "Reading the scan…" ("…" messages never auto-expire, see commitMsg's 6s-timer effect
      setCommitMsg("");
      return direct
        ? say("Couldn't place that — the sheet changed while reading the scan. Say it again.")
        : { ok: false, message: "" };
    }
    // The raster render can take real time on a large scan; the user may have
    // switched tools or started a DIFFERENT panel's proposal while it was in
    // flight. renderSeq alone only catches a sheet-GROUP change — re-validate
    // against the LIVE tool/proposal (refs, not the closed-over `tool`/
    // `proposal` — this is an async continuation resuming after other renders)
    // so a late raster result can never silently replace another panel's
    // in-progress proposal or paint a ghost selection in the wrong tool.
    // Voice (direct) is modeless — no tool check — but a proposal appearing
    // mid-await means the human started clicking; the utterance yields loudly
    // rather than race the hand.
    if (direct ? proposalRef.current : (toolRef.current !== "oneclick" || (proposalRef.current && proposalRef.current.key !== tp.key))) {
      setCommitMsg("");
      return direct
        ? say("Couldn't place that — a one-click selection started while reading the scan. Finish it (⏎/Esc), then say it again.")
        : { ok: false, message: "" };
    }
    if (!rmo) return say("Couldn't read this scan — trace it with Area (A).");
    // The raster mask is single-tier (softCount 0), so hatch escalation — and
    // with it the Fill sensitivity knob — is structurally inert on scans.
    // Opening seal still applies: same door/window gap policy as the vector path.
    const gap = openingGapPx(upp, rmo.ws);
    const f = floodRegionSealed(rmo, local[0], local[1], SENS_BALANCED, gap);
    if (f.status !== "ok") {
      return say(f.status === "leak"
        ? "That space isn't enclosed on the scan — the fill escaped through a gap wider than a door/window (faded line or open doorway). Click a more enclosed spot, or trace it with Area (A)."
        : "Landed on dense scan ink (text or hatching). Zoom in and click an open spot, or trace it with Area (A).");
    }
    return settleRegion(f, tp, local, negative, true, direct);
  }
  // After a successful flood: a physical click STAGES the region for the
  // ⏎/dblclick Create gate; a voice-deixis trace (direct) COMMITS it now —
  // same builder, same commit gate, no preview-then-Enter. The spoken
  // imperative IS the confirmation (RFC #59 who-aimed-it rule).
  function settleRegion(f, tp, local, negative, raster, direct) {
    if (!direct) { proposeRegion(f, tp, local, negative, raster); return { ok: true, message: "" }; }
    const regions = buildOneClickRegions(f, tp, local, negative, raster);
    if (!regions || !regions.length) return { ok: false, message: "Couldn't trace that space — trace it with Area (A)." };
    return commitOneClickRegions({ key: tp.key, regions }, direct);
  }
  // The ONE commit gate for one-click regions — the ⏎/dblclick Create AND a
  // voice-deixis trace both land here, so human-aimed work gets exactly one
  // origin shape (one_click_v1, reviewed) and one undo path. `direct` (voice)
  // pins { conditionId, label } from the utterance BY VALUE — the arming
  // setState hasn't rendered, so the activeCond/activeLabel closures are one
  // render behind (the updateCondition-by-id precedent in voiceActions).
  function commitOneClickRegions(prop, direct, opts = {}) {
    const tp = panelByKey(prop.key);
    const condId = direct ? direct.conditionId : activeCond;
    const label = direct && direct.label !== undefined ? direct.label : (activeLabel || undefined);
    if (!opts.forceMerge) {
      const overlapRegions = prop.regions.filter((r) => {
        const role = r.kind === "neg" ? "deduct" : "floor_area";
        return overlapVictimsFor(r.poly, prop.key, condId, role).length > 0;
      });
      if (overlapRegions.length) {
        setOverlapPrompt({
          source: "oneclick",
          prop, direct, condId,
          tag: (condById[condId] || agentStateRef.current.conditions.find((c) => c.id === condId))?.finish_tag || "this condition",
          count: overlapRegions.length,
        });
        return { ok: false, pending: true, message: "" };
      }
    }
    const made = [];
    for (const r of prop.regions) {
      const role = r.kind === "neg" ? "deduct" : "floor_area";
      if (mergeIntoExistingShapes(r.poly, tp.key, condId, role)) continue;
      made.push({
        sheet_id: tp.key, condition_id: condId,
        measure_role: role,
        verts_norm: r.poly.map(([x, y]) => [x / tp.img.w, y / tp.img.h]),
        computed: { area_sf: r.area_sf, perimeter_lf: r.perim_lf },
        ...(label ? { label } : {}),
        // the provenance receipt: machine-proposed, human-reviewed at the Create
        // gate (voice deixis: the spoken imperative is the review). A handle-
        // corrected region (touched) records the machine's frozen trace (poly0)
        // as proposed_verts_norm — the one-click correction pair; an untouched
        // region's verts ARE the proposal, so nothing extra rides. Post-Create
        // edits are stamped by stampEdit, which freezes the same field from the
        // pre-edit ring only when Create didn't already.
        origin: { method: "one_click_v1", seed_norm: [r.seed[0] / tp.img.w, r.seed[1] / tp.img.h], reviewed: true, ...(r.hf ? { hatch_filtered: true } : {}), ...(r.rt ? { raster_traced: true } : {}), ...(r.os ? { openings_sealed: true } : {}), ...(r.autoCutout ? { auto_cutout: true } : {}), ...(r.sens != null ? { fill_sensitivity: r.sens } : {}), ...(r.touched ? { edited_before_create: true, proposed_verts_norm: r.poly0.map(([x, y]) => [x / tp.img.w, y / tp.img.h]) } : {}) },
      });
    }
    if (made.length) dispatchShape({ type: "add", shapes: made });   // the creation gate — id/created_at minted by the command
    const sf = prop.regions.reduce((n, r) => n + (r.kind === "neg" ? -r.area_sf : r.area_sf), 0);
    // condById is a render closure — a condition minted THIS utterance is only
    // in the live mirror, so fall through to it for the tag
    const tag = (condById[condId] || agentStateRef.current.conditions.find((c) => c.id === condId))?.finish_tag || "";
    const autoN = prop.regions.filter((r) => r.autoCutout).length;
    const cutMsg = autoN ? ` (${autoN} auto-cutout${autoN === 1 ? "" : "s"})` : "";
    const message = `Created ${made.length} takeoff${made.length === 1 ? "" : "s"} — ${fa(sf)} ${tag}${cutMsg}. Click the next room.`;
    setCommitMsg(message);
    return { ok: true, message };
  }
  function createProposal() {
    if (!proposal || !proposal.regions.length) return;
    const res = commitOneClickRegions(proposal);
    if (res?.pending) return; // wait for merge / remove-overlap dialog
    setProposal(null);
  }

  // ── Wall Trace — click wall ink; flood connected network; rooms become holes ─
  function ensureWallMask(key, sensitivity = wallSens) {
    const cacheKey = `${key}:${sensitivity}`;
    let mo = wallMaskCacheRef.current.get(cacheKey);
    if (!mo) {
      const segs = vectorSegsRef.current.get(key);
      const dims = panelImgs[key];
      if (!segs || !segs.length || !dims?.w) return null;
      mo = buildWallMaskFromSegs(segs, dims.w, dims.h, segMetaRef.current.get(key), sensitivity);
      wallMaskCacheRef.current.set(cacheKey, mo);
    }
    return mo;
  }
  function wallNearest(key) {
    const grid = snapGridsRef.current.get(key);
    return (x, y, d) => (grid ? nearestSnap(grid, x, y, d) : null);
  }
  function wallTraceAt(p) {
    const tp = panelAt(p[0]);
    const local = [p[0] - tp.xOffset, p[1]];
    const upp = uppFor(tp.key);
    if (!upp) { setCommitMsg(`Set the scale for ${labelFor(tp)} first.`); return; }
    if (!activeCond) { setCommitMsg("Pick or add a condition first."); return; }
    const h = Number(aCond?.height_ft) || 0;
    if (!(h > 0)) {
      setCommitMsg(`Set a height for ${aCond?.finish_tag || "this condition"} (H in the condition editor) — Wall Trace needs height for face area and volume.`);
      return;
    }
    const mo = ensureWallMask(tp.key, wallSens);
    if (!mo) { setCommitMsg("No vector linework on this sheet — trace walls with Surface Area (S)."); return; }
    const gap = openingGapPx(upp, mo.ws);
    const traced = wallTraceAtPoint(mo, local[0], local[1], {
      upp,
      heightFt: h,
      sensitivity: wallSens,
      nearest: wallNearest(tp.key),
      maxGapMaskPx: gap,
    });
    if (traced.status !== "ok") {
      setCommitMsg(traced.message);
      return;
    }
    const region = {
      seed: local,
      outer: traced.outer,
      holes: traced.holes,
      footprint_sf: traced.quantities.footprint_sf,
      wall_face_sf: traced.quantities.wall_face_sf,
      volume_cf: traced.quantities.volume_cf,
      perimeter_lf: traced.quantities.perimeter_lf,
      hf: !!traced.hatchFiltered,
    };
    setWallProposal((prev) => {
      if (prev && prev.key === tp.key) return { key: tp.key, regions: [...prev.regions, region] };
      return { key: tp.key, regions: [region] };
    });
    setCommitMsg(`Wall network traced — ${fa(region.wall_face_sf)} face · ${fa(region.footprint_sf)} footprint · ${num(region.volume_cf, 1)} CF. ⏎ Create or click another wall island.`);
  }
  function commitWallTrace(prop) {
    const tp = panelByKey(prop.key);
    const condId = activeCond;
    const label = activeLabel || undefined;
    const h = Number(aCond?.height_ft) || 0;
    const made = [];
    for (const r of prop.regions) {
      made.push({
        sheet_id: tp.key,
        condition_id: condId,
        measure_role: "wall_area",
        height_ft: h,
        verts_norm: r.outer.map(([x, y]) => [x / tp.img.w, y / tp.img.h]),
        ...(r.holes?.length ? { holes_norm: r.holes.map((hole) => hole.map(([x, y]) => [x / tp.img.w, y / tp.img.h])) } : {}),
        computed: {
          area_sf: r.wall_face_sf,
          footprint_sf: r.footprint_sf,
          wall_face_sf: r.wall_face_sf,
          volume_cf: r.volume_cf,
          perimeter_lf: r.perimeter_lf,
        },
        ...(label ? { label } : {}),
        origin: {
          method: "wall_trace_v1",
          seed_norm: [r.seed[0] / tp.img.w, r.seed[1] / tp.img.h],
          reviewed: true,
          ...(r.hf ? { hatch_filtered: true } : {}),
        },
      });
    }
    if (made.length) dispatchShape({ type: "add", shapes: made });
    const tag = condById[condId]?.finish_tag || "";
    const face = prop.regions.reduce((n, r) => n + r.wall_face_sf, 0);
    setCommitMsg(`Created ${made.length} wall takeoff${made.length === 1 ? "" : "s"} — ${fa(face)} face ${tag}. Click the next wall network.`);
  }
  function createWallProposal() {
    if (!wallProposal || !wallProposal.regions.length) return;
    commitWallTrace(wallProposal);
    setWallProposal(null);
  }

  // ── One-Click proposal geometry editing — correct a fill BEFORE Create ──────
  // A proposal region's `poly` is panel-LOCAL px (image space of proposal.key,
  // no xOffset — same frame the preview draws in). These reuse the existing
  // recompute idiom (ringArea × upp², closedMetrics) and the endpoint snap grid,
  // so a corrected corner lands on the plan's true linework just like a hand
  // trace. Nothing here commits a takeoff — that's still the Create (⏎) gate.
  const ocMetrics = (poly, key) => {
    const upp = uppFor(key) || 0;
    return { area_sf: +(ringArea(poly) * upp * upp).toFixed(2), perim_lf: +(closedMetrics(poly).perim * upp).toFixed(2) };
  };
  // After a handle drag (or any edit), fold same-kind proposal regions that
  // now share interior into one ring — mirrors the click-time absorb path.
  function coalesceOverlappingProposalRegions(regions, key) {
    let list = regions.slice();
    let changed = false;
    for (;;) {
      let pair = null;
      for (let i = 0; i < list.length && !pair; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[i].kind !== list[j].kind) continue;
          if (!polygonsOverlap(list[i].poly, list[j].poly)) continue;
          pair = [i, j];
          break;
        }
      }
      if (!pair) break;
      const [i, j] = pair;
      const a = list[i], b = list[j];
      const uni = unionPolygons([a.poly, b.poly]);
      if (!uni || uni.length < 3) break;
      const wasAuto = !!(a.autoCutout || b.autoCutout);
      const next = {
        ...a,
        poly: uni,
        poly0: uni.map(([x, y]) => [x, y]),
        ...ocMetrics(uni, key),
        seed: a.seed,
        touched: true,
        ...(wasAuto ? { autoCutout: true } : {}),
      };
      list = list.filter((_, k) => k !== i && k !== j);
      list.push(next);
      changed = true;
    }
    const posPolys = list.filter((r) => r.kind === "pos").map((r) => r.poly);
    const pruned = [];
    for (const r of list) {
      if (r.kind === "neg" && !posPolys.some((poly) => pointInPoly(r.seed[0], r.seed[1], poly))) {
        changed = true;
        continue;
      }
      pruned.push(r);
    }
    return { regions: pruned, changed };
  }
  // `bypass` (true for a raster region/shape) skips nearestSnap entirely — on a
  // scan wrapper the snap grid holds only the placed-image/clip-rect corners
  // and title-block linework (extractVectorGeometry's few real points, not the
  // scan ink), so snapping a dragged raster corner onto it yanks the point
  // onto geometry unrelated to the room being edited. Same rationale
  // proposeRegion already applies to the initial trace — the handles must not
  // reintroduce it.
  const ocSnap = (key, x, y, bypass) => {
    if (bypass) return [x, y];
    const grid = snapGridsRef.current.get(key);
    const hit = grid ? nearestSnap(grid, x, y, 8 / tfRef.current.scale) : null;
    return hit ? [hit[0], hit[1]] : [x, y];
  };
  // Press on a corner (select + arm move), an edge grip (arm whole-line move),
  // or Shift on an edge (insert a new anchor, arm its move). Returns true if the
  // press was consumed. Hit-tests against RAW cursor px (not the snap/angle-
  // adjusted point) so grabbing a handle is never nudged by an unrelated snap.
  function oneClickHandleAt(e) {
    if (tool !== "oneclick" || !proposal) return false;
    // ⌥ is reserved for carving a cutout (oneClickAt) — never let a handle grab
    // swallow it, or an ⌥-click near a room's own corner/edge could never carve.
    if (e.altKey) return false;
    const tp = panelByKey(proposal.key);
    if (!tp || !tp.img.w) return false;
    const raw = toImage(e.clientX, e.clientY);
    const lx = raw[0] - tp.xOffset, ly = raw[1];
    const thr = 8 / tfRef.current.scale;
    const regions = proposal.regions;
    for (let ri = 0; ri < regions.length; ri++) {          // corners win over edges
      const poly = regions[ri].poly;
      for (let i = 0; i < poly.length; i++) {
        if (Math.hypot(poly[i][0] - lx, poly[i][1] - ly) < thr * 1.6) {
          setOcSel({ ri, vi: i });
          ocDragRef.current = { kind: "oc-vertex", ri, vi: i };
          e.currentTarget.setPointerCapture(e.pointerId);
          return true;
        }
      }
    }
    for (let ri = 0; ri < regions.length; ri++) {          // edge midpoints
      const poly = regions[ri].poly;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        if (Math.hypot(mx - lx, my - ly) < thr * 1.5) {
          if (e.shiftKey) {                                  // insert a new anchor, then drag it
            setProposal((pr) => {
              if (!pr) return pr;
              const rgs = pr.regions.map((r, idx) => {
                if (idx !== ri) return r;
                const np = [...r.poly.slice(0, i + 1), [mx, my], ...r.poly.slice(i + 1)];
                return { ...r, poly: np, ...ocMetrics(np, pr.key) };
              });
              return { ...pr, regions: rgs };
            });
            setOcSel({ ri, vi: i + 1 });
            ocDragRef.current = { kind: "oc-vertex", ri, vi: i + 1 };
          } else {                                           // move BOTH endpoints of this line
            ocDragRef.current = { kind: "oc-edge", ri, i, j: (i + 1) % poly.length, oa: a.slice(), ob: b.slice(), sx: lx, sy: ly };
          }
          e.currentTarget.setPointerCapture(e.pointerId);
          return true;
        }
      }
    }
    return false;
  }
  // Live drag: a corner follows the (snapped) cursor; an edge translates both its
  // endpoints by the drag delta, each end snapping independently to the linework.
  function ocDragMove(e) {
    const d = ocDragRef.current;
    const tp = panelByKey(proposal?.key);
    if (!proposal || !tp || !tp.img.w) { ocDragRef.current = null; bumpIdle(); return; }
    const raw = toImage(e.clientX, e.clientY);
    const lx = raw[0] - tp.xOffset, ly = raw[1];
    setProposal((pr) => {
      if (!pr) return pr;
      const regions = pr.regions.map((r, ri) => {
        if (ri !== d.ri) return r;
        let poly;
        if (d.kind === "oc-vertex") {
          const np = ocSnap(pr.key, lx, ly, r.rt);
          poly = r.poly.map((v, i) => (i === d.vi ? np : v));
        } else {
          const dx = lx - d.sx, dy = ly - d.sy;
          const na = ocSnap(pr.key, d.oa[0] + dx, d.oa[1] + dy, r.rt);
          const nb = ocSnap(pr.key, d.ob[0] + dx, d.ob[1] + dy, r.rt);
          poly = r.poly.map((v, i) => (i === d.i ? na : i === d.j ? nb : v));
        }
        // touched = a handle actually moved this region: Create records the
        // frozen poly0 as origin.proposed_verts_norm only for touched regions
        return { ...r, poly, ...ocMetrics(poly, pr.key), touched: true };
      });
      return { ...pr, regions };
    });
  }
  // Reveal handles on the region under the cursor (inside it, or near a corner /
  // edge grip so you can grab a corner to pull it outward). Ref-compared so we
  // only re-render when the hovered region actually changes.
  function ocHoverUpdate(e) {
    const tp = panelByKey(proposal.key);
    let hov = -1;
    if (tp && tp.img.w) {
      const raw = toImage(e.clientX, e.clientY);
      const lx = raw[0] - tp.xOffset, ly = raw[1];
      const near = 14 / tfRef.current.scale;
      for (let ri = 0; ri < proposal.regions.length && hov < 0; ri++) {
        const poly = proposal.regions[ri].poly;
        if (pointInPoly(lx, ly, poly)) { hov = ri; break; }
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          if (Math.hypot(a[0] - lx, a[1] - ly) < near || Math.hypot(mx - lx, my - ly) < near) { hov = ri; break; }
        }
      }
    }
    if (hov !== ocHoverRef.current) { ocHoverRef.current = hov; setOcHover(hov); }
  }
  // Delete just the selected corner (Delete/⌫), keeping a region ≥ 3 points —
  // never collapses the whole space (use ⌫ with nothing selected for that).
  function deleteSelectedOcVertex() {
    if (!ocSel || !proposal) return;
    const r = proposal.regions[ocSel.ri];
    if (!r) { setOcSel(null); return; }
    // Can't thin a triangle further. Deselect so the NEXT ⌫ falls through to the
    // remove-last-region branch — otherwise the ocSel guard keeps re-firing this
    // message and the space can never be dropped without an Esc first.
    if (r.poly.length <= 3) { setOcSel(null); setCommitMsg("A space needs at least 3 points — ⌫ again drops the whole space."); return; }
    setProposal((pr) => {
      if (!pr) return pr;
      const regions = pr.regions.map((rr, ri) => {
        if (ri !== ocSel.ri) return rr;
        const np = rr.poly.filter((_, i) => i !== ocSel.vi);
        // dropping a corner is a pre-Create correction too — same touched flag
        return { ...rr, poly: np, ...ocMetrics(np, pr.key), touched: true };
      });
      return { ...pr, regions };
    });
    setOcSel(null);
  }

  // ── copy / paste / duplicate — "draw once, drop it again", same sheet or the
  // one under the cursor. The clipboard carries verts + provenance, never the old
  // computed numbers: every paste recomputes against the TARGET panel's dims and
  // that sheet's scale (this also fixes the legacy bug where pasting after a
  // rescale kept the stale SF).
  const clipRef = useRef([]);
  // A clone keeps its lineage (method + flags + copied: true) but NEVER the
  // source's seed_norm / proposed_verts_norm: an offset paste would read as a
  // phantom correction (machine trace over here, shape over there). The edits
  // map is deep-copied so a stamp on the clone can't alias the source's tally.
  const cloneOrigin = (o) => {
    if (!o) return {};
    const { seed_norm: _seed, proposed_verts_norm: _pvn, ...rest } = o;
    return { origin: { ...rest, ...(rest.edits ? { edits: { ...rest.edits } } : {}), copied: true } };
  };
  // the clipboard payload for one shape: verts deep-copied, provenance kept,
  // `from` remembers the source sheet so paste knows same-sheet vs cross-sheet
  const clipEntry = (sel) => ({ condition_id: sel.condition_id, measure_role: sel.measure_role,
                                verts_norm: sel.verts_norm.map((v) => [...v]), from: sel.sheet_id, height_ft: sel.height_ft,
                                ...(sel.height_override ? { height_override: true } : {}),
                                ...(Array.isArray(sel.openings) && sel.openings.length
                                  ? { openings: sel.openings.map((o) => ({ ...o, id: o.id || uid("opn") })) }
                                  : {}),
                                ...(sel.label ? { label: sel.label } : {}), ...cloneOrigin(sel.origin) });
  function copySelected() {
    if (shapeIsLocked(selectedId)) return;
    const sel = shapes.find((s) => s.id === selectedId);
    if (!sel) { setCommitMsg("Select a takeoff to copy."); return; }
    clipRef.current = [clipEntry(sel)];
    setCommitMsg("Copied — ⌘V pastes onto the sheet under your cursor.");
  }
  function pasteClipboard(offset = 0.03) {
    if (!clipRef.current.length) return;
    const tp = lastPtrRef.current ? panelAt(toImage(lastPtrRef.current[0], lastPtrRef.current[1])[0]) : focusPanel;
    const needsScale = clipRef.current.some((c) => c.measure_role !== "count");
    if (needsScale && !uppFor(tp.key)) { setCommitMsg(`Set the scale for ${labelFor(tp)} first — paste recomputes SF/LF there.`); return; }
    let cross = false;
    const made = clipRef.current.map((c) => {
      const same = c.from === tp.key;
      cross = cross || !same;
      // same sheet: nudge so the copy is visible; other sheet: same relative spot
      const vn = c.verts_norm.map(([x, y]) => (same ? [Math.min(0.999, x + offset), Math.min(0.999, y + offset)] : [x, y]));
      // != null, not truthy: an overridden height of 0 must survive the paste
      const s = {
        sheet_id: tp.key, condition_id: c.condition_id, measure_role: c.measure_role, verts_norm: vn,
        ...(c.height_ft != null ? { height_ft: c.height_ft } : {}),
        ...(c.height_override ? { height_override: true } : {}),
        ...(Array.isArray(c.openings) && c.openings.length
          ? { openings: c.openings.map((o) => ({ ...o, id: uid("opn") })) }
          : {}),
        ...(c.label ? { label: c.label } : {}), ...cloneOrigin(c.origin),
      };
      return { ...s, computed: recomputeShape(s) };
    });
    // the add command mints id/created_at; a plain add appends, so the minted
    // clones are the array's last N — select the newest one
    const res = dispatchShape({ type: "add", shapes: made });
    selectShape(res.shapes[res.shapes.length - 1].id);
    setLayerPickFromShape(res.shapes[res.shapes.length - 1].id);
    setTool("select");
    setCommitMsg(`Pasted ${made.length} takeoff${made.length === 1 ? "" : "s"}${cross ? ` onto ${labelFor(tp)}` : ""} — drag to position.`);
  }
  function duplicateSelected() {
    const live = shapesRef.current;
    const picks = Object.keys(layerPickIds).filter((id) => live.some((s) => s.id === id));
    const targetIds = picks.length > 0 ? picks : (selectedId ? [selectedId] : []);
    const validIds = targetIds.filter((id) => !shapeIsLocked(id));
    if (!validIds.length) { setCommitMsg("Select a takeoff to duplicate."); return; }
    const targets = live.filter((s) => validIds.includes(s.id));
    clipRef.current = targets.map((s) => clipEntry(s));
    pasteClipboard();
  }
  // Mirror the selected shape about its own bbox center — an isometry, so SF/LF
  // never change. Routes through the same geom/vertex command path as a manual
  // vertex drag, which gives correct undo/redo and provenance stamping for free.
  function flipSelected(axis) {
    const sel = shapes.find((s) => s.id === selectedId);
    if (!sel || shapeIsLocked(selectedId) || !Array.isArray(sel.verts_norm) || sel.verts_norm.length < 2) {
      setCommitMsg("Select an area or linear takeoff to flip."); return;
    }
    const vn = reflectVertsNorm(sel.verts_norm, axis);
    dispatchShape({
      type: "geom", id: sel.id, editKind: "vertex",
      verts_norm: vn, computed: recomputeShape({ ...sel, verts_norm: vn }), prev: geomSnapshot(sel),
    });
  }
  function subtractSelectedShapes() {
    const live = shapesRef.current;
    const picks = Object.keys(layerPickIds).filter((id) => live.some((s) => s.id === id));
    const targetIds = picks.length > 1 ? picks : (selectedId ? [selectedId] : []);
    if (targetIds.length < 2) {
      setCommitMsg("Select at least 2 overlapping shapes to subtract.");
      return;
    }
    const selected = live.filter((s) => targetIds.includes(s.id) && !shapeIsLocked(s.id));
    if (selected.length < 2) return;

    // Sort by area descending — base is the largest polygon, cutters are the smaller ones
    const sorted = [...selected].sort((a, b) => (b.computed?.area_sf || 0) - (a.computed?.area_sf || 0));
    const base = sorted[0];
    const cutters = sorted.slice(1);

    const sp = panelByKey(base.sheet_id);
    if (!sp?.img?.w || !sp?.img?.h) return;

    let holes_norm = base.holes_norm ? base.holes_norm.map((h) => h.map((v) => [...v])) : [];
    const toDeleteIds = [];

    for (const cutter of cutters) {
      if (cutter.sheet_id !== base.sheet_id) continue;
      // Add cutter ring to base's holes
      holes_norm.push(cutter.verts_norm.map((v) => [...v]));
      toDeleteIds.push(cutter.id);
    }

    if (toDeleteIds.length) {
      // 1. Update base shape with holes
      dispatchShape({
        type: "geom",
        id: base.id,
        editKind: "vertex",
        verts_norm: base.verts_norm,
        holes_norm,
        computed: recomputeShape({ ...base, holes_norm }),
        prev: geomSnapshot(base),
      });
      // 2. Delete the cutter shapes
      dispatchShape({ type: "delete", ids: toDeleteIds });
      // 3. Keep base shape selected
      selectShape(base.id);
      setCommitMsg(`Subtracted ${toDeleteIds.length} void${toDeleteIds.length === 1 ? "" : "s"} from ${base.room || "area"}`);
    }
  }
  // ── markup (cloud / callout / text) — annotations, not measurements ─────────
  // markupDraft holds STAGE px (so the live preview spans panels); a markup
  // belongs to the panel of its FIRST click and normalizes against that panel.
  function addMarkup(m, key) {
    // created_at rides the defaults so every markup path (hand-drawn, cloud's
    // pre-minted id, stamp instances) is stamped at this single creation gate
    setMarkups((ms) => [...ms, { id: uid("mk"), created_at: nowIso(), sheet_id: key, rfi_id: "", ...m }]);
    // Drawing a markup by hand surfaces the Markups tab. But a STAMP places several
    // markups via addMarkup — don't yank the user off the Stamps tab mid-placement
    // (keep the current tab, or open Markups only if nothing's open). Highlighter
    // ink flows stroke after stroke — never pop the dock per stroke.
    if (m.type === "highlight" && m.pts) return;
    setLeftTab((t) => (tool === "stamp" ? (t ?? "markup") : "markup"));
  }
  // Marked-set PDF: every sheet carrying takeoffs/markups, work burned in as
  // drawn, legend cover with net totals — built fully in the browser
  // (lib/markedset.js). Exports in the CURRENT view: dark canvas → dark PDF.
  // includeMarkups (from the ReportPanel checkbox, default true) is ORTHOGONAL to
  // the canvas layer-hide (showMarkups): only this flag drops markups from the
  // PDF. Off → pass []; the RFI-only export still works (empty-guard unaffected).
  async function exportMarkedSet(includeMarkups = true) {
    try {
      setCommitMsg("Building the marked set…");
      const exportMarkups = includeMarkups ? markups : [];
      const keys = [...new Set([...shapes.map((s) => s.sheet_id), ...exportMarkups.map((m) => m.sheet_id)])];
      const sheetMeta = keys.map((key) => {
        const { file, page } = parseSheetKey(key);
        return { key, file, page, label: tabLabel(key) };
      }).sort((a, b) => compareSheetKeys(a.key, b.key));   // canonical sheet order — shared comparator
      // branding mode decides the cover identity + wordmark + parent credit;
      // resolved per-project (folderId "" ⇒ the single browser-only setting)
      const brand = resolveBranding({ ...(await loadBrandingSelection(projectIdFromUrl())), profiles: loadProfiles().profiles });
      const { bytes, filename } = await buildMarkedSetPdf({
        projectName, clientInfo, company: brand.company, credit: brand.credit, coverTitle: brand.coverTitle,
        dark: darkMode, units, sheets: sheetMeta, shapes, markups: exportMarkups, rfis, conditions,
        getPage: async (file, pageNum) => (await docFor(file)).getPage(pageNum),
        loadPdfData: (file) => store.loadPdfData(file),
      });
      downloadBytes(filename, bytes);
      setCommitMsg(`Marked set downloaded — ${filename}`);
    } catch (e) {
      setCommitMsg(`Marked set failed: ${e.message || e}`);
    }
  }

  // ── inline text editor — a screen-space <input> overlay (retires window.prompt).
  // An HTML input can't live in the zoom/pan-transformed SVG group, so it is
  // absolutely positioned in CONTAINER px, converting the anchor (stage px) through
  // tfRef. Pan/zoom is frozen while editing (onPointerDown / onWheel bail on
  // editingRef) so the overlay stays pinned to its anchor; the crosshair is
  // suppressed via the same ref inside moveCrosshair. Keys are handled on the
  // input's OWN onKeyDown/onBlur — the global window keydown returns early for
  // INPUT targets, so it never interferes.
  function markupAnchorStage(m) {
    const sp = panelByKey(m.sheet_id);
    if (!sp || !sp.img.w) return null;
    let nx, ny;
    if (m.type === "highlight" && Array.isArray(m.pts) && m.pts.length) { const mid = m.pts[Math.floor((m.pts.length - 1) / 2)]; nx = mid[0]; ny = mid[1]; }
    else if ((m.type === "cloud" || m.type === "highlight") && m.rect) { nx = (m.rect[0][0] + m.rect[1][0]) / 2; ny = (m.rect[0][1] + m.rect[1][1]) / 2; }
    else if (m.type === "arrow" && m.from && m.to) { nx = (m.from[0] + m.to[0]) / 2; ny = (m.from[1] + m.to[1]) / 2; }
    else if (m.at) { nx = m.at[0]; ny = m.at[1]; }   // text + bubble + callout
    else return null;
    return [nx * sp.img.w + sp.xOffset, ny * sp.img.h];
  }
  function openTextEditor({ anchorStage, value = "", multiline = false, commit }) {
    const el = containerRef.current;
    if (!el) return;
    const t = tfRef.current;
    hideCrosshair();                 // the OS cursor / aim crosshair steps aside while you type
    editingRef.current = true;
    const ed = { left: anchorStage[0] * t.scale + t.x, top: anchorStage[1] * t.scale + t.y, value, multiline, commit };
    editorRef.current = ed;
    setEditor(ed);
  }
  // commit=true → run the editor's commit with the current input text; either way
  // tear down. Guarded on editingRef so the blur that fires when we unmount the
  // focused input (after Enter/Esc) is a harmless no-op — no double commit.
  function finishEditor(commit) {
    if (!editingRef.current) return;
    editingRef.current = false;
    const ed = editorRef.current;
    const val = editorInputRef.current ? editorInputRef.current.value : (ed ? ed.value : "");
    editorRef.current = null;
    setEditor(null);
    if (commit && ed && ed.commit) ed.commit(val);
  }
  // defense-in-depth: editingRef locks pan/zoom/crosshair while the overlay is up.
  // If the input ever unmounts by a route other than finishEditor, this keeps the
  // ref from stranding true and freezing the canvas.
  useEffect(() => { if (!editor) { editingRef.current = false; bumpIdle(); } }, [editor]);
  // double-click a markup (Select tool) to edit its text in place — find the target
  // via toImage + hitMarkup (non-highlight beats highlight, mirroring selectAt) and
  // open the overlay at its anchor.
  function editMarkupAt(e) {
    if (!showMarkups) return;
    const p = toImage(e.clientX, e.clientY);
    const thr = 8 / tfRef.current.scale;
    const rev = [...visibleMarkups].reverse();
    const m = rev.find((mm) => mm.type !== "highlight" && hitMarkup(mm, p, thr))
      || rev.find((mm) => mm.type === "highlight" && hitMarkup(mm, p, thr));
    if (!m) return;
    // an svg symbol carries no text — select it, but don't open a dead-end editor;
    // a highlighter stroke is pure ink (no text either), same rule
    if (m.type === "svg" || (m.type === "highlight" && Array.isArray(m.pts))) { selectMarkup(m.id); return; }
    const anchor = markupAnchorStage(m);
    if (!anchor) return;
    selectMarkup(m.id);
    openTextEditor({ anchorStage: anchor, value: m.text || "", commit: (t) => updateMarkup(m.id, { text: (t || "").trim() }) });
  }

  function placeMarkup(p) {
    const tp = panelAt(p[0]);
    const norm = (q, panel) => [(q[0] - panel.xOffset) / panel.img.w, q[1] / panel.img.h];
    if (tool === "text") {
      // empty text is not committed (preserves the old `if (t && t.trim())` reject)
      openTextEditor({ anchorStage: p, commit: (t) => { const tx = (t || "").trim(); if (tx) addMarkup({ type: "text", at: norm(p, tp), text: tx }, tp.key); } });
    } else if (tool === "cloud") {
      if (!markupDraft) { setMarkupDraft(p); }
      else {
        const dp = panelAt(markupDraft[0]);
        const rect = [norm(markupDraft, dp), norm(p, dp)];
        setMarkupDraft(null);
        // create the cloud NOW (like highlight) so Esc/cancel in the note editor
        // keeps the drawn box — only the optional note is discarded, not the geometry
        const id = uid("mk");
        addMarkup({ id, type: "cloud", rect, text: "" }, dp.key);
        openTextEditor({ anchorStage: p, commit: (t) => updateMarkup(id, { text: (t || "").trim() }) });
      }
    } else if (tool === "highlight") {
      // two-corner like the cloud, but no note prompt — a highlight is a pure
      // translucent box you drop over an area; text/color/line_style come later.
      if (!markupDraft) { setMarkupDraft(p); }
      else {
        const dp = panelAt(markupDraft[0]);
        addMarkup({ type: "highlight", rect: [norm(markupDraft, dp), norm(p, dp)], text: "" }, dp.key);
        setMarkupDraft(null);
      }
    } else if (tool === "callout") {
      if (!markupDraft) { setMarkupDraft(p); }   // first click = the thing you're pointing at
      else {
        const dp = panelAt(markupDraft[0]);
        const target = norm(markupDraft, dp), at = norm(p, dp);
        setMarkupDraft(null);
        // empty callout text is not committed (preserves the old reject)
        openTextEditor({ anchorStage: p, commit: (t) => { const tx = (t || "").trim(); if (tx) addMarkup({ type: "callout", target, at, text: tx }, dp.key); } });
      }
    }
  }
  function updateMarkup(mid, patch) { setMarkups((ms) => ms.map((m) => (m.id === mid ? { ...m, ...patch } : m))); }
  function deleteMarkup(mid) { setMarkups((ms) => ms.filter((m) => m.id !== mid)); }

  // ── stamps — reusable annotations dropped click-to-place (#40). The library
  // is browser-global (persists across projects); placed instances are NORMAL
  // markups. Persist mirrors persistTemplates: ref + state + fire-and-forget
  // save, sanitized at the store boundary.
  const persistStampLib = (next) => {
    stampLibRef.current = next; setStampLib(next);
    store.saveStampLibrary(next).catch((e) => setCommitMsg(`Couldn't save the stamp library: ${e.message || e}`));
  };
  // Arm a stamp for placement: switch to the stamp tool and hold it in
  // armedStamp. Repeated clicks place multiple copies until you pick another
  // tool or press Escape.
  const armStamp = (stamp) => { setArmedStamp(stamp); setTool("stamp"); setMarkupDraft(null); };
  // Instantiate the armed stamp at the click point — every element becomes a
  // normal markup on the clicked panel's sheet. A `_prompt` element (a bubble
  // whose number you fill in) opens the text editor on the placed instance.
  function placeStamp(p) {
    if (!armedStamp) return;
    const tp = panelAt(p[0]);
    const cx = (p[0] - tp.xOffset) / tp.img.w, cy = p[1] / tp.img.h;
    const instances = instantiateStamp(armedStamp, [cx, cy]);
    if (!instances.length) { setCommitMsg("This stamp has no placeable elements."); return; }
    let promptId = null;
    for (const inst of instances) {
      const { _prompt, ...m } = inst;
      const id = uid("mk");
      addMarkup({ ...m, id }, tp.key);
      if (_prompt && !promptId) promptId = id;
    }
    setCommitMsg(`Placed “${armedStamp.name}”.`);
    if (promptId) openTextEditor({ anchorStage: p, commit: (t) => updateMarkup(promptId, { text: (t || "").trim() }) });
  }
  // Save the selected markup as a single-element stamp (the palette's define
  // flow). markupToStampElement re-expresses its coords as anchor-relative
  // offsets so the stamp is position independent.
  function saveMarkupAsStamp(m) {
    const el = markupToStampElement(m);
    if (!el) { setCommitMsg("This markup can't be saved as a stamp."); return; }
    const name = (window.prompt("Name this stamp:", (m.text || el.type).trim() || "Stamp") || "").trim();
    if (!name) return;
    const stamp = { id: uid("stmp"), name, elements: [el] };
    persistStampLib({ ...stampLibRef.current, stamps: [...stampLibRef.current.stamps, stamp] });
    setCommitMsg(`Saved stamp “${name}”.`);
    setLeftTab("stamp");
  }
  const deleteStamp = (id) => {
    const lib = stampLibRef.current;
    persistStampLib({
      stamps: lib.stamps.filter((s) => s.id !== id),
      sets: lib.sets.map((set) => ({ ...set, stampIds: set.stampIds.filter((sid) => sid !== id) })),
    });
    if (armedStamp?.id === id) setArmedStamp(null);
  };
  const renameStamp = (id, name) => {
    const nm = (name || "").trim();
    if (!nm) return;
    persistStampLib({ ...stampLibRef.current, stamps: stampLibRef.current.stamps.map((s) => (s.id === id ? { ...s, name: nm } : s)) });
  };
  // Export the whole library as JSON (a crew shares one standard set); import
  // MERGES a file's stamps/sets in, replacing same-id entries so a re-import is
  // idempotent. The store sanitizes on save, so a malformed file can't wedge us.
  function exportStamps() {
    const data = JSON.stringify({ schema: "opentakeoff.stamp_library.v1", ...stampLibRef.current }, null, 2);
    downloadBytes("opentakeoff-stamps.json", new TextEncoder().encode(data), "application/json");
  }
  async function importStamps(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const cur = stampLibRef.current;
      const inStamps = Array.isArray(parsed?.stamps) ? parsed.stamps : [];
      const inSets = Array.isArray(parsed?.sets) ? parsed.sets : [];
      const inIds = new Set(inStamps.map((s) => s?.id));
      const inSetIds = new Set(inSets.map((s) => s?.id));
      const merged = {
        stamps: [...cur.stamps.filter((s) => !inIds.has(s.id)), ...inStamps],
        sets: [...cur.sets.filter((s) => !inSetIds.has(s.id)), ...inSets],
      };
      persistStampLib(merged);   // persistStampLib → store sanitizes, dropping any malformed items
      setCommitMsg(`Imported ${inStamps.length} stamp${inStamps.length === 1 ? "" : "s"}.`);
      setLeftTab("stamp");
    } catch (e) {
      setCommitMsg(`Couldn't import stamps: ${e.message || e}`);
    }
  }
  // Import a real .svg FILE as a stamp: the browser's DOMParser extracts the
  // drawable primitives (extractSvgPrimitives, with the security gate), then the
  // pure svgToStamp bakes them into vector-path elements. A new stamp is minted
  // and added to the library — mirroring saveMarkupAsStamp.
  async function importSvgStamp(file) {
    try {
      const text = await file.text();
      const base = (file.name || "Imported SVG").replace(/\.svg$/i, "");
      const extracted = extractSvgPrimitives(text, { name: base });
      const stamp = extracted && svgToStamp(extracted);
      if (!stamp || !stamp.elements.length) { setCommitMsg("Couldn't read that SVG — no drawable vector shapes found."); return; }
      persistStampLib({ ...stampLibRef.current, stamps: [...stampLibRef.current.stamps, { id: uid("stmp"), name: stamp.name, elements: stamp.elements }] });
      setCommitMsg(`Imported “${stamp.name}” as a stamp.`);
      setLeftTab("stamp");
    } catch (e) {
      setCommitMsg(`Couldn't import SVG: ${e.message || e}`);
    }
  }

  // ── RFI register — the dormant markup.rfi_id hook made real. One RFI ↔ many
  // markups (markup.rfi_id === rfi.id); linked markups are DERIVED, never stored
  // twice. rfi.js stays PURE — every date is stamped HERE, at the event, so no
  // renderer computes an RFI field with new Date().
  function raiseRfi(markup) {
    if (!markup) return;
    const id = uid("rfi");
    const number = nextRfiNumber(rfis);
    const rec = {
      id, number, created_at: nowIso(), subject: (markup.text || "").trim(), question: "", status: "open",
      to: "", priority: "normal", cost_impact: false, schedule_impact: false,
      date: new Date().toISOString().slice(0, 10), response: "", response_date: "",
      sheet_id: markup.sheet_id,
    };
    setRfis((rs) => [...rs, rec]);
    updateMarkup(markup.id, { rfi_id: id });
    setLeftTab("rfi");
    setCommitMsg(`Raised ${number}.`);
  }
  const linkRfi = (markup, rfiId) => { if (markup && rfiId) updateMarkup(markup.id, { rfi_id: rfiId }); };
  const unlinkRfi = (markup) => { if (markup) updateMarkup(markup.id, { rfi_id: "" }); };
  // hard delete: drop the record AND clear the dangling pointer on every linked
  // markup (void is a status; delete removes — both must leave no orphan link)
  function deleteRfi(id) {
    setRfis((rs) => rs.filter((r) => r.id !== id));
    setMarkups((ms) => ms.map((m) => (m.rfi_id === id ? { ...m, rfi_id: "" } : m)));
  }
  // parent-owned update path: the status→response_date auto-stamp lives HERE (not
  // in the view) so the date is data, stamped once on the transition into Answered.
  function updateRfi(id, patch) {
    setRfis((rs) => rs.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r, ...patch };
      if (patch.status && next.status === "answered" && r.status !== "answered" && !next.response_date) {
        next.response_date = new Date().toISOString().slice(0, 10);
      }
      return next;
    }));
  }

  // Fly to a linked markup from the register. Two-phase because openSheets only
  // fires state setters and a sheet's bitmap dims load async: if the target sheet
  // isn't open, stash it in pendingFlyRef + openSheets, and the effect below
  // centers once the panel has non-zero img.w. If already open, center inline.
  function centerOnMarkup(m) {
    const sp = panelByKey(m.sheet_id);
    if (!sp || !sp.img || !sp.img.w || !sp.img.h) return false;
    let anchor;
    if (m.type === "highlight" && Array.isArray(m.pts) && m.pts.length) anchor = m.pts[Math.floor((m.pts.length - 1) / 2)];
    else if ((m.type === "cloud" || m.type === "highlight") && m.rect) anchor = [(m.rect[0][0] + m.rect[1][0]) / 2, (m.rect[0][1] + m.rect[1][1]) / 2];
    else if (m.type === "callout") anchor = m.at || m.target;
    else if (m.type === "arrow" && m.from && m.to) anchor = [(m.from[0] + m.to[0]) / 2, (m.from[1] + m.to[1]) / 2];
    else anchor = m.at;   // text + bubble
    if (!anchor || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1])) return false;
    const el = containerRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const curScale = Number.isFinite(tfRef.current.scale) ? tfRef.current.scale : 1;
    const sx = anchor[0] * sp.img.w + sp.xOffset, sy = anchor[1] * sp.img.h;
    const nextX = r.width / 2 - sx * curScale;
    const nextY = r.height / 2 - sy * curScale;
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY) || !Number.isFinite(curScale)) return false;
    setTfNow({ x: nextX, y: nextY, scale: curScale });
    selectMarkup(m.id);
    return true;
  }
  function centerOnShape(s) {
    const sp = panelByKey(s.sheet_id);
    if (!sp || !sp.img || !sp.img.w || !sp.img.h) return false;
    const verts = s.verts_norm || [];
    if (!verts.length) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [nx, ny] of verts) {
      if (typeof nx !== "number" || typeof ny !== "number" || isNaN(nx) || isNaN(ny)) continue;
      const x = nx * sp.img.w + sp.xOffset, y = ny * sp.img.h;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return false;
    const el = containerRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const minSpan = s.measure_role === "count" ? 48 : 10;
    const w = Math.max(x1 - x0, minSpan);
    const h = Math.max(y1 - y0, minSpan);
    const pad = 72;
    const rawScale = Math.min((r.width - pad) / w, (r.height - pad) / h, 2.25);
    const scale = Number.isFinite(rawScale) && rawScale > 0 ? clamp(rawScale) : 1;
    const nextX = (r.width - w * scale) / 2 - x0 * scale;
    const nextY = (r.height - h * scale) / 2 - y0 * scale;
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY) || !Number.isFinite(scale)) return false;
    setTfNow({ x: nextX, y: nextY, scale });
    selectShape(s.id);
    revealSheetInFilesSidebar(s.sheet_id);
    return true;
  }
  function flyToShape(shapeId) {
    const s = shapes.find((x) => x.id === shapeId);
    if (!s) return;
    setBoqFocusShapeId(null);
    if (!panelKeySet.has(s.sheet_id)) { pendingFlyShapeRef.current = shapeId; openSheets([s.sheet_id], false); return; }
    if (!centerOnShape(s)) pendingFlyShapeRef.current = shapeId;
  }
  /** Jump to a wall-opening door mark (or cutout anchor) on the plan. */
  function flyToWallOpening(opn, wall) {
    if (!opn || !wall) return;
    const sheet = wall.sheet_id;
    if (!panelKeySet.has(sheet)) {
      pendingFlyShapeRef.current = wall.id;
      openSheets([sheet], false);
    }
    const sp = panelByKey(sheet);
    const el = containerRef.current;
    if (!sp?.img?.w || !el) {
      flyToShape(wall.id);
      return;
    }
    const tag = String(opn.tag || "").toUpperCase();
    const ax = Array.isArray(opn.anchor_norm) ? opn.anchor_norm[0] * sp.img.w : null;
    const ay = Array.isArray(opn.anchor_norm) ? opn.anchor_norm[1] * sp.img.h : null;
    const distToSeg = (px, py, x1, y1, x2, y2) => {
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / len2));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    };
    const nearestDoor = (preferTag, maxD, fromX, fromY) => {
      let best = null, bestD = Infinity;
      for (const p of planSymbols) {
        if (p.sheet_id !== sheet || !isWallOpeningSymbol(p)) continue;
        if (preferTag && String(p.tag || "").toUpperCase() !== preferTag) continue;
        let d;
        if (fromX != null && fromY != null) d = Math.hypot(p.x - fromX, p.y - fromY);
        else d = 0;
        if (d < bestD && d <= maxD) { bestD = d; best = p; }
      }
      return best;
    };
    let sym = opn.symbol_id ? planSymbols.find((p) => p.id === opn.symbol_id) : null;
    // Stored id can go stale after re-extract — fall back by tag near the opening.
    if (!sym && tag) sym = nearestDoor(tag, Infinity, ax, ay);
    // Cutout / untagged rows: door mark closest to the opening anchor.
    if (!sym && ax != null && ay != null) sym = nearestDoor(null, 160, ax, ay);
    // Legacy openings with no anchor: door on/near this wall outline.
    if (!sym) {
      const wallPx = (wall.verts_norm || []).map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
      if (wallPx.length >= 2) {
        let best = null, bestD = Infinity;
        for (const p of planSymbols) {
          if (p.sheet_id !== sheet || !isWallOpeningSymbol(p)) continue;
          let d = pointInPoly(p.x, p.y, wallPx) ? 0 : Infinity;
          if (d !== 0) {
            for (let i = 0; i < wallPx.length; i++) {
              const a = wallPx[i], b = wallPx[(i + 1) % wallPx.length];
              d = Math.min(d, distToSeg(p.x, p.y, a[0], a[1], b[0], b[1]));
            }
          }
          if (d < bestD && d < 120) { bestD = d; best = p; }
        }
        sym = best;
      }
    }
    const r = el.getBoundingClientRect();
    const scale = clamp(Math.max(tfRef.current.scale, 2.5));
    const focusAt = (sx, sy, msg, focusId) => {
      setTfNow({ x: r.width / 2 - sx * scale, y: r.height / 2 - sy * scale, scale });
      if (focusId) {
        setSymbolFocus(focusId);
        setSymbolHover({
          id: focusId,
          cx: Math.min(r.width - 320, Math.max(8, r.width / 2 + 24)),
          cy: Math.min(r.height - 360, Math.max(8, 72)),
        });
      } else {
        selectShape(wall.id);
      }
      if (msg) setCommitMsg(msg);
    };
    // Custom cutouts: zoom in on the exact span and highlight it.
    if (opn.source === "cutout") {
      if (ax != null && ay != null) {
        const cutScale = clamp(Math.max(tfRef.current.scale, 4.5));
        setTfNow({
          x: r.width / 2 - (ax + sp.xOffset) * cutScale,
          y: r.height / 2 - ay * cutScale,
          scale: cutScale,
        });
        selectShape(wall.id);
        let aPt = null, bPt = null;
        if (Array.isArray(opn.span_a_norm) && Array.isArray(opn.span_b_norm)) {
          aPt = [opn.span_a_norm[0] * sp.img.w + sp.xOffset, opn.span_a_norm[1] * sp.img.h];
          bPt = [opn.span_b_norm[0] * sp.img.w + sp.xOffset, opn.span_b_norm[1] * sp.img.h];
        } else {
          // Legacy cutouts: reconstruct span from width along the wall line.
          const upp = uppFor(wall.sheet_id) || 0;
          const half = upp > 0 ? ((Number(opn.width_ft) || 0) / 2) / upp : 12;
          const wallPx = (wall.verts_norm || []).map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
          const closed = wallPx.length >= 3
            && (Math.hypot(wallPx[0][0] - wallPx[wallPx.length - 1][0], wallPx[0][1] - wallPx[wallPx.length - 1][1]) > 0.5);
          const ring = closed ? [...wallPx, wallPx[0]] : wallPx;
          const hit = nearestPointOnPolylinePx(ring, ax, ay);
          if (hit?.kind === "segment" && hit.segIndex > 0) {
            const p0 = ring[hit.segIndex - 1], p1 = ring[hit.segIndex];
            const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len, uy = dy / len;
            aPt = [hit.point[0] - ux * half + sp.xOffset, hit.point[1] - uy * half];
            bPt = [hit.point[0] + ux * half + sp.xOffset, hit.point[1] + uy * half];
          } else {
            aPt = [ax + sp.xOffset - half, ay];
            bPt = [ax + sp.xOffset + half, ay];
          }
        }
        if (wallCutoutFocusTimerRef.current) clearTimeout(wallCutoutFocusTimerRef.current);
        setWallCutoutFocus({ a: aPt, b: bPt });
        wallCutoutFocusTimerRef.current = setTimeout(() => setWallCutoutFocus(null), 4500);
        setCommitMsg("Jumped to custom cutout.");
        return;
      }
      flyToShape(wall.id);
      return;
    }
    if (sym) {
      focusAt(sym.x + sp.xOffset, sym.y, sym.tag ? `Door ${sym.tag}` : "Door", sym.id);
      return;
    }
    if (ax != null && ay != null) {
      focusAt(ax + sp.xOffset, ay, "Jumped to wall opening.", null);
      return;
    }
    flyToShape(wall.id);
  }
  function deleteShapeFromBoq(shapeId) {
    dispatchShape({ type: "delete", ids: [shapeId] });
    if (selectedId === shapeId) setSelectedId(null);
    if (boqFocusShapeId === shapeId) setBoqFocusShapeId(null);
    if (shapeBoqFocus === shapeId) { setShapeBoqFocus(null); shapeBoqPinPosRef.current = null; }
    setBoqLines((prev) => prev.filter((l) => l.shape_id !== shapeId && l.id !== rowKey(shapeId)));
    setShapeBoqHover((h) => (h?.id === shapeId ? null : h));
    shapeBoqHoverStickyRef.current = false;
  }
  function setShapeManualRate(shapeId, rateVal) {
    const key = rowKey(shapeId);
    const s = shapes.find((x) => x.id === shapeId);
    setBoqLines((prev) => {
      const i = prev.findIndex((l) => l.id === key);
      if (i >= 0) {
        const next = prev.slice();
        next[i] = { ...next[i], rate: rateVal };
        return next;
      }
      return [
        ...prev,
        {
          id: key,
          manual: false,
          sheet_id: s?.sheet_id || "",
          condition_id: s?.condition_id || "",
          shape_id: shapeId,
          room: "",
          description: "",
          notes: "",
          unit: "",
          qty_override: "",
          rate: rateVal,
        },
      ];
    });
  }
  function openBoqForShape(shapeId) {
    const s = shapes.find((x) => x.id === shapeId);
    setShowBoq(true);
    setBoqFocusShapeId(shapeId);
    setShapeBoqFocus(null);
    shapeBoqPinPosRef.current = null;
    if (s) {
      if (!panelKeySet.has(s.sheet_id)) {
        pendingFlyShapeRef.current = shapeId;
        openSheets([s.sheet_id], false);
      } else {
        centerOnShape(s);
      }
    }
    setShapeBoqHover(null);
    shapeBoqHoverStickyRef.current = false;
  }
  function flyToMarkup(m) {
    if (!m) return;
    setShowMarkups(true);   // flying to a markup reveals the layer, so you never land on an invisible selection
    if (!panelKeySet.has(m.sheet_id)) { pendingFlyRef.current = m; openSheets([m.sheet_id], false); return; }
    // open already, but its bitmap may still be mid-render (img.w === 0) — if the
    // inline center can't run yet, hand off to the phase-2 effect below.
    if (!centerOnMarkup(m)) pendingFlyRef.current = m;
  }

  function finishShape() {
    if (tool === "zone") {
      // ephemeral: classify, show, never save. Belongs to the panel of its first point.
      // Cross-panel span — the UI hides the Finish affordance (finishOk), but
      // keep the function safe standalone (Enter is still wired to it): a
      // point on a different panel than poly[0] would normalize to nx/ny
      // outside [0..1] for THAT panel, drawing a region that visually spans
      // a sheet it can never actually count shapes on.
      const tp = poly.length ? panelAt(poly[0][0]) : null;
      if (poly.length >= 3 && tp && poly.every((p) => panelAt(p[0]).key === tp.key)) {
        setZoneCheck({ key: tp.key, pts: poly.map(([x, y]) => [(x - tp.xOffset) / tp.img.w, y / tp.img.h]) });
        setZoneExpand(null);
      }
      setPoly([]);
      return;
    }
    if (tool === "surface" || tool === "wallarea") commitSurface(poly);
    else if (tool === "linear") commitLinear(poly);
    else if (tool === "curve") commitLinear(poly, true);
    else if (tool === "deduct-curve") {
      const flat = flattenCurve(poly);
      if (flat.length >= 3) commitPoly(flat, true);
    }
    else commitPoly(poly, tool === "deduct");
    setPoly([]);
  }
  function deleteSelected() {
    const live = shapesRef.current;
    const picks = Object.keys(layerPickIds).filter((id) => live.some((s) => s.id === id));
    const targetIds = picks.length > 0 ? picks : (selectedId ? [selectedId] : []);
    const cutIds = [...selectedCutoutIds].filter((id) => !shapeIsLocked(id));
    const allToDelete = [...new Set([...cutIds, ...targetIds])].filter((id) => !shapeIsLocked(id));
    if (allToDelete.length > 0) {
      dispatchShape({ type: "delete", ids: allToDelete });
      setSelectedCutoutIds(new Set());
      setLayerPickIds({});
      setSelectedId(null);
      setCutoutChecks((m) => {
        const next = { ...m };
        for (const id of allToDelete) delete next[id];
        return next;
      });
    }
  }
  // Wall cutout → openings[] face deduct (W × H). Floor cutouts still punch holes_norm.
  // Closed wall_area: uses cutout∩wall. Open Wall Area / Surface (surface_area): cutout
  // near the linear run uses the cutout ring itself for W×H.
  // Writes shapesRef synchronously so a following delete does not drop the opening.
  function applyWallCutoutAsOpening(cutterPx, sheetId, wallParents) {
    const tp = panelByKey(sheetId);
    const pool = (wallParents || []).filter((s) => s && (s.measure_role === "wall_area" || s.measure_role === "surface_area"));
    if (!pool.length || !cutterPx || cutterPx.length < 3 || !tp?.img?.w) return false;
    const toPx = (s) => s.verts_norm.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
    const nearOpenWall = (wallPts, thr = 28) => {
      if (!wallPts || wallPts.length < 2) return false;
      let cx = 0, cy = 0;
      for (const [x, y] of cutterPx) { cx += x; cy += y; }
      cx /= cutterPx.length; cy /= cutterPx.length;
      const samples = [[cx, cy], ...cutterPx];
      for (const [x, y] of samples) {
        for (let i = 1; i < wallPts.length; i++) {
          if (distToSeg(x, y, wallPts[i - 1][0], wallPts[i - 1][1], wallPts[i][0], wallPts[i][1]) < thr) return true;
        }
      }
      return false;
    };
    let target = null;
    let clipped = null;
    if (selectedId) {
      const sel = pool.find((s) => s.id === selectedId);
      if (sel) target = sel;
    }
    if (!target) {
      // Prefer closed wall with largest intersection; else nearest open linear run.
      let bestArea = -1;
      let bestOpen = null;
      for (const s of pool) {
        const outer = toPx(s);
        if (s.measure_role === "surface_area") {
          if (nearOpenWall(outer) && !bestOpen) bestOpen = s;
          continue;
        }
        const hit = intersectPolygons(outer, cutterPx);
        const ring = (hit && hit.length >= 3) ? hit : bboxIntersectRing(cutterPx, outer);
        const a = ring && ring.length >= 3 ? ringArea(ring) : 0;
        if (a > bestArea) { bestArea = a; target = s; clipped = ring; }
      }
      if (!target && bestOpen) { target = bestOpen; clipped = cutterPx; }
    }
    if (!target) {
      setCommitMsg("Cutout does not overlap the wall area — adjust the cutout onto the wall, then Apply.");
      return false;
    }
    const live = shapesRef.current.find((s) => s.id === target.id) || target;
    const outerPx = toPx(live);
    if (!clipped) {
      if (live.measure_role === "surface_area") {
        if (!nearOpenWall(outerPx)) {
          setCommitMsg("Cutout does not overlap the wall area — adjust the cutout onto the wall, then Apply.");
          return false;
        }
        clipped = cutterPx;
      } else {
        const hit = intersectPolygons(outerPx, cutterPx);
        clipped = (hit && hit.length >= 3) ? hit : bboxIntersectRing(cutterPx, outerPx);
      }
    }
    if (!clipped || clipped.length < 3) {
      setCommitMsg("Cutout does not overlap the wall area — adjust the cutout onto the wall, then Apply.");
      return false;
    }
    const h = live.height_override === true
      ? Number(live.height_ft) || 0
      : Number(live.height_ft) || Number(condById[live.condition_id]?.height_ft) || 0;
    const dims = openingDimsFromCutoutPx(clipped, uppFor(sheetId), h);
    if (!dims) {
      setCommitMsg("Set wall height (H) before applying a wall cutout — face deduct needs W × H.");
      return false;
    }
    let cx = 0, cy = 0;
    for (const [x, y] of clipped) { cx += x; cy += y; }
    cx /= clipped.length; cy /= clipped.length;
    const anchor_norm = [cx / tp.img.w, cy / tp.img.h];
    // Link nearest door / CW / GD mark on this sheet (inside/near the cutout) for fly-to.
    let nearSym = null, nearD = Infinity;
    for (const p of planSymbols) {
      if (p.sheet_id !== sheetId || !isWallOpeningSymbol(p)) continue;
      const inside = pointInPoly(p.x, p.y, clipped);
      const d = Math.hypot(p.x - cx, p.y - cy);
      if ((inside || d < 160) && d < nearD) { nearD = d; nearSym = p; }
    }
    let width_ft = dims.width_ft;
    let height_ft = dims.height_ft;
    if (live.measure_role === "surface_area") {
      const runLf = openLen(outerPx) * (uppFor(sheetId) || 0);
      if (nearSym) {
        const nk = symbolNoteKey(nearSym.sheet_id, nearSym.tag, nearSym.x, nearSym.y);
        const fields = resolveSymbolFields(nearSym.schedule || {}, symbolNotes[nk], nearSym.room_name);
        const parsed = parseOpeningSize(fields.size || nearSym.schedule?.size || "");
        if (parsed) {
          width_ft = parsed.width_ft;
          height_ft = parsed.height_ft;
        }
      } else if (height_ft >= h * 0.95) {
        // Cutout bbox defaults to full wall height — use a typical door leaf instead.
        height_ft = units === "metric" ? 2.1 / M_PER_FT : 7;
      }
      if (runLf > 0) {
        width_ft = Math.min(width_ft, runLf);
        if (!nearSym && width_ft >= runLf * 0.9) {
          width_ft = units === "metric" ? 0.9 / M_PER_FT : 3;
        }
      }
    }
    const opn = {
      id: uid("opn"),
      kind: nearSym ? openingKindForSymbol(nearSym) : "door",
      tag: nearSym?.tag || "",
      symbol_id: nearSym?.id || "",
      anchor_norm,
      width_ft,
      height_ft,
      source: "cutout",
    };
    const nextShapes = shapesRef.current.map((s) => {
      if (s.id !== live.id) return s;
      const openings = upsertWallOpening([...(s.openings || [])], opn);
      const next = { ...s, openings };
      return { ...next, computed: recomputeShape(next) };
    });
    shapesRef.current = nextShapes;
    setShapes(nextShapes);
    const deductSf = width_ft * height_ft;
    setCommitMsg(`Wall opening deducted from wall only — ${deductSf.toFixed(1)} SF (edit door H in openings if shorter than wall).`);
    return true;
  }

  // Punch checked/selected deduct cutouts into overlapping parents, then remove overlays.
  // Floors: holes_norm trim. Walls: openings[] W×H face deduct. Autosaves via shapes.
  function applyCutoutsToParents(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) return;
    let applied = 0;
    for (const id of list) {
      const cut = shapesRef.current.find((s) => s.id === id);
      if (!cut || cut.measure_role !== "deduct") continue;
      const tp = panelByKey(cut.sheet_id);
      if (!tp?.img?.w) continue;
      const cutterPx = cut.verts_norm.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
      if (cutterPx.length < 3) continue;
      const parents = shapesRef.current.filter((s) => {
        if (s.id === cut.id || s.sheet_id !== cut.sheet_id) return false;
        if (s.measure_role !== "floor_area" && s.measure_role !== "wall_area" && s.measure_role !== "surface_area") return false;
        if (s.measure_role === "floor_area" && !aiDetectShapeRevealed(s) && isAiDetectFloorPlan(s.sheet_id)) return false;
        const outer = s.verts_norm.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
        if (s.measure_role === "surface_area") {
          if (outer.length < 2) return false;
          let cx = 0, cy = 0;
          for (const [x, y] of cutterPx) { cx += x; cy += y; }
          cx /= cutterPx.length; cy /= cutterPx.length;
          const thr = 28;
          for (const [x, y] of [[cx, cy], ...cutterPx]) {
            for (let i = 1; i < outer.length; i++) {
              if (distToSeg(x, y, outer[i - 1][0], outer[i - 1][1], outer[i][0], outer[i][1]) < thr) return true;
            }
          }
          return false;
        }
        return polygonsOverlap(cutterPx, outer) || cutterPx.some(([x, y]) => pointInPoly(x, y, outer));
      });
      const wallParents = parents.filter((s) => s.measure_role === "wall_area" || s.measure_role === "surface_area");
      const floorParents = parents.filter((s) => s.measure_role === "floor_area");
      // Cutout centered on a floor mask must punch that floor — never divert to a
      // surrounding wall_area (its outer ring contains rooms as “inside”).
      let cx = 0, cy = 0;
      for (const [x, y] of cutterPx) { cx += x; cy += y; }
      cx /= cutterPx.length; cy /= cutterPx.length;
      const floorCovering = floorParents.filter((s) => {
        const outer = s.verts_norm.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
        if (!pointInPoly(cx, cy, outer)) return false;
        if ((s.holes_norm || []).some((hole) => {
          const hp = hole.map(([nx, ny]) => [nx * tp.img.w, ny * tp.img.h]);
          return pointInPoly(cx, cy, hp);
        })) return false;
        return true;
      });
      let ok = false;
      if (floorCovering.length) {
        ok = !!removeOverlapFromVictims(cutterPx, cut.sheet_id, floorCovering);
      } else if (wallParents.length) {
        ok = applyWallCutoutAsOpening(cutterPx, cut.sheet_id, wallParents);
      } else if (floorParents.length) {
        ok = !!removeOverlapFromVictims(cutterPx, cut.sheet_id, floorParents);
      }
      if (ok) applied += 1;
      if (ok && shapesRef.current.some((s) => s.id === id)) {
        dispatchShape({ type: "delete", ids: [id] });
      }
    }
    setSelectedCutoutIds(new Set());
    setSelectedId(null);
    setShapeCtxMenu(null);
    setCutoutChecks((m) => {
      const next = { ...m };
      for (const id of list) delete next[id];
      return next;
    });
    setCommitMsg(applied
      ? `Applied ${applied} cutout${applied === 1 ? "" : "s"} to parent mask${applied === 1 ? "" : "s"}.`
      : "No overlapping parent mask found for those cutouts.");
  }
  function reassignSelected(condId) { if (selectedId && !shapeIsLocked(selectedId)) dispatchShape({ type: "reassign", ids: [selectedId], condition_id: condId }); }
  function reassignSelectedLabel(value) { if (selectedId && !shapeIsLocked(selectedId)) dispatchShape({ type: "label", ids: [selectedId], value }); }   // Select-tool single-shape re-label (#111) — value "" / null clears it; label commands never stamp
  function setShapeHeightFt(shapeId, hFt) {
    const s = shapesRef.current.find((x) => x.id === shapeId);
    if (!s || shapeIsLocked(shapeId)) return;
    const height_ft = Number(hFt) || 0;
    const computed = recomputeShape({ ...s, height_ft, height_override: true });
    dispatchShape({
      type: "geom",
      id: shapeId,
      editKind: "vertex",
      height_ft,
      height_override: true,
      verts_norm: s.verts_norm,
      computed,
      prev: geomSnapshot(s),
    });
  }
  function layerGroupIdsFor(shapeId) {
    if (!shapeId) return [];
    const p = parentOf(layerForest, shapeId);
    if (!p) return [shapeId];
    const ids = descendantShapeIds(layerForest, p);
    return ids.length ? ids : [shapeId];
  }
  function moveIdsFor(shapeId) {
    const picks = Object.keys(layerPickIds).filter((id) => shapesRef.current.some((s) => s.id === id));
    if (picks.length > 1) return [...new Set(picks.flatMap((id) => layerGroupIdsFor(id)))];
    return layerGroupIdsFor(shapeId);
  }
  function shapeIsLocked(id) {
    const s = shapesRef.current.find((x) => x.id === id);
    return isLockedId(id, { lockedShapeIds, forest: layerForest, sheetId: s?.sheet_id });
  }
  function setLayerPickFromShape(id) {
    const ids = layerGroupIdsFor(id);
    if (ids.length > 1) setLayerPickIds(Object.fromEntries(ids.map((x) => [x, true])));
    else if (id) setLayerPickIds({ [id]: true });
    else setLayerPickIds({});
  }
  function armGroupMoveDrag(shape, p, e, memberIds) {
    const groupOrigs = {};
    const groupPrevs = {};
    for (const id of memberIds) {
      const sh = shapesRef.current.find((s) => s.id === id);
      if (sh) {
        groupOrigs[id] = sh.verts_norm;
        groupPrevs[id] = geomSnapshot(sh);
      }
    }
    dragRef.current = {
      kind: "move",
      shapeId: shape.id,
      start: p,
      orig: shape.verts_norm,
      prev: geomSnapshot(shape),
      shape,
      gx: e.clientX,
      gy: e.clientY,
      groupIds: memberIds,
      groupOrigs,
      groupPrevs,
    };
  }
  function groupLayerSelection() {
    const live = shapesRef.current;
    const shapeIds = Object.keys(layerPickIds).filter((id) => live.some((s) => s.id === id));
    const lifted = liftSelection(layerForest, shapeIds);
    if (lifted.length < 2) return;
    const first = live.find((s) => s.id === (descendantShapeIds(layerForest, lifted[0])[0] || lifted[0]));
    const sheetKey = first?.sheet_id || (layerForest[lifted[0]]?.sheetKey) || focusKey;
    const gid = uid("lg");
    const shapeById = new Map(live.map((s) => [s.id, s]));
    const next = groupSelection(layerForest, lifted, { newId: gid, name: "Group", sheetKey, shapeById });
    if (next === layerForest) return;
    setLayerForest(next);
    const members = [...new Set(lifted.flatMap((id) => (layerForest[id] ? descendantShapeIds(layerForest, id) : [id])))];
    const picks = Object.fromEntries(members.map((id) => [id, true]));
    if (members[0]) selectShape(members[0], picks);
    else setLayerPickIds(picks);
  }
  function ungroupLayerSelection() {
    const live = shapesRef.current;
    const shapeIds = Object.keys(layerPickIds).filter((id) => live.some((s) => s.id === id));
    const lifted = liftSelection(layerForest, shapeIds);
    setLayerForest((g) => ungroupNodes(g, lifted));
    setLayerPickIds({});
  }
  function selectLayerIds(ids, opts = {}) {
    if (opts.sheetKey) layerTargetSheetRef.current = opts.sheetKey;
    const live = shapesRef.current;
    const shapeIds = (ids || []).filter((id) => live.some((s) => s.id === id));
    const picks = Object.fromEntries(shapeIds.map((id) => [id, true]));
    if (shapeIds[0]) {
      const sk = live.find((s) => s.id === shapeIds[0])?.sheet_id;
      if (sk) layerTargetSheetRef.current = sk;
      selectShape(shapeIds[0], picks);
      setFocusKey(sk || focusKey);
      setTool("select");
      flyToShape(shapeIds[0]);
    } else {
      selectShape(null);
    }
  }
  function expandLayerIds(ids) {
    return collectIdsForLayerToggle(ids, {
      forest: layerForest,
      shapes: shapesRef.current,
      sheetMatch: aiFloorSheetKeysMatch,
    });
  }
  function toggleHideIds(ids, hidden) {
    const { shapeIds, groupIds, sheetIds } = expandLayerIds(ids);
    let shouldHide = typeof hidden === "boolean" ? hidden : undefined;
    setHiddenShapeIds((h) => {
      const next = { ...h };
      if (shouldHide === undefined) {
        const allHidden = shapeIds.length > 0 && shapeIds.every((id) => h[id]);
        shouldHide = !allHidden;
      }
      for (const id of [...ids, ...shapeIds, ...sheetIds]) {
        if (shouldHide) next[id] = true;
        else delete next[id];
      }
      return next;
    });
    if (groupIds.length) {
      setLayerForest((g) => {
        let next = g;
        const flag = shouldHide !== undefined ? shouldHide : (typeof hidden === "boolean" ? hidden : true);
        for (const id of groupIds) next = setGroupFlag(next, id, "hidden", flag);
        return next;
      });
    }
  }
  function toggleLockIds(ids, locked) {
    const { shapeIds, groupIds, sheetIds } = expandLayerIds(ids);
    let shouldLock = typeof locked === "boolean" ? locked : undefined;
    setLockedShapeIds((h) => {
      const next = { ...h };
      if (shouldLock === undefined) {
        const allLocked = shapeIds.length > 0 && shapeIds.every((id) => h[id]);
        shouldLock = !allLocked;
      }
      for (const id of [...ids, ...shapeIds, ...sheetIds]) {
        if (shouldLock) next[id] = true;
        else delete next[id];
      }
      return next;
    });
    if (groupIds.length) {
      setLayerForest((g) => {
        let next = g;
        const flag = shouldLock !== undefined ? shouldLock : (typeof locked === "boolean" ? locked : true);
        for (const id of groupIds) next = setGroupFlag(next, id, "locked", flag);
        return next;
      });
    }
  }
  function deleteLayerIds(ids) {
    const list = (ids || []).filter((id) => shapesRef.current.some((s) => s.id === id) && !shapeIsLocked(id));
    if (!list.length) return;
    dispatchShape({ type: "delete", ids: list });
    setHiddenShapeIds((h) => {
      const next = { ...h };
      for (const id of list) delete next[id];
      return next;
    });
    setLockedShapeIds((h) => {
      const next = { ...h };
      for (const id of list) delete next[id];
      return next;
    });
    setLayerPickIds((p) => {
      const next = { ...p };
      for (const id of list) delete next[id];
      return next;
    });
    if (list.includes(selectedId)) selectShape(null);
  }
  function duplicateLayerIds(ids) {
    const entries = (ids || [])
      .filter((id) => !shapeIsLocked(id))
      .map((id) => shapesRef.current.find((s) => s.id === id))
      .filter(Boolean)
      .map(clipEntry);
    if (!entries.length) return;
    clipRef.current = entries;
    pasteClipboard();
  }
  function renameLayer(id, name, kind) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return;
    if (kind === "group") {
      setLayerForest((g) => renameGroup(g, id, trimmed));
      return;
    }
    dispatchShape({ type: "label", ids: [id], value: trimmed });
  }
  function newLayerGroup() {
    const wanted = layerTargetSheetRef.current || focusKey || groupKeys[0];
    const sheetKey = (groupKeys || []).find((k) => k === wanted || aiFloorSheetKeysMatch(k, wanted)) || wanted;
    if (!sheetKey) return;
    const gid = uid("lg");
    setLayerForest((g) => addEmptyGroup(g, { id: gid, name: "Group", sheetKey }));
  }
  function moveLayerTree({ dragIds, parentId, index }) {
    const live = shapesRef.current;
    const shapeById = new Map(live.map((s) => [s.id, s]));
    const dest = sheetKeyFromNodeId(parentId) ? null : parentId;
    setLayerForest((g) => moveNodes(g, dragIds || [], dest, index, { shapeById }));
  }

  // pan/zoom the canvas to fit a condition's takeoffs on the open sheets —
  // the panel's ⌖ / double-click navigation. Fit zoom is capped so a lone
  // count marker doesn't slam the view to maximum magnification.
  function locateCondition(id) {
    const el = containerRef.current;
    if (!el) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, found = false;
    for (const s of visibleShapes) {
      if (s.condition_id !== id) continue;
      const sp = panelByKey(s.sheet_id);
      for (const [nx, ny] of s.verts_norm) {
        const x = nx * sp.img.w + sp.xOffset, y = ny * sp.img.h;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        found = true;
      }
    }
    if (!found) { setCommitMsg(`No takeoffs for ${condById[id]?.finish_tag || "this condition"} on the open sheet${groupKeys.length > 1 ? "s" : ""} yet.`); return; }
    const r = el.getBoundingClientRect();
    const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1), pad = 90;
    const scale = clamp(Math.min((r.width - pad) / w, (r.height - pad) / h, 1.5));
    setTfNow({ x: (r.width - w * scale) / 2 - x0 * scale, y: (r.height - h * scale) / 2 - y0 * scale, scale });
  }

  // ONE condition-minting path — the human +condition button and the agent's
  // create_condition tool both come through here, so the field set and the
  // color/hatch auto-rotation can never drift between the two.
  function mintCondition(tag) {
    // read the LIVE list (agentStateRef) — the agent can mint mid-run, when the
    // render-scope `conditions` closure is stale; the ref is updated per render
    // AND immediately below, so two mints in one model turn rotate correctly.
    const cs = agentStateRef.current.conditions;
    // auto-vary line color AND hatch so each new finish reads distinctly, like a drawing
    const lc = PALETTE[cs.length % PALETTE.length];
    const c = {
      id: uid("cnd"), created_at: nowIso(), finish_tag: tag,
      color: lc,            // line color
      fill: lc,             // fill color (NO_FILL for outline-only)
      hatch: HATCHES[1 + (cs.length % (HATCHES.length - 1))].id,
      multiplier: 1,        // ×N for identical repeated units (measure one, multiply)
      waste_pct: 0,         // flooring waste allowance (manual) — applied in the Report
      materials: [],        // supporting materials (adhesive, grout, …) with coverage rates
    };
    agentStateRef.current = { ...agentStateRef.current, conditions: [...cs, c] };
    setConditions((prev) => [...prev, c]);
    return c;
  }
  function addCondition() {
    const tag = (window.prompt("Finish tag for this condition (e.g. LVT-1):") || "").trim();
    if (!tag) return;
    const c = mintCondition(tag);
    activateCondition(c.id, { reassign: false });   // no reassign affordance on +condition; still dismisses a live bulk selection
  }

  // ── In-canvas takeoff agent — capabilities, the accept gate, and the run ────
  // The registry (lib/agentTools.js) owns schemas/validation/whitelists; these
  // are the CAPABILITIES its tools close over — each one reads live state via
  // agentStateRef (the loop spans many awaits) and reuses the app's existing
  // deterministic engines verbatim: the pdf.js text layer + extractRegionText,
  // parseSchedule, the one-click flood/trace/snap pipeline, and the detail-view
  // offscreen render. Nothing here writes to `shapes` — proposals stage into
  // agentProposals and only the accept gate below dispatches an `add` command.
  const AGENT_VIEW_MAX_EDGE = 1024;   // view_region crop cap (vision-model native range)
  const AGENT_TEXT_MAX_ITEMS = 600;   // read_sheet_text cap — a full E-size text layer would drown the context

  const agentPanelFor = (key) => {
    const p = agentStateRef.current.panels.find((x) => x.key === key);
    return p && p.img.w ? p : null;
  };
  const agentUpp = (key) => panelGeom.uppFor(agentStateRef.current.scales, renderScalesRef.current, key);

  async function agentTextTokens(key, region) {
    const p = agentPanelFor(key);
    const pageObj = pageObjsRef.current.get(key);
    if (!p || !pageObj) throw new Error(`Sheet ${key} isn't rendered yet.`);
    const rs = renderScalesRef.current.get(key) || RENDER_SCALE;
    const vp = pageObj.getViewport({ scale: rs });
    const tc = await pageObj.getTextContent();
    const rect = region
      ? { x0: region.x0 * p.img.w, y0: region.y0 * p.img.h, x1: region.x1 * p.img.w, y1: region.y1 * p.img.h }
      : { x0: 0, y0: 0, x1: p.img.w, y1: p.img.h };
    return { tokens: extractRegionText(tc, vp, rect), p };
  }

  async function agentReadSheetText(key, region) {
    const { tokens, p } = await agentTextTokens(key, region);
    return tokens.slice(0, AGENT_TEXT_MAX_ITEMS).map((t) => ({
      text: t.str, x: +(t.x / p.img.w).toFixed(4), y: +(t.y / p.img.h).toFixed(4),
    }));
  }

  async function agentReadSchedule(key, region) {
    const { tokens } = await agentTextTokens(key, region);
    return parseSchedule(tokens);   // vector path only — same parser as Import from schedule
  }

  // Render just the asked-for crop offscreen (the rasterizeRegion idiom) and
  // hand back a PNG data URL — THE vision tool for scans and ambiguous areas.
  async function agentViewRegion(key, region) {
    const p = agentPanelFor(key);
    const pageObj = pageObjsRef.current.get(key);
    if (!p || !pageObj) throw new Error(`Sheet ${key} isn't rendered yet.`);
    const rs = renderScalesRef.current.get(key) || RENDER_SCALE;
    const x0 = region.x0 * p.img.w, y0 = region.y0 * p.img.h;
    const regW = Math.max(1, (region.x1 - region.x0) * p.img.w);
    const regH = Math.max(1, (region.y1 - region.y0) * p.img.h);
    const factor = Math.min(1, AGENT_VIEW_MAX_EDGE / regW, AGENT_VIEW_MAX_EDGE / regH);
    const bw = Math.max(1, Math.round(regW * factor)), bh = Math.max(1, Math.round(regH * factor));
    const cv = document.createElement("canvas");
    cv.width = bw; cv.height = bh;
    await pageObj.render({
      canvasContext: cv.getContext("2d"),
      viewport: pageObj.getViewport({ scale: rs * factor }),
      transform: [1, 0, 0, 1, -x0 * factor, -y0 * factor],
      background: "#ffffff",   // never the panel canvas — dark mode bakes an inversion into those pixels
    }).promise;
    const image_data_url = cv.toDataURL("image/png");
    cv.width = cv.height = 0;
    return { image_data_url, width: bw, height: bh };
  }

  // The one-click engine at an agent-supplied seed — same trigger policy and
  // messages as oneClickAt, WITHOUT touching the interactive proposal state:
  // this probes and returns the ring; committing anything stays behind the gate.
  async function agentOneClickProbe(key, xn, yn) {
    const p = agentPanelFor(key);
    if (!p) return { error: `Sheet ${key} isn't rendered yet — try again in a moment.` };
    const upp = agentUpp(key);
    if (upp == null) return { error: agentScaleGate(key, agentStateRef.current.detectedScales[key]?.label || "") };
    const local = [xn * p.img.w, yn * p.img.h];
    const stats = sheetStatsRef.current.get(key);
    const rasterEligible = !!stats && stats.imageFrac >= RASTER_MIN_IMG_FRAC;
    const vectorViable = !!stats && stats.segCount >= RASTER_MIN_SEGS;
    let f = null, raster = false;
    if (!rasterEligible || vectorViable) {
      const mo = ensureMask(key);
      if (!mo && !rasterEligible) return { error: "Still reading this sheet's linework — try again in a second." };
      if (mo) {
        const gap = openingGapPx(upp, mo.ws);
        const r = floodRegionSealed(mo, local[0], local[1], fillSens, gap);
        if (r.status === "ok") f = r;
        else if (!rasterEligible) {
          return { error: r.status === "leak"
            ? "That space isn't enclosed on the plan linework — the fill spilled past a gap wider than a door/window. Seed a more enclosed spot."
            : "Landed in dense linework (hatching/text). Seed an open spot inside the room." };
        }
      }
    }
    if (!f) {
      const rmo = await ensureRasterMask(key);
      if (!rmo) return { error: "Couldn't read this scan — the estimator will have to trace it by hand." };
      const gap = openingGapPx(upp, rmo.ws);
      const r = floodRegionSealed(rmo, local[0], local[1], SENS_BALANCED, gap);
      if (r.status !== "ok") {
        return { error: r.status === "leak"
          ? "That space isn't enclosed on the scan — the fill escaped through a gap wider than a door/window (faded line or open doorway). Seed a more enclosed spot."
          : "Landed on dense scan ink (text or hatching). Seed an open spot inside the room." };
      }
      f = r; raster = true;
    }
    const eps = raster ? RASTER_RDP_EPS : 1.5;
    const snapRing = (ring) => {
      if (raster) return ring;
      const grid = snapGridsRef.current.get(key);
      return snapVertices(ring, (x, y, d) => (grid ? nearestSnap(grid, x, y, d) : null), 7);
    };
    const { outer, holes } = traceRegionWithHoles(f, { upp, epsMaskPx: eps });
    const ring = snapRing(outer);
    if (ring.length < 3) return { error: "Couldn't trace that space into a polygon." };
    const cutouts = [];
    for (const hole of holes) {
      const hr = snapRing(hole);
      if (hr.length < 3) continue;
      cutouts.push({
        verts_norm: hr.map(([x, y]) => [+(x / p.img.w).toFixed(5), +(y / p.img.h).toFixed(5)]),
        area_sf: +(ringArea(hr) * upp * upp).toFixed(2),
        perimeter_lf: +(closedMetrics(hr).perim * upp).toFixed(2),
        auto_cutout: true,
      });
    }
    return {
      verts_norm: ring.map(([x, y]) => [+(x / p.img.w).toFixed(5), +(y / p.img.h).toFixed(5)]),
      area_sf: +(ringArea(ring) * upp * upp).toFixed(2),
      perimeter_lf: +(closedMetrics(ring).perim * upp).toFixed(2),
      seed_norm: [+xn.toFixed(5), +yn.toFixed(5)],
      ...(f.hatchFiltered ? { hatch_filtered: true } : {}),
      ...(f.openingsSealed ? { openings_sealed: true } : {}),
      ...(raster ? { raster_traced: true } : {}),
      ...(cutouts.length ? { cutouts } : {}),
    };
  }

  // Stage already-whitelisted proposals (the registry validated + whitelisted
  // evidence before calling this). area/perim computed here for the review UI;
  // the accept gate recomputes fresh in case the estimator recalibrates first.
  function stageAgentProposals(shapes) {
    const staged = shapes.map((s) => {
      const p = agentPanelFor(s.sheet);
      const upp = agentUpp(s.sheet) || 0;
      const ringPx = s.verts_norm.map(([x, y]) => [x * p.img.w, y * p.img.h]);
      return {
        id: `agp-${mintUuid()}`,
        sheet_id: s.sheet,
        condition_id: s.condition_id,
        measure_role: s.measure_role,
        verts_norm: s.verts_norm,
        evidence: s.evidence,
        ...(Array.isArray(s.evidence.seed_norm) ? { seed_norm: s.evidence.seed_norm } : {}),
        proposed_ts: nowIso(),
        area_sf: +(ringArea(ringPx) * upp * upp).toFixed(2),
        perim_lf: +(closedMetrics(ringPx).perim * upp).toFixed(2),
      };
    });
    setAgentProposals((ps) => [...ps, ...staged]);
    return { staged: staged.length };
  }

  function buildAgentCtx() {
    return {
      listSheets: () => agentStateRef.current.panels.filter((p) => p.img.w).map((p) => ({
        sheet: p.key,
        title: tabLabel(p.key),
        width: p.img.w, height: p.img.h,
        scale_set: agentUpp(p.key) != null,
        ...(agentStateRef.current.scaleSources[p.key] ? { scale_source: agentStateRef.current.scaleSources[p.key] } : {}),
        ...(agentStateRef.current.detectedScales[p.key]?.label ? { detected_label: agentStateRef.current.detectedScales[p.key].label } : {}),
      })),
      sheetDims: (key) => { const p = agentPanelFor(key); return p ? { w: p.img.w, h: p.img.h } : null; },
      uppFor: agentUpp,
      detectedLabel: (key) => agentStateRef.current.detectedScales[key]?.label || "",
      readSheetText: agentReadSheetText,
      readSchedule: agentReadSchedule,
      viewRegion: agentViewRegion,
      oneClick: agentOneClickProbe,
      getConditions: () => agentStateRef.current.conditions.map((c) => ({ id: c.id, finish_tag: c.finish_tag, hatch: c.hatch, waste_pct: c.waste_pct })),
      createCondition: (tag) => { const c = mintCondition(tag); return { id: c.id, finish_tag: c.finish_tag }; },
      proposeShapes: stageAgentProposals,
      askDrawings: async (question) => {
        const liveConditions = agentStateRef.current.conditions || conditions;
        const projectContext = buildProjectChatContext({
          projectName,
          units,
          shapes,
          conditions: liveConditions,
          planSymbols,
          symbolNotes,
          panelImgs,
          roomLabelsBySheet,
          scheduleKb,
        });
        const liveSummary = buildLiveCountsSummary(planSymbols, shapes, liveConditions);
        const liveAnswer = answerFromLiveDetections(question, planSymbols, shapes, liveConditions);
        const result = await queryChat(question, { projectContext, liveSummary });
        const resolved = resolveChatAnswer(question, result, liveAnswer);
        return {
          answer: resolved.content,
          abstained: resolved.abstained,
          citations: (result.citations || []).map((c) => ({
            sheet_id: c.sheet_id,
            quote: c.quote,
            source: c.source,
          })),
        };
      },
    };
  }

  // Voice deixis (RFC #59 deixis slice): "carpet one, this room" — the
  // utterance carries WHAT, the crosshair carries WHERE. getAimSeed resolves
  // the existing pointer tracker (lastPtrRef — the same positions the
  // moveCrosshair aim renders from; no second tracker) into a sheet-local
  // seed. null = the aim isn't LIVE: nothing tracked since the utterance
  // began — Command box focus / the previous run — or since the pointer left
  // the canvas or the tab hid (voiceAimMarkRef). sheetId "" = live aim that
  // isn't over a sheet. Both become loud rejects in the dispatcher, checked
  // before any state moves. The seed is the RAW cursor, not the snap/angle-
  // adjusted point: a flood seed targets a room's interior, where snap pull
  // toward a wall endpoint could only hurt — and matches a mid-room click,
  // which never snaps either.
  function getAimSeed() {
    if (status !== "ready" || !lastPtrRef.current) return null;
    if (aimSeqRef.current <= voiceAimMarkRef.current) return null;   // stale — no pointer update since the utterance began / last invalidation
    const p = toImage(lastPtrRef.current[0], lastPtrRef.current[1]);
    const tp = panelAt(p[0]);
    const x = p[0] - tp.xOffset, y = p[1];
    if (!tp.img.w || x < 0 || y < 0 || x >= tp.img.w || y >= tp.img.h) return { x, y, sheetId: "" };
    return { x, y, sheetId: tp.key };
  }
  // The who-aimed-it rule: the human put the crosshair there, so the trace
  // runs the SAME oneClickAt flood a physical click runs and commits DIRECT
  // as human work (one_click_v1 origin, same undo) — one utterance, no
  // preview-then-⏎, and NEVER an agentProposals row (that gate is for agent-
  // INFERRED placement; the line is aim). conditionId/label ride explicitly:
  // the utterance armed them in this same handler, so the render closures are
  // stale. Failures wrap into the commitMsg bar's "Couldn't" convention.
  async function voiceTraceAt(seed, conditionId, label) {
    const tp = panelByKey(seed.sheetId);
    if (!tp || tp.key !== seed.sheetId || !tp.img.w) return { ok: false, message: "Couldn't place that — aim at a sheet." };
    const out = await oneClickAt([seed.x + tp.xOffset, seed.y], false, { conditionId, label });
    if (out.ok) return out;
    const m = out.message || "Couldn't place that — the view changed mid-trace. Say it again.";
    return { ok: false, message: /^couldn'?t/i.test(m) ? m : `Couldn't place that — ${m.charAt(0).toLowerCase()}${m.slice(1)}` };
  }
  // Voice-command capabilities (RFC #59 slice 2) — every entry binds an action
  // the UI already exposes; the dispatcher (voiceActions.ts) never touches
  // state directly. getConditions reads the live mirror (mintCondition updates
  // it mid-handler); the rest are safe render closures because the voice path
  // is synchronous up to traceAt, whose async continuation carries its state
  // by value/ref instead. Programmatic activation passes {reassign:false} —
  // same policy as hotkeys and Library Apply.
  function buildVoiceCtx() {
    return {
      getConditions: () => agentStateRef.current.conditions.map((c) => ({ id: c.id, finish_tag: c.finish_tag })),
      getShapeLabels: () => shapeLabels,
      getActiveConditionId: () => activeCond || "",
      activateCondition: (id) => activateCondition(id, { reassign: false }),
      createCondition: (tag) => mintCondition(tag),
      updateCondition: updateCondById,
      addLabel,
      activateLabel,
      // top-center of the focused sheet: text markups render centered on `at`,
      // and addMarkup auto-opens the Markups dock, so the note is immediately
      // visible and draggable — the anchor is a starting point, not a commitment
      addNote: (text) => addMarkup({ type: "text", at: [0.5, 0.06], text }, focusPanel.key),
      getAimSeed,
      traceAt: (seed, conditionId, label) => voiceTraceAt(seed, conditionId, label),
    };
  }
  const onVoiceCommand = (text) => {
    const out = runVoiceCommand(buildVoiceCtx(), text);
    // every run consumes the aim (the seed was already read synchronously):
    // repeating "this room" without a fresh pointer move is a stale-aim
    // reject, never a silent double-commit of the same room
    voiceAimMarkRef.current = aimSeqRef.current;
    const finish = (o) => {
      setCommitMsg(o.message);
      // two-tier router (RFC #59 slice 5): a FULLY-unrecognized transcript,
      // with the agent configured, earns an OFFER — never an auto-run. Any
      // other outcome (success, near-miss reject, dispatcher refusal) clears
      // a stale offer so ⏎ can never become a surprise agent run.
      if (shouldOfferAgentHandoff(o, isAiConfigured())) offerAgentHandoff(text);
      else clearAgentOffer();
      return o.ok;
    };
    // deixis traces can resolve async (raster flood awaits a render) — the
    // outcome message lands when it lands; everything else stays synchronous
    return typeof out?.then === "function" ? out.then(finish) : finish(out);
  };

  // ── push-to-talk (RFC #59 recognizer slice) ────────────────────────────────
  // Hold M to dictate; release runs the transcript through the SAME
  // onVoiceCommand the Command box uses; Esc mid-hold discards. Everything is
  // lazy: the worker + model load on the first hold (ingest.js precedent), and
  // decode happens OFF the main thread (stt.worker.ts) so pan/zoom stays
  // smooth. Deliberately NOT re-marking the deixis aim at keydown: for typed
  // commands focus starts the utterance and the pointer moves after; for a
  // hold, the hand is ALREADY resting the pointer on the room — demanding a
  // pointer tick mid-hold would stale-reject every still-handed "this room".
  // The standing invalidations (canvas-leave, tab-hide, previous run) still
  // guard every ghost-seed path the #83 design named.
  const [voiceChip, setVoiceChip] = useState(null); // { text, tone: "live"|"busy"|"info"|"offer" } | null
  const voiceClientRef = useRef(null);
  const voiceCaptureRef = useRef(null);              // live CaptureSession during a hold
  const voiceModelRef = useRef({ phase: "unprobed" });
  const voiceHoldRef = useRef(false);                // physical key/button state
  const voiceFlashRef = useRef(0);                   // transcript-flash timer
  // ── two-tier router offer (RFC #59 slice 5) ───────────────────────────────
  // A thin consent-gated bridge into the EXISTING agent loop: confirm hands
  // the refused transcript to runAgent() — same cfg, tools, Accept gate as the
  // panel; no new tools, no second interpretation. The offer expires (consent
  // hygiene), and the spoken confirm is a fixed literal, never grammar.
  const AGENT_OFFER_TTL_MS = 20000;
  const pendingAgentOfferRef = useRef(null);         // { transcript } | null — the chip is the render, the ref is the logic
  const agentOfferTimerRef = useRef(0);
  function offerAgentHandoff(transcript) {
    clearTimeout(agentOfferTimerRef.current);
    pendingAgentOfferRef.current = { transcript };
    setVoiceChip({ text: 'not a command — ⏎ or say "ask the agent" to run it on YOUR agent (your endpoint, your key) · proposals land for review · Esc dismisses', tone: "offer" });
    agentOfferTimerRef.current = setTimeout(() => clearAgentOffer(), AGENT_OFFER_TTL_MS);
  }
  function clearAgentOffer() {
    if (!pendingAgentOfferRef.current) return;
    clearTimeout(agentOfferTimerRef.current);
    pendingAgentOfferRef.current = null;
    setVoiceChip((c) => (c && c.tone === "offer" ? null : c));
  }
  function confirmAgentHandoff() {
    const t = pendingAgentOfferRef.current?.transcript;
    clearAgentOffer();
    if (!t) return;
    // runAgent self-guards (agentRunning, isAiConfigured, sheet ready); the
    // panel opens so the run — and its Accept gate — happen in plain sight
    setAgentOpen(true);
    void runAgent(t);
  }
  const agentOfferFnsRef = useRef(null);
  agentOfferFnsRef.current = { confirm: confirmAgentHandoff, dismiss: clearAgentOffer, pending: () => !!pendingAgentOfferRef.current };
  function ensureVoiceClient() {
    if (!voiceClientRef.current) {
      voiceClientRef.current = createVoiceRecognizerClient((s) => {
        voiceModelRef.current = s;
        if (s.phase === "loading") setVoiceChip({ text: `voice model loading… ${s.pct}%`, tone: "busy" });
        else if (s.phase === "ready") setVoiceChip((c) => (c && c.tone === "busy" ? null : c));
        else if (s.phase === "uninstalled") { setVoiceChip(null); setCommitMsg("Voice isn't installed on this deployment — see docs/VOICE.md to stage the model."); }
        else if (s.phase === "error") { setVoiceChip(null); setCommitMsg(`Couldn't load the voice model — ${s.message} Hold M to retry.`); }
      });
    }
    return voiceClientRef.current;
  }
  async function voiceHoldStart() {
    if (voiceCaptureRef.current) return;
    const client = ensureVoiceClient();
    if (voiceModelRef.current.phase !== "ready") {
      // never a silent drop: pressing PTT before the model is ready SAYS so
      // (and kicks off/retries the load, so the affordance is also the fix)
      void client.ensureReady();
      if (voiceModelRef.current.phase === "loading")
        setVoiceChip({ text: `voice model loading… ${voiceModelRef.current.pct ?? 0}% — try again shortly`, tone: "busy" });
      return;
    }
    try {
      const session = await startCapture();
      if (!voiceHoldRef.current) { session.cancel(); return; }  // released during the permission prompt
      session.onEnded(() => {
        session.cancel();
        voiceCaptureRef.current = null;
        setVoiceChip(null);
        setCommitMsg("Couldn't finish dictation — the microphone was revoked.");
      });
      voiceCaptureRef.current = session;
      setVoiceChip({ text: "listening… release M to run · Esc to discard", tone: "live" });
    } catch (err) {
      setCommitMsg(
        err?.reason === "mic_denied" ? "Couldn't start dictation — microphone permission denied. Allow the mic and try again."
        : err?.reason === "no_mic_device" ? "Couldn't start dictation — no microphone found."
        : "Couldn't start dictation — microphone unavailable.",
      );
    }
  }
  function voiceHoldEnd(commit) {
    const session = voiceCaptureRef.current;
    voiceCaptureRef.current = null;
    if (!session) return;
    if (!commit) { session.cancel(); setVoiceChip(null); return; }
    const pcm = session.stop();
    if (pcm.length < 1600) { setVoiceChip(null); return; }   // <0.1 s — a key tap, not an utterance
    setVoiceChip({ text: "decoding…", tone: "busy" });
    voiceClientRef.current.transcribe(pcm).then((text) => {
      const t = text.trim();
      // the spoken router confirm is a FIXED LITERAL (never grammar): said
      // alone with an offer pending it confirms; without one it says so —
      // and the trigger itself never becomes an offer
      if (isAgentHandoffTrigger(t)) {
        if (pendingAgentOfferRef.current) { setVoiceChip(null); agentOfferFnsRef.current.confirm(); return true; }
        setVoiceChip({ text: "nothing to hand off — say the command first", tone: "info" });
        clearTimeout(voiceFlashRef.current);
        voiceFlashRef.current = setTimeout(() => setVoiceChip((c) => (c && c.tone === "info" ? null : c)), 2400);
        return false;
      }
      // flash what was heard — the transcript is the receipt — then the
      // outcome lands in the commitMsg bar like every other command
      setVoiceChip(t ? { text: `“${t}”`, tone: "info" } : null);
      clearTimeout(voiceFlashRef.current);
      voiceFlashRef.current = setTimeout(() => setVoiceChip((c) => (c && c.tone === "info" ? null : c)), 2400);
      return Promise.resolve(onVoiceCommandRef.current(t));
    }).catch(() => { setVoiceChip(null); setCommitMsg("Couldn't decode that — try again."); });
  }
  // live refs — the mount-once keyboard effect must never see stale closures
  const onVoiceCommandRef = useRef(null);
  onVoiceCommandRef.current = onVoiceCommand;
  const voiceFnsRef = useRef(null);
  voiceFnsRef.current = { start: voiceHoldStart, end: voiceHoldEnd };
  useEffect(() => {
    const down = (e) => {
      if (e.key === "Escape" && voiceCaptureRef.current) { voiceFnsRef.current.end(false); return; }
      const tg = e.target.tagName;
      if (tg === "INPUT" || tg === "SELECT" || tg === "TEXTAREA") return;
      if (menuDepthRef.current > 0) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if ((e.key || "").toLowerCase() !== "m") return;
      voiceHoldRef.current = true;
      voiceFnsRef.current.start();
    };
    const up = (e) => {
      if ((e.key || "").toLowerCase() !== "m") return;
      if (!voiceHoldRef.current) return;
      voiceHoldRef.current = false;
      voiceFnsRef.current.end(true);
    };
    // tab backgrounded mid-dictation: discard, say so (testing-bar lifecycle)
    const onVis = () => {
      if (document.visibilityState === "hidden" && voiceCaptureRef.current) {
        voiceHoldRef.current = false;
        voiceFnsRef.current.end(false);
        setCommitMsg("Dictation discarded — the tab went to the background.");
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      document.removeEventListener("visibilitychange", onVis);
      // unmount cleanup — no orphaned audio contexts, workers, or offer timers
      voiceCaptureRef.current?.cancel();
      voiceCaptureRef.current = null;
      voiceClientRef.current?.dispose();
      voiceClientRef.current = null;
      clearTimeout(agentOfferTimerRef.current);
      pendingAgentOfferRef.current = null;
    };
  }, []);

  // ── the accept gate ─────────────────────────────────────────────────────────
  // Accept = the explicit human review one-click's Create models: the shape
  // commits through dispatchShape `add` (id/created_at minted there) with the
  // agent_v1 origin receipt — actor agent, reviewed true, the FROZEN proposed
  // ring, the evidence, and the propose/accept timestamps (local provenance;
  // the contribution wire whitelists evidence only, never timing). Post-accept
  // edits then grade through stampEdit exactly like one-click corrections.
  function acceptAgentProposals(ids) {
    const idSet = new Set(ids);
    const take = agentProposals.filter((p) => idSet.has(p.id));
    if (!take.length) return;
    const made = [], accepted = new Set();
    let skippedClosed = 0;
    for (const pr of take) {
      const tp = panels.find((x) => x.key === pr.sheet_id && x.img.w);
      const upp = uppFor(pr.sheet_id);
      if (!tp || !upp || !condById[pr.condition_id]) { skippedClosed++; continue; }
      const ringPx = pr.verts_norm.map(([x, y]) => [x * tp.img.w, y * tp.img.h]);
      made.push({
        sheet_id: pr.sheet_id, condition_id: pr.condition_id, measure_role: pr.measure_role,
        verts_norm: pr.verts_norm.map((v) => [...v]),
        computed: { area_sf: +(ringArea(ringPx) * upp * upp).toFixed(2), perimeter_lf: +(closedMetrics(ringPx).perim * upp).toFixed(2) },
        origin: {
          method: "agent_v1", actor: "agent", reviewed: true,
          proposed_ts: pr.proposed_ts, accepted_ts: nowIso(),
          proposed_verts_norm: pr.verts_norm.map((v) => [...v]),
          ...(pr.seed_norm ? { seed_norm: pr.seed_norm } : {}),
          ...(pr.evidence ? { evidence: pr.evidence } : {}),
        },
      });
      accepted.add(pr.id);
    }
    if (made.length) dispatchShape({ type: "add", shapes: made });   // ONE command — one undo entry for the batch
    setAgentProposals((ps) => ps.filter((p) => !accepted.has(p.id)));
    if (made.length) setCommitMsg(`Accepted ${made.length} agent proposal${made.length === 1 ? "" : "s"}.${skippedClosed ? ` ${skippedClosed} skipped — open their sheet (with its scale set) to accept.` : ""}`);
    else if (skippedClosed) setCommitMsg("Open that proposal's sheet (with its scale set) to accept it.");
  }
  const acceptAgentProposal = (id) => acceptAgentProposals([id]);
  const acceptAllVisibleAgentProposals = () => acceptAgentProposals(agentProposals.filter((p) => panelKeySet.has(p.sheet_id)).map((p) => p.id));
  // Reject = drop from the pending list, LOCAL ONLY. Dismissed-proposal
  // geometry never rides the contribution wire — no rejection records, no
  // counters, nothing for contribute.js to even see (the D34 cut-line).
  const rejectAgentProposal = (id) => setAgentProposals((ps) => ps.filter((p) => p.id !== id));

  // ── the accept gate, for shapes already IN the data ─────────────────────────
  // An imported MCP takeoff arrives committed but unreviewed (origin.reviewed
  // === false) — those render dashed pencil and gate the Accept pill. Accept
  // routes through the `review` command (ONE undo entry), which flips reviewed
  // + stamps accepted_ts and nothing else: affirmation, not an edit. Rejecting
  // one is just deleting it — select and Delete, like any shape.
  const pendingCommitted = useMemo(() => visibleShapes.filter((s) => s.origin?.reviewed === false), [visibleShapes]);
  function acceptPendingShapes() {
    if (!pendingCommitted.length) return;
    dispatchShape({ type: "review", ids: pendingCommitted.map((s) => s.id) });
    setCommitMsg(`Accepted ${pendingCommitted.length} proposed shape${pendingCommitted.length === 1 ? "" : "s"} — pencil is now ink.`);
  }
  const rejectAllAgentProposals = () => setAgentProposals([]);

  // ── the run ────────────────────────────────────────────────────────────────
  const trimJson = (v, n) => { let s; try { s = JSON.stringify(v); } catch { s = String(v); } return s && s.length > n ? `${s.slice(0, n)}…` : s || ""; };
  function appendAgentLog(ev) {
    const entry =
      ev.type === "text" ? { kind: "text", text: ev.text }
      : ev.type === "tool_start" ? { kind: "tool", text: `→ ${ev.name} ${trimJson(ev.args, 120)}` }
      : ev.type === "tool_end" ? (ev.result?.error
          ? { kind: "error", text: `✗ ${ev.name}: ${ev.result.error}` }
          : { kind: "status", text: `✓ ${ev.name} ${trimJson({ ...ev.result, image_data_url: undefined, items: Array.isArray(ev.result?.items) ? `${ev.result.items.length} items` : undefined }, 160)}` })
      : ev.type === "error" ? { kind: "error", text: `Error: ${ev.message}` }
      : ev.type === "aborted" ? { kind: "status", text: "Stopped." }
      : ev.type === "max_iterations" ? { kind: "status", text: `Stopped at the ${ev.limit}-step cap — review what's staged.` }
      : ev.type === "done" ? { kind: "status", text: "Done — review the dashed proposals." }
      : null;
    if (entry) setAgentLog((l) => [...l.slice(-199), entry]);
  }
  async function runAgent(goal) {
    if (agentRunning) return;
    if (!isAiConfigured()) { setShowAiSettings(true); return; }
    if (agentStateRef.current.status !== "ready") { setCommitMsg("Sheet still loading — try again in a moment."); return; }
    const ctl = new AbortController();
    agentAbortRef.current = ctl;
    setAgentRunning(true);
    setAgentLog([{ kind: "status", text: `Goal: ${goal}` }]);
    const ctx = buildAgentCtx();
    try {
      await runAgentLoop({
        cfg: aiConfig(), goal, tools: AGENT_TOOL_DEFS,
        execute: (name, args) => executeAgentTool(ctx, name, args),
        onEvent: appendAgentLog,
        signal: ctl.signal,
      });
    } finally {
      setAgentRunning(false);
      agentAbortRef.current = null;
    }
  }
  const stopAgent = () => agentAbortRef.current?.abort();

  // ── Import from schedule ────────────────────────────────────────────────────
  // Read the marqueed box and open the approval dialog. Two paths, ONE contract
  // (ScheduleRow[] → the same dialog):
  //   • vector plans: the page text layer inside the box IS the extraction —
  //     no OCR, open to everyone (parseSchedule);
  //   • scanned plans: the box has no text tokens, so we rasterize it and hand
  //     the PNG to the optional AI backend (/ai/parse-schedule). That path is
  //     login-gated (see importScheduleFromScan).
  // Corners a,b are stage px (raw cursor, snapping exempted at pointer-down).
  async function importScheduleFromRect(a, b) {
    if (status !== "ready") { setCommitMsg("Sheet still loading — try again in a moment."); return; }
    const panel = panelAt(a[0]);
    if (panelAt(b[0]).key !== panel.key) { setCommitMsg("Draw the box within a single sheet, around its schedule table."); return; }
    const pageObj = pageObjsRef.current.get(panel.key);
    if (!pageObj) { setCommitMsg("Open a sheet first."); return; }
    const rs = renderScalesRef.current.get(panel.key) || RENDER_SCALE;
    const rect = { x0: a[0] - panel.xOffset, y0: a[1], x1: b[0] - panel.xOffset, y1: b[1] };
    const seq = renderSeqRef.current;                 // a sheet switch mid-await must not pop a dialog for a page you left
    let tokens;
    try {
      const vp = pageObj.getViewport({ scale: rs });
      const tc = await pageObj.getTextContent();
      if (seq !== renderSeqRef.current) return;
      tokens = extractRegionText(tc, vp, rect);
    } catch { setCommitMsg("Couldn't read that region."); return; }
    // Vector-vs-scan decision. Tokens present ⇒ TRY the text layer first (a real
    // vector schedule parses straight from it, no OCR cost). But token presence
    // isn't proof of a vector page: scanned plans often carry a stray text layer
    // (embedded OCR, a title block, dimension text) that lands in the marquee yet
    // holds no schedule. So a token-bearing box that parses to NOTHING is not a
    // dead end — fall through to the AI scan path when it's reachable, exactly as
    // a truly text-less raster page would.
    if (tokens.length) {
      const rows = parseSchedule(tokens);
      if (rows.length) { setImportRows(rows); return; }
      // Parsed nothing. If the scan reader isn't reachable — not configured, not
      // signed in, or the account is outside the org domain — the only actionable
      // advice is to re-drag around the table header. Don't fire a paid OCR call
      // and don't claim the page is scanned.
      if (!isGoogleConfigured() || !isSignedIn() || !isAllowedDomain()) {
        setCommitMsg("No schedule found in that box — drag around the finish/material schedule (its CODE / MATERIAL / … header).");
        return;
      }
      // else: the reader is available — let it read the pixels below.
    }
    await importScheduleFromScan(pageObj, rs, rect, seq, tokens.length);
  }

  // Scan/OCR fallback for a raster page: rasterize the marqueed region and POST
  // it to the optional AI backend, then feed the returned rows into the SAME
  // approval dialog. LOGIN-GATED — only a Google-configured deployment with a
  // signed-in user reaches the network (no API key ever lives in client code).
  // tokenCount is the region's text-token count at the routing site: 0 ⇒ a true
  // raster page (no text layer, AI is the only reader); >0 ⇒ the fallthrough from a
  // token-bearing box whose vector parse found nothing. We report WHICH happened
  // (#104) but never claim the >0 case is a "fixable parser gap": scanned plans
  // routinely carry a stray text layer (title block, dimension text, embedded OCR)
  // that lands in the marquee yet holds no schedule, so a token-bearing box that
  // parses to nothing is just as likely a genuine scan as a defeated vector table.
  async function importScheduleFromScan(pageObj, rs, rect, seq, tokenCount) {
    const hadTokens = tokenCount > 0;
    if (!isGoogleConfigured()) {
      setCommitMsg("No schedule found — this looks like a scanned page (no text layer). Importing from scanned plans needs the AI backend.");
      return;
    }
    if (!isSignedIn()) { setCommitMsg("Sign in to import from scanned plans."); return; }
    // Org-only: a signed-in account outside the configured domain must not reach
    // the paid reader (the server 403s it too — this just avoids the round-trip).
    if (!isAllowedDomain()) { setCommitMsg("Your sign-in doesn't have access to the scanned-schedule reader."); return; }
    // A paid read is already in flight — a rapid re-draw of the marquee must not
    // fire a second Gemini call. Surface it (the first call may not have printed
    // "Reading…" yet) so the redraw doesn't look ignored. Clears in finally below.
    if (scanBusyRef.current) { setCommitMsg("Still reading the last schedule — one moment."); return; }
    scanBusyRef.current = true;
    try {
      let png;
      try { png = await rasterizeRegion(pageObj, rs, rect); }
      catch { setCommitMsg("Couldn't read that region."); return; }
      if (seq !== renderSeqRef.current) return;
      // The token is what actually authorizes the paid read — the server verifies
      // it before spending. A missing/expired token here means re-consent, not a
      // silent public call.
      let token;
      try { token = await getAccessToken(); }
      catch { setCommitMsg("Sign in again to import from scanned plans."); return; }
      if (seq !== renderSeqRef.current) return;
      setCommitMsg("Reading the scanned schedule…");
      // #104: record WHY the paid reader was reached, right before the call fires
      // (rasterize + token succeeded), so the log correlates 1:1 with paid reads.
      // no-text-layer = truly raster (AI-only); text-present-unparsed = tokens were
      // in the box but the vector parser produced nothing (NOT asserted as a parser
      // bug — a stray-text scan is indistinguishable from a defeated vector table).
      console.info("[schedule-import] using AI reader", {
        reason: hadTokens ? "text-present-unparsed" : "no-text-layer",
        tokenCount,
      });
      try {
        // A cold serverless start + slow vision call can overrun Netlify's sync cap
        // and return a 504 gateway page; the warm retry succeeds (#102). One retry
        // only, and only on 504 — real errors (401/403/501/5xx JSON) fall through
        // to the handling below on the first response.
        const res = await postScanWithRetry(
          () => fetch(SCAN_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            // client_hd stamps this build's VITE_GOOGLE_HD so the server can warn if
            // it has drifted from the runtime ALLOWED_HD (the client org-gate would
            // then be silently no-op'ing). Diagnostic only — the server's authoritative
            // token + ALLOWED_HD gate ignores it.
            body: JSON.stringify({ image_b64: png.b64, width: png.width, height: png.height, client_hd: orgDomainHint() }),
          }),
          { onRetry: () => setCommitMsg("The reader was warming up — retrying…") },
        );
        if (seq !== renderSeqRef.current) return;
        if (res.status === 401 || res.status === 403) { setCommitMsg("Your sign-in doesn't have access to the scanned-schedule reader."); return; }
        if (res.status === 501) { setCommitMsg("Importing from scanned plans isn't enabled on this deployment."); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = normalizeScanRows(await res.json());
        if (!rows.length) {
          setCommitMsg(hadTokens
            ? "No schedule found in that box — drag around the finish/material schedule (its CODE / MATERIAL / … header)."
            : "No schedule found in that scanned region — the reader returned nothing.");
          return;
        }
        // #104: say why the AI reader ran — honest about the token-bearing case (we
        // read the pixels; we do NOT claim the vector parser has a bug).
        setCommitMsg(hadTokens
          ? `Read ${rows.length} finish${rows.length === 1 ? "" : "es"} from the image — the box had text but we couldn't read it as a table.`
          : `Read ${rows.length} finish${rows.length === 1 ? "" : "es"} — scanned page (no text layer).`);
        setImportRows(rows);
      } catch { setCommitMsg("Couldn't reach the schedule reader — try again in a moment."); }
    } finally {
      scanBusyRef.current = false;
      bumpIdle();   // scan done → let the idle-drain observe the busy→idle edge (Slice 5b)
    }
  }

  // Render just the marqueed region (rs-viewport px, the space rect lives in) to
  // an offscreen canvas and return its PNG as base64 + pixel dims. Mirrors the
  // detail-view offscreen render: shift the region's top-left to (0,0) and clamp
  // to the single-canvas caps so a huge marquee can't exceed the backing store —
  // AND to SCAN_MAX_DIM (scanRasterScale), the server's per-side cap, so a
  // near-full-sheet marquee downscales to fit instead of being rejected with a
  // 400 "invalid image dimensions". Downscales only as far as the cap, so a
  // tighter box still goes at full resolution (better read on small schedule text).
  async function rasterizeRegion(pageObj, rs, rect) {
    const x0 = Math.min(rect.x0, rect.x1), y0 = Math.min(rect.y0, rect.y1);
    const regW = Math.max(1, Math.abs(rect.x1 - rect.x0)), regH = Math.max(1, Math.abs(rect.y1 - rect.y0));
    const factor = Math.min(1, MAX_CANVAS_DIM / regW, MAX_CANVAS_DIM / regH, Math.sqrt(MAX_CANVAS_AREA / (regW * regH)), scanRasterScale(regW, regH));
    const bw = Math.max(1, Math.round(regW * factor)), bh = Math.max(1, Math.round(regH * factor));
    const vp = pageObj.getViewport({ scale: rs * factor });
    const canvas = document.createElement("canvas");
    canvas.width = bw; canvas.height = bh;
    await pageObj.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: [1, 0, 0, 1, -x0 * factor, -y0 * factor],
    }).promise;
    const dataUrl = canvas.toDataURL("image/png");
    return { b64: dataUrl.split(",")[1] || "", width: bw, height: bh };
  }

  // Approved rows → conditions. Category drives color/hatch/waste (rowToSeed);
  // product spec (mfr/style/color/size) rides a plain `spec` field — NOT custom
  // columns (would hijack a user column and pollute its grouping vocabulary) and
  // NOT materials[] (those are coverage buy-list items, no coverage rate here).
  // Existing codes are skipped (shown "in use" in the dialog).
  function createFromSchedule(selected) {
    const existing = new Set(conditions.map((c) => normalizeTag(c.finish_tag)));
    const made = [];
    let idx = conditions.length;
    for (const row of selected) {
      const tag = normalizeTag(row.finish_tag);
      if (existing.has(tag)) continue;
      const seed = rowToSeed({ ...row, finish_tag: tag }, idx++, PALETTE);
      const hasSpec = Object.values(seed.spec).some(Boolean);
      made.push({
        id: uid("cnd"), created_at: nowIso(), finish_tag: seed.finish_tag, color: seed.color, fill: seed.color,
        hatch: seed.hatch, multiplier: 1, waste_pct: seed.waste_pct, materials: [],
        ...(hasSpec ? { spec: seed.spec } : {}),
      });
      existing.add(tag);
    }
    setImportRows(null);
    if (!made.length) { setCommitMsg("Those finishes already exist as conditions."); return; }
    setConditions((cs) => [...cs, ...made]);
    activateCondition(made[0].id, { reassign: false });
    setCommitMsg(`Created ${made.length} condition${made.length === 1 ? "" : "s"} from the schedule.`);
  }
  // every condition-editor save lands here — a bare updated_at is the whole
  // provenance story for conditions (no origin machinery; they're all manual)
  // By-id core + active-based convenience: one save chokepoint. Voice combo
  // intents ("cpt one waste seven") patch a condition activated in the SAME
  // handler, before re-render — the active-based form would hit the old active.
  const updateCondById = (id, patch) => setConditions((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch, updated_at: nowIso() } : c)));
  const updateCond = (patch) => updateCondById(activeCond, patch);

  // delete a condition entirely (and its takeoffs); pick a new active one
  function performDeleteCondition(id) {
    const c = condById[id];
    if (!c) return;
    const owned = shapes.filter((s) => s.condition_id === id);
    const next = conditions.filter((x) => x.id !== id);
    // cascade delete of the condition's OWNED shapes — counted centrally by the
    // command, but record:false keeps it off the undo stack: the confirm just
    // said "can't be undone", and ⌘Z restoring shapes without their condition
    // would resurrect orphans
    if (owned.length) dispatchShape({ type: "delete", ids: owned.map((s) => s.id), reason: "condition-delete" }, { record: false });
    setConditions(next);
    unpinFromPalette(id);   // a deleted condition can't stay pinned in the palette
    if (activeCond === id) setActiveCond(next[0]?.id || "");
    // no bulk-selection pruning needed here: the panel derives liveness from
    // the conditions prop (liveChecked = conditions ∩ checked), so a deleted
    // id left in its checked set is inert by construction
    setCommitMsg(`Deleted ${c.finish_tag}${owned.length ? ` and ${owned.length} takeoff${owned.length === 1 ? "" : "s"}` : ""}.`);
  }
  function deleteCondition(id) {
    const c = condById[id];
    if (!c) return;
    const owned = shapes.filter((s) => s.condition_id === id);
    if (owned.length) {
      setPendingTakeoffsConfirm({
        kind: "deleteCondition",
        payload: { id },
        title: `Delete ${c.finish_tag}?`,
        body: `This will also delete its ${owned.length} takeoff${owned.length === 1 ? "" : "s"}. This can't be undone.`,
        confirmLabel: "Delete",
      });
      return;
    }
    performDeleteCondition(id);
  }

  // custom columns: project-scoped vocabulary editing + per-condition assignment.
  // Snapshot-compare asymmetry, accepted: the diff (COND_FIELDS quantities) is
  // blind to attrs/definition changes, yet Load restores them — an assignments-
  // only change diffs as "unchanged". Known, not a bug.
  const assignAttr = (colId, v) => {
    // hydrate sanitizes attrs (sanitizeConditionAttrs), so spreading is safe;
    // an absent attrs spreads to {}
    const attrs = { ...aCond?.attrs };
    if (v) attrs[colId] = v; else delete attrs[colId];   // Unassigned = key absent, never ""
    updateCond({ attrs });
  };
  const addColumn = () => setConditionColumns((cols) => [...cols, { id: uid("col"), name: "", values: [] }]);
  const renameColumn = (colId, name) => setConditionColumns((cols) => cols.map((cc) => (cc.id === colId ? { ...cc, name } : cc)));   // id stays — assignments follow automatically
  const addColumnValue = (colId, v) => setConditionColumns((cols) => cols.map((cc) => (cc.id === colId && !cc.values.includes(v) ? { ...cc, values: [...cc.values, v] } : cc)));
  const removeColumnValue = (colId, v) => setConditionColumns((cols) => cols.map((cc) => (cc.id === colId ? { ...cc, values: cc.values.filter((x) => x !== v) } : cc)));   // assigned conditions keep the string — selects show "(removed)"
  const renameColumnVal = (colId, oldV) => {
    const newV = (window.prompt("Rename value:", oldV) || "").trim();
    if (!newV || newV === oldV) return;
    // rename into an existing value = merge (values are unique — they key the chips and the select options)
    setConditionColumns((cols) => cols.map((cc) => (cc.id === colId ? { ...cc, values: cc.values.includes(newV) ? cc.values.filter((x) => x !== oldV) : cc.values.map((x) => (x === oldV ? newV : x)) } : cc)));
    setConditions((cs) => renameColumnValue(cs, colId, oldV, newV));   // assignments follow the vocabulary
  };
  const deleteColumn = (colId) => {
    const cc = conditionColumns.find((c) => c.id === colId);
    if (!cc) return;
    setPendingTakeoffsConfirm({
      kind: "deleteColumn",
      payload: { colId },
      title: `Delete column “${columnLabel(cc)}”?`,
      body: `Delete column "${columnLabel(cc)}" for the whole project? Conditions keep their values but they're no longer shown or exported.`,
      confirmLabel: "Delete",
    });
  };
  const performDeleteColumn = (colId) => {
    setConditionColumns((cols) => cols.filter((c) => c.id !== colId));   // orphaned attrs[colId] stay behind — harmless, nothing iterates raw attrs
  };

  // shape-label vocabulary (#110): a flat project-level list; each shape carries
  // at most one, on shape.label. Mirrors the column-value family above.
  const addLabel = (v) => setShapeLabels((ls) => (ls.includes(v) ? ls : [...ls, v]));
  const removeLabel = (v) => setShapeLabels((ls) => ls.filter((x) => x !== v));   // labeled shapes keep the string — it falls into an ad-hoc report group, nothing disappears from totals
  const renameLabel = (oldV) => {
    const newV = (window.prompt("Rename label:", oldV) || "").trim();
    if (!newV || newV === oldV) return;
    // rename into an existing value = merge (labels are unique — they key the chips and the report's group headers)
    setShapeLabels((ls) => (ls.includes(newV) ? ls.filter((x) => x !== oldV) : ls.map((x) => (x === oldV ? newV : x))));
    setShapes((sh) => renameShapeLabel(sh, oldV, newV));   // assignments follow the vocabulary
  };

  // supporting-materials editing (operates on the active condition)
  const addMaterial = () => updateCond({ materials: [...(aCond?.materials || []), { id: uid("mat"), name: "", per: 0, basis: "area", unit: "", round: true }] });
  const updateMaterial = (mid, patch) => updateCond({ materials: (aCond?.materials || []).map((m) => (m.id === mid ? matEditPatch(m, patch) : m)) });   // NAME edits re-classify a geometry-less line's kind
  const removeMaterial = (mid) => updateCond({ materials: (aCond?.materials || []).filter((m) => m.id !== mid) });
  // Height/Thickness are LIVE parameters (Kreo-style): changing them re-flows
  // every dependent shape on this condition — wall SF tracks the tile height.
  const setCondParam = (field, raw) => {
    const v = raw === "" ? null : Math.max(0, parseFloat(raw) || 0);
    updateCond({ [field]: v });
    setShapes((ss) => ss.map((s) => {
      // height: existing walls KEEP their drawn height (the condition H only
      // seeds new traces — Michael: 4-ft wainscot stays 4 ft when the next
      // wall goes full height). Thickness still re-flows linears live.
      if (s.condition_id !== activeCond) return s;
      if (!(field === "thickness_in" && s.measure_role === "linear")) return s;
      const sp = panelByKey(s.sheet_id);
      const u = uppFor(s.sheet_id) || 0;
      const lpts = s.verts_norm.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
      const LF = openLen(s.curved ? flattenCurve(lpts) : lpts) * u;
      return { ...s, computed: { perimeter_lf: +LF.toFixed(2), area_sf: v > 0 ? +((LF * v) / 12).toFixed(2) : 0 } };
    }));
  };
  // "Undo last shape" (toolbar/⌫) is NOT ⌘Z: it stays what it always was — a
  // DELETE of the newest shape on the focused sheets (a decision, so it still
  // counts toward the deletion tally, now via the command's central tally).
  // It records on the undo stack like any delete, so ⌘Z can resurrect it.
  function undoLast() {
    const mine = shapes.filter((x) => panelKeySet.has(x.sheet_id));
    if (!mine.length) return;
    dispatchShape({ type: "delete", ids: [mine[mine.length - 1].id], reason: "undo-last" });
  }

  const condById = Object.fromEntries(conditions.map((c) => [c.id, c]));
  const aCond = condById[activeCond];
  // resolve pinned ids to live conditions for the top-bar palette (a stale id
  // renders nothing — the persisted list is pruned on save/delete, this is the
  // render-time guard)
  const activeColor = aCond?.color || "#c96442";
  // Pattern id encodes the appearance so a hatch/color change yields a NEW paint
  // server — otherwise browsers keep painting the cached old pattern (the "it
  // reverted" bug). Shapes and <defs> use the same id.
  const patId = (c) => `hx-${c.id}-${c.hatch || "solid"}-${String(c.color).slice(1)}-${String(c.fill || "n").slice(1)}${darkMode ? "-d" : ""}`;
  // Fill for a committed shape. Hatch tiles are 10 stage-units — once the zoom
  // puts a tile under ~4 screen px the pattern aliases into subpixel mush
  // (worst over the inverted dark sheet), so overview zoom swaps to a solid
  // tint and every condition still reads as a clear color block. Dark mode gets
  // its legibility from brighter alphas here, NOT from a CSS filter on the
  // overlay — filtering that whole layer re-rasterizes it on every sync.
  const shapeFill = (cond) => {
    if (!cond) return "none";
    const solid = cond.fill && cond.fill !== NO_FILL ? cond.fill : null;
    if (tf.scale < 0.35) return (solid || cond.color) + (darkMode ? "59" : "40");
    if (cond.hatch && cond.hatch !== "solid") return `url(#${patId(cond)})`;
    return solid ? solid + (darkMode ? "4d" : "33") : "none";
  };
  const mm = closedMetrics(poly);
  // the live readout prices the IN-PROGRESS poly with its own panel's scale
  const liveUpp = poly.length ? uppFor(panelAt(poly[0][0]).key) : uppFor(focusPanel.key);
  const liveArea = liveUpp ? mm.area * liveUpp * liveUpp : null;
  const livePerim = liveUpp ? mm.perim * liveUpp : null;
  // A zone trace with points on more than one panel (side-by-side group mode,
  // a gap click routing to the neighboring panel): finishShape normalizes
  // every point against the FIRST point's panel, so a second-panel point
  // would land at nx > 1 — outside that panel's own [0..1] space — and the
  // overlay would still draw the dashed region exactly where traced,
  // visually enclosing rooms on the second sheet that shapesInZone (filtered
  // to a single sheet_id) can never count. Reject it outright — mirrors the
  // check tool's checkCross guard, the same hazard on a 2-point span.
  const zoneTraceCross = tool === "zone" && poly.length >= 1 && poly.some((p) => panelAt(p[0]).key !== panelAt(poly[0][0]).key);
  const condMult = aCond?.multiplier || 1;
  // HUD + Takeoffs panel are sheet-scoped ("this sheet"): they total the
  // VISIBLE shapes through the same conditionTotals rules the Report uses —
  // one source of role math, two scopes. Memoized: visRowById is a prop of the
  // memoized panel, so its identity must only change when the totals can.
  const recomputeShapeRef = useRef(recomputeShape);
  const panelByKeyRef = useRef(panelByKey);
  const uppForRef = useRef(uppFor);
  const layerGroupIdsForRef = useRef(layerGroupIdsFor);
  recomputeShapeRef.current = recomputeShape;
  panelByKeyRef.current = panelByKey;
  uppForRef.current = uppFor;
  layerGroupIdsForRef.current = layerGroupIdsFor;
  const visibleShapesMeasured = useMemo(() => {
    void scales;
    void conditions;
    return drawableShapes.map((s) => {
      if (s.measure_role === "surface_area" || s.measure_role === "wall_area") {
        return { ...s, computed: recomputeShapeRef.current(s) };
      }
      return s;
    });
  }, [drawableShapes, scales, conditions]);
  const visRows = useMemo(() => conditionTotals(conditions, visibleShapesMeasured), [conditions, visibleShapesMeasured]);
  const visRowById = useMemo(() => new Map(visRows.map((r) => [r.id, r])), [visRows]);
  // Zone check: the SAME conditionTotals rules on the shapes whose center point
  // sits inside the traced zone (lib/zone.js) — third scope of the one role math.
  const zoneShapes = useMemo(() => (zoneCheck ? shapesInZone(shapes, zoneCheck) : null), [shapes, zoneCheck]);
  const zoneRows = useMemo(
    () => (zoneShapes ? conditionTotals(conditions, zoneShapes).filter((r) => r.shape_count > 0) : null),
    [conditions, zoneShapes]
  );
  const zoneIds = useMemo(() => (zoneShapes ? new Set(zoneShapes.map((sh) => sh.id)) : null), [zoneShapes]);
  const condRow = visRowById.get(activeCond);
  const condTotal = condRow?.floor_sf || 0;
  const lfTotal = condRow?.lf || 0;
  const countTotal = condRow?.ea || 0;
  const wallTotal = condRow?.wall_sf || 0;
  const borderTotal = condRow?.border_sf || 0;
  const condDeduction = useMemo(() => {
    void scales;
    if (!activeCond) return { floorBefore: 0, floorAfter: 0, wallBefore: 0, wallAfter: 0 };
    const mult = condMult || 1;
    let floorGross = 0;
    let floorNet = 0;
    let floorDed = 0;
    let wallGross = 0;
    let wallNet = 0;
    for (const s of visibleShapesMeasured) {
      if (s.condition_id !== activeCond) continue;
      const cp = s.computed || {};
      if (s.measure_role === "floor_area") {
        floorNet += cp.area_sf || 0;
        const sp = panelByKeyRef.current(s.sheet_id);
        const u = uppForRef.current(s.sheet_id) || 0;
        if (sp?.img?.w && u && s.verts_norm?.length >= 3) {
          const pts = s.verts_norm.map(([nx, ny]) => [nx * sp.img.w, ny * sp.img.h]);
          floorGross += closedMetrics(pts).area * u * u;
        } else floorGross += cp.area_sf || 0;
      } else if (s.measure_role === "deduct") floorDed += cp.area_sf || 0;
      else if (s.measure_role === "surface_area") {
        wallGross += cp.gross_face_sf || cp.area_sf || 0;
        wallNet += cp.area_sf || 0;
      } else if (s.measure_role === "wall_area") {
        wallGross += cp.gross_face_sf || cp.wall_face_sf || cp.area_sf || 0;
        wallNet += cp.wall_face_sf || cp.area_sf || 0;
      }
    }
    const r2 = (v) => +((Number(v) || 0).toFixed(2));
    return {
      floorBefore: r2(floorGross * mult),
      floorAfter: r2((floorNet - floorDed) * mult),
      wallBefore: r2(wallGross * mult),
      wallAfter: r2(wallNet * mult),
    };
  }, [activeCond, visibleShapesMeasured, condMult, scales]);
  const sheetFloorSf = visRows.reduce((n, r) => n + r.floor_sf, 0);
  const sheetWallSf = visRows.reduce((n, r) => n + r.wall_sf, 0);
  // display-only Kreo-style derived metric: floor-area perimeters × the condition height
  const condH = Number(aCond?.height_ft) || 0; // the live-readout JSX below still reads this
  const vertTotal = verticalWallSf(drawableShapes, activeCond, aCond?.height_ft, condMult);
  const num = (v, d = 1) => v.toLocaleString(undefined, { maximumFractionDigits: d });
  // unit-system display edge: internal math is always feet (lib/units.ts)
  const fa = (sf, d = 1) => `${num(areaVal(sf, units), d)} ${areaUnit(units)}`;
  const fl = (lf, d = 1) => `${num(lenVal(lf, units), d)} ${lenUnit(units)}`;
  const faSY = (sf) => (units === "metric" ? fa(sf) : `${num(sf)} SF · ${num(sf / 9)} SY`);
  const stdValue = unitsPerPx ? (STANDARD_SCALES.find((s) => Math.abs(s.upp - unitsPerPx) < 1e-9)?.label || "") : "";
  // Check tool: measured span at the current scale vs what the drawing says
  const checkPanel = check.length ? panelAt(check[0][0]) : null;
  const checkUpp = checkPanel ? uppFor(checkPanel.key) : null;
  const checkCross = check.length === 2 && panelAt(check[1][0]).key !== checkPanel.key;
  const checkPx = check.length === 2 && !checkCross ? Math.hypot(check[1][0] - check[0][0], check[1][1] - check[0][1]) : 0;
  const checkFeet = checkUpp && checkPx ? checkPx * checkUpp : null;
  const checkStatedFeet = parseLenInput(checkStated, units);
  const checkErrPct = checkFeet && checkStatedFeet > 0 ? ((checkFeet - checkStatedFeet) / checkStatedFeet) * 100 : null;

  const markupCount = markups.filter((m) => panelKeySet.has(m.sheet_id)).length;
  const selShapeRaw = selectedId ? visibleShapes.find((s) => s.id === selectedId) : null;
  const selShape = useMemo(() => {
    void visibleShapes;
    void scales;
    void conditions;
    if (!selShapeRaw) return null;
    if (selShapeRaw.measure_role === "surface_area" || selShapeRaw.measure_role === "wall_area") {
      return { ...selShapeRaw, computed: recomputeShapeRef.current(selShapeRaw) };
    }
    return selShapeRaw;
  }, [selShapeRaw, visibleShapes, scales, conditions]);
  const selectedLayerGroupMemberIds = useMemo(() => {
    void layerForest;
    const picks = Object.keys(activeLayerPickIds(selectedId, layerPickIds));
    if (picks.length) return new Set(picks);
    if (!selectedId) return new Set();
    return new Set(layerGroupIdsForRef.current(selectedId));
  }, [selectedId, layerPickIds, layerForest]);
  const selWallSegmentRows = useMemo(() => {
    void scales;
    void conditions;
    if (!selShape || selShape.measure_role !== "surface_area") return [];
    const sp = panelByKeyRef.current(selShape.sheet_id);
    const upp = uppForRef.current(selShape.sheet_id) || 0;
    if (!sp?.img?.w || !upp) return [];
    return wallSegmentRows(selShape, sp.img.w, sp.img.h, upp, Number(condById[selShape.condition_id]?.height_ft) || 0);
  }, [selShape, scales, conditions, condById]);
  function patchShapeHeight(shapeId, raw, clear = false) {
    setShapes((ss) => ss.map((s) => {
      if (s.id !== shapeId) return s;
      if (clear) {
        const origin = { ...(s.origin || {}) };
        delete origin.segment_heights_ft;
        const next = {
          ...s,
          origin,
          height_ft: Number(condById[s.condition_id]?.height_ft) || 0,
          height_override: false,
        };
        delete next.segment_heights_ft;
        return { ...next, computed: recomputeShape(next) };
      }
      const v = Math.max(0, parseFloat(raw) || 0);
      const closed = !!(s.origin?.closed_loop);
      const n = Math.max(0, (s.verts_norm?.length || 0) - (closed ? 0 : 1));
      let next = { ...s, height_ft: v, height_override: true };
      if (s.measure_role === "surface_area" && n > 0) {
        next = withSegmentHeights(next, Array(n).fill(v));
      }
      return { ...next, computed: recomputeShape(next) };
    }));
  }
  const setShapeHeight = (raw) => { if (selectedId) patchShapeHeight(selectedId, raw); };
  const clearShapeHeight = () => { if (selectedId) patchShapeHeight(selectedId, null, true); };
  function setSegmentHeight(shapeId, segIndex, raw) {
    const v = Math.max(0, parseFloat(raw) || 0);
    setShapes((ss) => ss.map((s) => {
      if (s.id !== shapeId || s.measure_role !== "surface_area") return s;
      const condH = Number(condById[s.condition_id]?.height_ft) || 0;
      const hs = [...segmentHeightsForShape(s, condH)];
      if (segIndex < 0 || segIndex >= hs.length) return s;
      hs[segIndex] = v;
      const next = withSegmentHeights({ ...s, height_ft: v }, hs);
      return { ...next, computed: recomputeShape(next) };
    }));
  }
  function wallSegmentIndexFromVert(shape, vertIndex) {
    if (!shape || shape.measure_role !== "surface_area" || vertIndex == null) return null;
    const n = shape.verts_norm?.length || 0;
    if (n <= 2) return null;
    return vertIndex > 0 ? vertIndex - 1 : 0;
  }
  function flyToWallSegment(shapeId, segIndex) {
    const s = shapesRef.current.find((x) => x.id === shapeId);
    if (!s || s.measure_role !== "surface_area") return;
    if (!panelKeySet.has(s.sheet_id)) {
      pendingFlyShapeRef.current = shapeId;
      openSheets([s.sheet_id], false);
      return;
    }
    const sp = panelByKey(s.sheet_id);
    const el = containerRef.current;
    const a = s.verts_norm?.[segIndex];
    const b = s.verts_norm?.[segIndex + 1];
    if (!sp?.img?.w || !el || !a || !b) { flyToShape(shapeId); return; }
    const ax = a[0] * sp.img.w + sp.xOffset, ay = a[1] * sp.img.h;
    const bx = b[0] * sp.img.w + sp.xOffset, by = b[1] * sp.img.h;
    const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
    const minY = Math.min(ay, by), maxY = Math.max(ay, by);
    const r = el.getBoundingClientRect();
    const w = Math.max(maxX - minX, 48), h = Math.max(maxY - minY, 48);
    const pad = 80;
    const scale = clamp(Math.min((r.width - pad) / w, (r.height - pad) / h, 2.5));
    setTfNow({ x: (r.width - w * scale) / 2 - minX * scale, y: (r.height - h * scale) / 2 - minY * scale, scale });
    selectShape(shapeId);
    setWallSegmentFocus(segIndex);
    setSelVert(segIndex + 1);
    revealSheetInFilesSidebar(s.sheet_id);
  }
  // Door/window openings on wall face — qty deduct only (not floor-style holes).
  const patchWallOpeningsFor = (shapeId, mutate) => {
    if (!shapeId) return;
    setShapes((ss) => ss.map((s) => {
      if (s.id !== shapeId) return s;
      if (s.measure_role !== "wall_area" && s.measure_role !== "surface_area" && s.measure_role !== "floor_area") return s;
      const openings = mutate([...(s.openings || [])]);
      const next = { ...s, openings };
      return { ...next, computed: recomputeShape(next) };
    }));
  };
  const patchSelectedWallOpenings = (mutate) => patchWallOpeningsFor(selectedId, mutate);
  // Start a linear custom cutout on the selected wall_area — snaps only to that perimeter.
  const startWallCutoutLinear = () => {
    const s = selectedId ? shapesRef.current.find((x) => x.id === selectedId) : null;
    if (!s || s.measure_role !== "wall_area") {
      setCommitMsg("Select a wall area line first — custom cutouts snap only to wall area.");
      return;
    }
    setTool("select");
    setWallCutoutDraft({ shapeId: s.id, a: null });
    setCommitMsg("Custom cutout — click two points on the wall area line (snaps to that line). Esc cancels · click again for another.");
  };
  const commitWallCutoutLinear = (shapeId, a, b) => {
    const wall = shapesRef.current.find((s) => s.id === shapeId);
    if (!wall || wall.measure_role !== "wall_area") return;
    const tp = panelByKey(wall.sheet_id);
    if (!tp?.img?.w) return;
    const upp = uppFor(wall.sheet_id);
    if (!(upp > 0)) {
      setCommitMsg("Calibrate scale before adding a custom cutout.");
      return;
    }
    const width_ft = Math.hypot(b[0] - a[0], b[1] - a[1]) * upp;
    if (!(width_ft > 0.05)) {
      setCommitMsg("Cutout too short — click a longer span on the wall area line.");
      return;
    }
    const hWall = wall.height_override === true
      ? Number(wall.height_ft) || 0
      : Number(wall.height_ft) || Number(condById[wall.condition_id]?.height_ft) || 0;
    const defaultH = units === "metric" ? 2.1 / M_PER_FT : 7;
    const height_ft = hWall > 0 ? Math.min(defaultH, hWall) : defaultH;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const anchor_norm = [(mx - tp.xOffset) / tp.img.w, my / tp.img.h];
    addWallOpening({
      source: "cutout",
      tag: "",
      kind: "door",
      width_ft: +width_ft.toFixed(4),
      height_ft: +height_ft.toFixed(4),
      anchor_norm,
      span_a_norm: [(a[0] - tp.xOffset) / tp.img.w, a[1] / tp.img.h],
      span_b_norm: [(b[0] - tp.xOffset) / tp.img.w, b[1] / tp.img.h],
    }, shapeId);
    setSelectedId(shapeId);
    setCommitMsg(`Custom cutout added — ${units === "metric" ? `${(width_ft * M_PER_FT).toFixed(2)} m` : `${width_ft.toFixed(2)} ft`} wide. Click again for another, or Esc to finish.`);
    setWallCutoutDraft({ shapeId, a: null });
    if (rubberRef.current) rubberRef.current.style.display = "none";
  };
  const addWallOpening = (partial = {}, shapeId = selectedId) => {
    const parsed = partial.size ? parseOpeningSize(partial.size) : null;
    const defaultW = units === "metric" ? 0.9 / M_PER_FT : 3;
    const defaultH = units === "metric" ? 2.1 / M_PER_FT : 7;
    const wall = shapeId ? shapesRef.current.find((s) => s.id === shapeId) : null;
    const tp = wall ? panelByKey(wall.sheet_id) : null;
    let symbol_id = partial.symbol_id || "";
    let anchor_norm = Array.isArray(partial.anchor_norm) ? partial.anchor_norm : null;
    const tag = partial.tag || "";
    let symKind = partial.kind || "door";
    if ((!symbol_id || !anchor_norm) && tag && wall && tp?.img?.w) {
      const sym = planSymbols.find((p) =>
        p.sheet_id === wall.sheet_id
        && isWallOpeningSymbol(p)
        && String(p.tag || "").toUpperCase() === String(tag).toUpperCase());
      if (sym) {
        symbol_id = symbol_id || sym.id;
        symKind = openingKindForSymbol(sym);
        if (!anchor_norm) anchor_norm = [sym.x / tp.img.w, sym.y / tp.img.h];
      }
    }
    const opn = {
      id: uid("opn"),
      kind: symKind,
      tag,
      ...(symbol_id ? { symbol_id } : {}),
      ...(anchor_norm ? { anchor_norm } : {}),
      ...(Array.isArray(partial.span_a_norm) ? { span_a_norm: partial.span_a_norm } : {}),
      ...(Array.isArray(partial.span_b_norm) ? { span_b_norm: partial.span_b_norm } : {}),
      width_ft: Number(partial.width_ft) > 0 ? Number(partial.width_ft) : (parsed?.width_ft || defaultW),
      height_ft: Number(partial.height_ft) > 0 ? Number(partial.height_ft) : (parsed?.height_ft || defaultH),
      source: partial.source || (tag || parsed ? "schedule" : "manual"),
    };
    patchWallOpeningsFor(shapeId, (list) => [...list, opn]);
  };
  const deductDoorOnWall = (shapeId, ref) => {
    if (!shapeId || !ref?.tag) return;
    const sym = ref.symbol_id ? planSymbols.find((p) => p.id === ref.symbol_id) : null;
    const wall = shapesRef.current.find((s) => s.id === shapeId);
    const tp = wall ? panelByKey(wall.sheet_id) : null;
    let size = ref.size || "";
    if (sym && tp?.img?.w) {
      const nk = symbolNoteKey(sym.sheet_id, sym.tag, sym.x, sym.y);
      const fields = resolveSymbolFields(sym.schedule || {}, symbolNotes[nk], sym.room_name);
      size = fields.size || sym.schedule?.size || size;
    }
    setSelectedId(shapeId);
    addWallOpening({
      tag: ref.tag,
      kind: sym ? openingKindForSymbol(sym) : (ref.kind || "door"),
      size,
      symbol_id: ref.symbol_id || sym?.id || "",
      source: "schedule",
    }, shapeId);
    setCommitMsg(`Door ${ref.tag} deducted from wall face — edit H in the readout if net looks off.`);
  };
  const updateWallOpening = (opnId, patch) => {
    patchSelectedWallOpenings((list) => list.map((o) => (o.id === opnId ? { ...o, ...patch } : o)));
  };
  const removeWallOpening = (opnId) => {
    patchSelectedWallOpenings((list) => list.filter((o) => o.id !== opnId));
  };
  const doorScheduleOptions = useMemo(() => {
    if (!selShape || (selShape.measure_role !== "wall_area" && selShape.measure_role !== "surface_area")) return [];
    const seen = new Set();
    const out = [];
    for (const sym of planSymbols) {
      if (sym.sheet_id !== selShape.sheet_id || !isWallOpeningSymbol(sym)) continue;
      const tag = String(sym.tag || "").toUpperCase();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      const nk = symbolNoteKey(sym.sheet_id, sym.tag, sym.x, sym.y);
      const fields = resolveSymbolFields(sym.schedule || {}, symbolNotes[nk], sym.room_name);
      out.push({
        tag,
        size: fields.size || sym.schedule?.size || "",
        symbol_id: sym.id,
        kind: openingKindForSymbol(sym),
      });
    }
    return out.sort((a, b) => a.tag.localeCompare(b.tag));
  }, [selShape, planSymbols, symbolNotes]);
  // Floating Condition Edit — apply only to the selected takeoff and/or the
  // in-progress draw. Appearance rides on the shape (saved in annotations);
  // other fields clone a private condition for that one shape so peers keep theirs.
  const FLOAT_APPEARANCE_KEYS = ["color", "fill", "hatch", "line_style", "weight"];
  const resolveShapeLook = (shape, cond) => {
    if (!cond) return null;
    if (!shape?.appearance_override) return cond;
    return {
      ...cond,
      ...(shape.color != null ? { color: shape.color } : {}),
      ...(shape.fill != null ? { fill: shape.fill } : {}),
      ...(shape.hatch != null ? { hatch: shape.hatch } : {}),
      ...(shape.line_style != null ? { line_style: shape.line_style } : {}),
      ...(shape.weight != null ? { weight: shape.weight } : {}),
    };
  };
  const isolateShapeCondition = (shapeId, patch) => {
    const sel = shapesRef.current.find((s) => s.id === shapeId);
    if (!sel) return;
    const base = condById[sel.condition_id];
    if (!base) return;
    const peers = shapesRef.current.filter((s) => s.condition_id === sel.condition_id);
    if (peers.length <= 1) {
      updateCondById(sel.condition_id, patch);
      return;
    }
    const nid = uid("cnd");
    const clone = {
      ...base,
      id: nid,
      materials: (base.materials || []).map((m) => ({ ...m, id: uid("mat") })),
      attrs: { ...(base.attrs || {}) },
      spec: base.spec && typeof base.spec === "object" && !Array.isArray(base.spec) ? { ...base.spec } : base.spec,
      ...patch,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    setConditions((cs) => [...cs, clone]);
    dispatchShape({ type: "reassign", ids: [sel.id], condition_id: nid });
    setActiveCond(nid);
  };
  const floatEditTargetShape = () => {
    if (selectedId) {
      const hit = shapesRef.current.find((s) => s.id === selectedId);
      if (hit) return hit;
    }
    // Condition Edit open with a just-drawn takeoff: allow Line/Fill colour on
    // the latest shape of the active condition (not every CPT-1 mask).
    if (!activeCond) return null;
    const pool = shapesRef.current.filter((s) => s.condition_id === activeCond);
    return pool.length ? pool[pool.length - 1] : null;
  };
  const applyFloatCondEdit = (patch) => {
    const sel = floatEditTargetShape();
    const drawing = poly.length > 0
      || !!(proposal?.regions?.length)
      || !!(wallProposal?.regions?.length)
      || tool === "rect"
      || tool === "deduct-rect"
      || MEASURE_TOOLS.some((t) => t.id === tool);
    if (!sel && !drawing) {
      setCommitMsg("Select a takeoff or start drawing — Edit applies only to that selection.");
      return;
    }
    const app = {};
    const rest = { ...patch };
    for (const k of FLOAT_APPEARANCE_KEYS) {
      if (k in rest) { app[k] = rest[k]; delete rest[k]; }
    }
    if ("height_ft" in rest && sel) {
      const v = rest.height_ft;
      if (sel.measure_role === "surface_area") {
        updateCondById(sel.condition_id, { height_ft: v });
      }
      delete rest.height_ft;
      if (selectedId === sel.id) {
        if (v == null || v === "") clearShapeHeight();
        else setShapeHeight(v);
      } else {
        setShapes((ss) => ss.map((s) => {
          if (s.id !== sel.id) return s;
          if (v == null || v === "") {
            const origin = { ...(s.origin || {}) };
            delete origin.segment_heights_ft;
            const next = {
              ...s,
              origin,
              height_ft: Number(condById[s.condition_id]?.height_ft) || 0,
              height_override: false,
            };
            delete next.segment_heights_ft;
            return { ...next, computed: recomputeShape(next) };
          }
          const closed = !!(s.origin?.closed_loop);
          const n = Math.max(0, (s.verts_norm?.length || 0) - (closed ? 0 : 1));
          let next = { ...s, height_ft: Math.max(0, Number(v) || 0), height_override: true };
          if (s.measure_role === "surface_area" && n > 0) {
            next = withSegmentHeights(next, Array(n).fill(Math.max(0, Number(v) || 0)));
          }
          return { ...next, computed: recomputeShape(next) };
        }));
      }
    }
    if (Object.keys(app).length) {
      if (sel) {
        setShapes((ss) => ss.map((s) => (s.id === sel.id ? { ...s, ...app, appearance_override: true } : s)));
      }
      if (drawing) setDrawAppearance((d) => ({ ...(d || {}), ...app }));
    }
    if (Object.keys(rest).length) {
      if (sel) isolateShapeCondition(sel.id, rest);
      else if (drawing) setDrawAppearance((d) => ({ ...(d || {}), ...rest }));
    }
  };
  const applyFloatCondParam = (field, raw) => {
    const v = raw === "" ? null : Math.max(0, parseFloat(raw) || 0);
    applyFloatCondEdit({ [field]: v });
  };
  // Height / thickness share one condition value — keep the docked Takeoffs row
  // and the floating Condition editor on the same live parameters.
  const syncFloatCondParam = (field, raw) => {
    if (field === "height_ft" || field === "thickness_in") setCondParam(field, raw);
    else applyFloatCondParam(field, raw);
  };
  const applyFloatAssignAttr = (colId, v) => {
    const sel = selectedId ? shapesRef.current.find((s) => s.id === selectedId) : null;
    if (!sel) {
      setCommitMsg("Select a takeoff first — Edit applies only to that selection.");
      return;
    }
    const base = condById[sel.condition_id];
    const attrs = { ...(base?.attrs || {}) };
    if (v) attrs[colId] = v; else delete attrs[colId];
    isolateShapeCondition(sel.id, { attrs });
  };
  const floatEditCond = (() => {
    if (!aCond) return null;
    const sel = selectedId
      ? shapes.find((s) => s.id === selectedId)
      : (() => {
          const pool = shapes.filter((s) => s.condition_id === activeCond);
          return pool.length ? pool[pool.length - 1] : null;
        })();
    if (sel) {
      const base = condById[sel.condition_id] || aCond;
      const look = resolveShapeLook(sel, base) || base;
      return drawAppearance ? { ...look, ...drawAppearance } : look;
    }
    if (drawAppearance) return { ...aCond, ...drawAppearance };
    return aCond;
  })();
  const liveDrawLook = drawAppearance && aCond ? { ...aCond, ...drawAppearance } : aCond;
  const finishOk = canFinishDraw(tool, poly.length, { zoneCross: zoneTraceCross });

  const writeMeasureRailLocalPos = useCallback((rail, pos) => {
    if (!rail || !pos) return;
    rail.style.left = `${pos.x}px`;
    rail.style.top = `${pos.y}px`;
    rail.style.transform = "none";
  }, []);
  const clampMeasureRailPos = useCallback((x, y) => {
    const rail = measureRailRef.current;
    if (!rail) return { x, y };
    const stack = rail.querySelector(".canvas-left-stack");
    const rw = stack?.offsetWidth || rail.offsetWidth || 48;
    const rh = stack?.offsetHeight || rail.offsetHeight || 320;
    const pad = 4;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const vw = vv?.width ?? window.innerWidth;
    const vh = vv?.height ?? window.innerHeight;
    const vx = vv?.offsetLeft ?? 0;
    const vy = vv?.offsetTop ?? 0;
    return {
      x: Math.min(Math.max(vx + pad, x), vx + vw - rw - pad),
      y: Math.min(Math.max(vy + pad, y), vy + vh - rh - pad),
    };
  }, []);
  const getMeasureRailDefaultPos = useCallback(() => {
    const rail = measureRailRef.current;
    const stack = rail?.querySelector(".canvas-left-stack");
    const stackH = stack?.getBoundingClientRect().height ?? stack?.offsetHeight ?? 240;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const vh = vv?.height ?? window.innerHeight;
    const vy = vv?.offsetTop ?? 0;
    const vx = vv?.offsetLeft ?? 0;
    const inset = 12;
    return {
      x: vx + 16,
      y: vy + Math.max(inset, (vh - stackH) / 2),
    };
  }, []);
  const syncMeasureRailLayout = useCallback(() => {
    const rail = measureRailRef.current;
    if (!rail || measureRailDraggingRef.current || measureRailResettingRef.current) return;
    const p = measureRailPosRef.current ?? getMeasureRailDefaultPos();
    writeMeasureRailLocalPos(rail, p);
  }, [getMeasureRailDefaultPos, writeMeasureRailLocalPos]);
  const resetMeasureRailPos = useCallback((e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    const rail = measureRailRef.current;
    if (!rail || !measureRailPosRef.current || measureRailResettingRef.current) return;

    const stack = rail.querySelector(".canvas-left-stack");
    const fromRect = stack?.getBoundingClientRect() ?? rail.getBoundingClientRect();
    const to = getMeasureRailDefaultPos();
    rail.style.left = `${fromRect.left}px`;
    rail.style.top = `${fromRect.top}px`;
    rail.style.transform = "none";
    rail.classList.add("is-custom-pos", "is-rail-resetting");
    rail.classList.remove("is-rail-dragging");
    measureRailResettingRef.current = true;
    measureRailDraggingRef.current = false;
    setMeasureRailResetting(true);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      rail.removeEventListener("transitionend", onTransitionEnd);
      clearTimeout(fallback);
      rail.classList.remove("is-rail-resetting", "is-rail-dragging");
      measureRailResettingRef.current = false;
      setMeasureRailResetting(false);
      measureRailPosRef.current = null;
      setMeasureRailPos(null);
      try { localStorage.removeItem(MEASURE_RAIL_POS_KEY); } catch { /* private mode */ }
      syncMeasureRailLayout();
    };
    const onTransitionEnd = (ev) => {
      if (ev.target !== rail) return;
      if (ev.propertyName !== "left" && ev.propertyName !== "top") return;
      finish();
    };
    const fallback = setTimeout(finish, 420);
    rail.addEventListener("transitionend", onTransitionEnd);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        rail.style.left = `${to.x}px`;
        rail.style.top = `${to.y}px`;
      });
    });
  }, [getMeasureRailDefaultPos, syncMeasureRailLayout]);
  const finalizeMeasureRailDrag = useCallback((rawPos) => {
    const rail = measureRailRef.current;
    const d = measureRailDragRef.current;
    if (!rail || !d || !rawPos) return;
    const p = clampMeasureRailPos(rawPos.x, rawPos.y);
    d.handle?.classList.remove("is-dragging");
    rail.classList.add("is-rail-commit");
    rail.classList.remove("is-rail-dragging");
    rail.style.removeProperty("--rail-drag-x");
    rail.style.removeProperty("--rail-drag-y");
    writeMeasureRailLocalPos(rail, p);
    requestAnimationFrame(() => rail.classList.remove("is-rail-commit"));
    measureRailDragRef.current = null;
    measureRailDragLiveRef.current = null;
    measureRailDraggingRef.current = false;
    measureRailPosRef.current = p;
    try { localStorage.setItem(MEASURE_RAIL_POS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
    setMeasureRailPos(p);
  }, [clampMeasureRailPos, writeMeasureRailLocalPos]);
  const beginMeasureRailDrag = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rail = measureRailRef.current;
    if (!rail) return;
    if (measureRailDragRafRef.current) {
      cancelAnimationFrame(measureRailDragRafRef.current);
      measureRailDragRafRef.current = 0;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const railRect = rail.getBoundingClientRect();
    const visual = { x: railRect.left, y: railRect.top };
    measureRailDraggingRef.current = true;
    measureRailDragLiveRef.current = { ...visual };
    measureRailDragRef.current = {
      pointerId: e.pointerId,
      offX: e.clientX - visual.x,
      offY: e.clientY - visual.y,
      handle: e.currentTarget,
      origin: { ...visual },
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      armed: false,
    };
    const armDrag = () => {
      const d = measureRailDragRef.current;
      if (!d || d.armed) return;
      d.armed = true;
      rail.style.setProperty("--rail-drag-x", `${d.origin.x}px`);
      rail.style.setProperty("--rail-drag-y", `${d.origin.y}px`);
      rail.classList.add("is-custom-pos", "is-rail-dragging");
      d.handle?.classList.add("is-dragging");
    };
    const applyPos = (nx, ny) => {
      const d = measureRailDragRef.current;
      if (!d) return;
      const c = clampMeasureRailPos(nx, ny);
      measureRailDragLiveRef.current = c;
      rail.style.setProperty("--rail-drag-x", `${c.x}px`);
      rail.style.setProperty("--rail-drag-y", `${c.y}px`);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    const finishDrag = (pointerId) => {
      const d = measureRailDragRef.current;
      if (!d || d.ended || (pointerId != null && pointerId !== d.pointerId)) return;
      d.ended = true;
      cleanup();
      if (!d.moved) {
        d.handle?.classList.remove("is-dragging");
        rail.classList.remove("is-rail-dragging", "is-rail-commit");
        rail.style.removeProperty("--rail-drag-x");
        rail.style.removeProperty("--rail-drag-y");
        measureRailDragRef.current = null;
        measureRailDragLiveRef.current = null;
        measureRailDraggingRef.current = false;
        return;
      }
      finalizeMeasureRailDrag(measureRailDragLiveRef.current);
    };
    const onMove = (ev) => {
      const d = measureRailDragRef.current;
      if (!d || d.ended || ev.pointerId !== d.pointerId) return;
      if (!d.moved) {
        const dx = ev.clientX - d.startClientX;
        const dy = ev.clientY - d.startClientY;
        if (dx * dx + dy * dy < 25) return;
        d.moved = true;
        armDrag();
      }
      applyPos(ev.clientX - d.offX, ev.clientY - d.offY);
    };
    const onUp = (ev) => {
      finishDrag(ev.pointerId);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [clampMeasureRailPos, finalizeMeasureRailDrag]);
  useEffect(() => {
    if (!measureRailPos) return undefined;
    const onResize = () => {
      if (measureRailDraggingRef.current || measureRailResettingRef.current) return;
      setMeasureRailPos((p) => (p ? clampMeasureRailPos(p.x, p.y) : p));
    };
    window.addEventListener("resize", onResize);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onResize);
    vv?.addEventListener("scroll", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      vv?.removeEventListener("resize", onResize);
      vv?.removeEventListener("scroll", onResize);
    };
  }, [measureRailPos, clampMeasureRailPos]);
  useLayoutEffect(() => {
    if (view !== "canvas" || status !== "ready") return;
    syncMeasureRailLayout();
    requestAnimationFrame(() => syncMeasureRailLayout());
  }, [view, status, measureRailPos, syncMeasureRailLayout]);
  useEffect(() => {
    if (view !== "canvas" || status !== "ready") return undefined;
    const onReflow = () => syncMeasureRailLayout();
    window.addEventListener("resize", onReflow);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onReflow);
    vv?.addEventListener("scroll", onReflow);
    return () => {
      window.removeEventListener("resize", onReflow);
      vv?.removeEventListener("resize", onReflow);
      vv?.removeEventListener("scroll", onReflow);
    };
  }, [view, status, syncMeasureRailLayout]);

  const RAIL_ICO = { size: 15, strokeWidth: 1.5 };
  const railBtn = (onClick, icon, label, isOn, extraClass = "") => (
    <button type="button" className={`canvas-circle-btn${isOn ? " is-on" : ""}${extraClass ? ` ${extraClass}` : ""}`} onClick={onClick} data-tip={label} aria-label={label}>
      {icon}
    </button>
  );
  // Measure tools relocated onto the vertical rail — same icons as the old
  // top-toolbar palette, each with its single-key shortcut tucked bottom-right.
  const measureRailBtn = (t) => (
    <button
      key={t.id}
      type="button"
      className={`canvas-circle-btn canvas-rail-tool${tool === t.id ? " is-on" : ""}`}
      onClick={() => setTool(t.id)}
      data-tip={`${t.label} · ${t.shortcut}`}
      aria-label={`${t.label} (${t.shortcut})`}
    >
      <Icon name={t.icon} size={17} />
      <span className="canvas-rail-kbd" aria-hidden="true">{t.shortcut}</span>
    </button>
  );
  // The panel's condition-list VIEW (search / natural sort / grouping / the
  // ⌘/⇧ multi-select) lives in components/TakeoffsPanel.jsx.

  // one activation path — the panel row, the compact strip, the 1–9 hotkeys,
  // +condition, and Library Apply all funnel here so the reassign-in-Select
  // and clear-multi-select semantics can never drift between surfaces. Only
  // surfaces with a VISIBLE reassign affordance (the panel row and the strip
  // button — both show the "reassign selected shape" hint once a shape is
  // selected) actually reassign; { reassign: false } is for keyboard/
  // programmatic activations (hotkeys, +condition, Library Apply) that offer
  // no such affordance — a digit press or an Apply click must never silently
  // move a selected shape's quantities. EVERY activation surface, reassigning
  // or not, dismisses a live bulk selection.
  const activateCondition = (id, { reassign = true } = {}) => {
    if (reassign && tool === "select" && selectedId) reassignSelected(id);
    setActiveCond(id);
    panelSelectionRef.current?.();   // plain activation dismisses a live bulk selection (panel view state)
  };
  // The label analogue (#111): with a shape selected in Select mode this re-labels
  // it (mirroring activateCondition's reassign-on-activate); otherwise it just sets
  // the active label for subsequent traces. value "" / null = No label / clear.
  const activateLabel = (value) => {
    if (tool === "select" && selectedId) reassignSelectedLabel(value);
    setActiveLabel(value);
  };

  const unpinFromPalette = (id) => setPalette((p) => p.filter((x) => x !== id));
  // togglePin: the panel row's pushpin — pin if absent (respecting the cap),
  // unpin if already pinned.
  const togglePin = (id) => setPalette((p) => (p.includes(id) ? p.filter((x) => x !== id) : (p.length >= PALETTE_MAX ? p : [...p, id])));

  // Bulk mutations — the multi-selection is TakeoffsPanel view state; every
  // callback takes the LIVE id set the panel computed (conditions ∩ checked),
  // so counts and names here can never claim rows the list already lost.
  const bulkWasteConditions = (ids, v) => {
    setConditions((cs) => cs.map((c) => (ids.has(c.id) ? { ...c, waste_pct: v } : c)));
    setCommitMsg(`Waste set to ${v}% on ${ids.size} condition${ids.size === 1 ? "" : "s"}.`);
  };
  const bulkColorConditions = (ids, color) => setConditions((cs) => cs.map((c) => (ids.has(c.id) ? { ...c, color } : c)));
  // returns whether the delete went through — the panel clears its selection only then
  const bulkDeleteConditions = (ids) => {
    const live = conditions.filter((c) => ids.has(c.id));
    if (!live.length) return false;
    const dead = shapes.filter((s) => ids.has(s.condition_id));
    const owned = dead.length;
    // name what dies while the list still reads at a glance (≤5); count beyond
    const what = live.length <= 5 ? live.map((c) => c.finish_tag).join(", ") : `${live.length} conditions`;
    setPendingTakeoffsConfirm({
      kind: "bulkDelete",
      payload: { ids: [...ids] },
      title: live.length === 1 ? `Delete ${live[0].finish_tag}?` : `Delete ${live.length} conditions?`,
      body: `Delete ${what}${owned ? ` and their ${owned} takeoff${owned === 1 ? "" : "s"}` : ""}? This can't be undone.`,
      confirmLabel: "Delete",
    });
    return false;
  };
  const performBulkDelete = (idArr) => {
    const ids = new Set(idArr);
    const live = conditions.filter((c) => ids.has(c.id));
    if (!live.length) return;
    const dead = shapes.filter((s) => ids.has(s.condition_id));
    const owned = dead.length;
    setConditions((cs) => cs.filter((c) => !ids.has(c.id)));
    // same cascade rule as deleteCondition: counted centrally, off the stack
    if (owned) dispatchShape({ type: "delete", ids: dead.map((s) => s.id), reason: "condition-delete" }, { record: false });
    setPalette((p) => p.filter((id) => !ids.has(id)));   // deleted conditions can't stay pinned
    if (ids.has(activeCond)) setActiveCond(conditions.find((c) => !ids.has(c.id))?.id || "");
    setCommitMsg(`Deleted ${live.length} condition${live.length === 1 ? "" : "s"}${owned ? ` and ${owned} takeoff${owned === 1 ? "" : "s"}` : ""}.`);
    panelSelectionRef.current?.();
  };

  // ── condition template library ops (browser-global; store meta key) ───────
  const persistTemplates = (next) => {
    templatesRef.current = next; setTemplates(next);
    store.saveTemplates(next).catch((e) => setCommitMsg(`Couldn't save the library: ${e.message || e}`));
  };
  const condToTemplate = (c) => ({
    finish_tag: c.finish_tag, color: c.color, fill: c.fill, hatch: c.hatch || "solid",
    waste_pct: c.waste_pct || 0,
    ...(c.height_ft != null ? { height_ft: c.height_ft } : {}),
    ...(c.thickness_in != null ? { thickness_in: c.thickness_in } : {}),
    ...(c.laborType != null ? { laborType: c.laborType } : {}),
    ...(c.subfloorType != null ? { subfloorType: c.subfloorType } : {}),
    materials: (c.materials || []).map(({ id: _id, ...m }) => (m.grout ? { ...m, grout: { ...m.grout } } : m)),   // ids are minted on instantiation; grout never shared by reference
  });
  const saveActiveAsTemplate = () => {
    if (!aCond) return;
    const tpl = condToTemplate(aCond);
    const at = templates.findIndex((t) => t.finish_tag === tpl.finish_tag);
    if (at >= 0) {
      setPendingTakeoffsConfirm({
        kind: "replaceTemplate",
        payload: { tpl },
        title: `Replace “${tpl.finish_tag}”?`,
        body: `A “${tpl.finish_tag}” template is already in the library — replace it?`,
        confirmLabel: "Replace",
        tone: "ink",
      });
      return;
    }
    persistTemplates([...templates, tpl]);
    setCommitMsg(`Saved ${tpl.finish_tag} to the library.`);
  };
  const applyTemplate = (t) => {
    const c = instantiateTemplate(t);
    setConditions((cs) => [...cs, c]);
    // reassign:false — Library Apply has no visual reassign affordance, but it
    // still dismisses a live bulk selection like every other activation surface
    activateCondition(c.id, { reassign: false });
    // the panel switches itself back to the Takeoffs tab (its Apply handler)
    setCommitMsg(`Added ${c.finish_tag} from the library.`);
  };
  // idx addresses the template BY POSITION (the panel's plain templates.map
  // index — it doesn't filter/sort). The focus-refresh above now skips the
  // setState when the loaded library is unchanged, which closes off the
  // common way idx would go stale mid-session; a same-length edit landing
  // from another tab in the sub-second window between render and click can
  // still retarget these by position — accepted residual risk, not fully
  // closed. Guard the deref so a stale idx (list shrank out from under us)
  // reports rather than throwing.
  const renameTemplate = (idx) => {
    const t = templates[idx];
    if (!t) { setCommitMsg("The library changed in another tab — try again."); return; }
    const tag = (window.prompt("Template tag:", t.finish_tag) || "").trim();
    if (!tag || tag === t.finish_tag) return;
    persistTemplates(templates.map((x, i) => (i === idx ? { ...x, finish_tag: tag } : x)));
  };
  const deleteTemplate = (idx) => {
    const t = templates[idx];
    if (!t) { setCommitMsg("The library changed in another tab — try again."); return; }
    setPendingTakeoffsConfirm({
      kind: "deleteTemplate",
      payload: { idx },
      title: `Remove ${t.finish_tag}?`,
      body: `Remove the ${t.finish_tag} template from the library? Existing conditions are unaffected.`,
      confirmLabel: "Remove",
    });
  };

  // ── material library ops (#47: copy-on-attach with a live link) ───────────
  // Conditions always own fully materialized material lines; lib_id is an
  // ADDITIVE link. Nothing here can affect totals, exports, or old snapshots
  // unless the user explicitly pushes an update.
  // memoized: both derivations feed the memoized TakeoffsPanel as props, so
  // they must hold identity across canvas-only renders (tf mirror, crosshair)
  const matLibById = useMemo(() => Object.fromEntries(matLib.map((m) => [m.id, m])), [matLib]);
  const persistMatLib = (next) => {
    setMatLib(next);
    store.saveMaterialLibrary(next).catch((e) => setCommitMsg(`Couldn't save the material library: ${e.message || e}`));
  };
  // libFields / matFieldOverridden / the push+revert patch builders live in
  // lib/materials.js (pure, tested): they carry kind and the grout tile
  // geometry through every library copy, deep-copying grout at each point.
  const attachLibMaterial = (libId) => {
    const lm = matLibById[libId];
    if (!lm || !aCond) return;
    updateCond({ materials: [...(aCond.materials || []), { id: uid("mat"), ...libFields(lm), lib_id: lm.id }] });
  };
  const promoteMaterial = (m) => {
    if (!m.name) { setCommitMsg("Name the material before saving it to the library."); return; }
    const entry = { id: uid("lib"), ...libFields(m) };
    persistMatLib([...matLib, entry]);
    updateMaterial(m.id, { lib_id: entry.id });
    setCommitMsg(`Saved ${m.name} to the material library.`);
  };
  const revertMatField = (m, f) => {
    const lm = matLibById[m.lib_id];
    if (lm) updateMaterial(m.id, libRevertPatch(m, lm, f));   // grout-derived per/note revert together with the geometry
  };
  const updateLibMaterial = (id, patch) => persistMatLib(matLib.map((x) => (x.id === id ? libEntryPatch(x, patch) : x)));   // hand-editing per/note detaches a grout entry's geometry
  // one pass per conditions change, not per library row — the Materials tab reads this per row
  const linkedCountById = useMemo(() => {
    const by = {};
    for (const c of conditions) for (const m of c.materials || []) if (m.lib_id) by[m.lib_id] = (by[m.lib_id] || 0) + 1;
    return by;
  }, [conditions]);
  const linkedCount = (libId) => linkedCountById[libId] || 0;
  const pushLibUpdate = (libId) => {
    const lm = matLibById[libId];
    if (!lm) return;
    const n = linkedCount(libId);
    if (!n) { setCommitMsg("No condition lines link this material yet."); return; }
    setPendingTakeoffsConfirm({
      kind: "pushLib",
      payload: { libId },
      title: "Update linked lines?",
      body: `Update ${n} linked line${n === 1 ? "" : "s"} across conditions to the library values? Overrides on those lines are replaced.`,
      confirmLabel: "Update",
      tone: "ink",
    });
  };
  const deleteLibMaterial = (libId) => {
    const lm = matLibById[libId];
    const n = linkedCount(libId);
    setPendingTakeoffsConfirm({
      kind: "deleteLibMaterial",
      payload: { libId },
      title: `Remove ${lm?.name || "this material"}?`,
      body: `Remove ${lm?.name || "this material"} from the library?${n ? (n === 1 ? " 1 linked line keeps its values — only the link is removed." : ` ${n} linked lines keep their values — only the links are removed.`) : ""}`,
      confirmLabel: "Remove",
    });
  };
  const addLibMaterial = () => persistMatLib([...matLib, { id: uid("lib"), name: "", unit: "", per: 0, basis: "area", round: true, note: "" }]);

  const cancelTakeoffsConfirm = () => setPendingTakeoffsConfirm(null);
  const confirmTakeoffsAction = () => {
    const p = pendingTakeoffsConfirm;
    setPendingTakeoffsConfirm(null);
    if (!p) return;
    const { kind, payload: pl } = p;
    if (kind === "deleteCondition") {
      performDeleteCondition(pl.id);
      return;
    }
    if (kind === "bulkDelete") {
      performBulkDelete(pl.ids);
      return;
    }
    if (kind === "deleteColumn") {
      performDeleteColumn(pl.colId);
      return;
    }
    if (kind === "replaceTemplate") {
      const { tpl } = pl;
      const at = templates.findIndex((t) => t.finish_tag === tpl.finish_tag);
      persistTemplates(at >= 0 ? templates.map((t, i) => (i === at ? tpl : t)) : [...templates, tpl]);
      setCommitMsg(`Saved ${tpl.finish_tag} to the library.`);
      return;
    }
    if (kind === "deleteTemplate") {
      const t = templates[pl.idx];
      if (!t) { setCommitMsg("The library changed in another tab — try again."); return; }
      persistTemplates(templates.filter((_, i) => i !== pl.idx));
      return;
    }
    if (kind === "pushLib") {
      const lm = matLibById[pl.libId];
      if (!lm) return;
      const n = linkedCount(pl.libId);
      setConditions((cs) => cs.map((c) => ({ ...c, materials: (c.materials || []).map((m) => (m.lib_id === pl.libId ? libPushPatch(m, lm) : m)) })));
      setCommitMsg(`Updated ${n} linked line${n === 1 ? "" : "s"} from the library.`);
      return;
    }
    if (kind === "deleteLibMaterial") {
      const libId = pl.libId;
      const n = linkedCount(libId);
      persistMatLib(matLib.filter((x) => x.id !== libId));
      if (n) setConditions((cs) => cs.map((c) => ({ ...c, materials: (c.materials || []).map((m) => { if (m.lib_id !== libId) return m; const { lib_id: _l, ...rest } = m; return rest; }) })));
      // condition templates carry lib_id too (so applying re-links to a live
      // entry) — detach them here as well, or a deleted entry would leave
      // dangling links inside saved templates
      if (templates.some((t) => (t.materials || []).some((m) => m.lib_id === libId))) {
        persistTemplates(templates.map((t) => ({ ...t, materials: (t.materials || []).map((m) => { if (m.lib_id !== libId) return m; const { lib_id: _l, ...rest } = m; return rest; }) })));
      }
    }
  };

  // ── TakeoffsPanel wiring ───────────────────────────────────────────────────
  // The docked panel is memoized (React.memo) so canvas-only renders — the
  // ~11Hz tf mirror during pan/zoom, crosshair/status churn — skip its whole
  // subtree. That only works if its props hold identity, and the handlers
  // above close over fresh state every render; so the panel gets STABLE
  // forwarders (minted once) that read the current handler through this ref
  // at call time. Add a handler here and it's automatically stable.
  const panelHandlersRef = useRef(null);
  panelHandlersRef.current = {
    onActivate: activateCondition, onLocate: locateCondition,
    onAddCondition: addCondition, onDeleteCondition: deleteCondition,
    onUpdateCond: updateCond, onSetCondParam: setCondParam, onAssignAttr: assignAttr,
    onAddMaterial: addMaterial, onUpdateMaterial: updateMaterial, onRemoveMaterial: removeMaterial,
    onBulkWaste: bulkWasteConditions, onBulkColor: bulkColorConditions, onBulkDelete: bulkDeleteConditions,
    onSaveTemplate: saveActiveAsTemplate, onApplyTemplate: applyTemplate,
    onRenameTemplate: renameTemplate, onDeleteTemplate: deleteTemplate,
    onAddColumn: addColumn, onRenameColumn: renameColumn, onDeleteColumn: deleteColumn,
    onAddColumnValue: addColumnValue, onRemoveColumnValue: removeColumnValue, onRenameColumnValue: renameColumnVal,
    onAddLabel: addLabel, onRenameLabel: renameLabel, onRemoveLabel: removeLabel,
    onAttachLibMaterial: attachLibMaterial, onPromoteMaterial: promoteMaterial, onRevertMatField: revertMatField,
    onUpdateLibMaterial: updateLibMaterial, onPushLibUpdate: pushLibUpdate,
    onDeleteLibMaterial: deleteLibMaterial, onAddLibMaterial: addLibMaterial,
    matFieldOverridden,   // pure helper, not an event handler — the forwarder returns its result
    onToggleCollapse: toggleTakeoffs, onTogglePin: togglePin,
    // these three are ALREADY stable on their own (setState identity, and
    // holdPanelGesture is a useCallback with an empty dep array) — routed
    // through the registry anyway so the memo contract has exactly ONE
    // convention to audit, not "stable via the registry, except these three"
    onPanelPrefs: setPanelPrefs, onSetActive: setActiveCond, onHoldGesture: holdPanelGesture,
  };
  const [panelHandlers] = useState(() => {
    const stable = {};
    for (const k of Object.keys(panelHandlersRef.current)) stable[k] = (...a) => panelHandlersRef.current[k](...a);
    return stable;
  });

  // deck-1 sheet-nav chip — ONE home for "which sheet am I on": pages, files,
  // group/ungroup and the gallery all live in its dropdown. Ungroup/Regroup
  // are sheet-set operations, so they move in here instead of appearing
  // mid-row and shifting everything after them.
  // assigned floor/level rides the sheet chip + page entries (sheet key: page 1 is the bare file name)
  const levelOfPage = (n) => sheetLevels[n > 1 ? `${active}#${n}` : active] || "";
  const sheetMenuItems = [];
  if (!sheetGroup.length && pageCount > 1) {
    sheetMenuItems.push({ section: "Sheets in this set" });
    for (let n = 1; n <= pageCount; n++) sheetMenuItems.push({ id: `pg-${n}`, label: `${levelOfPage(n) ? `${levelOfPage(n)} · ` : ""}${pageLabels[n] || `Sheet ${n}`}`, shortcut: `${n}/${pageCount}`, active: n === page, onSelect: () => setPage(n) });
  }
  if (!sheetGroup.length && sheets.length > 1) {
    sheetMenuItems.push({ section: "Files" });
    for (const s of sheets) sheetMenuItems.push({ id: `f-${s.name}`, label: s.name, active: s.name === active, onSelect: () => { setActive(s.name); setPage(1); } });
  }
  if (sheetMenuItems.length && (sheetGroup.length || lastGroup.length >= 2)) sheetMenuItems.push("divider");
  if (sheetGroup.length) sheetMenuItems.push({ id: "ungroup", label: "Ungroup — back to one sheet", title: "Back to one sheet — you land on the sheet you were last working; every sheet keeps its takeoffs and markups", onSelect: ungroup });
  if (!sheetGroup.length && lastGroup.length >= 2) sheetMenuItems.push({ id: "regroup", label: `Regroup (${lastGroup.length})`, title: `Side-by-side again with the same ${lastGroup.length} sheets — each keeps its own scale, takeoffs and markups`, onSelect: regroup });
  if (sheetMenuItems.length) sheetMenuItems.push("divider");
  sheetMenuItems.push({ id: "gallery", icon: "sheets", label: "Open gallery…", shortcut: "G", onSelect: openGallery });

  // deck-2 scale chip — the four scale controls collapsed to one status face:
  // red dashed = unset ("you can't trace yet"), green = set, warning = the
  // plan notes a different scale than the one you picked
  const scaleDet = detectedScales[focusPanel.key];
  const autoscaleOn = scaleSources[focusPanel.key] === "autoscale";
  const scaleMismatch = !!(unitsPerPx && stdValue && scaleDet && !autoscaleOn && Math.abs(scaleDet.upp - unitsPerPx) > 1e-9);
  const scaleFace = !unitsPerPx ? "Autoscale" : autoscaleOn ? "✓ Autoscale" : `${scaleMismatch ? "≠" : "✓"} ${stdValue || "custom"}`;
  const scaleFaceStyle = !unitsPerPx
    ? { border: "1px solid var(--c-positive)", color: "var(--c-positive)" }
    : scaleMismatch
      ? { border: "1px solid var(--c-warning)", color: "var(--c-warning)" }
      : { border: "1px solid var(--c-positive)", color: "var(--c-positive)" };
  const scaleTitle = scaleMismatch
    ? `You set ${stdValue}, but the plan notes ${scaleDet.label} on ${labelFor(focusPanel)} — double-check before tracing.`
    : `Set the scale for ${labelFor(focusPanel)} — remembered per sheet${groupKeys.length > 1 ? " (targets the sheet you last clicked)" : ""}`;
  const scaleItems = [];
  // one-step revert after a rescale that changed committed quantities on this
  // sheet — the oops-hatch for a mistyped recalibrate (ephemeral, one slot)
  scaleItems.push({ id: "calibrate", icon: "measure", label: "Set custom scale", title: "Calibrate — click two points of a known dimension", active: tool === "calibrate", onSelect: () => setTool("calibrate") });
  scaleItems.push({ id: "check", icon: "target", label: "Check a dimension…", shortcut: "K", title: "Check a dimension (K) — click both ends of a printed dimension string; compares the measured length against what the drawing says", active: tool === "check", onSelect: () => setTool("check") });
  scaleItems.push("divider");
  scaleItems.push({
    id: "autoscale",
    icon: "target",
    tint: "var(--cobalt)",
    label: "Autoscale",
    active: autoscaleOn || !unitsPerPx,
    title: "Detect the scale from the plan title block and apply it automatically. You can change it anytime from Standard or Calibrate.",
    onSelect: () => { void applyAutoscale(focusPanel.key, { force: true }); },
  });
  scaleItems.push("divider");
  if (prevScale && prevScale.key === focusPanel.key && scales[focusPanel.key] !== prevScale.upp) {
    const wasLabel = STANDARD_SCALES.find((x) => Math.abs(x.upp - prevScale.upp) < 1e-9)?.label
      || (prevScale.source === "calibrated" ? "calibrated" : "custom");
    scaleItems.push({
      id: "revert-scale", icon: "undo",
      label: `Revert scale (was ${wasLabel})`,
      title: `Put ${labelFor(focusPanel)} back on the scale the last rescale replaced and re-price its takeoffs. One step, kept only until the sheet view changes — reverting is itself revertible.`,
      onSelect: revertScale,
    });
    scaleItems.push("divider");
  }
  if (scaleDet) {
    scaleItems.push({ section: "From the plan" });
    scaleItems.push({
      id: "use-detected", icon: "target", tint: "var(--c-positive)",
      label: `Plan says ${scaleDet.label}${scaleDet.multi ? " ±" : ""} — use it`,
      title: `The plan notes ${scaleDet.label} on ${labelFor(focusPanel)}${scaleDet.multi ? " — this sheet shows several scales (details are often larger); confirm against a known dimension" : ""}. Hover previews a calibrated guide bar on the sheet so you can sanity-check it.`,
      onSelect: () => { rescaleSheet(focusPanel.key, scaleDet.upp); setScaleSources((s) => ({ ...s, [focusPanel.key]: "detected" })); showScaleGuide(focusPanel.key, scaleDet.upp, scaleDet.label); },
      // hover previews the guide bar behind the open menu — only while the
      // sheet is still UNSCALED (upstream's gate: on a scaled sheet the bar
      // would advertise a scale the sheet is not using, on the very affordance
      // whose job is sanity-checking bar length). The preview dies on hover-out
      // AND on menu close however it happens (onScaleMenuDepth below) — an
      // ACCEPTED bar (onSelect) is not a preview and rides out its 8 s.
      onHover: (on) => { if (on) { if (!scales[focusPanel.key]) showScaleGuide(focusPanel.key, scaleDet.upp, scaleDet.label, true); } else clearPreviewGuide(); },
    });
  }
  scaleItems.push({ section: "Standard" });
  for (const s of STANDARD_SCALES) scaleItems.push({ id: s.label, label: s.label, active: !autoscaleOn && stdValue === s.label, onSelect: () => { rescaleSheet(focusPanel.key, s.upp); setScaleSources((sc) => ({ ...sc, [focusPanel.key]: "standard" })); showScaleGuide(focusPanel.key, s.upp, s.label); } });
  scaleItems.push({ note: "Remembered per sheet." });

  // One-Click fill sensitivity — lives in the render menu now, so arming
  // One-Click never reshapes the toolbar. Detents at Strict / Balanced /
  // Aggressive; the slider still tunes 0–100% freely, snapping to a notch when
  // released near one. Detents come from oneclick's canonical presets so UI
  // and flood math can't drift if a preset is ever retuned.
  const fillRow = (() => {
    const NOTCHES = [SENS_STRICT, SENS_BALANCED, SENS_AGGRESSIVE];
    const label = fillSens === SENS_STRICT ? "Strict" : fillSens === SENS_BALANCED ? "Balanced" : fillSens === SENS_AGGRESSIVE ? "Aggressive" : `${Math.round(fillSens * 100)}%`;
    const snap = (v) => { for (const n of NOTCHES) if (Math.abs(v - n) <= 0.06) return n; return v; };
    return (
      <div title={"One-Click fill sensitivity — how far a fill reaches past a room's hatch pattern.\nStrict: stop at the linework (original behavior).\nBalanced: recover hatch-lined rooms to the walls (default).\nAggressive: cross more pattern and tolerate more growth.\nLower it if fills spill; raise it if hatched rooms come up short.\nScanned sheets trace from pixels — sensitivity doesn't apply there."}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-soft)" }}>Fill</span>
        <input name="fill-sensitivity" type="range" min={SENS_STRICT} max={SENS_AGGRESSIVE} step={0.01} value={fillSens} list="fill-sens-notches"
          onChange={(e) => setFillSens(snap(parseFloat(e.target.value)))}
          style={{ flex: 1, accentColor: "var(--cobalt)", cursor: "pointer" }} />
        <datalist id="fill-sens-notches"><option value={SENS_STRICT} /><option value={SENS_BALANCED} /><option value={SENS_AGGRESSIVE} /></datalist>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, fontWeight: 600, color: "var(--cobalt)", minWidth: 58 }}>{label}</span>
      </div>
    );
  })();
  const wallSensRow = (() => {
    const NOTCHES = [SENS_STRICT, SENS_BALANCED, SENS_AGGRESSIVE];
    const label = wallSens === SENS_STRICT ? "Strict" : wallSens === SENS_BALANCED ? "Balanced" : wallSens === SENS_AGGRESSIVE ? "Aggressive" : `${Math.round(wallSens * 100)}%`;
    const snap = (v) => { for (const n of NOTCHES) if (Math.abs(v - n) <= 0.06) return n; return v; };
    return (
      <div title={"Wall Trace sensitivity — pen-weight gate, grid-span filter, and door-neck break at openings.\nStrict: heavy linework only (dimensions/grid ignored).\nBalanced: default.\nAggressive: include hairlines; looser leak cap.\nLower if a click grabs too much linework; raise if hatch-filled walls come up short."}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-soft)" }}>Wall</span>
        <input name="wall-sensitivity" type="range" min={SENS_STRICT} max={SENS_AGGRESSIVE} step={0.01} value={wallSens} list="wall-sens-notches"
          onChange={(e) => { setWallSens(snap(parseFloat(e.target.value))); wallMaskCacheRef.current.clear(); }}
          style={{ flex: 1, accentColor: "var(--cobalt)", cursor: "pointer" }} />
        <datalist id="wall-sens-notches"><option value={SENS_STRICT} /><option value={SENS_BALANCED} /><option value={SENS_AGGRESSIVE} /></datalist>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, fontWeight: 600, color: "var(--cobalt)", minWidth: 58 }}>{label}</span>
      </div>
    );
  })();

  const renderLiveLayersPanel = (opts = {}) => (
    <LayersIllustratorPanel
      embedded={!!opts.embedded}
      closeOnOutside={!opts.embedded}
      onClose={opts.onClose}
      shapes={layerPanelShapes}
      condById={condById}
      hiddenShapeIds={hiddenShapeIds}
      lockedShapeIds={lockedShapeIds}
      layerForest={layerForest}
      sheetKeys={groupKeys}
      sheetLabel={tabLabel}
      focusSheetKey={focusKey}
      selectedIds={selectedLayerIds}
      units={units}
      sheetMatch={aiFloorSheetKeysMatch}
      roomForShape={(s) => detectRoomName(s, boqDetectCtx, shapes) || s.room_detected || s.room || ""}
      onSelectIds={selectLayerIds}
      onToggleHideIds={toggleHideIds}
      onToggleLockIds={toggleLockIds}
      onGroup={groupLayerSelection}
      onUngroup={ungroupLayerSelection}
      onDeleteIds={deleteLayerIds}
      onDuplicateIds={duplicateLayerIds}
      onRename={renameLayer}
      onMove={moveLayerTree}
      onNewGroup={newLayerGroup}
    />
  );
  const canvasReady = view === "canvas" && status === "ready";
  const sheetTools = status !== "loading" && status !== "rendering";
  const workspaceBarShown = canvasReady && toolbarChrome.workspaceVisible;
  useEffect(() => {
    if (!canvasReady) return undefined;
    try {
      window.parent?.postMessage({
        source: "opentakeoff",
        type: "adicc:canvas-ready-state",
        ready: true,
      }, "*");
    } catch { /* cross-origin embed */ }
    return undefined;
  }, [canvasReady]);
  const workspaceBg = darkMode ? "#0b0e14" : "var(--surface-pop)";

  return (
    // .app-shell: the print stylesheet collapses this 100vh flex column while the report is open
    <div
      className={`app-shell${darkMode ? " is-sheet-invert" : ""}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer?.files); }}
      style={{ position: "relative", display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* toolbar — two fixed decks (issue #61). Deck 1 = things you do to the
          PROJECT (open, navigate, export, account); deck 2 = things you do to
          the SHEET (arm tools, toggle aids, set scale). Neither row wraps, and
          conditional UI renders only into deck 2's reserved ACTION slot, so no
          control ever changes position. */}
      {/* Unified Floating Toolbar — waits for the sheet like Measure Rail / Takeoffs */}
      <div
        ref={workspaceBarRef}
        className={`toolbar-glass-bar workspace-chrome${workspaceBarShown ? " is-visible" : " is-hidden"}${darkMode ? " is-sheet-invert" : ""}`}
        style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: workspaceBarShown ? "12px 12px 4px" : 0, width: "100%", userSelect: "none", ...(darkMode ? { background: workspaceBg } : {}) }}
      >
        <input name="sheet-file" ref={fileInputRef} type="file" accept=".pdf,application/pdf,image/*,.zip,application/zip,application/x-zip-compressed,.dwg,application/acad,image/vnd.dwg" multiple style={{ display: "none" }} onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
        <input name="sheet-folder" ref={folderInputRef} type="file" multiple webkitdirectory="" directory="" style={{ display: "none" }} onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />

        {workspaceBarShown && sheetTools && (
        <div className="toolbar-glass-pills-row" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", width: "100%" }}>
          {/* Tools — icon row + Auto-Takeoff / Takeoff Tool Palette */}
          <div className="toolbar-glass-pill" style={{ display: "flex", alignItems: "center", overflow: "visible", borderRadius: 14, padding: "4px 10px", gap: 8, whiteSpace: "nowrap" }}>
            
            {/* Project Switcher */}
            {isSupabaseConfigured() && (
              <>
                <ProjectSwitcherDropdown
                  currentProjectName={projectName}
                  onProjectNameChange={setProjectName}
                />
                <div className="toolbar-glass-divider" style={{ width: 1, alignSelf: "stretch", margin: "4px 0" }} />
              </>
            )}

            {/* Mode */}
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <button type="button" onClick={() => setTool("select")} data-tip="Select · V" aria-label="Select · V"
                className={`mode-circle-btn${tool === "select" ? " is-on" : ""}`}>
                <Icon name="select" size={15} />
              </button>
              <button type="button" onClick={() => setTool("pan")} data-tip="Pan · P — or hold right-click / Space" aria-label="Pan · P — or hold right-click / Space mid-measure"
                className={`mode-circle-btn${tool === "pan" ? " is-on" : ""}`}>
                <Icon name="pan" size={15} />
              </button>
            </div>

            <div className="toolbar-glass-divider" style={{ width: 1, alignSelf: "stretch", margin: "4px 0" }} />

            {/* Draw */}
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <ToolMenu variant="palette" tiles circleTrigger title="Cut Out — subtract voids/columns" active={CUT_TOOLS.some((t) => t.id === tool)} accent="danger" onOpenChange={onMenuDepth} face={<Icon name="cutOut" size={15} />} items={CUT_TOOLS.map((t) => ({ id: t.id, icon: t.icon, label: t.label, short: t.short, title: `${t.label} — ${t.shortcut}`, shortcut: t.shortcut, active: tool === t.id, onSelect: () => setTool(t.id) }))} />
                <span style={{ position: "relative", display: "inline-flex" }}>
                  <ToolMenu variant="palette" tiles circleTrigger title="Markup — annotations, not measurements" active={MARKUP_IDS.includes(tool)} onOpenChange={onMenuDepth} face={<Icon name="markup" size={15} />} items={MARKUP_TOOLS.map((t) => ({ id: t.id, icon: t.icon, label: t.label, short: t.short, title: t.shortcut ? `${t.label} — ${t.shortcut}` : t.label, shortcut: t.shortcut, active: tool === t.id, onSelect: () => { setTool(t.id); setMarkupDraft(null); } }))} />
                  {tool === "highlighter" && showHlPopover && (
                    <div
                      className="toolbar-glass-popover"
                      style={{
                        position: "absolute",
                        top: "calc(100% + 6px)",
                        left: 0,
                        zIndex: 30,
                        borderRadius: "var(--radius-sm, 6px)",
                        padding: "8px 10px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 7,
                        boxShadow: "var(--shadow-2)",
                        background: "var(--paper-bright)",
                        border: "1px solid var(--ink)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)" }}>Highlighter</span>
                        <button
                          type="button"
                          onClick={() => setShowHlPopover(false)}
                          title="Close settings"
                          style={{
                            border: "none",
                            background: "transparent",
                            color: "var(--ink)",
                            fontSize: 16,
                            cursor: "pointer",
                            padding: "0 2px",
                            lineHeight: 1,
                            fontWeight: 700,
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: 6 }} data-tip="Ink">
                        {HL_INKS.map((c) => (
                          <button key={c} onClick={() => setHlStyle((st) => ({ ...st, color: c }))} style={{ width: 16, height: 16, padding: 0, background: c, border: hlStyle.color === c ? "2px solid var(--ink)" : "1px solid var(--ink-faint)", cursor: "pointer", borderRadius: 3 }} />
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {HL_SIZES.map(([lbl, px]) => (
                          <button key={lbl} onClick={() => setHlStyle((st) => ({ ...st, size: px }))} data-tip={`${lbl === "F" ? "Fine" : lbl === "M" ? "Medium" : "Broad"} tip`} aria-label={`${lbl === "F" ? "Fine" : lbl === "M" ? "Medium" : "Broad"} tip`} style={{ width: 22, height: 20, padding: 0, fontFamily: "var(--f-mono)", fontSize: 10, cursor: "pointer", border: hlStyle.size === px ? "1px solid var(--ink)" : "1px solid var(--ink-faint)", background: hlStyle.size === px ? "var(--ink)" : "transparent", color: hlStyle.size === px ? "var(--paper-bright)" : "var(--ink)", borderRadius: 3 }}>{lbl}</button>
                        ))}
                        <span style={{ width: 1, alignSelf: "stretch", background: "var(--ink-faint)" }} />
                        {[["chisel", "M4 16 L14 6 L18 10 L8 20 Z"], ["round", "M5 17 Q12 3 19 13"]].map(([tip, d]) => (
                          <button key={tip} onClick={() => setHlStyle((st) => ({ ...st, tip }))} data-tip={`${tip} tip`} aria-label={`${tip} tip`} style={{ width: 24, height: 20, padding: 1, cursor: "pointer", border: hlStyle.tip === tip ? "1px solid var(--ink)" : "1px solid var(--ink-faint)", background: "transparent", borderRadius: 3 }}>
                            <svg viewBox="0 0 24 24" width="18" height="14">{tip === "chisel" ? <path d={d} fill="currentColor" stroke="none" /> : <path d={d} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />}</svg>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </span>
                <ToolMenu
                  variant="palette"
                  tiles
                  circleTrigger
                  title="Edit takeoffs"
                  onOpenChange={onMenuDepth}
                  face={<Icon name="edit" size={15} />}
                  items={[
                    { id: "copy", icon: "copy", label: "Copy", short: "Copy", shortcut: "⌘C", title: "Copy — ⌘C", disabled: !selectedId, onSelect: copySelected },
                    { id: "paste", icon: "paste", label: "Paste", short: "Paste", shortcut: "⌘V", title: "Paste — ⌘V", disabled: !clipRef.current.length, onSelect: () => pasteClipboard() },
                    { id: "dup", icon: "duplicate", label: "Duplicate", short: "Dup", shortcut: "⌘D", title: "Duplicate — ⌘D", disabled: !selectedId, onSelect: duplicateSelected },
                    "divider",
                    { id: "flipH", icon: "flipH", label: "Flip Horizontal", short: "Flip H", title: "Flip Horizontal", disabled: !selectedId, onSelect: () => flipSelected("h") },
                    { id: "flipV", icon: "flipV", label: "Flip Vertical", short: "Flip V", title: "Flip Vertical", disabled: !selectedId, onSelect: () => flipSelected("v") },
                    "divider",
                    { id: "finish", icon: "check", label: `Finish shape${poly.length ? ` (${poly.length} pts)` : ""}`, short: "Finish", shortcut: "↵", title: poly.length ? `Finish shape (${poly.length} pts) — ↵` : "Finish shape — ↵", disabled: !finishOk, onSelect: finishShape },
                    { id: "undopt", icon: "undo", label: "Undo last point", short: "Point", shortcut: "⌘Z", title: "Undo last point — ⌘Z", disabled: !poly.length, onSelect: () => setPoly((q) => q.slice(0, -1)) },
                    { id: "undoshape", icon: "undo", label: "Undo last shape", short: "Shape", title: "Undo last shape", disabled: !visibleShapes.length, onSelect: undoLast },
                    { id: "redo", icon: "redo", label: "Redo", short: "Redo", shortcut: "⇧⌘Z", title: "Redo — ⇧⌘Z", onSelect: redoShapeCommand },
                    "divider",
                    { id: "del", icon: "trash", label: "Delete selected", short: "Delete", shortcut: "⌫", title: "Delete selected — ⌫", disabled: !selectedId, tint: "var(--c-danger)", onSelect: deleteSelected },
                  ]}
                />
            </div>

            <div className="toolbar-glass-divider" style={{ width: 1, alignSelf: "stretch", margin: "4px 0" }} />

            {/* Aids */}
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <span className="angle-dial-wrap">
                  <button
                    type="button"
                    className={`angle-dial-btn${angleOn ? " is-on" : ""}`}
                    onClick={() => setAngleOn((v) => !v)}
                    data-tip="Angle guides · ⇧"
                    aria-label="Angle guides · Shift (45°/90°)"
                  >
                    45°
                  </button>
                  <svg className="angle-dial-arc" width="14" height="28" viewBox="0 0 14 28" aria-hidden="true">
                    <path d="M 2 26 A 12 12 0 0 1 2 2" fill="none" stroke="var(--ink-faint)" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </span>
                <button type="button" onClick={() => setSnapOn((v) => !v)} data-tip="Snap to plan lines" aria-label="Snap to plan lines/corners (beta)"
                  className={`angle-dial-btn is-snap${snapOn ? " is-on" : ""}`}>
                  <Icon name="snap" size={14} />
                </button>
                <ToolMenu circleTrigger paletteAnchor title="Render & fill settings" onOpenChange={onMenuDepth} face={<Icon name="sliders" size={14} />} menuStyle={{ minWidth: 396 }} items={[{ id: "hires", icon: "hiRes", label: "Hi-Res render", checked: hiResOn(focusPanel.key), stayOpen: true, onSelect: toggleHiRes }, "divider", { id: "fill", custom: fillRow }, { id: "wall", custom: wallSensRow }]} />
                <TakeoffFeatureGuide />
            </div>

            <div className="toolbar-glass-divider" style={{ width: 1, alignSelf: "stretch", margin: "4px 0" }} />

            {/* Condition & Label */}
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {aCond ? (
                  <button type="button" onClick={() => setShowCondEdit(true)} data-tip={`Edit appearance for ${aCond.finish_tag}`} aria-label={`Edit appearance for ${aCond.finish_tag}`} className={`toolbar-glass-btn-cond${showCondEdit ? " is-on" : ""}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "0 12px", border: "1px solid var(--ink-faint)", borderRadius: 16, color: "var(--ink)", cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "var(--f-mono)", lineHeight: 1 }}>
                    <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, marginTop: 1 }}><HatchSwatch type={aCond.hatch || "solid"} line={aCond.color} fill={aCond.fill} /></span>
                    Edit {aCond.finish_tag}
                  </button>
                ) : (
                  <div className="toolbar-glass-btn-empty" style={{ padding: "0 12px", borderRadius: 16, border: "1px dashed var(--ink-faint)", color: "var(--ink-muted)", fontSize: 11, fontWeight: 600 }}>No condition</div>
                )}
                {shapeLabels.length > 0 && (
                  <span data-tip="Phase/area label" style={{ display: "inline-flex", alignItems: "center" }}>
                  <select value={tool === "select" && selectedId ? shapeLabelValue(shapes.find((s) => s.id === selectedId)) : (activeLabel || "")} onChange={(e) => activateLabel(e.target.value || null)} aria-label="Phase/area label" className={`toolbar-glass-select${activeLabel ? " is-active" : ""}`} style={{ fontFamily: "var(--f-mono)", fontSize: 11, padding: "0 6px", borderRadius: 16, border: `1px solid ${activeLabel ? "var(--cobalt)" : "var(--ink-faint)"}`, color: activeLabel ? "var(--paper-bright)" : "var(--ink)", cursor: "pointer", maxWidth: 100 }}>
                    <option value="">No label</option>
                    {shapeLabels.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                  </span>
                )}
            </div>

            <div className="toolbar-glass-divider" style={{ width: 1, alignSelf: "stretch", margin: "4px 0" }} />

            {/* Scale */}
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button type="button" onClick={() => setUnits((u) => (u === "metric" ? "imperial" : "metric"))} data-tip={units === "metric" ? "Switch to imperial (ft)" : "Switch to metric (m)"} aria-label="Toggle metric/imperial"
                  className={`angle-dial-btn${units === "metric" ? " is-on" : ""}`}
                  style={{ fontFamily: "var(--f-mono)", fontSize: 10.5 }}>
                  {units === "metric" ? "m" : "ft"}
                </button>
                <ToolMenu title={scaleTitle} onOpenChange={onScaleMenuDepth} faceStyle={{ borderRadius: 16, fontFamily: "var(--f-mono)", fontSize: 11, fontWeight: 600, ...scaleFaceStyle }} face={scaleFace} menuStyle={{ minWidth: 250 }} items={scaleItems} />
            </div>

            <div className="toolbar-glass-divider" style={{ width: 1, alignSelf: "stretch", margin: "4px 0" }} />

            <div className="takeoff-sticky-stack">
              <button type="button" onClick={runAiDetection}
                className="toolbar-glass-btn-ghost-positive"
                data-tip="Auto-Takeoff — detect floor finishes"
                aria-label="Auto-Takeoff"
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "0 10px", border: "1px solid var(--c-positive)", borderRadius: 999, color: "var(--c-positive)", cursor: "pointer", fontWeight: 600, fontSize: 11, lineHeight: 1, whiteSpace: "nowrap", flex: "0 0 auto" }}>
                <Icon name="sparkle" size={11} />
                Auto-Takeoff
              </button>
              <span ref={paletteRef} className="takeoff-sticky-menu takeoff-sticky-menu--stack">
                <button
                  type="button"
                  className={`takeoff-sticky-trigger takeoff-sticky-trigger--compact${paletteOpen ? " is-open" : ""}`}
                  data-tip="Takeoff Tool Palette"
                  aria-label="Takeoff Tool Palette"
                  onClick={() => setPaletteOpen((v) => !v)}
                  aria-expanded={paletteOpen}
                >
                  <Icon name="takeoffs" size={11} />
                  <span>Takeoff Tool Palette</span>
                </button>
                {paletteOpen && (
                  <div className="takeoff-sticky-panel-shell">
                    <div className="takeoff-sticky-panel" role="menu">
                      <div className="takeoff-sticky-panel-inner">
                      <button
                        type="button"
                        role="menuitem"
                        className={`takeoff-sticky-opt${leftTab === "summary" || showSummary ? " is-active" : ""}`}
                        onClick={() => {
                          lastLeftTabRef.current = "summary";
                          setLeftTab("summary");
                          setPaletteOpen(false);
                        }}
                      >
                        <Icon name="sheets" size={15} /> Summary
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={`takeoff-sticky-opt${showBoq ? " is-active" : ""}`}
                        disabled={!shapes.length && !conditions.length}
                        onClick={() => { setShowBoq((v) => !v); setPaletteOpen(false); }}
                      >
                        <Icon name="sheets" size={15} /> BOQ
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={`takeoff-sticky-opt${showEstimate ? " is-active" : ""}`}
                        disabled={!conditions.length}
                        onClick={() => { setShowEstimate((v) => !v); setPaletteOpen(false); }}
                      >
                        <Icon name="spec" size={15} /> Estimate
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={`takeoff-sticky-opt${showRates ? " is-active" : ""}`}
                        onClick={() => { setShowRates((v) => !v); setPaletteOpen(false); }}
                      >
                        <Icon name="takeoffs" size={15} /> Rates
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={`takeoff-sticky-opt${showFinishesSchedule ? " is-active" : ""}`}
                        onClick={() => { setShowFinishesSchedule((v) => !v); setPaletteOpen(false); }}
                      >
                        <Icon name="spec" size={15} /> Finishes
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="takeoff-sticky-opt is-report"
                        disabled={!conditions.length}
                        onClick={() => { setShowReport(true); setPaletteOpen(false); }}
                      >
                        <Icon name="document" size={15} /> Report
                      </button>
                    </div>
                    </div>
                  </div>
                )}
              </span>
            </div>
            
          </div>
        </div>
        )}
      </div>
      {showCondEdit && aCond && (
        <FloatingWindow
          defaultRect={{
            x: 24,
            y: 120,
            w: Math.min(560, (typeof window !== "undefined" ? window.innerWidth : 1280) - 48),
            h: Math.min(selWallSegmentRows.length > 1 ? 320 : 210, (typeof window !== "undefined" ? window.innerHeight : 800) - 140),
          }}
          minW={420}
          minH={170}
        >
          <div className="cond-edit-float" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--paper-bright)", overflow: "hidden", minHeight: 0 }}>
            <header className="cond-edit-float-header" data-float-drag>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cond-edit-float-kicker">Condition</div>
                <div className="cond-edit-float-title">{aCond.finish_tag}</div>
              </div>
              <button type="button" className="cond-edit-float-close" onClick={() => setShowCondEdit(false)} aria-label="Close">×</button>
            </header>
            <div className="cond-edit-float-body">
              <ConditionAppearanceEditor
                cond={floatEditCond && aCond ? { ...floatEditCond, height_ft: aCond.height_ft, thickness_in: aCond.thickness_in } : (floatEditCond || aCond)}
                onUpdateCond={applyFloatCondEdit}
                onSetCondParam={syncFloatCondParam}
                onAssignAttr={applyFloatAssignAttr}
                conditionColumns={conditionColumns}
                layout="row"
              />
              {selShape?.measure_role === "surface_area" && selWallSegmentRows.length > 1 && (
                <WallSegmentHeightsEditor
                  rows={selWallSegmentRows}
                  units={units}
                  condH={condH}
                  activeIndex={wallSegmentFocus}
                  onSetHeight={(idx, raw) => selectedId && setSegmentHeight(selectedId, idx, raw)}
                  onFlyToSegment={(idx) => selectedId && flyToWallSegment(selectedId, idx)}
                  onClearAll={() => selectedId && clearShapeHeight()}
                />
              )}
            </div>
          </div>
        </FloatingWindow>
      )}

      {/* compact conditions strip — OPTIONAL small-project mode. The docked
          Takeoffs panel is the primary conditions surface; the strip renders
          the same state (activate/reassign, hotkey badges, + condition) for
          users who want max panel-collapse and one-click switching. Toggled
          from the panel header, persisted with the panel prefs. */}
      {panelPrefs.strip && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 14px", flexWrap: "wrap", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)" }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--ink-muted)" }}>Conditions</span>
          {conditions.map((c, i) => {
            const on = c.id === activeCond;
            // the 1–9 badge follows the same rule as the hotkeys: palette order
            // when curated, condition order (fallback) when nothing is pinned
            const pinnedPal = palette.length > 0;
            const hIdx = pinnedPal ? palette.indexOf(c.id) : i;
            const hot = hIdx >= 0 && hIdx < 9;
            return (
              <button key={c.id} draggable onDragStart={(e) => { e.dataTransfer.setData(CONDITION_DND_MIME, c.id); e.dataTransfer.effectAllowed = "copy"; }} onClick={() => activateCondition(c.id)} data-tip={tool === "select" && selectedId ? "Reassign selected shape to this condition" : (hot ? `Press ${hIdx + 1} · drag to the palette to pin` : "Drag to the palette to pin")} aria-label={c.finish_tag} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px 3px 4px", borderRadius: 0, border: on ? `2px solid ${c.color}` : (tool === "select" && selectedId ? "1px dashed var(--cobalt)" : "1px solid var(--ink-faint)"), background: on ? "var(--surface-pop)" : "transparent", cursor: "pointer", fontWeight: on ? 700 : 500, fontSize: 12.5 }}>
                {hot && <span style={{ fontSize: 9, fontFamily: "var(--f-mono,monospace)", color: pinnedPal ? "var(--cobalt)" : "var(--ink-muted)", border: `1px solid ${pinnedPal ? "var(--cobalt)" : "var(--ink-faint)"}`, borderRadius: 3, padding: "0 3px" }}>{hIdx + 1}</span>}
                <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>{c.finish_tag}
              </button>
            );
          })}
          <button onClick={addCondition} style={{ padding: "4px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--ink-muted)" }}>+ condition</button>
        </div>
      )}

      {/* calibration prompt */}
      {tool === "calibrate" && (
        <div style={{ padding: "8px 14px", background: "var(--paper-bright)", borderBottom: "1px solid var(--hairline-warm)", fontSize: 14 }}>
          {calib.length < 2 ? <span>Custom scale: click two points along a known dimension ({calib.length}/2). Tip: use the longest dimension. (Or just pick a standard scale above.)</span> : (
            <span>Real length:{" "}
              <input name="calibration-length" type="number" value={pendingLen} onChange={(e) => setPendingLen(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyCalibration()} placeholder={units === "metric" ? "meters" : "feet"} autoFocus style={{ width: 90, padding: 5, borderRadius: 0, border: "1px solid var(--ink-faint)" }} /> {units === "metric" ? "m" : "ft"}
              <button onClick={applyCalibration} style={{ marginLeft: 8, padding: "5px 12px", borderRadius: 0, border: "none", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer" }}>Apply</button>
              <button onClick={() => setCalib([])} style={{ marginLeft: 6, padding: "5px 10px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer" }}>Reset</button>
            </span>
          )}
        </div>
      )}

      {/* check-a-dimension prompt — read-only twin of calibrate: measure a printed
          dimension at the current scale, compare with what the drawing says */}
      {tool === "check" && (
        <div style={{ padding: "8px 14px", background: "var(--paper-bright)", borderBottom: "1px solid var(--hairline-warm)", fontSize: 14 }}>
          {check.length < 2 ? (
            <span>Check a dimension: click both ends of a printed dimension ({check.length}/2). The measured length shows here — compare it with what the drawing says.</span>
          ) : checkCross ? (
            <span style={{ color: "var(--c-danger)" }}>Check on one sheet — those two clicks landed on different sheets. <button onClick={() => { setCheck([]); setCheckStated(""); }} style={{ marginLeft: 6, padding: "5px 10px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer" }}>Reset</button></span>
          ) : !checkUpp ? (
            <span style={{ color: "var(--c-danger)" }}>No scale set for {labelFor(checkPanel)} — pick a standard scale or calibrate first, then check it here.</span>
          ) : checkPx <= 0 ? (
            <span style={{ color: "var(--c-danger)" }}>Those two clicks landed on the same point — click the two <b>ends</b> of a printed dimension.</span>
          ) : (
            <span>
              measures <b style={{ fontFamily: "var(--f-mono)" }}>{fmtCheckLen(checkFeet, units)}</b> at {stdValue || "custom scale"} · drawing says{" "}
              <input name="check-stated-length" value={checkStated} onChange={(e) => setCheckStated(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} placeholder={units === "metric" ? "meters" : `feet (12'6, 6" ok)`} autoFocus style={{ width: 100, padding: 5, borderRadius: 0, border: "1px solid var(--ink-faint)" }} /> {units === "metric" ? "m" : "ft"}
              {checkErrPct != null && (() => {
                // checkVerdict grades the ROUNDED value the chip displays (and
                // normalizes -0), so color and number can never contradict —
                // see units.ts for the ≤1/≤5 tie-break rationale
                const v = checkVerdict(checkErrPct);
                const pct = `${v.shown >= 0 ? "+" : ""}${v.shown.toFixed(1)}%`;
                return (
                  <b style={{ marginLeft: 8, color: v.grade === "match" ? "var(--c-positive)" : v.grade === "close" ? "var(--c-warning)" : "var(--c-danger)" }}>
                    {v.grade === "match" ? `matches — scale checks out (${pct})`
                      : v.grade === "close" ? `off by ${pct} — re-check or recalibrate`
                      : `off by ${pct} — wrong scale; recalibrate`}
                  </b>
                );
              })()}
              {checkStatedFeet > 0 && (
                <button onClick={recalibrateFromCheck} style={{ marginLeft: 8, padding: "5px 12px", borderRadius: 0, border: "none", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer" }}>Recalibrate to this</button>
              )}
              <button onClick={() => { setCheck([]); setCheckStated(""); }} style={{ marginLeft: 6, padding: "5px 10px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer" }}>Reset</button>
            </span>
          )}
        </div>
      )}

      {/* Measure Rail — portaled to body so fixed positioning is viewport-local
          inside the canvas iframe (drag stays within the canvas bounds). */}
       {canvasReady && createPortal(
       <div
         ref={measureRailRef}
         className={`measure-rail-chrome is-portaled is-custom-pos${toolbarChrome.measureVisible ? " is-visible" : " is-hidden"}${leftPanelPresentation === "menu" && leftDesk.shown ? " has-host-menu" : ""}${measureRailResetting ? " is-rail-resetting" : ""}`}
         onPointerDown={(e) => e.stopPropagation()}
         style={{
           position: "fixed",
           zIndex: 10000,
           display: "flex",
           flexDirection: "row",
           alignItems: "flex-start",
           gap: 6,
           pointerEvents: "none",
         }}
       >
         {/* icon rail + sheets FAB + chat — one bottom-left column, left edges aligned */}
         <div
           className="canvas-left-stack"
           onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0 && !spaceRef.current) e.stopPropagation(); }}
           onDoubleClick={(e) => e.stopPropagation()}
         >
           <div className="canvas-glass-cluster">
             <button
               type="button"
               className="canvas-circle-btn canvas-adicc-rail-drag"
               data-tip="Drag to move toolbar"
               aria-label="ADICC — drag to move measure toolbar"
               onPointerDown={beginMeasureRailDrag}
             >
               <span className="canvas-adicc-rail-mark__clip">
                 <img
                   src={`${import.meta.env.BASE_URL || "/"}images/logos/adicc-logo.png`}
                   alt=""
                   draggable={false}
                 />
               </span>
               <span className="canvas-adicc-rail-drag__grip" aria-hidden="true">
                 <svg width="14" height="5" viewBox="0 0 14 5" fill="none">
                   <circle cx="2.5" cy="1.5" r="1" fill="currentColor" />
                   <circle cx="7" cy="1.5" r="1" fill="currentColor" />
                   <circle cx="11.5" cy="1.5" r="1" fill="currentColor" />
                   <circle cx="2.5" cy="3.5" r="1" fill="currentColor" />
                   <circle cx="7" cy="3.5" r="1" fill="currentColor" />
                   <circle cx="11.5" cy="3.5" r="1" fill="currentColor" />
                 </svg>
               </span>
             </button>
             <button
               type="button"
               className={`canvas-circle-btn${measureRailPos ? " is-rail-reset-ready" : " is-rail-reset-idle"}`}
               onClick={resetMeasureRailPos}
               disabled={!measureRailPos || measureRailResetting}
               data-tip={measureRailResetting ? "Returning toolbar to default position…" : (measureRailPos ? "Reset measure toolbar to default position" : "Toolbar is at default position")}
               aria-label={measureRailResetting ? "Returning toolbar to default position" : (measureRailPos ? "Reset measure toolbar to default position" : "Toolbar is at default position")}
             >
               <RotateCcw {...RAIL_ICO} />
             </button>
             <span className="canvas-rail-rule" aria-hidden="true" />
             {railBtn(toggleLayersPanel, <Icon name="layers" size={16} />, "Layers panel", illLayersOpen)}
             <span className="canvas-rail-rule" aria-hidden="true" />
             {MEASURE_TOOLS.map((t) => measureRailBtn(t))}
             <span className="canvas-rail-rule" aria-hidden="true" />
             {!isEmbedded && railBtn(() => setDarkMode((d) => !d), <Contrast {...RAIL_ICO} />, darkMode ? "Sheet back to positive print" : "Invert sheet — negative print (affects marked-set export)", false, darkMode ? "is-sheet-dark" : "")}
           </div>
           <button
             type="button"
             className={`canvas-sheets-fab canvas-circle-btn${leftTab === "sheets" ? " is-on" : ""}`}
             data-tip="Open sheets — jump, pair, or close tabs"
             aria-label="Sheets open on the canvas — jump, pair, or close tabs"
             onClick={() => {
               setIllLayersOpen(false);
               if (sheetKey) setOpenTabs((t) => (t.includes(sheetKey) ? t : [...t, sheetKey]));
               toggleSheetsTab();
             }}
           >
             <FileStack size={18} strokeWidth={1.7} aria-hidden="true" />
           </button>
           <button
             type="button"
             className={`drawings-chat-glass-trigger canvas-circle-btn${drawingsChatPill || showDrawingsChat ? " is-on" : ""}`}
             data-tip="Ask the drawings corpus"
             aria-label="Ask the Volume 4 drawings corpus"
             onClick={toggleDrawingsAsk}
           >
               <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                 <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-3.8 3.2c-.7.6-1.7.1-1.7-.8V16H6.5A2.5 2.5 0 0 1 4 13.5v-7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
                 <circle cx="9" cy="10" r="1" fill="currentColor"/>
                 <circle cx="12" cy="10" r="1" fill="currentColor"/>
                 <circle cx="15" cy="10" r="1" fill="currentColor"/>
               </svg>
             </button>
        </div>
        {/* Shared content: rail triggers dock it; host secondary-nav triggers present it as a menu. */}
        <div
          ref={hostMenuRef}
          className={`left-panel-slot${(layersMotion.shown || leftDesk.shown) ? " is-open" : ""}${leftPanelPresentation === "menu" && leftDesk.shown ? " is-host-menu" : ""}${hostMenuSwitching ? " is-switching" : ""}`}
          style={leftPanelPresentation === "menu" ? { "--host-menu-left": `${hostPanelAnchorLeft}px` } : undefined}
        >
          {layersMotion.shown && (
            <div className={`left-window${layersMotion.entered ? " is-open" : ""}`}>
              {renderLiveLayersPanel({ onClose: () => setIllLayersOpen(false) })}
            </div>
          )}
          {leftDesk.shown && deskTab && (
          <div className={`left-window${leftDesk.entered ? " is-open" : ""}`}>
          <div
            className="left-panel-glass"
            role="dialog"
            aria-label={`${LP_TAB_LABELS[deskTab] || "Project desk"} panel`}
            style={{
              width: "100%",
              alignSelf: "stretch",
              display: "flex",
              flexDirection: "column",
              borderRadius: 5,
              overflow: "hidden",
              minHeight: 0,
              height: "100%",
            }}
          >
           {leftPanelPresentation === "menu" ? (
             <div className="host-project-menu-head">
               <span key={deskTab} className="host-project-menu-title">{LP_TAB_LABELS[deskTab] || "Project desk"}</span>
               <button type="button" onClick={() => setLeftTab(null)} aria-label={`Close ${LP_TAB_LABELS[deskTab] || "project desk"} menu`}>
                 <Icon name="close" size={14} />
               </button>
             </div>
           ) : (
           /* Dock-only tab strip — host navbar already acts as the menu's section switcher. */
           <div className={`left-panel-glass-tabs${lpTabsOverflow.start ? " has-overflow-start" : ""}${lpTabsOverflow.end ? " has-overflow-end" : ""}`} style={{ color: "var(--accent-contrast)", flexShrink: 0 }}>
             <div className="lp-tabs-track">
               <button
                 type="button"
                 className="lp-tabs-shift is-start"
                 onClick={() => shiftLpTabs(-1)}
                 disabled={!lpTabsOverflow.start}
                 data-tip="Earlier tabs"
                 aria-label="Earlier tabs"
               >
                 <ChevronLeft size={14} strokeWidth={2.6} />
               </button>
             <div
               ref={lpTabsScrollRef}
               className="lp-tabs-scroller"
               role="tablist"
               aria-label="Project desk sections"
               onPointerDown={(e) => {
                 if (e.button !== 0) return;
                 const el = lpTabsScrollRef.current;
                 if (!el || el.scrollWidth <= el.clientWidth) return;
                 lpTabsDragRef.current = { x: e.clientX, sl: el.scrollLeft, moved: false, id: e.pointerId };
               }}
               onPointerMove={(e) => {
                 const d = lpTabsDragRef.current;
                 const el = lpTabsScrollRef.current;
                 if (!d || !el) return;
                 const dx = e.clientX - d.x;
                 if (!d.moved && Math.abs(dx) > 10) {
                   d.moved = true;
                   try { el.setPointerCapture(d.id); } catch { /* not all targets capture */ }
                 }
                 if (d.moved) el.scrollLeft = d.sl - dx;
               }}
               onPointerUp={() => {
                 if (lpTabsDragRef.current?.moved) {
                   lpTabsSkipClickRef.current = true;
                   setTimeout(() => { lpTabsSkipClickRef.current = false; }, 120);
                 }
                 lpTabsDragRef.current = null;
               }}
               onPointerCancel={() => { lpTabsSkipClickRef.current = false; lpTabsDragRef.current = null; }}
               onClickCapture={(e) => {
                 if (!lpTabsSkipClickRef.current) return;
                 e.preventDefault();
                 e.stopPropagation();
                 lpTabsSkipClickRef.current = false;
               }}
             >
             {[{ id: "summary", label: "Summary", n: boqShapes.length }, { id: "files", label: "Files", n: sheets.length }, { id: "sheets", label: "Sheets", n: openTabs.length }, { id: "markup", label: "Markups", n: markupCount }, { id: "stamp", label: "Stamps", n: stampLib.stamps.length }, { id: "rfi", label: "RFIs", n: rfis.length }].map((t) => (
               <button
                 key={t.id}
                 id={`lp-tab-${t.id}`}
                 type="button"
                 role="tab"
                 aria-selected={deskTab === t.id}
                 aria-controls="lp-tab-panel"
                 className={`lp-tab${deskTab === t.id ? " is-on" : ""}`}
                 onClick={() => {
                   lastLeftTabRef.current = t.id;
                   setLeftTab(t.id);
                 }}
                 title={t.label}
               >
                 <span>{t.label}</span>
                 {t.n ? <span className="lp-tab-count">{t.n}</span> : null}
               </button>
             ))}
             </div>
               <button
                 type="button"
                 className="lp-tabs-shift is-end"
                 onClick={() => shiftLpTabs(1)}
                 disabled={!lpTabsOverflow.end}
                 data-tip="More tabs"
                 aria-label="More tabs"
               >
                 <ChevronRight size={14} strokeWidth={2.6} />
               </button>
             </div>
             <button type="button" className="lp-tab-close" onClick={() => setLeftTab(null)} aria-label="Close panel">
               <Icon name="close" size={14} />
             </button>
           </div>
           )}
           {/* body of the active tab */}
           <div ref={lpScrollRef} className="left-panel-scroll" style={{ flex: 1, overflowX: "hidden", overflowY: "auto", minHeight: 0 }}>
             <div
               id="lp-tab-panel"
               role="tabpanel"
               aria-labelledby={`lp-tab-${deskTab}`}
               key={deskTab}
               className={`lp-tab-pane${leftPanelPresentation === "menu" ? " is-host-menu-pane" : ""}${lpTabMotionRef.current.animate ? (lpTabMotionRef.current.dir < 0 ? " is-back" : " is-fwd") : ""}`}
             >
             {deskTab === "summary" && (
                <SummaryPanel
                  docked={true}
                  shapes={boqShapes}
                  conditions={conditions}
                  sheetLevels={sheetLevels}
                  sheetLabel={tabLabel}
                  hiddenShapeIds={hiddenShapeIds}
                  units={units}
                  boqLines={boqLines}
                  projectName={projectName}
                  activeSheetId={focusKey || sheetKey}
                  onToggleHideIds={toggleHideIds}
                  onPatchCondition={updateCondById}
                  onShapeNavigate={flyToShape}
                  onClose={() => setLeftTab(null)}
                  roomForShape={(s) => detectRoomName(s, boqDetectCtx, shapes) || s.room_detected || s.room || ""}
                />
              )}
             {deskTab === "files" && (
               <div>
                 <div className="left-panel-glass-actions">
                   <div className="lp-action-row" role="group" aria-label="File actions">
                     <button type="button" className="lp-btn-primary" onClick={() => fileInputRef.current?.click()} title="Add PDF, image, or .zip plan set">
                       Add files
                     </button>
                     <button type="button" className="lp-btn-ghost" onClick={() => folderInputRef.current?.click()} title="Upload a whole project folder">
                       Folder
                     </button>
                     <button type="button" className="lp-btn-ghost" onClick={openGallery} title="Open the visual plan-set gallery">
                       Gallery
                     </button>
                   </div>
                 </div>
                 <div className="lp-find-wrap">
                   <label className={`lp-find${filesSearch ? " is-filled" : ""}`}>
                     <span className="lp-find-ico" aria-hidden="true">
                       <Search size={15} strokeWidth={2.25} />
                     </span>
                     <input
                       name="files-search"
                       value={filesSearch}
                       onChange={(e) => setFilesSearch(e.target.value)}
                       placeholder="Search files…"
                       aria-label="Search files by name"
                       autoComplete="off"
                     />
                     {filesSearch ? (
                       <button
                         type="button"
                         className="lp-find-clear"
                         title="Clear"
                         aria-label="Clear search"
                         onClick={() => setFilesSearch("")}
                       >
                         <X size={13} strokeWidth={2.4} />
                       </button>
                     ) : null}
                   </label>
                 </div>
                 {sheets.length === 0 ? (
                   <div style={{ padding: "16px 12px", color: "var(--ink-muted)", fontSize: 13 }}>
                     No project files yet. Use <b>Add files</b> or <b>Folder</b> to upload the whole plan set.
                   </div>
                 ) : (() => {
                   // Nest sheets under Folder-upload paths; loose files stay at the root.
                   const q = filesSearch.trim().toLowerCase();
                   const root = { folders: {}, files: [] };
                   for (const s of sheets) {
                     const parts = (fileFolders[s.name] || "").split("/").filter(Boolean);
                     let node = root;
                     for (const part of parts) {
                       if (!node.folders[part]) node.folders[part] = { name: part, folders: {}, files: [] };
                       node = node.folders[part];
                     }
                     node.files.push(s);
                   }
                   const fileName = (s) => s.name.split("/").pop();
                   const fileMatches = (s) => !q || fileName(s).toLowerCase().includes(q);
                   const filterNode = (node) => {
                     const files = node.files.filter(fileMatches);
                     const folders = {};
                     for (const [name, child] of Object.entries(node.folders)) {
                       const filtered = filterNode(child);
                       if (filtered.files.length > 0 || Object.keys(filtered.folders).length > 0) {
                         folders[name] = filtered;
                       }
                     }
                     return { folders, files };
                   };
                   const tree = q ? filterNode(root) : root;
                   const highlightName = (name) => {
                     if (!q) return name;
                     const lower = name.toLowerCase();
                     const i = lower.indexOf(q);
                     if (i < 0) return name;
                     return (
                       <>
                         {name.slice(0, i)}
                         <span style={{ background: "rgba(31, 63, 199, 0.28)", color: "var(--ink)", borderRadius: 3, padding: "0 2px" }}>{name.slice(i, i + q.length)}</span>
                         {name.slice(i + q.length)}
                       </>
                     );
                   };
                   const isOpen = (path) => (q ? true : openFolderPaths[path] === true);
                   const toggle = (path) => setOpenFolderPaths((m) => ({ ...m, [path]: !isOpen(path) }));
                   const fileRow = (s, depth) => {
                     const on = active === s.name;
                     const open = openTabs.some((k) => parseSheetKey(k).file === s.name);
                     const match = q && fileMatches(s);
                     const full = fileName(s);
                     const dot = full.lastIndexOf(".");
                     const base = dot > 0 ? full.slice(0, dot) : full;
                     const ext = dot > 0 ? full.slice(dot + 1) : "";
                     return (
                       <div key={s.name} className={`left-panel-glass-file-row${on ? " is-active" : ""}${match ? " is-match" : ""}`} style={{ "--file-indent": `${depth * 14}px`, boxShadow: match ? "inset 2px 0 0 var(--cobalt)" : undefined }}>
                         <button type="button" onClick={() => { openSheets([s.name]); setLeftTab("files"); }}
                           title={open ? `Open ${s.name}` : `Add ${s.name} to the canvas`}>
                           <span className="left-panel-glass-file-title">
                             <span className="left-panel-glass-file-name">{highlightName(base)}</span>
                             {ext ? <span className="left-panel-glass-file-ext">{ext}</span> : null}
                           </span>
                           <span className={`left-panel-glass-file-meta${on ? " is-viewing" : open ? " is-open" : ""}`}>{on ? "open · viewing" : open ? "open" : "in project"}</span>
                         </button>
                         <button type="button"
                           onClick={(e) => {
                             e.stopPropagation();
                             const key = s.name;
                             if (!openTabs.some((k) => parseSheetKey(k).file === s.name)) openSheets([key], false);
                             toggleInGroup(key);
                           }}
                           title="Side-by-side with the current sheet"
                           style={{ border: "none", background: "none", cursor: "pointer", color: "var(--c-positive)", padding: 4, display: "inline-flex" }}>
                           <Icon name="sideBySide" size={13} />
                         </button>
                         <button type="button" className="left-panel-glass-file-remove" onClick={(e) => { e.stopPropagation(); requestClosePdf(s.name); }} title={`Remove ${s.name} from this project`}>
                           <Icon name="trash" size={14} />
                         </button>
                       </div>
                     );
                   };
                   const renderNode = (node, path, depth) => {
                     const folderNames = Object.keys(node.folders).sort((a, b) => a.localeCompare(b));
                     return (
                       <>
                         {folderNames.map((name) => {
                           const child = node.folders[name];
                           const childPath = path ? `${path}/${name}` : name;
                           const open = isOpen(childPath);
                           const nFiles = (() => {
                             let c = child.files.length;
                             const walk = (n) => { for (const f of Object.values(n.folders)) { c += f.files.length; walk(f); } };
                             walk(child);
                             return c;
                           })();
                           return (
                             <div key={childPath}>
                               <button type="button" className="left-panel-glass-folder-btn" onClick={() => toggle(childPath)}
                                 title={open ? `Collapse ${name}` : `Expand ${name}`}
                                 style={{ display: "flex", alignItems: "center", gap: 10, padding: `10px 12px 10px ${12 + depth * 14}px`, border: "none", color: "var(--ink)", cursor: "pointer", textAlign: "left", fontWeight: 600, fontSize: 12.5 }}>
                                 <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, width: 12, color: "var(--cobalt)" }}>{open ? "▾" : "▸"}</span>
                                 <Icon name="sheets" size={13} />
                                 <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                                 <span style={{ fontSize: 10.5, color: "var(--ink-muted)", fontFamily: "var(--f-mono)" }}>{nFiles}</span>
                               </button>
                               {open && renderNode(child, childPath, depth + 1)}
                             </div>
                           );
                         })}
                         {node.files.map((s) => fileRow(s, depth))}
                       </>
                     );
                   };
                   const emptySearch = q && tree.files.length === 0 && Object.keys(tree.folders).length === 0;
                   return (
                     <div>
                       {emptySearch ? (
                         <div style={{ padding: "16px 12px", color: "var(--ink-muted)", fontSize: 13 }}>
                           No files match “{filesSearch.trim()}”.
                         </div>
                       ) : renderNode(tree, "", 0)}
                     </div>
                   );
                 })()}
               </div>
             )}
             {deskTab === "sheets" && (
               <div className="open-sheets-tab">
                 <label className="open-sheets-find">
                   <Search size={15} strokeWidth={2} className="open-sheets-find-ico" aria-hidden="true" />
                   <input
                     name="open-sheets-search"
                     value={sheetsSearch}
                     onChange={(e) => setSheetsSearch(e.target.value)}
                     placeholder="Jump to a sheet…"
                     aria-label="Filter open sheets"
                     autoComplete="off"
                   />
                   {sheetsSearch ? (
                     <button
                       type="button"
                       className="open-sheets-find-clear"
                       onClick={() => setSheetsSearch("")}
                       aria-label="Clear search"
                     >
                       <X size={13} strokeWidth={2.4} />
                     </button>
                   ) : null}
                 </label>
                <OpenSheetsPill
                  embedded
                  hideFind
                  hideActions
                  query={sheetsSearch}
                  openTabs={openTabs}
                  sheetGroup={sheetGroup}
                  sheetKey={sheetKey}
                  focusKey={focusKey}
                  tabLabel={tabLabel}
                  maxGroup={MAX_GROUP}
                  onGoToSheet={goToSheet}
                  onToggleInGroup={toggleInGroup}
                  onCloseTab={closeTab}
                  onClose={() => setLeftTab(null)}
                />
               </div>
             )}
             {deskTab === "markup" && (
               <div>
                 {/* layer show/hide — hides the on-canvas markup layer AND its hit-testing
                     (can't select/delete/fly-to an invisible markup); orthogonal to the
                     marked-set export, which still includes markups. */}
                 <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
                   <div style={{ flex: 1, fontSize: 12, color: "var(--ink-muted)", lineHeight: 1.45 }}>
                     Pick <b>Cloud</b>, <b>Highlight</b>, <b>Callout</b>, or <b>Text</b> above, then click the plan to annotate it.
                   </div>
                   <button
                     type="button"
                     className="lp-btn-ghost"
                     onClick={() => { const nv = !showMarkups; setShowMarkups(nv); if (!nv) setSelectedMarkupId(null); }}
                     data-tip={showMarkups ? "Hide the markup layer on the canvas" : "Show the markup layer on the canvas"}
                     aria-label={showMarkups ? "Hide the markup layer on the canvas" : "Show the markup layer on the canvas"}>
                     {showMarkups ? "Hide layer" : "Show layer"}
                   </button>
                 </div>
                 {markups.filter((m) => panelKeySet.has(m.sheet_id)).length === 0 && (
                   <div style={{ padding: "14px 12px", color: "var(--ink-muted)", fontSize: 13 }}>No markups {groupKeys.length > 1 ? "on these sheets" : "on this sheet"} yet.</div>
                 )}
                 {markups.filter((m) => panelKeySet.has(m.sheet_id)).map((m) => (
                   <div key={m.id} className="lp-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                     <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                       <span style={{ fontSize: 10, fontWeight: 700, color: "var(--cobalt)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{m.type}</span>
                       {/* inline edit — the panel's fallback for the canvas overlay, since a
                           markup here may be off-screen or on another sheet (no click point).
                           Enter/blur commit, Esc cancels; INPUT is guarded from the global keys. */}
                       {panelEditId === m.id ? (
                         <input name="markup-text" autoComplete="off" autoFocus defaultValue={m.text || ""}
                           onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); updateMarkup(m.id, { text: e.currentTarget.value.trim() }); setPanelEditId(null); } else if (e.key === "Escape") { e.preventDefault(); e.currentTarget.value = m.text || ""; setPanelEditId(null); } }}
                           onBlur={(e) => { updateMarkup(m.id, { text: e.currentTarget.value.trim() }); setPanelEditId(null); }}
                           className="lp-field" style={{ flex: 1, minWidth: 0, padding: "5px 8px" }} />
                       ) : (
                         <span style={{ flex: 1, minWidth: 0, color: "var(--ink)", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.type === "svg" ? <em style={{ color: "var(--ink-muted)" }}>(vector symbol)</em> : (m.text || <em style={{ color: "var(--ink-muted)" }}>(no text)</em>)}</span>
                       )}
                       {m.type !== "svg" && (
                         <button type="button" className="lp-icon-btn" onClick={() => setPanelEditId((id) => (id === m.id ? null : m.id))} data-tip="Edit text" aria-label="Edit text">
                           <Icon name="edit" size={13} />
                         </button>
                       )}
                       <button type="button" className="lp-icon-btn is-danger" onClick={() => setPendingMarkupDelete(m)} data-tip="Delete markup" aria-label="Delete markup">
                         <Icon name="trash" size={13} />
                       </button>
                     </div>
                     {/* appearance — per-markup color (reuse PALETTE) + line style; both
                         additive: unset color falls back to the cobalt(linked)/amber default,
                         unset style to solid. The RFI ⬢/number badge stays cobalt regardless. */}
                     <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                       <span className="lp-label" style={{ margin: 0 }}>Color</span>
                       <button type="button" title="Auto (linkage color)" onClick={() => updateMarkup(m.id, { color: "" })} style={{ width: 28, height: 18, borderRadius: 4, background: "var(--paper-bright)", border: !m.color ? "2px solid var(--ink)" : "1px solid var(--ink-faint)", cursor: "pointer", fontSize: 8.5, lineHeight: "14px", color: "var(--ink-muted)" }}>auto</button>
                       {PALETTE.map((c) => <button key={c} type="button" title={c} onClick={() => updateMarkup(m.id, { color: c })} style={{ width: 16, height: 16, borderRadius: 4, background: c, border: m.color === c ? "2px solid var(--ink)" : "1px solid var(--ink-faint)", cursor: "pointer" }} />)}
                       <select name="markup-line-style" className="lp-field" value={m.line_style || "solid"} onChange={(e) => updateMarkup(m.id, { line_style: e.target.value })} title="Line style" style={{ width: "auto", padding: "4px 6px", fontSize: 11 }}>
                         {LINE_STYLE_IDS.map((id) => <option key={id} value={id}>{LINE_STYLES[id].label}</option>)}
                       </select>
                       {/* line weight — a multiplier over the element's base stroke width (default
                           ×1, clamped 0.5–3); additive, absent = ×1 so legacy markups are unchanged */}
                       <span className="lp-label" style={{ margin: 0 }}>Weight</span>
                       <select name="markup-weight" className="lp-field" value={String(snapWeight(m.weight))} onChange={(e) => updateMarkup(m.id, { weight: Number(e.target.value) })} title="Line weight (× base)" style={{ width: "auto", padding: "4px 6px", fontSize: 11 }}>
                         {WEIGHT_STEPS.map((wv) => <option key={wv} value={wv}>{wv}×</option>)}
                       </select>
                       {/* revision-delta △n — clouds only; blank clears it (no delta drawn) */}
                       {m.type === "cloud" && (
                         <>
                           <span className="lp-label" style={{ margin: 0 }} title="Revision-delta number (△) drawn at a cloud corner">Rev △</span>
                           <input name="markup-rev" className="lp-field" type="number" min="0" step="1" value={Number.isFinite(m.rev) ? m.rev : ""} placeholder="—"
                             onChange={(e) => { const raw = e.target.value; updateMarkup(m.id, { rev: raw === "" ? undefined : Math.max(0, Math.floor(Number(raw) || 0)) }); }}
                             title="Revision number for the △ delta (blank = none)"
                             style={{ width: 48, padding: "4px 6px", fontSize: 11 }} />
                         </>
                       )}
                     </div>
                     {/* RFI controls — raise a fresh RFI, link an existing one, or unlink */}
                     {(() => {
                       const linked = m.rfi_id ? rfis.find((r) => r.id === m.rfi_id) : null;
                       return (
                         <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                           {linked ? (
                             <>
                               <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, fontWeight: 700, color: "var(--cobalt)" }}><Icon name="rfi" size={11} /> {String(linked.number ?? "")}</span>
                               <button type="button" className="lp-btn-ghost" onClick={() => { setLeftTab("rfi"); }} title="Open the RFI register" style={{ padding: "4px 8px", fontSize: 11 }}>Open</button>
                               <button type="button" className="lp-btn-ghost" onClick={() => unlinkRfi(m)} title="Unlink this markup from its RFI" style={{ padding: "4px 8px", fontSize: 11 }}>Unlink</button>
                             </>
                           ) : (
                             <>
                               <button type="button" className="lp-btn" onClick={() => raiseRfi(m)} title="Create a new RFI from this markup" style={{ padding: "4px 8px", fontSize: 11, color: "var(--cobalt)" }}>Raise RFI</button>
                               {rfis.length > 0 && (
                                 <select name="link-rfi" className="lp-field" value="" onChange={(e) => { if (e.target.value) linkRfi(m, e.target.value); }}
                                   title="Link this markup to an existing RFI" style={{ width: "auto", maxWidth: 150, padding: "4px 6px", fontSize: 11 }}>
                                   <option value="">Link existing…</option>
                                   {rfis.map((r) => <option key={r.id} value={r.id}>{r.number}{r.subject ? ` · ${r.subject}` : ""}</option>)}
                                 </select>
                               )}
                             </>
                           )}
                         </div>
                       );
                     })()}
                   </div>
                 ))}
               </div>
             )}
             {deskTab === "stamp" && (
               <StampPanel
                 docked
                 library={stampLib} armedStamp={armedStamp}
                 selectedMarkup={selectedMarkupId ? markups.find((m) => m.id === selectedMarkupId) : null}
                 onArm={armStamp} onSaveSelected={saveMarkupAsStamp} onDelete={deleteStamp} onRename={renameStamp}
                 onExport={exportStamps} onImport={importStamps} onImportSvg={importSvgStamp} onClose={() => setLeftTab(null)}
               />
             )}
             {deskTab === "rfi" && (
               <RfiPanel
                 docked
                 rfis={rfis} markups={markups}
                 onUpdateRfi={updateRfi} onDeleteRfi={deleteRfi} onFlyTo={flyToMarkup}
                 sheetLabel={(k) => tabLabel(k)} onClose={() => setLeftTab(null)}
               />
             )}
             </div>
           </div>
         </div>
           </div>
         )}
        </div>
       </div>,
       document.body)}
      {/* canvas + issue desk */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0, position: "relative" }}>
       <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* Bottom-right view stack. Stays put when Takeoffs opens so the
            drawer slides over the minimap / zoom / HUD instead of shoving them. */}
        {canvasReady && (
          <div
            className="canvas-view-dock"
            style={{ position: "absolute", right: 16, bottom: viewPrefs.rulers ? 38 : 14, zIndex: 40, pointerEvents: "none" }}
          >
            {sheetTools && (
            <div className="canvas-hud-dock">
            {Number(projectEstimateTotal) > 0 && (
              <div
                className={`canvas-estimate-hud has-focus${viewPrefs.estimate ? "" : " is-view-hidden"}`}
                title="Live takeoff value — updates as quantities and rates change"
              >
                <div className="canvas-estimate-hud-copy">
                  <div className={estimateValuePulse ? "canvas-estimate-hud-val is-pulse" : "canvas-estimate-hud-val"}>
                    {money(projectEstimateTotal || 0, projectCurrency)}
                  </div>
                  <div className="canvas-estimate-hud-lbl">TAKE-OFF VALUE</div>
                </div>
                <EstimateValueSpark series={estimateHistory} currency={projectCurrency} />
              </div>
            )}
              <LiveReadoutBar
                overlay
                visible={viewPrefs.readout}
                tool={tool}
                aCond={aCond}
                activeCond={activeCond}
                units={units}
                unitsPerPx={unitsPerPx}
                poly={poly}
                liveUpp={liveUpp}
                liveArea={liveArea}
                livePerim={livePerim}
                zoneTraceCross={zoneTraceCross}
                condH={condH}
                proposal={proposal}
                wallProposal={wallProposal}
                ocSel={ocSel}
                selShape={selShape}
                doorScheduleOptions={doorScheduleOptions}
                condRow={condRow}
                condMult={condMult}
                condTotal={condTotal}
                wallTotal={wallTotal}
                floorBeforeDeduction={condDeduction.floorBefore}
                floorAfterDeduction={condDeduction.floorAfter}
                wallBeforeDeduction={condDeduction.wallBefore}
                wallAfterDeduction={condDeduction.wallAfter}
                borderTotal={borderTotal}
                lfTotal={lfTotal}
                countTotal={countTotal}
                vertTotal={vertTotal}
                sheetFloorSf={sheetFloorSf}
                sheetWallSf={sheetWallSf}
                visibleShapeCount={visibleShapes.length}
                groupKeyCount={groupKeys.length}
                zoomScale={tf.scale}
                onSetShapeHeight={setShapeHeight}
                onClearShapeHeight={clearShapeHeight}
                wallSegmentRows={selWallSegmentRows}
                onSetSegmentHeight={(idx, raw) => selectedId && setSegmentHeight(selectedId, idx, raw)}
                onFlyToWallSegment={(idx) => selectedId && flyToWallSegment(selectedId, idx)}
                activeWallSegment={selShape?.measure_role === "surface_area" ? wallSegmentFocus : null}
                onAddWallOpening={addWallOpening}
                onStartWallCutout={startWallCutoutLinear}
                onUpdateWallOpening={updateWallOpening}
                onRemoveWallOpening={removeWallOpening}
                onFlyToWallOpening={flyToWallOpening}
              />
            </div>
            )}
            <div
              className={`canvas-minimap${minimapOpen ? " is-open" : ""}`}
              onPointerDown={onMinimapPointerDown}
              onPointerMove={onMinimapPointerMove}
              onPointerUp={onMinimapPointerUp}
              onPointerCancel={onMinimapPointerUp}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <div className="canvas-minimap-stage">
                <canvas ref={minimapCanvasRef} className="canvas-minimap-cv" title="Overview — drag to pan, scroll to zoom the sheet" />
                <div ref={minimapViewRef} className="canvas-minimap-view" aria-hidden="true" />
              </div>
            </div>
            <div
              ref={zoomBarRef}
              className="canvas-zoom-bar"
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <button type="button" className="canvas-zoom-btn" data-tip="Undo · ⌘Z" aria-label="Undo (⌘Z)"
                disabled={!undoStackRef.current.length}
                onClick={undoShapeCommand}>
                <Undo2 size={15} strokeWidth={1.8} />
              </button>
              <button type="button" className="canvas-zoom-btn" data-tip="Redo · ⇧⌘Z" aria-label="Redo (⇧⌘Z)"
                disabled={!redoStackRef.current.length}
                onClick={redoShapeCommand}>
                <Redo2 size={15} strokeWidth={1.8} />
              </button>
              <span className="canvas-zoom-sep" aria-hidden="true" />
              <button type="button" className={`canvas-zoom-btn${minimapOpen ? " is-on" : ""}`} data-tip="Minimap — drag to pan, scroll to zoom" aria-label="Minimap — sheet overview; drag to pan, scroll to zoom" aria-pressed={minimapOpen}
                onClick={() => setMinimapOpen((v) => !v)}>
                <MapIcon size={15} strokeWidth={1.6} />
              </button>
              <button type="button" className="canvas-zoom-btn" data-tip="Zoom out" aria-label="Zoom out"
                onClick={() => { const r = containerRef.current.getBoundingClientRect(); zoomAround(r.width / 2, r.height / 2, 0.8); }}>
                <Minus size={16} strokeWidth={2} />
              </button>
              <button type="button" className="canvas-zoom-pct" data-tip="Reset to 100%" aria-label="Reset to 100%"
                onClick={() => { const r = containerRef.current.getBoundingClientRect(); zoomAround(r.width / 2, r.height / 2, 1 / (tfRef.current.scale || 1)); }}>
                {Math.round((tf.scale || 1) * 100)}%
              </button>
              <button type="button" className="canvas-zoom-btn" data-tip="Zoom in" aria-label="Zoom in"
                onClick={() => { const r = containerRef.current.getBoundingClientRect(); zoomAround(r.width / 2, r.height / 2, 1.25); }}>
                <Plus size={16} strokeWidth={2} />
              </button>
              <span className="canvas-zoom-sep" aria-hidden="true" />
              <button type="button" className="canvas-zoom-btn" data-tip="Fit sheet to view" aria-label="Fit sheet to view"
                onClick={() => stage.w && fitToView(stage.w, stage.h)}>
                <Scan size={15} strokeWidth={1.6} />
              </button>
              <button
                type="button"
                className={`canvas-zoom-btn${canvasExpanded ? " is-on" : ""}`}
                data-tip={canvasExpanded ? "Exit fullscreen · Esc" : "Fullscreen"}
                aria-label={canvasExpanded ? "Exit fullscreen" : "Fullscreen"}
                aria-pressed={canvasExpanded}
                onClick={async () => {
                  if (isEmbedded) {
                    const active = !canvasExpanded;
                    window.parent?.postMessage({
                      source: "opentakeoff",
                      type: "adicc:canvas-expand-state",
                      active,
                    }, "*");
                    setCanvasExpanded(active);
                    return;
                  }
                  const el = containerRef.current?.closest(".canvas-workspace") || containerRef.current;
                  if (!el) return;
                  try {
                    if (document.fullscreenElement) await document.exitFullscreen?.();
                    else await el.requestFullscreen?.();
                  } catch { /* browser denied standalone fullscreen */ }
                }}>
                {canvasExpanded ? <Minimize2 size={15} strokeWidth={1.6} /> : <Maximize2 size={15} strokeWidth={1.6} />}
              </button>
            </div>
          </div>
        )}
        <div ref={containerRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp} onPointerLeave={leaveCanvas}
          onContextMenu={(e) => {
            e.preventDefault();
            const polyDrawing = poly.length > 0 && (tool === "area" || tool === "deduct" || tool === "deduct-curve" || tool === "wallarea" || tool === "linear" || tool === "curve" || tool === "surface" || tool === "zone" || tool === "rect" || tool === "deduct-rect");
            if (polyDrawing) return;
            const r = containerRef.current?.getBoundingClientRect();
            if (!r || status !== "ready") { setShapeCtxMenu(null); return; }
            const p = toImage(e.clientX, e.clientY);
            const thr = 8 / tfRef.current.scale;
            const hit = [...visibleShapes].slice().sort((a, b) => {
              const ad = a.measure_role === "deduct" ? 1 : 0, bd = b.measure_role === "deduct" ? 1 : 0;
              return ad - bd;
            }).reverse().find((s) => {
              if (!aiDetectShapeRevealed(s)) return false;
              const sp = panelByKey(s.sheet_id);
              return sp && hitShapeC(s, p[0] - sp.xOffset, p[1], sp.img.w, sp.img.h, thr);
            });
            if (!hit) { setShapeCtxMenu(null); return; }
            const live = shapesRef.current;
            const curPicks = Object.keys(layerPickIds).filter((id) => live.some((s) => s.id === id));
            if (curPicks.includes(hit.id) && curPicks.length > 1) {
              // Preserve multi-selection
            } else if (hit.measure_role === "deduct") {
              setSelectedCutoutIds((prev) => (prev.has(hit.id) ? prev : new Set([hit.id])));
              setSelectedId(hit.id);
            } else {
              setSelectedCutoutIds(new Set());
              selectShape(hit.id, { [hit.id]: true });
            }
            setShapeCtxMenu({
              x: Math.min(e.clientX - r.left, r.width - 240),
              y: Math.min(e.clientY - r.top, r.height - 280),
              shapeId: hit.id,
            });
          }}
          onDoubleClick={(e) => {
            // Double-click on a vertex → remove it; Double-click near an edge → insert a vertex
            // Must run BEFORE the shapeBoqHover check so clicks on the border line work.
            if (tool === "select" && selectedId) {
              const _dSel = shapes.find((_x) => _x.id === selectedId);
              const _dSp = _dSel && panelKeySet.has(_dSel.sheet_id) ? panelByKey(_dSel.sheet_id) : null;
              if (_dSel && _dSp && _dSel.measure_role !== "count") {
                const _dP = toImage(e.clientX, e.clientY);
                const _dPts = _dSel.verts_norm.map(([nx, ny]) => [nx * _dSp.img.w + _dSp.xOffset, ny * _dSp.img.h]);
                
                // 1. Check if user double-clicked a vertex (remove it)
                const _dThr = 10 / tfRef.current.scale;
                let _clickedVert = -1;
                for (let _i = 0; _i < _dPts.length; _i++) {
                  if (Math.hypot(_dPts[_i][0] - _dP[0], _dPts[_i][1] - _dP[1]) < _dThr * 1.6) {
                    _clickedVert = _i; break;
                  }
                }
                if (_clickedVert >= 0) {
                  const isClosed = _dSel.measure_role !== "linear" && _dSel.measure_role !== "surface_area";
                  const minV = isClosed ? 3 : 2;
                  if (_dSel.verts_norm.length <= minV) {
                    setCommitMsg(isClosed ? "A shape needs at least 3 points — ⌫ again deletes the whole shape." : "A run needs at least 2 points — ⌫ again deletes the whole run.");
                    return;
                  }
                  const vn = _dSel.verts_norm.filter((_, j) => j !== _clickedVert);
                  dispatchShape({
                    type: "geom", id: _dSel.id, editKind: "vertexDelete",
                    verts_norm: vn, computed: recomputeShape({ ..._dSel, verts_norm: vn }), prev: geomSnapshot(_dSel),
                  });
                  setSelVert(null); setSelHole(null); setHoverEdge(null);
                  return;
                }

                // 2. Check if user double-clicked an edge (insert vertex)
                // 2. Check if user double-clicked an edge (insert vertex)
                if (hoverEdge && hoverEdge.shapeId === selectedId) {
                  const _dBestI = hoverEdge.i;
                  if (_dBestI >= _dPts.length) return; // safety against stale hover state
                  const _jIdx = (_dBestI + 1) % _dPts.length;
                  const _dx = _dPts[_jIdx][0] - _dPts[_dBestI][0], _dy = _dPts[_jIdx][1] - _dPts[_dBestI][1];
                  const _l2 = _dx * _dx + _dy * _dy;
                  const _dBestT = _l2 ? Math.max(0.01, Math.min(0.99, ((_dP[0] - _dPts[_dBestI][0]) * _dx + (_dP[1] - _dPts[_dBestI][1]) * _dy) / _l2)) : 0.5;
                  const _va = _dSel.verts_norm[_dBestI];
                  const _vb = _dSel.verts_norm[_jIdx];
                  const _nv = [_va[0] + (_vb[0] - _va[0]) * _dBestT, _va[1] + (_vb[1] - _va[1]) * _dBestT];
                  const _vnIns = [..._dSel.verts_norm.slice(0, _dBestI + 1), _nv, ..._dSel.verts_norm.slice(_dBestI + 1)];
                  dispatchShape({
                    type: "geom", id: _dSel.id, editKind: "vertexInsert",
                    verts_norm: _vnIns, computed: recomputeShape({ ..._dSel, verts_norm: _vnIns }), prev: geomSnapshot(_dSel),
                  });
                  setSelVert(_dBestI + 1);
                  setWallSegmentFocus(_dBestI);
                  setSelHole(null); setHoverEdge(null);
                  return;
                }
              }
            }
            if (shapeBoqHover?.id) {
              setShapeBoqFocus(shapeBoqHover.id);
              shapeBoqPinPosRef.current = { cx: shapeBoqHover.cx, cy: shapeBoqHover.cy };
              shapeBoqHoverStickyRef.current = true;
              return;
            }
            if (symbolHover) { setSymbolFocus(symbolHover.id); return; }
            if (tool === "oneclick") { if (proposal?.regions.length) createProposal(); }
            else if (tool === "walltrace") { if (wallProposal?.regions.length) createWallProposal(); }
            else if (tool === "area" || tool === "deduct" || tool === "deduct-curve" || tool === "wallarea" || tool === "linear" || tool === "curve" || tool === "surface" || tool === "zone") finishShape();
            else if (tool === "select") editMarkupAt(e);
          }}
          style={{ position: "absolute", inset: 0, ...(darkMode ? { background: workspaceBg } : {}), cursor: tool === "pan" ? "grab" : tool === "select" ? "default" : "none", touchAction: "none" }}
          className={`canvas-workspace${darkMode ? " is-sheet-invert" : ""}${viewPrefs.rulers ? " has-view-rulers" : ""}`}
          data-canvas-status={status}>
          {viewPrefs.rulers && rulerMetrics && (
            <>
              <div ref={rulerXRef} className="canvas-view-ruler is-horizontal" aria-hidden="true">
                <span>{rulerMetrics.label}</span>
              </div>
              <div ref={rulerYRef} className="canvas-view-ruler is-vertical" aria-hidden="true" />
              <div className="canvas-view-ruler-corner" aria-hidden="true">0</div>
            </>
          )}
          {/* aim crosshair (draw modes): the OS cursor is hidden on the canvas — the
              crosshair IS the cursor. Two crisp full-page hairlines riding the
              EFFECTIVE point (angle-locked / endpoint-snapped), the SPLINE STAR at
              the crossing, and a small readout chip in the house style. The 45°
              lock reads as a quiet state change (hairlines brighten, star swells
              cobalt, rubber band thickens) — no extra chrome on the sheet. All
              positioned imperatively in moveCrosshair. */}
          <div ref={crossVRef} style={{ position: "absolute", top: 0, bottom: 0, width: 1.5, background: "var(--canvas-aim)", boxShadow: "var(--canvas-aim-shadow)", pointerEvents: "none", display: "none", zIndex: 5 }} />
          <div ref={crossHRef} style={{ position: "absolute", left: 0, right: 0, height: 1.5, background: "var(--canvas-aim)", boxShadow: "var(--canvas-aim-shadow)", pointerEvents: "none", display: "none", zIndex: 5 }} />
          <div ref={aimMarkRef} style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none", display: "none", zIndex: 6, willChange: "transform" }}>
            {/* the SPLINE STAR at the crossing — the house vertex mark IS the cursor;
                it swells and glows cobalt while the 45° lock holds */}
            <svg width={22} height={22} viewBox="0 0 22 22" style={{ position: "absolute", left: -11, top: -11, transition: "transform 120ms ease, filter 120ms ease", filter: "var(--canvas-aim-star-shadow)" }}>
              <path d={starPath(11, 11, 8.5)} style={{ fill: "var(--canvas-aim-star)", stroke: "var(--canvas-aim-star-stroke)" }} strokeWidth={1.4} />
            </svg>
          </div>
          <div ref={aimChipRef} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", display: "none", zIndex: 6, padding: "2px 8px", background: "var(--canvas-chip-bg)", border: "1px solid var(--canvas-chip-border)", boxShadow: "var(--shadow-1)", fontFamily: "var(--f-mono)", fontSize: 10.5, fontWeight: 600, color: "var(--canvas-chip-ink)", whiteSpace: "nowrap", willChange: "transform" }} />
          {/* hover readout — proposals / agent previews (DOM-direct) */}
          <div ref={hoverRef} style={{ position: "absolute", display: "none", pointerEvents: "none", zIndex: 8, background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-1)", padding: "4px 8px", fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink)", whiteSpace: "nowrap" }} />
          {/* BOQ hover card — masked area quantities; click opens filtered BOQ panel */}
          {(shapeBoqFocus || shapeBoqHover) && (() => {
            const cardId = shapeBoqFocus || shapeBoqHover?.id;
            const s = shapes.find((x) => x.id === cardId);
            const cardPos = shapeBoqHover || (shapeBoqFocus ? shapeBoqPinPosRef.current : null);
            if (!s || !cardPos) return null;
            if (isAiDetectFloorPlan(s.sheet_id) && !aiDetectShapeRevealed(s)) return null;
            const boqShape = (s.measure_role === "surface_area" || s.measure_role === "wall_area" || s.measure_role === "floor_area")
              ? { ...s, computed: recomputeShape(s) }
              : s;
            const data = resolveShapeBoq(boqShape, conditions, boqDetectCtx, boqLines, units, pricingCtx);
            if (!data) return null;
            const pinned = !!shapeBoqFocus;
            return (
              <ShapeBoqHoverCard
                key={cardId}
                data={data}
                left={cardPos.cx}
                top={cardPos.cy}
                units={units}
                pinned={pinned}
                onOpenBoq={() => openBoqForShape(s.id)}
                onOpenDoorDetect={(ref) => {
                  const sid = ref?.symbol_id;
                  if (!sid || !planSymbols.some((p) => p.id === sid)) return;
                  const cw = containerRef.current?.clientWidth || 800;
                  const ch = containerRef.current?.clientHeight || 600;
                  const cx = Math.min((cardPos?.cx ?? 24) + 16, cw - 308);
                  const cy = Math.min(cardPos?.cy ?? 24, ch - 380);
                  setSymbolHover({ id: sid, cx: Math.max(8, cx), cy: Math.max(8, cy) });
                  setSymbolFocus(sid);
                }}
                onDeductDoor={(ref) => deductDoorOnWall(s.id, ref)}
                onUpdateHeight={(hFt) => setShapeHeightFt(s.id, hFt)}
                onUpdateRate={(rVal) => setShapeManualRate(s.id, rVal)}
                onMove={(nx, ny) => {
                  const cw = containerRef.current?.clientWidth || 1200;
                  const ch = containerRef.current?.clientHeight || 800;
                  const cx = Math.max(8, Math.min(cw - 256, nx));
                  const cy = Math.max(8, Math.min(ch - 80, ny));
                  setShapeBoqHover((prev) => (prev ? { ...prev, cx, cy } : { id: cardId, cx, cy }));
                  if (shapeBoqFocus) shapeBoqPinPosRef.current = { cx, cy };
                  shapeBoqHoverStickyRef.current = true;
                }}
                onClose={() => { setShapeBoqFocus(null); setShapeBoqHover(null); shapeBoqPinPosRef.current = null; shapeBoqHoverStickyRef.current = false; }}
                onOpenFinishSource={(fd) => {
                  if (!fd?.source_sheet) return;
                  const roomName = fd.room_name || data.room || "";
                  const sheetFloor = fd.floors || floorLabelFromSheetId(s.sheet_id) || "";
                  const finishTag = fd.tag || data.finish_tag || "";
                  const roomHit = scheduleKb && roomName
                    ? lookupScheduleRoomHighlight(scheduleKb, roomName, {
                      sheetId: fd.source_sheet,
                      tag: finishTag,
                      sheetFloor,
                    })
                    : null;
                  const spaceBbox = roomHit?.space_bbox || fd.space_bbox || null;
                  setSymbolSourceView({
                    sheetId: fd.source_sheet,
                    title: fd.source || fd.source_sheet,
                    bbox: spaceBbox || fd.source_bbox || null,
                    spaceBbox,
                    markBbox: fd.source_bbox || null,
                    tag: finishTag,
                    room: roomName,
                    sheetFloor,
                  });
                }}
                onPointerEnter={() => { shapeBoqHoverStickyRef.current = true; }}
                onPointerLeave={() => {
                  shapeBoqHoverStickyRef.current = false;
                  if (!shapeBoqFocus) setShapeBoqHover(null);
                }}
              />
            );
          })()}
          {/* Plan-symbol detail card — hover preview, or pinned (Select-click) for manual fill */}
          {(() => {
            const focusSym = symbolFocus ? planSymbols.find((s) => s.id === symbolFocus) : null;
            const hoverSym = !focusSym && symbolHover ? planSymbols.find((s) => s.id === symbolHover.id) : null;
            const sym = focusSym || hoverSym;
            if (!sym) return null;
            const pinned = !!focusSym;
            const noteKey = symbolNoteKey(sym.sheet_id, sym.tag, sym.x, sym.y);
            const fields = resolveSymbolFields(sym.schedule, symbolNotes[noteKey], sym.room_name);
            const left = pinned ? Math.min((symbolHover?.cx ?? 24), (containerRef.current?.clientWidth || 400) - 300) : (symbolHover?.cx ?? 24);
            const top = pinned ? Math.min((symbolHover?.cy ?? 24), (containerRef.current?.clientHeight || 400) - 380) : (symbolHover?.cy ?? 24);
            const fieldRows = [
              ["room_name", "Room name", fields.room_name],
              ["type", "Type", fields.type || SYMBOL_KIND_LABEL[sym.kind]],
              ["description", "Description", fields.description],
              ["size", "Size / opening", fields.size],
              ["fire_rating", "Fire rating", fields.fire_rating],
              ["floors", "Floors", fields.floors],
              ["manufacturer", "Manufacturer", fields.manufacturer],
              ["style", "Style", fields.style],
              ["color", "Color", fields.color],
              ["remarks", "Remarks", fields.remarks],
            ];
            const setNote = (field, value) => {
              setSymbolNotes((prev) => {
                const cur = { ...(prev[noteKey] || {}) };
                const v = (value || "").trim();
                if (v) cur[field] = v; else delete cur[field];
                const next = { ...prev };
                if (Object.keys(cur).length) next[noteKey] = cur; else delete next[noteKey];
                return next;
              });
            };
            const hasSource = !!(sym.schedule?.source_sheet);
            const detailLinks = sym.kind === "detail" ? (sym.detail_links || []) : [];
            const hasEdits = !!(symbolNotes[noteKey] && Object.keys(symbolNotes[noteKey]).length);
            const openSource = () => {
              if (!sym.schedule?.source_sheet) return;
              setSymbolSourceView({
                sheetId: sym.schedule.source_sheet,
                title: sym.schedule.source_title || sym.schedule.source_sheet,
                bbox: sym.schedule.source_bbox || null,
                tag: sym.tag,
              });
            };
            const openDetailLink = (link) => {
              setSymbolSourceView({
                sheetId: link.sheet_id,
                title: `${sym.tag} · ${link.title || link.sheet_id}`.replace(/^ · /, ""),
                bbox: null,
                tag: sym.tag,
              });
            };
            return (
              <div data-hover-scroll style={{ position: "absolute", left, top, zIndex: 12, width: 300, background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-2)", pointerEvents: "auto", fontFamily: "var(--f-body)", fontSize: 12, color: "var(--ink)", cursor: !pinned ? "pointer" : "default" }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); if (!pinned) setSymbolFocus(sym.id); }}
                onDoubleClick={(e) => { e.stopPropagation(); if (!pinned) setSymbolFocus(sym.id); }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "10px 12px 6px", borderBottom: "1px solid var(--ink-faint)", cursor: pinned ? "grab" : "pointer", userSelect: "none" }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    if (!pinned) {
                      setSymbolFocus(sym.id);
                      return;
                    }
                    e.preventDefault();
                    const ox = e.clientX - left;
                    const oy = e.clientY - top;
                    const move = (ev) => {
                      const nl = Math.max(8, Math.min((containerRef.current?.clientWidth || 1200) - 308, ev.clientX - ox));
                      const nt = Math.max(8, Math.min((containerRef.current?.clientHeight || 1200) - 80, ev.clientY - oy));
                      setSymbolHover((prev) => (prev ? { ...prev, cx: nl, cy: nt } : { id: sym.id, cx: nl, cy: nt }));
                    };
                    const up = () => {
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                    };
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                  }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    {fields.room_name ? (
                      <div style={{ fontFamily: "var(--f-display)", fontWeight: 700, fontSize: 14, color: "var(--ink)", lineHeight: 1.25, marginBottom: 2 }}>{fields.room_name}</div>
                    ) : null}
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: 13, letterSpacing: "0.04em" }}>{sym.tag}</span>
                      <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>{SYMBOL_KIND_LABEL[sym.kind]}</span>
                    </div>
                  </div>
                  {pinned ? (
                    <button type="button" onClick={() => setSymbolFocus(null)} title="Close"
                      style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-muted)", fontSize: 14, lineHeight: 1, padding: 2 }}>×</button>
                  ) : (
                    <span style={{ fontSize: 10, color: "var(--ink-muted)", whiteSpace: "nowrap" }}>click to edit</span>
                  )}
                </div>
                <div style={{ padding: "8px 12px", display: "grid", gap: 6, maxHeight: pinned ? 380 : 320, overflowY: "auto", overscrollBehavior: "contain" }}>
                  {fieldRows.map(([key, label, value]) => {
                    const empty = !value;
                    if (!pinned) {
                      return (
                        <div key={key} style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: 6, alignItems: "baseline" }}>
                          <span style={{ fontSize: 10.5, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
                          <span style={{ color: empty ? "var(--ink-faint)" : "var(--ink)", lineHeight: 1.35 }}>{empty ? "—" : value}</span>
                        </div>
                      );
                    }
                    return (
                      <label key={key} style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: 6, alignItems: "center" }}>
                        <span style={{ fontSize: 10.5, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
                        <input name={`sym-${key}`}
                          value={symbolNotes[noteKey]?.[key] ?? (fields[key] || (key === "type" ? (SYMBOL_KIND_LABEL[sym.kind] || "") : "") || "")}
                          placeholder="Enter…"
                          onChange={(e) => setNote(key, e.target.value)}
                          style={{ width: "100%", boxSizing: "border-box", padding: "4px 6px", border: "1px solid var(--ink-faint)", background: empty && !symbolNotes[noteKey]?.[key] ? "var(--paper-cream)" : "var(--paper-bright)", fontSize: 12, color: "var(--ink)", fontFamily: "var(--f-body)" }} />
                      </label>
                    );
                  })}
                  {sym.kind === "detail" && detailLinks.length > 0 && (
                    <div style={{ marginTop: 4, paddingTop: 8, borderTop: "1px solid var(--ink-faint)" }}>
                      <div style={{ fontSize: 10.5, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Detail sheets</div>
                      {detailLinks.map((link) => (
                        <button key={link.sheet_id} type="button" onClick={(e) => { e.stopPropagation(); openDetailLink(link); }}
                          title="Open matching detail sheet in floating window"
                          style={{
                            display: "block", width: "100%", textAlign: "left", padding: "2px 0", border: "none",
                            background: "transparent", cursor: "pointer", fontSize: 11.5, color: "var(--ink)",
                            lineHeight: 1.35, fontFamily: "var(--f-body)", textDecoration: "underline",
                            textUnderlineOffset: 2,
                          }}>
                          {link.title}
                        </button>
                      ))}
                      {pinned && detailLinks[0] && (
                        <button type="button" onClick={(e) => { e.stopPropagation(); openDetailLink(detailLinks[0]); }}
                          style={{ width: "100%", marginTop: 8, padding: "6px 10px", border: "1px solid var(--ink)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--ink)", fontFamily: "var(--f-body)" }}>
                          Open in floating window →
                        </button>
                      )}
                    </div>
                  )}
                  {sym.kind !== "detail" && hasSource && (
                    <div style={{ marginTop: 4, paddingTop: 8, borderTop: "1px solid var(--ink-faint)" }}>
                      <div style={{ fontSize: 10.5, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Source</div>
                      <button type="button" onClick={openSource}
                        title="Open source PDF with this schedule region highlighted"
                        style={{
                          display: "block", width: "100%", textAlign: "left", padding: 0, border: "none",
                          background: "transparent", cursor: "pointer", fontSize: 11.5, color: "var(--ink)",
                          lineHeight: 1.35, fontFamily: "var(--f-body)", textDecoration: "underline",
                          textUnderlineOffset: 2,
                        }}>
                        {sym.schedule.source_title || sym.schedule.source_sheet}
                      </button>
                      {pinned && (
                        <button type="button" onClick={openSource}
                          style={{ width: "100%", marginTop: 8, padding: "6px 10px", border: "1px solid var(--ink)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--ink)", fontFamily: "var(--f-body)" }}>
                          Open source PDF →
                        </button>
                      )}
                    </div>
                  )}
                  {pinned && (
                    <div style={{ marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--ink-faint)", display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.4 }}>
                        {hasEdits ? "Edits saved with this takeoff." : "Edit any field — changes save with the takeoff."}
                      </div>
                      <button type="button" onClick={() => setSymbolFocus(null)}
                        style={{ width: "100%", padding: "7px 10px", border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "var(--f-body)" }}>
                        Done
                      </button>
                    </div>
                  )}
                  {!pinned && sym.kind === "detail" && !detailLinks.length && !hasSource && (
                    <div style={{ fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.45, marginTop: 2 }}>
                      No matching detail sheet in project — upload the {sym.tag} PDF from Files.
                    </div>
                  )}
                  {!pinned && sym.kind !== "detail" && !hasSource && !fields.description && !fields.room_name && (
                    <div style={{ fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.45, marginTop: 2 }}>
                      No schedule match yet — click to enter details, or upload the door/finish schedule PDFs.
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
          {symbolSourceView && (
            <SymbolSourceViewer
              sheetId={symbolSourceView.sheetId}
              title={`${symbolSourceView.tag || ""} · ${symbolSourceView.title || ""}`.replace(/^ · /, "")}
              bbox={symbolSourceView.bbox}
              spaceBbox={symbolSourceView.spaceBbox}
              markBbox={symbolSourceView.markBbox}
              room={symbolSourceView.room}
              tag={symbolSourceView.tag}
              sheetFloor={symbolSourceView.sheetFloor}
              scheduleKb={scheduleKb}
              getDoc={docFor}
              onClose={() => setSymbolSourceView(null)}
            />
          )}
          {/* inline on-canvas text editor — a screen-space overlay pinned to its anchor
              (pan/zoom is frozen while open). Enter commits, Esc cancels, blur commits;
              all on the input's OWN handlers so the global keydown (which returns early
              for INPUT) never interferes. cursor:text overrides the stage's cursor:none. */}
          {editor && (
            <input name="inline-editor" autoComplete="off" ref={editorInputRef} autoFocus defaultValue={editor.value}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finishEditor(true); } else if (e.key === "Escape") { e.preventDefault(); finishEditor(false); } }}
              onBlur={() => finishEditor(true)}
              placeholder="Type, Enter to place · Esc cancels"
              style={{ position: "absolute", left: editor.left, top: editor.top, zIndex: 9, minWidth: 160, padding: "3px 6px", font: "13px var(--f-body, sans-serif)", color: "var(--ink)", background: "var(--paper-bright)", border: "1px solid var(--cobalt)", boxShadow: "0 2px 10px rgba(0,0,0,.18)", borderRadius: 0, cursor: "text", outline: "none" }} />
          )}
          <div ref={stageRef} style={{ position: "absolute", transformOrigin: "0 0", width: stage.w || undefined, height: stage.h || undefined, opacity: status === "ready" ? 1 : 0, pointerEvents: status === "ready" ? "auto" : "none" }}>
            {panels.map((p) => (
              <canvas key={p.key} ref={(el) => { if (el) { panelCanvasRefs.current.set(p.key, el); blitPanelPaint(p.key, el); } else panelCanvasRefs.current.delete(p.key); }}
                style={{ position: "absolute", left: p.xOffset, top: 0, boxShadow: status === "ready" ? "0 2px 20px rgba(0,0,0,.18)" : "none" }} />
            ))}
            {/* high-res detail overlay — a crop of the visible region re-rendered at the current zoom (see the detail-view effect) */}
            <canvas ref={detailCanvasRef} style={{ position: "absolute", left: 0, top: 0, display: "none", pointerEvents: "none" }} />
            {viewPrefs.grid && <div className="canvas-view-grid" aria-hidden="true" />}
            <svg width={stage.w} height={stage.h} viewBox={`0 0 ${stage.w} ${stage.h}`} style={{ position: "absolute", top: 0, left: 0, zIndex: 2, overflow: "visible", pointerEvents: "none" }}>
              <defs>
                {conditions.map((c) => <HatchPattern key={patId(c)} id={patId(c)} type={c.hatch || "solid"} line={c.color} fill={c.fill} dark={darkMode} />)}
                {shapes.filter((s) => s.appearance_override).map((s) => {
                  const base = condById[s.condition_id];
                  const look = resolveShapeLook(s, base);
                  if (!look) return null;
                  return <HatchPattern key={`ov-${s.id}-${patId(look)}`} id={patId(look)} type={look.hatch || "solid"} line={look.color} fill={look.fill} dark={darkMode} />;
                })}
                {liveDrawLook && drawAppearance ? (
                  <HatchPattern key={`draw-${patId(liveDrawLook)}`} id={patId(liveDrawLook)} type={liveDrawLook.hatch || "solid"} line={liveDrawLook.color} fill={liveDrawLook.fill} dark={darkMode} />
                ) : null}
              </defs>
              {/* committed shapes + markups, one group per panel in its local frame */}
              {panels.map((p) => {
                const pShapes = visibleShapes.filter((s) => s.sheet_id === p.key || aiFloorSheetKeysMatch(s.sheet_id, p.key));
                const dn = (vn) => vn.map(([x, y]) => [x * p.img.w, y * p.img.h]);
                const label = labelFor(p);
                return (
                  <g key={p.key} transform={`translate(${p.xOffset},0)`}>
                    {panels.length > 1 && <text x={0} y={-26} fontSize={64} fontWeight={700} fill={darkMode ? "#9a917f" : "#6b6256"}>{label}</text>}
                    {/* Plan symbols — door/window/type/finish marks from the PDF text layer */}
                    {planSymbols.filter((s) => s.sheet_id === p.key).map((s) => {
                      const z = tf.scale;
                      const on = s.id === symbolFocus || s.id === symbolHover?.id;
                      const sw = (on ? 1.6 : 1.1) / z;
                      const col = on ? "#1f3fc7" : "rgba(31,63,199,.45)";
                      const shape = s.outline || (s.kind === "door" || s.kind === "window" || s.kind === "detail" ? "circle" : "rect");
                      if (shape === "circle") {
                        return <circle key={s.id} cx={s.x} cy={s.y} r={Math.max(s.w, s.h) / 2}
                          fill={on ? "rgba(31,63,199,.10)" : "transparent"} stroke={col} strokeWidth={sw} strokeDasharray={`${3 / z} ${2 / z}`} />;
                      }
                      return <rect key={s.id} x={s.x - s.w / 2} y={s.y - s.h / 2} width={s.w} height={s.h}
                        fill={on ? "rgba(31,63,199,.10)" : "transparent"} stroke={col} strokeWidth={sw} strokeDasharray={`${3 / z} ${2 / z}`} />;
                    })}
                    {(() => {
                      const aiSheet = isAiDetectFloorPlan(p.key);
                      // Cutouts always paint; AI floor masks follow reveal. Deducts on top.
                      const drawn = (!aiSheet ? pShapes : pShapes.filter((s) => aiDetectShapeRevealed(s)))
                        .filter((s) => !isHiddenId(s.id, { hiddenShapeIds, sheetId: s.sheet_id }))
                        .slice()
                        .sort((a, b) => {
                          const ad = a.measure_role === "deduct" ? 1 : 0;
                          const bd = b.measure_role === "deduct" ? 1 : 0;
                          return ad - bd;
                        });
                      return drawn;
                    })().map((s) => {
                      const cond = condById[s.condition_id];
                      const look = resolveShapeLook(s, cond) || cond;
                      const sel = selectedLayerGroupMemberIds.has(s.id) || selectedCutoutIds.has(s.id);
                      // Selection focus: selected keeps its color; others go grey.
                      // Nothing selected → every mask keeps its normal color.
                      const dim = !!(selectedId || selectedCutoutIds.size) && !sel;
                      const col = dim ? "#9aa0a6" : (look?.color || "#888");
                      const pts = dn(s.verts_norm);
                      // Screen-constant strokes: zoom is a CSS transform on the
                      // stage div, which never enters this SVG's CTM — so
                      // vector-effect can't help and raw widths go subpixel at
                      // overview zoom (invisible conditions). Divide by scale
                      // like every other screen-relative size here.
                      const z = tf.scale;
                      const lw = clampWeight(look?.weight);
                      const sw = ((sel ? 4 : 2) * lw) / z;
                      // Committed-but-unreviewed machine shapes (an imported MCP
                      // takeoff) render dashed pencil — same invariant as the
                      // ephemeral agent proposals, until Accept flips reviewed.
                      const pending = s.origin?.reviewed === false;
                      const pDash = `${4 / z} ${3 / z}`;
                      if (s.measure_role === "count") {
                        const [cx, cy] = pts[0], r = 7 / z;
                        return <rect key={s.id} x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={2 / z} fill={col + (pending ? "55" : "cc")} stroke={sel ? "#1f3fc7" : (dim ? "#9aa0a6" : "#fff")} strokeWidth={((sel ? 3 : 1.5) * lw) / z} strokeDasharray={pending ? `${3 / z} ${2.5 / z}` : undefined} />;
                      }
                      if (s.measure_role === "surface_area") {
                        const dash = pending ? pDash : `${10 / z} ${3 / z} ${2 / z} ${3 / z}`;
                        const isLoop = !!s.origin?.closed_loop;
                        const segFocus = sel && s.id === selectedId ? wallSegmentFocus : null;
                        const segCount = isLoop ? pts.length : pts.length - 1;
                        if (segFocus != null && segCount > 1) {
                          return (
                            <g key={s.id}>
                              {Array.from({ length: segCount }, (_, i) => {
                                const a = pts[i];
                                const b = isLoop && i === segCount - 1 ? pts[0] : pts[i + 1];
                                const isActive = i === segFocus;
                                return (
                                  <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} fill="none"
                                    stroke={isActive ? "#1f3fc7" : "#9aa0a6"}
                                    strokeOpacity={isActive ? (pending ? 0.85 : 1) : 0.45}
                                    strokeWidth={((isActive ? 4.5 : 3) * lw) / z}
                                    strokeDasharray={dash} strokeLinecap="round" />
                                );
                              })}
                            </g>
                          );
                        }
                        const polyPts = isLoop && pts.length >= 3 ? [...pts, pts[0]] : pts;
                        return <polyline key={s.id} points={polyPts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? "#1f3fc7" : col} strokeOpacity={pending ? 0.85 : undefined} strokeWidth={((sel ? 4.5 : 3.5) * lw) / z} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" />;
                      }
                      if (s.measure_role === "linear") {
                        // line_style governs linear outlines (surface_area keeps its dash-dot identity above)
                        const lpts = s.curved ? flattenCurve(pts) : pts;
                        return <polyline key={s.id} points={lpts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? "#1f3fc7" : col} strokeOpacity={pending ? 0.85 : undefined} strokeWidth={((sel ? 4 : 3) * lw) / z} strokeDasharray={pending ? pDash : dashArrayFor(look?.line_style || "solid", z)} strokeLinecap="round" strokeLinejoin="round" />;
                      }
                      const ded = s.measure_role === "deduct";
                      const fill = dim ? (col + (darkMode ? "4d" : "33")) : ded ? (pending ? "rgba(176,58,38,.10)" : "rgba(176,58,38,.28)") : pending ? col + "14" : shapeFill(look);
                      const stroke = dim ? col : ded ? "#b03a26" : (sel ? "#1f3fc7" : col);
                      const dash = pending ? pDash : ded ? `${6 / z} ${4 / z}` : dashArrayFor(look?.line_style || "solid", z);
                      const holes = s.holes_norm;
                      if (holes?.length) {
                        const outerD = `M ${pts.map((q) => q.join(",")).join(" L ")} Z`;
                        const holesD = holes.map((h) => {
                          const hp = dn(h);
                          return `M ${hp.map((q) => q.join(",")).join(" L ")} Z`;
                        }).join(" ");
                        return (
                          <path key={s.id} d={`${outerD} ${holesD}`} fillRule="evenodd"
                            fill={fill} stroke={stroke} strokeOpacity={pending ? 0.9 : undefined} strokeWidth={sw}
                            strokeDasharray={dash} />
                        );
                      }
                      return <polygon key={s.id} points={pts.map((q) => q.join(",")).join(" ")}
                        fill={fill} stroke={stroke} strokeOpacity={pending ? 0.9 : undefined} strokeWidth={sw}
                        strokeDasharray={dash} />;
                    })}
                    {/* vertex handles for the selected shape (drag to reshape) */}
                    {selectedId && !shapeIsLocked(selectedId) && (() => {
                      const sel = pShapes.find((s) => s.id === selectedId && aiDetectShapeRevealed(s));
                      if (!sel || sel.measure_role === "count") return null;
                      const qs = dn(sel.verts_norm);
                      const closed = sel.measure_role !== "linear" && sel.measure_role !== "surface_area";
                      const s = tf.scale;
                      const grip = darkMode ? "#0b0e14" : "#faf6ea";
                      const edges = closed ? qs.length : qs.length - 1;
                      return (
                        <g>
                          {/* edge grips — drag moves the whole line; Shift-click inserts a point */}
                          {Array.from({ length: edges }, (_, i) => {
                            const a = qs[i], b = qs[(i + 1) % qs.length];
                            const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
                            const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
                            const ew = 14 / s, eh = 6 / s;
                            return <rect key={"m" + i} x={mx - ew / 2} y={my - eh / 2} width={ew} height={eh} rx={eh / 2}
                              transform={`rotate(${ang} ${mx} ${my})`} fill={grip} stroke="#1f3fc7" strokeWidth={1.6 / s} />;
                          })}
                          {/* edge length label — shows the hovered segment's length */}
                          {hoverEdge && hoverEdge.shapeId === sel.id && (() => {
                            const _hI = hoverEdge.i, _hJ = (_hI + 1) % qs.length;
                            const _hA = qs[_hI], _hB = qs[_hJ];
                            const _ht = Number.isFinite(hoverEdge.t) ? hoverEdge.t : 0.5;
                            const _hMx = _hA[0] + (_hB[0] - _hA[0]) * _ht;
                            const _hMy = _hA[1] + (_hB[1] - _hA[1]) * _ht;
                            const _hLen = hoverEdge.length;
                            if (!_hLen) return null;
                            const _hLabel = `${lenVal(_hLen, units).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${lenUnit(units)}`;
                            const _hFs = 10.5 / s;
                            const _hPad = 3 / s;
                            const _hW = Math.max(50 / s, _hLabel.length * 6 / s);
                            return (
                              <g key="hover-edge-len" transform={`translate(${_hMx}, ${_hMy - 14 / s})`}>
                                <rect x={-_hW / 2} y={-_hFs - _hPad} width={_hW} height={_hFs + _hPad * 2} rx={3 / s}
                                  fill="var(--cobalt, #1f3fc7)" fillOpacity={0.92} />
                                <text x={0} y={-_hPad} textAnchor="middle" fontSize={_hFs} fontWeight={700}
                                  fontFamily="var(--f-mono, monospace)" fill="#fff">
                                  {_hLabel}
                                </text>
                              </g>
                            );
                          })()}
                          {/* corner handles — click selects (Delete removes just that point), drag moves */}
                          {qs.map(([x, y], i) => {
                            const isSel = selHole == null && selVert === i;
                            const sz = (isSel ? 6.5 : 5.5) / s;
                            return <g key={"h" + i}>
                              {isSel && <circle cx={x} cy={y} r={9 / s} fill="none" stroke="#1f3fc7" strokeWidth={1.2 / s} opacity={0.5} />}
                              <path d={`M${x},${y - sz} L${x + sz},${y} L${x},${y + sz} L${x - sz},${y} Z`}
                                fill={isSel ? grip : "#1f3fc7"} stroke={isSel ? "#1f3fc7" : "#fff"} strokeWidth={(isSel ? 2 : 1.4) / s} />
                            </g>;
                          })}
                          {/* trim-hole grips — interior removal polygons (amber), same edit model */}
                          {closed && (sel.holes_norm || []).map((hole, hi) => {
                            const hqs = dn(hole);
                            const holeCol = "#c47a10";
                            return (
                              <g key={`trim-${hi}`}>
                                {hqs.map((_, i) => {
                                  const a = hqs[i], b = hqs[(i + 1) % hqs.length];
                                  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
                                  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
                                  const ew = 12 / s, eh = 5 / s;
                                  return <rect key={`hm${hi}-${i}`} x={mx - ew / 2} y={my - eh / 2} width={ew} height={eh} rx={eh / 2}
                                    transform={`rotate(${ang} ${mx} ${my})`} fill={grip} stroke={holeCol} strokeWidth={1.4 / s} />;
                                })}
                                {hqs.map(([x, y], i) => {
                                  const isSel = selHole === hi && selVert === i;
                                  const sz = (isSel ? 6 : 5) / s;
                                  return <g key={`hh${hi}-${i}`}>
                                    {isSel && <circle cx={x} cy={y} r={8 / s} fill="none" stroke={holeCol} strokeWidth={1.2 / s} opacity={0.55} />}
                                    <path d={`M${x},${y - sz} L${x + sz},${y} L${x},${y + sz} L${x - sz},${y} Z`}
                                      fill={isSel ? grip : holeCol} stroke={isSel ? holeCol : "#fff"} strokeWidth={(isSel ? 2 : 1.3) / s} />
                                  </g>;
                                })}
                              </g>
                            );
                          })}
                        </g>
                      );
                    })()}
                    {/* Edge length label — renders for ANY hovered shape (selected or not) */}
                    {hoverEdge && (() => {
                      const _hShape = pShapes.find((_s) => _s.id === hoverEdge.shapeId);
                      if (!_hShape) return null;
                      // Skip if the selected-shape block already rendered this label
                      if (selectedId && hoverEdge.shapeId === selectedId) return null;
                      const _hQs = dn(_hShape.verts_norm);
                      const _hI = hoverEdge.i, _hJ = (_hI + 1) % _hQs.length;
                      if (_hI >= _hQs.length) return null;
                      const _hA = _hQs[_hI], _hB = _hQs[_hJ];
                      const _ht = Number.isFinite(hoverEdge.t) ? hoverEdge.t : 0.5;
                      const _hMx = _hA[0] + (_hB[0] - _hA[0]) * _ht;
                      const _hMy = _hA[1] + (_hB[1] - _hA[1]) * _ht;
                      const _s = tf.scale;
                      const _hLen = hoverEdge.length;
                      if (!_hLen) return null;
                      const _hLabel = `${lenVal(_hLen, units).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${lenUnit(units)}`;
                      const _hFs = 10.5 / _s;
                      const _hPad = 3 / _s;
                      const _hW = Math.max(50 / _s, _hLabel.length * 6 / _s);
                      return (
                        <g key="hover-edge-len-any" transform={`translate(${_hMx}, ${_hMy - 14 / _s})`}>
                          <rect x={-_hW / 2} y={-_hFs - _hPad} width={_hW} height={_hFs + _hPad * 2} rx={3 / _s}
                            fill="var(--cobalt, #1f3fc7)" fillOpacity={0.92} />
                          <text x={0} y={-_hPad} textAnchor="middle" fontSize={_hFs} fontWeight={700}
                            fontFamily="var(--f-mono, monospace)" fill="#fff">
                            {_hLabel}
                          </text>
                        </g>
                      );
                    })()}
                    {/* markup layer — highlights / clouds / callouts / text notes on this
                        panel. Highlights draw FIRST (behind) so their translucent fill never
                        dims the linework above. A selected markup wears a CONTRASTING halo
                        (white outer ring + cobalt inner). Per-markup color drives the STROKE/
                        FILL (dark-boosted on the dark canvas); RFI linkage is an unconditional
                        ⬢/number badge, independent of the note text. Layer hides via showMarkups. */}
                    {showMarkups && visibleMarkups.filter((m) => m.sheet_id === p.key)
                      .slice().sort((a, b) => (a.type === "highlight" ? 0 : 1) - (b.type === "highlight" ? 0 : 1))
                      .map((m) => {
                      const z = tf.scale;
                      const base = m.color || (m.rfi_id ? "#1f3fc7" : "#c47a10");
                      const mk = darkMode ? boostForDark(base) : base;   // literal — SVG attrs don't resolve CSS vars
                      const dash = dashArrayFor(m.line_style || "solid", z);
                      const w = clampWeight(m.weight);   // stroke-width multiplier over each element's base, default ×1
                      const selM = m.id === selectedMarkupId;
                      // linkage badge — unconditional for any linked markup (a note-less
                      // recolored cloud still reads as linked); kept in cobalt for legibility
                      // regardless of the user's color, pinned clear of the halo.
                      const linked = m.rfi_id ? rfis.find((r) => r.id === m.rfi_id) : null;
                      const badgeCol = darkMode ? boostForDark("#1f3fc7") : "#1f3fc7";
                      const badge = (bx, by) => (m.rfi_id ? (
                        <text x={bx} y={by} fill={badgeCol} fontSize={12 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{"⬢"}{linked && linked.number != null && linked.number !== "" ? " " + linked.number : ""}</text>
                      ) : null);
                      // revision-delta △n — a small numbered triangle at a cloud corner,
                      // clear of the halo, the top-left RFI badge, and the centered note.
                      // Absent/zero m.rev → nothing (legacy clouds render unchanged).
                      // the triangle backing is ALWAYS white, so stroke/number it in the
                      // UN-boosted color (mk's dark boost is tuned to contrast the dark
                      // canvas, and would wash out on white).
                      const revTri = (rx, ry) => (Number.isFinite(m.rev) && m.rev > 0 ? (
                        <g style={{ pointerEvents: "none" }}>
                          <path d={`M${rx},${ry - 9 / z} L${rx + 8 / z},${ry + 6 / z} L${rx - 8 / z},${ry + 6 / z} Z`} fill="#fff" stroke={base} strokeWidth={1.4 / z} />
                          <text x={rx} y={ry + 2.5 / z} fill={base} fontSize={9 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central">{m.rev}</text>
                        </g>
                      ) : null);
                      // halo ring widths scale with weight so a heavy stroke never overruns them
                      const halo = (x0, y0, x1, y1) => (selM ? (
                        <>
                          <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="none" stroke="#fff" strokeWidth={(5 * w) / z} />
                          <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="none" stroke="#1f3fc7" strokeWidth={(2 * w) / z} />
                        </>
                      ) : null);
                      if (m.type === "highlight" && Array.isArray(m.pts)) {
                        // freehand highlighter stroke — the ink keeps its OWN hue (a highlight
                        // IS its color; dark legibility comes from the higher opacity, not a
                        // boost). Weight (×) multiplies the stored width like every markup.
                        const ip = m.pts.map(([nx, ny]) => [nx * p.img.w, ny * p.img.h]);
                        if (ip.length < 2) return null;
                        const sw = (m.w || 0.01) * p.img.w * w, o = darkMode ? 0.42 : 0.32;
                        const ink = m.tip === "chisel"
                          ? <path d={"M" + chiselRibbon(ip, sw, 45).map((q) => q.join(",")).join(" L") + " Z"} fill={m.color || "#ffd60a"} fillOpacity={o} />
                          : <path d={strokePathD(ip)} fill="none" stroke={m.color || "#ffd60a"} strokeOpacity={o} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
                        return (
                          <g key={m.id}>
                            {/* selection halo follows the stroke's spine (white outer + cobalt
                                inner, the selected-markup convention adapted to an open path) */}
                            {selM && (
                              <>
                                <path d={strokePathD(ip)} fill="none" stroke="#fff" strokeWidth={sw + 8 / z} strokeLinecap="round" strokeLinejoin="round" />
                                <path d={strokePathD(ip)} fill="none" stroke="#1f3fc7" strokeOpacity={0.55} strokeWidth={sw + 4 / z} strokeLinecap="round" strokeLinejoin="round" />
                              </>
                            )}
                            {ink}
                            {badge(ip[0][0], ip[0][1] - 9 / z)}
                          </g>
                        );
                      }
                      if (m.type === "highlight") {
                        const [c0, c1] = m.rect;
                        const hx0 = Math.min(c0[0], c1[0]) * p.img.w, hy0 = Math.min(c0[1], c1[1]) * p.img.h;
                        const hx1 = Math.max(c0[0], c1[0]) * p.img.w, hy1 = Math.max(c0[1], c1[1]) * p.img.h;
                        const pad = (5 * w) / z;
                        return (
                          <g key={m.id}>
                            {halo(hx0 - pad, hy0 - pad, hx1 + pad, hy1 + pad)}
                            <rect x={hx0} y={hy0} width={hx1 - hx0} height={hy1 - hy0} fill={mk} fillOpacity={0.18} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
                            {m.text && <text x={(hx0 + hx1) / 2} y={(hy0 + hy1) / 2} fill={mk} fontSize={13 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
                            {badge(hx0, hy0 - pad - 9 / z)}
                          </g>
                        );
                      }
                      if (m.type === "cloud") {
                        const [c0, c1] = m.rect;
                        const pad = (5 * w) / z;
                        const bx0 = Math.min(c0[0], c1[0]) * p.img.w - pad, by0 = Math.min(c0[1], c1[1]) * p.img.h - pad;
                        const bx1 = Math.max(c0[0], c1[0]) * p.img.w + pad, by1 = Math.max(c0[1], c1[1]) * p.img.h + pad;
                        return (
                          <g key={m.id}>
                            {halo(bx0, by0, bx1, by1)}
                            <path d={cloudPath(c0[0] * p.img.w, c0[1] * p.img.h, c1[0] * p.img.w, c1[1] * p.img.h)} fill="none" stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
                            {m.text && <text x={(c0[0] + c1[0]) / 2 * p.img.w} y={(c0[1] + c1[1]) / 2 * p.img.h} fill={mk} fontSize={13 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
                            {badge(bx0, by0 - 9 / z)}
                            {revTri(bx1, by0 - 9 / z)}
                          </g>
                        );
                      }
                      if (m.type === "callout") {
                        const [tx, ty] = m.target, [ax, ay] = m.at;
                        const lw = ((m.text?.length || 1) * 7 + 10) / z;
                        return (
                          <g key={m.id}>
                            {halo(ax * p.img.w - 4 / z, ay * p.img.h - 18 / z, ax * p.img.w + lw + 4 / z, ay * p.img.h + 4 / z)}
                            <line x1={tx * p.img.w} y1={ty * p.img.h} x2={ax * p.img.w} y2={ay * p.img.h} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
                            {/* arrowhead at the target end — replaces the old vertex star */}
                            <path d={arrowheadPath(ax * p.img.w, ay * p.img.h, tx * p.img.w, ty * p.img.h, 9 / z)} fill={mk} />
                            <rect x={ax * p.img.w} y={ay * p.img.h - 16 / z} width={lw} height={20 / z} fill="rgba(255,255,255,.92)" stroke={mk} strokeWidth={(1 * w) / z} strokeDasharray={dash} rx={3 / z} />
                            <text x={(ax * p.img.w) + 5 / z} y={(ay * p.img.h) - 2 / z} fill="#0e1a2e" fontSize={12 / z}>{m.text}</text>
                            {badge(ax * p.img.w, ay * p.img.h - 24 / z)}
                          </g>
                        );
                      }
                      if (m.type === "arrow") {
                        const [fx, fy] = [m.from[0] * p.img.w, m.from[1] * p.img.h];
                        const [tx, ty] = [m.to[0] * p.img.w, m.to[1] * p.img.h];
                        const midx = (fx + tx) / 2, midy = (fy + ty) / 2;
                        const hx0 = Math.min(fx, tx), hy0 = Math.min(fy, ty), hx1 = Math.max(fx, tx), hy1 = Math.max(fy, ty);
                        const pad = (6 * w) / z;
                        return (
                          <g key={m.id}>
                            {halo(hx0 - pad, hy0 - pad, hx1 + pad, hy1 + pad)}
                            <line x1={fx} y1={fy} x2={tx} y2={ty} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} strokeLinecap="round" />
                            {/* filled arrowhead at the `to` end */}
                            <path d={arrowheadPath(fx, fy, tx, ty, 11 / z)} fill={mk} />
                            {m.text && <text x={midx} y={midy - 6 / z} fill={mk} fontSize={12 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
                            {badge(hx0, hy0 - pad - 9 / z)}
                          </g>
                        );
                      }
                      if (m.type === "bubble") {
                        const cx = m.at[0] * p.img.w, cy = m.at[1] * p.img.h;
                        const rad = (Number(m.r) > 0 ? Number(m.r) : 0.02) * p.img.w;
                        const pad = (5 * w) / z;
                        return (
                          <g key={m.id}>
                            {halo(cx - rad - pad, cy - rad - pad, cx + rad + pad, cy + rad + pad)}
                            <circle cx={cx} cy={cy} r={rad} fill={darkMode ? "rgba(12,15,20,.85)" : "rgba(255,255,255,.85)"} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
                            {m.text && <text x={cx} y={cy} fill={mk} fontSize={Math.min(13, rad * z * 0.9) / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
                            {badge(cx + rad, cy - rad - 4 / z)}
                          </g>
                        );
                      }
                      if (m.type === "svg" && m.path && Array.isArray(m.vb)) {
                        // a vector symbol (imported .svg or saved-as-stamp art). The
                        // path is baked local→image px through a uniform scale off the
                        // LONGER viewBox extent so it never distorts and a one-axis
                        // symbol can't blow up; stroke/fill are the symbol's OWN color
                        // (dark-boosted), not the linkage tint.
                        const { s: sx, bw, bh } = svgPlacedBox(m.vb, m.w, p.img.w);
                        if (!(sx > 0)) return null;
                        const x0 = m.at[0] * p.img.w - bw / 2, y0 = m.at[1] * p.img.h - bh / 2;
                        const d = transformPath(m.path, (lx, ly) => [x0 + lx * sx, y0 + ly * sx]);
                        const fillOn = m.fill && m.fill !== "none";
                        const fcol = fillOn ? (darkMode ? boostForDark(m.fill) : m.fill) : "none";
                        return (
                          <g key={m.id}>
                            {halo(x0, y0, x0 + bw, y0 + bh)}
                            <path d={d} fill={fcol} fillOpacity={fillOn ? 0.9 : undefined} stroke={mk} strokeWidth={(1.6 * w) / z} strokeLinejoin="round" style={{ pointerEvents: "none" }} />
                            {badge(x0, y0 - 9 / z)}
                          </g>
                        );
                      }
                      const [x, y] = m.at;
                      const lw = ((m.text?.length || 1) * 7 + 10) / z;
                      return (
                        <g key={m.id}>
                          {halo(x * p.img.w - 5 / z, y * p.img.h - 16 / z, x * p.img.w + lw + 3 / z, y * p.img.h + 6 / z)}
                          <rect x={x * p.img.w - 3 / z} y={y * p.img.h - 14 / z} width={lw} height={20 / z} fill="rgba(255,247,237,.92)" stroke={mk} strokeWidth={(1 * w) / z} strokeDasharray={dash} rx={3 / z} />
                          <text x={x * p.img.w + 2 / z} y={y * p.img.h} fill="#0e1a2e" fontSize={12 / z} fontWeight="600">{m.text}</text>
                          {badge(x * p.img.w, y * p.img.h - 22 / z)}
                        </g>
                      );
                    })}
                    {/* zone check — transparent dashed region + a cobalt trace on every counted shape */}
                    {zoneCheck && zoneCheck.key === p.key && (
                      <g style={{ pointerEvents: "none" }}>
                        <polygon points={zoneCheck.pts.map(([nx, ny]) => `${nx * p.img.w},${ny * p.img.h}`).join(" ")}
                          fill="rgba(31,63,199,.06)" stroke="#1f3fc7" strokeWidth={2 / tf.scale}
                          strokeDasharray={`${7 / tf.scale} ${5 / tf.scale}`} />
                        {zoneIds && pShapes.filter((sh) => zoneIds.has(sh.id)).map((sh) => {
                          const vs = sh.verts_norm || [];
                          if (vs.length < 2) {
                            return <circle key={"zc" + sh.id} cx={(vs[0]?.[0] || 0) * p.img.w} cy={(vs[0]?.[1] || 0) * p.img.h}
                              r={7 / tf.scale} fill="none" stroke="#1f3fc7" strokeOpacity={0.45} strokeWidth={2.5 / tf.scale} />;
                          }
                          // Closed roles (floor_area/deduct) get a <polygon> like the
                          // main shape renderer — a <polyline> never draws the
                          // closing edge back to the first vertex, so a 4-vertex
                          // room's glow was missing 25% of its outline. linear/
                          // surface_area are genuinely open runs, so they keep
                          // <polyline>, also matching the main renderer.
                          const closed = sh.measure_role !== "linear" && sh.measure_role !== "surface_area";
                          const pts = vs.map(([nx, ny]) => `${nx * p.img.w},${ny * p.img.h}`).join(" ");
                          return closed
                            ? <polygon key={"zc" + sh.id} points={pts} fill="none" stroke="#1f3fc7" strokeOpacity={0.45} strokeWidth={3.5 / tf.scale} strokeLinejoin="round" />
                            : <polyline key={"zc" + sh.id} points={pts} fill="none" stroke="#1f3fc7" strokeOpacity={0.45} strokeWidth={3.5 / tf.scale} strokeLinejoin="round" />;
                        })}
                      </g>
                    )}
                    {/* One-Click proposal preview — dashed cobalt selection, red dashed carve.
                        Handles (corner diamonds + edge grips) rise on the hovered/selected
                        region: drag a corner, drag an edge to move the whole line, Shift-click
                        an edge to add a point, select a corner + Delete to remove it. */}
                    {proposal && proposal.key === p.key && proposal.regions.map((r, i) => {
                      const col = r.kind === "neg" ? "#b03a26" : "#1f3fc7";
                      const s = tf.scale;
                      const grip = darkMode ? "#0b0e14" : "#faf6ea";
                      const show = i === ocHover || (ocSel && ocSel.ri === i);
                      return (
                      <g key={"oc" + i}>
                        <polygon points={r.poly.map((q) => q.join(",")).join(" ")}
                          fill={r.kind === "neg" ? "rgba(176,58,38,.18)" : "rgba(31,63,199,.10)"}
                          stroke={col} strokeWidth={2.5 / s} strokeDasharray={`${7 / s} ${4 / s}`} />
                        <path d={starPath(r.seed[0], r.seed[1], 5 / s)} fill={col} stroke="#fff" strokeWidth={1 / s} />
                        {show && r.poly.map((a, k) => {
                          const b = r.poly[(k + 1) % r.poly.length];
                          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
                          const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
                          const w = 14 / s, h = 6 / s;
                          return <rect key={"e" + k} x={mx - w / 2} y={my - h / 2} width={w} height={h} rx={h / 2}
                            transform={`rotate(${ang} ${mx} ${my})`} fill={grip} stroke={col} strokeWidth={1.6 / s} />;
                        })}
                        {show && r.poly.map(([x, y], k) => {
                          const isSel = ocSel && ocSel.ri === i && ocSel.vi === k;
                          const sz = (isSel ? 6.5 : 5.5) / s;
                          return <g key={"v" + k}>
                            {isSel && <circle cx={x} cy={y} r={9 / s} fill="none" stroke={col} strokeWidth={1.2 / s} opacity={0.5} />}
                            <path d={`M${x},${y - sz} L${x + sz},${y} L${x},${y + sz} L${x - sz},${y} Z`}
                              fill={isSel ? grip : col} stroke={isSel ? col : "#fff"} strokeWidth={(isSel ? 2 : 1.4) / s} />
                          </g>;
                        })}
                      </g>
                      );
                    })}
                    {/* Wall Trace proposal — wall ink network with room holes */}
                    {wallProposal && wallProposal.key === p.key && wallProposal.regions.map((r, i) => {
                      const col = "#1f3fc7";
                      const s = tf.scale;
                      const outerD = `M ${r.outer.map((q) => q.join(",")).join(" L ")} Z`;
                      const holesD = (r.holes || []).map((h) => `M ${h.map((q) => q.join(",")).join(" L ")} Z`).join(" ");
                      return (
                        <g key={"wt" + i}>
                          <path d={`${outerD} ${holesD}`} fillRule="evenodd"
                            fill="rgba(31,63,199,.14)" stroke={col} strokeWidth={2.5 / s} strokeDasharray={`${7 / s} ${4 / s}`} />
                          <path d={starPath(r.seed[0], r.seed[1], 5 / s)} fill={col} stroke="#fff" strokeWidth={1 / s} />
                        </g>
                      );
                    })}
                    {/* Agent proposals — DASHED pencil pending the accept gate. A
                        finer dash than one-click's selection so the two proposal
                        kinds read apart; the seed star marks the flood seed. The
                        native SVG <title> is the evidence tooltip. Click-to-accept
                        only under the non-drawing tools (select/pan) so a live
                        trace over a proposal is never swallowed; the panel rows
                        and ⏎ accept regardless of tool. */}
                    {agentProposals.filter((ap) => ap.sheet_id === p.key).map((ap) => {
                      const s = tf.scale;
                      const pts = ap.verts_norm.map(([x, y]) => [x * p.img.w, y * p.img.h]);
                      const ded = ap.measure_role === "deduct";
                      const col = ded ? "#b03a26" : "#1f3fc7";
                      const clickable = tool === "select" || tool === "pan";
                      const ev = ap.evidence || {};
                      const evBits = [
                        ev.schedule_row_tag ? `schedule ${ev.schedule_row_tag}` : "",
                        ev.matched_text && ev.matched_text !== ev.schedule_row_tag ? `matched "${ev.matched_text}"` : "",
                        Array.isArray(ev.seed_norm) ? "seeded by one-click" : "",
                      ].filter(Boolean).join(", ");
                      return (
                        <g key={ap.id} style={{ pointerEvents: clickable ? "auto" : "none", cursor: clickable ? "pointer" : undefined }}
                          onPointerDown={(e) => { if (clickable) e.stopPropagation(); }}
                          onClick={(e) => { if (clickable) { e.stopPropagation(); acceptAgentProposal(ap.id); } }}>
                          <title>{`Agent proposal — ${condById[ap.condition_id]?.finish_tag || "?"}${ded ? " (deduct)" : ""}, ${fa(ap.area_sf)}. ${evBits ? `Evidence: ${evBits}. ` : ""}Click to accept (⏎ accepts all visible); reject from the Agent panel.`}</title>
                          <polygon points={pts.map((q) => q.join(",")).join(" ")}
                            fill={ded ? "rgba(176,58,38,.10)" : "rgba(31,63,199,.07)"}
                            stroke={col} strokeOpacity={0.9} strokeWidth={2 / s}
                            strokeDasharray={`${3.5 / s} ${3.5 / s}`} strokeLinejoin="round" />
                          {Array.isArray(ap.seed_norm) && (
                            <path d={starPath(ap.seed_norm[0] * p.img.w, ap.seed_norm[1] * p.img.h, 4.5 / s)}
                              fill={col} fillOpacity={0.85} stroke="#fff" strokeWidth={1 / s} />
                          )}
                        </g>
                      );
                    })}
                  </g>
                );
              })}
              {/* IN-PROGRESS work draws in the INSTRUMENT color — the house cobalt pencil
                  (deduct keeps its danger red). Committed shapes wear the condition's own
                  color; the draft never mimics anyone's takeoff look. Solid, no dashes. */}
              <line ref={rubberRef} stroke={tool === "deduct" || tool === "deduct-curve" ? "#b03a26" : "#1f3fc7"} strokeWidth={1.5 / tf.scale} strokeOpacity={0.85} strokeLinecap="round" style={{ display: "none" }} />
              {wallCutoutDraft?.a && (
                <path d={starPath(wallCutoutDraft.a[0], wallCutoutDraft.a[1], 4.5 / tf.scale)} fill="#fff" stroke="#1f3fc7" strokeWidth={2 / tf.scale} />
              )}
              {wallCutoutFocus?.a && wallCutoutFocus?.b && (
                <g pointerEvents="none">
                  <line
                    x1={wallCutoutFocus.a[0]} y1={wallCutoutFocus.a[1]}
                    x2={wallCutoutFocus.b[0]} y2={wallCutoutFocus.b[1]}
                    stroke="#1f3fc7" strokeWidth={6 / tf.scale} strokeOpacity={0.35} strokeLinecap="round"
                  />
                  <line
                    x1={wallCutoutFocus.a[0]} y1={wallCutoutFocus.a[1]}
                    x2={wallCutoutFocus.b[0]} y2={wallCutoutFocus.b[1]}
                    stroke="#1f3fc7" strokeWidth={2.5 / tf.scale} strokeLinecap="round"
                  />
                  <path d={starPath(wallCutoutFocus.a[0], wallCutoutFocus.a[1], 5 / tf.scale)} fill="#1f3fc7" stroke="#fff" strokeWidth={1.2 / tf.scale} />
                  <path d={starPath(wallCutoutFocus.b[0], wallCutoutFocus.b[1], 5 / tf.scale)} fill="#1f3fc7" stroke="#fff" strokeWidth={1.2 / tf.scale} />
                  <path d={starPath((wallCutoutFocus.a[0] + wallCutoutFocus.b[0]) / 2, (wallCutoutFocus.a[1] + wallCutoutFocus.b[1]) / 2, 6 / tf.scale)} fill="#fff" stroke="#1f3fc7" strokeWidth={2 / tf.scale} />
                </g>
              )}
              <rect ref={rectRef} fill={tool === "deduct" ? "rgba(176,58,38,.22)" : shapeFill(liveDrawLook)} stroke={tool === "deduct" ? "#b03a26" : "#1f3fc7"} strokeWidth={2 / tf.scale} style={{ display: "none" }} />
              <path ref={cloudRef} fill="rgba(37,99,235,.06)" stroke="#1f3fc7" strokeWidth={2 / tf.scale} strokeDasharray={`${5 / tf.scale} ${4 / tf.scale}`} style={{ display: "none" }} />
              <rect ref={highlightRef} fill="rgba(196,122,16,.18)" stroke="#c47a10" strokeWidth={2 / tf.scale} style={{ display: "none" }} />
              <path ref={hlPathRef} style={{ display: "none" }} />
              {poly.length >= 2 && (tool === "linear" || tool === "curve" || tool === "deduct-curve" || tool === "surface" || tool === "wallarea"
                ? <polyline points={(tool === "curve" || tool === "deduct-curve" ? flattenCurve(poly) : poly).map((p) => p.join(",")).join(" ")} fill="none" stroke={tool === "deduct-curve" ? "#b03a26" : ((tool === "surface" || tool === "wallarea") ? (liveDrawLook?.color || activeColor) : "#1f3fc7")} strokeWidth={(((tool === "surface" || tool === "wallarea") ? 3.5 : 2.5) * clampWeight(liveDrawLook?.weight)) / tf.scale} strokeDasharray={(tool === "surface" || tool === "wallarea") ? `${10 / tf.scale} ${3 / tf.scale} ${2 / tf.scale} ${3 / tf.scale}` : undefined} strokeLinecap="round" strokeLinejoin="round" />
                : <polygon points={poly.map((p) => p.join(",")).join(" ")} fill={poly.length >= 3 ? (tool === "deduct" ? "rgba(176,58,38,.22)" : tool === "zone" ? "rgba(31,63,199,.06)" : shapeFill(liveDrawLook)) : "none"} stroke={tool === "deduct" ? "#b03a26" : "#1f3fc7"} strokeWidth={(2 * clampWeight(liveDrawLook?.weight)) / tf.scale} strokeDasharray={tool === "zone" ? `${7 / tf.scale} ${5 / tf.scale}` : undefined} />)}
              {/* bold the most recent segment so you see where you just clicked */}
              {poly.length >= 2 && (
                <line x1={poly[poly.length - 2][0]} y1={poly[poly.length - 2][1]} x2={poly[poly.length - 1][0]} y2={poly[poly.length - 1][1]}
                  stroke={tool === "deduct" || tool === "deduct-curve" ? "#b03a26" : ((tool === "surface" || tool === "wallarea") ? (liveDrawLook?.color || "#1f3fc7") : "#1f3fc7")} strokeWidth={(3.5 * clampWeight(liveDrawLook?.weight)) / tf.scale} strokeLinecap="round" />
              )}
              {poly.map((p, i) => {
                const isLast = i === poly.length - 1;
                return <path key={i} d={starPath(p[0], p[1], (isLast ? 4.5 : 3) / tf.scale)}
                  fill={isLast ? "#fff" : "#1f3fc7"} stroke="#1f3fc7" strokeWidth={(isLast ? 2 : 1) / tf.scale} />;
              })}
              {calib.length === 2 && <line x1={calib[0][0]} y1={calib[0][1]} x2={calib[1][0]} y2={calib[1][1]} stroke="#1f3fc7" strokeWidth={2 / tf.scale} />}
              {calib.map((p, i) => <path key={i} d={starPath(p[0], p[1], 3.5 / tf.scale)} fill="#1f3fc7" />)}
              {/* check tool — dashed so it never reads as calibrate's solid line */}
              {tool === "check" && check.length === 2 && !checkCross && (
                <>
                  <line x1={check[0][0]} y1={check[0][1]} x2={check[1][0]} y2={check[1][1]} stroke="#1f3fc7" strokeWidth={2 / tf.scale} strokeDasharray={`${6 / tf.scale} ${4 / tf.scale}`} />
                  {checkFeet != null && (
                    <text x={(check[0][0] + check[1][0]) / 2} y={(check[0][1] + check[1][1]) / 2 - 8 / tf.scale}
                      fontSize={12.5 / tf.scale} fontWeight={700} fill="#1f3fc7" textAnchor="middle"
                      stroke="#fff" strokeWidth={3 / tf.scale} paintOrder="stroke">{fmtCheckLen(checkFeet, units)}</text>
                  )}
                </>
              )}
              {tool === "check" && check.map((p, i) => <path key={"ck" + i} d={starPath(p[0], p[1], 3.5 / tf.scale)} fill="#1f3fc7" />)}
              {/* snap-to-vector indicator (star) */}
              <path ref={snapMarkRef} fill="#1f6b4a" stroke="#fff" strokeWidth={1 / tf.scale} style={{ display: "none" }} />
              {/* markup draft marker (first click of cloud/callout) */}
              {markupDraft && <path d={starPath(markupDraft[0], markupDraft[1], 5 / tf.scale)} fill="#1f3fc7" />}
              {/* marquee box selection */}
              {selectMarquee && (
                <rect
                  x={Math.min(selectMarquee.x0, selectMarquee.x1)}
                  y={Math.min(selectMarquee.y0, selectMarquee.y1)}
                  width={Math.abs(selectMarquee.x1 - selectMarquee.x0)}
                  height={Math.abs(selectMarquee.y1 - selectMarquee.y0)}
                  fill="rgba(31, 63, 199, 0.12)"
                  stroke="#1f3fc7"
                  strokeWidth={1.5 / tf.scale}
                  strokeDasharray={`${5 / tf.scale} ${3 / tf.scale}`}
                />
              )}
            </svg>
          </div>

          {status !== "ready" && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, pointerEvents: "none" }}>
              {(status === "loading" || status === "rendering" || status === "empty") ? (
                <div className="canvas-loading-mark" aria-busy="true" aria-label={status === "empty" ? "ADICC" : status === "loading" ? "Reading the sheet" : "Rendering the sheet"}>
                  <AdiccLoadingLogo />
                  {status !== "empty" && (
                    <>
                      <span className="canvas-loading-rule" aria-hidden="true" />
                      <div className="canvas-loading-caption">{status === "loading" ? "Reading the sheet" : "Rendering the sheet"}</div>
                    </>
                  )}
                </div>
              ) : (
                <div style={{ color: "var(--ink-muted)", fontSize: 15, textAlign: "center" }}>
                  {status === "error" && <span style={{ color: "var(--c-danger)" }}>Error: {err}</span>}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Cutout checklist — per open PDF/sheet; click flies to that cutout. */}
        {(() => {
          const sheetKeys = new Set(sheetGroup.length ? sheetGroup : (sheetKey ? [sheetKey] : []));
          const cutouts = shapes.filter((s) => s.measure_role === "deduct" && sheetKeys.has(s.sheet_id));
          if (!cutouts.length) return null;
          const checkedIds = cutouts.filter((s) => cutoutChecks[s.id]).map((s) => s.id);
          const fa = (n) => `${(Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} SF`;
          const pdfLabel = (() => {
            const k = sheetGroup.length
              ? ((focusKey && sheetGroup.includes(focusKey)) ? focusKey : sheetGroup[0])
              : sheetKey;
            return k ? (parseSheetKey(k).file || k).replace(/^.*[/\\]/, "") : "sheet";
          })();
          const left = cutoutPanelPos?.left;
          const top = cutoutPanelPos?.top;
          const pw = cutoutPanelSize?.w || 240;
          const ph = cutoutPanelSize?.h || 280;
          return (
            <div
              data-hover-scroll
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                ...(cutoutPanelPos
                  ? { left, top }
                  : { right: 56, bottom: 14 }),
                zIndex: 10, width: pw, height: ph,
                display: "flex", flexDirection: "column",
                overflow: "hidden", overscrollBehavior: "contain",
                background: "var(--paper-bright)", border: "1px solid var(--ink-faint)",
                boxShadow: "0 6px 18px rgba(14,26,46,.14)", fontSize: 12, color: "var(--ink)",
              }}
            >
              <div
                title="Drag to move"
                style={{ padding: "8px 10px", borderBottom: "1px solid var(--ink-faint)", cursor: "grab", userSelect: "none", flexShrink: 0 }}
                onPointerDown={(e) => {
                  if (e.button !== 0 || e.target.closest("button, input, a")) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const host = e.currentTarget.parentElement;
                  const parent = host?.offsetParent || containerRef.current;
                  const pr = parent?.getBoundingClientRect();
                  const hr = host?.getBoundingClientRect();
                  if (!pr || !hr) return;
                  const ox = e.clientX - hr.left;
                  const oy = e.clientY - hr.top;
                  const move = (ev) => {
                    const cw = parent.clientWidth || 1200;
                    const ch = parent.clientHeight || 800;
                    const nl = Math.max(8, Math.min(cw - pw - 8, ev.clientX - pr.left - ox));
                    const nt = Math.max(8, Math.min(ch - 80, ev.clientY - pr.top - oy));
                    setCutoutPanelPos({ left: nl, top: nt });
                  };
                  const up = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  };
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }}
              >
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--cobalt)" }}>
                  Cutouts · {cutouts.length}
                </div>
                <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pdfLabel}>{pdfLabel}</div>
              </div>
              <div style={{ padding: "6px 8px", display: "grid", gap: 4, alignContent: "start", justifyItems: "stretch", flex: 1, minHeight: 0, overflowY: "auto" }}>
                {cutouts.map((s, i) => {
                  const on = !!cutoutChecks[s.id] || selectedCutoutIds.has(s.id);
                  return (
                    <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", cursor: "pointer", background: selectedCutoutIds.has(s.id) ? "var(--paper-cream)" : "transparent" }}>
                      <input
                        type="checkbox"
                        checked={!!cutoutChecks[s.id]}
                        onChange={() => setCutoutChecks((m) => ({ ...m, [s.id]: !m[s.id] }))}
                      />
                      <span
                        role="button"
                        tabIndex={0}
                        title="Go to this cutout"
                        onClick={(e) => {
                          e.preventDefault();
                          if (e.shiftKey || e.metaKey || e.ctrlKey) {
                            setSelectedCutoutIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                              return next;
                            });
                            setSelectedId(s.id);
                          } else {
                            setSelectedCutoutIds(new Set([s.id]));
                            flyToShape(s.id);
                          }
                        }}
                        style={{ flex: 1, minWidth: 0, fontFamily: "var(--f-mono)", fontSize: 11.5, color: on ? "var(--ink)" : "var(--ink-muted)" }}
                      >
                        #{i + 1} · {fa(s.computed?.area_sf)}
                      </span>
                      <button
                        type="button"
                        title="Delete this cutout"
                        onClick={(e) => {
                          e.preventDefault();
                          dispatchShape({ type: "delete", ids: [s.id] });
                          setSelectedCutoutIds((prev) => { const n = new Set(prev); n.delete(s.id); return n; });
                          setCutoutChecks((m) => { const n = { ...m }; delete n[s.id]; return n; });
                          if (selectedId === s.id) setSelectedId(null);
                        }}
                        style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--c-danger)", fontSize: 14, lineHeight: 1, padding: 2 }}
                      >×</button>
                    </label>
                  );
                })}
              </div>
              <div style={{ padding: "8px", borderTop: "1px solid var(--ink-faint)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexShrink: 0 }}>
                <button
                  type="button"
                  disabled={!selectedCutoutIds.size}
                  onClick={() => applyCutoutsToParents([...selectedCutoutIds])}
                  style={{
                    flex: 1, padding: "6px 8px", border: "1px solid var(--ink-faint)",
                    background: "transparent", color: selectedCutoutIds.size ? "var(--ink)" : "var(--ink-muted)",
                    cursor: selectedCutoutIds.size ? "pointer" : "default", fontSize: 11, fontWeight: 600,
                  }}
                >
                  Apply selected
                </button>
                <button
                  type="button"
                  disabled={!checkedIds.length}
                  onClick={() => applyCutoutsToParents(checkedIds)}
                  title="Punch checked cutouts into the parent floor mask"
                  style={{
                    flex: 1, padding: "6px 8px", border: "1px solid var(--cobalt)",
                    background: checkedIds.length ? "var(--cobalt)" : "transparent",
                    color: checkedIds.length ? "var(--accent-contrast, #fff)" : "var(--ink-muted)",
                    cursor: checkedIds.length ? "pointer" : "default", fontWeight: 600, fontSize: 11,
                  }}
                >
                  Apply checked{checkedIds.length ? ` · ${checkedIds.length}` : ""}
                </button>
              </div>
              <div
                title="Drag to resize"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const host = e.currentTarget.parentElement;
                  const parent = host?.offsetParent || containerRef.current;
                  const hr = host?.getBoundingClientRect();
                  if (!hr) return;
                  const startW = hr.width, startH = hr.height, sx = e.clientX, sy = e.clientY;
                  // Pin bottom-right default into left/top so resize keeps the corner anchored.
                  if (!cutoutPanelPos && parent) {
                    const pr = parent.getBoundingClientRect();
                    setCutoutPanelPos({ left: hr.left - pr.left, top: hr.top - pr.top });
                  }
                  const move = (ev) => {
                    const cw = parent?.clientWidth || 1200;
                    const ch = parent?.clientHeight || 800;
                    const nw = Math.max(200, Math.min(480, startW + (ev.clientX - sx)));
                    const nh = Math.max(160, Math.min(ch - 24, startH + (ev.clientY - sy)));
                    setCutoutPanelSize({ w: Math.min(nw, cw - 16), h: nh });
                  };
                  const up = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  };
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }}
                style={{
                  position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize",
                  background: "linear-gradient(135deg, transparent 50%, var(--ink-faint) 50%)",
                }}
              />
            </div>
          );
        })()}

        {/* Right-click menu — cutout apply/remove, selection totals, duplicate, group, hide, delete */}
        {shapeCtxMenu && (() => {
          const hit = shapes.find((s) => s.id === shapeCtxMenu.shapeId);
          if (!hit) return null;
          const live = shapesRef.current;
          const curPicks = Object.keys(layerPickIds).filter((id) => live.some((s) => s.id === id));
          const isMulti = curPicks.includes(hit.id) && curPicks.length > 1;
          const targetIds = isMulti ? curPicks : [hit.id];
          const selShapes = shapes.filter((s) => targetIds.includes(s.id));
          const isCut = hit.measure_role === "deduct";

          const totFloor = selShapes.reduce((sum, s) => sum + (Number(s.computed?.area_sf) || (s.measure_role === "floor_area" ? Number(s.computed?.floor_sf) || 0 : 0)), 0);
          const totWall = selShapes.reduce((sum, s) => sum + (Number(s.computed?.gross_face_sf) || Number(s.computed?.wall_face_sf) || 0), 0);
          const totPerim = selShapes.reduce((sum, s) => sum + (Number(s.computed?.perimeter_lf) || 0), 0);
          const totLinear = selShapes.reduce((sum, s) => sum + (s.measure_role === "linear" ? Number(s.computed?.length_lf || s.computed?.perimeter_lf || 0) : 0), 0);
          const totCount = selShapes.reduce((sum, s) => sum + (s.measure_role === "count" ? Number(s.computed?.count || 1) : 0), 0);

          const aU = areaUnit(units);
          const lU = lenUnit(units);

          const item = (label, onClick, danger = false, shortcut = null) => (
            <button
              key={label}
              type="button"
              onClick={() => { onClick(); setShapeCtxMenu(null); }}
              style={{
                display: "flex", width: "100%", textAlign: "left", alignItems: "center", justifyContent: "space-between",
                padding: "6px 12px", border: "none", background: "transparent", cursor: "pointer",
                fontSize: 12, fontWeight: 600, color: danger ? "var(--c-danger)" : "var(--ink)",
                fontFamily: "var(--f-body)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--paper-cream)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <span>{label}</span>
              {shortcut && <span style={{ fontSize: 10, color: "var(--ink-muted)", fontFamily: "var(--f-mono)" }}>{shortcut}</span>}
            </button>
          );

          return (
            <div
              role="menu"
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                position: "absolute", left: shapeCtxMenu.x, top: shapeCtxMenu.y, zIndex: 20,
                minWidth: 200, background: "var(--paper-bright)", border: "1px solid var(--ink)",
                boxShadow: "var(--shadow-2)", padding: "0 0 4px", borderRadius: "var(--radius-sm)",
                overflow: "hidden",
              }}
            >
              {/* Totals Summary Card */}
              <div style={{ padding: "8px 12px 6px", background: "var(--paper-cream)", borderBottom: "1px solid var(--ink-faint)" }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--cobalt)", marginBottom: 4 }}>
                  {isMulti ? `Selection (${selShapes.length} shapes)` : (hit.room ? `${hit.room}` : `Shape · ${hit.measure_role}`)}
                </div>
                <div style={{ display: "grid", gap: 3, fontSize: 11, fontFamily: "var(--f-mono)", color: "var(--ink)" }}>
                  {totFloor > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span>Floor:</span><b>{num(areaVal(totFloor, units))} {aU}</b></div>}
                  {totWall > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span>Wall (gross):</span><b>{num(areaVal(totWall, units))} {aU}</b></div>}
                  {totPerim > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span>Perimeter:</span><b>{num(lenVal(totPerim, units))} {lU}</b></div>}
                  {totLinear > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span>Linear:</span><b>{num(lenVal(totLinear, units))} {lU}</b></div>}
                  {totCount > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span>Count:</span><b>{num(totCount, 0)} EA</b></div>}
                </div>
              </div>

              {/* Action items */}
              <div style={{ paddingTop: 4 }}>
                {isCut ? (
                  <>
                    {item("Apply cutout to parent", () => applyCutoutsToParents(
                      selectedCutoutIds.has(hit.id) && selectedCutoutIds.size ? [...selectedCutoutIds] : [hit.id],
                    ))}
                    {item("Remove cutout", () => {
                      const ids = (selectedCutoutIds.has(hit.id) && selectedCutoutIds.size > 1 ? [...selectedCutoutIds] : [hit.id])
                        .filter((id) => !shapeIsLocked(id));
                      if (!ids.length) return;
                      dispatchShape({ type: "delete", ids });
                      setSelectedCutoutIds(new Set());
                      setSelectedId(null);
                    }, true)}
                  </>
                ) : (
                  <>
                    {item("Open in BOQ", () => openBoqForShape(hit.id), false, "B")}
                    {item("Duplicate", duplicateSelected, false, "Ctrl+D")}
                    {isMulti && targetIds.length >= 2 && item("Subtract (Cut out void)", subtractSelectedShapes, false, "Shift+X")}
                    {isMulti && item("Group", groupLayerSelection, false, "Ctrl+G")}
                    {isMulti && item("Ungroup", ungroupLayerSelection, false, "Ctrl+Shift+U")}
                    {item(targetIds.some((id) => hiddenShapeIds[id]) ? "Show" : "Hide", () => toggleHideIds(targetIds), false)}
                    {item("Delete", deleteSelected, true, "Del")}
                  </>
                )}
              </div>
            </div>
          );
        })()}

        {/* Classic scale bar — bottom-center HUD; always visible while a sheet scale is set */}
        {status === "ready" && unitsPerPx && focusPanel?.img?.w && (() => {
          const uppBitmap = unitsPerPx / factorFor(focusPanel.key);
          const z = tf.scale;
          const CAND = units === "metric" ? [1, 2, 5, 10, 20, 50, 100].map((m) => m / M_PER_FT) : [2, 5, 10, 20, 50, 100, 200];
          const feet = CAND.find((f) => (f / uppBitmap) * z >= 160) ?? CAND[CAND.length - 1];
          const barPx = (feet / uppBitmap) * z;
          const nUnits = units === "metric" ? Math.round(feet * M_PER_FT) : feet;
          const unitPx = barPx / nUnits;
          const scaleLbl = stdValue || scaleDet?.label || (scaleSources[focusPanel.key] === "calibrated" ? "calibrated" : "custom");
          const scaleTxt = /[=:]/.test(scaleLbl) ? `at ${scaleLbl}` : `(${scaleLbl})`;
          const lbl = units === "metric" ? `${nUnits} m ${scaleTxt}` : `${feet}′ ${scaleTxt}`;
          const cap = units === "metric" ? "a door is about 0.9 m — if this bar looks wildly off, the scale is wrong" : "a door opening is about 3′ — if this bar looks wildly off, the scale is wrong";
          const step = unitPx >= 6 ? 1 : unitPx * 5 >= 6 ? 5 : 0;
          const ticks = step ? Array.from({ length: Math.floor(nUnits / step) + 1 }, (_, i) => i * step) : [0, nUnits];
          if (ticks[ticks.length - 1] !== nUnits) ticks.push(nUnits);
          const ink = darkMode ? "#9ec9f5" : "#1f3fc7";
          const halo = darkMode ? "#0b0e14" : "#fff";
          const y = 14;
          const mid = barPx / 2;
          const isMajor = (u) => u === 0 || u === nUnits || (step && u % (step === 1 ? 5 : step) === 0);
          return (
            <div className={`canvas-scale-hud${darkMode ? " is-sheet-invert" : ""}${viewPrefs.scaleBar ? "" : " is-view-hidden"}`}>
              <div className="canvas-scale-hud-lbl">{lbl}</div>
              <svg className="canvas-scale-hud-rule" width={Math.ceil(barPx)} height={22} aria-hidden="true">
                <line x1={0} y1={y} x2={barPx} y2={y} stroke={halo} strokeWidth={7} strokeLinecap="square" />
                <line x1={0} y1={y} x2={barPx} y2={y} stroke={ink} strokeWidth={2.4} />
                {ticks.map((u) => {
                  const x = u * unitPx;
                  const major = isMajor(u);
                  return (
                    <line key={u} x1={x} y1={y - (major ? 9 : 5)} x2={x} y2={y + (major ? 3 : 0)}
                      stroke={ink} strokeWidth={major ? 2 : 1.15} />
                  );
                })}
                <path d={`M 0 ${y - 9} V ${y + 4} H 7`} fill="none" stroke={ink} strokeWidth="2" />
                <path d={`M ${barPx} ${y - 9} V ${y + 4} H ${barPx - 7}`} fill="none" stroke={ink} strokeWidth="2" />
                <path d={`M ${mid - 4} ${y + 1} L ${mid} ${y + 7} L ${mid + 4} ${y + 1}`} fill={ink} stroke={halo} strokeWidth="1" />
              </svg>
              <div className="canvas-scale-hud-cap">{cap}</div>
            </div>
          );
        })()}

        {/* status line — floats above the scale bar so they never share a corner */}
        {commitMsg && (
          <div style={{ position: "absolute", left: "50%", bottom: (status === "ready" && unitsPerPx && focusPanel?.img?.w && viewPrefs.scaleBar ? 78 : 14) + (viewPrefs.rulers ? 24 : 0), transform: "translateX(-50%)", maxWidth: "70%", zIndex: 6, pointerEvents: "none", padding: "6px 12px", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", boxShadow: "var(--shadow-1)", fontSize: 12, color: isDangerMsg(commitMsg) ? "var(--c-danger)" : "var(--c-positive)" }}>
            {commitMsg}
          </div>
        )}
        {/* live dictation chip (RFC #59 recognizer): top-center, fixed — NOT
            cursor-following, the cursor is busy aiming for deixis. Shows the
            hold state, decode state, and a brief flash of the heard transcript
            (the receipt); outcomes land in the commitMsg bar like every command. */}
        {voiceChip && (
          <div style={{ position: "absolute", left: "50%", top: 14, transform: "translateX(-50%)", zIndex: 6, pointerEvents: "none", padding: "5px 12px", background: "var(--surface-pop)", border: `1px solid ${voiceChip.tone === "live" || voiceChip.tone === "offer" ? "var(--cobalt)" : "var(--ink-faint)"}`, boxShadow: "var(--shadow-1)", fontFamily: "var(--f-mono)", fontSize: 11.5, color: "var(--ink)", display: "flex", alignItems: "center", gap: 7, whiteSpace: "nowrap" }}>
            {voiceChip.tone === "live" && <span className="pip" />}
            {voiceChip.text}
          </div>
        )}

        {/* accept pill — visible while committed-but-unreviewed shapes (an
            imported MCP takeoff) are on the visible sheets; they render dashed
            pencil until accepted. One click, one undo entry. */}
        {pendingCommitted.length > 0 && (
          <button onClick={acceptPendingShapes}
            title={`${pendingCommitted.length} machine-proposed shape${pendingCommitted.length === 1 ? "" : "s"} render${pendingCommitted.length === 1 ? "s" : ""} dashed pending your review. Accept makes them ink (⌘Z undoes); to reject one, select it and press Delete.`}
            style={{ position: "absolute", left: "50%", top: 12, transform: "translateX(-50%)", zIndex: 6, padding: "6px 14px", background: "var(--paper-bright)", border: "1.5px dashed var(--cobalt)", boxShadow: "var(--shadow-1)", fontSize: 12.5, fontWeight: 600, color: "var(--cobalt)", cursor: "pointer" }}>
            Accept {pendingCommitted.length} proposed shape{pendingCommitted.length === 1 ? "" : "s"}
          </button>
        )}


        {/* zone check results — ephemeral, clears with the tool/outline. Docked at
            right:56 so it never covers the panel rail (right:14, 34px wide), and
            anchored to the BOTTOM (not top:14 like the original) so it stacks
            vertically with the live readout instead of sitting on top of it —
            the live readout (view-dock overlay above the minimap) shows the SAME zone's
            live "SF in zone" figure for the NEXT trace while this panel is open,
            and a top:14 placement here covered all but a ~42px sliver of it. */}
        {zoneRows && (
          <div style={{ position: "absolute", right: 56, bottom: 14, width: 300, maxHeight: "calc(100% - 28px)", overflowY: "auto", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", borderRadius: 0, boxShadow: "0 6px 22px rgba(0,0,0,.16)", zIndex: 7, fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
              <b style={{ fontSize: 12.5 }}>Zone check</b>
              <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, color: "var(--ink-muted)" }}>nothing saved</span>
              <button onClick={resetZone} style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", fontSize: 15, lineHeight: 1, color: "var(--ink)" }}>×</button>
            </div>
            {zoneRows.length === 0 && (
              <div style={{ padding: "10px 12px", color: "var(--ink-muted)", fontSize: 11.5 }}>No takeoffs inside this zone on this sheet.</div>
            )}
            {zoneRows.map((zr) => {
              const parts = [];
              if (zr.floor_sf) parts.push(fa(zr.floor_sf));
              if (zr.wall_sf) parts.push(`${fa(zr.wall_sf)} wall`);
              if (zr.border_sf) parts.push(`${fa(zr.border_sf)} border`);
              if (zr.lf) parts.push(fl(zr.lf));
              if (zr.ea) parts.push(`${num(zr.ea, 0)} EA`);
              const open = zoneExpand === zr.id;
              return (
                <div key={zr.id} style={{ padding: "8px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={zr.hatch || "solid"} line={zr.color} fill={zr.fill} /></span>
                    <b style={{ fontFamily: "var(--f-mono)", fontSize: 11.5 }}>{zr.finish_tag || "—"}</b>
                    {zr.multiplier > 1 && <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>×{zr.multiplier}</span>}
                    <span style={{ marginLeft: "auto", fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink)" }}>{parts.join(" · ") || "—"}</span>
                  </div>
                  {zr.materials.length > 0 && (
                    <button onClick={() => setZoneExpand(open ? null : zr.id)}
                      style={{ marginTop: 4, padding: 0, border: "none", background: "none", cursor: "pointer", fontSize: 10.5, color: "var(--ink-muted)" }}>
                      {open ? "▾" : "▸"} materials · {zr.materials.length}
                    </button>
                  )}
                  {open && zr.materials.map((m, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, marginTop: 3, marginLeft: 12, fontSize: 11, color: "var(--ink-secondary)" }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                      <span style={{ fontFamily: "var(--f-mono)" }}>{num(m.qty)} {m.unit}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            <div style={{ padding: "7px 12px", fontSize: 10, color: "var(--ink-muted)" }}>
              Shapes counted by their center point · same sheet only · counted shapes glow cobalt.
              {zoneRows.some((r) => (r.multiplier || 1) > 1) && <> Rows marked ×N already have the condition's multiplier applied — the same convention as the Report's Groups section, not its base-quantity by-sheet rows.</>}
              {/* A deduct classifies by its OWN center, independent of its positive
                  area's center (same rule the Report's by-sheet "negative slices"
                  note already documents for a cross-sheet split) — a zone edge
                  can split a deduct from the shape it cuts, producing a negative
                  row here. Flag it rather than guess a pairing: the deduct/positive
                  link is never stored, only inferred by overlap, and geometric
                  containment pairing would guess wrong for nested/overlapping
                  positives. */}
              {zoneRows.some((r) => r.total_sf < 0 || r.floor_sf < 0) && <> A negative row means a deduct here counted but its positive area's center fell outside the zone (or vice-versa) — the zone edge split a deduct from its shape.</>}
            </div>
          </div>
        )}

        {/* Standalone builds retain a click-only drawer affordance. The ADICC
            embed is controlled exclusively by the host's Tools eye button. */}
        {canvasReady && !isEmbedded && !takeoffsOpen && (
          <button
            type="button"
            className="chrome-edge-trigger is-right"
            aria-label="Show Takeoffs Drawer"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setToolbarVisible("takeoffs", true)}
          >
            <span>Takeoffs Drawer</span>
          </button>
        )}

        {/* Drawings Q&A — centered ask box. Trigger lives in the left stack. */}

        {/* Centered drawings ask — click outside or any other chrome closes it. */}
        {canvasReady && !showDrawingsChat && drawingsChatPill && (
          <div className="drawings-chat-center-scrim">
            <div
              className="drawings-ask-wrap"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <form
                className="drawings-ask"
                onPointerDown={(e) => e.stopPropagation()}
                onSubmit={(e) => {
                  e.preventDefault();
                  submitDrawingsAsk(drawingsChatDraft);
                }}
              >
                <span className="drawings-ask-mark" aria-hidden="true">
                  <Search size={16} strokeWidth={1.7} />
                </span>
                <label className="drawings-ask-field">
                  <span className="drawings-ask-k">Ask the drawings</span>
                  <input
                    ref={drawingsChatInputRef}
                    className="drawings-ask-input"
                    autoFocus
                    value={drawingsChatDraft}
                    onChange={(e) => setDrawingsChatDraft(e.target.value)}
                    placeholder="A scale, a door tag, a spec…"
                  />
                </label>
                {drawingsChatDraft && (
                  <button
                    type="button"
                    className="drawings-ask-clear"
                    aria-label="Clear question"
                    onClick={() => {
                      setDrawingsChatDraft("");
                      drawingsChatInputRef.current?.focus();
                    }}
                  >
                    <X size={15} strokeWidth={2} />
                  </button>
                )}
                <button
                  type="submit"
                  className="drawings-ask-send"
                  aria-label="Send"
                  disabled={!drawingsChatDraft.trim()}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4.5 11.2 19.2 4.4c.7-.3 1.4.4 1.1 1.1L13.5 20.2c-.3.7-1.3.6-1.5-.2l-1.6-6.1-6.1-1.6c-.8-.2-.9-1.2-.2-1.5Z" fill="currentColor"/>
                  </svg>
                </button>
              </form>
              <div className="drawings-ask-hits" role="listbox" aria-label="Suggested questions">
                {DRAWINGS_ASK_HINTS.map((hint) => (
                  <button
                    key={hint}
                    type="button"
                    className="drawings-ask-hit"
                    onClick={() => submitDrawingsAsk(hint)}
                  >
                    <span className="drawings-ask-pip" aria-hidden="true" />
                    <span>{hint}</span>
                  </button>
                ))}
              </div>
              <div className="drawings-ask-foot">
                <span>Enter sends</span>
                <span>Esc closes</span>
              </div>
            </div>
          </div>
        )}

        {/* Takeoffs Drawer overlays the sheet with no scrim — close only via
            the panel × or Tools → Takeoffs Drawer (toggle). Outside clicks keep
            working the canvas underneath. */}
        {canvasReady && takeoffsShown && (
        <div
          className={`takeoffs-drawer-slot${takeoffsEntered ? " is-open" : ""}`}
        >
          <TakeoffsPanel
            open
            width={panelW}
            multiSheet={groupKeys.length > 1}
            units={units}
            conditions={conditions}
            activeCond={activeCond}
            visRowById={visRowById}
            conditionColumns={conditionColumns}
            shapeLabels={shapeLabels}
            templates={templates}
            palette={palette}
            matLib={matLib}
            matLibById={matLibById}
            linkedCountById={linkedCountById}
            panelPrefs={panelPrefs}
            reassigning={tool === "select" && !!selectedId}
            epoch={panelEpoch}
            clearSelectionRef={panelSelectionRef}
            {...panelHandlers}
          />
        </div>
        )}

       </div>

        {/* Agent panel — DOCKED right-rail sibling (reflows the canvas like the
            Takeoffs panel). Honest empty state until the BYO-AI seam is
            configured; otherwise the goal box, the streaming run log, and the
            per-proposal accept/reject desk. */}
        {agentOpen && (
          <AgentPanel
            configured={isAiConfigured()}
            running={agentRunning}
            log={agentLog}
            proposals={agentProposals}
            condById={condById}
            sheetLabel={(k) => tabLabel(k)}
            units={units}
            fmtArea={(sf) => fa(sf)}
            onRun={runAgent}
            onStop={stopAgent}
            onAccept={acceptAgentProposal}
            onReject={rejectAgentProposal}
            onAcceptAll={acceptAllVisibleAgentProposals}
            onRejectAll={rejectAllAgentProposals}
            onOpenSettings={() => setShowAiSettings(true)}
            onClose={() => setAgentOpen(false)}
          />
        )}

        {canvasReady && showDrawingsChat && (
          <DrawingsChatPanel
            onClose={() => { setShowDrawingsChat(false); setDrawingsChatSeed(""); }}
            onOpenInWorkspace={openCitationInWorkspace}
            sheetNames={sheets.map((s) => s.name)}
            galleryLabels={galleryLabels}
            initialQuestion={drawingsChatSeed}
            getProjectContext={() => buildProjectChatContext({
              projectName,
              units,
              shapes,
              conditions,
              planSymbols,
              symbolNotes,
              panelImgs,
              roomLabelsBySheet,
              scheduleKb,
            })}
            getLiveDetectionInput={() => ({ planSymbols, shapes, conditions })}
          />
        )}

        {showRates && (
          <FloatingWindow
            defaultRect={{ x: 16, y: 72, w: 440, h: Math.min(720, (typeof window !== "undefined" ? window.innerHeight : 800) - 96) }}
            minW={360}
            minH={320}
          >
            <RatesPanel open={showRates} onClose={() => setShowRates(false)} onRatesChange={setMaterialRates} />
          </FloatingWindow>
        )}

        {showEstimate && (
          <FloatingWindow
            defaultRect={{ x: Math.max(16, ((typeof window !== "undefined" ? window.innerWidth : 1280) - 480) / 2 - 40), y: 72, w: 480, h: Math.min(720, (typeof window !== "undefined" ? window.innerHeight : 800) - 96) }}
            minW={360}
            minH={320}
          >
            <EstimatePanel
              open={showEstimate}
              onClose={() => setShowEstimate(false)}
              conditions={conditions}
              shapes={boqShapes}
              materialRates={materialRates}
              units={units}
              projectSettings={projectSettings}
              projectName={projectName}
              sheetLabel={tabLabel}
              sheetLevels={sheetLevels}
            />
          </FloatingWindow>
        )}

        {/* BOQ — floating window (same content; drag header / resize edges) */}
        {showBoq && (
          <FloatingWindow
            defaultRect={{ x: Math.max(16, (typeof window !== "undefined" ? window.innerWidth : 1280) - 456), y: 72, w: 440, h: Math.min(720, (typeof window !== "undefined" ? window.innerHeight : 800) - 96) }}
            minW={360}
            minH={320}
          >
            <BoqPanel
              open={showBoq}
              onClose={() => { setShowBoq(false); setBoqFocusShapeId(null); }}
              conditions={conditions}
              shapes={boqShapes}
              sheetLabel={tabLabel}
              sheetLevels={sheetLevels}
              boqLines={boqLines}
              onBoqLinesChange={setBoqLines}
              units={units}
              projectName={projectName}
              planSymbols={planSymbols}
              symbolNotes={symbolNotes}
              panelImgs={panelImgs}
              roomLabelsBySheet={roomLabelsBySheet}
              scheduleKb={scheduleKb}
              focusShapeId={boqFocusShapeId}
              activeShapeId={selectedId}
              onShapeNavigate={flyToShape}
              onShapeDelete={deleteShapeFromBoq}
              onClearFocus={() => setBoqFocusShapeId(null)}
              onOpenRates={() => setShowRates(true)}
              onOpenSummary={() => setShowSummary(true)}
              materialRates={materialRates}
              projectSettings={projectSettings}
              pricingCtx={pricingCtx}
            />
          </FloatingWindow>
        )}

        {/* Summary Table — hierarchical floor -> type -> code -> qty floating window */}
        {showSummary && (
          <FloatingWindow
            defaultRect={{ x: Math.max(16, (typeof window !== "undefined" ? window.innerWidth : 1280) - 520), y: 72, w: 480, h: Math.min(740, (typeof window !== "undefined" ? window.innerHeight : 800) - 96) }}
            minW={380}
            minH={320}
          >
            <SummaryPanel
              shapes={boqShapes}
              conditions={conditions}
              sheetLevels={sheetLevels}
              sheetLabel={tabLabel}
              hiddenShapeIds={hiddenShapeIds}
              units={units}
              boqLines={boqLines}
              projectName={projectName}
              activeSheetId={focusKey || sheetKey}
              onToggleHideIds={toggleHideIds}
              onPatchCondition={updateCondById}
              onShapeNavigate={flyToShape}
              onClose={() => setShowSummary(false)}
              roomForShape={(s) => detectRoomName(s, boqDetectCtx, shapes) || s.room_detected || s.room || ""}
            />
          </FloatingWindow>
        )}

        {showFinishesSchedule && (() => {
          const selShapeObj = selectedId ? shapes.find((s) => s.id === selectedId) : null;
          const activeRoom = selShapeObj ? (selShapeObj.room || detectRoomName(selShapeObj, boqDetectCtx, shapes) || selShapeObj.room_detected || "") : "";
          return (
            <FloatingWindow
              defaultRect={{ x: Math.max(16, ((typeof window !== "undefined" ? window.innerWidth : 1280) - 920) / 2), y: 72, w: 920, h: Math.min(680, (typeof window !== "undefined" ? window.innerHeight : 800) - 96) }}
              minW={520}
              minH={360}
            >
              <FinishesSchedulePanel
                open={showFinishesSchedule}
                onClose={() => setShowFinishesSchedule(false)}
                scheduleKb={scheduleKb}
                highlightRoom={activeRoom}
              />
            </FloatingWindow>
          );
        })()}

      </div>

      {/* Unified plan navigator — one surface for the plan-set gallery AND the
          Drive folder browser. Presents as a modal over the dimmed canvas when a
          sheet is open behind it, or full-screen (onboarding) when nothing is. */}
      {(view === "gallery" || view === "picker") && (
        <PlanNavigator
          canClose={openTabs.length > 0}
          onExit={() => setView("canvas")}
          initialMode={view === "picker" ? "browse" : "plan"}
          cloudMode={cloudMode}
          sheets={sheets} getDoc={docFor} scales={scales} detectedScales={detectedScales}
          shapes={shapes} labels={galleryLabels}
          onLabel={(k, lbl) => setGalleryLabels((m) => (m[k] === lbl ? m : { ...m, [k]: lbl }))}
          onDetect={(k, det) => setDetectedScales((d) => (d[k]?.label === det.label ? d : { ...d, [k]: det }))}
          thumbCacheRef={thumbCacheRef} busyRef={statusRef}
          openTabs={openTabs} onOpen={openSheets}
          onAddFiles={handleFiles}
          levels={sheetLevels}
          fileFolders={fileFolders}
          onAssignLevel={(keys, label) => setSheetLevels((m) => {
            const next = { ...m };
            for (const k of keys) { if (label) next[k] = label; else delete next[k]; }
            return next;
          })}
          onClosePdf={closePdf}
          onRemoveFromProject={cloudMode ? removeFromProject : undefined}
          onCloseProject={cloudMode ? closeProject : undefined}
          onBrowseProjects={cloudMode ? browseProjects : undefined}
          listFolder={cloudMode ? pickerListFolder : undefined}
          addSheets={pickerAddSheets}
          onAdded={async () => { await refreshSheets(); setStatus("ready"); }}
        />
      )}

      {importRows && (
        <ImportSchedulePanel
          rows={importRows}
          existing={new Set(conditions.map((c) => normalizeTag(c.finish_tag)))}
          palette={PALETTE} startIndex={conditions.length}
          onCreate={createFromSchedule}
          onClose={() => setImportRows(null)}
        />
      )}

      {pendingPdfClose && (
        <ConfirmDeleteModal
          title="Remove this file?"
          body={`“${String(pendingPdfClose).split("/").pop()}” will leave this takeoff. Takeoffs on its sheets stay saved and come back if you add the file again.`}
          confirmLabel="Remove file"
          onConfirm={confirmClosePdf}
          onCancel={cancelClosePdf}
        />
      )}

      {pendingMarkupDelete && (
        <ConfirmDeleteModal
          title="Delete this markup?"
          body={pendingMarkupDelete.text
            ? `“${pendingMarkupDelete.text}” will be removed from the sheet.`
            : `This ${pendingMarkupDelete.type || "markup"} will be removed from the sheet.`}
          confirmLabel="Delete"
          onConfirm={() => { deleteMarkup(pendingMarkupDelete.id); setPendingMarkupDelete(null); }}
          onCancel={() => setPendingMarkupDelete(null)}
        />
      )}

      {pendingTakeoffsConfirm && (
        <ConfirmDeleteModal
          title={pendingTakeoffsConfirm.title}
          body={pendingTakeoffsConfirm.body}
          confirmLabel={pendingTakeoffsConfirm.confirmLabel}
          tone={pendingTakeoffsConfirm.tone || "danger"}
          onConfirm={confirmTakeoffsAction}
          onCancel={cancelTakeoffsConfirm}
        />
      )}

      {overlapPrompt && (
        <div
          onClick={() => resolveOverlapPrompt("cancel")}
          style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(14,26,46,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="overlap-prompt-title"
            aria-describedby="overlap-prompt-desc"
            style={{ width: 440, maxWidth: "100%", background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-2)", fontFamily: "var(--f-body)", color: "var(--ink)" }}>
            <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--ink-faint)" }}>
              <div id="overlap-prompt-title" style={{ fontFamily: "var(--f-display)", fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
                Overlapping takeoff detected
              </div>
              <p id="overlap-prompt-desc" style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--ink-secondary)" }}>
                {overlapPrompt.source === "oneclick"
                  ? <>The selected area overlaps {overlapPrompt.count === 1 ? "an existing takeoff" : `${overlapPrompt.count} existing takeoffs`} for <strong>{overlapPrompt.tag}</strong>. Choose how to resolve the overlap before creating.</>
                  : overlapPrompt.cutoutOverParent
                    ? <>This cutout overlaps {overlapPrompt.victims?.length === 1 ? "a parent mask" : `${overlapPrompt.victims?.length || 0} parent masks`}. Choose how to resolve it.</>
                    : <>This measurement overlaps {overlapPrompt.victims?.length === 1 ? "an existing takeoff" : `${overlapPrompt.victims?.length || 0} existing takeoffs`} for <strong>{overlapPrompt.tag}</strong>. Choose how to resolve the overlap.</>}
              </p>
            </div>
            <div style={{ padding: "14px 18px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                type="button"
                autoFocus
                onClick={() => resolveOverlapPrompt("merge")}
                title={overlapPrompt.cutoutOverParent ? "Keep cutout on top of the parent (Enter)" : "Combine into one takeoff region (Enter)"}
                style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "10px 12px", border: "1px solid var(--cobalt)", background: "rgba(31,63,199,.06)", cursor: "pointer", textAlign: "left" }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--cobalt)" }}>Merge</span>
                <span style={{ fontSize: 12, color: "var(--ink-muted)", lineHeight: 1.4 }}>
                  {overlapPrompt.cutoutOverParent
                    ? "Keep the cutout visible on top of the parent mask until you apply it."
                    : "Combine the overlapping areas into a single takeoff."}
                </span>
              </button>
              <button
                type="button"
                onClick={() => resolveOverlapPrompt("remove")}
                title={overlapPrompt.cutoutOverParent ? "Punch the cutout out of the parent mask now" : "Cut the overlapping portion from the existing takeoff"}
                style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "10px 12px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", textAlign: "left" }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>Remove overlap</span>
                <span style={{ fontSize: 12, color: "var(--ink-muted)", lineHeight: 1.4 }}>
                  {overlapPrompt.cutoutOverParent
                    ? "Cut this region out of the parent mask now."
                    : "Cut the overlapping portion from the existing takeoff without adding a duplicate."}
                </span>
              </button>
              <button
                type="button"
                onClick={() => resolveOverlapPrompt("cancel")}
                title="Discard this draw (Esc)"
                style={{ alignSelf: "flex-start", marginTop: 4, padding: "6px 10px", border: "none", background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--ink-muted)", textDecoration: "underline" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {loadError && (
        <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 60, display: "flex", alignItems: "center", gap: 12, maxWidth: 640, padding: "10px 14px", background: "var(--paper-bright)", border: "1px solid var(--c-danger)", boxShadow: "var(--shadow-2)", fontSize: 12.5, color: "var(--ink)" }}>
          <span>
            <strong style={{ color: "var(--c-danger)" }}>Couldn't load this project's saved takeoff</strong> ({loadError}).
            Autosave is paused so nothing overwrites your saved work — reload the tab to retry.
          </span>
          <button onClick={() => window.location.reload()} style={{ whiteSpace: "nowrap", padding: "6px 12px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 12 }}>Reload</button>
        </div>
      )}

      {showReport && (
        <ReportPanel
          projectName={projectName} onProjectName={setProjectName}
          clientInfo={clientInfo} onClientInfo={setClientInfo} units={units}
          conditions={conditions} shapes={boqShapes} markups={markups} rfis={rfis}
          conditionColumns={conditionColumns} shapeLabels={shapeLabels}
          scaleInfo={Object.entries(scales).map(([sheet_id, units_per_px]) => ({ sheet_id, units_per_px, scale_source: scaleSources[sheet_id] || "unknown" }))}
          provenanceCounters={provCounters}
          sheetLabel={(k) => tabLabel(k)}
          onMarkedSet={exportMarkedSet} markedSetDark={darkMode}
          onClose={() => setShowReport(false)}
        />
      )}

      {showRevisions && (
        <RevisionsPanel
          current={buildPayload()}
          units={units}
          onRestore={restoreSavedPayload}
          onClose={() => setShowRevisions(false)}
        />
      )}

      {/* BYO-key AI settings — the single config surface for the ai.js seam
          (the Agent panel links here; closing re-renders, so `configured`
          re-reads immediately). */}
      {showAiSettings && <AiSettings onClose={() => setShowAiSettings(false)} />}

    </div>
  );
}
