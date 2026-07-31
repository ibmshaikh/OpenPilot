const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");

let db;
/** @type {Buffer | null} */
let secretKey = null;

/** Legacy: Electron safeStorage / Keychain (prompts for password — no longer written). */
const SECRET_PREFIX_V1 = "enc:v1:";
/** AES-256-GCM with a local key file in userData (no OS password prompts). */
const SECRET_PREFIX = "enc:v2:";
const TINYFISH_SETTINGS_KEY = "tinyfish";
const MEMORY_SETTINGS_KEY = "memory";
const ONBOARDING_SETTINGS_KEY = "onboarding";
const DEFAULT_MODEL_SETTINGS_KEY = "defaultModelId";

function getDbPath() {
  return path.join(app.getPath("userData"), "onecode.sqlite");
}

function getSecretKeyPath() {
  return path.join(app.getPath("userData"), "secrets.key");
}

function getSecretKey() {
  if (secretKey) return secretKey;

  const keyPath = getSecretKeyPath();
  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath);
      if (existing.length === 32) {
        secretKey = existing;
        return secretKey;
      }
    }
  } catch (err) {
    console.error("[db] Failed to read secrets.key:", err);
  }

  secretKey = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, secretKey, { mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // best-effort on platforms that ignore mode
  }
  return secretKey;
}

function isEncryptedSecret(value) {
  const v = String(value || "");
  return v.startsWith(SECRET_PREFIX) || v.startsWith(SECRET_PREFIX_V1);
}

/** Encrypt a secret for disk storage (AES-256-GCM). */
function encryptSecret(plainText) {
  const plain = String(plainText || "");
  if (!plain) return "";
  if (plain.startsWith(SECRET_PREFIX)) return plain;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SECRET_PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** Decrypt a stored secret. Plaintext legacy values are returned as-is. */
function decryptSecret(stored) {
  const value = String(stored || "");
  if (!value) return "";

  if (value.startsWith(SECRET_PREFIX)) {
    try {
      const buf = Buffer.from(value.slice(SECRET_PREFIX.length), "base64");
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const data = buf.subarray(28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", getSecretKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch (err) {
      console.error("[db] Failed to decrypt secret:", err);
      return "";
    }
  }

  // Legacy Keychain-backed values are unsupported (avoid OS password prompts).
  if (value.startsWith(SECRET_PREFIX_V1)) return "";

  return value;
}

function migrateSecretsToV2() {
  const updateModelKey = db.prepare(`UPDATE models SET api_key = ? WHERE id = ?`);
  for (const row of db.prepare(`SELECT id, api_key AS apiKey FROM models`).all()) {
    const stored = String(row.apiKey || "");
    if (!stored || stored.startsWith(SECRET_PREFIX)) continue;
    // Drop unreadable v1 Keychain blobs; plaintext keys are upgraded to v2.
    if (stored.startsWith(SECRET_PREFIX_V1)) {
      updateModelKey.run("", row.id);
      continue;
    }
    updateModelKey.run(encryptSecret(stored), row.id);
  }

  const settingsRow = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(TINYFISH_SETTINGS_KEY);
  if (!settingsRow?.value) return;

  try {
    const parsed = JSON.parse(settingsRow.value);
    const key = String(parsed?.apiKey || "");
    if (!key || key.startsWith(SECRET_PREFIX)) return;
    if (key.startsWith(SECRET_PREFIX_V1)) {
      parsed.apiKey = "";
    } else {
      parsed.apiKey = encryptSecret(key);
    }
    db.prepare(
      `UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?`
    ).run(JSON.stringify(parsed), TINYFISH_SETTINGS_KEY);
  } catch {
    // leave corrupt settings row alone
  }
}

function initDatabase() {
  if (db) return db;

  db = new Database(getDbPath());
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      workspace_path TEXT,
      agent_state TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages (conversation_id, id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      model_name TEXT PRIMARY KEY,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  migrateSecretsToV2();

  return db;
}

/** @type {Map<string, {
 *   modelName: string,
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   requestCount: number,
 * }>} */
const sessionTokenUsage = new Map();

function emptyUsageRow(modelName) {
  return {
    modelName: String(modelName || "").trim() || "unknown",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requestCount: 0,
  };
}

function normalizeUsageDelta(delta = {}) {
  const toCount = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    modelName: String(delta.modelName || "").trim() || "unknown",
    inputTokens: toCount(delta.inputTokens),
    outputTokens: toCount(delta.outputTokens),
    cacheReadTokens: toCount(delta.cacheReadTokens),
    cacheWriteTokens: toCount(delta.cacheWriteTokens),
    requestCount: Math.max(1, toCount(delta.requestCount) || 1),
  };
}

function addUsageInto(target, delta) {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.requestCount += delta.requestCount;
  return target;
}

function mapTokenUsageRow(row) {
  if (!row) return null;
  return {
    modelName: row.model_name,
    inputTokens: Number(row.input_tokens) || 0,
    outputTokens: Number(row.output_tokens) || 0,
    cacheReadTokens: Number(row.cache_read_tokens) || 0,
    cacheWriteTokens: Number(row.cache_write_tokens) || 0,
    requestCount: Number(row.request_count) || 0,
    updatedAt: row.updated_at || null,
  };
}

function recordTokenUsage(delta) {
  const next = normalizeUsageDelta(delta);
  if (
    !next.inputTokens &&
    !next.outputTokens &&
    !next.cacheReadTokens &&
    !next.cacheWriteTokens
  ) {
    return getTokenUsage();
  }

  const sessionRow = sessionTokenUsage.get(next.modelName) || emptyUsageRow(next.modelName);
  addUsageInto(sessionRow, next);
  sessionTokenUsage.set(next.modelName, sessionRow);

  initDatabase()
    .prepare(
      `INSERT INTO token_usage (
         model_name, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, request_count, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(model_name) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         request_count = request_count + excluded.request_count,
         updated_at = datetime('now')`
    )
    .run(
      next.modelName,
      next.inputTokens,
      next.outputTokens,
      next.cacheReadTokens,
      next.cacheWriteTokens,
      next.requestCount
    );

  return getTokenUsage();
}

function listLifetimeTokenUsage() {
  return initDatabase()
    .prepare(
      `SELECT model_name, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, request_count, updated_at
       FROM token_usage
       ORDER BY updated_at DESC, model_name ASC`
    )
    .all()
    .map(mapTokenUsageRow);
}

function listSessionTokenUsage() {
  return Array.from(sessionTokenUsage.values())
    .map((row) => ({ ...row }))
    .sort((a, b) => a.modelName.localeCompare(b.modelName));
}

function summarizeUsageRows(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.inputTokens += row.inputTokens || 0;
      acc.outputTokens += row.outputTokens || 0;
      acc.cacheReadTokens += row.cacheReadTokens || 0;
      acc.cacheWriteTokens += row.cacheWriteTokens || 0;
      acc.requestCount += row.requestCount || 0;
      return acc;
    },
    emptyUsageRow("total")
  );
}

function getTokenUsage() {
  const lifetime = listLifetimeTokenUsage();
  const session = listSessionTokenUsage();
  return {
    lifetime,
    session,
    lifetimeTotal: summarizeUsageRows(lifetime),
    sessionTotal: summarizeUsageRows(session),
  };
}

function resetTokenUsage({ scope = "all" } = {}) {
  const nextScope = String(scope || "all").trim().toLowerCase();
  if (nextScope === "session" || nextScope === "all") {
    sessionTokenUsage.clear();
  }
  if (nextScope === "lifetime" || nextScope === "all") {
    initDatabase().exec(`DELETE FROM token_usage`);
  }
  return getTokenUsage();
}

function getDefaultTinyFishSettings() {
  return {
    enabled: false,
    apiKey: "",
  };
}

function getTinyFishSettings() {
  const row = initDatabase()
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(TINYFISH_SETTINGS_KEY);

  if (!row?.value) {
    return getDefaultTinyFishSettings();
  }

  try {
    const parsed = JSON.parse(row.value);
    return {
      enabled: Boolean(parsed?.enabled),
      apiKey: decryptSecret(parsed?.apiKey).trim(),
    };
  } catch {
    return getDefaultTinyFishSettings();
  }
}

function saveTinyFishSettings({ enabled, apiKey } = {}) {
  const plainKey = String(apiKey || "").trim();
  const next = {
    enabled: Boolean(enabled),
    apiKey: plainKey,
  };

  initDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`
    )
    .run(
      TINYFISH_SETTINGS_KEY,
      JSON.stringify({
        enabled: next.enabled,
        apiKey: encryptSecret(plainKey),
      })
    );

  return next;
}

function getOnboardingSettings() {
  const row = initDatabase()
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(ONBOARDING_SETTINGS_KEY);

  if (!row?.value) {
    return { completed: false };
  }

  try {
    const parsed = JSON.parse(row.value);
    return { completed: Boolean(parsed?.completed) };
  } catch {
    return { completed: false };
  }
}

function saveOnboardingSettings({ completed } = {}) {
  const next = { completed: Boolean(completed) };

  initDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`
    )
    .run(ONBOARDING_SETTINGS_KEY, JSON.stringify(next));

  return next;
}

function getDefaultMemorySettings() {
  return {
    enabled: false,
    user: true,
    project: true,
  };
}

function getMemorySettings() {
  const row = initDatabase()
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(MEMORY_SETTINGS_KEY);

  if (!row?.value) {
    return getDefaultMemorySettings();
  }

  try {
    const parsed = JSON.parse(row.value);
    return {
      enabled: Boolean(parsed?.enabled),
      user: parsed?.user !== false,
      project: parsed?.project !== false,
    };
  } catch {
    return getDefaultMemorySettings();
  }
}

function saveMemorySettings({ enabled, user, project } = {}) {
  const next = {
    enabled: Boolean(enabled),
    user: user !== false,
    project: project !== false,
  };

  initDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`
    )
    .run(MEMORY_SETTINGS_KEY, JSON.stringify(next));

  return next;
}

const BROWSER_SETTINGS_KEY = "browser";

function getDefaultBrowserSettings() {
  return {
    enabled: false,
  };
}

function getBrowserSettings() {
  const row = initDatabase()
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(BROWSER_SETTINGS_KEY);

  if (!row?.value) {
    return getDefaultBrowserSettings();
  }

  try {
    const parsed = JSON.parse(row.value);
    return {
      enabled: Boolean(parsed?.enabled),
    };
  } catch {
    return getDefaultBrowserSettings();
  }
}

function saveBrowserSettings({ enabled } = {}) {
  const next = {
    enabled: Boolean(enabled),
  };

  initDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`
    )
    .run(BROWSER_SETTINGS_KEY, JSON.stringify(next));

  return next;
}

function mapModel(row) {
  if (!row) return null;
  return {
    ...row,
    apiKey: decryptSecret(row.apiKey),
  };
}

function listModels() {
  return initDatabase()
    .prepare(
      `SELECT id, model_name AS modelName, base_url AS baseUrl, api_key AS apiKey,
              display_name AS displayName, created_at AS createdAt, updated_at AS updatedAt
       FROM models
       ORDER BY updated_at DESC, id DESC`
    )
    .all()
    .map(mapModel);
}

function getModel(id) {
  return mapModel(
    initDatabase()
      .prepare(
        `SELECT id, model_name AS modelName, base_url AS baseUrl, api_key AS apiKey,
                display_name AS displayName, created_at AS createdAt, updated_at AS updatedAt
         FROM models
         WHERE id = ?`
      )
      .get(id)
  );
}

function createModel({ modelName, baseUrl, apiKey, displayName }) {
  const result = initDatabase()
    .prepare(
      `INSERT INTO models (model_name, base_url, api_key, display_name)
       VALUES (?, ?, ?, ?)`
    )
    .run(modelName, baseUrl, encryptSecret(apiKey), displayName);

  return getModel(result.lastInsertRowid);
}

function updateModel(id, { modelName, baseUrl, apiKey, displayName }) {
  initDatabase()
    .prepare(
      `UPDATE models
       SET model_name = ?, base_url = ?, api_key = ?, display_name = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(modelName, baseUrl, encryptSecret(apiKey), displayName, id);

  return getModel(id);
}

function deleteModel(id) {
  const result = initDatabase().prepare(`DELETE FROM models WHERE id = ?`).run(id);
  const currentDefault = getDefaultModelId();
  if (currentDefault === Number(id)) {
    setDefaultModelId(null);
  }
  return { success: result.changes > 0 };
}

function getDefaultModelId() {
  const row = initDatabase()
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(DEFAULT_MODEL_SETTINGS_KEY);

  if (!row?.value) return null;

  try {
    const parsed = JSON.parse(row.value);
    const nextId = Number(parsed?.id);
    return Number.isInteger(nextId) && nextId > 0 ? nextId : null;
  } catch {
    return null;
  }
}

function setDefaultModelId(id) {
  const numericId = id == null || id === "" ? null : Number(id);
  const next =
    Number.isInteger(numericId) && numericId > 0 ? numericId : null;

  if (next != null) {
    const exists = getModel(next);
    if (!exists) {
      throw new Error("Cannot set default: model not found.");
    }
  }

  initDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`
    )
    .run(DEFAULT_MODEL_SETTINGS_KEY, JSON.stringify({ id: next }));

  return { id: next };
}

function mapConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    workspacePath: row.workspace_path || null,
    agentState: row.agent_state || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function touchConversation(id) {
  initDatabase()
    .prepare(
      `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
    )
    .run(id);
}

function listConversations() {
  return initDatabase()
    .prepare(
      `SELECT id, title, workspace_path, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC, created_at DESC`
    )
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      workspacePath: row.workspace_path || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

function getConversation(id) {
  return mapConversation(
    initDatabase()
      .prepare(
        `SELECT id, title, workspace_path, agent_state, created_at, updated_at
         FROM conversations
         WHERE id = ?`
      )
      .get(id)
  );
}

function createConversation({ title = "New chat", workspacePath = null } = {}) {
  const id = crypto.randomUUID();
  initDatabase()
    .prepare(
      `INSERT INTO conversations (id, title, workspace_path)
       VALUES (?, ?, ?)`
    )
    .run(id, title || "New chat", workspacePath || null);

  return getConversation(id);
}

function deleteConversation(id) {
  const result = initDatabase()
    .prepare(`DELETE FROM conversations WHERE id = ?`)
    .run(id);
  return { ok: result.changes > 0, id };
}

function updateConversationTitle(id, title) {
  const next = String(title || "").trim() || "New chat";
  initDatabase()
    .prepare(
      `UPDATE conversations
       SET title = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(next, id);
  return getConversation(id);
}

function updateConversationWorkspace(id, workspacePath) {
  initDatabase()
    .prepare(
      `UPDATE conversations
       SET workspace_path = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(workspacePath || null, id);
  return getConversation(id);
}

function saveConversationAgentState(id, agentState) {
  initDatabase()
    .prepare(
      `UPDATE conversations
       SET agent_state = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(agentState || null, id);
}

function listMessages(conversationId) {
  return initDatabase()
    .prepare(
      `SELECT id, conversation_id AS conversationId, role, content_json AS contentJson,
              created_at AS createdAt
       FROM messages
       WHERE conversation_id = ?
       ORDER BY id ASC`
    )
    .all(conversationId)
    .map((row) => {
      let content = {};
      try {
        content = JSON.parse(row.contentJson || "{}");
      } catch {
        content = { text: String(row.contentJson || "") };
      }
      return {
        id: row.id,
        conversationId: row.conversationId,
        role: row.role,
        content,
        createdAt: row.createdAt,
      };
    });
}

function addMessage(conversationId, { role, content }) {
  const contentJson = JSON.stringify(content ?? {});
  const result = initDatabase()
    .prepare(
      `INSERT INTO messages (conversation_id, role, content_json)
       VALUES (?, ?, ?)`
    )
    .run(conversationId, role, contentJson);

  touchConversation(conversationId);

  return {
    id: Number(result.lastInsertRowid),
    conversationId,
    role,
    content: content ?? {},
  };
}

function getConversationWithMessages(id) {
  const conversation = getConversation(id);
  if (!conversation) return null;
  return {
    ...conversation,
    messages: listMessages(id),
  };
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDatabase,
  listModels,
  getModel,
  createModel,
  updateModel,
  deleteModel,
  getDefaultModelId,
  setDefaultModelId,
  getTinyFishSettings,
  saveTinyFishSettings,
  getOnboardingSettings,
  saveOnboardingSettings,
  getMemorySettings,
  saveMemorySettings,
  getBrowserSettings,
  saveBrowserSettings,
  recordTokenUsage,
  getTokenUsage,
  resetTokenUsage,
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  updateConversationTitle,
  updateConversationWorkspace,
  saveConversationAgentState,
  listMessages,
  addMessage,
  getConversationWithMessages,
  closeDatabase,
};
