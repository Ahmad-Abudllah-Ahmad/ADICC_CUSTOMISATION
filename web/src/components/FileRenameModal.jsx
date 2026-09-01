// Display-name rename for Files — same ADICC confirm chrome as remove/delete.
// Does not rename the stored PDF key; callers own that contract.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export default function FileRenameModal({
  title = "Rename in Files",
  body = "This only changes the label in Files. The stored file and takeoffs stay linked.",
  initialValue = "",
  confirmLabel = "Save name",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef(null);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel?.();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onConfirm?.(value);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onConfirm, onCancel, value]);

  return createPortal(
    <div className="adicc-confirm-scrim" onClick={onCancel}>
      <div
        className="adicc-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="adicc-rename-title"
        aria-describedby="adicc-rename-body"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="adicc-confirm-copy">
          <div id="adicc-rename-title" className="adicc-confirm-title">{title}</div>
          {body ? <p id="adicc-rename-body" className="adicc-confirm-body">{body}</p> : null}
          <label className="adicc-rename-field">
            <span className="adicc-rename-label">Name</span>
            <input
              ref={inputRef}
              name="file-display-name"
              className="adicc-rename-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        <div className="adicc-confirm-actions">
          <button type="button" className="adicc-confirm-btn adicc-confirm-btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="adicc-confirm-btn adicc-confirm-btn-ink" onClick={() => onConfirm?.(value)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
