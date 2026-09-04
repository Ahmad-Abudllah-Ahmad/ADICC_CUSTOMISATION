// Past projects — Supabase-backed recents on the home screen.
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { isSupabaseConfigured } from "../lib/supabaseStore.js";
import { createSupabaseRecents, mergeProjectLists, browserStorage } from "../lib/supabaseRecents.js";
import ProjectPdfSlider from "./ProjectPdfSlider.jsx";
import AdiccLoadingLogo from "./AdiccLoadingLogo.jsx";

function BlurReveal({ children, className = "", delay = 0, style }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(true);
      return undefined;
    }
    let timer;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.unobserve(el);
        timer = window.setTimeout(() => {
          requestAnimationFrame(() => setShown(true));
        }, delay);
      },
      { threshold: 0.06, rootMargin: "0px 0px -4% 0px" }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [delay]);

  return (
    <div ref={ref} className={`blur-reveal${shown ? " blur-reveal-in" : ""}${className ? ` ${className}` : ""}`} style={style}>
      {children}
    </div>
  );
}

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
  border: "1px solid var(--divider-soft)",
  background: "var(--paper-cream)",
  color: "var(--ink-soft)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
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

function fmtCardDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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

export default function PastProjectsPanel({
  currentProjectId,
  onNewProject,
  home = false,
  creating = false,
  newProjectOpen = false,
  onCloseNewProject,
  onPickFiles,
  onPickFolder,
  newProjectError = "",
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(isSupabaseConfigured());
  const [err, setErr] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  const [newProjectHover, setNewProjectHover] = useState(false);
  const [menuBtnHover, setMenuBtnHover] = useState("");

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

  // Publish recent projects to the ADICC platform top-nav search.
  useEffect(() => {
    if (!home || typeof window === "undefined" || window.parent === window) return;
    const projects = rows.map((p) => ({
      id: p.id,
      name: p.name,
      sheetCount: p.sheetCount || 0,
      shapeCount: p.shapeCount || 0,
    }));
    window.parent.postMessage({ source: "opentakeoff", type: "adicc:project-list", projects }, "*");
  }, [home, rows]);

  const openProject = async (p) => {
    createSupabaseRecents(browserStorage()).remember({ id: p.id, name: p.name });
    const { touchProjectOpened, openSupabaseProject } = await import("../lib/supabase/projects.js");
    touchProjectOpened(p.id).catch(() => {});
    openSupabaseProject(p.id);
  };

  // Platform top-nav: filter home list / open + highlight a project.
  useEffect(() => {
    if (!home) return undefined;
    const onMsg = (e) => {
      const d = e?.data;
      if (!d || d.source !== "adicc-platform") return;
      if (d.type === "adicc:request-project-list") {
        const projects = rows.map((p) => ({
          id: p.id,
          name: p.name,
          sheetCount: p.sheetCount || 0,
          shapeCount: p.shapeCount || 0,
        }));
        window.parent?.postMessage({ source: "opentakeoff", type: "adicc:project-list", projects }, "*");
        return;
      }
      if (d.type === "adicc:project-search") {
        setQ(typeof d.query === "string" ? d.query : "");
        return;
      }
      if (d.type === "adicc:open-project" && d.id) {
        setHighlightId(d.id);
        const match = rows.find((p) => p.id === d.id);
        if (match) {
          openProject(match);
          return;
        }
        openProject({ id: d.id, name: d.name || "Project" });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [home, rows]);

  useEffect(() => {
    if (!highlightId) return undefined;
    const el = document.querySelector(`[data-project-id="${highlightId}"]`);
    el?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    const t = setTimeout(() => setHighlightId(null), 2800);
    return () => clearTimeout(t);
  }, [highlightId, rows]);

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

  const searchField = (
    <div style={{ position: "relative", flex: 1, minWidth: 0, width: "100%" }}>
      <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--ink-muted)", pointerEvents: "none", display: "inline-flex" }}>
        <Icon name="search" size={14} />
      </span>
      <input
        name="project-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search projects…"
        aria-label="Search past projects"
        style={{
          width: "100%", boxSizing: "border-box", padding: "9px 12px 9px 36px",
          border: "1px solid var(--divider-soft)", background: "var(--paper-bright)",
          fontSize: 13, color: "var(--ink)", borderRadius: 10,
        }}
      />
    </div>
  );

  const newProjectBtn = home && onNewProject ? (
    <span
      style={{ position: "relative", display: "inline-flex", flexDirection: "column", alignItems: "center", paddingBottom: 16 }}
      onMouseEnter={() => setNewProjectHover(true)}
      onMouseLeave={() => setNewProjectHover(false)}
    >
      <button
        type="button"
        className="canvas-circle-btn home-glass-circle-btn is-primary"
        onClick={onNewProject}
        disabled={creating}
        title={creating ? "Creating…" : "New project"}
        aria-label={creating ? "Creating project" : "New project"}
        aria-expanded={!!newProjectOpen}
        aria-haspopup="menu"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 42,
          height: 42,
          minWidth: 42,
          minHeight: 42,
          aspectRatio: "1",
          padding: 0,
          borderRadius: "50%",
          border: "none",
          outline: "none",
          background: "var(--cobalt)",
          color: "var(--accent-contrast)",
          cursor: creating ? "default" : "pointer",
          opacity: creating ? 0.6 : 1,
          boxShadow: "0 4px 16px rgba(26, 82, 118, 0.28)",
          flexShrink: 0,
        }}
      >
        <Icon name="plus" size={18} />
      </button>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          bottom: 0,
          left: "50%",
          transform: "translateX(-50%)",
          fontFamily: "var(--f-body)",
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: "0.02em",
          color: "var(--ink-muted)",
          whiteSpace: "nowrap",
          opacity: newProjectHover && !newProjectOpen ? 1 : 0,
          transition: "opacity 160ms ease",
          pointerEvents: "none",
        }}
      >
        {creating ? "Creating…" : "New project"}
      </span>
      {newProjectOpen && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "100%",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            width: "max-content",
            padding: 6,
            border: "none",
            background: "transparent",
            boxShadow: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-start",
            gap: 8,
            boxSizing: "border-box",
            fontFamily: "var(--f-body)",
          }}
        >
          {[
            { key: "files", label: "Upload files", icon: "document", onClick: () => onPickFiles?.(), solid: true },
            { key: "folder", label: "Upload folder", icon: "sheets", onClick: () => onPickFolder?.(), solid: false },
            { key: "cancel", label: "Cancel", icon: "close", onClick: () => onCloseNewProject?.(), solid: false },
          ].map((item) => (
            <span
              key={item.key}
              style={{ position: "relative", display: "inline-flex", flexDirection: "column", alignItems: "center", paddingBottom: 14 }}
              onMouseEnter={() => setMenuBtnHover(item.key)}
              onMouseLeave={() => setMenuBtnHover((k) => (k === item.key ? "" : k))}
            >
              <button
                type="button"
                role="menuitem"
                className={`canvas-circle-btn home-glass-circle-btn${item.solid ? " is-solid" : ""}`}
                disabled={creating}
                title={item.label}
                aria-label={item.label}
                onClick={item.onClick}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 40,
                  height: 40,
                  minWidth: 40,
                  minHeight: 40,
                  aspectRatio: "1",
                  padding: 0,
                  borderRadius: "50%",
                  border: item.solid ? "none" : "1px solid var(--divider-soft)",
                  outline: "none",
                  background: item.solid ? "var(--ink)" : "var(--surface-pop)",
                  color: item.solid ? "var(--paper-bright)" : "var(--ink)",
                  cursor: creating ? "default" : "pointer",
                  opacity: creating ? 0.6 : 1,
                  boxShadow: "0 2px 8px rgba(14, 26, 46, 0.10)",
                  flexShrink: 0,
                }}
              >
                <Icon name={item.icon} size={15} />
              </button>
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  bottom: 0,
                  left: "50%",
                  transform: "translateX(-50%)",
                  fontFamily: "var(--f-body)",
                  fontSize: 9.5,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  color: "var(--ink-muted)",
                  whiteSpace: "nowrap",
                  opacity: menuBtnHover === item.key ? 1 : 0,
                  transition: "opacity 160ms ease",
                  pointerEvents: "none",
                }}
              >
                {item.label}
              </span>
            </span>
          ))}
        </div>
      )}
      {newProjectOpen && creating && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--cobalt)", lineHeight: 1.35, textAlign: "center" }}>
          Creating project…
        </div>
      )}
      {newProjectOpen && !!newProjectError && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--c-danger)", lineHeight: 1.35, maxWidth: 200, textAlign: "center" }}>
          {newProjectError}
        </div>
      )}
    </span>
  ) : null;

  if (home) {
    return (
      <div className="animate-projects-pop" style={{ textAlign: "left", width: "100%", height: "100%", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", boxSizing: "border-box", position: "relative" }}>
        {newProjectBtn && (
          <div style={{ position: "absolute", top: 0, right: 0, zIndex: 3, pointerEvents: "none" }}>
            <BlurReveal delay={80} style={{ pointerEvents: "auto" }}>{newProjectBtn}</BlurReveal>
          </div>
        )}

        {err && (
          <BlurReveal delay={40}>
            <div style={{ padding: "10px 12px", marginBottom: 12, border: "1px solid var(--c-danger)", color: "var(--c-danger)", fontSize: 12.5, background: "var(--paper-bright)", borderRadius: 10 }}>
              Couldn&apos;t load projects: {err}
            </div>
          </BlurReveal>
        )}

        {loading ? (
          <div style={{ padding: "48px 4px", flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }} aria-busy="true" aria-label="Loading projects">
            <AdiccLoadingLogo />
          </div>
        ) : rows.length === 0 ? (
          <BlurReveal delay={120}>
            <div style={{ padding: "28px 18px", border: "1px dashed var(--divider-soft)", color: "var(--ink-muted)", fontSize: 13, lineHeight: 1.55, background: "var(--paper-bright)", borderRadius: 12, textAlign: "center", flex: 1 }}>
              {q.trim() ? `No projects match “${q.trim()}”.` : "No saved projects yet."}
            </div>
          </BlurReveal>
        ) : (
          <div className="home-project-grid">
            {rows.filter((p) => !p.name?.toLowerCase().includes("arch. drawings part ii")).map((p, i) => {
              const active = p.id === currentProjectId;
              const renaming = renamingId === p.id;
              const busy = busyId === p.id;
              const highlighted = highlightId === p.id;
              const when = fmtCardDate(p.lastOpenedAt || p.updatedAt || p.createdAt);
              const takeoffs = Number(p.shapeCount) || 0;
              const shared = p.shared !== false;
              return (
                <BlurReveal key={p.id} delay={Math.min(i * 100, 480)} style={{ height: "100%", minWidth: 0, overflow: "visible", paddingTop: 2 }}>
                <div
                  data-project-id={p.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open project ${p.name}`}
                  className={`home-project-card${highlighted || active ? " is-on" : ""}${busy ? " is-busy" : ""}`}
                  onClick={() => !active && !renaming && !busy && openProject(p)}
                  onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !active && !renaming && !busy) { e.preventDefault(); openProject(p); } }}
                  style={{ cursor: active || renaming || busy ? "default" : "pointer" }}
                >
                  <div className="home-project-card-shell">
                    <div className="home-project-preview-wrap">
                      <ProjectPdfSlider projectId={p.id} sheetCount={p.sheetCount} />
                      <span className={`home-project-card-scope${shared ? " is-shared" : " is-private"}`}>
                        {shared ? "Shared" : "Private"}
                      </span>
                      {active && <span className="home-project-card-now">Current</span>}
                    </div>

                    <div className="home-project-card-body">
                      {renaming ? (
                        <input
                          name="project-rename"
                          className="home-project-card-rename"
                          value={renameDraft}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); commitRename(p); }
                            if (e.key === "Escape") { e.preventDefault(); setRenamingId(null); }
                          }}
                          onBlur={() => commitRename(p)}
                        />
                      ) : (
                        <strong className="home-project-card-name" title={p.name}>
                          {p.name}
                        </strong>
                      )}
                      <p className="home-project-card-meta">
                        <span>ADICC</span>
                        {takeoffs > 0 && (
                          <>
                            <span className="home-project-card-dot" aria-hidden="true" />
                            <span>{takeoffs} {takeoffs === 1 ? "takeoff" : "takeoffs"}</span>
                          </>
                        )}
                      </p>

                      <div className="home-project-card-foot">
                        {!active && !renaming ? (
                          <div className="home-project-card-acts" onClick={(e) => e.stopPropagation()}>
                            <button type="button" disabled={busy} onClick={(e) => startRename(p, e)} className="home-project-card-act">
                              <Icon name="edit" size={13} />
                              Rename
                            </button>
                            <button type="button" disabled={busy} onClick={(e) => deleteProject(p, e)} className="home-project-card-act is-danger">
                              <Icon name="trash" size={13} />
                              Delete
                            </button>
                          </div>
                        ) : (
                          <span />
                        )}
                        {when && (
                          <div className="home-project-card-when">
                            {when}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                </BlurReveal>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 28, textAlign: "left" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={sectionHead}>Past projects</div>
          <div style={{ fontSize: 12.5, color: "var(--ink-muted)", lineHeight: 1.5 }}>
            Pick up where you left off — saved to your ADICC database.
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        {searchField}
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
          {q.trim() ? `No projects match “${q.trim()}”.` : "No saved projects yet."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 280, overflow: "auto" }}>
          {rows.filter((p) => !p.name?.toLowerCase().includes("arch. drawings part ii")).map((p) => {
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
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  cursor: active || renaming || busy ? "default" : "pointer",
                  borderColor: active ? "var(--cobalt)" : "var(--ink-faint)",
                  boxShadow: active ? "inset 0 0 0 1px var(--cobalt)" : "none",
                  opacity: busy ? 0.65 : 1,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
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
                  {!active && !renaming && (
                    <button type="button" disabled={busy} onClick={(e) => { e.stopPropagation(); openProject(p); }} style={openBtn}>Open</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
