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
  modelIdInput,
  modelNameInput,
  modelBaseUrlInput,
  modelApiKeyInput,
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
} from "./dom.js";
import { state, getSession, SELECTED_MODEL_KEY } from "./state.js";
import { escapeHtml } from "./markdown.js";
import { refreshContextUsage } from "./context-usage.js";
import {
  maskKey,
  syncComposerModelLabel,
  renderModelMenu,
  renderMcpChatControls,
} from "./composer.js";
import { createListSkeleton, setSkeleton } from "./skeleton.js";

export function renderModelList() {
  modelListEl.innerHTML = "";
  emptyModelsEl.hidden = state.customModels.length > 0;

  for (const model of state.customModels) {
    const card = document.createElement("article");
    card.className = "model-card";

    const info = document.createElement("div");
    info.className = "model-card-info";

    const title = document.createElement("div");
    title.className = "model-card-title";
    title.textContent = model.displayName;

    const meta = document.createElement("div");
    meta.className = "model-card-meta";
    meta.textContent = `${model.modelName} · ${model.baseUrl} · ${maskKey(model.apiKey)}`;

    info.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "model-card-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn secondary";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openModelForm(model));

    actions.append(editBtn);
    card.append(info, actions);
    modelListEl.appendChild(card);
  }

  syncComposerModelLabel();
  renderModelMenu();
}

export async function refreshModels() {
  if (modelListEl && !modelListEl.childElementCount) {
    if (emptyModelsEl) emptyModelsEl.hidden = true;
    setSkeleton(modelListEl, createListSkeleton(3, "card"));
  }

  state.customModels = await window.onecode.models.list();

  if (state.customModels.length && !state.customModels.some((model) => model.id === state.selectedModelId)) {
    state.selectedModelId = state.customModels[0].id;
    localStorage.setItem(SELECTED_MODEL_KEY, String(state.selectedModelId));
  }

  if (!state.customModels.length) {
    state.selectedModelId = null;
    localStorage.removeItem(SELECTED_MODEL_KEY);
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
    section === "usage"
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

export function openModelForm(model = null) {
  clearModelFormError();
  state.editingModelId = model?.id ?? null;
  modelIdInput.value = model?.id ? String(model.id) : "";
  modelFormTitle.textContent = model ? "Edit model" : "Add new model";
  modelNameInput.value = model?.modelName || "";
  modelBaseUrlInput.value = model?.baseUrl || "";
  modelApiKeyInput.value = model?.apiKey || "";
  modelDisplayNameInput.value = model?.displayName || "";
  modelFormModal.hidden = false;
  modelNameInput.focus();
}

export function closeModelForm() {
  modelFormModal.hidden = true;
  state.editingModelId = null;
  modelForm.reset();
  modelIdInput.value = "";
  clearModelFormError();
}

export async function saveModel(event) {
  event.preventDefault();
  clearModelFormError();

  const payload = {
    modelName: modelNameInput.value.trim(),
    baseUrl: modelBaseUrlInput.value.trim(),
    apiKey: modelApiKeyInput.value.trim(),
    displayName: modelDisplayNameInput.value.trim(),
  };

  try {
    if (state.editingModelId) {
      await window.onecode.models.update(state.editingModelId, payload);
    } else {
      const created = await window.onecode.models.create(payload);
      if (created?.id) {
        state.selectedModelId = created.id;
        localStorage.setItem(SELECTED_MODEL_KEY, String(created.id));
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
