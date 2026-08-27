// Shared pdf.js worker URL for Vite.
// TakeoffCanvas and ProjectPdfSlider set GlobalWorkerOptions.workerSrc from
// this so PDF parse/render stay on the bundled worker (same `?url` import
// the app used before this helper existed).
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export function pdfjsWorkerSrc() {
  return workerUrl;
}
