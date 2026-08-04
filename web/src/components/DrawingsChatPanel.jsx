// Drawings Q&A — integrated Volume 4 RAG chat.
// Citations are compact buttons; tapping one opens a dedicated Source sidebar.
import React, { useMemo, useState } from "react";
import { citationImageUrl, openCitationFile, sheetKeyForCitation, queryChat } from "../lib/rag.js";

function hasImagePreview(citation) {
  return citation?.chunk_id > 0 && citation.doc_path?.toLowerCase().endsWith(".pdf");
}

function fileName(path) {
  if (!path) return "";
  const parts = String(path).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function CitationChip({ citation, index, active, onSelect, onOpenInWorkspace }) {
  const label = citation.sheet_id || citation.sheet_title || `Source ${index + 1}`;
  return (
    <button
      type="button"
      onClick={() => {
        onSelect(citation);
        onOpenInWorkspace?.(citation);
      }}
      title={citation.quote || label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 9px",
        border: active ? "1px solid var(--cobalt)" : "1px solid var(--ink-faint)",
        background: active ? "rgba(31,63,199,0.1)" : "var(--paper-bright)",
        color: active ? "var(--cobalt)" : "var(--ink)",
        cursor: "pointer",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "inherit",
        maxWidth: "100%",
      }}
    >
      <span style={{
        width: 16, height: 16, borderRadius: 8, flexShrink: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: active ? "var(--cobalt)" : "var(--ink-faint)",
        color: active ? "var(--paper-bright)" : "var(--ink-muted)",
        fontSize: 9, fontWeight: 700,
      }}>
        {index + 1}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontSize: 9.5, color: "var(--ink-muted)", fontWeight: 500, flexShrink: 0 }}>Open</span>
    </button>
  );
}

function SourceSidebar({ citation, onClose, onOpenInWorkspace, sheetNames, galleryLabels }) {
  if (!citation) return null;
  const preview = hasImagePreview(citation);
  const inProject = sheetNames?.length ? sheetKeyForCitation(citation, sheetNames, galleryLabels) : null;

  return (
    <aside
      style={{
        width: 420,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--ink-faint)",
        background: "var(--paper-bright)",
        height: "100%",
        fontFamily: "var(--f-body)",
        color: "var(--ink)",
      }}
    >
      <header style={{ padding: "12px 14px", borderBottom: "1px solid var(--ink-faint)", display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--cobalt)" }}>
            Source
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4, lineHeight: 1.3 }}>
            {citation.sheet_id || "Document"}
            {citation.sheet_title ? (
              <span style={{ fontWeight: 500, color: "var(--ink-muted)" }}> — {citation.sheet_title}</span>
            ) : null}
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 4 }}>
            {[citation.discipline, citation.page_no != null ? `Page ${(citation.page_no || 0) + 1}` : null, citation.source, citation.verified ? "verified" : "unverified"]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close source"
          style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "var(--ink-muted)", lineHeight: 1 }}
        >
          ×
        </button>
      </header>

      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-cream)" }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)", marginBottom: 4 }}>
          File
        </div>
        {citation.doc_path ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {inProject ? (
              <button
                type="button"
                onClick={() => onOpenInWorkspace?.(citation)}
                title="Open this drawing in the workspace tab bar at the cited page"
                style={{
                  display: "block", width: "100%", textAlign: "left", padding: "8px 10px",
                  border: "1px solid var(--cobalt)", borderRadius: 4, background: "var(--cobalt)",
                  color: "var(--paper-bright)", cursor: "pointer", fontFamily: "var(--f-mono)",
                  fontSize: 11.5, fontWeight: 600, wordBreak: "break-all",
                }}
              >
                Open in workspace
                <span style={{ display: "block", marginTop: 4, fontSize: 10, fontWeight: 500, opacity: 0.85, fontFamily: "var(--f-body)" }}>
                  {fileName(citation.doc_path)}{citation.page_no != null ? ` · page ${citation.page_no + 1}` : ""}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={async () => {
                try {
                  await openCitationFile(citation);
                } catch (err) {
                  // eslint-disable-next-line no-alert
                  alert(err instanceof Error ? err.message : "Could not open file");
                }
              }}
              title={inProject ? "Download / open in external viewer" : "File not in project — opens from Volume 4 corpus"}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "8px 10px",
                border: "1px solid var(--ink-faint)", borderRadius: 4, background: "var(--paper-bright)",
                color: "var(--ink)", cursor: "pointer", fontFamily: "var(--f-mono)",
                fontSize: 11.5, fontWeight: 600, wordBreak: "break-all",
              }}
            >
              {fileName(citation.doc_path)}
              <span style={{ display: "block", marginTop: 4, fontSize: 10, fontWeight: 500, color: "var(--ink-muted)", fontFamily: "var(--f-body)" }}>
                {inProject ? "External viewer / download" : "Not in project Files — external open"}
              </span>
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>—</div>
        )}
        {citation.doc_path && fileName(citation.doc_path) !== citation.doc_path && (
          <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 6, wordBreak: "break-all" }}>{citation.doc_path}</div>
        )}
      </div>

      {citation.quote ? (
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--ink-faint)" }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)", marginBottom: 6 }}>
            Quoted text
          </div>
          <blockquote style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45, fontStyle: "italic", color: "var(--ink)" }}>
            “{citation.quote}”
          </blockquote>
        </div>
      ) : null}

      <div style={{ flex: 1, overflow: "auto", padding: 12, background: "var(--paper-cream)" }}>
        {preview ? (
          <img
            key={citation.chunk_id}
            src={citationImageUrl(citation.chunk_id)}
            alt="Citation page preview"
            style={{
              width: "100%",
              display: "block",
              borderRadius: 4,
              border: "1px solid var(--ink-faint)",
              background: "#fff",
              boxShadow: "var(--shadow-1)",
            }}
            onError={(e) => {
              e.currentTarget.style.display = "none";
              const fallback = e.currentTarget.nextSibling;
              if (fallback) fallback.style.display = "block";
            }}
          />
        ) : null}
        <div
          style={{
            display: preview ? "none" : "block",
            padding: 14,
            border: "1px dashed var(--ink-faint)",
            borderRadius: 4,
            fontSize: 12,
            color: "var(--ink-muted)",
            lineHeight: 1.45,
            background: "var(--paper-bright)",
          }}
        >
          No page image for this source (Excel schedule row or non-PDF). The quote and file path above are still the verified citation.
        </div>
      </div>
    </aside>
  );
}

export default function DrawingsChatPanel({ onClose, onOpenInWorkspace, sheetNames = [], galleryLabels = {} }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeCitation, setActiveCitation] = useState(null);

  const suggestions = useMemo(
    () => [
      "What scale is sheet A1105?",
      "What STC requirements are in the acoustic report?",
      "Which electrical drawings cover fire alarm?",
      "What door tags appear on the 1st floor plan?",
    ],
    [],
  );

  async function sendMessage(question) {
    if (!question.trim() || loading) return;
    setLoading(true);
    setActiveCitation(null);
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setInput("");
    try {
      const result = await queryChat(question);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: result.answer,
          citations: result.citations || [],
          abstained: result.abstained,
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`, citations: [] },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", height: "100%", flexShrink: 0 }}>
      <aside
        style={{
          width: 360,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--ink-faint)",
          background: "var(--paper-bright)",
          fontFamily: "var(--f-body)",
          color: "var(--ink)",
          height: "100%",
        }}
      >
        <header style={{ padding: "12px 14px", borderBottom: "1px solid var(--ink-faint)", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--cobalt)" }}>Drawings Q&A</div>
            <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}>Tap a citation to open it in the workspace</div>
          </div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "var(--ink-muted)" }}>×</button>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          {messages.length === 0 && (
            <div>
              <p style={{ fontSize: 12, color: "var(--ink-muted)", marginBottom: 8 }}>Ask about drawings, specs, schedules, or reports.</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {suggestions.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => sendMessage(item)}
                    style={{ fontSize: 11, padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "var(--paper-cream)", cursor: "pointer", borderRadius: 4, textAlign: "left" }}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, index) => (
            <div
              key={index}
              style={{
                padding: 10,
                borderRadius: 6,
                background: message.role === "user" ? "rgba(31,63,199,0.08)" : "var(--paper-cream)",
                marginLeft: message.role === "user" ? 20 : 0,
                marginRight: message.role === "assistant" ? 8 : 0,
              }}
            >
              <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-muted)", marginBottom: 4 }}>
                {message.role === "user" ? "You" : "Assistant"}
                {message.abstained ? " · abstained" : ""}
              </div>
              <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{message.content}</div>

              {message.citations?.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)", marginBottom: 6 }}>
                    Citations · tap to open in workspace
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {message.citations.map((citation, ci) => (
                      <CitationChip
                        key={citation.id || `${index}-${ci}`}
                        citation={citation}
                        index={ci}
                        active={activeCitation?.id === citation.id}
                        onSelect={setActiveCitation}
                        onOpenInWorkspace={onOpenInWorkspace}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); sendMessage(input); }}
          style={{ padding: 10, borderTop: "1px solid var(--ink-faint)", display: "flex", gap: 6 }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about Volume 4 drawings..."
            style={{ flex: 1, padding: "8px 10px", border: "1px solid var(--ink-faint)", borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}
          />
          <button
            type="submit"
            disabled={loading}
            style={{ padding: "8px 14px", background: "var(--cobalt)", color: "var(--paper-bright)", border: "none", borderRadius: 4, fontWeight: 600, fontSize: 11, cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "…" : "Ask"}
          </button>
        </form>
      </aside>

      <SourceSidebar
        citation={activeCitation}
        onClose={() => setActiveCitation(null)}
        onOpenInWorkspace={onOpenInWorkspace}
        sheetNames={sheetNames}
        galleryLabels={galleryLabels}
      />
    </div>
  );
}
