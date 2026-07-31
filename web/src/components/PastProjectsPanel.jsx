// Past projects — Supabase-backed recents on the home screen.
import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { isSupabaseConfigured } from "../lib/supabaseStore.js";
import { createSupabaseRecents, mergeProjectLists, browserStorage } from "../lib/supabaseRecents.js";

const sectionHead = {
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--ink-muted)",
  margin: "0 0 10px 2px",
};

const rowBase = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "11px 14px",
  border: "1px solid var(--ink-faint)",
  background: "var(--paper-bright)",
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
  boxSizing: "border-box",
  fontFamily: "var(--f-body)",
};

const openBtn = {
  padding: "5px 11px",
  border: "1px solid var(--ink-faint)",
  background: "transparent",
  color: "var(--cobalt)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1,
  whiteSpace: "nowrap",
  flexShrink: 0,
};

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function metaLine(p) {
  const parts = [];
  if (p.sheetCount) parts.push(`${p.sheetCount} sheet${p.sheetCount === 1 ? "" : "s"}`);
  if (p.shapeCount) parts.push(`${p.shapeCount} takeoff${p.shapeCount === 1 ? "" : "s"}`);
  if (!parts.length) parts.push("Empty project");
  const when = fmtWhen(p.lastOpenedAt || p.updatedAt);
  if (when) parts.push(when);
  return parts.join(" · ");
}

export default function PastProjectsPanel({ currentProjectId, onNewProject, home = false, creating = false }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(isSupabaseConfigured());
  const [err, setErr] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busyId, setBusyId] = useState(null);

  const recents = useMemo(() => createSupabaseRecents(browserStorage()).list(), [refresh]);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      setErr("");
      import("../lib/supabase/projects.js")
        .then(({ listProjectSummaries }) => listProjectSummaries({ search: q, limit: 48 }))
        .then((list) => {
          if (!live) return;
          createSupabaseRecents(browserStorage()).pruneMissing(new Set(list.map((p) => p.id)));
          setRows(mergeProjectLists(list, createSupabaseRecents(browserStorage()).list(), q.trim().toLowerCase()));
          setLoading(false);
        })
        .catch((e) => {
          if (!live) return;
          setErr(String(e?.message || e));
          setLoading(false);
        });
    }, q ? 180 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, refresh]);

  const openProject = async (p) => {
    createSupabaseRecents(browserStorage()).remember({ id: p.id, name: p.name });
    const { touchProjectOpened, openSupabaseProject } = await import("../lib/supabase/projects.js");
    touchProjectOpened(p.id).catch(() => {});
    openSupabaseProject(p.id);
  };

  const startRename = (p, e) => {
    e?.stopPropagation?.();
    setRenamingId(p.id);
    setRenameDraft(p.name);
  };

  const commitRename = async (p) => {
    const trimmed = renameDraft.trim();
    setRenamingId(null);
    if (!trimmed || trimmed === p.name) return;
    setBusyId(p.id);
    setErr("");
    try {
      const { renameSupabaseProject } = await import("../lib/supabase/projects.js");
      await renameSupabaseProject(p.id, trimmed);
      createSupabaseRecents(browserStorage()).rename(p.id, trimmed);
      setRefresh((n) => n + 1);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusyId(null);
    }
  };

  const deleteProject = async (p, e) => {
    e?.stopPropagation?.();
    if (!window.confirm(`Delete “${p.name}” and all of its takeoff data? This cannot be undone.`)) return;
    setBusyId(p.id);
    setErr("");
    try {
      const { deleteSupabaseProject } = await import("../lib/supabase/projects.js");
      await deleteSupabaseProject(p.id);
      createSupabaseRecents(browserStorage()).forget(p.id);
      setRefresh((n) => n + 1);
    } catch (err) {
      setErr(String(err?.message || err));
    } finally {
      setBusyId(null);
    }
  };

  if (!isSupabaseConfigured()) return null;

  return (
    <div style={{ marginBottom: home ? 0 : 28, textAlign: "left" }}>
      {!home && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={sectionHead}>Past projects</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-muted)", lineHeight: 1.5 }}>
              Pick up where you left off — saved to your ADICC database.
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 160 }}>
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--ink-muted)", pointerEvents: "none", display: "inline-flex" }}>
          <Icon name="search" size={14} />
        </span>
        <input
          name="project-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects…"
          aria-label="Search past projects"
          style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px 10px 36px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 13, color: "var(--ink)" }}
        />
        </div>
        {home && onNewProject && (
          <button type="button" onClick={onNewProject} disabled={creating}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 14px", border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: creating ? "default" : "pointer", fontWeight: 700, fontSize: 13, whiteSpace: "nowrap", opacity: creating ? 0.6 : 1 }}>
            <Icon name="plus" size={14} />{creating ? "Creating…" : "New project"}
          </button>
        )}
      </div>

      {err && (
        <div style={{ padding: "10px 12px", marginBottom: 10, border: "1px solid var(--c-danger)", color: "var(--c-danger)", fontSize: 12.5, background: "var(--paper-bright)" }}>
          Couldn&apos;t load projects: {err}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "18px 4px", color: "var(--ink-muted)", fontSize: 13 }}>Loading projects…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: "18px 14px", border: "1px dashed var(--ink-faint)", color: "var(--ink-muted)", fontSize: 13, lineHeight: 1.55, background: "var(--paper-bright)" }}>
          {q.trim() ? `No projects match “${q.trim()}”.` : home ? "No saved projects yet — start a new project to open the takeoff canvas." : "No saved projects yet."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: home ? undefined : 280, overflow: home ? "visible" : "auto" }}>
          {rows.map((p) => {
            const active = p.id === currentProjectId;
            const renaming = renamingId === p.id;
            const busy = busyId === p.id;
            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => !active && !renaming && !busy && openProject(p)}
                onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !active && !renaming && !busy) { e.preventDefault(); openProject(p); } }}
                style={{
                  ...rowBase,
                  cursor: active || renaming || busy ? "default" : "pointer",
                  borderColor: active ? "var(--cobalt)" : "var(--ink-faint)",
                  boxShadow: active ? "inset 0 0 0 1px var(--cobalt)" : "none",
                  opacity: busy ? 0.65 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                    <span style={{ color: "var(--cobalt)", flexShrink: 0, display: "inline-flex" }}>
                      <Icon name="document" size={15} />
                    </span>
                    {renaming ? (
                      <input
                        name="project-rename"
                        value={renameDraft}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitRename(p); }
                          if (e.key === "Escape") { e.preventDefault(); setRenamingId(null); }
                        }}
                        onBlur={() => commitRename(p)}
                        style={{ flex: 1, minWidth: 0, padding: "4px 8px", border: "1px solid var(--cobalt)", fontSize: 14, fontFamily: "var(--f-body)" }}
                      />
                    ) : (
                      <strong style={{ fontSize: 14, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.name}>
                        {p.name}
                      </strong>
                    )}
                    {active && !renaming && (
                      <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--cobalt)", border: "1px solid var(--cobalt)", padding: "1px 6px", flexShrink: 0 }}>
                        Current
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-muted)", paddingLeft: 23 }}>{metaLine(p)}</div>
                </div>
                {!active && home && !renaming && (
                  <>
                    <button type="button" disabled={busy} onClick={(e) => startRename(p, e)} style={openBtn}>Rename</button>
                    <button type="button" disabled={busy} onClick={(e) => deleteProject(p, e)} style={{ ...openBtn, color: "var(--c-danger)", borderColor: "var(--c-danger)" }}>Delete</button>
                  </>
                )}
                {!active && !renaming && (
                  <button type="button" disabled={busy} onClick={(e) => { e.stopPropagation(); openProject(p); }} style={openBtn}>Open</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
