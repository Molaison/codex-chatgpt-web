// Shared by the page probe and native session-change notifications. Only the
// authenticated endpoint establishes account state; neither cookies nor UI do.
async function readChatGptAuthSession(fetchSession, origin, timeoutMs, identifyUser) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let received = false;
      try {
        const response = await fetchSession(`${origin}/api/auth/session`, {
          // Electron's native Response has no URL. Reject redirects at the request
          // boundary in both clients, so only this exact endpoint can supply evidence.
          credentials: "include", cache: "no-store", redirect: "error", headers: { accept: "application/json" },
          signal: controller.signal,
        });
        received = true;
        if (response.redirected) {
          return { sessionAuthenticated: false, sessionCheckError: "ChatGPT session verification received an unexpected response. Check your connection and retry." };
        }
        if (response.status === 401) return { sessionAuthenticated: false, sessionCheckError: null };
        if (!response.ok) {
          if (response.status >= 500 && attempt === 0 && !controller.signal.aborted) continue;
          return { sessionAuthenticated: false, sessionCheckError: `ChatGPT session verification failed (HTTP ${response.status}). Check your connection and retry.` };
        }
        if (!response.headers.get("content-type")?.includes("application/json")) {
          return { sessionAuthenticated: false, sessionCheckError: "ChatGPT session verification received an unexpected response. Check your connection and retry." };
        }
        const payload = await response.json();
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid session");
        const user = payload.user;
        const authenticated = user && typeof user === "object" && !Array.isArray(user)
          && Object.keys(user).length > 0
          && (payload.error === undefined || payload.error === null || payload.error === "")
          && (payload.expires === undefined || payload.expires === null
            || typeof payload.expires === "string" && Number.isFinite(Date.parse(payload.expires))
              && Date.parse(payload.expires) > Date.now());
        return { sessionAuthenticated: Boolean(authenticated), sessionCheckError: null,
          ...(typeof identifyUser === "function" ? {
            sessionPrincipalDigest: authenticated ? identifyUser(user.id) : null,
          } : {}),
        };
      } catch {
        // A rejected redirect arrives here as the same throw as a transport
        // rejection, so it may share the single re-read; the outcome still fails closed.
        if (!received && attempt === 0 && !controller.signal.aborted) continue;
        return { sessionAuthenticated: false, sessionCheckError: controller.signal.aborted
          ? "ChatGPT session verification timed out. Check your network or proxy and retry."
          : received
            ? "ChatGPT session verification received an invalid response. Retry after the page finishes loading."
            : "ChatGPT session verification failed. Check your network or proxy and retry." };
      }
    }
  } finally { clearTimeout(timer); }
}

module.exports = { readChatGptAuthSession };
