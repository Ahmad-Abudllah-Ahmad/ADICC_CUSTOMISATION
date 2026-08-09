// Bottom pill — open sheets slide out horizontally with own backdrop (portal).
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../brand/icons.jsx";

export default function OpenSheetsPill({
  openTabs = [],
  sheetGroup = [],
  sheetKey,
  tabLabel,
  onGoToSheet,
  onToggleInGroup,
  onCloseTab,
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!openTabs.length) setOpen(false);
  }, [openTabs.length]);

  if (!openTabs.length) return null;

  const ui = (
    <>
      <div
        style={{
          position: "fixed",
          left: 14,
          bottom: 14,
          zIndex: 41,
          maxWidth: "calc(50vw - 90px)",
          pointerEvents: "none",
        }}
      >
        <div
          className="sheets-pill-glass"
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "stretch",
            borderRadius: 999,
            overflow: "hidden",
            transition: "box-shadow 0.28s ease",
          }}
        >
          <button
            type="button"
            className={`sheets-pill-glass-trigger${open ? " is-open" : ""}`}
            onClick={() => setOpen((v) => !v)}
            title={open ? "Hide open sheets" : "Show open sheets"}
            aria-expanded={open}
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "6px 10px",
              border: "none",
              borderRight: open ? "1px solid var(--ink-faint)" : "none",
              cursor: "pointer",
              fontFamily: "var(--f-mono)",
              fontSize: 10,
            }}
          >
            <Icon name="document" size={11} />
            <span style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: "0.1em", opacity: open ? 0.75 : 0.9 }}>Sheets</span>
            <span style={{ fontWeight: 700, fontSize: 10 }}>{openTabs.length}</span>
            <Icon name={open ? "chevronLeft" : "chevronRight"} size={9} />
          </button>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              overflow: "hidden",
              maxWidth: open ? "min(calc(50vw - 120px), 520px)" : 0,
              opacity: open ? 1 : 0,
              transition: "max-width 0.36s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.22s ease",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 4,
                alignItems: "center",
                padding: "5px 8px 5px 6px",
                overflowX: "auto",
                whiteSpace: "nowrap",
              }}
            >
              {openTabs.map((k) => {
                const inGroup = sheetGroup.includes(k);
                const on = sheetGroup.length ? inGroup : k === sheetKey;
                const lbl = tabLabel(k);
                return (
                  <span
                    key={k}
                    className={`sheets-pill-glass-tab${on ? " is-on" : ""}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      borderBottom: on ? "2px solid var(--cobalt)" : "1px solid var(--ink-faint)",
                      padding: "2px 4px 2px 6px",
                      maxWidth: 155,
                      flexShrink: 0,
                      borderRadius: 5,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => { onGoToSheet(k); }}
                      title={k}
                      style={{
                        border: "none",
                        background: "none",
                        cursor: "pointer",
                        fontWeight: on ? 700 : 500,
                        fontSize: 10,
                        color: "var(--ink)",
                        fontFamily: "var(--f-mono)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: 105,
                        padding: 0,
                      }}
                    >
                      {lbl}
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleInGroup(k)}
                      title={inGroup ? "Remove from side-by-side" : "Side-by-side with the current sheet"}
                      style={{ border: "none", background: "none", cursor: "pointer", color: "var(--c-positive)", padding: 0, display: "inline-flex" }}
                    >
                      <Icon name="sideBySide" size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onCloseTab(k)}
                      title="Close tab"
                      style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: 0, display: "inline-flex" }}
                    >
                      <Icon name="close" size={8} />
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return createPortal(ui, document.body);
}
