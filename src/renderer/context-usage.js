import {
  contextUsageRoot,
  contextRingBtn,
  contextRingFill,
  contextUsagePopup,
  contextUsageClose,
  contextUsagePercent,
  contextUsageTokens,
  contextUsageBar,
  contextUsageList,
  input,
} from "./dom.js";
import { state } from "./state.js";

/** @type {object|null} */
let latestUsage = null;
let refreshTimer = 0;
let draftTimer = 0;

function getDraftText() {
  if (!input) return "";
  return (input.textContent || "").replace(/\u00a0/g, " ");
}

function getSelectedModelId() {
  if (!state.customModels.length) return null;
  if (state.selectedModelId == null) return null;
  const selected = state.customModels.find(
    (model) => model.id === state.selectedModelId
  );
  return selected?.id || null;
}

function getMcpPayload() {
  const servers = state.mcpChatEnabled ? [...state.mcpSelectedServers] : [];
  return {
    enabled: Boolean(state.mcpChatEnabled),
    servers,
  };
}

function formatTokenCount(value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}K`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function isPopupOpen() {
  return Boolean(contextUsagePopup && !contextUsagePopup.hidden);
}

export function closeContextUsagePopup() {
  if (!contextUsagePopup || !contextUsageRoot || !contextRingBtn) return;
  contextUsagePopup.hidden = true;
  contextUsageRoot.classList.remove("open");
  contextRingBtn.setAttribute("aria-expanded", "false");
}

export function openContextUsagePopup() {
  if (!contextUsagePopup || !contextUsageRoot || !contextRingBtn) return;
  contextUsagePopup.hidden = false;
  contextUsageRoot.classList.add("open");
  contextRingBtn.setAttribute("aria-expanded", "true");
  refreshContextUsage({ force: true });
}

export function toggleContextUsagePopup() {
  if (isPopupOpen()) closeContextUsagePopup();
  else openContextUsagePopup();
}

function applyRing(percent) {
  if (!contextRingFill || !contextRingBtn) return;
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  // pathLength="100" → dasharray is "filled remaining"
  contextRingFill.style.strokeDasharray = `${pct} ${100 - pct}`;
  contextRingBtn.classList.toggle("is-warn", pct >= 70 && pct < 90);
  contextRingBtn.classList.toggle("is-full", pct >= 90);
  contextRingBtn.title =
    pct >= 90
      ? `Context nearly full (${pct}%)`
      : pct > 0
        ? `Context ${pct}% full`
        : "Context usage";
}

function renderPopup(usage) {
  if (!usage) return;

  if (contextUsagePercent) {
    contextUsagePercent.textContent = `${usage.percent ?? 0}% Full`;
  }
  if (contextUsageTokens) {
    contextUsageTokens.textContent = `~${formatTokenCount(usage.totalTokens)} / ${formatTokenCount(
      usage.maxTokens
    )} Tokens`;
  }

  if (contextUsageBar) {
    contextUsageBar.innerHTML = "";
    const maxTokens = Math.max(1, Number(usage.maxTokens) || 1);
    for (const category of usage.categories || []) {
      const tokens = Number(category.tokens) || 0;
      if (tokens <= 0) continue;
      const seg = document.createElement("div");
      seg.className = "context-usage-bar-seg";
      seg.style.flexGrow = String(tokens);
      seg.style.flexBasis = "0";
      seg.style.background = category.color || "#888";
      seg.title = `${category.label}: ${formatTokenCount(tokens)}`;
      contextUsageBar.appendChild(seg);
    }
    // Empty remainder of the window
    const used = Math.min(maxTokens, Number(usage.totalTokens) || 0);
    const remain = Math.max(0, maxTokens - used);
    if (remain > 0) {
      const empty = document.createElement("div");
      empty.className = "context-usage-bar-seg";
      empty.style.flexGrow = String(remain);
      empty.style.flexBasis = "0";
      empty.style.background = "transparent";
      contextUsageBar.appendChild(empty);
    }
  }

  if (contextUsageList) {
    contextUsageList.innerHTML = "";
    for (const category of usage.categories || []) {
      const li = document.createElement("li");
      li.className = "context-usage-row";

      const left = document.createElement("div");
      left.className = "context-usage-row-left";

      const swatch = document.createElement("span");
      swatch.className = "context-usage-swatch";
      swatch.style.background = category.color || "#888";

      const label = document.createElement("span");
      label.className = "context-usage-label";
      label.textContent = category.label;

      left.append(swatch, label);

      const count = document.createElement("span");
      count.className = "context-usage-count";
      count.textContent = formatTokenCount(category.tokens);

      li.append(left, count);
      contextUsageList.appendChild(li);
    }
  }
}

export function applyContextUsage(usage) {
  if (!usage || typeof usage !== "object") return;
  latestUsage = usage;
  applyRing(usage.percent);
  if (isPopupOpen()) renderPopup(usage);
}

export async function refreshContextUsage({ force = false } = {}) {
  if (!window.onecode?.chat?.getContextUsage) return;
  if (!force && refreshTimer) return;

  const run = async () => {
    refreshTimer = 0;
    try {
      const usage = await window.onecode.chat.getContextUsage({
        conversationId: state.activeConversationId,
        modelId: getSelectedModelId(),
        mcp: getMcpPayload(),
        draftText: getDraftText(),
      });
      applyContextUsage(usage);
    } catch (error) {
      console.error("Failed to refresh context usage:", error);
    }
  };

  if (force) {
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
      refreshTimer = 0;
    }
    await run();
    return;
  }

  refreshTimer = window.setTimeout(run, 180);
}

export function scheduleContextUsageRefreshFromDraft() {
  if (draftTimer) window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    draftTimer = 0;
    refreshContextUsage();
  }, 400);
}

export function initContextUsage() {
  if (!contextRingBtn) return;

  contextRingBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleContextUsagePopup();
  });

  if (contextUsageClose) {
    contextUsageClose.addEventListener("click", (event) => {
      event.preventDefault();
      closeContextUsagePopup();
    });
  }

  document.addEventListener("mousedown", (event) => {
    if (!isPopupOpen()) return;
    const target = event.target;
    if (contextUsageRoot?.contains(target)) return;
    closeContextUsagePopup();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isPopupOpen()) {
      closeContextUsagePopup();
    }
  });

  if (input) {
    input.addEventListener("input", () => {
      scheduleContextUsageRefreshFromDraft();
    });
  }

  applyRing(0);
  refreshContextUsage({ force: true });
}
