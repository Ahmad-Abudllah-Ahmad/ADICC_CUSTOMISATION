// Supabase home — landing screen with recent projects. Opening a project
// navigates to /?db=<uuid> where the takeoff canvas loads (main page).
import React, { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../brand/icons.jsx";
import PastProjectsPanel from "./PastProjectsPanel.jsx";
import { createSupabaseRecents, browserStorage } from "../lib/supabaseRecents.js";
import { stashPendingIngest } from "../lib/pendingIngest.js";
import { projectNameFromFiles } from "../lib/projectNaming.js";

const uploadBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  padding: "10px 16px",
  border: "1px solid var(--ink-faint)",
  background: "var(--paper-bright)",
  color: "var(--ink)",
  cursor: "pointer",
  fontWeight: 700,
  fontSize: 13,
  fontFamily: "var(--f-body)",
};

export default function SupabaseHome() {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const folderRef = useRef(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  const startNewProjectWithFiles = async (fileList) => {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    if (creating) return;
    setCreating(true);
    setErr("");
    try {
      const { createSupabaseProject } = await import("../lib/supabase/persist.js");
      const { touchProjectOpened, navigateToSupabaseProject } = await import("../lib/supabase/projects.js");
      const name = projectNameFromFiles(incoming);
      const id = await createSupabaseProject(name);
      createSupabaseRecents(browserStorage()).remember({ id, name });
      touchProjectOpened(id).catch(() => {});
      stashPendingIngest(incoming, name);
      navigateToSupabaseProject(id, navigate);
    } catch (e) {
      console.error("[ADICC] new project", e);
      setErr(String(e?.message || e));
      setCreating(false);
    }
  };

  const onFilePicked = (e) => {
    startNewProjectWithFiles(e.target.files);
    e.target.value = "";
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--paper-cream)", color: "var(--ink)",
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      "--f-display": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      "--f-body": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      "--f-mono": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    }}>
      <div style={{ flex: 1, overflow: "auto", padding: "32px 18px 48px" }}>
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <div style={{ fontFamily: "var(--f-display)", fontSize: 22, color: "var(--ink)", lineHeight: 1.3, marginBottom: 6 }}>
            Recent projects
          </div>
          <div style={{ fontSize: 13.5, color: "var(--ink-muted)", lineHeight: 1.55, marginBottom: 24 }}>
            Choose a project to open the takeoff canvas, or start a new one.
          </div>

          {showNewProject && (
            <div style={{ marginBottom: 24, padding: "24px 20px", border: "1px solid var(--cobalt)", background: "var(--paper-bright)", boxShadow: "inset 0 0 0 1px rgba(31,63,199,0.08)" }}>
              <div style={{ fontFamily: "var(--f-display)", fontSize: 18, color: "var(--ink)", marginBottom: 6 }}>New project</div>
              <div style={{ fontSize: 13, color: "var(--ink-muted)", lineHeight: 1.55, marginBottom: 18 }}>
                Upload your plans to get started — PDFs, images, .zip plan sets, or an entire folder including subfolders.
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" disabled={creating} onClick={() => fileRef.current?.click()} style={{ ...uploadBtn, border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", opacity: creating ? 0.6 : 1 }}>
                  <Icon name="document" size={14} />Upload files
                </button>
                <button type="button" disabled={creating} onClick={() => folderRef.current?.click()} style={{ ...uploadBtn, opacity: creating ? 0.6 : 1 }}>
                  <Icon name="sheets" size={14} />Upload folder
                </button>
                <button type="button" disabled={creating} onClick={() => { setShowNewProject(false); setErr(""); }} style={{ ...uploadBtn, color: "var(--ink-muted)", opacity: creating ? 0.6 : 1 }}>
                  Cancel
                </button>
              </div>
              {creating && (
                <div style={{ marginTop: 14, fontSize: 12.5, color: "var(--cobalt)" }}>Creating project and opening your plans…</div>
              )}
              {err && (
                <div style={{ marginTop: 14, fontSize: 12.5, color: "var(--c-danger)" }}>{err}</div>
              )}
            </div>
          )}

          <input name="home-sheet-file" ref={fileRef} type="file" accept=".pdf,application/pdf,image/*,.zip,application/zip,application/x-zip-compressed,.dwg,application/acad,image/vnd.dwg" multiple style={{ display: "none" }}
            onChange={onFilePicked} />
          <input name="home-sheet-folder" ref={folderRef} type="file" multiple webkitdirectory="" directory="" style={{ display: "none" }}
            onChange={onFilePicked} />

          <PastProjectsPanel
            home
            currentProjectId={null}
            onNewProject={() => { setShowNewProject(true); setErr(""); }}
            creating={creating && showNewProject}
          />
        </div>
      </div>
    </div>
  );
}
