const fs = require("node:fs");
const path = require("node:path");
const { MultiServerMCPClient } = require("@langchain/mcp-adapters");

const DEFAULT_CONFIG_TEXT = `{
  "mcpServers": {}
}
`;

/** @type {string|null} */
let configPath = null;
/** @type {string|null} */
let logPath = null;
/** @type {fs.FSWatcher|null} */
let watcher = null;
let watchDebounce = null;
let reloadGeneration = 0;
let toolsRevision = 0;

/** @type {import("@langchain/core/tools").StructuredToolInterface[]} */
let cachedTools = [];

/** @type {Record<string, import("@langchain/core/tools").StructuredToolInterface[]>} */
let cachedToolsByServer = {};

/** @type {any} */
let activeClient = null;

/** @type {Set<(status: object) => void>} */
const statusListeners = new Set();

/** @type {{
 *   configPath: string|null,
 *   logPath: string|null,
 *   exists: boolean,
 *   valid: boolean,
 *   parseError: string|null,
 *   raw: string,
 *   testing: boolean,
 *   servers: Array<object>,
 *   toolsRevision: number,
 *   updatedAt: string|null,
 * }} */
let currentStatus = {
  configPath: null,
  logPath: null,
  exists: false,
  valid: false,
  parseError: null,
  raw: "",
  testing: false,
  servers: [],
  toolsRevision: 0,
  updatedAt: null,
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendLog(level, message, detail = null) {
  if (!logPath) return;
  try {
    ensureDir(path.dirname(logPath));
    const stamp = new Date().toISOString();
    const extra =
      detail == null
        ? ""
        : typeof detail === "string"
          ? ` ${detail}`
          : ` ${JSON.stringify(detail)}`;
    fs.appendFileSync(logPath, `[${stamp}] [${level}] ${message}${extra}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write MCP log:", error);
  }
}

function readLogs(limit = 200) {
  if (!logPath || !fs.existsSync(logPath)) return "";
  try {
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - limit)).join("\n");
  } catch (error) {
    return `Failed to read MCP logs: ${error?.message || error}`;
  }
}

function ensureConfigFile() {
  if (!configPath) return;
  if (fs.existsSync(configPath)) return;
  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, DEFAULT_CONFIG_TEXT, "utf8");
  appendLog("info", "Created default mcp.json", { path: configPath });
}

/**
 * Resolve ${env:NAME} and ${userHome} placeholders in string values.
 */
function resolvePlaceholders(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\$\{userHome\}/g, require("node:os").homedir())
    .replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_match, name) => {
      const envValue = process.env[name];
      return envValue == null ? "" : envValue;
    });
}

function resolveDeep(value) {
  if (typeof value === "string") return resolvePlaceholders(value);
  if (Array.isArray(value)) return value.map(resolveDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = resolveDeep(nested);
    }
    return out;
  }
  return value;
}

function inferTransport(entry) {
  const explicit = String(entry?.transport || entry?.type || "")
    .trim()
    .toLowerCase();
  if (explicit === "stdio" || explicit === "http" || explicit === "sse") {
    return explicit;
  }
  if (entry?.url || entry?.serverUrl) {
    const url = String(entry.url || entry.serverUrl);
    if (/\/sse(\?|$)/i.test(url) || explicit === "sse") return "sse";
    return "http";
  }
  if (entry?.command) return "stdio";
  return null;
}

/**
 * Convert a Cursor-style mcpServers entry into a LangChain MCP connection.
 */
function toLangchainConnection(name, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Server "${name}" must be an object.`);
  }

  if (entry.disabled === true) {
    return { skipped: true, reason: "disabled" };
  }

  const resolved = resolveDeep(entry);
  const transport = inferTransport(resolved);

  if (transport === "stdio") {
    const command = String(resolved.command || "").trim();
    if (!command) {
      throw new Error(`Server "${name}" is missing required "command".`);
    }
    const args = Array.isArray(resolved.args)
      ? resolved.args.map((item) => String(item))
      : [];
    const connection = {
      transport: "stdio",
      command,
      args,
      stderr: "pipe",
    };
    if (resolved.env && typeof resolved.env === "object") {
      connection.env = Object.fromEntries(
        Object.entries(resolved.env).map(([key, value]) => [key, String(value)])
      );
    }
    if (resolved.cwd) connection.cwd = String(resolved.cwd);
    return { skipped: false, connection, transport: "stdio" };
  }

  if (transport === "http" || transport === "sse") {
    const url = String(resolved.url || resolved.serverUrl || "").trim();
    if (!url) {
      throw new Error(`Server "${name}" is missing required "url".`);
    }
    const connection = {
      transport,
      url,
    };
    if (resolved.headers && typeof resolved.headers === "object") {
      connection.headers = Object.fromEntries(
        Object.entries(resolved.headers).map(([key, value]) => [key, String(value)])
      );
    }
    return { skipped: false, connection, transport };
  }

  throw new Error(
    `Server "${name}" needs either "command" (stdio) or "url" (http/sse).`
  );
}

function validateConfigText(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    return {
      valid: false,
      parseError: "Config file is empty.",
      mcpServers: {},
      serverNames: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      valid: false,
      parseError: `Invalid JSON: ${error?.message || error}`,
      mcpServers: {},
      serverNames: [],
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      valid: false,
      parseError: 'Root value must be an object with an "mcpServers" map.',
      mcpServers: {},
      serverNames: [],
    };
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, "mcpServers")) {
    return {
      valid: false,
      parseError: 'Missing top-level "mcpServers" object (Cursor-compatible format).',
      mcpServers: {},
      serverNames: [],
    };
  }

  if (
    !parsed.mcpServers ||
    typeof parsed.mcpServers !== "object" ||
    Array.isArray(parsed.mcpServers)
  ) {
    return {
      valid: false,
      parseError: '"mcpServers" must be an object map of server name → config.',
      mcpServers: {},
      serverNames: [],
    };
  }

  const serverNames = Object.keys(parsed.mcpServers);
  const schemaErrors = [];
  for (const name of serverNames) {
    try {
      toLangchainConnection(name, parsed.mcpServers[name]);
    } catch (error) {
      schemaErrors.push(error?.message || String(error));
    }
  }

  if (schemaErrors.length) {
    return {
      valid: false,
      parseError: schemaErrors.join(" "),
      mcpServers: parsed.mcpServers,
      serverNames,
    };
  }

  return {
    valid: true,
    parseError: null,
    mcpServers: parsed.mcpServers,
    serverNames,
  };
}

function emitStatus() {
  const snapshot = {
    ...currentStatus,
    servers: currentStatus.servers.map((server) => ({ ...server })),
  };
  for (const listener of statusListeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error("MCP status listener failed:", error);
    }
  }
}

function setStatus(patch) {
  currentStatus = {
    ...currentStatus,
    ...patch,
    configPath,
    logPath,
    toolsRevision,
    updatedAt: new Date().toISOString(),
  };
  emitStatus();
}

function invalidateAgents() {
  try {
    const agent = require("./agent");
    if (typeof agent.invalidateAllCachedAgents === "function") {
      agent.invalidateAllCachedAgents();
    }
  } catch (error) {
    console.error("Failed to invalidate agent caches after MCP change:", error);
  }
}

async function closeActiveClient() {
  if (!activeClient) return;
  const client = activeClient;
  activeClient = null;
  try {
    if (typeof client.close === "function") {
      await client.close();
    }
  } catch (error) {
    appendLog("warn", "Failed to close previous MCP client", error?.message || String(error));
  }
}

/**
 * Test a single MCP server by connecting through LangChain MultiServerMCPClient
 * and listing tools (deepagent-compatible tool discovery).
 */
async function testSingleServer(name, connection) {
  const client = new MultiServerMCPClient({
    mcpServers: {
      [name]: connection,
    },
    onConnectionError: "throw",
    throwOnLoadError: true,
  });

  try {
    const tools = await client.getTools(name);
    return {
      ok: true,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description || "",
      })),
      toolCount: tools.length,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      tools: [],
      toolCount: 0,
      error: error?.message || String(error),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close errors during probe
    }
  }
}

async function rebuildSharedClient(connections) {
  await closeActiveClient();
  cachedTools = [];
  cachedToolsByServer = {};

  const enabled = Object.keys(connections);
  if (!enabled.length) {
    toolsRevision += 1;
    invalidateAgents();
    return [];
  }

  const client = new MultiServerMCPClient({
    mcpServers: connections,
    onConnectionError: "ignore",
    throwOnLoadError: false,
  });

  try {
    const toolsByServer = await client.initializeConnections();
    activeClient = client;
    cachedToolsByServer = {};
    for (const [name, tools] of Object.entries(toolsByServer || {})) {
      cachedToolsByServer[name] = Array.isArray(tools) ? tools : [];
    }
    cachedTools = Object.values(cachedToolsByServer).flat();
    toolsRevision += 1;
    invalidateAgents();
    appendLog("info", "Loaded MCP tools for deepagent", {
      servers: Object.keys(cachedToolsByServer),
      toolCount: cachedTools.length,
      tools: cachedTools.map((tool) => tool.name),
    });
    return cachedTools;
  } catch (error) {
    try {
      await client.close();
    } catch {
      // ignore
    }
    cachedTools = [];
    cachedToolsByServer = {};
    toolsRevision += 1;
    invalidateAgents();
    appendLog("error", "Failed to load MCP tools for deepagent", error?.message || String(error));
    throw error;
  }
}

async function reloadAndTest({ reason = "manual" } = {}) {
  const generation = ++reloadGeneration;
  ensureConfigFile();

  let raw = "";
  let exists = false;
  try {
    exists = fs.existsSync(configPath);
    raw = exists ? fs.readFileSync(configPath, "utf8") : "";
  } catch (error) {
    const message = error?.message || String(error);
    appendLog("error", "Failed to read mcp.json", message);
    setStatus({
      exists: false,
      valid: false,
      parseError: message,
      raw: "",
      testing: false,
      servers: [],
    });
    cachedTools = [];
    cachedToolsByServer = {};
    toolsRevision += 1;
    invalidateAgents();
    return getStatus();
  }

  const validated = validateConfigText(raw);
  appendLog("info", `MCP config reload (${reason})`, {
    valid: validated.valid,
    servers: validated.serverNames,
  });

  if (!validated.valid) {
    appendLog("error", "MCP configuration invalid", validated.parseError);
    await closeActiveClient();
    cachedTools = [];
    cachedToolsByServer = {};
    toolsRevision += 1;
    invalidateAgents();
    setStatus({
      exists,
      valid: false,
      parseError: validated.parseError,
      raw,
      testing: false,
      servers: validated.serverNames.map((name) => ({
        name,
        status: "error",
        transport: null,
        toolCount: 0,
        tools: [],
        error: validated.parseError,
        disabled: false,
      })),
    });
    return getStatus();
  }

  const pendingServers = [];
  /** @type {Record<string, object>} */
  const enabledConnections = {};

  for (const name of validated.serverNames) {
    const entry = validated.mcpServers[name];
    try {
      const converted = toLangchainConnection(name, entry);
      if (converted.skipped) {
        pendingServers.push({
          name,
          status: "disabled",
          transport: inferTransport(entry),
          toolCount: 0,
          tools: [],
          error: null,
          disabled: true,
        });
        continue;
      }
      enabledConnections[name] = converted.connection;
      pendingServers.push({
        name,
        status: "testing",
        transport: converted.transport,
        toolCount: 0,
        tools: [],
        error: null,
        disabled: false,
      });
    } catch (error) {
      pendingServers.push({
        name,
        status: "error",
        transport: inferTransport(entry),
        toolCount: 0,
        tools: [],
        error: error?.message || String(error),
        disabled: false,
      });
    }
  }

  setStatus({
    exists,
    valid: true,
    parseError: null,
    raw,
    testing: true,
    servers: pendingServers,
  });

  const results = [];
  for (const server of pendingServers) {
    if (generation !== reloadGeneration) {
      return getStatus();
    }

    if (server.status === "disabled") {
      results.push(server);
      continue;
    }

    if (server.status === "error") {
      appendLog("error", `MCP server "${server.name}" schema error`, server.error);
      results.push(server);
      continue;
    }

    const connection = enabledConnections[server.name];
    appendLog("info", `Testing MCP server "${server.name}" via LangChain MultiServerMCPClient`);
    const probe = await testSingleServer(server.name, connection);

    if (generation !== reloadGeneration) {
      return getStatus();
    }

    if (probe.ok) {
      appendLog("info", `MCP server "${server.name}" OK`, {
        toolCount: probe.toolCount,
        tools: probe.tools.map((tool) => tool.name),
      });
      results.push({
        ...server,
        status: "connected",
        toolCount: probe.toolCount,
        tools: probe.tools,
        error: null,
      });
    } else {
      appendLog("error", `MCP server "${server.name}" failed`, probe.error);
      delete enabledConnections[server.name];
      results.push({
        ...server,
        status: "error",
        toolCount: 0,
        tools: [],
        error: probe.error,
      });
    }

    setStatus({
      exists,
      valid: true,
      parseError: null,
      raw,
      testing: true,
      servers: [...results, ...pendingServers.slice(results.length)],
    });
  }

  if (generation !== reloadGeneration) {
    return getStatus();
  }

  try {
    await rebuildSharedClient(enabledConnections);
  } catch (error) {
    // Individual probes already recorded; shared load failure is logged.
    appendLog("warn", "Shared MCP client rebuild issue", error?.message || String(error));
  }

  setStatus({
    exists,
    valid: true,
    parseError: null,
    raw,
    testing: false,
    servers: results,
  });

  return getStatus();
}

function startWatching() {
  if (!configPath || watcher) return;
  try {
    watcher = fs.watch(path.dirname(configPath), { persistent: true }, (_eventType, filename) => {
      if (filename && filename !== path.basename(configPath)) return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        reloadAndTest({ reason: "file-change" }).catch((error) => {
          appendLog("error", "MCP reload after file change failed", error?.message || String(error));
        });
      }, 250);
    });
    watcher.on("error", (error) => {
      appendLog("error", "MCP config watcher error", error?.message || String(error));
    });
  } catch (error) {
    appendLog("error", "Failed to watch mcp.json", error?.message || String(error));
  }
}

function stopWatching() {
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
    watcher = null;
  }
}

function initMcp(userDataPath) {
  const root = String(userDataPath || "").trim();
  if (!root) {
    throw new Error("userDataPath is required to initialize MCP.");
  }

  configPath = path.join(root, "mcp.json");
  logPath = path.join(root, "logs", "mcp.log");
  ensureDir(path.join(root, "logs"));
  ensureConfigFile();
  startWatching();
  appendLog("info", "MCP manager initialized", { configPath, logPath });

  setStatus({
    exists: fs.existsSync(configPath),
    valid: false,
    parseError: null,
    raw: "",
    testing: true,
    servers: [],
  });

  reloadAndTest({ reason: "startup" }).catch((error) => {
    appendLog("error", "Initial MCP reload failed", error?.message || String(error));
  });
}

function getStatus() {
  return {
    ...currentStatus,
    configPath,
    logPath,
    toolsRevision,
    servers: currentStatus.servers.map((server) => ({ ...server })),
  };
}

function getConfigPath() {
  return configPath;
}

function getLogPath() {
  return logPath;
}

function getMcpTools(serverNames = null) {
  if (serverNames == null) {
    return cachedTools.slice();
  }

  const wanted = new Set(
    (Array.isArray(serverNames) ? serverNames : [serverNames])
      .map((name) => String(name || "").trim())
      .filter(Boolean)
  );

  if (!wanted.size) return [];

  const tools = [];
  for (const name of wanted) {
    const serverTools = cachedToolsByServer[name];
    if (Array.isArray(serverTools) && serverTools.length) {
      tools.push(...serverTools);
    }
  }
  return tools;
}

function getMcpToolsByServer() {
  const out = {};
  for (const [name, tools] of Object.entries(cachedToolsByServer)) {
    out[name] = Array.isArray(tools) ? tools.slice() : [];
  }
  return out;
}

function getConnectedMcpServers() {
  return Object.keys(cachedToolsByServer).map((name) => ({
    name,
    toolCount: cachedToolsByServer[name]?.length || 0,
    tools: (cachedToolsByServer[name] || []).map((tool) => ({
      name: tool.name,
      description: tool.description || "",
    })),
  }));
}

function getMcpToolsRevision() {
  return toolsRevision;
}

function onStatus(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

async function shutdownMcp() {
  stopWatching();
  await closeActiveClient();
  cachedTools = [];
  cachedToolsByServer = {};
  statusListeners.clear();
}

module.exports = {
  initMcp,
  shutdownMcp,
  reloadAndTest,
  getStatus,
  getConfigPath,
  getLogPath,
  getMcpTools,
  getMcpToolsByServer,
  getConnectedMcpServers,
  getMcpToolsRevision,
  readLogs,
  onStatus,
  validateConfigText,
};
