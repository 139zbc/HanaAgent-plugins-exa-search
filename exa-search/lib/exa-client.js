// lib/exa-client.js — shared module for exa-search plugin
//
// Holds the Exa API key (set by index.js onload) and exposes:
//   - callExaAPI()   — raw Exa search API call (throws on error)
//   - searchAsTool() — tool entry point; on failure triggers restoreWebSearch()
//   - setActiveToolsController() — lets the extension register remove/restore
//     callbacks so index.js can control web_search availability
//   - triggerRemoveWebSearch() / triggerRestoreWebSearch()

let _exaApiKey = "";

export function setExaKey(k) {
  _exaApiKey = (k || "").trim();
}

export function hasKey() {
  return !!_exaApiKey;
}

export function formatResults(query, results) {
  if (!Array.isArray(results) || results.length === 0) return "_(no results)_";
  return results
    .map((r, i) => `${i + 1}. **${r.title || "(no title)"}**\n   ${r.url || ""}\n   ${r.text || ""}`)
    .join("\n\n");
}

export async function callExaAPI(query, opts = {}) {
  if (!_exaApiKey) {
    throw new Error("Exa API key not configured");
  }
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": _exaApiKey,
    },
    body: JSON.stringify({
      query,
      numResults: opts.numResults || 10,
      type: opts.type || "auto",
      contents: { text: { maxCharacters: 2000 } },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Exa API ${res.status}: ${errText.slice(0, 200)}`);
  }
  return await res.json();
}

// ── Active-tools controller (registered by extension factory) ────────
// The exa_search tool lives in index.js and has no direct access to the
// Pi SDK `pi` reference (which holds setActiveTools). The extension shares
// its remove/restore callbacks here so the tool can control web_search.

let _removeWebSearch = null;
let _restoreWebSearch = null;

export function setActiveToolsController({ remove, restore }) {
  if (typeof remove === "function") _removeWebSearch = remove;
  if (typeof restore === "function") _restoreWebSearch = restore;
}

export function triggerRemoveWebSearch() {
  if (_removeWebSearch) {
    try { _removeWebSearch(); return true; } catch {}
  }
  return false;
}

export function triggerRestoreWebSearch() {
  if (_restoreWebSearch) {
    try { _restoreWebSearch(); return true; } catch {}
  }
  return false;
}

// ── exa_search tool entry — never throws, returns a tool result ──────
// On failure: restores web_search so the LLM can fall back.
export async function searchAsTool(query, opts = {}) {
  try {
    const data = await callExaAPI(query, opts);
    const formatted = formatResults(query, data.results);
    return {
      content: [{ type: "text", text: `Exa search results for "${query}":\n\n${formatted}` }],
      details: { provider: "exa", query, count: data.results?.length || 0, type: opts.type || "auto" },
    };
  } catch (err) {
    triggerRestoreWebSearch();
    return {
      content: [
        {
          type: "text",
          text:
            `Exa search failed: ${err.message}\n\n` +
            `web_search has been restored. Please retry your search using web_search.`,
        },
      ],
      details: { provider: "exa", error: err.message, fallback: "web_search" },
    };
  }
}
