// Browser-only OCR of the title-block table. Used by ingest when a split page
// has no usable PDF text layer (scans / outlined CAD). Worker, wasm, and
// English traineddata are served from public/tesseract/ (copied at install).

import { parseDrawingTitleFromOcr } from "./sheets.ts";

const LEFT_CROP = { x0: 0, y0: 0.78, x1: 0.22, y1: 1 };
const RIGHT_CROP = { x0: 0.76, y0: 0.55, x1: 1, y1: 0.88 };

function publicTesseractUrl(file = "") {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
  const origin = (typeof window !== "undefined" && window.location?.origin) || "";
  return `${origin}${base}tesseract${file ? `/${file}` : ""}`;
}

async function renderCrop(page, viewport, frac) {
  const scale = Math.min(2.2, 1800 / Math.max(viewport.width, 1));
  const vp = page.getViewport({ scale });
  const x = frac.x0 * vp.width;
  const y = frac.y0 * vp.height;
  const w = Math.max(8, (frac.x1 - frac.x0) * vp.width);
  const h = Math.max(8, (frac.y1 - frac.y0) * vp.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w);
  canvas.height = Math.ceil(h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(-x, -y);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  ctx.restore();
  return canvas;
}

export async function createSheetTitleOcr() {
  if (typeof document === "undefined") return null;
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: publicTesseractUrl("worker.min.js"),
    corePath: publicTesseractUrl(),
    langPath: publicTesseractUrl(),
    gzip: true,
    workerBlobURL: false,
  });
  return {
    async readPage(page, viewport) {
      const left = await renderCrop(page, viewport, LEFT_CROP);
      const leftText = (await worker.recognize(left)).data?.text || "";
      if (parseDrawingTitleFromOcr(leftText)) return leftText;
      const right = await renderCrop(page, viewport, RIGHT_CROP);
      const rightText = (await worker.recognize(right)).data?.text || "";
      return [leftText, rightText].filter(Boolean).join("\n");
    },
    terminate: () => worker.terminate(),
  };
}
