// Isolated chrome light/dark control. Calls existing toggleTheme(); does not
// touch canvas sheet-invert (darkMode / opentakeoff_dark).
import React, { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { getTheme, toggleTheme, onThemeChange } from "../lib/theme.js";

export default function ThemeToggle() {
  const [theme, setTheme] = useState(getTheme);
  useEffect(() => onThemeChange(setTheme), []);
  const dark = theme === "dark";
  return (
    <button
      type="button"
      className={`canvas-circle-btn${dark ? " is-chrome-dark" : ""}`}
      onClick={() => toggleTheme()}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={dark}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        minWidth: 32,
        minHeight: 32,
        padding: 0,
        border: "none",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        flexShrink: 0,
        boxShadow: "none",
      }}
    >
      {dark ? <Sun size={15} strokeWidth={1.5} /> : <Moon size={15} strokeWidth={1.5} />}
    </button>
  );
}
