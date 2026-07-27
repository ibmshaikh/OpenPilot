const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");

const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$|^[a-z0-9]$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const USER_VIRTUAL_SOURCE = "/skills/user/";
const PROJECT_VIRTUAL_SOURCE = "/.onecode/skills/";

function getSkillVirtualMdPath(scope, name) {
  const safeName = String(name || "").trim();
  if (String(scope || "").trim().toLowerCase() === "project") {
    return `${PROJECT_VIRTUAL_SOURCE}${safeName}/SKILL.md`;
  }
  return `${USER_VIRTUAL_SOURCE}${safeName}/SKILL.md`;
}

function getUserSkillsDir() {
  return path.join(os.homedir(), ".onecode", "skills");
}

function getProjectSkillsDir(workspacePath) {
  if (!workspacePath || typeof workspacePath !== "string") return null;
  const root = workspacePath.trim();
  if (!root) return null;
  return path.join(root, ".onecode", "skills");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function ensureUserSkillsDir() {
  return ensureDir(getUserSkillsDir());
}

function ensureProjectSkillsDir(workspacePath) {
  const dir = getProjectSkillsDir(workspacePath);
  if (!dir) {
    throw new Error("Pick a workspace folder before managing project skills.");
  }
  return ensureDir(dir);
}

function formatPathLabel(filePath) {
  if (!filePath) return "";
  const home = os.homedir();
  if (home && filePath.startsWith(home)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

function validateSkillName(name) {
  const value = String(name || "").trim();
  if (!value) throw new Error("Skill name is required.");
  if (value.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(`Skill name must be at most ${MAX_SKILL_NAME_LENGTH} characters.`);
  }
  if (!SKILL_NAME_RE.test(value)) {
    throw new Error(
      "Skill name must be lowercase letters, numbers, and hyphens (no leading/trailing hyphen)."
    );
  }
  return value;
}

function validateDescription(description) {
  const value = String(description || "").trim();
  if (!value) throw new Error("Skill description is required.");
  if (value.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new Error(
      `Skill description must be at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`
    );
  }
  return value;
}

function validateScope(scope) {
  const value = String(scope || "").trim().toLowerCase();
  if (value !== "user" && value !== "project") {
    throw new Error('Skill scope must be "user" or "project".');
  }
  return value;
}

function getSkillsRoot(scope, workspacePath) {
  const normalized = validateScope(scope);
  if (normalized === "user") return ensureUserSkillsDir();
  return ensureProjectSkillsDir(workspacePath);
}

function getSkillDir(scope, name, workspacePath) {
  return path.join(getSkillsRoot(scope, workspacePath), validateSkillName(name));
}

function getSkillMdPath(scope, name, workspacePath) {
  return path.join(getSkillDir(scope, name, workspacePath), "SKILL.md");
}

function escapeYamlDoubleQuoted(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildSkillMarkdown({ name, description, body }) {
  const safeName = validateSkillName(name);
  const safeDescription = validateDescription(description);
  const instructions = String(body || "").trim() || `# ${safeName}\n`;
  return `---\nname: ${safeName}\ndescription: "${escapeYamlDoubleQuoted(safeDescription)}"\n---\n\n${instructions}\n`;
}

function extractBodyFromSkillMd(content) {
  const text = String(content || "");
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return text.trim();
  return text.slice(match[0].length).replace(/^\r?\n/, "").trimEnd();
}

function parseFrontmatter(content) {
  const text = String(content || "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { name: "", description: "", body: text.trim() };
  }

  const yaml = match[1];
  const body = text.slice(match[0].length).replace(/^\r?\n/, "").trimEnd();
  let name = "";
  let description = "";

  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") name = value;
    if (key === "description") description = value;
  }

  return { name, description, body };
}

function readSkillFile(skillMdPath) {
  const content = fs.readFileSync(skillMdPath, "utf8");
  const parsed = parseFrontmatter(content);
  const dirName = path.basename(path.dirname(skillMdPath));
  return {
    name: parsed.name || dirName,
    description: parsed.description || "",
    body: parsed.body || "",
    content,
  };
}

function listSkillsInDir(dirPath, scope) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];

  /** @type {Array<object>} */
  const skills = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(dirPath, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;
    try {
      const skill = readSkillFile(skillMdPath);
      const stat = fs.statSync(skillMdPath);
      skills.push({
        name: skill.name || entry.name,
        description: skill.description || "",
        body: skill.body || "",
        scope,
        dirName: entry.name,
        path: skillMdPath,
        dirPath: path.join(dirPath, entry.name),
        pathLabel: formatPathLabel(skillMdPath),
        mtimeMs: stat.mtimeMs,
      });
    } catch (error) {
      console.error(`Failed to read skill ${entry.name}:`, error);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function listSkills(workspacePath) {
  const userSkills = listSkillsInDir(getUserSkillsDir(), "user");
  const projectDir = getProjectSkillsDir(workspacePath);
  const projectSkills = projectDir ? listSkillsInDir(projectDir, "project") : [];

  /** @type {Map<string, object>} */
  const byName = new Map();
  for (const skill of userSkills) byName.set(skill.name, skill);
  for (const skill of projectSkills) byName.set(skill.name, skill);

  return {
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    userSkills,
    projectSkills,
    paths: {
      user: formatPathLabel(getUserSkillsDir()),
      userAbsolute: getUserSkillsDir(),
      project: projectDir ? formatPathLabel(projectDir) : null,
      projectAbsolute: projectDir,
    },
  };
}

function getSkill(scope, name, workspacePath) {
  const skillMdPath = getSkillMdPath(scope, name, workspacePath);
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`Skill "${name}" not found in ${scope} skills.`);
  }
  const skill = readSkillFile(skillMdPath);
  return {
    name: skill.name,
    description: skill.description,
    body: skill.body,
    scope: validateScope(scope),
    path: skillMdPath,
    dirPath: path.dirname(skillMdPath),
    pathLabel: formatPathLabel(skillMdPath),
  };
}

function createSkill({ scope, name, description, body, workspacePath }) {
  const normalizedScope = validateScope(scope);
  const safeName = validateSkillName(name);
  const skillDir = getSkillDir(normalizedScope, safeName, workspacePath);
  const skillMdPath = path.join(skillDir, "SKILL.md");

  if (fs.existsSync(skillMdPath)) {
    throw new Error(`Skill "${safeName}" already exists in ${normalizedScope} skills.`);
  }

  ensureDir(skillDir);
  fs.writeFileSync(
    skillMdPath,
    buildSkillMarkdown({ name: safeName, description, body }),
    "utf8"
  );

  return getSkill(normalizedScope, safeName, workspacePath);
}

function updateSkill({ scope, name, description, body, workspacePath, renameTo }) {
  const normalizedScope = validateScope(scope);
  const currentName = validateSkillName(name);
  const nextName = renameTo ? validateSkillName(renameTo) : currentName;
  const currentDir = getSkillDir(normalizedScope, currentName, workspacePath);
  const currentMd = path.join(currentDir, "SKILL.md");

  if (!fs.existsSync(currentMd)) {
    throw new Error(`Skill "${currentName}" not found in ${normalizedScope} skills.`);
  }

  const existing = readSkillFile(currentMd);
  const markdown = buildSkillMarkdown({
    name: nextName,
    description: description ?? existing.description,
    body: body ?? existing.body,
  });

  if (nextName !== currentName) {
    const nextDir = getSkillDir(normalizedScope, nextName, workspacePath);
    if (fs.existsSync(nextDir)) {
      throw new Error(`Skill "${nextName}" already exists in ${normalizedScope} skills.`);
    }
    fs.renameSync(currentDir, nextDir);
    fs.writeFileSync(path.join(nextDir, "SKILL.md"), markdown, "utf8");
    return getSkill(normalizedScope, nextName, workspacePath);
  }

  fs.writeFileSync(currentMd, markdown, "utf8");
  return getSkill(normalizedScope, currentName, workspacePath);
}

function deleteSkill(scope, name, workspacePath) {
  const skillDir = getSkillDir(scope, name, workspacePath);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`Skill "${name}" not found in ${scope} skills.`);
  }

  fs.rmSync(skillDir, { recursive: true, force: true });
  return { ok: true, name: validateSkillName(name), scope: validateScope(scope) };
}

/**
 * Virtual skill source paths for deepagents SkillsMiddleware, plus real dirs
 * needed to mount user skills outside the workspace via CompositeBackend.
 */
function getSkillSourcePaths(workspacePath) {
  const userDir = ensureUserSkillsDir();
  const projectDir = workspacePath ? getProjectSkillsDir(workspacePath) : null;
  if (projectDir) ensureDir(projectDir);

  return {
    userDir,
    projectDir,
    /** Virtual paths relative to the agent backend root (project last → wins). */
    sources: [USER_VIRTUAL_SOURCE, PROJECT_VIRTUAL_SOURCE],
    userVirtualSource: USER_VIRTUAL_SOURCE,
    projectVirtualSource: PROJECT_VIRTUAL_SOURCE,
  };
}

/** Cache-busting fingerprint so agents rebuild when skills change on disk. */
function getSkillsRevision(workspacePath) {
  const { userSkills, projectSkills } = listSkills(workspacePath);
  const parts = [...userSkills, ...projectSkills]
    .map((skill) => `${skill.scope}:${skill.name}:${Math.floor(skill.mtimeMs || 0)}`)
    .sort();
  return parts.join("|") || "none";
}

const SKILL_CONTAINER_DIRS = new Set([
  "skills",
  ".agents",
  ".agent",
  ".cursor",
  ".claude",
  ".codex",
  ".onecode",
  ".github",
  "packages",
]);

function rmrf(target) {
  if (target && fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function copyDirRecursive(src, dest) {
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true, force: true });
}

/**
 * Normalize user-pasted skill sources into a fetch plan.
 * Accepts: owner/repo, GitHub URLs, skills.sh URLs, raw SKILL.md URLs.
 */
function parseSkillSource(source) {
  const raw = String(source || "").trim();
  if (!raw) throw new Error("Skill source is required (GitHub URL, owner/repo, or SKILL.md URL).");

  // owner/repo or owner/repo/path
  const shorthand = raw.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/
  );
  if (shorthand && !raw.includes("://") && !raw.includes(" ")) {
    return {
      kind: "github",
      owner: shorthand[1],
      repo: shorthand[2].replace(/\.git$/i, ""),
      ref: null,
      subpath: shorthand[3] ? shorthand[3].replace(/^\/+|\/+$/g, "") : null,
      display: `${shorthand[1]}/${shorthand[2].replace(/\.git$/i, "")}`,
      cloneUrl: `https://github.com/${shorthand[1]}/${shorthand[2].replace(/\.git$/i, "")}.git`,
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `Unrecognized skill source "${raw}". Use owner/repo, a GitHub URL, skills.sh URL, or a direct SKILL.md link.`
    );
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  // skills.sh/owner/repo[/skill]
  if (host === "skills.sh") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error("skills.sh URL must look like https://skills.sh/owner/repo");
    }
    return {
      kind: "github",
      owner: parts[0],
      repo: parts[1],
      ref: null,
      subpath: parts.length > 2 ? parts.slice(2).join("/") : null,
      display: `skills.sh/${parts[0]}/${parts[1]}`,
      cloneUrl: `https://github.com/${parts[0]}/${parts[1]}.git`,
    };
  }

  // raw.githubusercontent.com/owner/repo/ref/path/SKILL.md
  if (host === "raw.githubusercontent.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 4) {
      const filePath = parts.slice(3).join("/");
      return {
        kind: "raw",
        owner: parts[0],
        repo: parts[1],
        ref: parts[2],
        filePath,
        display: raw,
        url: raw,
      };
    }
  }

  if (host === "github.com" || host === "www.github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error("GitHub URL must include owner and repo.");
    }
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    let ref = null;
    let subpath = null;

    if (parts[2] === "tree" || parts[2] === "blob") {
      ref = parts[3] || null;
      const rest = parts.slice(4);
      if (parts[2] === "blob" && rest.length) {
        const filePath = rest.join("/");
        if (rest[rest.length - 1].toLowerCase() === "skill.md") {
          return {
            kind: "raw",
            owner,
            repo,
            ref,
            filePath,
            display: `${owner}/${repo}`,
            url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`,
          };
        }
        subpath = rest.slice(0, -1).join("/") || rest.join("/");
      } else {
        subpath = rest.length ? rest.join("/") : null;
      }
    }

    return {
      kind: "github",
      owner,
      repo,
      ref,
      subpath,
      display: `${owner}/${repo}`,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
    };
  }

  // Direct SKILL.md on any https host
  if (/skill\.md$/i.test(url.pathname)) {
    return {
      kind: "raw",
      display: raw,
      url: raw,
      filePath: path.basename(url.pathname),
    };
  }

  throw new Error(
    `Unsupported skill URL host "${host}". Paste a GitHub repo/skill URL, skills.sh link, owner/repo, or raw SKILL.md URL.`
  );
}

function discoverSkillDirs(rootDir, { preferSubpath = null } = {}) {
  const found = [];
  const seen = new Set();

  function consider(skillMdPath) {
    const dir = path.dirname(skillMdPath);
    if (seen.has(dir)) return;
    seen.add(dir);
    try {
      const skill = readSkillFile(skillMdPath);
      const dirName = path.basename(dir);
      let name;
      try {
        name = validateSkillName(skill.name || dirName);
      } catch {
        name = validateSkillName(
          String(skill.name || dirName)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64) || "skill"
        );
      }
      found.push({
        name,
        description: skill.description || "",
        dirPath: dir,
        skillMdPath,
        relativePath: path.relative(rootDir, dir).split(path.sep).join("/"),
      });
    } catch (error) {
      console.error("Skipping invalid skill at", skillMdPath, error.message);
    }
  }

  if (preferSubpath) {
    const preferred = path.join(rootDir, preferSubpath);
    const directMd = path.join(preferred, "SKILL.md");
    if (fs.existsSync(directMd)) {
      consider(directMd);
      return found;
    }
    if (fs.existsSync(preferred) && fs.statSync(preferred).isFile() && /skill\.md$/i.test(preferred)) {
      consider(preferred);
      return found;
    }
  }

  const rootMd = path.join(rootDir, "SKILL.md");
  if (fs.existsSync(rootMd)) {
    consider(rootMd);
    return found;
  }

  function walk(dir, depth) {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "SKILL.md") {
        consider(full);
        continue;
      }
      if (!entry.isDirectory()) continue;
      // Prefer known skill containers; still walk one level of others for flat layouts.
      if (depth === 0 && !SKILL_CONTAINER_DIRS.has(entry.name) && entry.name.startsWith(".")) {
        // skip unknown hidden dirs at root except containers already listed
        continue;
      }
      walk(full, depth + 1);
    }
  }

  walk(rootDir, 0);

  // Deduplicate by skill name (prefer shallower relative paths)
  found.sort((a, b) => a.relativePath.length - b.relativePath.length);
  const byName = new Map();
  for (const skill of found) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function cloneGithubRepo(parsed, tempRoot) {
  ensureDir(tempRoot);
  const dest = path.join(tempRoot, "repo");
  rmrf(dest);
  const args = ["clone", "--depth", "1"];
  if (parsed.ref) {
    args.push("--branch", parsed.ref);
  }
  args.push(parsed.cloneUrl, dest);
  try {
    execFileSync("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : error.message;
    throw new Error(`Failed to clone ${parsed.display}: ${stderr.slice(0, 400)}`);
  }
  return dest;
}

async function downloadRawSkillMd(parsed, tempRoot) {
  ensureDir(tempRoot);
  const destDir = path.join(tempRoot, "raw-skill");
  ensureDir(destDir);
  const url = parsed.url;
  if (!url) throw new Error("Raw skill URL is missing.");

  const response = await fetch(url, {
    headers: { Accept: "text/plain, text/markdown, */*" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Failed to download SKILL.md (${response.status}): ${url}`);
  }
  const content = await response.text();
  if (!content.trim()) throw new Error("Downloaded SKILL.md is empty.");
  const skillMdPath = path.join(destDir, "SKILL.md");
  fs.writeFileSync(skillMdPath, content, "utf8");
  return destDir;
}

async function materializeSkillSource(source) {
  const parsed = parseSkillSource(source);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "onecode-skills-"));
  try {
    let searchRoot;
    if (parsed.kind === "raw" && parsed.url) {
      searchRoot = await downloadRawSkillMd(parsed, tempRoot);
    } else if (parsed.kind === "github" || (parsed.kind === "raw" && parsed.cloneUrl)) {
      searchRoot = cloneGithubRepo(
        {
          ...parsed,
          cloneUrl: parsed.cloneUrl || `https://github.com/${parsed.owner}/${parsed.repo}.git`,
        },
        tempRoot
      );
    } else {
      throw new Error("Unable to resolve skill source.");
    }

    const preferSubpath =
      parsed.subpath ||
      (parsed.filePath && !/skill\.md$/i.test(parsed.filePath)
        ? parsed.filePath
        : parsed.filePath && /skill\.md$/i.test(parsed.filePath)
          ? path.posix.dirname(parsed.filePath)
          : null);

    const discovered = discoverSkillDirs(searchRoot, {
      preferSubpath: preferSubpath && preferSubpath !== "." ? preferSubpath : null,
    });

    return { parsed, tempRoot, searchRoot, discovered };
  } catch (error) {
    rmrf(tempRoot);
    throw error;
  }
}

/**
 * List skills available at a remote source without installing.
 */
async function listRemoteSkills(source) {
  const { parsed, tempRoot, discovered } = await materializeSkillSource(source);
  try {
    return {
      source: parsed.display || source,
      skills: discovered.map((skill) => ({
        name: skill.name,
        description: skill.description,
        relativePath: skill.relativePath,
      })),
    };
  } finally {
    rmrf(tempRoot);
  }
}

/**
 * Install one or more skills from a GitHub repo / skills.sh / SKILL.md URL.
 */
async function installSkillsFromSource({
  source,
  scope = "user",
  workspacePath = null,
  skillNames = null,
  overwrite = false,
} = {}) {
  const normalizedScope = validateScope(scope);
  if (normalizedScope === "project" && !workspacePath) {
    throw new Error("Pick a workspace folder before installing project skills.");
  }

  const destRoot =
    normalizedScope === "user"
      ? ensureUserSkillsDir()
      : ensureProjectSkillsDir(workspacePath);

  const { parsed, tempRoot, discovered } = await materializeSkillSource(source);
  try {
    if (!discovered.length) {
      throw new Error(
        `No SKILL.md skills found in ${parsed.display || source}. Expected folders containing SKILL.md.`
      );
    }

    let selected = discovered;
    if (Array.isArray(skillNames) && skillNames.length) {
      const wanted = new Set(
        skillNames.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean)
      );
      selected = discovered.filter(
        (skill) => wanted.has(skill.name.toLowerCase()) || wanted.has("*")
      );
      if (!selected.length) {
        throw new Error(
          `None of the requested skills were found. Available: ${discovered
            .map((s) => s.name)
            .join(", ")}`
        );
      }
    }

    const installed = [];
    const skipped = [];

    for (const skill of selected) {
      const targetDir = path.join(destRoot, skill.name);
      if (fs.existsSync(targetDir) && !overwrite) {
        skipped.push({
          name: skill.name,
          reason: "already exists (pass overwrite=true to replace)",
          path: formatPathLabel(targetDir),
        });
        continue;
      }
      rmrf(targetDir);
      copyDirRecursive(skill.dirPath, targetDir);
      // Record provenance for Settings / future updates
      try {
        fs.writeFileSync(
          path.join(targetDir, ".onecode-source.json"),
          JSON.stringify(
            {
              source: String(source).trim(),
              display: parsed.display || source,
              installedAt: new Date().toISOString(),
              scope: normalizedScope,
            },
            null,
            2
          ),
          "utf8"
        );
      } catch {
        // non-fatal
      }
      installed.push({
        name: skill.name,
        description: skill.description,
        scope: normalizedScope,
        path: formatPathLabel(path.join(targetDir, "SKILL.md")),
      });
    }

    return {
      source: parsed.display || source,
      scope: normalizedScope,
      available: discovered.map((s) => s.name),
      installed,
      skipped,
    };
  } finally {
    rmrf(tempRoot);
  }
}

/**
 * Always-on agent tools so chat can install skills from pasted repos/URLs.
 */
function createSkillTools({ workspacePath, onChange } = {}) {
  const listRemote = tool(
    async ({ source }) => {
      const result = await listRemoteSkills(source);
      return JSON.stringify(result, null, 2);
    },
    {
      name: "list_remote_skills",
      description:
        "List Agent Skills (SKILL.md) available at a GitHub repo, skills.sh page, owner/repo shorthand, or SKILL.md URL — without installing. Use when the user pastes a skills repo/website and you need to show what can be installed, or before installing a specific skill name.",
      schema: z.object({
        source: z
          .string()
          .describe(
            "GitHub URL, skills.sh URL, owner/repo, or direct SKILL.md URL the user provided."
          ),
      }),
    }
  );

  const installRemote = tool(
    async ({ source, scope, skills, overwrite }) => {
      const result = await installSkillsFromSource({
        source,
        scope: scope || "user",
        workspacePath,
        skillNames: skills && skills.length ? skills : null,
        overwrite: Boolean(overwrite),
      });
      if (typeof onChange === "function") {
        try {
          onChange(result);
        } catch (error) {
          console.error("Skill install onChange failed:", error);
        }
      }
      return JSON.stringify(result, null, 2);
    },
    {
      name: "install_skill",
      description:
        "Install Agent Skills into OpenPilot from a GitHub repo, skills.sh link, owner/repo shorthand, or SKILL.md URL. Call this whenever the user pastes a skills repository or website and wants OpenPilot to gain that capability. Default scope is user (~/.onecode/skills). Use project scope for workspace-only .onecode/skills. If multiple skills exist and the user did not specify, list_remote_skills first or install all. Set overwrite=true to replace an existing skill with the same name.",
      schema: z.object({
        source: z
          .string()
          .describe(
            "GitHub URL, skills.sh URL, owner/repo (e.g. vercel-labs/agent-skills), or raw SKILL.md URL."
          ),
        scope: z
          .enum(["user", "project"])
          .optional()
          .describe(
            'Install location. "user" = ~/.onecode/skills (all workspaces). "project" = .onecode/skills in the current workspace. Default: user.'
          ),
        skills: z
          .array(z.string())
          .optional()
          .describe(
            "Optional skill names to install. Omit to install every skill found in the source."
          ),
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace existing skills with the same name. Default false."),
      }),
    }
  );

  return [listRemote, installRemote];
}

module.exports = {
  USER_VIRTUAL_SOURCE,
  PROJECT_VIRTUAL_SOURCE,
  getUserSkillsDir,
  getProjectSkillsDir,
  ensureUserSkillsDir,
  ensureProjectSkillsDir,
  formatPathLabel,
  validateSkillName,
  validateDescription,
  validateScope,
  buildSkillMarkdown,
  extractBodyFromSkillMd,
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  getSkillSourcePaths,
  getSkillsRevision,
  getSkillVirtualMdPath,
  parseSkillSource,
  listRemoteSkills,
  installSkillsFromSource,
  createSkillTools,
};

