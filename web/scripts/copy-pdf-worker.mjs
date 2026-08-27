// Copy pdf.js worker into public/ so Vite can serve it at /pdf.worker.min.mjs.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
const destDir = join(root, "public");
const dest = join(destDir, "pdf.worker.min.mjs");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("Copied pdf.worker.min.mjs → public/");
