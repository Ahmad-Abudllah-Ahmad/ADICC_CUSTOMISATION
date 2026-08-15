// Open sheets on the canvas — docked above the bottom-left sheets FAB.
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
  embedded = false,
  hideFind = false,
  hideActions = false,
  query,
  maxGroup = 4,
}) {
  const [q, setQ] = useState("");
  const findRef = useRef(null);
  const filterText = query != null ? query : q;

  useEffect(() => {
    if (hideFind) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && !embedded) { onClose?.(); return; }
      if (e.key !== "/") return;
      const tg = e.target?.tagName;
      if (tg === "INPUT" || tg === "SELECT" || tg === "TEXTAREA") return;
      e.preventDefault();
      findRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, embedded, hideFind]);

  const filtering = filterText.trim().length > 0;
  const shown = useMemo(() => {
    const s = filterText.trim().toLowerCase();
    if (!s) return openTabs.map((k, i) => ({ k, i }));
    return openTabs.map((k, i) => ({ k, i })).filter(({ k }) => {
      const lbl = (tabLabel ? tabLabel(k) : k).toLowerCase();
      return lbl.includes(s) || String(k).toLowerCase().includes(s);
    });
  }, [openTabs, filterText, tabLabel]);

  const activeKey = (() => {
    if (sheetGroup.length) {
      if (focusKey && sheetGroup.includes(focusKey)) return focusKey;
      if (sheetKey && sheetGroup.includes(sheetKey)) return sheetKey;
      return sheetGroup[0];
    }
    if (sheetKey && openTabs.includes(sheetKey)) return sheetKey;
    return openTabs[0] || "";
  })();

  const onEye = (e, k, eyeDisabled) => {
    e.stopPropagation();
    if (eyeDisabled) return;
    onToggleInGroup(k);
  };

  const list = (
      <div className="left-panel-scroll open-sheets-list">
        {shown.length === 0 ? (
          <div className="open-sheets-empty">
            {filtering ? `Nothing matches “${filterText.trim()}”.` : "No sheets open on the canvas."}
          </div>
        ) : shown.map(({ k, i }) => {
          const inGroup = sheetGroup.includes(k);
          const visible = sheetGroup.length ? inGroup : k === sheetKey;
          const selected = k === activeKey;
          const lbl = tabLabel ? tabLabel(k) : k;
          const n = String(i + 1).padStart(2, "0");
          const canHide = visible && inGroup && sheetGroup.length >= 2;
          const eyeDisabled = visible && sheetGroup.length < 2;
          const eyeTip = eyeDisabled
            ? "On canvas"
            : canHide
              ? "Hide from view"
              : "Show in pair";
          // Split makes/keeps a side-by-side pair. Removing (in-group) is always
          // allowed; adding is a dead action when the group is already full, or
          // when it would try to pair the only/active sheet with itself — disable
          // it there so no click ever lands on nothing.
          const atCap = sheetGroup.length >= maxGroup;
          const selfPair = sheetGroup.length === 0 && k === activeKey;
          const splitDisabled = !inGroup && (atCap || selfPair);
          const splitTip = inGroup
            ? "Unsplit"
            : atCap
              ? `Max ${maxGroup} sheets`
              : selfPair
                ? "Open another sheet first"
                : "Split view";
          return (
            <div
              key={k}
              className={`open-sheets-row${selected ? " is-on" : ""}${visible && !selected ? " is-up" : ""}`}
              onClick={() => onGoToSheet(k)}
              role="button"
              tabIndex={0}
              aria-current={selected ? "true" : undefined}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onGoToSheet(k); } }}
            >
              <span className="open-sheets-idx" aria-hidden="true">{n}</span>
              <span className="open-sheets-name">{lbl}</span>
              <span className={`open-sheets-now${selected ? " is-on" : ""}`}>{selected ? "Now" : ""}</span>
              <span className="open-sheets-tools">
                <button
                  type="button"
                  className={`open-sheets-ico${visible ? " is-eye" : ""}`}
                  onClick={(e) => onEye(e, k, eyeDisabled)}
                  disabled={eyeDisabled}
                  data-tip={eyeTip}
                  data-tip-at="left"
                  aria-label={eyeTip}
                >
                  {visible ? <Eye {...ICO} /> : <EyeOff {...ICO} />}
                </button>
                <button
                  type="button"
                  className={`open-sheets-ico${inGroup ? " is-pair" : ""}`}
                  onClick={(e) => { e.stopPropagation(); if (!splitDisabled) onToggleInGroup(k); }}
                  disabled={splitDisabled}
                  data-tip={splitTip}
                  data-tip-at="left"
                  aria-label={splitTip}
                >
                  <Columns2 {...ICO} />
                </button>
                <button
                  type="button"
                  className="open-sheets-ico is-x"
                  onClick={(e) => { e.stopPropagation(); onCloseTab(k); }}
                  data-tip="Close"
                  data-tip-at="left"
                  aria-label="Close tab"
                >
                  <X {...ICO} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
  );

  const body = (
    <>
      {!hideFind && (
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
      )}
      {list}
    </>
  );

  if (embedded) {
    return (
      <div className="open-sheets-embedded">
        {!hideActions && onAdd && (
          <div className="left-panel-glass-actions">
            <div className="lp-action-seg" role="group" aria-label="Sheet actions">
              <button type="button" className="lp-btn-ghost" onClick={onAdd} title="Add sheets from the gallery">
                Add from gallery
              </button>
            </div>
          </div>
        )}
        {body}
      </div>
    );
  }

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
        <button type="button" className="lp-tab-close" onClick={onClose} data-tip="Close panel" aria-label="Close panel">
          <X size={18} strokeWidth={2} />
        </button>
      </div>
      {body}
    </div>
  );
}
