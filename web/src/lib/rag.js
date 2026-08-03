// ADICC Volume 4 RAG client — talks to the FastAPI backend via the /rag proxy.

/** @typedef {{ id: string, chunk_id: number, doc_path: string, page_no: number, sheet_id?: string|null, sheet_title?: string|null, discipline?: string|null, bbox?: number[]|null, quote: string, source: string, verified: boolean }} Citation */

/** @typedef {{ answer: string, citations: Citation[], abstained: boolean, candidates?: Array<Record<string, unknown>>|null }} QueryResponse */

/** @typedef {{ room: string, matched_room?: string|null, finish_codes: Array<{ category: string, code: string, description: string, material?: string|null }>, citations: Citation[], abstained: boolean }} FinishForRoomResponse */

const RAG_BASE = "/rag";

/**
 * @param {string} question
 * @returns {Promise<QueryResponse>}
 */
export async function queryChat(question) {
  const response = await fetch(`${RAG_BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: question }),
  });
  if (!response.ok) throw new Error(`Query failed: ${response.status}`);
  return response.json();
}

/**
 * Stream a query answer via SSE (events: answer, citations, done).
 * @param {string} question
 * @param {{ onAnswer?: (answer: string) => void, onCitations?: (citations: Citation[]) => void, onDone?: () => void, onError?: (err: Error) => void }} handlers
 */
export async function queryChatStream(question, handlers = {}) {
  const response = await fetch(`${RAG_BASE}/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: question }),
  });
  if (!response.ok) throw new Error(`Stream query failed: ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      try {
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.type === "answer") handlers.onAnswer?.(payload.answer);
        if (payload.type === "citations") handlers.onCitations?.(payload.citations);
        if (payload.type === "done") handlers.onDone?.();
      } catch {
        /* ignore malformed SSE chunks */
      }
    }
  }
  handlers.onDone?.();
}

/** @param {number} chunkId */
export function citationImageUrl(chunkId) {
  return `${RAG_BASE}/citation/${chunkId}/image`;
}

/**
 * URL that serves the original source file (PDF opens in browser; Word/Excel download → OS app).
 * @param {{ chunk_id?: number, doc_path?: string, page_no?: number }} citation
 * @param {{ download?: boolean }} [opts]
 */
export function citationFileUrl(citation, opts = {}) {
  if (citation?.chunk_id > 0) {
    const q = opts.download ? "?download=true" : "";
    return `${RAG_BASE}/citation/${citation.chunk_id}/file${q}`;
  }
  if (citation?.doc_path) {
    const q = new URLSearchParams({ path: citation.doc_path });
    if (opts.download) q.set("download", "true");
    return `${RAG_BASE}/file?${q.toString()}`;
  }
  return null;
}

/**
 * Open the citation's source file.
 * PDFs: fetch → blob URL in a new tab (more reliable than proxy navigation), with #page=N.
 * Word/Excel/etc.: fetch → download so the OS opens the default app.
 * @param {{ chunk_id?: number, doc_path?: string, page_no?: number }} citation
 */
export async function openCitationFile(citation) {
  const url = citationFileUrl(citation);
  if (!url) throw new Error("No file path on this citation");

  const path = (citation.doc_path || "").toLowerCase();
  const isPdf = path.endsWith(".pdf");
  const name = (citation.doc_path || "document").replace(/^.*[/\\]/, "") || "document";

  const response = await fetch(url);
  if (!response.ok) {
    let detail = `Could not open file (${response.status})`;
    try {
      const body = await response.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* ignore */ }
    throw new Error(detail);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  if (isPdf) {
    const page = citation.page_no != null && citation.page_no >= 0 ? `#page=${citation.page_no + 1}` : "";
    const win = window.open(objectUrl + page, "_blank", "noopener,noreferrer");
    if (!win) {
      // Popup blocked — fall back to download
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = name;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return;
  }

  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/**
 * Deterministic room → finish schedule lookup (no LLM).
 * @param {string} room
 * @returns {Promise<FinishForRoomResponse>}
 */
export async function finishForRoom(room) {
  const response = await fetch(`${RAG_BASE}/finish-for-room`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room }),
  });
  if (!response.ok) throw new Error(`finish-for-room failed: ${response.status}`);
  return response.json();
}
