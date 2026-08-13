// Open sheets on the canvas — docked left-rail window.
// Parent owns goToSheet / toggleInGroup / closeTab / gallery; this view only calls them.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Eye, EyeOff, FileStack, Plus, Search, X } from "lucide-react";

const ICO = { size: 15, strokeWidth: 2 };

export default function OpenSheetsPill({
  openTabs = [],
  sheetGroup = [],
  sheetKey,
  focusKey,
  tabLabel,
  onGoToSheet,
  onToggleInGroup,
  onCloseTab,
  onAdd,
  onClose,
}) {
  const [q, setQ] = useState("");
  const findRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { onClose?.(); return; }
      if (e.key !== "/") return;
      const tg = e.target?.tagName;
      if (tg === "INPUT" || tg === "SELECT" || tg === "TEXTAREA") return;
      e.preventDefault();
      findRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtering = q.trim().length > 0;
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return openTabs.map((k, i) => ({ k, i }));
    return openTabs.map((k, i) => ({ k, i })).filter(({ k }) => {
      const lbl = (tabLabel ? tabLabel(k) : k).toLowerCase();
      return lbl.includes(s) || String(k).toLowerCase().includes(s);
    });
  }, [openTabs, q, tabLabel]);

  const activeKey = (() => {
    if (sheetGroup.length) {
      if (focusKey && sheetGroup.includes(focusKey)) return focusKey;
      if (sheetKey && sheetGroup.includes(sheetKey)) return sheetKey;
      return sheetGroup[0];
    }
    if (sheetKey && openTabs.includes(sheetKey)) return sheetKey;
    return openTabs[0] || "";
  })();

  const onEye = (e, k, visible, inGroup) => {
    e.stopPropagation();
    if (!visible) { onGoToSheet(k); return; }
    if (inGroup && sheetGroup.length >= 2) onToggleInGroup(k);
  };

  return (
    <div className="left-panel-glass open-sheets-panel" role="dialog" aria-label="Open sheets">
      <div className="open-sheets-head">
        <FileStack size={18} strokeWidth={2} />
        <strong>Open set</strong>
        <span className="open-sheets-head-n">{openTabs.length}</span>
        <span style={{ flex: 1 }} />
        {onAdd && (
          <button type="button" className="open-sheets-add" onClick={onAdd} title="Add sheets from the gallery">
            <Plus size={15} strokeWidth={2.25} />Add
          </button>
        )}
        <button type="button" className="lp-tab-close" onClick={onClose} title="Close panel">
          <X size={18} strokeWidth={2} />
        </button>
      </div>

      <label className="open-sheets-find">
        <Search size={16} strokeWidth={2} className="open-sheets-find-ico" aria-hidden="true" />
        <input
          ref={findRef}
          name="open-sheets-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Jump to a sheet"
          aria-label="Filter open sheets"
          autoComplete="off"
        />
        {filtering && <span className="open-sheets-find-n">{shown.length}/{openTabs.length}</span>}
      </label>

      <div className="left-panel-scroll open-sheets-list">
        {shown.length === 0 ? (
          <div className="open-sheets-empty">
            {filtering ? `Nothing matches “${q.trim()}”.` : "No sheets open on the canvas."}
          </div>
        ) : shown.map(({ k, i }) => {
          const inGroup = sheetGroup.includes(k);
          const visible = sheetGroup.length ? inGroup : k === sheetKey;
          const selected = k === activeKey;
          const lbl = tabLabel ? tabLabel(k) : k;
          const n = String(i + 1).padStart(2, "0");
          const canHide = visible && inGroup && sheetGroup.length >= 2;
          return (
            <div
              key={k}
              className={`open-sheets-row${selected ? " is-on" : ""}${visible && !selected ? " is-up" : ""}`}
              onClick={() => onGoToSheet(k)}
              title={k}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onGoToSheet(k); } }}
            >
              <span className="open-sheets-idx" aria-hidden="true">{n}</span>
              <span className="open-sheets-name">{lbl}</span>
              {selected && <span className="open-sheets-now">Selected</span>}
              <button
                type="button"
                className={`open-sheets-ico${visible ? " is-eye" : ""}`}
                onClick={(e) => onEye(e, k, visible, inGroup)}
                title={canHide ? "Hide from this view" : visible ? "On the canvas" : "Show this sheet"}
              >
                {visible ? <Eye {...ICO} /> : <EyeOff {...ICO} />}
              </button>
              <button
                type="button"
                className={`open-sheets-ico${inGroup ? " is-pair" : ""}`}
                onClick={(e) => { e.stopPropagation(); onToggleInGroup(k); }}
                title={inGroup ? "Remove from side-by-side" : "Side-by-side with the current sheet"}
              >
                <Columns2 {...ICO} />
              </button>
              <button
                type="button"
                className="open-sheets-ico is-x"
                onClick={(e) => { e.stopPropagation(); onCloseTab(k); }}
                title="Close tab"
              >
                <X {...ICO} size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
