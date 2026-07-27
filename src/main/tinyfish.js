const { tool } = require("@langchain/core/tools");
const { z } = require("zod");

const SEARCH_ENDPOINT = "https://api.search.tinyfish.ai";
const FETCH_ENDPOINT = "https://api.fetch.tinyfish.ai";

function truncate(text, max = 12000) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n…[truncated]`;
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    if (!text) return response.statusText || `HTTP ${response.status}`;
    try {
      const json = JSON.parse(text);
      return (
        json.message ||
        json.error ||
        json.detail ||
        (typeof json === "string" ? json : text)
      );
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

/**
 * Search the web via TinyFish Search API.
 * @see https://docs.tinyfish.ai/search-api
 */
async function searchWeb(apiKey, { query, purpose, page = 0 } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new Error("TinyFish API key is not configured. Add it in Settings → TinyFish.");
  }

  const q = String(query || "").trim();
  if (!q) {
    throw new Error("Search query is required.");
  }

  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("query", q);
  if (purpose) url.searchParams.set("purpose", String(purpose).trim().slice(0, 2000));
  if (Number.isInteger(page) && page > 0) {
    url.searchParams.set("page", String(Math.min(page, 10)));
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-API-Key": key,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`TinyFish search failed (${response.status}): ${await readErrorBody(response)}`);
  }

  return response.json();
}

/**
 * Fetch and extract page content via TinyFish Fetch API.
 * @see https://docs.tinyfish.ai/fetch-api
 */
async function fetchUrls(apiKey, { urls, format = "markdown" } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new Error("TinyFish API key is not configured. Add it in Settings → TinyFish.");
  }

  const list = (Array.isArray(urls) ? urls : [urls])
    .map((u) => String(u || "").trim())
    .filter(Boolean)
    .slice(0, 10);

  if (!list.length) {
    throw new Error("At least one URL is required.");
  }

  const response = await fetch(FETCH_ENDPOINT, {
    method: "POST",
    headers: {
      "X-API-Key": key,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      urls: list,
      format: format === "html" || format === "json" ? format : "markdown",
    }),
  });

  if (!response.ok) {
    throw new Error(`TinyFish fetch failed (${response.status}): ${await readErrorBody(response)}`);
  }

  return response.json();
}

function formatSearchResults(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) {
    return JSON.stringify(
      {
        query: data?.query || "",
        results: [],
        message: "No search results found.",
      },
      null,
      2
    );
  }

  const compact = results.slice(0, 10).map((item) => ({
    position: item.position,
    title: item.title,
    url: item.url,
    site: item.site_name,
    snippet: item.snippet,
    date: item.date || item.published_date || undefined,
    publisher: item.publisher || undefined,
  }));

  return truncate(
    JSON.stringify(
      {
        query: data?.query || "",
        total_results: data?.total_results ?? compact.length,
        results: compact,
      },
      null,
      2
    ),
    14000
  );
}

function formatFetchResults(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const errors = Array.isArray(data?.errors) ? data.errors : [];

  const compact = results.map((item) => ({
    url: item.url,
    title: item.title,
    content: truncate(item.content || item.markdown || item.text || "", 10000),
    links: Array.isArray(item.links) ? item.links.slice(0, 20) : undefined,
  }));

  return truncate(
    JSON.stringify(
      {
        results: compact,
        errors: errors.length ? errors : undefined,
      },
      null,
      2
    ),
    24000
  );
}

function createTinyFishTools(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return [];

  const webSearch = tool(
    async ({ query, purpose }) => {
      const data = await searchWeb(key, { query, purpose });
      return formatSearchResults(data);
    },
    {
      name: "web_search",
      description:
        "Search the live web with TinyFish. Use when you need current information, docs, library versions, error explanations, or any facts not in the local workspace. Returns ranked titles, URLs, and snippets. After searching, use web_fetch on promising URLs when you need full page content.",
      schema: z.object({
        query: z
          .string()
          .describe("Search query. Prefer specific keywords; operators like site:docs.example.com work."),
        purpose: z
          .string()
          .optional()
          .describe(
            "Optional short intent for better results, e.g. 'Find the official API for X in Python'."
          ),
      }),
    }
  );

  const webFetch = tool(
    async ({ urls, format }) => {
      const data = await fetchUrls(key, { urls, format });
      return formatFetchResults(data);
    },
    {
      name: "web_fetch",
      description:
        "Fetch one or more URLs (up to 10) via TinyFish and extract clean page content (markdown by default). Use after web_search when snippets are not enough, or when the user gives a specific URL to read.",
      schema: z.object({
        urls: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .describe("URLs to fetch (1–10). Prefer absolute https URLs from search results."),
        format: z
          .enum(["markdown", "html", "json"])
          .optional()
          .describe("Extraction format. Default markdown is best for answering questions."),
      }),
    }
  );

  return [webSearch, webFetch];
}

module.exports = {
  searchWeb,
  fetchUrls,
  createTinyFishTools,
};
