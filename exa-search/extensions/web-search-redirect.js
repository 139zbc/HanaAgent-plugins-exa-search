// extensions/web-search-redirect.js — exa-search Pi SDK extension
//
// Replaces web_search with Exa. Three layers of defense:
//
//   1. pi.on("context")  — runs before every LLM request. Injects a system
//      note telling the LLM "web_search is UNAVAILABLE, use exa_search" AND
//      calls setActiveTools to remove web_search BEFORE the LLM decides tools.
//      This is what makes the FIRST search already use Exa.
//
//   2. exa_search tool  — (in index.js) calls Exa; on failure triggers
//      restoreWebSearch() so the LLM can fall back to web_search.
//
//   3. straggler handler — if web_search still somehow gets called, intercept
//      it, call Exa, steer the result into the LLM, and re-remove web_search.

import {
  callExaAPI,
  formatResults,
  hasKey,
  setActiveToolsController,
} from "../lib/exa-client.js";

const SYS_NOTE =
  "\n\n[SYSTEM NOTE — exa-search plugin] " +
  "The web_search tool is UNAVAILABLE in this session. Do NOT call web_search. " +
  "You MUST use exa_search_exa_search for ALL web searches instead. " +
  "If exa_search fails, web_search is automatically re-enabled.";

export default function (pi) {
  let latestPi = pi;

  const isWebSearch = (t) => {
    if (typeof t === "string") return t === "web_search";
    if (t && typeof t === "object") return t.name === "web_search";
    return false;
  };

  const getActive = () => {
    try { return latestPi.getActiveTools() || []; }
    catch { return []; }
  };

  const getAll = () => {
    try { return latestPi.getAllTools() || []; }
    catch { return []; }
  };

  const removeWebSearch = () => {
    const active = getActive();
    const filtered = active.filter((t) => !isWebSearch(t));
    try { latestPi.setActiveTools(filtered); } catch {}
  };

  const restoreWebSearch = () => {
    const active = getActive();
    if (active.some(isWebSearch)) return;
    const ws = getAll().find(isWebSearch);
    if (!ws) return;
    try { latestPi.setActiveTools([...active, ws]); } catch {}
  };

  setActiveToolsController({ remove: removeWebSearch, restore: restoreWebSearch });

  // ── session_start: refresh latestPi + remove web_search ─────────────
  try {
    pi.on("session_start", (event, ctx) => {
      latestPi = ctx?.pi || ctx?.extensionApi || pi;
      removeWebSearch();
    });
  } catch {}

  // ── context: inject note + remove web_search EARLY ─────────────────
  try {
    pi.on("context", (event) => {
      try { removeWebSearch(); } catch {}

      const messages = event?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return undefined;

      const modified = messages.map((m) => {
        if (m.role !== "system" && m.role !== "developer") return m;
        if (typeof m.content === "string") {
          return { ...m, content: m.content + SYS_NOTE };
        }
        if (Array.isArray(m.content)) {
          return { ...m, content: [...m.content, { type: "text", text: SYS_NOTE }] };
        }
        return m;
      });

      const hasSystem = messages.some((m) => m.role === "system" || m.role === "developer");
      if (!hasSystem) {
        modified.unshift({ role: "system", content: SYS_NOTE });
      }

      return { messages: modified };
    });
  } catch {}

  // ── first tool_call safety net + straggler web_search handler ───────
  let didFirstRemove = false;

  pi.on("tool_call", async (event, ctx) => {
    if (!didFirstRemove) {
      didFirstRemove = true;
      try { removeWebSearch(); } catch {}
    }

    if (event?.toolName !== "web_search") return undefined;

    const input = event.input || {};
    const query = input.query || input.q || "";
    const maxResults = input.maxResults || 10;

    if (!hasKey() || !query) return undefined;

    let exaData = null;
    try {
      exaData = await callExaAPI(query, { numResults: maxResults, type: "auto" });
    } catch {
      try { restoreWebSearch(); } catch {}
      return undefined;
    }

    const formatted = formatResults(query, exaData.results);
    const messageBody = {
      customType: "exa-search-redirect",
      content: `[Exa search results for "${query}"]\n\n${formatted}`,
      display: false,
    };
    const messageOpts = { deliverAs: "steer", triggerTurn: true };

    let sender = null;
    if (ctx && typeof ctx.sendMessage === "function") sender = ctx;
    else if (ctx && ctx.pi && typeof ctx.pi.sendMessage === "function") sender = ctx.pi;
    else if (latestPi && typeof latestPi.sendMessage === "function") sender = latestPi;

    try { sender?.sendMessage(messageBody, messageOpts); } catch {}

    try { removeWebSearch(); } catch {}
    return false;
  });
}
