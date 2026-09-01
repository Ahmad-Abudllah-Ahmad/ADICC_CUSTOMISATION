// Copy Tesseract worker + wasm cores into public/ so title-block OCR stays
// same-origin (no CDN for the engine). Language data is fetched once if missing.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "public/tesseract");
mkdirSync(destDir, { recursive: true });

const workerSrc = join(root, "node_modules/tesseract.js/dist/worker.min.js");
copyFileSync(workerSrc, join(destDir, "worker.min.js"));

const coreDir = join(root, "node_modules/tesseract.js-core");
for (const name of readdirSync(coreDir)) {
  if (!/^tesseract-core.*\.(js|wasm)$/.test(name)) continue;
  copyFileSync(join(coreDir, name), join(destDir, name));
}

const langDest = join(destDir, "eng.traineddata.gz");
if (!existsSync(langDest)) {
  const url = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz";
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    writeFileSync(langDest, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    console.warn("tesseract lang data not cached (OCR will fetch on first use):", err.message || err);
  }
}

console.log("Copied tesseract worker/core → public/tesseract/");
