// ToolMenu — brand dropdown for the takeoff toolbar (and tab overflow).
// STACK-style state+switcher: the trigger face can show the currently armed
// tool while the panel switches it. Square corners, paper/ink/cobalt tokens.
//
// Beyond plain action items it also serves the two-deck toolbar's chips:
// `faceStyle`/`menuStyle` restyle the trigger and panel (scale chip, account
// chip), items may be `{ section }`, `"divider"`, `{ note }` (muted footnote),
// `{ custom }` (arbitrary row, e.g. the fill-sensitivity slider — interacting
// inside it never closes the menu), and `{ checked, stayOpen }` checkable
// items that flip in place (render menu). An item may carry `onHover(bool)` to
// preview its effect while pointed at (the scale menu's plan-says item shows
// the calibrated guide bar on the sheet behind the open menu).
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../brand/icons.jsx";

const MENU_W = 232;

function renderPaletteItems(items, setOpen) {
  return items.map((it, i) => {
    if (it === "divider") return <div key={`d-${i}`} className="tool-menu-palette-divider" aria-hidden="true" />;
    if (it.section || it.note || it.custom) return null;
    const dis = !!it.disabled;
    const danger = !!(it.danger || it.tint === "var(--c-danger)");
    return (
      <button
        key={it.id || i}
        type="button"
        role="menuitem"
        disabled={dis}
        title={it.title || it.label || ""}
        className={`takeoff-sticky-opt${it.active ? " is-active" : ""}${danger ? " is-danger" : ""}`}
        onClick={() => { if (!dis) { if (!it.stayOpen) setOpen(false); it.onSelect?.(); } }}
      >
        {it.icon && <Icon name={it.icon} size={15} />}
        {it.label}
      </button>
    );
  });
}

export default function ToolMenu({ face, active = false, accent = "cobalt", title = "", items, onOpenChange, faceStyle, menuStyle, disabled = false, variant = "default", circleTrigger = false, paletteAnchor = false, compactFace = false }) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const isPalette = variant === "palette";
  const usePalettePosition = isPalette || paletteAnchor;

  const renderDefaultMenu = () => items.map((it, i) => {
    if (it === "divider") return <div key={i} style={{ height: 1, background: "var(--ink-faint)", margin: "4px 0" }} />;
    if (it.section) return (
      <div key={i} style={{ padding: "6px 12px 3px", fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--ink-muted)" }}>{it.section}</div>
    );
    if (it.note) return (
      <div key={i} style={{ padding: "6px 12px 8px", fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.4 }}>{it.note}</div>
    );
    if (it.custom) return <div key={it.id || i}>{it.custom}</div>;
    const dis = !!it.disabled;
    const checkable = "checked" in it;
    const fg = it.danger ? "var(--c-danger)" : "var(--ink)";
    return (
      <button key={it.id || i} type="button" disabled={dis} title={it.title || ""}
        onClick={() => { if (!dis) { if (!it.stayOpen) setOpen(false); it.onSelect?.(); } }}
        style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 12px",
          border: "none", textAlign: "left", cursor: dis ? "default" : "pointer",
          background: it.active ? "var(--paper-cream)" : "transparent",
          borderLeft: it.active ? "2px solid var(--cobalt)" : "2px solid transparent",
          opacity: dis ? 0.38 : 1, color: fg,
        }}
        onMouseEnter={(e) => { if (!dis && !it.active) e.currentTarget.style.background = "var(--paper-shadow)"; if (!dis) it.onHover?.(true); }}
        onMouseLeave={(e) => { e.currentTarget.style.background = it.active ? "var(--paper-cream)" : "transparent"; if (!dis) it.onHover?.(false); }}>
        {checkable && <span style={{ display: "inline-flex", width: 15, justifyContent: "center", color: "var(--c-positive)", visibility: it.checked ? "visible" : "hidden" }}><Icon name="check" size={14} /></span>}
        {it.icon && <span style={{ display: "inline-flex", width: 17, justifyContent: "center", color: it.tint || fg }}><Icon name={it.icon} size={16} /></span>}
        <span style={{ flex: 1, fontFamily: "var(--f-body)", fontSize: 13, fontWeight: it.active ? 600 : 400 }}>{it.label}</span>
        {it.shortcut && <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--ink-muted)" }}>{it.shortcut}</span>}
      </button>
    );
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      const inRoot = rootRef.current?.contains(e.target);
      const inPanel = panelRef.current?.contains(e.target);
      if (!inRoot && !inPanel) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Notify strictly in open/close PAIRS: fire true only when opening, and repay
  // it in the cleanup — which also runs if the menu unmounts while open (e.g.
  // sign-out unmounts the account menu mid-click). Calling onOpenChange(open)
  // unconditionally would fire a stray `false` on every closed-menu mount and
  // never fire the closing `false` on unmount, leaking menuDepthRef either way.
  useEffect(() => {
    if (!open) return;
    onOpenChange?.(true);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open || !usePalettePosition) return undefined;
    const PALETTE_PANEL_GAP = 38;
    const place = () => {
      if (!panelRef.current) return;
      const stack = document.querySelector(".takeoff-sticky-menu--stack");
      const preset = stack?.style.getPropertyValue("--palette-panel-top");
      const anchor = stack || rootRef.current;
      const top = preset || (anchor ? `${anchor.getBoundingClientRect().bottom + PALETTE_PANEL_GAP}px` : "166px");
      panelRef.current.style.setProperty("--tool-menu-panel-top", top);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, usePalettePosition]);

  const accentColor = accent === "danger" ? "var(--c-danger)" : "var(--cobalt)";
  const menuW = (menuStyle && parseInt(menuStyle.minWidth, 10)) || MENU_W;
  const toggle = () => {
    if (disabled) return;
    if (!open && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect();
      setFlip(r.left + menuW > window.innerWidth - 16);
    }
    setOpen((v) => !v);
  };

  const anchoredPanel = (
    <div ref={panelRef} className="tool-menu-palette-shell">
      <svg className="takeoff-sticky-panel-curve takeoff-sticky-panel-curve--left" viewBox="0 0 22 34" aria-hidden="true">
        <path d="M 3 0 C 3 11, 17 22, 20 34" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <div className="tool-menu-anchored-panel" role="menu" style={{ minWidth: MENU_W, ...menuStyle }}>
        {renderDefaultMenu()}
      </div>
      <svg className="takeoff-sticky-panel-curve takeoff-sticky-panel-curve--right" viewBox="0 0 22 34" aria-hidden="true">
        <path d="M 19 0 C 19 11, 5 22, 2 34" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );

  const triggerClass = circleTrigger
    ? `angle-dial-btn${open ? " is-on" : ""}`
    : [
        "tool-menu-trigger",
        active ? "is-active" : "",
        open && !active ? "is-open" : "",
        accent === "danger" && active ? "is-accent-danger" : "",
      ].filter(Boolean).join(" ");

  return (
    <span ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" onClick={toggle} title={title} disabled={disabled}
        className={triggerClass}
        style={circleTrigger ? { opacity: disabled ? 0.38 : 1, cursor: disabled ? "default" : "pointer", ...faceStyle } : {
          display: "inline-flex", alignItems: "center", gap: compactFace ? 3 : 7, padding: compactFace ? "4px 7px" : "6px 10px", cursor: disabled ? "default" : "pointer",
          border: `1px solid ${active ? accentColor : "var(--ink-faint)"}`,
          background: active ? accentColor : (open ? "var(--paper-shadow)" : "transparent"),
          color: active ? "var(--paper-bright)" : "var(--ink)",
          opacity: disabled ? 0.38 : 1,
          fontFamily: "var(--f-body)", fontSize: compactFace ? 11 : 12.5, fontWeight: 600, lineHeight: 1,
          borderRadius: compactFace ? 20 : undefined,
          ...faceStyle,
        }}>
        {face}
        {!circleTrigger && <span style={{ display: "inline-flex", opacity: 0.7 }}><Icon name="chevronDown" size={compactFace ? 10 : 11} /></span>}
      </button>
      {open && isPalette && (
        <div ref={panelRef} className="tool-menu-palette-shell">
          <svg className="takeoff-sticky-panel-curve takeoff-sticky-panel-curve--left" viewBox="0 0 22 34" aria-hidden="true">
            <path d="M 3 0 C 3 11, 17 22, 20 34" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <div className="takeoff-sticky-panel tool-menu-palette-panel" role="menu">
            <div className="tool-menu-palette-inner">
              {renderPaletteItems(items, setOpen)}
            </div>
          </div>
          <svg className="takeoff-sticky-panel-curve takeoff-sticky-panel-curve--right" viewBox="0 0 22 34" aria-hidden="true">
            <path d="M 19 0 C 19 11, 5 22, 2 34" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      )}
      {open && !isPalette && paletteAnchor && (typeof document !== "undefined"
        ? createPortal(anchoredPanel, document.body)
        : anchoredPanel)}
      {open && !isPalette && !paletteAnchor && (
        <div className="tool-menu-drop-panel" style={{
          position: "absolute", top: "calc(100% + 4px)", [flip ? "right" : "left"]: 0, zIndex: 60,
          minWidth: MENU_W, padding: "4px 0",
          ...menuStyle,
          maxHeight: "min(60vh, 420px)",
          overflowY: "auto",
        }}>
          {renderDefaultMenu()}
        </div>
      )}
    </span>
  );
}
