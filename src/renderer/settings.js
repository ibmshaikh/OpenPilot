import {
  input,
  settingsModal,
  settingsStatus,
  settingsNavItems,
  settingsPanels,
  modelListEl,
  emptyModelsEl,
  modelFormModal,
  modelForm,
  modelFormTitle,
  modelFormError,
  modelFormSaveBtn,
  modelIdInput,
  modelProviderIdInput,
  modelProviderTrigger,
  modelProviderLogo,
  modelProviderTriggerLabel,
  modelProviderTriggerDesc,
  modelProviderMenu,
  modelProviderKeyLink,
  modelNameSelect,
  modelNameInput,
  modelFetchStatus,
  modelRefreshBtn,
  modelBaseUrlInput,
  modelApiKeyInput,
  modelApiKeyToggle,
  modelVerifyBtn,
  modelVerifyStatus,
  modelDisplayNameInput,
  skillListEl,
  emptySkillsEl,
  skillsUserPathEl,
  skillsProjectPathEl,
  skillsRevealProjectBtn,
  skillFormModal,
  skillForm,
  skillFormTitle,
  skillFormError,
  skillFormSaveBtn,
  skillOriginalNameInput,
  skillOriginalScopeInput,
  skillNameInput,
  skillDescriptionInput,
  skillBodyInput,
  skillScopeUserInput,
  skillScopeProjectInput,
  mcpConfigPathEl,
  mcpBannerEl,
  mcpServerListEl,
  mcpEmptyEl,
  mcpLogsBodyEl,
  tinyfishEnabledInput,
  tinyfishApiKeyInput,
  tinyfishFormError,
  tinyfishSaveBtn,
  memoryEnabledInput,
  memoryUserEnabledInput,
  memoryProjectEnabledInput,
  memoryUserPathEl,
  memoryProjectPathEl,
  memoryRevealProjectBtn,
  memoryFormError,
  memorySaveBtn,
  enableAllPermissionsInput,
  agentFormError,
  agentSaveBtn,
  usageSessionBody,
  usageSessionFoot,
  usageSessionTable,
  usageSessionEmpty,
  usageLifetimeBody,
  usageLifetimeFoot,
  usageLifetimeTable,
  usageLifetimeEmpty,
  usageEstimateHint,
  aboutVersionEl,
  aboutUpdateStatusEl,
} from "./dom.js";
import { state, getSession } from "./state.js";
import { escapeHtml } from "./markdown.js";
import { refreshContextUsage } from "./context-usage.js";
import {
  checkForAppUpdates,
  refreshAboutPanel as refreshUpdateAboutState,
} from "./updater-ui.js";
import {
  maskKey,
  syncComposerModelLabel,
  renderModelMenu,
  renderMcpChatControls,
  setSelectedModel,
  setDefaultModel,
} from "./composer.js";
import { createListSkeleton, setSkeleton } from "./skeleton.js";
import {
  LLM_PROVIDERS,
  getProviderById,
  matchProvider,
  defaultDisplayName,
} from "./llm-providers.js";

export { checkForAppUpdates };

const CUSTOM_MODEL_OPTION = "__custom__";

let modelVerified = false;
let displayNameTouched = false;
let providerMenuBuilt = false;
let verifyingModel = false;
/** @type {Array<{ id: string, label: string }>} */
let remoteModels = [];
let modelsFetchToken = 0;
let modelsFetchTimer = null;
let preferredModelId = "";

export function renderModelList() {
  modelListEl.innerHTML = "";
  emptyModelsEl.hidden = state.customModels.length > 0;

  for (const model of state.customModels) {
    const isDefault = model.id === state.defaultModelId;
    const card = document.createElement("article");
    card.className = `model-card${isDefault ? " is-default" : ""}`;

    const info = document.createElement("div");
    info.className = "model-card-info";

    const titleRow = document.createElement("div");
    titleRow.className = "model-card-title-row";

    const title = document.createElement("div");
    title.className = "model-card-title";
    title.textContent = model.displayName;

    titleRow.append(title);
    if (isDefault) {
      const badge = document.createElement("span");
      badge.className = "model-default-badge";
      badge.textContent = "Default";
      titleRow.append(badge);
    }

    const meta = document.createElement("div");
    meta.className = "model-card-meta";
    meta.textContent = `${model.modelName} · ${model.baseUrl} · ${maskKey(model.apiKey)}`;

    info.append(titleRow, meta);

    const actions = document.createElement("div");
    actions.className = "model-card-actions";

    if (!isDefault) {
      const defaultBtn = document.createElement("button");
      defaultBtn.type = "button";
      defaultBtn.className = "btn secondary";
      defaultBtn.textContent = "Set default";
      defaultBtn.addEventListener("click", () => {
        setDefaultModel(model.id, { syncSelection: true });
        renderModelList();
        settingsStatus.hidden = false;
        settingsStatus.textContent = `"${model.displayName}" is now the default.`;
        window.setTimeout(() => {
          settingsStatus.hidden = true;
        }, 1400);
      });
      actions.append(defaultBtn);
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn secondary";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openModelForm(model));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      deleteSavedModel(model).catch((error) => {
        console.error(error);
        settingsStatus.hidden = false;
        settingsStatus.textContent = error?.message || "Failed to delete model.";
        window.setTimeout(() => {
          settingsStatus.hidden = true;
        }, 2000);
      });
    });

    actions.append(editBtn, deleteBtn);
    card.append(info, actions);
    modelListEl.appendChild(card);
  }

  syncComposerModelLabel();
  renderModelMenu();
}

export async function deleteSavedModel(model) {
  if (!model?.id) return;
  const label = model.displayName || model.modelName || "this model";
  const ok = window.confirm(`Delete "${label}"? This cannot be undone.`);
  if (!ok) return;

  const wasDefault = state.defaultModelId === model.id;
  const wasSelected = state.selectedModelId === model.id;
  await window.onecode.models.delete(model.id);

  if (wasDefault) {
    state.defaultModelId = null;
  }
  if (wasSelected) {
    setSelectedModel(null);
  }

  await refreshModels();
  settingsStatus.hidden = false;
  settingsStatus.textContent = "Model deleted.";
  window.setTimeout(() => {
    settingsStatus.hidden = true;
  }, 1400);
}

export async function refreshModels() {
  if (modelListEl && !modelListEl.childElementCount) {
    if (emptyModelsEl) emptyModelsEl.hidden = true;
    setSkeleton(modelListEl, createListSkeleton(3, "card"));
  }

  const [models, defaultResult] = await Promise.all([
    window.onecode.models.list(),
    window.onecode.models.getDefault().catch(() => ({ id: null })),
  ]);

  state.customModels = models;

  const persistedDefault = Number(defaultResult?.id) || null;
  const isValid = (id) =>
    id != null && state.customModels.some((model) => model.id === id);

  let nextDefault = isValid(persistedDefault) ? persistedDefault : null;
  if (!nextDefault && state.customModels.length) {
    nextDefault = state.customModels[0].id;
  }
  state.defaultModelId = nextDefault;

  if (nextDefault !== persistedDefault) {
    window.onecode.models.setDefault(nextDefault).catch((error) => {
      console.error(error);
    });
  }

  // Chat selection is independent — only reset it when invalid.
  if (!isValid(state.selectedModelId)) {
    setSelectedModel(nextDefault);
  } else {
    syncComposerModelLabel();
    renderModelMenu();
  }

  renderModelList();
}

export function setSettingsSection(section) {
  if (
    section === "mcp" ||
    section === "tinyfish" ||
    section === "memory" ||
    section === "agent" ||
    section === "skills" ||
    section === "usage" ||
    section === "about"
  ) {
    state.activeSettingsSection = section;
  } else {
    state.activeSettingsSection = "models";
  }

  settingsNavItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.section === state.activeSettingsSection);
  });

  settingsPanels.forEach((panel) => {
    const isActive = panel.dataset.panel === state.activeSettingsSection;
    panel.hidden = !isActive;
  });

  if (state.activeSettingsSection === "mcp") {
    refreshMcpPanel().catch((error) => {
      console.error(error);
    });
  } else if (state.activeSettingsSection === "tinyfish") {
    refreshTinyFishPanel().catch((error) => {
      console.error(error);
    });
  } else if (state.activeSettingsSection === "memory") {
    refreshMemoryPanel().catch((error) => {
      console.error(error);
    });
  } else if (state.activeSettingsSection === "agent") {
    refreshAgentPanel();
  } else if (state.activeSettingsSection === "skills") {
    refreshSkillsPanel().catch((error) => {
      console.error(error);
    });
  } else if (state.activeSettingsSection === "usage") {
    refreshUsagePanel().catch((error) => {
      console.error(error);
    });
  } else if (state.activeSettingsSection === "about") {
    refreshAboutPanel().catch((error) => {
      console.error(error);
    });
  }
}

export function formatTokenCount(value) {
  const n = Number(value) || 0;
  return n.toLocaleString();
}

export function renderUsageTable({ bodyEl, footEl, tableEl, emptyEl, rows, total }) {
  if (!bodyEl || !footEl || !tableEl || !emptyEl) return;

  const list = Array.isArray(rows) ? rows : [];
  bodyEl.innerHTML = "";
  footEl.innerHTML = "";

  if (!list.length) {
    tableEl.dataset.empty = "true";
    emptyEl.hidden = false;
    return;
  }

  tableEl.dataset.empty = "false";
  emptyEl.hidden = true;

  for (const row of list) {
    const tr = document.createElement("tr");
    const totalTokens = (row.inputTokens || 0) + (row.outputTokens || 0);
    tr.innerHTML = `
      <td>${escapeHtml(row.modelName || "unknown")}</td>
      <td>${formatTokenCount(row.inputTokens)}</td>
      <td>${formatTokenCount(row.outputTokens)}</td>
      <td>${formatTokenCount(row.cacheReadTokens)}</td>
      <td>${formatTokenCount(row.cacheWriteTokens)}</td>
      <td>${formatTokenCount(row.requestCount)}</td>
      <td>${formatTokenCount(totalTokens)}</td>
    `;
    bodyEl.appendChild(tr);
  }

  const totalRow = total || {};
  const totalTokens =
    (totalRow.inputTokens || 0) + (totalRow.outputTokens || 0);
  footEl.innerHTML = `
    <tr>
      <td>Total</td>
      <td>${formatTokenCount(totalRow.inputTokens)}</td>
      <td>${formatTokenCount(totalRow.outputTokens)}</td>
      <td>${formatTokenCount(totalRow.cacheReadTokens)}</td>
      <td>${formatTokenCount(totalRow.cacheWriteTokens)}</td>
      <td>${formatTokenCount(totalRow.requestCount)}</td>
      <td>${formatTokenCount(totalTokens)}</td>
    </tr>
  `;
}

export async function refreshUsagePanel() {
  if (!window.onecode?.settings?.getUsage) return;

  const sessionBlock = usageSessionTable?.closest(".usage-block");
  const hadRows = Boolean(usageSessionBody?.childElementCount);
  /** @type {HTMLElement | null} */
  let usageSkeleton = null;
  if (!hadRows && sessionBlock) {
    if (usageSessionEmpty) usageSessionEmpty.hidden = true;
    if (usageLifetimeEmpty) usageLifetimeEmpty.hidden = true;
    if (usageSessionTable) usageSessionTable.hidden = true;
    if (usageLifetimeTable) usageLifetimeTable.hidden = true;
    usageSkeleton = createListSkeleton(4, "usage");
    sessionBlock.appendChild(usageSkeleton);
  }

  try {
    const usage = await window.onecode.settings.getUsage();

    usageSkeleton?.remove();
    usageSkeleton = null;
    if (usageSessionTable) usageSessionTable.hidden = false;
    if (usageLifetimeTable) usageLifetimeTable.hidden = false;

    renderUsageTable({
      bodyEl: usageSessionBody,
      footEl: usageSessionFoot,
      tableEl: usageSessionTable,
      emptyEl: usageSessionEmpty,
      rows: usage?.session,
      total: usage?.sessionTotal,
    });

    renderUsageTable({
      bodyEl: usageLifetimeBody,
      footEl: usageLifetimeFoot,
      tableEl: usageLifetimeTable,
      emptyEl: usageLifetimeEmpty,
      rows: usage?.lifetime,
      total: usage?.lifetimeTotal,
    });

    if (usageEstimateHint) {
      usageEstimateHint.hidden = false;
    }
  } catch (error) {
    usageSkeleton?.remove();
    if (usageSessionTable) usageSessionTable.hidden = false;
    if (usageLifetimeTable) usageLifetimeTable.hidden = false;
    throw error;
  }
}

export async function resetUsagePanel() {
  if (!window.onecode?.settings?.resetUsage) return;
  const confirmed = window.confirm(
    "Reset all token usage (this session and lifetime)?"
  );
  if (!confirmed) return;

  await window.onecode.settings.resetUsage({ scope: "all" });
  await refreshUsagePanel();
  settingsStatus.hidden = false;
  settingsStatus.textContent = "Usage reset.";
  window.setTimeout(() => {
    settingsStatus.hidden = true;
  }, 2000);
}

export async function refreshAboutPanel() {
  if (aboutVersionEl && window.onecode?.app?.getVersion) {
    try {
      aboutVersionEl.textContent = await window.onecode.app.getVersion();
    } catch (error) {
      aboutVersionEl.textContent = "—";
      console.error(error);
    }
  }

  await refreshUpdateAboutState();

  if (aboutUpdateStatusEl && !aboutUpdateStatusEl.dataset.locked) {
    aboutUpdateStatusEl.textContent = "Updates apply to installed builds only.";
  }
}

export function clearTinyFishFormError() {
  if (!tinyfishFormError) return;
  tinyfishFormError.hidden = true;
  tinyfishFormError.textContent = "";
}

export function showTinyFishFormError(message) {
  if (!tinyfishFormError) return;
  tinyfishFormError.hidden = false;
  tinyfishFormError.textContent = message;
}

export async function refreshTinyFishPanel() {
  if (!tinyfishEnabledInput || !tinyfishApiKeyInput) return;
  clearTinyFishFormError();
  const settings = await window.onecode.settings.getTinyFish();
  tinyfishEnabledInput.checked = Boolean(settings?.enabled);
  tinyfishApiKeyInput.value = settings?.apiKey || "";
}

export async function saveTinyFishSettings(event) {
  event.preventDefault();
  if (!tinyfishSaveBtn) return;
  clearTinyFishFormError();
  tinyfishSaveBtn.disabled = true;
  try {
    await window.onecode.settings.saveTinyFish({
      enabled: Boolean(tinyfishEnabledInput?.checked),
      apiKey: String(tinyfishApiKeyInput?.value || "").trim(),
    });
    settingsStatus.hidden = false;
    settingsStatus.textContent = "TinyFish settings saved.";
    refreshContextUsage({ force: true });
    setTimeout(() => {
      settingsStatus.hidden = true;
    }, 2000);
  } catch (error) {
    showTinyFishFormError(error?.message || "Failed to save TinyFish settings.");
  } finally {
    tinyfishSaveBtn.disabled = false;
  }
}

function clearMemoryFormError() {
  if (!memoryFormError) return;
  memoryFormError.hidden = true;
  memoryFormError.textContent = "";
}

function showMemoryFormError(message) {
  if (!memoryFormError) return;
  memoryFormError.hidden = false;
  memoryFormError.textContent = message;
}

export async function refreshMemoryPanel() {
  if (!memoryEnabledInput) return;
  clearMemoryFormError();
  const workspacePath = getActiveWorkspacePath();
  const settings = await window.onecode.settings.getMemory(workspacePath);
  memoryEnabledInput.checked = Boolean(settings?.enabled);
  if (memoryUserEnabledInput) {
    memoryUserEnabledInput.checked = settings?.user !== false;
  }
  if (memoryProjectEnabledInput) {
    memoryProjectEnabledInput.checked = settings?.project !== false;
  }
  if (memoryUserPathEl) {
    memoryUserPathEl.textContent = settings?.userPath || "—";
  }
  if (memoryProjectPathEl) {
    memoryProjectPathEl.textContent = settings?.projectPath || "Pick a workspace first";
  }
  if (memoryRevealProjectBtn) {
    memoryRevealProjectBtn.disabled = !settings?.projectAbsolute;
  }
}

export async function saveMemorySettings(event) {
  event.preventDefault();
  if (!memorySaveBtn) return;
  clearMemoryFormError();
  memorySaveBtn.disabled = true;
  try {
    await window.onecode.settings.saveMemory({
      enabled: Boolean(memoryEnabledInput?.checked),
      user: memoryUserEnabledInput ? Boolean(memoryUserEnabledInput.checked) : true,
      project: memoryProjectEnabledInput
        ? Boolean(memoryProjectEnabledInput.checked)
        : true,
      workspacePath: getActiveWorkspacePath(),
    });
    await refreshMemoryPanel();
    refreshContextUsage({ force: true });
    settingsStatus.hidden = false;
    settingsStatus.textContent = "Memory settings saved.";
    setTimeout(() => {
      settingsStatus.hidden = true;
    }, 2000);
  } catch (error) {
    showMemoryFormError(error?.message || "Failed to save Memory settings.");
  } finally {
    memorySaveBtn.disabled = false;
  }
}

function clearAgentFormError() {
  if (!agentFormError) return;
  agentFormError.hidden = true;
  agentFormError.textContent = "";
}

function showAgentFormError(message) {
  if (!agentFormError) return;
  agentFormError.hidden = false;
  agentFormError.textContent = message;
}

const ENABLE_ALL_PERMISSIONS_KEY = "onecode.enableAllPermissions";

/** Global auto-approve: when true, shell/file tools never pause for approval. */
export function isAllPermissionsEnabled() {
  return localStorage.getItem(ENABLE_ALL_PERMISSIONS_KEY) === "1";
}

export function refreshAgentPanel() {
  if (!enableAllPermissionsInput) return;
  clearAgentFormError();
  enableAllPermissionsInput.checked = isAllPermissionsEnabled();
}

export function saveAgentSettings(event) {
  event.preventDefault();
  if (!agentSaveBtn) return;
  clearAgentFormError();
  agentSaveBtn.disabled = true;
  try {
    const enabled = Boolean(enableAllPermissionsInput?.checked);
    localStorage.setItem(ENABLE_ALL_PERMISSIONS_KEY, enabled ? "1" : "0");
    refreshAgentPanel();
    settingsStatus.hidden = false;
    settingsStatus.textContent = "Agent settings saved.";
    setTimeout(() => {
      settingsStatus.hidden = true;
    }, 2000);
  } catch (error) {
    showAgentFormError(error?.message || "Failed to save Agent settings.");
  } finally {
    agentSaveBtn.disabled = false;
  }
}

export async function revealMemoryFile(scope) {
  const workspacePath = getActiveWorkspacePath();
  await window.onecode.settings.revealMemory({ scope, workspacePath });
}

export function renderMcpBanner(status) {
  if (!mcpBannerEl) return;

  if (!status) {
    mcpBannerEl.hidden = true;
    mcpBannerEl.textContent = "";
    mcpBannerEl.className = "mcp-banner";
    return;
  }

  if (status.parseError) {
    mcpBannerEl.hidden = false;
    mcpBannerEl.className = "mcp-banner is-error";
    mcpBannerEl.textContent = `Config invalid: ${status.parseError}`;
    return;
  }

  if (status.testing) {
    mcpBannerEl.hidden = false;
    mcpBannerEl.className = "mcp-banner is-testing";
    mcpBannerEl.textContent = "Testing servers…";
    return;
  }

  const servers = Array.isArray(status.servers) ? status.servers : [];
  const errored = servers.filter((server) => server.status === "error").length;

  if (errored) {
    mcpBannerEl.hidden = false;
    mcpBannerEl.className = "mcp-banner is-error";
    mcpBannerEl.textContent = `${errored} server${errored === 1 ? "" : "s"} failed to connect.`;
    return;
  }

  mcpBannerEl.hidden = true;
  mcpBannerEl.textContent = "";
  mcpBannerEl.className = "mcp-banner";
}

export function renderMcpServers(status) {
  if (!mcpServerListEl || !mcpEmptyEl) return;

  const servers = Array.isArray(status?.servers) ? status.servers : [];
  mcpServerListEl.innerHTML = "";
  mcpEmptyEl.hidden = servers.length > 0;

  for (const server of servers) {
    const card = document.createElement("article");
    card.className = "mcp-server-card";

    const top = document.createElement("div");
    top.className = "mcp-server-top";

    const info = document.createElement("div");
    info.className = "mcp-server-info";

    const name = document.createElement("div");
    name.className = "mcp-server-name";
    name.textContent = server.name || "unnamed";

    const meta = document.createElement("div");
    meta.className = "mcp-server-meta";
    const bits = [];
    if (server.transport) bits.push(server.transport);
    if (server.status === "connected") {
      bits.push(`${server.toolCount || 0} tool${server.toolCount === 1 ? "" : "s"}`);
    } else if (server.status === "testing") {
      bits.push("probing…");
    } else if (server.status === "disabled") {
      bits.push("disabled");
    }
    meta.textContent = bits.join(" · ");

    info.append(name, meta);

    const pill = document.createElement("span");
    const statusKey = String(server.status || "error");
    pill.className = `mcp-status-pill is-${statusKey}`;
    pill.textContent = statusKey === "connected" ? "ok" : statusKey;

    top.append(info, pill);
    card.appendChild(top);

    if (server.error) {
      const errorEl = document.createElement("p");
      errorEl.className = "mcp-server-error";
      errorEl.textContent = server.error;
      card.appendChild(errorEl);
    }

    mcpServerListEl.appendChild(card);
  }
}

export function renderMcpStatus(status) {
  state.mcpStatus = status || null;
  if (mcpConfigPathEl) {
    mcpConfigPathEl.textContent = status?.configPath || "—";
    mcpConfigPathEl.title = status?.configPath || "";
  }
  renderMcpBanner(status);
  renderMcpServers(status);
  renderMcpChatControls();
}

export async function refreshMcpLogs() {
  if (!mcpLogsBodyEl || state.mcpLogsLoading) return;
  state.mcpLogsLoading = true;
  try {
    const logs = await window.onecode.mcp.logs(250);
    mcpLogsBodyEl.textContent = logs?.trim() ? logs : "No MCP logs yet.";
    mcpLogsBodyEl.scrollTop = mcpLogsBodyEl.scrollHeight;
  } catch (error) {
    mcpLogsBodyEl.textContent = error?.message || "Failed to load MCP logs.";
  } finally {
    state.mcpLogsLoading = false;
  }
}

export async function refreshMcpPanel() {
  try {
    const status = await window.onecode.mcp.status();
    renderMcpStatus(status);
  } catch (error) {
    renderMcpBanner({
      parseError: error?.message || "Failed to load MCP status.",
      testing: false,
      servers: [],
    });
  }

  const logsDetails = document.getElementById("mcp-logs-details");
  if (logsDetails?.open) {
    await refreshMcpLogs();
  }
}

export function openSettings(section) {
  settingsStatus.hidden = true;
  settingsModal.hidden = false;
  const next = typeof section === "string" ? section : state.activeSettingsSection;
  setSettingsSection(next);
  refreshModels().catch((error) => {
    console.error(error);
  });
}

export function closeSettings() {
  if (!modelFormModal.hidden) return;
  if (skillFormModal && !skillFormModal.hidden) return;
  settingsModal.hidden = true;
  input.focus();
}

export function clearModelFormError() {
  modelFormError.hidden = true;
  modelFormError.textContent = "";
}

export function showModelFormError(message) {
  modelFormError.hidden = false;
  modelFormError.textContent = message;
}

function setVerifyStatus(message, { ok = false, error = false } = {}) {
  if (!modelVerifyStatus) return;
  if (!message) {
    modelVerifyStatus.hidden = true;
    modelVerifyStatus.textContent = "";
    modelVerifyStatus.classList.remove("is-ok", "is-error");
    return;
  }
  modelVerifyStatus.hidden = false;
  modelVerifyStatus.textContent = message;
  modelVerifyStatus.classList.toggle("is-ok", ok);
  modelVerifyStatus.classList.toggle("is-error", error);
}

function setModelVerified(next) {
  modelVerified = Boolean(next);
  if (modelFormSaveBtn) {
    modelFormSaveBtn.disabled = !modelVerified;
  }
}

function invalidateModelVerification(message = "") {
  setModelVerified(false);
  if (message) {
    setVerifyStatus(message, { error: false });
  } else {
    setVerifyStatus("");
  }
}

function closeProviderMenu() {
  if (!modelProviderMenu || !modelProviderTrigger) return;
  modelProviderMenu.hidden = true;
  modelProviderTrigger.setAttribute("aria-expanded", "false");
}

function openProviderMenu() {
  if (!modelProviderMenu || !modelProviderTrigger) return;
  ensureProviderMenu();
  modelProviderMenu.hidden = false;
  modelProviderTrigger.setAttribute("aria-expanded", "true");
}

function ensureProviderMenu() {
  if (!modelProviderMenu || providerMenuBuilt) return;
  modelProviderMenu.innerHTML = "";

  for (const provider of LLM_PROVIDERS) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "provider-option";
    option.role = "option";
    option.dataset.providerId = provider.id;
    option.setAttribute("aria-selected", "false");

    const logo = document.createElement("span");
    logo.className = "provider-picker-logo";
    logo.innerHTML = provider.logoSvg;
    logo.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "provider-picker-text";

    const name = document.createElement("span");
    name.className = "provider-picker-name";
    name.textContent = provider.name;

    const desc = document.createElement("span");
    desc.className = "provider-picker-desc";
    desc.textContent = provider.description || "";

    text.append(name, desc);
    option.append(logo, text);
    option.addEventListener("click", () => {
      applyProvider(provider.id, { autofill: true });
      closeProviderMenu();
    });
    modelProviderMenu.appendChild(option);
  }

  providerMenuBuilt = true;
}

function syncProviderTrigger(provider) {
  if (!modelProviderTriggerLabel) return;

  if (!provider) {
    modelProviderIdInput.value = "";
    modelProviderTriggerLabel.textContent = "Select a provider";
    if (modelProviderTriggerDesc) modelProviderTriggerDesc.textContent = "";
    if (modelProviderLogo) modelProviderLogo.innerHTML = "";
    if (modelProviderKeyLink) {
      modelProviderKeyLink.hidden = true;
      modelProviderKeyLink.removeAttribute("href");
    }
    return;
  }

  modelProviderIdInput.value = provider.id;
  modelProviderTriggerLabel.textContent = provider.name;
  if (modelProviderTriggerDesc) {
    modelProviderTriggerDesc.textContent = provider.description || "";
  }
  if (modelProviderLogo) {
    modelProviderLogo.innerHTML = provider.logoSvg;
  }

  if (modelProviderKeyLink) {
    if (provider.apiKeyUrl) {
      modelProviderKeyLink.hidden = false;
      modelProviderKeyLink.href = provider.apiKeyUrl;
    } else {
      modelProviderKeyLink.hidden = true;
      modelProviderKeyLink.removeAttribute("href");
    }
  }

  if (modelProviderMenu) {
    for (const option of modelProviderMenu.querySelectorAll(".provider-option")) {
      option.setAttribute(
        "aria-selected",
        option.dataset.providerId === provider.id ? "true" : "false"
      );
    }
  }
}

function setModelsFetchStatus(message, { ok = false, error = false } = {}) {
  if (!modelFetchStatus) return;
  if (!message) {
    modelFetchStatus.hidden = true;
    modelFetchStatus.textContent = "";
    modelFetchStatus.classList.remove("is-ok", "is-error");
    return;
  }
  modelFetchStatus.hidden = false;
  modelFetchStatus.textContent = message;
  modelFetchStatus.classList.toggle("is-ok", ok);
  modelFetchStatus.classList.toggle("is-error", error);
}

function resolveApiKeyForRequest() {
  const raw = modelApiKeyInput?.value.trim() || "";
  if (raw) return raw;
  if (modelProviderIdInput?.value === "ollama") return "ollama";
  return "";
}

function providerNeedsApiKey(provider) {
  return provider?.requiresApiKey !== false;
}

/**
 * Rebuild model name select/input from `remoteModels`.
 * @param {string} [selectedModelId]
 */
function syncModelNameControls(selectedModelId = "") {
  if (!modelNameSelect || !modelNameInput) return;

  const selected = String(selectedModelId || preferredModelId || "").trim();
  const known = remoteModels.some((m) => m.id === selected);

  modelNameSelect.innerHTML = "";

  if (!remoteModels.length) {
    modelNameSelect.hidden = true;
    modelNameInput.hidden = false;
    modelNameInput.required = true;
    if (selected) modelNameInput.value = selected;
    if (modelRefreshBtn) {
      modelRefreshBtn.hidden = !modelBaseUrlInput?.value.trim();
    }
    return;
  }

  for (const model of remoteModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label || model.id;
    modelNameSelect.appendChild(option);
  }

  const customOption = document.createElement("option");
  customOption.value = CUSTOM_MODEL_OPTION;
  customOption.textContent = "Custom model ID…";
  modelNameSelect.appendChild(customOption);

  modelNameSelect.hidden = false;
  if (modelRefreshBtn) modelRefreshBtn.hidden = false;

  if (selected && known) {
    modelNameSelect.value = selected;
    modelNameInput.hidden = true;
    modelNameInput.required = false;
    modelNameInput.value = selected;
  } else if (selected) {
    modelNameSelect.value = CUSTOM_MODEL_OPTION;
    modelNameInput.hidden = false;
    modelNameInput.required = true;
    modelNameInput.value = selected;
  } else {
    modelNameSelect.value = remoteModels[0].id;
    modelNameInput.hidden = true;
    modelNameInput.required = false;
    modelNameInput.value = remoteModels[0].id;
  }
}

function resetRemoteModels(selectedModelId = "") {
  remoteModels = [];
  preferredModelId = String(selectedModelId || "").trim();
  syncModelNameControls(preferredModelId);
  setModelsFetchStatus("");
}

/**
 * Fetch models from the provider's GET /models API.
 * @param {{ selectedModelId?: string, silent?: boolean }} [opts]
 */
async function fetchRemoteModels(opts = {}) {
  const provider = getProviderById(modelProviderIdInput?.value);
  const baseUrl = modelBaseUrlInput?.value.trim() || "";
  const apiKey = resolveApiKeyForRequest();
  const selectedModelId = String(
    opts.selectedModelId ?? preferredModelId ?? getSelectedModelName()
  ).trim();

  if (selectedModelId) preferredModelId = selectedModelId;

  if (!baseUrl) {
    resetRemoteModels(selectedModelId);
    setModelsFetchStatus("Enter a base URL to load models.");
    if (modelRefreshBtn) modelRefreshBtn.hidden = true;
    return;
  }

  if (providerNeedsApiKey(provider) && !apiKey) {
    resetRemoteModels(selectedModelId);
    setModelsFetchStatus("Enter an API key to load models from this provider.");
    if (modelRefreshBtn) modelRefreshBtn.hidden = false;
    modelNameInput.placeholder = "Enter API key to load models";
    return;
  }

  const token = ++modelsFetchToken;
  if (modelRefreshBtn) modelRefreshBtn.hidden = false;
  setModelsFetchStatus("Loading models from provider…");
  modelNameSelect.hidden = true;
  modelNameInput.hidden = false;
  modelNameInput.required = true;
  modelNameInput.placeholder = "Loading models…";
  if (selectedModelId) modelNameInput.value = selectedModelId;

  try {
    const result = await window.onecode.models.listRemote({
      baseUrl,
      apiKey: apiKey || "ollama",
      modelsPath: provider?.modelsPath || "/models",
      headers: provider?.modelsHeaders || undefined,
    });

    if (token !== modelsFetchToken) return;

    remoteModels = Array.isArray(result?.models) ? result.models : [];
    syncModelNameControls(preferredModelId);
    const providerLabel = provider?.name || "provider";
    setModelsFetchStatus(
      `Loaded ${remoteModels.length} model${remoteModels.length === 1 ? "" : "s"} from ${providerLabel}.`,
      { ok: true }
    );

    const currentProvider = getProviderById(modelProviderIdInput?.value);
    maybeAutofillDisplayName(currentProvider);
  } catch (error) {
    if (token !== modelsFetchToken) return;
    remoteModels = [];
    syncModelNameControls(preferredModelId);
    modelNameInput.hidden = false;
    modelNameInput.required = true;
    modelNameInput.placeholder = "e.g. gpt-4o-mini";
    if (preferredModelId) modelNameInput.value = preferredModelId;
    setModelsFetchStatus(
      error?.message
        ? `${error.message} You can still type a model ID manually.`
        : "Could not load models. Type a model ID manually.",
      { error: true }
    );
  }
}

function scheduleFetchRemoteModels(delayMs = 450) {
  if (modelsFetchTimer) {
    window.clearTimeout(modelsFetchTimer);
    modelsFetchTimer = null;
  }
  modelsFetchTimer = window.setTimeout(() => {
    modelsFetchTimer = null;
    fetchRemoteModels().catch((error) => {
      setModelsFetchStatus(error?.message || "Could not load models.", {
        error: true,
      });
    });
  }, delayMs);
}

function getSelectedModelName() {
  if (modelNameSelect && !modelNameSelect.hidden) {
    if (modelNameSelect.value === CUSTOM_MODEL_OPTION || !modelNameInput.hidden) {
      return modelNameInput.value.trim();
    }
    return modelNameSelect.value.trim();
  }
  return modelNameInput.value.trim();
}

function maybeAutofillDisplayName(provider) {
  if (displayNameTouched) return;
  const modelId = getSelectedModelName();
  modelDisplayNameInput.value = defaultDisplayName(provider, modelId);
}

/**
 * @param {string} providerId
 * @param {{ autofill?: boolean, modelName?: string, baseUrl?: string, preserveDisplayName?: boolean, fetchModels?: boolean }} [opts]
 */
function applyProvider(providerId, opts = {}) {
  const provider = getProviderById(providerId) || getProviderById("custom");
  const autofill = opts.autofill !== false;
  const selectedModelId = String(opts.modelName || "").trim();
  preferredModelId = selectedModelId;

  syncProviderTrigger(provider);

  if (autofill) {
    if (opts.baseUrl != null) {
      modelBaseUrlInput.value = opts.baseUrl;
    } else if (provider.baseUrl) {
      modelBaseUrlInput.value = provider.baseUrl;
    } else if (provider.id === "custom" && !opts.modelName) {
      // Keep whatever the user typed when switching to custom mid-edit.
    } else if (!opts.modelName) {
      modelBaseUrlInput.value = "";
    }
  }

  if (modelApiKeyInput) {
    const optionalKey = provider.requiresApiKey === false;
    modelApiKeyInput.required = !optionalKey;
    if (optionalKey && !modelApiKeyInput.value.trim()) {
      modelApiKeyInput.placeholder = "ollama (or any value)";
    } else {
      modelApiKeyInput.placeholder = "sk-...";
    }
  }

  resetRemoteModels(selectedModelId);

  if (!opts.preserveDisplayName) {
    maybeAutofillDisplayName(provider);
  }

  invalidateModelVerification();

  if (opts.fetchModels !== false) {
    scheduleFetchRemoteModels(provider.requiresApiKey === false ? 0 : 150);
  }
}

export function openModelForm(model = null) {
  clearModelFormError();
  setVerifyStatus("");
  setModelsFetchStatus("");
  setModelVerified(false);
  displayNameTouched = false;
  remoteModels = [];
  preferredModelId = "";
  modelsFetchToken += 1;
  if (modelsFetchTimer) {
    window.clearTimeout(modelsFetchTimer);
    modelsFetchTimer = null;
  }
  closeProviderMenu();
  ensureProviderMenu();

  state.editingModelId = model?.id ?? null;
  modelIdInput.value = model?.id ? String(model.id) : "";
  modelFormTitle.textContent = model ? "Edit model configuration" : "Add new model";

  if (model) {
    const provider = matchProvider(model);
    displayNameTouched = true;
    preferredModelId = model.modelName || "";
    applyProvider(provider.id, {
      autofill: true,
      modelName: model.modelName || "",
      baseUrl: model.baseUrl || "",
      preserveDisplayName: true,
      fetchModels: false,
    });
    modelApiKeyInput.value = model.apiKey || "";
    modelDisplayNameInput.value = model.displayName || "";
    scheduleFetchRemoteModels(0);
  } else {
    modelForm.reset();
    modelIdInput.value = "";
    applyProvider("openai", { autofill: true });
    modelApiKeyInput.value = "";
  }

  if (modelApiKeyInput) modelApiKeyInput.type = "password";
  if (modelApiKeyToggle) modelApiKeyToggle.setAttribute("aria-label", "Show API key");

  modelFormModal.hidden = false;
  modelProviderTrigger?.focus();
}

export function closeModelForm() {
  modelFormModal.hidden = true;
  state.editingModelId = null;
  modelForm.reset();
  modelIdInput.value = "";
  closeProviderMenu();
  clearModelFormError();
  setVerifyStatus("");
  setModelsFetchStatus("");
  setModelVerified(false);
  displayNameTouched = false;
  verifyingModel = false;
  remoteModels = [];
  preferredModelId = "";
  modelsFetchToken += 1;
  if (modelsFetchTimer) {
    window.clearTimeout(modelsFetchTimer);
    modelsFetchTimer = null;
  }
  if (modelVerifyBtn) {
    modelVerifyBtn.classList.remove("is-loading");
    modelVerifyBtn.disabled = false;
  }
  if (modelRefreshBtn) modelRefreshBtn.hidden = true;
}

export async function verifyModel() {
  clearModelFormError();
  if (verifyingModel) return;

  const payload = {
    modelName: getSelectedModelName(),
    baseUrl: modelBaseUrlInput.value.trim(),
    apiKey: resolveApiKeyForRequest(),
  };

  if (!payload.modelName || !payload.baseUrl || !payload.apiKey) {
    setModelVerified(false);
    setVerifyStatus("Enter model name, base URL, and API key before verifying.", {
      error: true,
    });
    return;
  }

  verifyingModel = true;
  if (modelVerifyBtn) {
    modelVerifyBtn.classList.add("is-loading");
    modelVerifyBtn.disabled = true;
  }
  setVerifyStatus("Verifying API key…");

  try {
    const result = await window.onecode.models.verify(payload);
    setModelVerified(true);
    setVerifyStatus(result?.message || "API key and model verified.", { ok: true });
  } catch (error) {
    setModelVerified(false);
    setVerifyStatus(error?.message || "Verification failed.", { error: true });
  } finally {
    verifyingModel = false;
    if (modelVerifyBtn) {
      modelVerifyBtn.classList.remove("is-loading");
      modelVerifyBtn.disabled = false;
    }
  }
}

export async function saveModel(event) {
  event.preventDefault();
  clearModelFormError();

  if (!modelVerified) {
    showModelFormError("Verify the API key before saving this model.");
    return;
  }

  const payload = {
    modelName: getSelectedModelName(),
    baseUrl: modelBaseUrlInput.value.trim(),
    apiKey: resolveApiKeyForRequest(),
    displayName: modelDisplayNameInput.value.trim(),
  };

  try {
    if (state.editingModelId) {
      await window.onecode.models.update(state.editingModelId, payload);
    } else {
      const created = await window.onecode.models.create(payload);
      // Only become the default when none is set yet (first model).
      const hasDefault = state.customModels.some(
        (model) => model.id === state.defaultModelId
      );
      if (!hasDefault && created?.id) {
        setDefaultModel(created.id, { syncSelection: true });
      } else if (created?.id && state.selectedModelId == null) {
        setSelectedModel(created.id);
      }
    }

    await refreshModels();
    closeModelForm();
    settingsStatus.hidden = false;
    settingsStatus.textContent = "Model saved.";
    window.setTimeout(() => {
      settingsStatus.hidden = true;
    }, 1400);
  } catch (error) {
    showModelFormError(error?.message || "Failed to save model.");
  }
}

export function initModelFormControls() {
  ensureProviderMenu();

  modelProviderKeyLink?.addEventListener("click", (event) => {
    event.preventDefault();
    const url = modelProviderKeyLink.getAttribute("href");
    if (!url || url === "#") return;
    window.onecode.app.openExternal(url).catch((error) => {
      console.error(error);
    });
  });

  modelProviderTrigger?.addEventListener("click", (event) => {
    event.preventDefault();
    if (modelProviderMenu?.hidden) openProviderMenu();
    else closeProviderMenu();
  });

  modelProviderTrigger?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openProviderMenu();
    } else if (event.key === "Escape") {
      closeProviderMenu();
    }
  });

  document.addEventListener("click", (event) => {
    if (!modelProviderMenu || modelProviderMenu.hidden) return;
    const picker = modelProviderTrigger?.closest(".provider-picker");
    if (picker && picker.contains(event.target)) return;
    closeProviderMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!modelProviderMenu || modelProviderMenu.hidden) return;
    event.stopImmediatePropagation();
    closeProviderMenu();
  });

  modelNameSelect?.addEventListener("change", () => {
    const provider = getProviderById(modelProviderIdInput.value);
    if (modelNameSelect.value === CUSTOM_MODEL_OPTION) {
      modelNameInput.hidden = false;
      modelNameInput.required = true;
      modelNameInput.value = "";
      preferredModelId = "";
      modelNameInput.focus();
    } else {
      modelNameInput.hidden = true;
      modelNameInput.required = false;
      modelNameInput.value = modelNameSelect.value;
      preferredModelId = modelNameSelect.value;
      maybeAutofillDisplayName(provider);
    }
    invalidateModelVerification();
  });

  modelNameInput?.addEventListener("input", () => {
    preferredModelId = modelNameInput.value.trim();
    const provider = getProviderById(modelProviderIdInput.value);
    maybeAutofillDisplayName(provider);
    invalidateModelVerification();
  });

  modelBaseUrlInput?.addEventListener("input", () => {
    invalidateModelVerification();
    scheduleFetchRemoteModels();
  });

  modelApiKeyInput?.addEventListener("input", () => {
    invalidateModelVerification();
    scheduleFetchRemoteModels();
  });

  modelRefreshBtn?.addEventListener("click", () => {
    fetchRemoteModels().catch((error) => {
      setModelsFetchStatus(error?.message || "Could not load models.", {
        error: true,
      });
    });
  });

  modelDisplayNameInput?.addEventListener("input", () => {
    displayNameTouched = Boolean(modelDisplayNameInput.value.trim());
  });

  modelApiKeyToggle?.addEventListener("click", () => {
    if (!modelApiKeyInput) return;
    const showing = modelApiKeyInput.type === "text";
    modelApiKeyInput.type = showing ? "password" : "text";
    modelApiKeyToggle.setAttribute("aria-label", showing ? "Show API key" : "Hide API key");
    modelApiKeyToggle.title = showing ? "Show API key" : "Hide API key";
  });

  modelVerifyBtn?.addEventListener("click", () => {
    verifyModel().catch((error) => {
      setModelVerified(false);
      setVerifyStatus(error?.message || "Verification failed.", { error: true });
    });
  });
}

export function getActiveWorkspacePath() {
  return getSession()?.workspacePath || null;
}

export function clearSkillFormError() {
  if (!skillFormError) return;
  skillFormError.hidden = true;
  skillFormError.textContent = "";
}

export function showSkillFormError(message) {
  if (!skillFormError) return;
  skillFormError.hidden = false;
  skillFormError.textContent = message;
}

export function getSelectedSkillScope() {
  if (skillScopeProjectInput?.checked) return "project";
  return "user";
}

export function setSkillScopeInputs(scope, { locked = false } = {}) {
  const isProject = scope === "project";
  if (skillScopeUserInput) {
    skillScopeUserInput.checked = !isProject;
    skillScopeUserInput.disabled = locked;
  }
  if (skillScopeProjectInput) {
    skillScopeProjectInput.checked = isProject;
    skillScopeProjectInput.disabled = locked;
  }
}

export function renderSkillList() {
  if (!skillListEl || !emptySkillsEl) return;
  skillListEl.innerHTML = "";
  emptySkillsEl.hidden = state.skillsCatalog.length > 0;

  for (const skill of state.skillsCatalog) {
    const card = document.createElement("article");
    card.className = "model-card skill-card";

    const info = document.createElement("div");
    info.className = "model-card-info";

    const titleRow = document.createElement("div");
    titleRow.className = "skill-card-title-row";

    const title = document.createElement("div");
    title.className = "model-card-title";
    title.textContent = skill.name;

    const badge = document.createElement("span");
    badge.className = `skill-scope-badge scope-${skill.scope}`;
    badge.textContent = skill.scope === "project" ? "Project" : "User";

    titleRow.append(title, badge);

    const meta = document.createElement("div");
    meta.className = "model-card-meta";
    meta.textContent = skill.description || skill.pathLabel || "";

    info.append(titleRow, meta);

    const actions = document.createElement("div");
    actions.className = "model-card-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn secondary";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openSkillForm(skill));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn secondary";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      deleteSkillCard(skill).catch((error) => {
        console.error(error);
        window.alert(error?.message || "Failed to delete skill.");
      });
    });

    actions.append(editBtn, deleteBtn);
    card.append(info, actions);
    skillListEl.appendChild(card);
  }
}

export async function refreshSkillsPanel() {
  if (!window.onecode?.skills) return;
  if (skillListEl && !skillListEl.childElementCount) {
    if (emptySkillsEl) emptySkillsEl.hidden = true;
    setSkeleton(skillListEl, createListSkeleton(3, "card"));
  }
  const workspacePath = getActiveWorkspacePath();
  const result = await window.onecode.skills.list(workspacePath);
  state.skillsCatalog = [
    ...(result?.userSkills || []),
    ...(result?.projectSkills || []),
  ];
  if (skillsUserPathEl) {
    skillsUserPathEl.textContent = result?.paths?.user || "—";
  }
  if (skillsProjectPathEl) {
    skillsProjectPathEl.textContent = result?.paths?.project || "Pick a workspace first";
  }
  if (skillsRevealProjectBtn) {
    skillsRevealProjectBtn.disabled = !result?.paths?.projectAbsolute;
  }
  renderSkillList();
}

export function openSkillForm(skill = null) {
  if (!skillFormModal) return;
  clearSkillFormError();
  state.editingSkillKey = skill ? `${skill.scope}:${skill.name}` : null;
  skillOriginalNameInput.value = skill?.name || "";
  skillOriginalScopeInput.value = skill?.scope || "";
  skillFormTitle.textContent = skill ? "Edit skill" : "Add skill";
  skillNameInput.value = skill?.name || "";
  skillDescriptionInput.value = skill?.description || "";
  skillBodyInput.value = skill?.body || "";
  setSkillScopeInputs(skill?.scope || "user", { locked: Boolean(skill) });
  skillFormModal.hidden = false;
  skillNameInput.focus();
}

export function closeSkillForm() {
  if (!skillFormModal) return;
  skillFormModal.hidden = true;
  state.editingSkillKey = null;
  skillForm.reset();
  skillOriginalNameInput.value = "";
  skillOriginalScopeInput.value = "";
  setSkillScopeInputs("user", { locked: false });
  clearSkillFormError();
}

export async function saveSkill(event) {
  event.preventDefault();
  if (!skillFormSaveBtn) return;
  clearSkillFormError();

  const workspacePath = getActiveWorkspacePath();
  const scope = state.editingSkillKey
    ? skillOriginalScopeInput.value || getSelectedSkillScope()
    : getSelectedSkillScope();
  const name = skillNameInput.value.trim();
  const description = skillDescriptionInput.value.trim();
  const body = skillBodyInput.value;

  if (scope === "project" && !workspacePath) {
    showSkillFormError("Pick a workspace folder before creating a project skill.");
    return;
  }

  skillFormSaveBtn.disabled = true;
  try {
    if (state.editingSkillKey) {
      await window.onecode.skills.update({
        scope,
        name: skillOriginalNameInput.value.trim(),
        renameTo: name,
        description,
        body,
        workspacePath,
      });
    } else {
      await window.onecode.skills.create({
        scope,
        name,
        description,
        body,
        workspacePath,
      });
    }

    await refreshSkillsPanel();
    closeSkillForm();
    settingsStatus.hidden = false;
    settingsStatus.textContent = "Skill saved.";
    window.setTimeout(() => {
      settingsStatus.hidden = true;
    }, 1400);
  } catch (error) {
    showSkillFormError(error?.message || "Failed to save skill.");
  } finally {
    skillFormSaveBtn.disabled = false;
  }
}

export async function deleteSkillCard(skill) {
  const workspacePath = getActiveWorkspacePath();
  const ok = window.confirm(`Delete skill "${skill.name}" (${skill.scope})?`);
  if (!ok) return;
  await window.onecode.skills.delete({
    scope: skill.scope,
    name: skill.name,
    workspacePath,
  });
  await refreshSkillsPanel();
  settingsStatus.hidden = false;
  settingsStatus.textContent = "Skill deleted.";
  window.setTimeout(() => {
    settingsStatus.hidden = true;
  }, 1400);
}

export async function revealSkillsDir(scope) {
  const workspacePath = getActiveWorkspacePath();
  await window.onecode.skills.reveal({ scope, workspacePath });
}
