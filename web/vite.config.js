import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The one source of truth for the app version — package.json — inlined as
// __APP_VERSION__ so contributions can carry generator_version without a
// runtime fetch. Guarded with `typeof` at the use site so the Node test
// runner (no Vite, no define) sees plain undefined instead of a crash.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// OpenTakeoff is a client-only static app: the takeoff canvas runs entirely in
// the browser (pdf.js + canvas + the geometry libs), persists to IndexedDB /
// localStorage, and builds to a static `dist/` you can host anywhere (GitHub
// Pages, Vercel, Netlify, an S3 bucket).
//
// The `/ai` proxy is OPTIONAL — it only matters if you run the bring-your-own-
// model AI sandbox in `../server` (see server/README.md). Without it, the app
// works fully; the AI hooks just stay dormant.
export default defineConfig({
  // Local/dev: /takeoff/ (platform Next rewrite). Render static site: set VITE_BASE=/
  // so built assets match the publish root (/assets, /theme-init.js).
  base: process.env.VITE_BASE || "/takeoff/",
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // The STT worker (stt.worker.ts, RFC #59) lazy-imports its engine adapter,
  // which needs code-splitting inside the worker bundle — only the ES format
  // supports that (Vite's default iife errors on split worker builds).
  worker: { format: "es" },
  optimizeDeps: {
    exclude: ["@mlightcad/libredwg-web"],
  },
  assetsInclude: ["**/*.wasm"],
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    // HMR stays on the Vite port so the platform proxy only needs HTTP.
    hmr: { host: "127.0.0.1", port: 5180, clientPort: 5180 },
    proxy: {
      "/ai": "http://localhost:8000",
      "/rag": {
        target: "http://127.0.0.1:8001",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rag/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
