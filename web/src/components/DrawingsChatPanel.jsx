// Drawings Q&A — integrated Volume 4 RAG chat.
// Citations open a floating, draggable reference window with highlighted PDF preview.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  citationImageUrl,
  sheetKeyForCitation,
  queryChat,
  buildLiveCountsSummary,
  answerFromLiveDetections,
  resolveChatAnswer,
} from "../lib/rag.js";
import FloatingWindow from "./FloatingWindow.jsx";

function hasImagePreview(citation) {
  return citation?.chunk_id > 0 && citation.doc_path?.toLowerCase().endsWith(".pdf");
}

function fileName(path) {
  if (!path) return "";
  const parts = String(path).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function cleanDisplayText(text) {
  return String(text || "")
    .replace(/[#*`>•●○◆▪︎■□★☆✓✔✕✖]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Render TITLE: / SECTION: structured answers as bold titles + clean paragraphs. */
function FormattedAnswer({ content }) {
  const blocks = useMemo(() => {
    const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let body = [];
    const flushBody = () => {
      const text = cleanDisplayText(body.join(" ").trim());
      if (text) out.push({ type: "p", text });
      body = [];
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        flushBody();
        continue;
      }
      const title = line.match(/^TITLE:\s*(.+)$/i);
      if (title) {
        flushBody();
        out.push({ type: "title", text: cleanDisplayText(title[1]) });
        continue;
      }
      const section = line.match(/^SECTION:\s*(.+)$/i);
      if (section) {
        flushBody();
        out.push({ type: "section", text: cleanDisplayText(section[1]) });
        continue;
      }
      // Treat short plain heading lines as section titles when model drifts
      if (/^[A-Z][A-Za-z0-9 /&()]{2,48}$/.test(line) && !/[.!?]$/.test(line) && line.split(" ").length <= 6) {
        flushBody();
        out.push({ type: "section", text: cleanDisplayText(line) });
        continue;
      }
      body.push(line.replace(/^[-–—*•]\s+/, "").replace(/^\d+[).]\s+/, (m) => m.replace(/[).]/g, ") ")));
    }
    flushBody();
    return out;
  }, [content]);

  if (!blocks.length) {
    return <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>{cleanDisplayText(content)}</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {blocks.map((b, i) => {
        if (b.type === "title") {
          return (
            <div key={i} style={{ fontSize: 14, fontWeight: 800, color: "light-dark(var(--ink), #ffffff)", lineHeight: 1.25 }}>
              {b.text}
            </div>
          );
        }
        if (b.type === "section") {
          return (
            <div key={i} style={{ fontSize: 12, fontWeight: 700, color: "light-dark(var(--ink), #f0f4ff)", marginTop: i ? 2 : 0, letterSpacing: "0.02em", lineHeight: 1.3 }}>
              {b.text}
            </div>
          );
        }
        return (
          <div key={i} style={{ fontSize: 12.5, lineHeight: 1.4, color: "light-dark(var(--ink), rgba(255,255,255,0.92))" }}>
            {b.text}
          </div>
        );
      })}
    </div>
  );
}

function GeneratingIndicator() {
  return (
    <div
      className="drawings-chat-glass-generating"
      style={{
        padding: "4px 8px",
        borderRadius: 999,
        marginRight: 8,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        alignSelf: "flex-start",
        width: "max-content",
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              background: "light-dark(var(--cobalt), #6eb5ff)",
              animation: "adiccChatDot 1s ease-in-out infinite",
              animationDelay: `${i * 0.16}s`,
            }}
          />
        ))}
      </div>
      <div style={{ fontSize: 11, color: "light-dark(var(--ink-muted), rgba(255,255,255,0.88))", lineHeight: 1.2, whiteSpace: "nowrap" }}>Generating answer</div>
    </div>
  );
}

function TypewriterAnswer({ content, onDone }) {
  const [visible, setVisible] = useState("");
  const doneRef = useRef(false);

  useEffect(() => {
    doneRef.current = false;
    setVisible("");
    const full = String(content || "");
    if (!full) {
      doneRef.current = true;
      onDone?.();
      return undefined;
    }
    let i = 0;
    const chunk = Math.max(2, Math.ceil(full.length / 90));
    const id = window.setInterval(() => {
      i = Math.min(full.length, i + chunk);
      setVisible(full.slice(0, i));
      if (i >= full.length) {
        window.clearInterval(id);
        if (!doneRef.current) {
          doneRef.current = true;
          onDone?.();
        }
      }
    }, 22);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- type once per content payload
  }, [content]);

  const typing = visible.length < String(content || "").length;

  return (
    <div>
      <FormattedAnswer content={visible} />
      {typing ? (
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 7,
            height: 14,
            marginLeft: 2,
            marginTop: 4,
            background: "var(--cobalt)",
            verticalAlign: "text-bottom",
            animation: "adiccChatCaret 0.85s steps(1) infinite",
          }}
        />
      ) : null}
    </div>
  );
}

function CitationChip({ citation, index, active, onSelect }) {
  const label = citation.sheet_id || citation.sheet_title || `Source ${index + 1}`;
  return (
    <button
      type="button"
      className={`drawings-chat-glass-citation${active ? " is-active" : ""}`}
      onClick={() => onSelect(citation)}
      title={citation.quote || label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 9px",
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

function FloatingSourceWindow({ citation, onClose, onOpenInWorkspace, sheetNames, galleryLabels }) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(24, Math.round(window.innerWidth * 0.42)),
    y: Math.max(72, Math.round(window.innerHeight * 0.14)),
  }));
  const [viewZoom, setViewZoom] = useState(1);
  const [viewPan, setViewPan] = useState({ x: 0, y: 0 });
  const [previewState, setPreviewState] = useState("loading"); // loading | ready | error
  const dragRef = useRef(null);
  const panRef = useRef(null);

  useEffect(() => {
    // Re-center slightly when switching citation so the window stays visible
    setPos((p) => ({
      x: Math.min(Math.max(16, p.x), window.innerWidth - 380),
      y: Math.min(Math.max(56, p.y), window.innerHeight - 120),
    }));
    setViewZoom(1);
    setViewPan({ x: 0, y: 0 });
    setPreviewState(hasImagePreview(citation) ? "loading" : "error");
  }, [citation?.chunk_id]);

  if (!citation) return null;
  const preview = hasImagePreview(citation);
  const inProject = sheetNames?.length ? sheetKeyForCitation(citation, sheetNames, galleryLabels) : null;

  function onDragStart(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { ...pos };
    dragRef.current = { startX, startY, origin };
    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({
        x: Math.max(8, d.origin.x + (ev.clientX - d.startX)),
        y: Math.max(8, d.origin.y + (ev.clientY - d.startY)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onPanStart(e) {
    if (e.button !== 0 || !preview) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { ...viewPan };
    panRef.current = { startX, startY, origin };
    const onMove = (ev) => {
      const d = panRef.current;
      if (!d) return;
      setViewPan({
        x: d.origin.x + (ev.clientX - d.startX),
        y: d.origin.y + (ev.clientY - d.startY),
      });
    };
    const onUp = () => {
      panRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function zoomBy(delta) {
    setViewZoom((z) => Math.min(4, Math.max(0.5, Math.round((z + delta) * 100) / 100)));
  }

  return (
    <div
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: 440,
        maxWidth: "calc(100vw - 24px)",
        maxHeight: "min(72vh, 640px)",
        zIndex: 80,
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--ink-faint)",
        borderRadius: 10,
        background: "var(--paper-bright)",
        boxShadow: "0 16px 40px rgba(0,0,0,.22)",
        fontFamily: "var(--f-body)",
        color: "var(--ink)",
        overflow: "hidden",
      }}
    >
      <header
        onPointerDown={onDragStart}
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--ink-faint)",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          cursor: "grab",
          background: "var(--paper-cream)",
          userSelect: "none",
          touchAction: "none",
        }}
        title="Drag to move"
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--cobalt)" }}>
            Reference
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4, lineHeight: 1.3 }}>
            {citation.sheet_id || "Document"}
            {citation.sheet_title ? (
              <span style={{ fontWeight: 500, color: "var(--ink-muted)" }}>  {citation.sheet_title}</span>
            ) : null}
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 4 }}>
            {[citation.discipline, citation.page_no != null ? `Page ${(citation.page_no || 0) + 1}` : null]
              .filter(Boolean)
              .join("  ·  ")}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          title="Close reference"
          style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "var(--ink-muted)", lineHeight: 1 }}
        >
          ×
        </button>
      </header>

      {inProject ? (
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
          <button
            type="button"
            onClick={() => onOpenInWorkspace?.(citation)}
            style={{
              display: "block", width: "100%", textAlign: "left", padding: "8px 10px",
              border: "1px solid var(--cobalt)", borderRadius: 6, background: "var(--cobalt)",
              color: "var(--paper-bright)", cursor: "pointer", fontSize: 11.5, fontWeight: 600,
            }}
          >
            Open in workspace
            <span style={{ display: "block", marginTop: 3, fontSize: 10, fontWeight: 500, opacity: 0.9 }}>
              {fileName(citation.doc_path)}{citation.page_no != null ? `  page ${citation.page_no + 1}` : ""}
            </span>
          </button>
        </div>
      ) : null}

      {citation.quote ? (
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--ink-faint)" }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)", marginBottom: 6 }}>
            Cited text
          </div>
          <div style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45, color: "var(--ink)" }}>
            {cleanDisplayText(citation.quote)}
          </div>
        </div>
      ) : null}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 12, background: "var(--paper-cream)", minHeight: 180, gap: 8 }}>
        {preview && previewState !== "error" ? (
          <>
            <div
              onPointerDown={previewState === "ready" ? onPanStart : undefined}
              title="Drag to pan"
              style={{
                flex: 1,
                minHeight: 200,
                overflow: "hidden",
                borderRadius: 6,
                border: "1px solid var(--ink-faint)",
                background: "#fff",
                cursor: previewState === "ready" ? "grab" : "default",
                touchAction: "none",
                position: "relative",
              }}
            >
              {previewState === "loading" ? (
                <div style={{
                  position: "absolute", inset: 0, display: "flex", alignItems: "center",
                  justifyContent: "center", fontSize: 12, color: "var(--ink-muted)",
                }}>
                  Loading preview…
                </div>
              ) : null}
              <img
                key={citation.chunk_id}
                src={citationImageUrl(citation.chunk_id)}
                alt="Cited page with highlight"
                draggable={false}
                style={{
                  width: "100%",
                  display: previewState === "ready" ? "block" : "none",
                  transform: `translate(${viewPan.x}px, ${viewPan.y}px) scale(${viewZoom})`,
                  transformOrigin: "center center",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
                onLoad={() => setPreviewState("ready")}
                onError={() => setPreviewState("error")}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <button
                type="button"
                title="Zoom out"
                onClick={() => zoomBy(-0.25)}
                disabled={viewZoom <= 0.5 || previewState !== "ready"}
                style={{
                  width: 34, height: 34, borderRadius: 6,
                  border: "1px solid var(--ink-faint)", background: "var(--paper-bright)",
                  color: "var(--ink)", cursor: viewZoom <= 0.5 ? "default" : "pointer",
                  fontSize: 18, fontWeight: 600, lineHeight: 1, opacity: viewZoom <= 0.5 ? 0.45 : 1,
                }}
              >
                −
              </button>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-muted)", minWidth: 44, textAlign: "center" }}>
                {Math.round(viewZoom * 100)}%
              </span>
              <button
                type="button"
                title="Zoom in"
                onClick={() => zoomBy(0.25)}
                disabled={viewZoom >= 4 || previewState !== "ready"}
                style={{
                  width: 34, height: 34, borderRadius: 6,
                  border: "1px solid var(--ink-faint)", background: "var(--paper-bright)",
                  color: "var(--ink)", cursor: viewZoom >= 4 ? "default" : "pointer",
                  fontSize: 18, fontWeight: 600, lineHeight: 1, opacity: viewZoom >= 4 ? 0.45 : 1,
                }}
              >
                +
              </button>
            </div>
          </>
        ) : (
          <div
            style={{
              padding: 14,
              border: "1px dashed var(--ink-faint)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--ink-muted)",
              lineHeight: 1.45,
              background: "var(--paper-bright)",
            }}
          >
            No page image for this source. The cited text above is still available.
          </div>
        )}
      </div>
    </div>
  );
}

export default function DrawingsChatPanel({
  onClose,
  onOpenInWorkspace,
  sheetNames = [],
  galleryLabels = {},
  initialQuestion = "",
  getProjectContext,
  getLiveDetectionInput,
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeCitation, setActiveCitation] = useState(null);
  const seededRef = useRef(false);

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
      let projectContext = "";
      let liveSummary = "";
      let liveAnswer = null;
      let live = null;
      try {
        projectContext = (typeof getProjectContext === "function" ? getProjectContext() : "") || "";
      } catch { /* ignore */ }
      try {
        live = typeof getLiveDetectionInput === "function" ? getLiveDetectionInput() : null;
        if (live) {
          liveSummary = buildLiveCountsSummary(live.planSymbols || [], live.shapes || [], live.conditions || []);
          liveAnswer = answerFromLiveDetections(
            question,
            live.planSymbols || [],
            live.shapes || [],
            live.conditions || [],
          );
        }
      } catch { /* ignore */ }
      // 1) Ask RAG + API first (with live context available).
      // 2) Keep that answer when it is accurate; otherwise fall back to live detections.
      const result = await queryChat(question, { projectContext, liveSummary });
      const citations = (result.citations || []).slice(0, 2);
      const resolved = resolveChatAnswer(question, result, liveAnswer);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: resolved.content,
          citations,
          abstained: resolved.abstained,
          animate: true,
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          citations: [],
          animate: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const q = (initialQuestion || "").trim();
    if (!q || seededRef.current) return;
    seededRef.current = true;
    void sendMessage(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once when the side panel opens
  }, [initialQuestion]);

  return (
    <>
      <style>{`
        @keyframes adiccChatDot {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.45; }
          40% { transform: translateY(-5px); opacity: 1; }
        }
        @keyframes adiccChatCaret {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0.15; }
        }
      `}</style>
      <FloatingWindow
        shellClassName="drawings-chat-glass-shell"
        defaultRect={(() => {
          const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
          const vh = typeof window !== "undefined" ? window.innerHeight : 800;
          const w = Math.min(800, Math.round(vw * 0.62));
          const h = Math.min(Math.round(vh * 0.88), vh - 48);
          return {
            x: Math.max(16, Math.round((vw - w) / 2)),
            y: Math.max(24, Math.round((vh - h) / 2)),
            w,
            h,
          };
        })()}
        minW={300}
        minH={280}
      >
        <aside
          className="drawings-chat-glass"
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            background: "transparent",
            fontFamily: "var(--f-body)",
            color: "var(--ink)",
            overflow: "hidden",
            minHeight: 0,
          }}
        >
          <header data-float-drag className="drawings-chat-glass-header" style={{ padding: "12px 14px", borderBottom: "1px solid var(--ink-faint)", display: "flex", alignItems: "center", gap: 8, cursor: "grab", userSelect: "none", flexShrink: 0 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "light-dark(var(--cobalt), #ffffff)" }}>Drawings Q&A</div>
              <div style={{ fontSize: 11, color: "light-dark(var(--ink-muted), rgba(255,255,255,0.82))", marginTop: 2 }}>Ask about Volume 4 drawings, specs, and schedules</div>
            </div>
            <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "var(--ink-muted)", lineHeight: 1 }}>×</button>
          </header>

          <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
            {messages.length === 0 && !loading && (
              <div>
                <p style={{ fontSize: 12, color: "var(--ink-muted)", marginBottom: 8 }}>Ask about drawings, specs, schedules, or reports.</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {suggestions.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="drawings-chat-glass-suggestion"
                      onClick={() => sendMessage(item)}
                      style={{ fontSize: 11, padding: "6px 10px", cursor: "pointer", borderRadius: 999, textAlign: "left" }}
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
                className={message.role === "user" ? "drawings-chat-glass-msg drawings-chat-glass-msg--user" : "drawings-chat-glass-msg drawings-chat-glass-msg--assistant"}
                style={{
                  padding: message.role === "user" ? "3px 8px 4px" : "5px 9px",
                  borderRadius: message.role === "user" ? 12 : 8,
                  alignSelf: message.role === "user" ? "flex-end" : "flex-start",
                  width: "fit-content",
                  maxWidth: message.role === "user" ? "min(72%, 240px)" : "min(94%, 100%)",
                  boxSizing: "border-box",
                }}
              >
                <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "light-dark(var(--ink-muted), rgba(255,255,255,0.65))", marginBottom: message.role === "user" ? 1 : 3, lineHeight: 1 }}>
                  {message.role === "user" ? "You" : "Assistant"}
                  {message.abstained ? "  abstained" : ""}
                </div>
                {message.role === "assistant" ? (
                  message.animate ? (
                    <TypewriterAnswer
                      content={message.content}
                      onDone={() => {
                        setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, animate: false } : m)));
                      }}
                    />
                  ) : (
                    <FormattedAnswer content={message.content} />
                  )
                ) : (
                  <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap", lineHeight: 1.25, margin: 0 }}>{message.content.trim()}</div>
                )}
              </div>
            ))}
            {loading ? <GeneratingIndicator /> : null}
          </div>

          <form
            className="drawings-chat-glass-form"
            onSubmit={(e) => { e.preventDefault(); sendMessage(input); }}
            style={{ padding: 10, borderTop: "1px solid var(--ink-faint)", display: "flex", gap: 6, flexShrink: 0 }}
          >
            <input
              className="drawings-chat-glass-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about Volume 4 drawings..."
              style={{ flex: 1, padding: "8px 10px", borderRadius: 999, fontSize: 12, fontFamily: "inherit" }}
            />
            <button
              type="submit"
              className="drawings-chat-glass-send canvas-circle-btn"
              disabled={loading}
              title={loading ? "Thinking…" : "Send"}
              style={{
                width: 40,
                height: 40,
                padding: 0,
                borderRadius: "50%",
                fontWeight: 600,
                fontSize: 11,
                cursor: loading ? "default" : "pointer",
                opacity: loading ? 0.6 : 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4.5 11.2 19.2 4.4c.7-.3 1.4.4 1.1 1.1L13.5 20.2c-.3.7-1.3.6-1.5-.2l-1.6-6.1-6.1-1.6c-.8-.2-.9-1.2-.2-1.5Z" fill="currentColor"/>
              </svg>
            </button>
          </form>
        </aside>
      </FloatingWindow>

      <FloatingSourceWindow
        citation={activeCitation}
        onClose={() => setActiveCitation(null)}
        onOpenInWorkspace={onOpenInWorkspace}
        sheetNames={sheetNames}
        galleryLabels={galleryLabels}
      />
    </>
  );
}
