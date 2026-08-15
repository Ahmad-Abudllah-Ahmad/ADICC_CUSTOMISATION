// Bill of Quantities PDF — ADICC-branded export matching report PDF styling
// with BOQ panel table layout (per-sheet rows: Room, Finish, quantities, pricing).

import { winAnsiSafe } from "./markedset.js";
import { areaUnit } from "./units";
import { money } from "./num.js";

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
const dash = "—";
const trunc = (s, n = 26) => {
  const t = String(s ?? "").trim();
  if (!t) return dash;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

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

export async function buildBoqPdf({
  projectName = "",
  units = "imperial",
  currency = "AED",
  sheets = [],
  manualLines = [],
  grand = {},
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
  const lineC = rgb(0.78, 0.84, 0.92);

  const logoImg = await loadAdiccBrandLogo(doc);
  const AU = areaUnit(units);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let pageNo = 1;
  let y = M_TOP;

  const paintPageBg = (pg) => {
    pg.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: paper });
  };

  const drawFooter = (pg, n) => {
    pg.drawRectangle({ x: M_LEFT, y: M_BOTTOM - 4, width: CONTENT_W, height: 18, color: rgb(0.92, 0.955, 0.985), borderColor: lineC, borderWidth: 0.5 });
    const foot = winAnsiSafe(`${projectName || "Untitled project"} — Bill of Quantities; verify quantities in field.`);
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
    page.drawText(winAnsiSafe(projectName || "Bill of Quantities"), {
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

  const gap = (n = 10) => { y -= n; };

  const section = (title, minBody = 52) => {
    ensure(minBody + 32);
    y -= 12;
    page.drawRectangle({ x: M_LEFT, y: y - 16, width: 4, height: 16, color: cobalt });
    page.drawText(winAnsiSafe(title), { x: M_LEFT + 10, y: y - 12, size: 11, font: bold, color: navy });
    page.drawLine({ start: { x: M_LEFT, y: y - 20 }, end: { x: M_RIGHT, y: y - 20 }, thickness: 1.2, color: cobalt });
    y -= 28;
  };

  const drawTable = (headers, bodyRows, colWidths, opts = {}) => {
    if (!headers.length && !bodyRows.length) return;
    const bodySize = opts.bodySize || 7;
    const headerSize = opts.headerSize || 7;
    const baseRowH = opts.rowH || 16;
    const totalW = colWidths.reduce((a, b) => a + b, 0);
    const scale = totalW > CONTENT_W ? CONTENT_W / totalW : 1;
    const widths = colWidths.map((w) => w * scale);
    const textPad = 10;

    if (headers.length) {
      ensure(baseRowH + 6);
      page.drawRectangle({ x: M_LEFT, y: y - baseRowH, width: CONTENT_W, height: baseRowH, color: navy });
      let hx = M_LEFT;
      headers.forEach((h, i) => {
        page.drawText(winAnsiSafe(h), { x: hx + 3, y: y - textPad, size: headerSize, font: bold, color: white });
        hx += widths[i];
      });
      y -= baseRowH;
      page.drawLine({ start: { x: M_LEFT, y }, end: { x: M_RIGHT, y }, thickness: 0.5, color: cobalt });
    }

    bodyRows.forEach((cells, ri) => {
      const rowH = baseRowH;
      ensure(rowH + 4);
      if (ri % 2 === 1) {
        page.drawRectangle({ x: M_LEFT, y: y - rowH, width: CONTENT_W, height: rowH, color: rowAlt });
      }
      let x = M_LEFT;
      cells.forEach((cell, i) => {
        const txt = winAnsiSafe(String(cell ?? dash));
        page.drawText(txt, {
          x: x + 3,
          y: y - textPad,
          size: bodySize,
          font: i === 0 ? bold : font,
          color: i === 0 ? navy : ink,
        });
        x += widths[i];
      });
      y -= rowH;
      page.drawLine({ start: { x: M_LEFT, y }, end: { x: M_RIGHT, y }, thickness: 0.35, color: lineC });
    });
    gap(8);
  };

  // ── masthead ───────────────────────────────────────────────────────────────
  const headerH = 96;
  const headerTop = y;
  page.drawRectangle({ x: M_LEFT, y: headerTop - headerH, width: CONTENT_W, height: headerH, color: rgb(0.90, 0.945, 0.985), borderColor: navy, borderWidth: 1 });
  const logoTop = headerTop - 10;
  const imgH = drawLogo(page, M_LEFT + 10, logoTop, 44);
  let titleY = logoTop - imgH - 10;
  page.drawText(winAnsiSafe("Bill of Quantities"), { x: M_LEFT + 10, y: titleY, size: 9, font: bold, color: cobalt });
  titleY -= 18;
  page.drawText(winAnsiSafe(projectName || "Untitled project"), { x: M_LEFT + 10, y: titleY, size: 15, font: serif, color: navy });
  const dateStr = winAnsiSafe(`Date: ${new Date().toLocaleDateString()}`);
  page.drawText(dateStr, {
    x: M_RIGHT - 10 - font.widthOfTextAtSize(dateStr, 9),
    y: headerTop - 16,
    size: 9,
    font,
    color: muted,
  });
  y = headerTop - headerH - 10;

  if (grand.sheets != null) {
    const summary = winAnsiSafe(
      `${grand.sheets} sheet${grand.sheets === 1 ? "" : "s"} · ${grand.shapes_n} mask${grand.shapes_n === 1 ? "" : "s"} · ${fmt(grand.floor)} ${AU} floor`
      + (grand.wall > 0 ? ` · ${fmt(grand.wall)} ${AU} wall` : ""),
    );
    ensure(18);
    page.drawText(summary, { x: M_LEFT, y: y - 10, size: 9.5, font: bold, color: navy });
    y -= 22;
  }

  const headers = ["Room", "Finish", "Floor", "Wall", "LF", "EA", "Qty", "Unit", "Rate", "Amt", "Notes"];
  const colWidths = [54, 50, 34, 34, 28, 22, 30, 26, 36, 42, 58];

  const rowCells = (r) => [
    trunc(r.room),
    trunc(r.finish),
    r.floor_sf ? fmt(r.floor_sf) : dash,
    r.wall_sf ? fmt(r.wall_sf) : dash,
    r.lf ? fmt(r.lf) : dash,
    r.ea ? fmt(r.ea, 0) : dash,
    r.qty != null && r.qty !== "" ? fmt(r.qty, 2) : dash,
    r.unit || dash,
    r.rate ? fmt(r.rate, 2) : dash,
    r.amount ? money(r.amount, currency).replace(/\s/g, " ") : dash,
    trunc(r.notes, 20),
  ];

  for (const sh of sheets) {
    section(sh.title || sh.sheet || "Sheet", 64);
    if (sh.subtitle) {
      ensure(16);
      page.drawText(winAnsiSafe(sh.subtitle), { x: M_LEFT + 4, y: y - 10, size: 8.5, font, color: muted });
      y -= 18;
    }
    const body = (sh.rows || []).map(rowCells);
    drawTable(headers, body, colWidths, { rowH: 16, bodySize: 7 });

    if (sh.roomSummary?.length) {
      ensure(24);
      page.drawText(winAnsiSafe(`Room summary · ${fmt(sh.floorTotal || 0)} ${AU} total masked`), {
        x: M_LEFT + 4, y: y - 10, size: 8.5, font: bold, color: cobalt,
      });
      y -= 16;
      const rmBody = sh.roomSummary.map((rm) => [
        rm.room,
        rm.floor_sf ? `${fmt(rm.floor_sf)} ${AU}` : dash,
        rm.wall_sf ? `${fmt(rm.wall_sf)} ${AU} wall` : dash,
        rm.masks > 1 ? `${rm.masks} masks` : dash,
      ]);
      drawTable(["Room", "Floor", "Wall", "Masks"], rmBody, [140, 80, 80, 50], { rowH: 15, bodySize: 7.5 });
    }
    gap(6);
  }

  if (manualLines.length) {
    section("Manual lines", 48);
    const body = manualLines.map(rowCells);
    drawTable(headers, body, colWidths, { rowH: 16, bodySize: 7 });
  }

  drawFooter(page, pageNo);

  const bytes = await doc.save();
  const base = (projectName || "takeoff").replace(/[^\w.-]+/g, "_");
  return { bytes, filename: `${base}_boq.pdf` };
}
