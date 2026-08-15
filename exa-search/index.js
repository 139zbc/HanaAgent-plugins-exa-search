// index.js — exa-search plugin lifecycle
//
// 1. Reads the Exa API key from plugin config (secret field needs
//    { decrypt: true }) with a dataDir/api-key.txt fallback.
// 2. Registers the exa_search tool (delegates to searchAsTool, which
//    restores web_search on failure).

import { setExaKey, searchAsTool } from "./lib/exa-client.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const FALLBACK_KEY_FILE = "api-key.txt";

function looksLikeMask(s) {
  // HanaAgent may return masked values like "***" / "••••"
  return /^[•\*\s]+$/.test(s);
}

export default class ExaSearchPlugin {
  async onload() {
    const ctx = this.ctx;
    let apiKey = null;

    // Primary: plugin config (secret field)
    if (typeof ctx.config?.get === "function") {
      try {
        const v = await ctx.config.get("exaApiKey", { decrypt: true });
        if (typeof v === "string" && v.length >= 8 && !looksLikeMask(v)) apiKey = v;
      } catch {}
      if (!apiKey) {
        try {
          const v = await ctx.config.get("exaApiKey");
          if (typeof v === "string" && v.length >= 8 && !looksLikeMask(v)) apiKey = v;
        } catch {}
      }
    }

    // Fallback: dataDir/api-key.txt (bypasses config storage if needed)
    if (!apiKey && ctx.dataDir) {
      try {
        const v = (await fs.readFile(join(ctx.dataDir, FALLBACK_KEY_FILE), "utf8")).trim();
        if (v && v.length >= 8) apiKey = v;
      } catch {}
    }

    setExaKey(apiKey || "");

    if (apiKey && typeof ctx.registerTool === "function") {
      ctx.registerTool({
        name: "exa_search",
        description:
          "PRIMARY web search tool (web_search is unavailable). Search the web using Exa's neural search engine. " +
          "Supports semantic similarity (neural), exact keywords (keyword), or hybrid (auto). " +
          "If this tool fails, web_search is automatically re-enabled.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            numResults: { type: "number", description: "Number of results, default 10" },
            searchType: {
              type: "string",
              enum: ["auto", "neural", "keyword"],
              description: "Search type. neural = semantic, keyword = exact, auto = hybrid.",
              default: "auto",
            },
          },
          required: ["query"],
        },
        execute: async (input) =>
          searchAsTool(input.query, {
            numResults: input.numResults || 10,
            type: input.searchType || "auto",
          }),
      });
    }
  }
}
