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
