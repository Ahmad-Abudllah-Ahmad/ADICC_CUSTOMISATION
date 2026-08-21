// Isolated chrome light/dark control. Calls existing toggleTheme(); does not
// touch canvas sheet-invert (darkMode / opentakeoff_dark).
import React, { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { getTheme, toggleTheme, onThemeChange } from "../lib/theme.js";

export default function ThemeToggle({ className }) {
  return null;
}
