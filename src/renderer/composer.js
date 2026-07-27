import {
  input,
  form,
  skillsSlashMenu,
  skillsSlashList,
  skillsSlashEmpty,
  modelLabel,
  modelMenu,
  modelPicker,
  modelChip,
  modelMenuList,
  modelMenuEmpty,
  mcpMenu,
  mcpPicker,
  mcpPill,
  mcpPillLabel,
  mcpEnabledToggle,
  mcpMenuActions,
  mcpMenuList,
  mcpMenuEmpty,
  planPill,
  composerAttachments,
  attachBtn,
  attachInput,
} from "./dom.js";
import {
  state,
  getSession,
  SELECTED_MODEL_KEY,
  MCP_ENABLED_KEY,
  MCP_SERVERS_KEY,
} from "./state.js";
import { stopAgent, submitPrompt } from "./chat.js";
import { refreshContextUsage } from "./context-usage.js";

const MAX_ATTACHMENTS = 6;

export function getPendingAttachments() {
  const session = getSession();
  return Array.isArray(session?.pendingAttachments)
    ? session.pendingAttachments
    : [];
}

export function clearPendingAttachments() {
  const session = getSession();
  if (session) session.pendingAttachments = [];
  renderAttachmentPreviews();
}

export function renderAttachmentPreviews() {
  if (!composerAttachments) return;
  const attachments = getPendingAttachments();
  composerAttachments.replaceChildren();
  if (!attachments.length) {
    composerAttachments.hidden = true;
    return;
  }
  composerAttachments.hidden = false;
  attachments.forEach((att, index) => {
    const chip = document.createElement("div");
    chip.className = "composer-attachment-chip";
    const img = document.createElement("img");
    img.src = `data:${att.mimeType};base64,${att.data}`;
    img.alt = "Attachment preview";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "composer-attachment-remove";
    remove.setAttribute("aria-label", "Remove attachment");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      const session = getSession();
      if (!session?.pendingAttachments) return;
      session.pendingAttachments.splice(index, 1);
      renderAttachmentPreviews();
    });
    chip.append(img, remove);
    composerAttachments.appendChild(chip);
  });
}

function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith("image/")) {
      reject(new Error("Only images can be attached."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const match = result.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        reject(new Error("Failed to read image."));
        return;
      }
      if (match[2].length > 2_500_000) {
        reject(new Error("Image is too large (max ~2MB)."));
        return;
      }
      resolve({ mimeType: match[1] || file.type, data: match[2] });
    };
    reader.onerror = () => reject(new Error("Failed to read image."));
    reader.readAsDataURL(file);
  });
}

export async function addAttachmentsFromFiles(files) {
  const session = getSession();
  if (!session) return;
  if (!Array.isArray(session.pendingAttachments)) {
    session.pendingAttachments = [];
  }
  const list = Array.from(files || []).filter((f) => f?.type?.startsWith("image/"));
  for (const file of list) {
    if (session.pendingAttachments.length >= MAX_ATTACHMENTS) break;
    try {
      const att = await fileToAttachment(file);
      session.pendingAttachments.push(att);
    } catch (error) {
      console.error(error);
    }
  }
  renderAttachmentPreviews();
}

export function initAttachments() {
  if (attachBtn && attachInput) {
    attachBtn.addEventListener("click", () => attachInput.click());
    attachInput.addEventListener("change", () => {
      addAttachmentsFromFiles(attachInput.files).catch((error) =>
        console.error(error)
      );
      attachInput.value = "";
    });
  }
}

export function isComposerEmpty() {
  if (!input) return true;
  if (getPendingAttachments().length) return false;
  const skills = input.querySelectorAll(".skill-mention");
  if (skills.length) return false;
  const text = (input.textContent || "").replace(/\u00a0/g, " ").trim();
  return !text;
}

export function syncComposerEmptyState() {
  if (!input) return;
  const empty = isComposerEmpty();
  if (empty && input.childNodes.length) {
    // Contenteditable often leaves a <br>/nbsp after delete-all; clear it so
    // the caret cannot sit at the end of the CSS placeholder.
    const hadFocus = document.activeElement === input;
    input.innerHTML = "";
    if (hadFocus) placeCaretAtStart(input);
  }
  input.classList.toggle("is-empty", empty);
}

export function placeCaretAtStart(el) {
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

export function getComposerPlainText() {
  const el = input || document.getElementById("message-input");
  if (!el) return "";

  let text = "";
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue || "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.classList?.contains("skill-mention")) {
      const name = node.getAttribute("data-skill-name") || node.textContent || "";
      text += `/${name}`;
      return;
    }
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    if (node.tagName === "DIV" || node.tagName === "P") {
      if (text && !text.endsWith("\n")) text += "\n";
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(el);

  const walked = text.replace(/\u00a0/g, " ");
  if (walked.trim()) return walked;

  // Fallback for odd contenteditable structures browsers insert.
  return String(el.innerText || el.textContent || "").replace(/\u00a0/g, " ");
}

export function getComposerSelectedSkills() {
  if (!input) return [];
  /** @type {Map<string, object>} */
  const unique = new Map();
  input.querySelectorAll(".skill-mention").forEach((el) => {
    const name = String(el.getAttribute("data-skill-name") || "").trim();
    const scope = String(el.getAttribute("data-skill-scope") || "user").trim();
    if (!name) return;
    unique.set(`${scope}:${name}`, { name, scope });
  });
  return [...unique.values()];
}

export function clearComposer() {
  if (!input) return;
  input.innerHTML = "";
  syncComposerEmptyState();
  resizeInput();
}

export function setComposerPlainText(text) {
  if (!input) return;
  input.textContent = text || "";
  syncComposerEmptyState();
  resizeInput();
  placeCaretAtEnd(input);
}

export function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

export function resizeInput() {
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  syncComposerEmptyState();
}

export function closeSkillsSlashMenu() {
  state.slashMenuOpen = false;
  state.slashActiveIndex = 0;
  state.slashFilteredSkills = [];
  if (skillsSlashMenu) skillsSlashMenu.hidden = true;
}

export function getCaretSlashQuery() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !input?.contains(sel.anchorNode)) return null;

  const range = sel.getRangeAt(0);
  if (!range.collapsed) return null;

  let node = range.startContainer;
  let offset = range.startOffset;

  // If caret is inside a skill mention, no slash query
  if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains("skill-mention")) {
    return null;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const child = node.childNodes[offset - 1] || node.childNodes[offset];
    if (child?.nodeType === Node.TEXT_NODE) {
      node = child;
      offset = child.nodeType === Node.TEXT_NODE ? child.nodeValue.length : offset;
    } else if (child?.classList?.contains("skill-mention")) {
      return null;
    }
  }

  if (node.nodeType !== Node.TEXT_NODE) return null;
  if (node.parentElement?.closest?.(".skill-mention")) return null;

  const textBefore = (node.nodeValue || "").slice(0, offset);
  const match = textBefore.match(/(^|[\s\u00a0])\/([a-z0-9-]*)$/i);
  if (!match) return null;

  return {
    node,
    queryStart: match.index + match[1].length,
    queryEnd: offset,
    query: match[2] || "",
  };
}

export async function ensureSlashSkillsCache(force = false) {
  const now = Date.now();
  if (!force && state.slashSkillsCache.length && now - state.slashSkillsCacheAt < 5000) {
    return state.slashSkillsCache;
  }
  const workspacePath = getSession()?.workspacePath || null;
  const result = await window.onecode.skills.list(workspacePath);
  // Prefer project over user when same name for the picker list (show both if different)
  const items = [...(result?.userSkills || []), ...(result?.projectSkills || [])];
  state.slashSkillsCache = items;
  state.slashSkillsCacheAt = now;
  return state.slashSkillsCache;
}

export function renderSkillsSlashMenu() {
  if (!skillsSlashMenu || !skillsSlashList || !skillsSlashEmpty) return;

  skillsSlashList.innerHTML = "";
  const hasItems = state.slashFilteredSkills.length > 0;
  skillsSlashEmpty.hidden = hasItems;
  skillsSlashMenu.hidden = false;
  state.slashMenuOpen = true;

  state.slashFilteredSkills.forEach((skill, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `skills-slash-item${index === state.slashActiveIndex ? " active" : ""}`;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", index === state.slashActiveIndex ? "true" : "false");

    const title = document.createElement("div");
    title.className = "skills-slash-item-title";
    const name = document.createElement("span");
    name.textContent = `/${skill.name}`;
    const badge = document.createElement("span");
    badge.className = `skill-scope-badge scope-${skill.scope}`;
    badge.textContent = skill.scope === "project" ? "Project" : "User";
    title.append(name, badge);

    const desc = document.createElement("div");
    desc.className = "skills-slash-item-desc";
    desc.textContent = skill.description || "No description";

    btn.append(title, desc);
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      insertSkillMention(skill);
    });
    skillsSlashList.appendChild(btn);
  });
}

export async function updateSkillsSlashMenu() {
  const slash = getCaretSlashQuery();
  if (!slash) {
    closeSkillsSlashMenu();
    return;
  }

  try {
    await ensureSlashSkillsCache();
  } catch (error) {
    console.error(error);
    closeSkillsSlashMenu();
    return;
  }

  const q = slash.query.toLowerCase();
  state.slashFilteredSkills = state.slashSkillsCache.filter((skill) => {
    if (!q) return true;
    return (
      skill.name.toLowerCase().includes(q) ||
      String(skill.description || "").toLowerCase().includes(q)
    );
  });

  // Don't offer skills already attached
  const attached = new Set(
    getComposerSelectedSkills().map((s) => `${s.scope}:${s.name}`)
  );
  state.slashFilteredSkills = state.slashFilteredSkills.filter(
    (skill) => !attached.has(`${skill.scope}:${skill.name}`)
  );

  if (!state.slashFilteredSkills.length && !q) {
    // Still show empty state so user knows / works
  }

  state.slashActiveIndex = Math.min(
    state.slashActiveIndex,
    Math.max(state.slashFilteredSkills.length - 1, 0)
  );
  renderSkillsSlashMenu();
}

export function createSkillMentionElement(skill) {
  const span = document.createElement("span");
  span.className = "skill-mention";
  span.contentEditable = "false";
  span.dataset.skillName = skill.name;
  span.dataset.skillScope = skill.scope || "user";
  span.textContent = `/${skill.name}`;
  span.title =
    skill.description ||
    `${skill.scope === "project" ? "Project" : "User"} skill`;
  return span;
}

export function insertSkillMention(skill) {
  const slash = getCaretSlashQuery();
  const sel = window.getSelection();
  if (!sel) return;

  if (slash) {
    const range = document.createRange();
    range.setStart(slash.node, slash.queryStart);
    range.setEnd(slash.node, slash.queryEnd);
    range.deleteContents();
    const mention = createSkillMentionElement(skill);
    range.insertNode(mention);
    // Trailing space for continued typing
    const space = document.createTextNode("\u00a0");
    mention.after(space);
    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  } else {
    const mention = createSkillMentionElement(skill);
    input.appendChild(mention);
    input.appendChild(document.createTextNode("\u00a0"));
    placeCaretAtEnd(input);
  }

  closeSkillsSlashMenu();
  resizeInput();
  input.focus();
}

export function handleComposerKeydown(event) {
  if (state.slashMenuOpen) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!state.slashFilteredSkills.length) return;
      state.slashActiveIndex = (state.slashActiveIndex + 1) % state.slashFilteredSkills.length;
      renderSkillsSlashMenu();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!state.slashFilteredSkills.length) return;
      state.slashActiveIndex =
        (state.slashActiveIndex - 1 + state.slashFilteredSkills.length) %
        state.slashFilteredSkills.length;
      renderSkillsSlashMenu();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (state.slashFilteredSkills[state.slashActiveIndex]) {
        event.preventDefault();
        insertSkillMention(state.slashFilteredSkills[state.slashActiveIndex]);
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSkillsSlashMenu();
      return;
    }
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    const session = getSession();
    if (session?.isSending) {
      stopAgent(session.id);
      return;
    }
    submitPrompt();
    return;
  }

  if (event.key === "Tab" && event.shiftKey) {
    event.preventDefault();
    planPill.click();
  }
}

export function handleComposerInput() {
  // Prevent runaway nested junk from paste
  const textLen = (input.textContent || "").length;
  if (textLen > 8000) {
    // Trim soft: keep first 8000 chars of plain serialization roughly
    const plain = getComposerPlainText().slice(0, 8000);
    setComposerPlainText(plain);
  }
  resizeInput();
  updateSkillsSlashMenu().catch((error) => console.error(error));
}

export function maskKey(key) {
  if (!key) return "••••";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

export function getSelectedModel() {
  if (!state.customModels.length) return null;
  return state.customModels.find((model) => model.id === state.selectedModelId) || state.customModels[0];
}

export function setSelectedModel(id) {
  state.selectedModelId = id;
  if (id == null) {
    localStorage.removeItem(SELECTED_MODEL_KEY);
  } else {
    localStorage.setItem(SELECTED_MODEL_KEY, String(id));
  }
  syncComposerModelLabel();
  renderModelMenu();
  refreshContextUsage();
}

export function syncComposerModelLabel() {
  const selected = getSelectedModel();
  if (!selected) {
    modelLabel.textContent = "No model";
    state.selectedModelId = null;
    syncComposerSetupBanner();
    return;
  }

  state.selectedModelId = selected.id;
  modelLabel.textContent = selected.displayName;
  syncComposerSetupBanner();
}

export function syncComposerSetupBanner() {
  const banner = document.getElementById("composer-setup-banner");
  if (!banner) return;
  const hasModel = Boolean(state.customModels?.length);
  banner.hidden = hasModel;
  // Keep compose usable when a model exists; surface setup CTA only when missing.
  if (form) {
    form.classList.toggle("needs-model", !hasModel);
  }
}

export function closeModelMenu() {
  modelMenu.hidden = true;
  modelPicker.classList.remove("open");
  modelChip.setAttribute("aria-expanded", "false");
}

export function openModelMenu() {
  closeMcpMenu();
  renderModelMenu();
  modelMenu.hidden = false;
  modelPicker.classList.add("open");
  modelChip.setAttribute("aria-expanded", "true");
}

export function toggleModelMenu() {
  if (modelMenu.hidden) {
    openModelMenu();
  } else {
    closeModelMenu();
  }
}

export function getConnectedMcpServerNames() {
  const servers = Array.isArray(state.mcpStatus?.servers) ? state.mcpStatus.servers : [];
  return servers
    .filter(
      (server) =>
        server &&
        server.status === "connected" &&
        !server.disabled &&
        !server.builtin
    )
    .map((server) => String(server.name || "").trim())
    .filter(Boolean);
}

export function persistMcpChatSelection() {
  localStorage.setItem(MCP_ENABLED_KEY, state.mcpChatEnabled ? "1" : "0");
  localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify([...state.mcpSelectedServers]));
}

export function syncMcpSelectionWithStatus() {
  const connected = getConnectedMcpServerNames();
  const connectedSet = new Set(connected);

  for (const name of [...state.mcpSelectedServers]) {
    if (!connectedSet.has(name)) state.mcpSelectedServers.delete(name);
  }

  // First enable with no selection → select all connected servers (Cursor-like default).
  if (state.mcpChatEnabled && connected.length && state.mcpSelectedServers.size === 0) {
    for (const name of connected) state.mcpSelectedServers.add(name);
  }

  persistMcpChatSelection();
}

export function getMcpChatPayload() {
  syncMcpSelectionWithStatus();
  return {
    enabled: Boolean(state.mcpChatEnabled),
    servers: state.mcpChatEnabled ? [...state.mcpSelectedServers] : [],
  };
}

export function closeMcpMenu() {
  if (!mcpMenu || !mcpPicker || !mcpPill) return;
  mcpMenu.hidden = true;
  mcpPicker.classList.remove("open");
  mcpPill.setAttribute("aria-expanded", "false");
}

export function openMcpMenu() {
  if (!mcpMenu || !mcpPicker || !mcpPill) return;
  closeModelMenu();
  renderMcpChatMenu();
  mcpMenu.hidden = false;
  mcpPicker.classList.add("open");
  mcpPill.setAttribute("aria-expanded", "true");
}

export function toggleMcpMenu() {
  if (!mcpMenu) return;
  if (mcpMenu.hidden) openMcpMenu();
  else closeMcpMenu();
}

export function setMcpChatEnabled(enabled, { autoSelect = true } = {}) {
  state.mcpChatEnabled = Boolean(enabled);
  if (state.mcpChatEnabled && autoSelect) {
    const connected = getConnectedMcpServerNames();
    if (connected.length && state.mcpSelectedServers.size === 0) {
      for (const name of connected) state.mcpSelectedServers.add(name);
    }
  }
  persistMcpChatSelection();
  renderMcpChatControls();
}

export function toggleMcpServerSelected(name, selected) {
  const serverName = String(name || "").trim();
  if (!serverName) return;
  if (selected) state.mcpSelectedServers.add(serverName);
  else state.mcpSelectedServers.delete(serverName);

  if (state.mcpSelectedServers.size === 0) {
    state.mcpChatEnabled = false;
  } else if (!state.mcpChatEnabled) {
    state.mcpChatEnabled = true;
  }

  persistMcpChatSelection();
  renderMcpChatControls();
}

export function selectAllMcpServers() {
  const connected = getConnectedMcpServerNames();
  if (!connected.length) return;
  for (const name of connected) state.mcpSelectedServers.add(name);
  state.mcpChatEnabled = true;
  persistMcpChatSelection();
  renderMcpChatControls();
}

export function selectNoMcpServers() {
  state.mcpSelectedServers.clear();
  state.mcpChatEnabled = false;
  persistMcpChatSelection();
  renderMcpChatControls();
}

export function renderMcpChatControls() {
  syncMcpSelectionWithStatus();

  const connectedCount = getConnectedMcpServerNames().length;
  const selectedCount = state.mcpChatEnabled ? state.mcpSelectedServers.size : 0;
  const isOn = state.mcpChatEnabled && selectedCount > 0;
  const needsServers = state.mcpChatEnabled && connectedCount === 0;

  if (mcpPill) {
    mcpPill.setAttribute("aria-pressed", String(isOn || needsServers));
    mcpPill.dataset.warning = needsServers ? "true" : "false";
    mcpPill.title = isOn
      ? `MCP on · ${selectedCount} server${selectedCount === 1 ? "" : "s"}`
      : needsServers
        ? "MCP is on, but no servers are connected yet"
        : "MCP tools are off for this chat";
  }

  if (mcpPillLabel) {
    if (isOn) {
      mcpPillLabel.textContent =
        selectedCount === 1 ? "MCP · 1 server" : `MCP · ${selectedCount}`;
    } else if (needsServers) {
      mcpPillLabel.textContent = "MCP · setup";
    } else {
      mcpPillLabel.textContent = "MCP · Off";
    }
  }

  if (mcpEnabledToggle) {
    mcpEnabledToggle.setAttribute("aria-checked", String(state.mcpChatEnabled));
  }

  if (mcpMenuActions) {
    mcpMenuActions.hidden = connectedCount === 0;
  }

  if (mcpMenu && !mcpMenu.hidden) {
    renderMcpChatMenu();
  }

  refreshContextUsage();
}

export function renderMcpChatMenu() {
  if (!mcpMenuList || !mcpMenuEmpty) return;

  const connectedServers = (Array.isArray(state.mcpStatus?.servers) ? state.mcpStatus.servers : []).filter(
    (server) =>
      server && server.status === "connected" && !server.disabled && !server.builtin
  );

  mcpMenuList.innerHTML = "";
  mcpMenuEmpty.hidden = connectedServers.length > 0;
  if (mcpMenuActions) {
    mcpMenuActions.hidden = connectedServers.length === 0;
  }

  for (const server of connectedServers) {
    const selected = state.mcpSelectedServers.has(server.name);
    const active = state.mcpChatEnabled && selected;

    const row = document.createElement("button");
    row.type = "button";
    row.className = "mcp-menu-item";
    if (active) row.classList.add("is-on");
    if (state.mcpChatEnabled && !selected) row.classList.add("is-dim");

    const body = document.createElement("div");
    body.className = "mcp-menu-item-body";

    const name = document.createElement("span");
    name.className = "mcp-menu-item-name";
    name.textContent = server.name;

    const meta = document.createElement("span");
    meta.className = "mcp-menu-item-meta";
    const toolCount = Number(server.toolCount) || 0;
    meta.textContent = `${String(server.transport || "mcp").toUpperCase()} · ${toolCount} tool${
      toolCount === 1 ? "" : "s"
    }`;

    body.append(name, meta);

    const check = document.createElement("span");
    check.className = "mcp-menu-item-check";
    check.setAttribute("aria-hidden", "true");
    check.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.2 5.2 4.1 7l3.7-4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    row.append(body, check);
    row.addEventListener("click", () => {
      toggleMcpServerSelected(server.name, !selected);
    });

    mcpMenuList.appendChild(row);
  }
}

export function renderModelMenu() {
  modelMenuList.innerHTML = "";
  modelMenuEmpty.hidden = state.customModels.length > 0;

  for (const model of state.customModels) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "model-option";
    option.role = "option";
    option.setAttribute("aria-selected", String(model.id === state.selectedModelId));
    if (model.id === state.selectedModelId) {
      option.classList.add("selected");
    }

    const name = document.createElement("span");
    name.className = "model-option-name";
    name.textContent = model.displayName;

    const meta = document.createElement("span");
    meta.className = "model-option-meta";
    meta.textContent = model.modelName;

    option.append(name, meta);
    option.addEventListener("click", () => {
      setSelectedModel(model.id);
      closeModelMenu();
      input.focus();
    });

    modelMenuList.appendChild(option);
  }
}
