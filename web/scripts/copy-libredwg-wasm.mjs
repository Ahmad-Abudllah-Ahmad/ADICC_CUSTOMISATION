// Copy LibreDWG wasm into public/ so Vite can serve it at /libredwg/libredwg-web.wasm.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm");
const destDir = join(root, "public/libredwg");
const dest = join(destDir, "libredwg-web.wasm");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("Copied libredwg-web.wasm → public/libredwg/");
