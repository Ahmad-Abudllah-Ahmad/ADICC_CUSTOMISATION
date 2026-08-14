// Isolated chrome light/dark control. Calls existing toggleTheme(); does not
// touch canvas sheet-invert (darkMode / opentakeoff_dark).
import React, { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { getTheme, toggleTheme, onThemeChange } from "../lib/theme.js";

export default function ThemeToggle({ className }) {
  const [theme, setTheme] = useState(getTheme);
  useEffect(() => onThemeChange(setTheme), []);
  const dark = theme === "dark";
  const cls = className || "canvas-circle-btn";
  const inToolbar = cls.includes("mode-circle-btn");
  return (
    <button
      type="button"
      className={`${cls}${dark && !inToolbar ? " is-chrome-dark" : ""}`}
      onClick={() => toggleTheme()}
      data-tip={inToolbar ? (dark ? "Light mode" : "Dark mode") : undefined}
      title={inToolbar ? undefined : (dark ? "Switch to light mode" : "Switch to dark mode")}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={dark}
      style={inToolbar ? undefined : {
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
