// Takeoff report PDF — ADICC-branded export with logo, colour accents,
// condition breakdown, by-sheet, revisions, materials, and RFIs.

import { winAnsiSafe } from "./markedset.js";
import { colGetter } from "./reportColumns.js";
import { roundSheetRow, hasMultipliers, BY_SHEET_BASE_NOTE, grandTotals } from "./totals.js";
import { areaVal, areaUnit, lenVal, lenUnit } from "./units";
import { columnLabel } from "./conditionColumns.js";
import { sheetExportName } from "./sheetKey.ts";

const PAGE_W = 612;
const PAGE_H = 792;
const M_LEFT = 48;
const M_RIGHT = 564;
const M_BOTTOM = 58;
const M_TOP = 748;
const CONTENT_W = M_RIGHT - M_LEFT;

const ADICC_LOGO_URLS = [
  "/images/logos/adicc-logo.png",
  `${typeof import.meta !== "undefined" && import.meta.env?.BASE_URL ? import.meta.env.BASE_URL : "/"}images/logos/adicc-logo.png`,
];

const fmt = (v, d = 1) => (Math.round((Number(v) || 0) * 10 ** d) / 10 ** d || 0).toLocaleString(undefined, { maximumFractionDigits: d });

function cellText(col, row, ctx) {
  const get = colGetter(col);
  const v = get ? get(row, ctx) : row[col.key];
  if (col.custom || col.spec || col.labor) return v ? String(v) : "—";
  switch (col.key) {
    case "finish":
      return `${row.finish_tag || ""}${row.multiplier > 1 ? ` x${row.multiplier}` : ""}`;
    case "waste_pct":
      return v ? `${fmt(v, 0)}%` : "—";
    case "ea":
      return v ? fmt(v, 0) : "—";
    default:
      return v === "" || v == null ? "—" : fmt(v);
  }
}

function footText(col, grand) {
  if (!col.foot || col.ref) return "";
  const v = col.foot(grand);
  return v === "" || v == null ? "" : fmt(v);
}

function wrapText(text, font, size, maxW) {
  const words = winAnsiSafe(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxW) line = next;
    else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

async function embedLogoFromDataUri(doc, dataUri) {
  if (!dataUri) return null;
  try { return await doc.embedPng(dataUri); } catch { /* fall through */ }
  try { return await doc.embedJpg(dataUri); } catch { return null; }
}

async function loadAdiccBrandLogo(doc) {
  for (const url of ADICC_LOGO_URLS) {
    if (!url) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      return await doc.embedPng(buf);
    } catch { /* try next source */ }
  }
  return null;
}

export async function buildReportPdf({
  projectName = "",
  clientInfo = {},
  brand = {},
  company = null,
  rows = [],
  grand = {},
  bySheet = [],
  matSummary = [],
  markups = [],
  rfis = [],
  sheetLabel = null,
  tableCols = [],
  ctx = {},
  groups = null,
  grouped = false,
  groupCol = null,
  groupBy = "",
  units = "imperial",
  disclaimer = "Quantities derived from drawings at stated scales; verify in field.",
}) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serif = await doc.embedFont(StandardFonts.TimesRomanBold);

  const navy = rgb(0.106, 0.263, 0.396);
  const cobalt = rgb(0.122, 0.247, 0.780);
  const ink = rgb(0.13, 0.12, 0.1);
  const muted = rgb(0.42, 0.4, 0.36);
  const white = rgb(1, 1, 1);
  const paper = rgb(0.98, 0.985, 0.99);
  const rowAlt = rgb(0.94, 0.965, 0.995);
  const rowTotal = rgb(0.90, 0.945, 0.985);
  const lineC = rgb(0.78, 0.84, 0.92);
  const accent = rgb(0.85, 0.72, 0.28);

  let logoImg = await loadAdiccBrandLogo(doc);
  if (!logoImg && company?.logo) logoImg = await embedLogoFromDataUri(doc, company.logo);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let pageNo = 1;
  let y = M_TOP;

  const labelSheet = (id) => sheetExportName(id);

  const paintPageBg = (pg) => {
    pg.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: paper });
  };

  const drawFooter = (pg, n) => {
    pg.drawRectangle({ x: M_LEFT, y: M_BOTTOM - 4, width: CONTENT_W, height: 18, color: rgb(0.92, 0.955, 0.985), borderColor: lineC, borderWidth: 0.5 });
    const foot = winAnsiSafe(`${projectName || "Untitled project"} — ${disclaimer}`);
    pg.drawText(foot, { x: M_LEFT + 6, y: M_BOTTOM, size: 7, font, color: muted });
    const pgTxt = winAnsiSafe(`Page ${n}`);
    pg.drawText(pgTxt, { x: M_RIGHT - 6 - font.widthOfTextAtSize(pgTxt, 7.5), y: M_BOTTOM, size: 7.5, font: bold, color: navy });
  };

  const drawLogo = (pg, x, topY, maxH = 46) => {
    if (!logoImg) return 0;
    const s = Math.min(220 / logoImg.width, maxH / logoImg.height);
    const w = logoImg.width * s;
    const h = logoImg.height * s;
    pg.drawImage(logoImg, { x, y: topY - h, width: w, height: h });
    return h;
  };

  const newPage = () => {
    drawFooter(page, pageNo);
    page = doc.addPage([PAGE_W, PAGE_H]);
    paintPageBg(page);
    pageNo += 1;
    y = M_TOP - 6;
    page.drawRectangle({ x: M_LEFT, y: y - 28, width: CONTENT_W, height: 30, color: rgb(0.92, 0.955, 0.99), borderColor: lineC, borderWidth: 0.5 });
    page.drawText(winAnsiSafe(projectName || "Takeoff Report"), {
      x: M_LEFT + 6,
      y: y - 18,
      size: 10,
      font: bold,
      color: navy,
    });
    if (logoImg) {
      const maxH = 22;
      const s = Math.min(100 / logoImg.width, maxH / logoImg.height);
      const w = logoImg.width * s;
      const h = logoImg.height * s;
      page.drawImage(logoImg, { x: M_RIGHT - 10 - w, y: y - 8 - h, width: w, height: h });
    }
    y -= 38;
  };

  paintPageBg(page);

  const ensure = (h) => { if (y - h < M_BOTTOM + 32) newPage(); };

  const draw = (text, opts = {}) => {
    const size = opts.size || 10;
    const fnt = opts.font || font;
    const color = opts.color || ink;
    const maxW = opts.maxW || CONTENT_W;
    const lh = opts.lh || size + 5;
    for (const line of wrapText(text, fnt, size, maxW)) {
      ensure(lh);
      page.drawText(line, { x: opts.x ?? M_LEFT, y, size, font: fnt, color });
      y -= lh;
    }
  };

  const section = (title, minBody = 52) => {
    ensure(minBody + 32);
    y -= 12;
    page.drawRectangle({ x: M_LEFT, y: y - 16, width: 4, height: 16, color: cobalt });
    page.drawText(winAnsiSafe(title), { x: M_LEFT + 10, y: y - 12, size: 11, font: bold, color: navy });
    page.drawLine({ start: { x: M_LEFT, y: y - 20 }, end: { x: M_RIGHT, y: y - 20 }, thickness: 1.2, color: cobalt });
    y -= 28;
  };

  const gap = (n = 10) => { y -= n; };

  // ── masthead ───────────────────────────────────────────────────────────────
  const headerH = 96;
  const headerTop = y;
  page.drawRectangle({ x: M_LEFT, y: headerTop - headerH, width: CONTENT_W, height: headerH, color: rgb(0.90, 0.945, 0.985), borderColor: navy, borderWidth: 1 });
  const logoTop = headerTop - 10;
  const imgH = drawLogo(page, M_LEFT + 10, logoTop, 44);
  let titleY = logoTop - imgH - 10;
  page.drawText(winAnsiSafe("Takeoff Report"), { x: M_LEFT + 10, y: titleY, size: 9, font: bold, color: cobalt });
  titleY -= 18;
  page.drawText(winAnsiSafe(projectName || "Untitled project"), { x: M_LEFT + 10, y: titleY, size: 15, font: serif, color: navy });
  const dateStr = winAnsiSafe(`Date: ${clientInfo?.date || new Date().toLocaleDateString()}`);
  page.drawText(dateStr, {
    x: M_RIGHT - 10 - font.widthOfTextAtSize(dateStr, 9),
    y: headerTop - 16,
    size: 9,
    font,
    color: muted,
  });
  y = headerTop - headerH - 10;

  if (clientInfo?.client_name) draw(`Client: ${clientInfo.client_name}`, { size: 9.5, lh: 14, color: navy });
  if (clientInfo?.reference) draw(`Reference: ${clientInfo.reference}`, { size: 9.5, lh: 14 });
  if (clientInfo?.client_address) {
    for (const line of String(clientInfo.client_address).split("\n").slice(0, 3)) {
      if (line.trim()) draw(line.trim(), { size: 9, color: muted, lh: 13 });
    }
  }
  gap(8);

  const AU = areaUnit(units);
  const LU = lenUnit(units);

  const drawTable = (headers, bodyRows, colWidths, opts = {}) => {
    if (!headers.length && !bodyRows.length) return;
    const bodySize = opts.bodySize || 8;
    const headerSize = opts.headerSize || 7.5;
    const baseRowH = opts.rowH || 18;
    const totalW = colWidths.reduce((a, b) => a + b, 0);
    const scale = totalW > CONTENT_W ? CONTENT_W / totalW : 1;
    const widths = colWidths.map((w) => w * scale);
    const textPad = 11;

    if (headers.length) {
      ensure(baseRowH + 6);
      page.drawRectangle({ x: M_LEFT, y: y - baseRowH, width: CONTENT_W, height: baseRowH, color: navy });
      let hx = M_LEFT;
      headers.forEach((h, i) => {
        page.drawText(winAnsiSafe(h), { x: hx + 4, y: y - textPad, size: headerSize, font: bold, color: white });
        hx += widths[i];
      });
      y -= baseRowH;
      page.drawLine({ start: { x: M_LEFT, y }, end: { x: M_RIGHT, y }, thickness: 0.5, color: cobalt });
    }

    bodyRows.forEach((cells, ri) => {
      const isTotal = opts.totalRow && ri === bodyRows.length - 1;
      const rowH = baseRowH;
      ensure(rowH + 4);
      if (isTotal) {
        page.drawRectangle({ x: M_LEFT, y: y - rowH, width: CONTENT_W, height: rowH, color: rowTotal, borderColor: cobalt, borderWidth: 0.75 });
      } else if (ri % 2 === 1) {
        page.drawRectangle({ x: M_LEFT, y: y - rowH, width: CONTENT_W, height: rowH, color: rowAlt });
      }
      let x = M_LEFT;
      cells.forEach((cell, i) => {
        const txt = winAnsiSafe(String(cell ?? "—"));
        const cellColor = isTotal && i > 0 ? cobalt : (i === 0 ? navy : ink);
        page.drawText(txt, {
          x: x + 4,
          y: y - textPad,
          size: isTotal ? bodySize + 0.5 : bodySize,
          font: i === 0 || isTotal ? bold : font,
          color: cellColor,
        });
        x += widths[i];
      });
      y -= rowH;
      page.drawLine({ start: { x: M_LEFT, y }, end: { x: M_RIGHT, y }, thickness: 0.35, color: lineC });
    });
    gap(8);
  };

  const drawWrappedTable = (headers, bodyRows, colWidths, bodySize = 8) => {
    if (!bodyRows.length) return;
    const totalW = colWidths.reduce((a, b) => a + b, 0);
    const scale = totalW > CONTENT_W ? CONTENT_W / totalW : 1;
    const widths = colWidths.map((w) => w * scale);
    const lineH = bodySize + 5;
    const headerH = 18;
    const textPad = 11;

    ensure(headerH + 8);
    page.drawRectangle({ x: M_LEFT, y: y - headerH, width: CONTENT_W, height: headerH, color: navy });
    let hx = M_LEFT;
    headers.forEach((h, i) => {
      page.drawText(winAnsiSafe(h), { x: hx + 4, y: y - textPad, size: 7.5, font: bold, color: white });
      hx += widths[i];
    });
    y -= headerH;
    page.drawLine({ start: { x: M_LEFT, y }, end: { x: M_RIGHT, y }, thickness: 0.5, color: cobalt });

    bodyRows.forEach((cells, ri) => {
      const lineSets = cells.map((cell, i) => wrapText(String(cell ?? "—"), font, bodySize, widths[i] - 8));
      const rowLines = Math.max(1, ...lineSets.map((ls) => ls.length));
      const rowH = rowLines * lineH + 10;
      ensure(rowH + 4);
      if (ri % 2 === 1) {
        page.drawRectangle({ x: M_LEFT, y: y - rowH, width: CONTENT_W, height: rowH, color: rowAlt });
      }
      const rowTop = y;
      for (let li = 0; li < rowLines; li++) {
        let x = M_LEFT;
        cells.forEach((_cell, i) => {
          const line = lineSets[i][li] || "";
          if (line) {
            page.drawText(winAnsiSafe(line), {
              x: x + 4,
              y: rowTop - textPad - li * lineH,
              size: bodySize,
              font: i === 0 ? bold : font,
              color: i === 0 ? navy : ink,
            });
          }
          x += widths[i];
        });
      }
      y -= rowH;
      page.drawLine({ start: { x: M_LEFT, y }, end: { x: M_RIGHT, y }, thickness: 0.35, color: lineC });
    });
    gap(12);
  };

  // ── conditions table ─────────────────────────────────────────────────────
  if (rows.length) {
    section("Condition breakdown", 64);
    if (grouped) {
      draw(`Grouped by ${groupCol ? columnLabel(groupCol) : groupBy === "label" ? "label" : "sheet"}`, { size: 9, color: cobalt, lh: 13 });
    }

    const cols = tableCols.length ? tableCols : [{ key: "finish", header: "Finish" }];
    const headers = cols.map((c) => c.header);
    const baseW = cols.map((c) => (c.key === "finish" ? 86 : 38));
    const partition = grouped && groups?.length ? groups : [{ label: null, rows, perimByCond: null }];
    let tableHeadersDrawn = false;

    for (const gp of partition) {
      if (gp.label) {
        ensure(22);
        page.drawRectangle({ x: M_LEFT, y: y - 16, width: CONTENT_W, height: 18, color: rgb(0.96, 0.98, 1), borderColor: lineC, borderWidth: 0.5 });
        page.drawText(winAnsiSafe(gp.label), { x: M_LEFT + 6, y: y - 12, size: 10, font: bold, color: navy });
        y -= 22;
      }
      const gctx = gp.perimByCond ? { ...ctx, perimByCond: gp.perimByCond } : ctx;
      const body = gp.rows.map((r) => cols.map((c) => cellText(c, r, gctx)));
      drawTable(tableHeadersDrawn ? [] : headers, body, baseW, { rowH: 18 });
      tableHeadersDrawn = true;

      if (grouped && groups.length > 1 && gp.rows.length > 1) {
        const subG = grandTotals(gp.rows);
        const subRow = cols.map((c, i) => (i === 0 ? "Subtotal" : footText(c, subG)));
        drawTable([], [subRow], baseW, { rowH: 18, totalRow: true });
      }
    }

    const totalRow = cols.map((c, i) => (i === 0 ? "TOTAL" : footText(c, grand)));
    drawTable([], [totalRow], baseW, { rowH: 20, bodySize: 8.5, totalRow: true });
    draw(`${AU} w/Waste = measured quantity with waste applied per condition.`, { size: 8.5, color: muted, lh: 13 });
    gap(8);
  }

  // ── by sheet ───────────────────────────────────────────────────────────────
  if (rows.length && bySheet.length) {
    section("By sheet", 76);
    const shHeaders = ["Finish", `Floor ${AU}`, `Wall ${AU}`, `Border ${AU}`, LU, "EA"];
    const shWidths = [116, 48, 48, 48, 40, 32];
    for (const gp of bySheet) {
      ensure(26);
      page.drawText(winAnsiSafe(labelSheet(gp.sheet_id)), { x: M_LEFT + 4, y: y - 11, size: 9.5, font: bold, color: cobalt });
      y -= 18;
      const body = gp.rows.map((r) => {
        const { floor_sf, wall_sf, border_sf, lf, ea } = roundSheetRow(r);
        return [
          `${r.finish_tag}${r.multiplier > 1 ? ` x${r.multiplier}` : ""}`,
          areaVal(floor_sf, units) ? fmt(areaVal(floor_sf, units)) : "—",
          areaVal(wall_sf, units) ? fmt(areaVal(wall_sf, units)) : "—",
          areaVal(border_sf, units) ? fmt(areaVal(border_sf, units)) : "—",
          lenVal(lf, units) ? fmt(lenVal(lf, units)) : "—",
          ea ? fmt(ea, 0) : "—",
        ];
      });
      drawTable(shHeaders, body, shWidths, { rowH: 18 });
    }
    draw("Base quantities per sheet — waste not applied.", { size: 8.5, color: muted, lh: 13 });
    if (hasMultipliers(bySheet)) draw(BY_SHEET_BASE_NOTE, { size: 8.5, color: muted, lh: 13 });
    gap(8);
  }

  // ── revisions noted ────────────────────────────────────────────────────────
  const revMarkups = markups.filter((m) => m.type !== "svg");
  if (revMarkups.length) {
    section("Revisions noted", 84);
    const revBody = revMarkups.map((m) => [
      m.type === "cloud" ? "CLOUD" : m.type === "callout" ? "CALLOUT" : "NOTE",
      labelSheet(m.sheet_id),
      m.text || "—",
    ]);
    drawWrappedTable(["Type", "Sheet", "Note"], revBody, [50, 120, CONTENT_W - 170]);
    draw("Markups are annotations, not measurements.", { size: 8.5, color: muted, lh: 13 });
    gap(10);
  }

  // ── materials buy list ─────────────────────────────────────────────────────
  if (matSummary.length) {
    section("Supporting materials — buy list", 76);
    drawTable(
      ["Material", "Quantity", "Unit"],
      matSummary.map((m) => [m.name, fmt(m.qty, 2), m.unit || "—"]),
      [250, 74, 58],
      { rowH: 18 },
    );
    for (const r of rows.filter((row) => row.materials?.length)) {
      const detail = r.materials.map((m) => `${m.name} ${fmt(m.qty, 2)}${m.unit ? ` ${m.unit}` : ""}${m.note ? ` (${m.note})` : ""}`).join(" · ");
      draw(`${r.finish_tag}: ${detail}`, { size: 8.5, color: muted, lh: 13 });
    }
    gap(8);
  }

  // ── RFIs ───────────────────────────────────────────────────────────────────
  if (rfis.length) {
    section("RFI register", 76);
    drawWrappedTable(
      ["#", "Status", "Subject"],
      rfis.map((r) => [String(r.number ?? "—"), r.status || "—", r.subject || r.title || "—"]),
      [38, 74, CONTENT_W - 112],
    );
  }

  if (brand.credit) {
    ensure(24);
    const credit = winAnsiSafe(brand.credit);
    page.drawText(credit, {
      x: (PAGE_W - font.widthOfTextAtSize(credit, 7)) / 2,
      y: M_BOTTOM + 30,
      size: 7,
      font,
      color: accent,
    });
  }

  drawFooter(page, pageNo);

  const bytes = await doc.save();
  const base = (projectName || "takeoff").replace(/[^\w.-]+/g, "_");
  return { bytes, filename: `${base}_report.pdf` };
}
