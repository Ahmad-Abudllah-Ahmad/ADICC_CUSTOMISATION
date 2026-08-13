// Set the theme before first paint (no flash of the wrong theme).
// Default is LIGHT. An explicit stored choice, ?theme=, or parent
// `adicc:theme` message can switch it. We do NOT follow OS prefers-color-scheme
// — that used to stamp Windows dark-mode into localStorage and made chrome
// look "dark" with no working toggle.
//
// This lives as a same-origin file rather than an inline <script> ON PURPOSE:
// it lets the deployed app ship a strict Content-Security-Policy with
// `script-src 'self'` (no 'unsafe-inline', no per-file hash to keep in sync) —
// see public/_headers. It must stay a render-blocking classic script in <head>
// (no async/defer) so it runs before the first paint.
(function () {
  var t = null;
  // Parent ADICC platform may pass ?theme= when embedding this app in an iframe.
  try {
    var qt = new URLSearchParams(location.search).get("theme");
    if (qt === "light" || qt === "dark") t = qt;
  } catch (e) {}

  // Previous builds followed OS and wrote that into localStorage, so Windows
  // dark-mode users landed on dark chrome. One-time reset to light; after this,
  // only an explicit choice (in-app button / ?theme= / parent message) persists.
  try {
    if (!localStorage.getItem("adicc_theme_migrated_v1")) {
      localStorage.setItem("adicc_theme_migrated_v1", "1");
      if (t !== "light" && t !== "dark") {
        localStorage.setItem("opentakeoff_theme", "light");
      }
    }
  } catch (e) {}

  if (t !== "light" && t !== "dark") {
    try { t = localStorage.getItem("opentakeoff_theme"); } catch (e) {}
  }
  if (t !== "light" && t !== "dark") t = "light";
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("opentakeoff_theme", t); } catch (e) {}
  document.querySelector('meta[name="theme-color"]')
    .setAttribute("content", t === "dark" ? "#1a2332" : "#fafaf8");
})();
