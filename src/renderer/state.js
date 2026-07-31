import {
  shell,
  workspaceLabel,
  workspaceChip,
  sendBtn,
  form,
  runStatus,
} from "./dom.js";

export const SELECTED_MODEL_KEY = "onecode.selectedModelId";
export const ACTIVE_CHAT_KEY = "onecode.activeConversationId";
export const MCP_ENABLED_KEY = "onecode.mcp.enabled";
export const MCP_SERVERS_KEY = "onecode.mcp.servers";

/** Shared mutable UI/app state (ESM-safe reassignment via object props). */
export const state = {
  customModels: [],
  /** Active model in the chat composer (session preference). */
  selectedModelId: Number(localStorage.getItem(SELECTED_MODEL_KEY)) || null,
  /** Persisted Settings default — independent of the chat picker. */
  defaultModelId: null,
  editingModelId: null,
  conversations: [],
  activeConversationId: null,
  activeSettingsSection: "models",
  /** @type {Array<object>} */
  skillsCatalog: [],
  editingSkillKey: null,
  mcpStatus: null,
  mcpLogsLoading: false,
  mcpChatEnabled: localStorage.getItem(MCP_ENABLED_KEY) === "1",
  /** @type {Set<string>} */
  mcpSelectedServers: new Set(
    (() => {
      try {
        const raw = JSON.parse(localStorage.getItem(MCP_SERVERS_KEY) || "[]");
        return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
      } catch {
        return [];
      }
    })()
  ),
  /** @type {Map<string, object>} */
  chatSessions: new Map(),
  todoPanelRaf: 0,
  /** @type {Array<object>} */
  slashSkillsCache: [],
  slashSkillsCacheAt: 0,
  slashMenuOpen: false,
  slashActiveIndex: 0,
  /** @type {Array<object>} */
  slashFilteredSkills: [],
  stickToBottom: true,
  touchStartY: 0,
};

/** @type {(() => void) | null} */
let renderChatListFn = null;
/** @type {(() => void) | null} */
let patchChatListFn = null;

export function registerRenderChatList(fn, patchFn = null) {
  renderChatListFn = fn;
  patchChatListFn = patchFn;
}

export function getSession(conversationId = state.activeConversationId) {
  if (!conversationId) return null;
  return state.chatSessions.get(conversationId) || null;
}

export function ensureUiSession(conversation) {
  const id = conversation.id;
  let session = state.chatSessions.get(id);
  if (!session) {
    const panel = document.createElement("div");
    panel.className = "thread-panel";
    panel.dataset.conversationId = id;
    session = {
      id,
      panel,
      isSending: false,
      isStopping: false,
      activeAgentTurn: null,
      started: false,
      title: conversation.title || "New chat",
      workspacePath: conversation.workspacePath || null,
      hydrated: false,
      todos: [],
      todoFingerprint: "",
      lastPrompt: null,
      pendingAttachments: [],
      stickyGroup: null,
    };
    state.chatSessions.set(id, session);
  } else {
    session.title = conversation.title || session.title;
    if (conversation.workspacePath !== undefined) {
      session.workspacePath = conversation.workspacePath;
    }
  }
  return session;
}

export function getActivePanel() {
  return getSession()?.panel || null;
}

export function formatWorkspaceLabel(fullPath) {
  if (!fullPath) return "Select folder";
  const homeHints = ["/Users/", "/home/"];
  for (const hint of homeHints) {
    const idx = fullPath.indexOf(hint);
    if (idx === 0) {
      const rest = fullPath.slice(hint.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        return `~${rest.slice(slash)}`;
      }
    }
  }
  return fullPath;
}

export function applyWorkspaceToUi(workspacePath, label) {
  const session = getSession();
  if (session) session.workspacePath = workspacePath || null;
  const display = label || formatWorkspaceLabel(workspacePath) || "Select folder";
  if (workspaceLabel) workspaceLabel.textContent = display;
  if (workspaceChip) {
    workspaceChip.title = workspacePath || "Select workspace folder";
  }
}

export function syncShellMode(session = getSession()) {
  const started = Boolean(session?.started || session?.panel?.childElementCount);
  if (session) session.started = started;
  shell.classList.toggle("started", started);
}

export function syncSendButton() {
  if (!sendBtn) return;
  const session = getSession();
  const sending = Boolean(session?.isSending);

  if (sending) {
    sendBtn.classList.add("stopping");
    sendBtn.type = "button";
    sendBtn.setAttribute("aria-label", "Stop");
    sendBtn.title = "Stop";
  } else {
    sendBtn.classList.remove("stopping");
    sendBtn.type = "submit";
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.title = "Send";
  }
}

export function setSending(conversationId, next) {
  const session = getSession(conversationId);
  if (!session) return;
  session.isSending = next;
  if (!next) session.isStopping = false;

  if (conversationId === state.activeConversationId) {
    form.classList.toggle("sending", next);
    if (runStatus) runStatus.hidden = !next;
    syncSendButton();
  }
  // Sending state only needs a light patch (running dots), not a full list rebuild.
  (patchChatListFn || renderChatListFn)?.();
}
