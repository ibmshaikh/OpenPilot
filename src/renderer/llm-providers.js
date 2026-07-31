/**
 * Configurable LLM provider catalog for the Add/Edit model form.
 *
 * Add a provider by appending an entry — UI and auto-fill pick it up.
 * Model IDs are fetched live from each provider's OpenAI-compatible
 * GET /models API (overridable via modelsPath / modelsHeaders).
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description?: string,
 *   baseUrl: string,
 *   apiKeyUrl?: string | null,
 *   logoSvg: string,
 *   requiresApiKey?: boolean,
 *   modelsPath?: string,
 *   modelsHeaders?: Record<string, string>,
 * }} LlmProvider
 */

const LOGO = {
  openai: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.774-4.23 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.049zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.784-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l2.02-1.164a.08.08 0 0 1 .038-.054v-5.577c0-1.36.87-2.56 2.164-3.01v6.778a.76.76 0 0 0 .39.676l5.815 3.354-2.02 1.164a.085.085 0 0 1-.076 0l-4.842-2.797a.762.762 0 0 0-.39-.675z"/></svg>`,
  anthropic: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-3.654 0H6.57L0 20.48h3.604l1.534-3.98h6.705l1.33 3.98h3.603L10.173 3.52zM7.515 13.338l2.371-6.15 2.371 6.15H7.515z"/></svg>`,
  openrouter: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zm-9 0a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM7.5 14.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zm9 0a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM9.6 8.4l4.8 2.4M9.6 15.6l4.8-2.4" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>`,
  minimax: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6h3.2l2.4 6.4L12 6h3.2v12H12.8V10.8L10.4 18H8.2L5.8 10.8V18H4V6zm12.5 0H20v12h-3.5V6z"/></svg>`,
  deepseek: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3.5c2.3 0 4.2 1.4 5 3.4-.9.5-1.9.8-3 .8-2.5 0-4.6-1.6-5.4-3.8.4-.3.9-.4 1.4-.4zm-6.3 7c.5-2.8 2.7-5 5.5-5.6.7 2.5 3 4.4 5.7 4.6-.4 2.6-2.5 4.7-5.1 5.2-1.4-1.8-2.4-4-2.8-6.4-.9.5-1.7 1.3-2.3 2.2zm7.8 6.8c-1.1 0-2.1-.3-3-.8.8-2 2.7-3.4 5-3.4.5 0 1 .1 1.4.2-.7 2.2-2.6 4-5 4z"/></svg>`,
  groq: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6h4.5l3.5 7 3.5-7H20v12h-3.2v-7.2L13.5 18h-3L7.2 10.8V18H4V6z"/></svg>`,
  together: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="12" r="4"/><circle cx="16" cy="12" r="4" opacity=".55"/></svg>`,
  mistral: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 19V5h3.2v5.2L9.8 5H13l-3.8 6L13 19H9.8L6.2 12.8V19H3zm11 0V5h3.2v14H14zm4.8 0V5H22v14h-3.2z"/></svg>`,
  xai: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4.5 4.5 12 12m0 0 7.5 7.5M12 12 19.5 4.5M12 12 4.5 19.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`,
  ollama: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><ellipse cx="12" cy="14" rx="8" ry="6"/><circle cx="9" cy="13" r="1.2" fill="#111"/><circle cx="15" cy="13" r="1.2" fill="#111"/><path d="M8 8c1.2-2 2.8-3 4-3s2.8 1 4 3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`,
  custom: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
};

/** @type {LlmProvider[]} */
export const LLM_PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    description: "Official OpenAI API",
    baseUrl: "https://api.openai.com/v1",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    logoSvg: LOGO.openai,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude via OpenAI-compatible API",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    logoSvg: LOGO.anthropic,
    // Anthropic Models API accepts the same Bearer key; version header helps some gateways.
    modelsHeaders: { "anthropic-version": "2023-06-01" },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Aggregator",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyUrl: "https://openrouter.ai/keys",
    logoSvg: LOGO.openrouter,
  },
  {
    id: "minimax",
    name: "MiniMax",
    description: "MiniMax OpenAI-compatible API",
    baseUrl: "https://api.minimax.io/v1",
    apiKeyUrl: "https://platform.minimax.io/",
    logoSvg: LOGO.minimax,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek API",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    logoSvg: LOGO.deepseek,
  },
  {
    id: "groq",
    name: "Groq",
    description: "Fast inference",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyUrl: "https://console.groq.com/keys",
    logoSvg: LOGO.groq,
  },
  {
    id: "together",
    name: "Together AI",
    description: "Open models API",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyUrl: "https://api.together.xyz/settings/api-keys",
    logoSvg: LOGO.together,
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Mistral AI API",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyUrl: "https://console.mistral.ai/api-keys",
    logoSvg: LOGO.mistral,
  },
  {
    id: "xai",
    name: "xAI",
    description: "Grok API",
    baseUrl: "https://api.x.ai/v1",
    apiKeyUrl: "https://console.x.ai/",
    logoSvg: LOGO.xai,
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Local OpenAI-compatible server",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyUrl: null,
    logoSvg: LOGO.ollama,
    requiresApiKey: false,
  },
  {
    id: "custom",
    name: "Custom / Other",
    description: "Any OpenAI-compatible endpoint",
    baseUrl: "",
    apiKeyUrl: null,
    logoSvg: LOGO.custom,
  },
];

/**
 * @param {string} providerId
 * @returns {LlmProvider | undefined}
 */
export function getProviderById(providerId) {
  return LLM_PROVIDERS.find((p) => p.id === providerId);
}

/**
 * Best-effort match of a saved model config to a catalog provider.
 * @param {{ baseUrl?: string, modelName?: string }} model
 * @returns {LlmProvider}
 */
export function matchProvider(model) {
  const base = String(model?.baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
  const modelName = String(model?.modelName || "").trim();

  if (!base) return getProviderById("custom");

  const byUrl = LLM_PROVIDERS.find((p) => {
    if (p.id === "custom" || !p.baseUrl) return false;
    return p.baseUrl.replace(/\/+$/, "").toLowerCase() === base;
  });
  if (byUrl) return byUrl;

  if (modelName.includes("/")) {
    const openrouter = getProviderById("openrouter");
    if (openrouter) return openrouter;
  }

  return getProviderById("custom");
}

/**
 * Default display name for a model id within a provider.
 * @param {LlmProvider | undefined} provider
 * @param {string} modelId
 */
export function defaultDisplayName(provider, modelId) {
  const id = String(modelId || "").trim();
  if (!id) return "";
  if (provider && provider.id !== "custom") {
    return `${provider.name}: ${id}`;
  }
  return id;
}
