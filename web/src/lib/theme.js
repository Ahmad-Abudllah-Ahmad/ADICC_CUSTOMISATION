// App chrome theme (light/dark). The <html data-theme> attribute is the source
// of truth — theme-init.js sets it before first paint. This module changes it
// and keeps it in sync across tabs and the parent ADICC iframe. tokens.css does
// the actual theming. Orthogonal to the canvas ☾ invert (opentakeoff_dark),
// which is a per-sheet work-mode preference that flows into the marked-set export.
//
// Default is LIGHT. OS prefers-color-scheme is ignored so Windows dark mode
// cannot paint the chrome dark while the user thinks they are in light mode.

const KEY = "opentakeoff_theme";
const EVT = "opentakeoff:theme";

function apply(t) {
  document.documentElement.setAttribute("data-theme", t);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", t === "dark" ? "#1a2332" : "#fafaf8");
  window.dispatchEvent(new CustomEvent(EVT, { detail: t }));
}

export function getTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function setTheme(t) {
  if (t !== "light" && t !== "dark") return getTheme();
  apply(t);
  try { localStorage.setItem(KEY, t); } catch { /* private mode — session-only */ }
  return t;
}

export function toggleTheme() {
  return setTheme(getTheme() === "dark" ? "light" : "dark");
}

// Subscribe React state to any theme change (toggle, other tab, parent iframe).
// Returns the unsubscribe fn, so it can be a useEffect body directly.
export function onThemeChange(fn) {
  const h = (e) => fn(e.detail);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}

// Call once at startup. An explicit choice made in another tab syncs here via
// `storage` (which never fires in the tab that set it, so no double-apply).
// Also accepts theme sync from the parent ADICC platform iframe host.
export function initTheme() {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY && (e.newValue === "light" || e.newValue === "dark")) apply(e.newValue);
  });
  window.addEventListener("message", (e) => {
    const d = e?.data;
    if (!d || d.type !== "adicc:theme") return;
    if (d.theme === "light" || d.theme === "dark") setTheme(d.theme);
  });
}
