// Isolated confirm dialog — ADICC tokens only. Callers keep their own
// delete/remove functions; this layer only asks and then invokes onConfirm.
import React, { useEffect } from "react";
import { createPortal } from "react-dom";

export default function ConfirmDeleteModal({
  title,
  body,
  confirmLabel = "Remove",
  cancelLabel = "Cancel",
  tone = "danger",
  onConfirm,
  onCancel,
}) {
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
        onConfirm?.();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onConfirm, onCancel]);

  return createPortal(
    <div className="adicc-confirm-scrim" onClick={onCancel}>
      <div
        className="adicc-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="adicc-confirm-title"
        aria-describedby="adicc-confirm-body"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="adicc-confirm-copy">
          <div id="adicc-confirm-title" className="adicc-confirm-title">{title}</div>
          {body ? <p id="adicc-confirm-body" className="adicc-confirm-body">{body}</p> : null}
        </div>
        <div className="adicc-confirm-actions">
          <button type="button" className="adicc-confirm-btn adicc-confirm-btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className={`adicc-confirm-btn ${tone === "ink" ? "adicc-confirm-btn-ink" : "adicc-confirm-btn-danger"}`} autoFocus onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
