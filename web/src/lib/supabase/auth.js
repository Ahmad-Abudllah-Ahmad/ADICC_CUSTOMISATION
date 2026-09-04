// Supabase Auth bridge — session from alpha1 (postMessage) or same-origin embed.
import { supabase } from "./client.js";

let cachedUserId = null;
let authReady = false;
let authReadyPromise = null;

function setCachedUser(user) {
  cachedUserId = user?.id ?? null;
  authReady = true;
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
