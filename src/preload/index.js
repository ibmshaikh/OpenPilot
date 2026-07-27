const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("onecode", {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  app: {
    getVersion: () => ipcRenderer.invoke("app:getVersion"),
    checkForUpdates: () => ipcRenderer.invoke("app:checkForUpdates"),
  },
  models: {
    list: () => ipcRenderer.invoke("models:list"),
    create: (payload) => ipcRenderer.invoke("models:create", payload),
    update: (id, payload) => ipcRenderer.invoke("models:update", id, payload),
    delete: (id) => ipcRenderer.invoke("models:delete", id),
  },
  settings: {
    getTinyFish: () => ipcRenderer.invoke("settings:tinyfish:get"),
    saveTinyFish: (payload) => ipcRenderer.invoke("settings:tinyfish:save", payload),
    getOnboarding: () => ipcRenderer.invoke("settings:onboarding:get"),
    saveOnboarding: (payload) => ipcRenderer.invoke("settings:onboarding:save", payload),
    getMemory: (workspacePath) => ipcRenderer.invoke("settings:memory:get", workspacePath),
    saveMemory: (payload) => ipcRenderer.invoke("settings:memory:save", payload),
    revealMemory: (payload) => ipcRenderer.invoke("settings:memory:reveal", payload),
    getUsage: () => ipcRenderer.invoke("settings:usage:get"),
    resetUsage: (payload) => ipcRenderer.invoke("settings:usage:reset", payload),
  },
  skills: {
    list: (workspacePath) => ipcRenderer.invoke("skills:list", workspacePath),
    get: (payload) => ipcRenderer.invoke("skills:get", payload),
    create: (payload) => ipcRenderer.invoke("skills:create", payload),
    update: (payload) => ipcRenderer.invoke("skills:update", payload),
    delete: (payload) => ipcRenderer.invoke("skills:delete", payload),
    paths: (workspacePath) => ipcRenderer.invoke("skills:paths", workspacePath),
    reveal: (payload) => ipcRenderer.invoke("skills:reveal", payload),
  },
  mcp: {
    status: () => ipcRenderer.invoke("mcp:status"),
    logs: (limit) => ipcRenderer.invoke("mcp:logs", limit),
    reload: () => ipcRenderer.invoke("mcp:reload"),
    openConfig: () => ipcRenderer.invoke("mcp:openConfig"),
    revealConfig: () => ipcRenderer.invoke("mcp:revealConfig"),
    onEvent: (handler) => {
      const listener = (_event, data) => handler(data);
      ipcRenderer.on("mcp:event", listener);
      return () => ipcRenderer.removeListener("mcp:event", listener);
    },
  },
  chats: {
    list: () => ipcRenderer.invoke("chats:list"),
    create: (payload) => ipcRenderer.invoke("chats:create", payload),
    get: (id) => ipcRenderer.invoke("chats:get", id),
    setTitle: (id, title) => ipcRenderer.invoke("chats:setTitle", id, title),
    delete: (id) => ipcRenderer.invoke("chats:delete", id),
    addMessage: (id, payload) => ipcRenderer.invoke("chats:addMessage", id, payload),
    export: (payload) => ipcRenderer.invoke("chats:export", payload),
  },
  workspace: {
    get: (conversationId) => ipcRenderer.invoke("workspace:get", conversationId),
    set: (conversationId, nextPath) =>
      ipcRenderer.invoke("workspace:set", conversationId, nextPath),
    pick: (conversationId) => ipcRenderer.invoke("workspace:pick", conversationId),
    list: (conversationId, relativePath) =>
      ipcRenderer.invoke("workspace:list", conversationId, relativePath),
    reveal: (conversationId, relativePath) =>
      ipcRenderer.invoke("workspace:reveal", conversationId, relativePath),
    open: (conversationId, relativePath) =>
      ipcRenderer.invoke("workspace:open", conversationId, relativePath),
  },
  chat: {
    send: (payload) => ipcRenderer.invoke("chat:send", payload),
    cancel: (conversationId) => ipcRenderer.invoke("chat:cancel", conversationId),
    reset: (conversationId) => ipcRenderer.invoke("chat:reset", conversationId),
    polishPrompt: (payload) => ipcRenderer.invoke("chat:polishPrompt", payload),
    getContextUsage: (payload) => ipcRenderer.invoke("chat:contextUsage", payload),
    resolveApproval: (payload) => ipcRenderer.invoke("chat:resolveApproval", payload),
    onEvent: (handler) => {
      const listener = (_event, data) => handler(data);
      ipcRenderer.on("chat:event", listener);
      return () => ipcRenderer.removeListener("chat:event", listener);
    },
  },
});

