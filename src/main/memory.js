const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { FilesystemBackend } = require("deepagents");

/** Virtual mount for user-scoped AGENTS.md (outside the workspace). */
const USER_MEMORY_VIRTUAL_ROOT = "/memories/user/";
/** Project AGENTS.md lives in the workspace under .deepagents/. */
const PROJECT_MEMORY_VIRTUAL_PATH = "/.deepagents/AGENTS.md";

const DEFAULT_USER_MEMORY = `# OpenPilot user memory

Persistent preferences for this machine (all projects).

## Preferences
- Prefer concise answers unless asked for detail
- Prefer making real file changes over only describing them

## Notes
- Update this file when the user asks you to remember something across projects
`;

const DEFAULT_PROJECT_MEMORY = `# OpenPilot project memory

Project-specific instructions for this workspace.

## Conventions
- Follow existing code style in this repository

## Notes
- Update this file when the user asks you to remember project-specific facts
`;

function formatPathLabel(filePath) {
  if (!filePath) return "";
  const home = os.homedir();
  if (home && filePath.startsWith(home)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

function getUserMemoryDir() {
  return path.join(os.homedir(), ".onecode", "memory");
}

function getUserMemoryPath() {
  return path.join(getUserMemoryDir(), "AGENTS.md");
}

function getProjectMemoryDir(workspacePath) {
  if (!workspacePath || typeof workspacePath !== "string") return null;
  const root = workspacePath.trim();
  if (!root) return null;
  return path.join(root, ".deepagents");
}

function getProjectMemoryPath(workspacePath) {
  const dir = getProjectMemoryDir(workspacePath);
  return dir ? path.join(dir, "AGENTS.md") : null;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function ensureMemoryFile(filePath, defaultContent) {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, "utf8");
  }
  return filePath;
}

function ensureUserMemoryFile() {
  return ensureMemoryFile(getUserMemoryPath(), DEFAULT_USER_MEMORY);
}

function ensureProjectMemoryFile(workspacePath) {
  const filePath = getProjectMemoryPath(workspacePath);
  if (!filePath) {
    throw new Error("Pick a workspace folder before managing project memory.");
  }
  return ensureMemoryFile(filePath, DEFAULT_PROJECT_MEMORY);
}

/**
 * Resolve memory sources for createDeepAgent({ memory }).
 * Paths are virtual (backend-relative).
 */
function getMemorySourcePaths(workspacePath, settings = {}) {
  const enabled = Boolean(settings?.enabled);
  const userEnabled = settings?.user !== false;
  const projectEnabled = settings?.project !== false;

  /** @type {string[]} */
  const sources = [];
  if (enabled && userEnabled) {
    ensureUserMemoryFile();
    sources.push(`${USER_MEMORY_VIRTUAL_ROOT}AGENTS.md`);
  }
  if (enabled && projectEnabled && workspacePath) {
    ensureProjectMemoryFile(workspacePath);
    sources.push(PROJECT_MEMORY_VIRTUAL_PATH);
  }

  return {
    enabled,
    userEnabled,
    projectEnabled,
    sources,
    userVirtualRoot: USER_MEMORY_VIRTUAL_ROOT,
    projectVirtualPath: PROJECT_MEMORY_VIRTUAL_PATH,
    userPath: getUserMemoryPath(),
    projectPath: getProjectMemoryPath(workspacePath),
    userPathLabel: formatPathLabel(getUserMemoryPath()),
    projectPathLabel:
      formatPathLabel(getProjectMemoryPath(workspacePath)) || "Pick a workspace first",
  };
}

/** FilesystemBackend mount for user AGENTS.md (CompositeBackend route). */
function createUserMemoryBackend() {
  const rootDir = ensureDir(getUserMemoryDir());
  return new FilesystemBackend({
    rootDir,
    virtualMode: true,
  });
}

function getMemoryRevision(workspacePath, settings = {}) {
  if (!settings?.enabled) return "off";
  const parts = ["on"];
  if (settings?.user !== false) {
    const p = getUserMemoryPath();
    try {
      parts.push(`u:${fs.statSync(p).mtimeMs}`);
    } catch {
      parts.push("u:missing");
    }
  } else {
    parts.push("u:off");
  }
  if (settings?.project !== false && workspacePath) {
    const p = getProjectMemoryPath(workspacePath);
    try {
      parts.push(`p:${fs.statSync(p).mtimeMs}`);
    } catch {
      parts.push("p:missing");
    }
  } else {
    parts.push("p:off");
  }
  return parts.join(":");
}

module.exports = {
  USER_MEMORY_VIRTUAL_ROOT,
  PROJECT_MEMORY_VIRTUAL_PATH,
  getUserMemoryPath,
  getProjectMemoryPath,
  ensureUserMemoryFile,
  ensureProjectMemoryFile,
  getMemorySourcePaths,
  createUserMemoryBackend,
  getMemoryRevision,
};
