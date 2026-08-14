// Monoline icon set. 24x24 grid, 1.5px stroke.

function I({ children, size = 24, stroke = 1.5, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="square" strokeLinejoin="miter">
      {children}
    </svg>
  );
}

export const icons = {
  logo: (s) => <I size={s}><path d="M2 18 C 7 18, 7 6, 12 12 S 17 18, 22 6" /><circle cx="7" cy="14" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="17" cy="10" r="1" fill="currentColor" /></I>,
  spec: (s) => <I size={s}><path d="M5 3 H 16 L 19 6 V 21 H 5 Z" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></I>,
  document: (s) => <I size={s}><path d="M6 3 H 16 L 19 6 V 21 H 6 Z" /><path d="M16 3 V 6 H 19" /><line x1="9" y1="12" x2="16" y2="12" /><line x1="9" y1="16" x2="16" y2="16" /></I>,
  product: (s) => <I size={s}><rect x="3" y="7" width="18" height="13" /><path d="M3 7 L 12 3 L 21 7" /><line x1="12" y1="3" x2="12" y2="20" /></I>,
  takeoff: (s) => <I size={s}><rect x="3" y="3" width="18" height="18" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="3" x2="9" y2="21" /><circle cx="15" cy="15" r="1.2" fill="currentColor" /></I>,
  plus: (s) => <I size={s}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></I>,
  search: (s) => <I size={s}><circle cx="11" cy="11" r="6.5" /><line x1="16" y1="16" x2="20.5" y2="20.5" /></I>,

  // ── takeoff canvas set — drafting monoline, vertex-dot motif on measure tools ──
  pan: (s) => (
    <i className="fa-solid fa-hand-wave" aria-hidden="true" style={{ fontSize: s, lineHeight: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", width: s, height: s }}>
      <svg width={s} height={s} viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">
        <path d="M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 208c0 8.8-7.2 16-16 16s-16-7.2-16-16l0-176c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 272c0 1.5 0 3.1 .1 4.6L67.6 283c-16-15.2-41.3-14.6-56.6 1.4S-3.6 325.7 12.4 341L124.8 448c43.1 41.1 100.4 64 160 64l19.2 0c97.2 0 176-78.8 176-176l0-208c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 112c0 8.8-7.2 16-16 16s-16-7.2-16-16l0-176c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 176c0 8.8-7.2 16-16 16s-16-7.2-16-16l0-208z" />
      </svg>
    </i>
  ),
  select: (s) => <I size={s}><path d="M5 3 V 19 L 9.5 14.5 L 12.5 20 L 14.5 18 L 11.5 12.5 L 19.5 12.5 L 5 3 Z" fill="currentColor" stroke="none" /></I>,
  calibrate: (s) => <I size={s}><circle cx="12" cy="4.6" r="1.4" /><path d="M11.2 5.9 L 7 19 M12.8 5.9 L 17 19" /><path d="M5.8 17.4 L 8.2 18.4 M18.2 17.4 L 15.8 18.4" /></I>,
  area: (s) => <I size={s}><path d="M12 4 L 20 10 L 17 19 L 7 19 L 4 10 Z" /><circle cx="12" cy="4" r="1.1" fill="currentColor" /><circle cx="20" cy="10" r="1.1" fill="currentColor" /><circle cx="17" cy="19" r="1.1" fill="currentColor" /><circle cx="7" cy="19" r="1.1" fill="currentColor" /><circle cx="4" cy="10" r="1.1" fill="currentColor" /></I>,
  rectTool: (s) => <I size={s}><rect x="4" y="6" width="16" height="12" /><circle cx="4" cy="6" r="1.1" fill="currentColor" /><circle cx="20" cy="6" r="1.1" fill="currentColor" /><circle cx="20" cy="18" r="1.1" fill="currentColor" /><circle cx="4" cy="18" r="1.1" fill="currentColor" /></I>,
  linear: (s) => <I size={s}><path d="M3 17 L 9 9 L 15 13 L 21 5" /><circle cx="3" cy="17" r="1.1" fill="currentColor" /><circle cx="9" cy="9" r="1.1" fill="currentColor" /><circle cx="15" cy="13" r="1.1" fill="currentColor" /><circle cx="21" cy="5" r="1.1" fill="currentColor" /></I>,
  curve: (s) => <I size={s}><path d="M3 18 C 8 18, 8 6, 12.5 6 C 17 6, 17 13, 21 13" /><circle cx="3" cy="18" r="1.1" fill="currentColor" /><circle cx="12.5" cy="6" r="1.1" fill="currentColor" /><circle cx="21" cy="13" r="1.1" fill="currentColor" /></I>,
  surface: (s) => <I size={s}><line x1="3" y1="20" x2="21" y2="20" /><path d="M8 20 V 7 H 16 V 20" /><path d="M12 16.5 V 10 M12 10 L 10.2 11.8 M12 10 L 13.8 11.8" /></I>,
  count: (s) => <I size={s}><rect x="4" y="4" width="4.5" height="4.5" fill="currentColor" stroke="none" /><rect x="15" y="5.5" width="4.5" height="4.5" fill="currentColor" stroke="none" /><rect x="6.5" y="13.5" width="4.5" height="4.5" fill="currentColor" stroke="none" /><rect x="15" y="15" width="4.5" height="4.5" /></I>,
  deduct: (s) => <I size={s}><path d="M12 4 L 20 10 L 17 19 L 7 19 L 4 10 Z" /><line x1="9" y1="13" x2="15" y2="13" /></I>,
  measure: (s) => <I size={s}><path d="M4 8 H 20" /><path d="M4 8 V 16 H 20 V 8" /><line x1="7" y1="8" x2="7" y2="11.5" /><line x1="10" y1="8" x2="10" y2="10.5" /><line x1="13" y1="8" x2="13" y2="11.5" /><line x1="16" y1="8" x2="16" y2="10.5" /><circle cx="20" cy="12" r="1.1" fill="currentColor" /></I>,
  cutOut: (s) => <I size={s}><path d="M12 4 L 20 10 L 17 19 L 7 19 L 4 10 Z" /><circle cx="12" cy="4" r="1" fill="currentColor" /><circle cx="20" cy="10" r="1" fill="currentColor" /><circle cx="17" cy="19" r="1" fill="currentColor" /><circle cx="7" cy="19" r="1" fill="currentColor" /><circle cx="4" cy="10" r="1" fill="currentColor" /><line x1="9" y1="13" x2="15" y2="13" strokeWidth="2" /></I>,
  edit: (s) => <I size={s}><path d="M14.2 5.2 L 18.8 9.8 L 8.5 20 H 4 V 15.5 Z" /><path d="M12.6 6.8 L 17.2 11.4" /></I>,
  deductRect: (s) => <I size={s}><rect x="4" y="6" width="16" height="12" /><line x1="9" y1="12" x2="15" y2="12" /></I>,
  snap: (s) => (
    <svg width={s} height={s} viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">
      <g transform="translate(256 268) rotate(-42) scale(0.84) translate(-224 -268)">
        <path d="M0 176L0 288C0 411.7 100.3 512 224 512S448 411.7 448 288l0-112-128 0 0 112c0 53-43 96-96 96s-96-43-96-96l0-112-128 0zm0-48l128 0 0-64c0-17.7-14.3-32-32-32L32 32C14.3 32 0 46.3 0 64l0 64zm320 0l128 0 0-64c0-17.7-14.3-32-32-32l-64 0c-17.7 0-32 14.3-32 32l0 64z" />
        <path d="M206 4 L230 48 L214 48 L232 96 L190 40 L208 40 Z" />
      </g>
    </svg>
  ),
  angle: (s) => <I size={s}><path d="M4 19 H 20" /><path d="M4 19 L 17 6" /><path d="M12 19 a 8 8 0 0 0 -2.3 -5.7" /></I>,
  cloud: (s) => <I size={s}><path d="M6 9 a2.3 2.3 0 0 1 4 -1.4 a2.3 2.3 0 0 1 4 0 a2.3 2.3 0 0 1 4 1.4 a2.3 2.3 0 0 1 0.4 3 a2.3 2.3 0 0 1 -0.4 3 a2.3 2.3 0 0 1 -4 1.4 a2.3 2.3 0 0 1 -4 0 a2.3 2.3 0 0 1 -4 -1.4 a2.3 2.3 0 0 1 -0.4 -3 a2.3 2.3 0 0 1 0.4 -3 Z" /></I>,
  callout: (s) => <I size={s}><circle cx="6" cy="17" r="1.1" fill="currentColor" /><line x1="6.8" y1="16.2" x2="13" y2="10" /><rect x="13" y="5.5" width="8" height="6" /></I>,
  textNote: (s) => <I size={s}><path d="M5 5 H 19 M5 5 V 7.5 M19 5 V 7.5 M12 5 V 19 M9.5 19 H 14.5" /></I>,
  highlight: (s) => <I size={s}><rect x="4" y="7" width="16" height="10" /><line x1="7" y1="12" x2="17" y2="12" /></I>,
  highlighter: (s) => <I size={s}><path d="M5 21 L8.5 17.5 M8.5 17.5 L6.8 14 L14 6.8 L17.2 10 L10 17.2 Z M14 6.8 L15.8 5 L19 8.2 L17.2 10" /></I>,
  copy: (s) => <I size={s}><rect x="8" y="8" width="12" height="12" /><path d="M16 8 V 4 H 4 V 16 H 8" /></I>,
  paste: (s) => <I size={s}><rect x="5" y="5" width="14" height="16" /><rect x="9" y="3" width="6" height="4" /><line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="15" y2="16" /></I>,
  duplicate: (s) => <I size={s}><rect x="8" y="8" width="12" height="12" /><path d="M16 8 V 4 H 4 V 16 H 8" /><path d="M12 14 H 16 M14 12 V 16" /></I>,
  undo: (s) => <I size={s}><path d="M9 5 L 5 9 L 9 13" /><path d="M5 9 H 14.5 a 4.8 4.8 0 0 1 0 9.6 H 8" /></I>,
  redo: (s) => <I size={s}><path d="M15 5 L 19 9 L 15 13" /><path d="M19 9 H 9.5 a 4.8 4.8 0 0 0 0 9.6 H 16" /></I>,
  flipH: (s) => <I size={s}><path d="M12 3 V 21" /><path d="M10 8 L 5 12 L 10 16" /><path d="M14 8 L 19 12 L 14 16" /></I>,
  flipV: (s) => <I size={s}><path d="M3 12 H 21" /><path d="M8 10 L 12 5 L 16 10" /><path d="M8 14 L 12 19 L 16 14" /></I>,
  check: (s) => <I size={s}><path d="M5 13 L 10 18 L 19 7" /></I>,
  sheets: (s) => <I size={s}><rect x="4" y="4" width="7" height="7" /><rect x="13" y="4" width="7" height="7" /><rect x="4" y="13" width="7" height="7" /><rect x="13" y="13" width="7" height="7" /></I>,
  // stacked pages — open tabs on the canvas (distinct from the 4-up Files grid)
  openSheets: (s) => <I size={s}><rect x="7" y="4" width="13" height="16" /><path d="M4 7 V 21 H 17" /></I>,
  eye: (s) => <I size={s}><path d="M3 12 C 7 6.5, 17 6.5, 21 12 C 17 17.5, 7 17.5, 3 12 Z" /><circle cx="12" cy="12" r="2.3" /></I>,
  eyeOff: (s) => <I size={s}><path d="M3 12 C 7 6.5, 17 6.5, 21 12 C 17 17.5, 7 17.5, 3 12 Z" /><circle cx="12" cy="12" r="2.3" /><line x1="5" y1="19" x2="19" y2="5" /></I>,
  sideBySide: (s) => <I size={s}><rect x="4" y="5" width="7" height="14" /><rect x="13" y="5" width="7" height="14" /></I>,
  close: (s) => <I size={s}><path d="M6 6 L 18 18 M18 6 L 6 18" /></I>,
  trash: (s) => <I size={s}><path d="M5 7 H 19" /><path d="M9.5 7 V 4.5 H 14.5 V 7" /><path d="M7 7 V 19.5 H 17 V 7" /><line x1="10" y1="10.5" x2="10" y2="16.5" /><line x1="14" y1="10.5" x2="14" y2="16.5" /></I>,
  chevronDown: (s) => <I size={s}><path d="M6 9 L 12 15 L 18 9" /></I>,
  chevronLeft: (s) => <I size={s}><path d="M15 6 L 9 12 L 15 18" /></I>,
  chevronRight: (s) => <I size={s}><path d="M9 6 L 15 12 L 9 18" /></I>,
  markup: (s) => <I size={s}><path d="M5 21 L8.5 17.5 M8.5 17.5 L6.8 14 L14 6.8 L17.2 10 L10 17.2 Z M14 6.8 L15.8 5 L19 8.2 L17.2 10" /></I>,
  // stamp — a press-down rubber stamp over its impression line (the tool-chest motif)
  stamp: (s) => <I size={s}><rect x="8" y="3" width="8" height="6" rx="1" /><path d="M6 15 L 9 9 H 15 L 18 15 Z" /><line x1="4" y1="19" x2="20" y2="19" /></I>,
  // RFI — a hexagon echoing the on-canvas ⬢ RFI marker, with a question motif
  rfi: (s) => <I size={s}><path d="M12 3 L 19 7 V 15 L 12 19 L 5 15 V 7 Z" /><path d="M10 10 a2 2 0 1 1 2.6 1.9 C 12 12.2 12 12.6 12 13.2" /><circle cx="12" cy="15.6" r="0.9" fill="currentColor" /></I>,
  takeoffs: (s) => <I size={s}><rect x="4" y="5" width="3" height="3" fill="currentColor" stroke="none" /><line x1="10" y1="6.5" x2="20" y2="6.5" /><rect x="4" y="10.5" width="3" height="3" fill="currentColor" stroke="none" /><line x1="10" y1="12" x2="20" y2="12" /><rect x="4" y="16" width="3" height="3" fill="currentColor" stroke="none" /><line x1="10" y1="17.5" x2="20" y2="17.5" /></I>,
  // stacked-sheets layers motif — the Illustrator-style Layers panel toggle
  layers: (s) => <I size={s}><path d="M12 3 L 21 8 L 12 13 L 3 8 Z" /><path d="M3 12 L 12 17 L 21 12" /><path d="M3 16 L 12 21 L 21 16" /></I>,
  // padlock — locked / unlocked layer row state
  lock: (s) => <I size={s}><rect x="5" y="10.5" width="14" height="9.5" rx="1" /><path d="M8 10.5 V 7.5 a 4 4 0 0 1 8 0 V 10.5" /><circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" /></I>,
  unlock: (s) => <I size={s}><rect x="5" y="10.5" width="14" height="9.5" rx="1" /><path d="M8 10.5 V 7.5 a 4 4 0 0 1 7.6 -1.6" /><circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" /></I>,
  revisions: (s) => <I size={s}><circle cx="12" cy="12" r="8" /><path d="M12 7.5 V 12 L 15.4 14" /><circle cx="12" cy="12" r="0.9" fill="currentColor" /></I>,
  zone: (s) => <I size={s}><path d="M4 4 H 8 M11 4 H 15 M18 4 H 20 V 6 M20 9 H 20 V 13 M20 16 V 20 H 17 M14 20 H 10 M7 20 H 4 V 16 M4 13 V 9 M4 6 V 4" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /></I>,
  target: (s) => <I size={s}><circle cx="12" cy="12" r="6" /><path d="M12 3 V 7 M12 17 V 21 M3 12 H 7 M17 12 H 21" /><circle cx="12" cy="12" r="1" fill="currentColor" /></I>,
  height: (s) => <I size={s}><line x1="6" y1="4" x2="18" y2="4" /><line x1="6" y1="20" x2="18" y2="20" /><path d="M12 6.5 V 17.5 M12 6.5 L 9.8 8.7 M12 6.5 L 14.2 8.7 M12 17.5 L 9.8 15.3 M12 17.5 L 14.2 15.3" /></I>,
  thickness: (s) => <I size={s}><line x1="5" y1="5" x2="5" y2="19" /><line x1="19" y1="5" x2="19" y2="19" /><path d="M7.5 12 H 16.5 M7.5 12 L 9.7 9.8 M7.5 12 L 9.7 14.2 M16.5 12 L 14.3 9.8 M16.5 12 L 14.3 14.2" /></I>,
  oneClick: (s) => <I size={s}><path d="M9 3 H 3 V 9" /><path d="M15 3 H 21 V 9" /><path d="M3 15 V 21 H 9" /><path d="M21 15 V 21 H 15" /><path d="M12 7.4 L 13.2 10.8 L 16.6 12 L 13.2 13.2 L 12 16.6 L 10.8 13.2 L 7.4 12 L 10.8 10.8 Z" /></I>,
  // Auto-Takeoff — sparkle / shimmer (4-point star + accents)
  sparkle: (s) => <I size={s} stroke={1.6}><path d="M12 3.2 L 13.55 9.05 L 19.5 10.5 L 13.55 11.95 L 12 17.8 L 10.45 11.95 L 4.5 10.5 L 10.45 9.05 Z" fill="currentColor" stroke="none" /><path d="M18.2 4.2 L 18.75 5.85 L 20.4 6.4 L 18.75 6.95 L 18.2 8.6 L 17.65 6.95 L 16 6.4 L 17.65 5.85 Z" fill="currentColor" stroke="none" /><circle cx="6.2" cy="16.8" r="1.05" fill="currentColor" stroke="none" /></I>,
  wallTrace: (s) => <I size={s}><rect x="5" y="5" width="14" height="14" /><rect x="8" y="8" width="8" height="8" fill="currentColor" stroke="none" /><path d="M12 3 V 5 M12 19 V 21 M3 12 H 5 M19 12 H 21" /></I>,
  wallArea: (s) => <I size={s}><path d="M12 4 L 20 10 L 17 19 L 7 19 L 4 10 Z" /><rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none" opacity="0.35" /></I>,
  hiRes: (s) => <I size={s}><rect x="3" y="5" width="18" height="14" /><path d="M7 15 V 9 M7 12 H 10.5 M10.5 9 V 15" /><path d="M14 9 V 15 M14 9 H 15.6 A 3 3 0 0 1 15.6 15 H 14" /></I>,
  // pushpin / thumbtack — the quick-access palette "pin this condition" action.
  // Cap bar at top, tapered body to a collar, needle to the point.
  pin: (s) => <I size={s}><line x1="8" y1="3" x2="16" y2="3" /><path d="M10 3 V 8 L 7 11 H 17 L 14 8 V 3" /><line x1="12" y1="11" x2="12" y2="20" /></I>,
  // mixer sliders — the toolbar render/fill settings menu
  sliders: (s) => <I size={s}><path d="M4 7 H 6.8 M11.2 7 H 20" /><path d="M4 17 H 12.8 M17.2 17 H 20" /><circle cx="9" cy="7" r="2.2" /><circle cx="15" cy="17" r="2.2" /></I>,
  info: (s) => <I size={s} stroke={1.6}><circle cx="12" cy="12" r="8.5" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="8.1" r="0.95" fill="currentColor" /></I>,
  // chrome theme — orthogonal to the canvas ☾ sheet invert
  sun: (s) => <I size={s}><circle cx="12" cy="12" r="4" /><path d="M12 2.8 V 5.2 M12 18.8 V 21.2 M2.8 12 H 5.2 M18.8 12 H 21.2 M5.2 5.2 L 6.9 6.9 M17.1 17.1 L 18.8 18.8 M18.8 5.2 L 17.1 6.9 M6.9 17.1 L 5.2 18.8" /></I>,
  moon: (s) => <I size={s}><path d="M16 3.8 A 8.4 8.4 0 1 0 20.2 15.2 A 6.5 6.5 0 0 1 16 3.8 Z" fill="currentColor" stroke="none" /></I>,
};

export function Icon({ name, size = 18 }) {
  const fn = icons[name] || icons.spec;
  return fn(size);
}
