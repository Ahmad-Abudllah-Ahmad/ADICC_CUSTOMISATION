// Supabase home — landing screen with recent projects. Opening a project
// navigates to /?db=<uuid> where the takeoff canvas loads (main page).
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import PastProjectsPanel from "./PastProjectsPanel.jsx";
import ThemeToggle from "./ThemeToggle.jsx";
import { createSupabaseRecents, browserStorage } from "../lib/supabaseRecents.js";
import { stashPendingIngest } from "../lib/pendingIngest.js";
import { projectNameFromFiles } from "../lib/projectNaming.js";

export default function SupabaseHome() {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const folderRef = useRef(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    try {
      window.parent?.postMessage({ source: "opentakeoff", type: "adicc:sheets-view", active: false }, "*");
    } catch { /* cross-origin embed */ }
  }, []);

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
      position: "relative",
      height: "100%", minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--paper-bright)", color: "var(--ink)",
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      "--f-display": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      "--f-body": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      "--f-mono": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      boxSizing: "border-box",
    }}>
      <div style={{ position: "absolute", top: 16, right: 16, zIndex: 8 }}>
        <ThemeToggle />
      </div>
      <div className="home-projects-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 16px 24px", display: "flex", flexDirection: "column", background: "var(--stage)" }}>
        <div style={{ width: "100%", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 14, boxSizing: "border-box" }}>
          <input name="home-sheet-file" ref={fileRef} type="file" accept=".pdf,application/pdf,image/*,.zip,application/zip,application/x-zip-compressed,.dwg,application/acad,image/vnd.dwg" multiple style={{ display: "none" }}
            onChange={onFilePicked} />
          <input name="home-sheet-folder" ref={folderRef} type="file" multiple webkitdirectory="" directory="" style={{ display: "none" }}
            onChange={onFilePicked} />

          <PastProjectsPanel
            home
            currentProjectId={null}
            onNewProject={() => { setShowNewProject((v) => !v); setErr(""); }}
            creating={creating && showNewProject}
            newProjectOpen={showNewProject}
            onCloseNewProject={() => { setShowNewProject(false); setErr(""); }}
            onPickFiles={() => fileRef.current?.click()}
            onPickFolder={() => folderRef.current?.click()}
            newProjectError={err}
          />
        </div>
      </div>
    </div>
  );
}
