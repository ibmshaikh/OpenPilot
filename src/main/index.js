const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  safeTitle,
  conversationToMarkdown,
  conversationToHtml,
} = require("./export-chat");
const {
  initDatabase,
  listModels,
  getModel,
  createModel,
  updateModel,
  deleteModel,
  getTinyFishSettings,
  saveTinyFishSettings,
  getOnboardingSettings,
  saveOnboardingSettings,
  getMemorySettings,
  saveMemorySettings,
  getTokenUsage,
  resetTokenUsage,
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  updateConversationTitle,
  updateConversationWorkspace,
  saveConversationAgentState,
  addMessage,
  getConversationWithMessages,
  closeDatabase,
} = require("./db");
const {
  ensureSession,
  getWorkspacePath,
  setWorkspacePath,
  resetConversation,
  cancelRun,
  cancelAllRuns,
  disposeSession,
  exportAgentState,
  invalidateAllCachedAgents,
  polishPrompt,
  runChatTurn,
  getContextUsage,
  resolveToolApproval,
} = require("./agent");
const {
  initMcp,
  shutdownMcp,
  reloadAndTest,
  getStatus: getMcpStatus,
  getConfigPath: getMcpConfigPath,
  readLogs: readMcpLogs,
  onStatus: onMcpStatus,
} = require("./mcp");
const {
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  getUserSkillsDir,
  getProjectSkillsDir,
  ensureUserSkillsDir,
  ensureProjectSkillsDir,
} = require("./skills");
const {
  getMemorySourcePaths,
  ensureUserMemoryFile,
  ensureProjectMemoryFile,
  getUserMemoryPath,
  getProjectMemoryPath,
} = require("./memory");
const { setupAutoUpdater, checkForUpdates } = require("./updater");

const APP_ICON_PNG = path.join(__dirname, "../../assets/icons", "icon.png");
const APP_ICON_ICNS = path.join(__dirname, "../../assets/icons", "icon.icns");

function resolveAppIconPath() {
  if (process.platform === "darwin" && fs.existsSync(APP_ICON_ICNS)) {
    return APP_ICON_ICNS;
  }
  if (fs.existsSync(APP_ICON_PNG)) {
    return APP_ICON_PNG;
  }
  return null;
}

function createWindow() {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const iconPath = resolveAppIconPath();

  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    title: "OpenPilot",
    ...(iconPath ? { icon: iconPath } : {}),
    // Custom titlebar: hide native chrome on supported platforms; keep window buttons.
    ...(isMac || isWin ? { titleBarStyle: "hidden" } : {}),
    ...(isMac ? { trafficLightPosition: { x: 15, y: 13 } } : {}),
    ...(isWin
      ? {
          titleBarOverlay: {
            color: "#0c0c0c",
            symbolColor: "#ececec",
            height: 42,
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function validateModelPayload(payload) {
  const modelName = String(payload?.modelName || "").trim();
  const baseUrl = String(payload?.baseUrl || "").trim();
  const apiKey = String(payload?.apiKey || "").trim();
  const displayName = String(payload?.displayName || "").trim();

  if (!modelName || !baseUrl || !apiKey || !displayName) {
    throw new Error("All fields are required.");
  }

  return { modelName, baseUrl, apiKey, displayName };
}

function formatPathLabel(fullPath) {
  if (!fullPath) return "Select folder";
  const home = os.homedir();
  if (fullPath.startsWith(home)) {
    return `~${fullPath.slice(home.length)}`;
  }
  return fullPath;
}

function workspacePayload(conversationId) {
  const fullPath = getWorkspacePath(conversationId);
  return {
    path: fullPath,
    label: formatPathLabel(fullPath),
  };
}

function requireConversationId(conversationId) {
  const id = String(conversationId || "").trim();
  if (!id) {
    throw new Error("conversationId is required.");
  }
  return id;
}

function hydrateAgentSession(conversation) {
  if (!conversation) return null;
  ensureSession(conversation.id, {
    workspacePath: conversation.workspacePath,
    agentState: conversation.agentState,
  });
  return conversation;
}

function titleFromMessage(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return "New chat";
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

app.whenReady().then(() => {
  const iconPath = resolveAppIconPath();
  if (iconPath && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconPath);
  }

  initDatabase();
  initMcp(app.getPath("userData"));
  createWindow();
  setupAutoUpdater();

  ipcMain.handle("app:getVersion", () => app.getVersion());
  ipcMain.handle("app:checkForUpdates", async () => checkForUpdates());

  onMcpStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send("mcp:event", status);
      }
    }
  });

  ipcMain.handle("models:list", () => listModels());

  ipcMain.handle("models:create", (_event, payload) => {
    return createModel(validateModelPayload(payload));
  });

  ipcMain.handle("models:update", (_event, id, payload) => {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new Error("Invalid model id.");
    }
    return updateModel(numericId, validateModelPayload(payload));
  });

  ipcMain.handle("models:delete", (_event, id) => {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new Error("Invalid model id.");
    }
    return deleteModel(numericId);
  });

  ipcMain.handle("settings:tinyfish:get", () => getTinyFishSettings());

  ipcMain.handle("settings:tinyfish:save", (_event, payload) => {
    const enabled = Boolean(payload?.enabled);
    const apiKey = String(payload?.apiKey || "").trim();
    if (enabled && !apiKey) {
      throw new Error("API key is required when TinyFish search is enabled.");
    }
    const saved = saveTinyFishSettings({ enabled, apiKey });
    invalidateAllCachedAgents();
    return saved;
  });

  ipcMain.handle("settings:onboarding:get", () => getOnboardingSettings());

  ipcMain.handle("settings:onboarding:save", (_event, payload) => {
    return saveOnboardingSettings({
      completed: Boolean(payload?.completed),
    });
  });

  ipcMain.handle("settings:memory:get", (_event, workspacePath) => {
    const settings = getMemorySettings();
    const paths = getMemorySourcePaths(workspacePath || null, {
      ...settings,
      // Don't create files just for reading settings UI when disabled
      enabled: false,
    });
    return {
      ...settings,
      userPath: paths.userPathLabel,
      projectPath: paths.projectPathLabel,
      userAbsolute: getUserMemoryPath(),
      projectAbsolute: getProjectMemoryPath(workspacePath || null),
      userVirtual: `${paths.userVirtualRoot}AGENTS.md`,
      projectVirtual: paths.projectVirtualPath,
    };
  });

  ipcMain.handle("settings:memory:save", (_event, payload) => {
    const enabled = Boolean(payload?.enabled);
    const user = payload?.user !== false;
    const project = payload?.project !== false;
    if (enabled && !user && !project) {
      throw new Error("Enable at least user or project memory.");
    }
    const saved = saveMemorySettings({ enabled, user, project });
    if (saved.enabled) {
      if (saved.user) ensureUserMemoryFile();
      if (saved.project) {
        const workspacePath = payload?.workspacePath || null;
        if (workspacePath) ensureProjectMemoryFile(workspacePath);
      }
    }
    invalidateAllCachedAgents();
    return saved;
  });

  ipcMain.handle("settings:memory:reveal", async (_event, payload = {}) => {
    const scope = String(payload.scope || "user").trim().toLowerCase();
    let target;
    if (scope === "project") {
      target = ensureProjectMemoryFile(payload.workspacePath || null);
    } else {
      target = ensureUserMemoryFile();
    }
    shell.showItemInFolder(target);
    return { ok: true, path: target };
  });

  ipcMain.handle("skills:list", (_event, workspacePath) => {
    return listSkills(workspacePath || null);
  });

  ipcMain.handle("skills:get", (_event, payload = {}) => {
    return getSkill(payload.scope, payload.name, payload.workspacePath || null);
  });

  ipcMain.handle("skills:create", (_event, payload = {}) => {
    const skill = createSkill(payload);
    invalidateAllCachedAgents();
    return skill;
  });

  ipcMain.handle("skills:update", (_event, payload = {}) => {
    const skill = updateSkill(payload);
    invalidateAllCachedAgents();
    return skill;
  });

  ipcMain.handle("skills:delete", (_event, payload = {}) => {
    const result = deleteSkill(payload.scope, payload.name, payload.workspacePath || null);
    invalidateAllCachedAgents();
    return result;
  });

  ipcMain.handle("skills:paths", (_event, workspacePath) => {
    ensureUserSkillsDir();
    const projectDir = workspacePath ? getProjectSkillsDir(workspacePath) : null;
    if (projectDir) {
      try {
        ensureProjectSkillsDir(workspacePath);
      } catch {
        // Workspace may be unset; still return user path.
      }
    }
    return {
      user: formatPathLabel(getUserSkillsDir()),
      userAbsolute: getUserSkillsDir(),
      project: projectDir ? formatPathLabel(projectDir) : null,
      projectAbsolute: projectDir,
    };
  });

  ipcMain.handle("skills:reveal", async (_event, payload = {}) => {
    const scope = String(payload.scope || "user").trim().toLowerCase();
    let target = ensureUserSkillsDir();
    if (scope === "project") {
      target = ensureProjectSkillsDir(payload.workspacePath || null);
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return { ok: true, path: target };
  });

  ipcMain.handle("settings:usage:get", () => getTokenUsage());

  ipcMain.handle("settings:usage:reset", (_event, payload = {}) => {
    const scope = String(payload?.scope || "all").trim().toLowerCase();
    if (!["all", "lifetime", "session"].includes(scope)) {
      throw new Error("Invalid usage reset scope.");
    }
    return resetTokenUsage({ scope });
  });

  ipcMain.handle("mcp:status", () => getMcpStatus());

  ipcMain.handle("mcp:logs", (_event, limit) => {
    const size = Number(limit);
    return readMcpLogs(Number.isFinite(size) && size > 0 ? size : 200);
  });

  ipcMain.handle("mcp:reload", async () => reloadAndTest({ reason: "ui-retest" }));

  ipcMain.handle("mcp:openConfig", async () => {
    const configPath = getMcpConfigPath();
    if (!configPath) {
      throw new Error("MCP config path is not ready.");
    }
    if (!fs.existsSync(configPath)) {
      throw new Error("MCP config file was not found.");
    }
    const error = await shell.openPath(configPath);
    if (error) {
      throw new Error(error);
    }
    return { ok: true, path: configPath };
  });

  ipcMain.handle("mcp:revealConfig", async () => {
    const configPath = getMcpConfigPath();
    if (!configPath) {
      throw new Error("MCP config path is not ready.");
    }
    if (!fs.existsSync(configPath)) {
      throw new Error("MCP config file was not found.");
    }
    shell.showItemInFolder(configPath);
    return { ok: true, path: configPath };
  });

  ipcMain.handle("chats:list", () => listConversations());

  ipcMain.handle("chats:create", (_event, payload = {}) => {
    const inheritWorkspace = payload?.workspacePath
      ? String(payload.workspacePath).trim()
      : null;
    const conversation = createConversation({
      title: "New chat",
      workspacePath: inheritWorkspace || app.getAppPath(),
    });
    hydrateAgentSession(conversation);
    return {
      id: conversation.id,
      title: conversation.title,
      workspacePath: conversation.workspacePath,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: [],
    };
  });

  ipcMain.handle("chats:get", (_event, conversationId) => {
    const id = requireConversationId(conversationId);
    const conversation = getConversationWithMessages(id);
    if (!conversation) {
      throw new Error("Conversation not found.");
    }
    hydrateAgentSession(conversation);
    return conversation;
  });

  ipcMain.handle("chats:setTitle", (_event, conversationId, title) => {
    const id = requireConversationId(conversationId);
    return updateConversationTitle(id, title);
  });

  ipcMain.handle("chats:delete", (_event, conversationId) => {
    const id = requireConversationId(conversationId);
    if (!getConversation(id)) {
      throw new Error("Conversation not found.");
    }
    disposeSession(id);
    return deleteConversation(id);
  });

  ipcMain.handle("chats:addMessage", (_event, conversationId, payload) => {
    const id = requireConversationId(conversationId);
    if (!getConversation(id)) {
      throw new Error("Conversation not found.");
    }
    const role = String(payload?.role || "").trim();
    if (role !== "user" && role !== "agent") {
      throw new Error("Invalid message role.");
    }
    return addMessage(id, {
      role,
      content: payload?.content ?? {},
    });
  });

  ipcMain.handle("workspace:get", (_event, conversationId) => {
    const id = requireConversationId(conversationId);
    const conversation = getConversation(id);
    if (!conversation) {
      throw new Error("Conversation not found.");
    }
    hydrateAgentSession(conversation);
    return workspacePayload(id);
  });

  ipcMain.handle("workspace:set", (_event, conversationId, nextPath) => {
    const id = requireConversationId(conversationId);
    if (!getConversation(id)) {
      throw new Error("Conversation not found.");
    }

    const candidate = String(nextPath || "").trim();
    if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      return {
        ...workspacePayload(id),
        invalid: true,
      };
    }

    const fullPath = setWorkspacePath(id, candidate);
    updateConversationWorkspace(id, fullPath);
    saveConversationAgentState(id, exportAgentState(id));
    return {
      path: fullPath,
      label: formatPathLabel(fullPath),
    };
  });

  ipcMain.handle("workspace:pick", async (_event, conversationId) => {
    const id = requireConversationId(conversationId);
    if (!getConversation(id)) {
      throw new Error("Conversation not found.");
    }

    const current = getWorkspacePath(id);
    const result = await dialog.showOpenDialog({
      title: "Select workspace folder",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: current || os.homedir(),
    });

    if (result.canceled || !result.filePaths[0]) {
      return {
        ...workspacePayload(id),
        cancelled: true,
      };
    }

    const fullPath = setWorkspacePath(id, result.filePaths[0]);
    updateConversationWorkspace(id, fullPath);
    saveConversationAgentState(id, exportAgentState(id));
    return {
      path: fullPath,
      label: formatPathLabel(fullPath),
      cancelled: false,
    };
  });

  function resolveWorkspaceChild(conversationId, relativePath = "") {
    const root = getWorkspacePath(conversationId);
    if (!root || !fs.existsSync(root)) {
      throw new Error("Workspace folder is not set or missing.");
    }
    const rootResolved = path.resolve(root);
    const rel = String(relativePath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    if (rel.includes("\0") || /(^|\/)\.\.(\/|$)/.test(rel)) {
      throw new Error("Invalid path.");
    }
    const target = rel ? path.resolve(rootResolved, rel) : rootResolved;
    const relativeToRoot = path.relative(rootResolved, target);
    if (
      relativeToRoot.startsWith("..") ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new Error("Path is outside the workspace.");
    }
    return { root: rootResolved, target, relative: relativeToRoot.replace(/\\/g, "/") };
  }

  ipcMain.handle("workspace:list", (_event, conversationId, relativePath = "") => {
    const id = requireConversationId(conversationId);
    if (!getConversation(id)) {
      throw new Error("Conversation not found.");
    }
    hydrateAgentSession(getConversation(id));
    const { target, relative } = resolveWorkspaceChild(id, relativePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new Error("Directory not found.");
    }

    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .map((dirent) => {
        const name = dirent.name;
        const childRel = relative ? `${relative}/${name}` : name;
        const type = dirent.isDirectory() ? "dir" : "file";
        return { name, relativePath: childRel, type };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

    return { path: relative, entries };
  });

  ipcMain.handle("workspace:reveal", (_event, conversationId, relativePath = "") => {
    const id = requireConversationId(conversationId);
    if (!getConversation(id)) {
      throw new Error("Conversation not found.");
    }
    hydrateAgentSession(getConversation(id));
    const { target } = resolveWorkspaceChild(id, relativePath);
    if (!fs.existsSync(target)) {
      throw new Error("Path not found.");
    }
    shell.showItemInFolder(target);
    return { ok: true };
  });

  ipcMain.handle("workspace:open", async (_event, conversationId, relativePath = "") => {
    const id = requireConversationId(conversationId);
    if (!getConversation(id)) {
      throw new Error("Conversation not found.");
    }
    hydrateAgentSession(getConversation(id));
    const { target } = resolveWorkspaceChild(id, relativePath);
    if (!fs.existsSync(target)) {
      throw new Error("Path not found.");
    }
    const errorMessage = await shell.openPath(target);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return { ok: true };
  });

  ipcMain.handle("chats:export", async (event, payload = {}) => {
    const id = requireConversationId(payload?.conversationId);
    const conversation = getConversationWithMessages(id);
    if (!conversation) {
      throw new Error("Conversation not found.");
    }

    const preferred =
      String(payload?.format || "").toLowerCase() === "pdf" ? "pdf" : "markdown";
    const base = safeTitle(conversation.title);
    const result = await dialog.showSaveDialog({
      title: "Export conversation",
      defaultPath: path.join(
        os.homedir(),
        preferred === "pdf" ? `${base}.pdf` : `${base}.md`
      ),
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "PDF", extensions: ["pdf"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { cancelled: true };
    }

    const outPath = result.filePath;
    const isPdf = outPath.toLowerCase().endsWith(".pdf");

    if (isPdf) {
      const html = conversationToHtml(conversation);
      const tempHtml = path.join(
        app.getPath("temp"),
        `onecode-export-${id}-${Date.now()}.html`
      );
      fs.writeFileSync(tempHtml, html, "utf8");
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
        },
      });
      try {
        await win.loadFile(tempHtml);
        const pdf = await win.webContents.printToPDF({
          printBackground: true,
          pageSize: "A4",
          margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
        });
        fs.writeFileSync(outPath, pdf);
      } finally {
        if (!win.isDestroyed()) win.close();
        try {
          fs.unlinkSync(tempHtml);
        } catch {
          // ignore temp cleanup failures
        }
      }
    } else {
      fs.writeFileSync(outPath, conversationToMarkdown(conversation), "utf8");
    }

    return { ok: true, path: outPath, format: isPdf ? "pdf" : "markdown" };
  });

  ipcMain.handle("chat:reset", (_event, conversationId) => {
    const id = requireConversationId(conversationId);
    resetConversation(id);
    saveConversationAgentState(id, exportAgentState(id));
    return { ok: true };
  });

  ipcMain.handle("chat:cancel", (_event, conversationId) => {
    const id = requireConversationId(conversationId);
    return { cancelled: cancelRun(id) };
  });

  ipcMain.handle("chat:resolveApproval", (_event, payload = {}) => {
    const id = requireConversationId(payload?.conversationId);
    const approvalId = String(payload?.id || "").trim();
    if (!approvalId) {
      throw new Error("Approval id is required.");
    }
    const ok = resolveToolApproval(id, {
      id: approvalId,
      approved: Boolean(payload?.approved),
      message: payload?.message ? String(payload.message) : "",
      allowAllForSession: Boolean(payload?.allowAllForSession),
    });
    return { ok };
  });

  ipcMain.handle("chat:polishPrompt", async (_event, payload = {}) => {
    const text = String(payload?.text ?? payload?.draft ?? "").trim();
    if (!text) {
      throw new Error("Nothing to polish. Type a prompt first.");
    }
    const modelId = Number(payload?.modelId);
    if (!Number.isInteger(modelId) || modelId <= 0) {
      throw new Error("No model selected. Add a model in Settings.");
    }
    const modelConfig = getModel(modelId);
    if (!modelConfig) {
      throw new Error("Selected model was not found. Pick another model in Settings.");
    }
    return polishPrompt({
      text,
      modelConfig,
    });
  });

  ipcMain.handle("chat:contextUsage", (_event, payload = {}) => {
    const conversationId = payload?.conversationId
      ? requireConversationId(payload.conversationId)
      : null;
    let modelConfig = null;
    const modelId = Number(payload?.modelId);
    if (Number.isInteger(modelId) && modelId > 0) {
      modelConfig = getModel(modelId);
    }
    const conversation = conversationId ? getConversation(conversationId) : null;
    return getContextUsage({
      conversationId,
      modelConfig,
      modelId: Number.isInteger(modelId) && modelId > 0 ? modelId : null,
      workspacePath: conversation?.workspacePath || payload?.workspacePath || null,
      mcp: {
        enabled: Boolean(payload?.mcp?.enabled),
        servers: Array.isArray(payload?.mcp?.servers)
          ? payload.mcp.servers.map((name) => String(name || "").trim()).filter(Boolean)
          : [],
      },
      draftText: String(payload?.draftText || ""),
    });
  });

  ipcMain.handle("chat:send", async (event, payload) => {
    const conversationId = requireConversationId(payload?.conversationId);
    const conversation = getConversation(conversationId);
    if (!conversation) {
      throw new Error("Conversation not found.");
    }

    const modelId = Number(payload?.modelId);
    if (!Number.isInteger(modelId) || modelId <= 0) {
      throw new Error("No model selected. Add a model in Settings.");
    }

    const modelConfig = getModel(modelId);
    if (!modelConfig) {
      throw new Error("Selected model was not found. Pick another model in Settings.");
    }

    const message = String(payload?.message || "").trim();
    const attachments = Array.isArray(payload?.attachments)
      ? payload.attachments
          .map((item) => ({
            mimeType: String(item?.mimeType || item?.mime_type || "").trim(),
            data: String(item?.data || "").replace(/\s+/g, ""),
          }))
          .filter(
            (item) =>
              item.mimeType.startsWith("image/") &&
              item.data &&
              item.data.length <= 2_500_000
          )
          .slice(0, 6)
      : [];
    if (!message && !attachments.length) {
      throw new Error("Message is empty.");
    }

    hydrateAgentSession(conversation);

    if (conversation.title === "New chat") {
      updateConversationTitle(
        conversationId,
        titleFromMessage(message || "Image attachment")
      );
    }

    const emit = (chatEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("chat:event", chatEvent);
      }
    };

    await runChatTurn(
      {
        conversationId,
        message,
        modelConfig,
        workspacePath: conversation.workspacePath,
        agentState: conversation.agentState,
        attachments,
        requireToolApproval: Boolean(payload?.requireToolApproval),
        mcp: {
          enabled: Boolean(payload?.mcp?.enabled),
          servers: Array.isArray(payload?.mcp?.servers)
            ? payload.mcp.servers.map((name) => String(name || "").trim()).filter(Boolean)
            : [],
        },
        skills: Array.isArray(payload?.skills)
          ? payload.skills
              .map((skill) => ({
                name: String(skill?.name || "").trim(),
                scope: String(skill?.scope || "user").trim(),
              }))
              .filter((skill) => skill.name)
          : [],
      },
      emit
    );

    const agentState = exportAgentState(conversationId);
    if (agentState) {
      saveConversationAgentState(conversationId, agentState);
    }

    return {
      ok: true,
      conversation: getConversation(conversationId),
    };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  cancelAllRuns();
  shutdownMcp().catch((error) => {
    console.error("Failed to shut down MCP:", error);
  });
  closeDatabase();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  cancelAllRuns();
});
