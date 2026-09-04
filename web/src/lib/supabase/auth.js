// Supabase Auth bridge — session from alpha1 (postMessage) or same-origin embed.
import { supabase } from "./client.js";

let cachedUserId = null;
let authReady = false;
let authReadyPromise = null;
/** Resolves when iframe receives session from alpha1 (or times out). */
let parentSessionWait = null;
let resolveParentSession = null;

function beginParentSessionWait() {
  parentSessionWait = new Promise((resolve) => {
    resolveParentSession = resolve;
  });
}

function finishParentSessionWait() {
  resolveParentSession?.();
  resolveParentSession = null;
}

function setCachedUser(user) {
  cachedUserId = user?.id ?? null;
  authReady = true;
  if (cachedUserId) finishParentSessionWait();
}

async function refreshCachedUser() {
  if (!supabase) {
    setCachedUser(null);
    return null;
  }
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    setCachedUser(null);
    return null;
  }
  setCachedUser(data.user);
  return data.user.id;
}

export function waitForAuthReady() {
  if (authReady) return Promise.resolve(cachedUserId);
  if (!authReadyPromise) {
    authReadyPromise = refreshCachedUser().finally(() => {
      authReadyPromise = null;
    });
  }
  return authReadyPromise;
}

export async function getCurrentUserId() {
  if (!supabase) return null;
  if (!authReady) await waitForAuthReady();
  // Embedded in alpha1: session arrives via postMessage shortly after load.
  if (!cachedUserId && typeof window !== "undefined" && window.parent !== window) {
    if (!parentSessionWait) beginParentSessionWait();
    await Promise.race([
      parentSessionWait,
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    await refreshCachedUser();
  }
  return cachedUserId;
}

export async function applySupabaseSession(session) {
  if (!supabase || !session?.access_token) {
    await refreshCachedUser();
    return cachedUserId;
  }
  const { error } = await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token || "",
  });
  if (error) console.warn("[ADICC auth]", error.message);
  await refreshCachedUser();
  return cachedUserId;
}

export function initSupabaseAuthBridge() {
  if (!supabase || typeof window === "undefined") return () => {};

  beginParentSessionWait();

  supabase.auth.onAuthStateChange((_event, session) => {
    setCachedUser(session?.user ?? null);
  });

  const onMessage = (event) => {
    const d = event?.data;
    if (!d || d.source !== "adicc-platform" || d.type !== "adicc:supabase-session") return;
    if (event.source !== window.parent) return;
    void applySupabaseSession(d.session);
  };
  window.addEventListener("message", onMessage);

  void refreshCachedUser();
  window.parent?.postMessage({ source: "opentakeoff", type: "adicc:request-supabase-session" }, "*");

  return () => window.removeEventListener("message", onMessage);
}
