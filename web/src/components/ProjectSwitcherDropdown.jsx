// ProjectSwitcherDropdown — in-canvas project switcher and creator.
// Directly addresses Client POC Feedback #14 (Multi-Project Support).
import React, { useEffect, useRef, useState, useCallback } from "react";
import { Icon } from "../brand/icons.jsx";
import { isSupabaseConfigured, getSupabaseProjectIdFromUrl, getSupabaseProjectId } from "../lib/supabase/client.js";
import {
  listProjectSummaries,
  navigateToSupabaseProject,
  goSupabaseHome,
  touchProjectOpened,
  renameSupabaseProject,
} from "../lib/supabase/projects.js";
import { createSupabaseProject } from "../lib/supabase/persist.js";
import { createSupabaseRecents, browserStorage } from "../lib/supabaseRecents.js";

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ProjectSwitcherDropdown({
  currentProjectName = "",
  onProjectNameChange,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(currentProjectName || "");

  const menuRef = useRef(null);
  const curProjId = getSupabaseProjectIdFromUrl() || getSupabaseProjectId() || "";

  const isConfigured = isSupabaseConfigured();

  const fetchProjects = useCallback(async () => {
    if (!isConfigured) return;
    setLoading(true);
    try {
      const recents = createSupabaseRecents(browserStorage()).list();
      const dbList = await listProjectSummaries({ limit: 24 });
      
      const map = new Map();
      for (const p of dbList) map.set(p.id, p);
      for (const r of recents) {
        if (!map.has(r.id)) {
          map.set(r.id, {
            id: r.id,
            name: r.name || "Untitled Project",
            lastOpenedAt: r.opened_at || r.saved_at || null,
            sheetCount: 0,
            shapeCount: 0,
          });
        }
      }
      setProjects([...map.values()]);
    } catch {
      const recents = createSupabaseRecents(browserStorage()).list();
      setProjects(recents.map((r) => ({
        id: r.id,
        name: r.name || "Untitled Project",
        lastOpenedAt: r.opened_at || r.saved_at || null,
        sheetCount: 0,
        shapeCount: 0,
      })));
    } finally {
      setLoading(false);
    }
  }, [isConfigured]);

  useEffect(() => {
    if (isOpen) {
      fetchProjects();
      setSearch("");
      setIsCreating(false);
      setNewProjName("");
    }
  }, [isOpen, fetchProjects]);

  useEffect(() => {
    setRenameVal(currentProjectName || "");
  }, [currentProjectName]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [isOpen]);

  const handleCreateProject = async (e) => {
    e?.preventDefault();
    const name = newProjName.trim() || "New Project";
    setCreateLoading(true);
    try {
      const newId = await createSupabaseProject(name);
      createSupabaseRecents(browserStorage()).remember({ id: newId, name });
      touchProjectOpened(newId).catch(() => {});
      navigateToSupabaseProject(newId);
      setIsOpen(false);
    } catch (err) {
      console.error("[ProjectSwitcher] create project failed:", err);
    } finally {
      setCreateLoading(false);
    }
  };

  const handleSelectProject = (proj) => {
    if (proj.id === curProjId) {
      setIsOpen(false);
      return;
    }
    createSupabaseRecents(browserStorage()).remember({ id: proj.id, name: proj.name });
    touchProjectOpened(proj.id).catch(() => {});
    navigateToSupabaseProject(proj.id);
    setIsOpen(false);
  };

  const handleCommitRename = async () => {
    const trimmed = renameVal.trim();
    if (trimmed && trimmed !== currentProjectName && curProjId) {
      onProjectNameChange?.(trimmed);
      try {
        await renameSupabaseProject(curProjId, trimmed);
        createSupabaseRecents(browserStorage()).remember({ id: curProjId, name: trimmed });
      } catch (err) {
        console.error("[ProjectSwitcher] rename failed:", err);
      }
    }
    setIsRenaming(false);
  };

  if (!isConfigured) return null;

  const filtered = projects.filter((p) =>
    (p.name || "").toLowerCase().includes(search.toLowerCase().trim()),
  );

  return (
    <div ref={menuRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      {/* Project Chip Trigger */}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px 3px 10px",
          background: "var(--paper-cream)",
          border: "1px solid var(--ink-faint)",
          borderRadius: 16,
          cursor: "pointer",
          fontSize: 11.5,
          fontWeight: 600,
          color: "var(--ink)",
          maxWidth: 220,
        }}
        onClick={() => setIsOpen((v) => !v)}
        title="Click to switch or manage projects"
      >
        <span style={{ color: "var(--cobalt)", display: "flex", alignItems: "center" }}>
          <Icon name="document" size={13} />
        </span>
        {isRenaming ? (
          <input
            type="text"
            value={renameVal}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCommitRename();
              if (e.key === "Escape") setIsRenaming(false);
            }}
            onBlur={handleCommitRename}
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              fontFamily: "inherit",
              padding: "0 4px",
              border: "1px solid var(--cobalt)",
              borderRadius: 3,
              outline: "none",
              maxWidth: 140,
            }}
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              setIsRenaming(true);
            }}
            title="Double-click to rename"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {currentProjectName || "Untitled Project"}
          </span>
        )}
        <span style={{ fontSize: 9, color: "var(--ink-muted)", marginLeft: 2 }}>▾</span>
      </div>

      {/* Dropdown Popover */}
      {isOpen && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 9999,
            width: 280,
            background: "var(--paper-bright)",
            border: "1px solid var(--ink)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-3, 0 10px 30px rgba(0,0,0,0.15))",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            fontFamily: "var(--f-body)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderBottom: "1px solid var(--ink-faint)",
              background: "var(--paper-cream)",
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--cobalt)" }}>
              Projects ({projects.length})
            </span>
            <button
              type="button"
              onClick={() => setIsCreating((v) => !v)}
              style={{
                border: "1px solid var(--cobalt)",
                background: isCreating ? "var(--cobalt)" : "transparent",
                color: isCreating ? "var(--accent-contrast, #fff)" : "var(--cobalt)",
                borderRadius: 12,
                padding: "2px 8px",
                fontSize: 10.5,
                fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              + New
            </button>
          </div>

          {/* New Project Inline Form */}
          {isCreating && (
            <form
              onSubmit={handleCreateProject}
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--ink-faint)",
                background: "rgba(31, 63, 199, 0.04)",
                display: "flex",
                gap: 6,
              }}
            >
              <input
                type="text"
                autoFocus
                placeholder="Project name…"
                value={newProjName}
                onChange={(e) => setNewProjName(e.target.value)}
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  fontSize: 11.5,
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--ink-faint)",
                  outline: "none",
                  background: "var(--paper-bright)",
                }}
              />
              <button
                type="submit"
                disabled={createLoading}
                style={{
                  padding: "4px 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "none",
                  background: "var(--cobalt)",
                  color: "var(--accent-contrast, #fff)",
                  fontWeight: 600,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {createLoading ? "…" : "Create"}
              </button>
            </form>
          )}

          {/* Search Filter */}
          {projects.length > 5 && (
            <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--ink-faint)" }}>
              <input
                type="text"
                placeholder="Search projects…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "4px 8px",
                  fontSize: 11,
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--ink-faint)",
                  outline: "none",
                }}
              />
            </div>
          )}

          {/* Projects List */}
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {loading && projects.length === 0 ? (
              <div style={{ padding: "16px", textAlign: "center", fontSize: 11.5, color: "var(--ink-muted)" }}>
                Loading projects…
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: "16px", textAlign: "center", fontSize: 11.5, color: "var(--ink-muted)" }}>
                No projects found.
              </div>
            ) : (
              filtered.map((p) => {
                const isActive = p.id === curProjId;
                return (
                  <div
                    key={p.id}
                    onClick={() => handleSelectProject(p)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 12px",
                      borderBottom: "1px solid rgba(0,0,0,0.03)",
                      background: isActive ? "var(--paper-cream)" : "transparent",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) e.currentTarget.style.background = "rgba(0,0,0,0.025)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1, marginRight: 8 }}>
                      <div
                        style={{
                          fontWeight: isActive ? 700 : 500,
                          color: isActive ? "var(--cobalt)" : "var(--ink)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.name || "Untitled Project"}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>
                        {p.sheetCount ? `${p.sheetCount} sheet${p.sheetCount === 1 ? "" : "s"} · ` : ""}
                        {fmtDate(p.lastOpenedAt || p.updatedAt || p.createdAt)}
                      </div>
                    </div>
                    {isActive && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          color: "var(--cobalt)",
                          background: "rgba(31, 63, 199, 0.08)",
                          padding: "2px 6px",
                          borderRadius: 10,
                          flexShrink: 0,
                        }}
                      >
                        Active
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer Navigation */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 12px",
              borderTop: "1px solid var(--ink-faint)",
              background: "var(--paper-cream)",
              fontSize: 11,
            }}
          >
            <button
              type="button"
              onClick={() => goSupabaseHome()}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--cobalt)",
                cursor: "pointer",
                padding: 0,
                fontWeight: 600,
                fontSize: 11,
              }}
            >
              All Projects (Home) →
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--ink-muted)",
                cursor: "pointer",
                padding: 0,
                fontSize: 11,
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
