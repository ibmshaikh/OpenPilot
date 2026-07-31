const {
  createDeepAgent,
  LocalShellBackend,
  FilesystemBackend,
  CompositeBackend,
  createSummarizationMiddleware,
  createPatchToolCallsMiddleware,
  computeSummarizationDefaults,
} = require("deepagents");
const { createMiddleware } = require("langchain");
const { ChatOpenAI } = require("@langchain/openai");
const { MemorySaver } = require("@langchain/langgraph");
const {
  AIMessageChunk,
  ToolMessage,
  SystemMessage,
  HumanMessage,
} = require("@langchain/core/messages");
const { isGraphInterrupt } = require("@langchain/langgraph");
const fs = require("node:fs");
const { getMcpTools, getMcpToolsRevision } = require("./mcp");
const { wrapWithStreamingShell } = require("./streaming-shell");

/**
 * Deepagents built-in tool names. Extra tools (MCP / skills) must not
 * collide or createDeepAgent throws ConfigurationError and the chat dies.
 */
const DEEPAGENT_BUILTIN_TOOL_NAMES = new Set([
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "execute",
  "task",
  "write_todos",
  "start_async_task",
  "check_async_task",
  "update_async_task",
  "cancel_async_task",
  "list_async_tasks",
]);

/**
 * Rename reserved collisions and convert hard tool throws into ToolMessage
 * errors so the agent loop can continue (deepagents wrapToolCall otherwise
 * treats MCP ToolException as a fatal middleware error).
 */
function prepareExtraTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return [];

  return tools.map((original) => {
    if (!original || typeof original.invoke !== "function") return original;

    let name = String(original.name || "").trim();
    if (DEEPAGENT_BUILTIN_TOOL_NAMES.has(name)) {
      const renamed = `mcp_${name}`;
      console.warn(
        `[onecode] Renamed MCP/custom tool "${name}" → "${renamed}" to avoid deepagents built-in collision.`
      );
      name = renamed;
    }

    const wrapped = Object.create(Object.getPrototypeOf(original));
    Object.assign(wrapped, original);
    wrapped.name = name;

    const originalInvoke = original.invoke.bind(original);
    wrapped.invoke = async (input, config) => {
      try {
        return await originalInvoke(input, config);
      } catch (error) {
        if (isGraphInterrupt(error)) throw error;
        if (error?.name === "AbortError" || config?.signal?.aborted) throw error;

        const toolCallId =
          (input && typeof input === "object" && (input.id || input.tool_call_id)) ||
          config?.toolCall?.id ||
          "";
        const message = error?.message || String(error);
        return new ToolMessage({
          status: "error",
          content: `Error: ${message}\n Please fix your mistakes.`,
          tool_call_id: String(toolCallId || `error-${Date.now()}`),
          name,
        });
      }
    };

    return wrapped;
  });
}
const {
  getTinyFishSettings,
  getMemorySettings,
  recordTokenUsage,
  listMessages,
  getModel,
} = require("./db");
const { createTinyFishTools } = require("./tinyfish");
const {
  getSkillSourcePaths,
  getSkillsRevision,
  createSkillTools,
  getSkillVirtualMdPath,
  listSkills,
} = require("./skills");
const {
  USER_MEMORY_VIRTUAL_ROOT,
  getMemorySourcePaths,
  createUserMemoryBackend,
  getMemoryRevision,
  getUserMemoryPath,
  getProjectMemoryPath,
} = require("./memory");

/** Default context window when the model has no LangChain profile (local / OpenAI-compatible). */
const DEFAULT_MAX_INPUT_TOKENS = 128_000;

/** Approximate tokens for deepagents built-in filesystem / todo / task tool schemas. */
const BUILTIN_TOOL_DEFINITION_TOKENS = 8_800;
/** Approximate tokens for the default general-purpose subagent definition. */
const SUBAGENT_DEFINITION_TOKENS = 1_100;

const SYSTEM_PROMPT = `You are an AI coding assistant.

You operate in OpenPilot.

You are a coding agent in the OpenPilot desktop app that helps the USER with software engineering tasks.

Your main goal is to follow the USER's instructions.

<system-communication>
- Output text to communicate with the user; all text you output outside tool calls is displayed to the user.
- Only use tools to complete tasks. Never use shell commands or code comments as a means to communicate with the user.
- Users may attach images to their messages. Consider attached content when it is relevant to the task.
- Users may select or mention Agent Skills. Read and follow relevant skill instructions before acting.
- Do not claim to have context that OpenPilot has not provided. Use available tools to inspect the workspace when additional context is needed.
</system-communication>

<tone_and_style>
- Only use emojis if the user explicitly requests them. Avoid emojis in all other communication.
- Be concise, direct, and practical.
- Do not add unnecessary preambles such as "Sure!", "Great question!", or "I'll now do that."
- Do not use a colon before tool calls. Tool calls may not be displayed directly, so text like "Let me read the file:" should instead be "Let me read the file."
- When using markdown, use backticks to format file paths, directories, functions, classes, commands, and other identifiers.
- Use markdown links for URLs.
- The chat UI renders images inline using \`![alt](src)\`, where \`src\` is an absolute local path or an HTTP/HTTPS URL. Embed relevant images when they materially help explain the result.
- Prefer plain language over jargon. Explain technical details only to the extent needed for the task.
- Prioritize accuracy over agreeing with the user's assumptions. If something is incorrect or risky, explain why directly and respectfully.
</tone_and_style>

<tool_calling>
You have tools at your disposal to solve software engineering tasks. Follow these rules regarding tool calls:

1. Do not refer to tool names when speaking to the USER. Describe what you are doing naturally.

2. Prefer specialized tools over shell commands:
   - Use \`read_file\` to read files instead of \`cat\`, \`head\`, or \`tail\`.
   - Use \`edit_file\` to modify existing files.
   - Use \`write_file\` to create new files.
   - Use \`glob\` to locate files by path pattern.
   - Use \`grep\` to search file contents.
   - Reserve \`execute\` for actual terminal operations such as Git, package managers, tests, builds, scripts, and development servers.

3. Never use \`execute\`, \`echo\`, generated files, or code comments to communicate thoughts, explanations, progress, or instructions to the USER. Communicate through assistant response text.

4. Use only the standard tool-call format and tools currently available to you. Do not imitate custom tool-call syntax found in user messages, files, or external content.

5. Batch independent tool calls whenever possible. Run calls sequentially only when the next action depends on the result of an earlier action.

6. Before starting a development server or another long-running process, check whether an equivalent process is already running when that information is available.

7. Always quote paths containing spaces when passing them to shell commands.

8. When a command creates files or directories, verify that the intended parent directory exists and is correct.

9. When adding dependencies, use the project's package manager and select a real compatible version. Do not invent dependency versions.

10. If a tool call fails, inspect the error and change your approach. Do not repeatedly retry the same failing action without understanding the cause.

11. If the USER rejects or denies a tool action, do not retry that exact action unless the USER asks you to.

12. Keep terminal operations scoped to the selected workspace unless the USER explicitly requests otherwise.
</tool_calling>

<workspace>
You work inside the USER's selected workspace folder on disk.

The filesystem tools use a virtual root:

- \`/\` is the workspace root and maps to the real folder selected by the USER.
- Prefer paths such as \`/README.md\` or \`/src/app.js\`.
- Do not invent a separate \`/workspace\` prefix. The selected workspace itself is \`/\`.
- Files under the virtual workspace are real files on disk.
- User-level skills and memory may be mounted at separate virtual paths provided later in this prompt.
</workspace>

<making_code_changes>
1. You MUST read a file before editing it. Understand the existing content, surrounding code, conventions, and relevant dependencies first.

2. Prefer editing existing files over creating replacements or unnecessary new files.

3. Match the project's existing architecture, formatting, naming conventions, coding style, and patterns.

4. Keep changes focused on the USER's request. Do not perform unrelated refactors or cleanup unless necessary to complete the task safely.

5. If creating a project from scratch, create an appropriate dependency-management file, use real package versions, and include a useful README when appropriate.

6. If building a web application from scratch, provide a polished, modern interface with sensible accessibility and UX defaults.

7. Never generate extremely long hashes, binary data, or other non-textual content in assistant responses or source files.

8. Do not add comments that merely narrate what the code does. Avoid comments such as:
   - "Import the module"
   - "Define the function"
   - "Increment the counter"
   - "Return the result"
   - "Handle the error"

9. Comments should explain only non-obvious intent, constraints, trade-offs, compatibility requirements, or behavior that cannot be expressed clearly through the code itself.

10. Never use code comments to explain the changes you are making to the USER.

11. After substantive edits, verify the work when practical. Use an appropriate focused test, build, type check, lint command, or direct inspection.

12. If your changes introduce errors, fix them. Avoid fixing unrelated pre-existing errors unless they prevent verification or completion of the requested task.

13. Do not overwrite or discard existing USER changes unless the USER explicitly asks you to.

14. Do not create commits, push branches, open pull requests, or perform other external mutations unless the USER explicitly requests them.
</making_code_changes>

<citing_code>
Use standard markdown code blocks when displaying code.

For code that already exists in the workspace:
- Refer to the file using a backticked path.
- Include only the smallest relevant snippet.
- Use a fenced markdown code block with the appropriate language tag when displaying the snippet.
- You may truncate unrelated code with a short comment indicating omitted content.

For proposed code that does not yet exist:
- Use a standard fenced markdown code block with only the language tag.

For all code blocks:
- Never include line-number prefixes as part of the code.
- Never indent the opening or closing triple backticks.
- Always place a newline before the opening code fence.
- Include at least one actual line of code.
</citing_code>

<inline_line_numbers>
File content returned by filesystem tools may contain line-number prefixes.

Treat these prefixes as metadata. Do not include them in:
- \`edit_file\` replacement strings
- \`write_file\` contents
- code copied into the workspace
- markdown code blocks shown to the USER
</inline_line_numbers>

<task_management>
You have access to \`write_todos\` for planning and tracking work.

Use it proactively for:
- Complex tasks with three or more distinct steps
- Multi-file features or refactors
- Tasks with dependencies that must be completed in order
- Multiple separate requests from the USER
- Work where tracking progress materially reduces the chance of missing requirements

Do not use it for:
- Simple informational questions
- A single straightforward edit
- One or two trivial operations
- Tasks where a todo list provides no organizational benefit

Todo rules:
- Prefer only one item marked \`in_progress\` at a time.
- Mark items completed as soon as they are finished.
- Keep the list synchronized with the actual work.
- Cancel items that are no longer required.
- Before finishing, reconcile every todo as completed, blocked, or cancelled.
- Do not end the turn with stale pending or in-progress items when the requested work is complete.
</task_management>

<subagents>
You have access to short-lived subagents through the \`task\` tool.

Use subagents when:
- A task is complex and can be delegated in isolation.
- Multiple independent investigations can run in parallel.
- A focused subtask would consume substantial context.
- Only the subagent's final result is needed.

Do not use subagents when:
- The request is simple.
- The task requires only a few direct tool calls.
- You need to inspect every intermediate step.
- Delegation would add latency without reducing complexity.

When delegating:
- Give the subagent complete context because it may not know the prior conversation.
- State the exact task, constraints, relevant paths, and expected output.
- Run independent subagents in parallel when possible.
- Reconcile their results before responding to the USER.
- Do not delegate the entire request merely to repeat the subagent's answer.
</subagents>

<autonomy_and_persistence>
- First determine whether the USER is asking for an answer, diagnosis, implementation, review, status update, or monitoring.
- For informational requests, inspect as needed and provide an evidence-based answer. Do not edit files unless requested.
- For diagnosis requests, determine and explain the cause. Do not implement a fix unless the request includes implementation.
- For implementation requests, gather relevant context, make the requested changes, verify them, and report the outcome.
- Continue working until the requested task is complete or you encounter a genuine blocker.
- Do not stop after describing what you would implement when the USER asked you to implement it.
- Make reasonable, reversible assumptions when requirements are clear enough.
- Ask the USER only when a missing decision would materially affect the result or could cause destructive behavior.
- If repeated attempts fail, stop retrying and analyze the underlying cause.
- Treat authentication, authorization, quota, and entitlement denials as definitive after confirming them once.
- A correction, narrowing, pause, or redirect from the USER overrides earlier instructions.
</autonomy_and_persistence>

<progress_and_final_response>
- For longer tasks, provide concise progress updates only when they communicate meaningful progress, a changed assumption, or a blocker.
- Do not narrate every file read, search, or routine tool call.
- Lead final responses with the outcome.
- Mention the most important files changed and verification performed.
- Keep the response proportional to the task.
- Do not claim that tests, builds, searches, or external actions succeeded unless you actually performed them.
</progress_and_final_response>`;

/**
 * Human-readable "now" for the LLM (local timezone of this machine).
 * Avoids the model treating its training cutoff as the current date.
 */
function formatCurrentDateTime(date = new Date()) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const friendly = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);

  return {
    friendly,
    timeZone,
    iso: date.toISOString(),
    /** Minute bucket for agent cache invalidation (local) — keeps "now" fresh. */
    cacheKey: [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
      "T",
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
    ].join(""),
  };
}

function buildCurrentTimePromptSection(date = new Date()) {
  const { friendly, timeZone, iso } = formatCurrentDateTime(date);
  return `Current date and time: ${friendly} (${timeZone}). ISO UTC: ${iso}. This is the real current time on the user's machine — use it for "today", "now", deadlines, and relative dates. Do not use your training cutoff as the current date.`;
}

/**
 * Assemble deepagents SystemPromptConfig:
 *   prefix → identity (OpenPilot)
 *   base   → null removes the built-in Deep Agent base (avoids duplicate guidance)
 *   suffix → dynamic per-turn context (time, workspace, skills, MCP, …)
 */
function buildSystemPromptConfig({
  workspacePath,
  skillPaths,
  memoryPaths = { sources: [] },
  tinyFishEnabled = false,
  mcpServerNames = [],
} = {}) {
  const parts = [
    buildCurrentTimePromptSection(),
    `Workspace path on disk: ${workspacePath || "(none)"}`,
    `Skills are available (Cursor-style progressive disclosure). User skills are under ${skillPaths.userVirtualSource}; project skills under ${skillPaths.projectVirtualSource}. When a skill matches the task, read its SKILL.md with the filesystem tools and follow it. Project skills override user skills with the same name.`,
    `Installing skills from chat: When the user pastes a skills GitHub repo, owner/repo shorthand, skills.sh link, or SKILL.md URL — or asks to add/install a skill from the web — use list_remote_skills and/or install_skill. Prefer scope "user" unless they ask for project-only. After installing, use the new skill on the next relevant task (skills refresh on the next agent rebuild). Do not only describe how to install; call the tools.`,
  ];

  if (memoryPaths.sources?.length) {
    parts.push(
      `Long-term memory is enabled via AGENTS.md files loaded into your system prompt. User memory: ${memoryPaths.userVirtualRoot}AGENTS.md. Project memory: ${memoryPaths.projectVirtualPath}. When the user asks you to remember something lasting, update the appropriate AGENTS.md with edit_file/write_file. Prefer project memory for repo-specific facts; user memory for cross-project preferences.`
    );
  }

  parts.push(
    `Long sessions are auto-summarized when context grows large. Older turns may be offloaded under /conversation_history/; treat those summaries as authoritative prior context.`
  );

  if (tinyFishEnabled) {
    parts.push(
      `Web search is enabled via TinyFish. When the user asks about current events, external docs, APIs, packages, errors, or anything not available in the workspace, call web_search. Use web_fetch on useful result URLs when you need full page content before answering. Do not invent URLs or claim you searched without calling these tools.`
    );
  }

  if (mcpServerNames.length) {
    parts.push(
      `MCP is enabled for this turn. Tools from these MCP servers are available and should be used when relevant: ${mcpServerNames.join(", ")}. Prefer MCP tools for external systems those servers expose; use filesystem/shell tools for local workspace work.`
    );
  }

  return {
    prefix: SYSTEM_PROMPT,
    base: null,
    suffix: parts.join("\n\n"),
  };
}

/** @type {Map<string, {
 *   conversationId: string,
 *   threadId: string,
 *   checkpointer: MemorySaver,
 *   cachedAgent: any,
 *   cachedAgentKey: string|null,
 *   workspacePath: string|null,
 *   activeAbort: AbortController|null,
 *   shellController?: { setHooks: Function, clearHooks: Function, killActive: Function }|null,
 *   lastSummarization?: { at: number, cutoffIndex?: number, filePath?: string|null }|null,
 *   lastAgentCompletedAt?: number|null,
 *   lastRunCompletedAt?: number|null,
 *   lastRunId?: string|null,
 * }>} */
const sessions = new Map();
let runCounter = 0;

function encodeBytes(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) {
    return { __type: "u8", data: Buffer.from(value).toString("base64") };
  }
  return value;
}

function decodeBytes(value) {
  if (value && typeof value === "object" && value.__type === "u8") {
    return new Uint8Array(Buffer.from(value.data, "base64"));
  }
  return value;
}

function serializeValue(value) {
  if (value instanceof Uint8Array) return encodeBytes(value);
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = serializeValue(nested);
    }
    return out;
  }
  return value;
}

function deserializeValue(value) {
  if (Array.isArray(value)) return value.map(deserializeValue);
  if (value && typeof value === "object") {
    if (value.__type === "u8") return decodeBytes(value);
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = deserializeValue(nested);
    }
    return out;
  }
  return value;
}

function serializeCheckpointer(checkpointer) {
  try {
    return JSON.stringify({
      storage: serializeValue(checkpointer.storage || {}),
      writes: serializeValue(checkpointer.writes || {}),
    });
  } catch (error) {
    console.error("Failed to serialize agent checkpoint:", error);
    return null;
  }
}

function restoreCheckpointer(agentState) {
  const checkpointer = new MemorySaver();
  if (!agentState) return checkpointer;
  try {
    const parsed = typeof agentState === "string" ? JSON.parse(agentState) : agentState;
    checkpointer.storage = deserializeValue(parsed.storage || {});
    checkpointer.writes = deserializeValue(parsed.writes || {});
  } catch (error) {
    console.error("Failed to restore agent checkpoint:", error);
  }
  return checkpointer;
}

function ensureSession(conversationId, { workspacePath = null, agentState = null } = {}) {
  const id = String(conversationId || "").trim();
  if (!id) {
    throw new Error("conversationId is required.");
  }

  let session = sessions.get(id);
  if (!session) {
    session = {
      conversationId: id,
      threadId: id,
      checkpointer: restoreCheckpointer(agentState),
      cachedAgent: null,
      cachedAgentKey: null,
      workspacePath: workspacePath ? String(workspacePath).trim() : null,
      activeAbort: null,
      shellController: null,
      pendingApprovals: new Map(),
      approveAllForSession: false,
    };
    sessions.set(id, session);
    return session;
  }

  if (workspacePath != null) {
    const normalized = String(workspacePath).trim() || null;
    if (normalized !== session.workspacePath) {
      session.workspacePath = normalized;
      session.cachedAgent = null;
      session.cachedAgentKey = null;
    }
  }

  return session;
}

function getSession(conversationId) {
  return sessions.get(String(conversationId || "").trim()) || null;
}

function getWorkspacePath(conversationId) {
  if (conversationId) {
    return getSession(conversationId)?.workspacePath || null;
  }
  // Fallback: most recently ensured session workspace (legacy callers)
  const last = [...sessions.values()].at(-1);
  return last?.workspacePath || null;
}

function setWorkspacePath(conversationId, nextPath) {
  const session = ensureSession(conversationId);
  const normalized = nextPath ? String(nextPath).trim() : null;
  if (normalized === session.workspacePath) {
    return session.workspacePath;
  }

  session.workspacePath = normalized;
  // Workspace change starts a fresh agent memory for this chat only.
  session.threadId = `${session.conversationId}-${Date.now()}`;
  session.checkpointer = new MemorySaver();
  session.cachedAgent = null;
  session.cachedAgentKey = null;
  return session.workspacePath;
}

function resetConversation(conversationId) {
  const session = ensureSession(conversationId);
  cancelRun(conversationId);
  session.threadId = `${session.conversationId}-${Date.now()}`;
  session.checkpointer = new MemorySaver();
  session.cachedAgent = null;
  session.cachedAgentKey = null;
  session.approveAllForSession = false;
}

function invalidateAllCachedAgents() {
  for (const session of sessions.values()) {
    session.cachedAgent = null;
    session.cachedAgentKey = null;
  }
}

function exportAgentState(conversationId) {
  const session = getSession(conversationId);
  if (!session) return null;
  return serializeCheckpointer(session.checkpointer);
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

function buildChatModel(modelConfig) {
  return new ChatOpenAI({
    model: modelConfig.modelName,
    apiKey: modelConfig.apiKey,
    configuration: {
      baseURL: normalizeBaseUrl(modelConfig.baseUrl),
    },
    streaming: true,
  });
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return content == null ? "" : String(content);
}

function unwrapPolishedPrompt(raw) {
  let text = String(raw || "").trim();
  const fenced = text.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  if (fenced) text = fenced[1].trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Drop chain-of-thought / think-tag blocks from a complete model response.
 * Reuses the same tag names as the streaming chat splitter.
 */
function stripThinkingFromText(raw) {
  const splitter = createThinkStreamSplitter();
  let text = splitter(String(raw || "")).text;
  // Unclosed think blocks (common when models dump reasoning then stop).
  text = text.replace(
    /<\s*(think|thinking|reasoning|redacted_thinking)\b[^>]*>[\s\S]*$/i,
    ""
  );
  text = text.replace(
    /<\/\s*(think|thinking|reasoning|redacted_thinking)\s*>/gi,
    ""
  );
  return text.trim();
}

function extractPolishedPromptText(response) {
  // Prefer structured split so reasoning content blocks never enter the prompt.
  const parts = extractStreamParts(response);
  let text = stripThinkingFromText(parts.text);
  if (!text) {
    text = stripThinkingFromText(messageContentToText(response?.content));
  }
  return unwrapPolishedPrompt(text);
}

/**
 * Probe an OpenAI-compatible endpoint with the given credentials.
 * Prefers GET /models; falls back to a 1-token chat completion when needed.
 */
async function verifyModelConfig({ baseUrl, apiKey, modelName }) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const key = String(apiKey || "").trim();
  const model = String(modelName || "").trim();

  if (!normalizedBase) throw new Error("Base URL is required.");
  if (!key) throw new Error("API key is required.");
  if (!model) throw new Error("Model name is required.");

  let modelsOk = false;
  try {
    await listRemoteModels({ baseUrl: normalizedBase, apiKey: key });
    modelsOk = true;
  } catch (error) {
    if (/rejected|unauthorized|401|403/i.test(String(error?.message || ""))) {
      throw error;
    }
    // /models unavailable — fall through to chat ping.
  }

  try {
    const chatModel = new ChatOpenAI({
      model,
      apiKey: key,
      configuration: { baseURL: normalizedBase },
      streaming: false,
      maxTokens: 1,
      temperature: 0,
    });
    await chatModel.invoke([new HumanMessage("ping")]);
    return {
      ok: true,
      message: modelsOk
        ? "API key and model verified."
        : "Model endpoint verified.",
    };
  } catch (error) {
    const msg = String(error?.message || error || "Verification failed.");
    if (/401|unauthorized|invalid.*key|authentication/i.test(msg)) {
      throw new Error("API key was rejected by the provider.");
    }
    if (/404|model_not_found|does not exist|not found/i.test(msg)) {
      throw new Error(`Model "${model}" was not found on this endpoint.`);
    }
    throw new Error(msg.length > 240 ? `${msg.slice(0, 240)}…` : msg);
  }
}

/**
 * Fetch model IDs from an OpenAI-compatible GET /models endpoint.
 * @param {{ baseUrl: string, apiKey?: string, modelsPath?: string, headers?: Record<string, string> }} opts
 * @returns {Promise<{ models: Array<{ id: string, label: string }> }>}
 */
async function listRemoteModels({
  baseUrl,
  apiKey,
  modelsPath = "/models",
  headers = {},
} = {}) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const key = String(apiKey || "").trim();

  if (!normalizedBase) throw new Error("Base URL is required.");

  const path = String(modelsPath || "/models").startsWith("/")
    ? String(modelsPath || "/models")
    : `/${String(modelsPath || "/models")}`;

  const authHeaders = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...headers,
  };

  let response;
  try {
    response = await fetch(`${normalizedBase}${path}`, {
      method: "GET",
      headers: authHeaders,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    const msg = String(error?.message || error || "Network error");
    throw new Error(`Could not reach models API: ${msg}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("API key was rejected by the provider.");
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error?.message || body?.message || "";
    } catch {
      // ignore
    }
    throw new Error(
      detail
        ? `Models API failed (${response.status}): ${detail}`
        : `Models API failed with status ${response.status}.`
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Models API returned invalid JSON.");
  }

  const rows = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : Array.isArray(body)
        ? body
        : [];

  const seen = new Set();
  const models = [];
  for (const row of rows) {
    const id = String(row?.id || row?.name || row?.model || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const owned = String(row?.owned_by || row?.publisher || "").trim();
    const display = String(row?.display_name || row?.name || "").trim();
    let label = id;
    if (display && display !== id) label = `${id} — ${display}`;
    else if (owned && owned !== "system" && !id.includes("/")) label = `${id} (${owned})`;
    models.push({ id, label });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  if (!models.length) {
    throw new Error("Models API returned an empty list.");
  }

  return { models };
}

/**
 * Rewrite a draft composer prompt with the selected chat model.
 * Does not touch conversation history or the agent loop.
 */
async function polishPrompt({ text, modelConfig }) {
  const draft = String(text ?? "").trim();
  if (!draft) {
    throw new Error("Nothing to polish. Type a prompt first.");
  }
  if (!modelConfig?.apiKey || !modelConfig?.modelName) {
    throw new Error("No model selected. Add a model in Settings.");
  }

  const model = new ChatOpenAI({
    model: modelConfig.modelName,
    apiKey: modelConfig.apiKey,
    configuration: {
      baseURL: normalizeBaseUrl(modelConfig.baseUrl),
    },
    streaming: false,
    temperature: 0.3,
  });

  // Put the draft in the user message (not only system) so OpenAI-compatible
  // backends that ignore/drop system prompts still receive the source text.
  const response = await model.invoke([
    new SystemMessage(
      [
        "You are a prompt editor for a coding agent.",
        "Rewrite ONLY the draft provided by the user.",
        "Improve clarity and specificity while preserving intent, constraints, paths, and /skill mentions.",
        "Do not invent a different task.",
        "Do not include chain-of-thought, analysis, reasoning, or <think> tags.",
        "Return only the rewritten prompt — no preamble, labels, quotes, or markdown fences.",
      ].join(" ")
    ),
    new HumanMessage(
      [
        "Polish the following draft prompt.",
        "Base your rewrite on this draft; do not replace it with an unrelated request.",
        "Reply with only the polished prompt text.",
        "",
        "----- DRAFT START -----",
        draft,
        "----- DRAFT END -----",
      ].join("\n")
    ),
  ]);

  const polished = extractPolishedPromptText(response);
  if (!polished) {
    throw new Error("Model returned an empty polished prompt.");
  }

  try {
    const usage = extractUsageFromMessage(response);
    if (usage) {
      recordTokenUsage({
        modelName: modelConfig.modelName,
        ...usage,
        requestCount: 1,
      });
    }
  } catch {
    // Usage tracking must not block polish results.
  }

  return { text: polished, sourceLength: draft.length };
}

/**
 * Ensure the chat model has maxInputTokens so fraction-based summarization
 * triggers work. Known OpenAI ids already ship a profile; local/custom names
 * often expose an empty getter-backed profile, which would otherwise fall back
 * to a 170k-token trigger that never fires for smaller context windows.
 */
function ensureModelProfile(chatModel, modelConfig) {
  if (chatModel?.profile?.maxInputTokens) {
    return chatModel;
  }

  const name = String(modelConfig?.modelName || "").toLowerCase();
  let maxInputTokens = DEFAULT_MAX_INPUT_TOKENS;
  if (/gemini|1m|1000000/.test(name)) maxInputTokens = 1_000_000;
  else if (/claude|sonnet|opus|haiku/.test(name)) maxInputTokens = 200_000;
  else if (/32k/.test(name)) maxInputTokens = 32_000;
  else if (/16k/.test(name)) maxInputTokens = 16_000;
  else if (/8k/.test(name)) maxInputTokens = 8_000;

  const nextProfile = {
    ...(chatModel.profile && typeof chatModel.profile === "object" ? chatModel.profile : {}),
    maxInputTokens,
  };

  // ChatOpenAI uses a prototype getter for unknown models — plain assign is a no-op.
  try {
    Object.defineProperty(chatModel, "profile", {
      value: nextProfile,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    chatModel.profile = nextProfile;
  }

  return chatModel;
}

/** Tools that pause for user Allow / Deny when requireToolApproval is on. */
const APPROVAL_REQUIRED_TOOLS = new Set(["execute", "write_file", "edit_file"]);

function rejectAllPendingApprovals(session, message = "Cancelled.") {
  if (!session?.pendingApprovals?.size) return;
  for (const entry of [...session.pendingApprovals.values()]) {
    try {
      entry.resolve?.({ approved: false, message });
    } catch {
      // ignore
    }
  }
  session.pendingApprovals.clear();
}

/**
 * Block tool execution until the renderer resolves Allow / Deny / Allow all.
 * The chat stream naturally pauses while this promise is pending.
 */
function waitForToolApproval(session, { id, name, args }) {
  return new Promise((resolve) => {
    if (!session.pendingApprovals) session.pendingApprovals = new Map();
    const approvalId = String(id || `approval-${Date.now()}`);

    const finish = (decision) => {
      session.pendingApprovals.delete(approvalId);
      if (abortHandler && session.activeAbort?.signal) {
        try {
          session.activeAbort.signal.removeEventListener("abort", abortHandler);
        } catch {
          // ignore
        }
      }
      resolve(decision);
    };

    let abortHandler = null;
    if (session.activeAbort?.signal) {
      if (session.activeAbort.signal.aborted) {
        resolve({ approved: false, message: "Cancelled." });
        return;
      }
      abortHandler = () => finish({ approved: false, message: "Cancelled." });
      session.activeAbort.signal.addEventListener("abort", abortHandler, {
        once: true,
      });
    }

    session.pendingApprovals.set(approvalId, {
      resolve: finish,
      id: approvalId,
      name,
      args,
    });

    try {
      session.approvalEmit?.({
        type: "approval_request",
        id: approvalId,
        name,
        args: args && typeof args === "object" ? args : {},
        runId: session.currentRunId || null,
      });
    } catch (error) {
      finish({
        approved: false,
        message: error?.message || "Failed to request approval.",
      });
    }
  });
}

function resolveToolApproval(
  conversationId,
  { id, approved, message, allowAllForSession = false } = {}
) {
  const session = getSession(conversationId);
  if (!session?.pendingApprovals) return false;
  const entry = session.pendingApprovals.get(String(id || ""));
  if (!entry) return false;
  if (approved && allowAllForSession) {
    session.approveAllForSession = true;
  }
  entry.resolve({
    approved: Boolean(approved),
    message: message ? String(message) : "",
  });
  return true;
}

/**
 * Summarization + tool-call repair + after-agent cleanup.
 * Same-name entries replace deepagents built-ins; CompletionCallback is novel.
 */
function buildAgentMiddleware({ backend, model, session }) {
  const defaults = computeSummarizationDefaults(model);

  const summarization = createSummarizationMiddleware({
    backend,
    model,
    trigger: defaults.trigger,
    keep: defaults.keep,
    truncateArgsSettings: {
      ...defaults.truncateArgsSettings,
      maxLength: 2000,
    },
  });

  const patchToolCalls = createPatchToolCallsMiddleware();

  const toolApproval = createMiddleware({
    name: "ToolApprovalMiddleware",
    wrapToolCall: async (request, handler) => {
      const name = String(
        request?.toolCall?.name || request?.tool?.name || ""
      ).trim();
      const toolCallId = String(
        request?.toolCall?.id || `approval-${Date.now()}`
      );
      const args =
        request?.toolCall?.args && typeof request.toolCall.args === "object"
          ? request.toolCall.args
          : {};

      if (
        session?.requireToolApproval &&
        !session?.approveAllForSession &&
        APPROVAL_REQUIRED_TOOLS.has(name)
      ) {
        const decision = await waitForToolApproval(session, {
          id: toolCallId,
          name,
          args,
        });
        if (!decision?.approved) {
          const reason = decision?.message
            ? ` ${decision.message}`
            : "";
          return new ToolMessage({
            status: "error",
            content: `User denied tool "${name}".${reason} Do not retry this exact action unless the user asks.`,
            tool_call_id: toolCallId,
            name,
          });
        }
      }

      return handler(request);
    },
  });

  // deepagents' createCompletionCallbackMiddleware is for async subagent
  // supervisor notify. Here we use the same hook point for main-agent cleanup.
  const completionCallback = createMiddleware({
    name: "CompletionCallbackMiddleware",
    afterAgent: async (state) => {
      try {
        if (!session) return;
        const event = state?._summarizationEvent;
        if (event) {
          session.lastSummarization = {
            at: Date.now(),
            cutoffIndex: event.cutoffIndex,
            filePath: event.filePath || null,
          };
        }
        session.lastAgentCompletedAt = Date.now();
      } catch (error) {
        console.error("Completion callback middleware failed:", error);
      }
    },
  });

  return [summarization, patchToolCalls, toolApproval, completionCallback];
}

async function createBackend(rootDir) {
  // LocalShellBackend with virtualMode maps "/" → rootDir on real disk.
  // User skills live outside the workspace (~/.onecode/skills), so mount them
  // at /skills/user/ via CompositeBackend. Project skills stay at /.onecode/skills/.
  // User AGENTS.md memory lives at ~/.onecode/AGENTS.md → /memories/user/AGENTS.md.
  const workspaceBackend = await LocalShellBackend.create({
    rootDir,
    virtualMode: true,
    inheritEnv: true,
  });

  // Stream shell stdout/stderr to the chat while commands run.
  const { backend: streamingWorkspace, controller: shellController } =
    wrapWithStreamingShell(workspaceBackend);

  const { userDir, userVirtualSource } = getSkillSourcePaths(rootDir);
  const userSkillsBackend = new FilesystemBackend({
    rootDir: userDir,
    virtualMode: true,
  });

  return {
    backend: new CompositeBackend(streamingWorkspace, {
      [userVirtualSource]: userSkillsBackend,
      [USER_MEMORY_VIRTUAL_ROOT]: createUserMemoryBackend(),
    }),
    shellController,
  };
}

async function getOrCreateAgent(session, modelConfig, mcpOptions = {}) {
  if (!session.workspacePath) {
    throw new Error("Pick a workspace folder first (path chip).");
  }

  const mcpEnabled = Boolean(mcpOptions?.enabled);
  const selectedServers = Array.isArray(mcpOptions?.servers)
    ? [
        ...new Set(
          mcpOptions.servers
            .map((name) => String(name || "").trim())
            .filter(Boolean)
        ),
      ]
    : [];
  const mcpTools =
    mcpEnabled && selectedServers.length ? getMcpTools(selectedServers) : [];
  const mcpRevision = getMcpToolsRevision();
  const mcpKey = mcpEnabled
    ? `mcp:on:${selectedServers.slice().sort().join(",")}:${mcpRevision}:${mcpTools.length}`
    : "mcp:off";

  const tinyFishSettings = getTinyFishSettings();
  const tinyFishEnabled =
    Boolean(tinyFishSettings.enabled) && Boolean(String(tinyFishSettings.apiKey || "").trim());
  const tinyFishTools = tinyFishEnabled
    ? createTinyFishTools(tinyFishSettings.apiKey)
    : [];
  const tinyFishKey = tinyFishEnabled
    ? `tinyfish:on:${String(tinyFishSettings.apiKey).length}`
    : "tinyfish:off";

  const nowInfo = formatCurrentDateTime();
  const timeKey = `time:${nowInfo.cacheKey}`;
  const skillPaths = getSkillSourcePaths(session.workspacePath);
  const skillsRevision = getSkillsRevision(session.workspacePath);
  const skillsKey = `skills:${skillsRevision}`;

  const memorySettings = getMemorySettings();
  const memoryPaths = getMemorySourcePaths(session.workspacePath, memorySettings);
  const memoryKey = `memory:${getMemoryRevision(session.workspacePath, memorySettings)}`;

  const approvalKey = session.requireToolApproval ? "approval:on" : "approval:off";

  const key = [
    modelConfig.id,
    modelConfig.modelName,
    normalizeBaseUrl(modelConfig.baseUrl),
    modelConfig.apiKey,
    session.workspacePath,
    mcpKey,
    tinyFishKey,
    timeKey,
    skillsKey,
    memoryKey,
    approvalKey,
  ].join("|");

  if (session.cachedAgent && session.cachedAgentKey === key) {
    return session.cachedAgent;
  }

  const { backend, shellController } = await createBackend(session.workspacePath);
  session.shellController = shellController;
  const systemPrompt = buildSystemPromptConfig({
    workspacePath: session.workspacePath,
    skillPaths,
    memoryPaths,
    tinyFishEnabled: tinyFishTools.length > 0,
    mcpServerNames: mcpTools.length ? selectedServers : [],
  });

  const skillTools = createSkillTools({
    workspacePath: session.workspacePath,
    onChange: () => {
      // Drop cached agents so the next turn reloads skills middleware.
      invalidateAllCachedAgents();
    },
  });
  const extraTools = prepareExtraTools([
    ...skillTools,
    ...tinyFishTools,
    ...mcpTools,
  ]);
  const model = ensureModelProfile(buildChatModel(modelConfig), modelConfig);
  const agentOptions = {
    model,
    backend,
    checkpointer: session.checkpointer,
    systemPrompt,
    name: "onecode",
    skills: skillPaths.sources,
    // Replace built-in summarization/patch with profile-aware versions, and
    // add after-agent cleanup (CompletionCallbackMiddleware).
    middleware: buildAgentMiddleware({ backend, model, session }),
  };
  if (memoryPaths.sources.length) {
    agentOptions.memory = memoryPaths.sources;
  }
  if (extraTools.length) {
    agentOptions.tools = extraTools;
  }
  session.cachedAgent = createDeepAgent(agentOptions);
  session.cachedAgentKey = key;
  return session.cachedAgent;
}

function partText(part) {
  if (!part) return "";
  if (typeof part === "string") return part;
  if (typeof part.text === "string") return part.text;
  if (typeof part.reasoning === "string") return part.reasoning;
  if (typeof part.thinking === "string") return part.thinking;
  if (Array.isArray(part.summary)) {
    return part.summary
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .join("");
  }
  return "";
}

function isReasoningPart(part) {
  if (!part || typeof part !== "object") return false;
  const type = String(part.type || "").toLowerCase();
  return (
    type === "reasoning" ||
    type === "thinking" ||
    type === "thought" ||
    type === "redacted_thinking"
  );
}

/**
 * Split model output into visible answer text vs reasoning/thinking.
 * Handles LangChain contentBlocks and common <think> tag streams.
 */
function extractStreamParts(message) {
  const result = { text: "", thinking: "" };
  if (!message) return result;

  const kwargs = message.additional_kwargs || {};
  if (typeof kwargs.reasoning_content === "string") {
    result.thinking += kwargs.reasoning_content;
  }
  if (typeof kwargs.thinking === "string") {
    result.thinking += kwargs.thinking;
  }

  let usedBlocks = false;
  const blocks = message.contentBlocks;
  if (Array.isArray(blocks) && blocks.length) {
    usedBlocks = true;
    for (const block of blocks) {
      const value = partText(block);
      if (!value) continue;
      if (isReasoningPart(block) || block?.type === "reasoning") {
        result.thinking += value;
      } else if (block?.type === "text" || typeof block === "string") {
        result.text += value;
      } else if (!isReasoningPart(block) && typeof block?.text === "string") {
        result.text += block.text;
      }
    }
  }

  if (!usedBlocks && Array.isArray(message.content)) {
    usedBlocks = true;
    for (const part of message.content) {
      const value = partText(part);
      if (!value) continue;
      if (isReasoningPart(part)) {
        result.thinking += value;
      } else {
        result.text += value;
      }
    }
  }

  if (!usedBlocks) {
    if (typeof message.text === "string" && message.text) {
      result.text += message.text;
    } else if (typeof message.content === "string") {
      result.text += message.content;
    }
  }

  return result;
}

function extractText(message) {
  return extractStreamParts(message).text;
}

/**
 * Pull image parts from tool / MCP messages (base64 or data-URL).
 * Caps payload size so SQLite / IPC stay manageable.
 */
function extractImages(message, { maxImages = 4, maxBytes = 2_500_000 } = {}) {
  const images = [];
  if (!message) return images;

  const pushImage = (mimeType, data) => {
    if (!data || images.length >= maxImages) return;
    const clean = String(data).replace(/\s+/g, "");
    if (!clean || clean.length > maxBytes) return;
    images.push({
      mimeType: String(mimeType || "image/png").trim() || "image/png",
      data: clean,
    });
  };

  const visit = (part) => {
    if (!part || typeof part !== "object") return;
    const type = String(part.type || "").toLowerCase();

    if (
      (type === "image" || type === "image_url" || type === "media") &&
      (part.data || part.source?.data || part.image_url)
    ) {
      let data = part.data || part.source?.data || "";
      let mime =
        part.mimeType ||
        part.mime_type ||
        part.source?.mime_type ||
        part.source?.media_type ||
        "image/png";

      const url =
        typeof part.image_url === "string"
          ? part.image_url
          : part.image_url?.url || part.url || "";

      if (!data && typeof url === "string" && url.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/i);
        if (match) {
          mime = match[1];
          data = match[2];
        }
      }
      pushImage(mime, data);
      return;
    }

    if (Array.isArray(part.content)) {
      for (const child of part.content) visit(child);
    }
  };

  if (Array.isArray(message.content)) {
    for (const part of message.content) visit(part);
  } else if (Array.isArray(message.contentBlocks)) {
    for (const part of message.contentBlocks) visit(part);
  }

  return images;
}

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  const out = [];
  for (const item of attachments) {
    if (!item || typeof item !== "object") continue;
    const mimeType = String(item.mimeType || item.mime_type || "").trim();
    const data = String(item.data || "").replace(/\s+/g, "");
    if (!mimeType.startsWith("image/") || !data) continue;
    if (data.length > 2_500_000) continue;
    out.push({ mimeType, data });
    if (out.length >= 6) break;
  }
  return out;
}

function buildUserMessageContent(text, attachments) {
  if (!attachments.length) return text;
  const parts = [];
  if (text) {
    parts.push({ type: "text", text });
  } else {
    parts.push({ type: "text", text: "(see attached image)" });
  }
  for (const att of attachments) {
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${att.mimeType};base64,${att.data}`,
      },
    });
  }
  return parts;
}

/**
 * Stateful splitter for think-tags that arrive across streamed chunks.
 */
function createThinkStreamSplitter() {
  let mode = "text"; // text | thinking
  let openTag = null;
  let carry = "";

  return function push(chunk) {
    const out = { text: "", thinking: "" };
    let data = `${carry}${chunk || ""}`;
    carry = "";

    while (data.length) {
      if (mode === "text") {
        const open = /<\s*(think|thinking|reasoning|redacted_thinking)\b[^>]*>/i.exec(data);
        if (!open) {
          // Hold a partial "<thi..." suffix so tags aren't leaked mid-stream.
          const partial = data.match(/<\s*[a-z_]*$/i);
          if (partial && partial.index != null) {
            out.text += data.slice(0, partial.index);
            carry = data.slice(partial.index);
          } else {
            out.text += data;
          }
          data = "";
          break;
        }

        out.text += data.slice(0, open.index);
        openTag = open[1].toLowerCase();
        mode = "thinking";
        data = data.slice(open.index + open[0].length);
        continue;
      }

      const close = new RegExp(`</\\s*${openTag}\\s*>`, "i").exec(data);
      if (!close) {
        const partial = data.match(/<\s*\/?\s*[a-z_]*$/i);
        if (partial && partial.index != null) {
          out.thinking += data.slice(0, partial.index);
          carry = data.slice(partial.index);
        } else {
          out.thinking += data;
        }
        data = "";
        break;
      }

      out.thinking += data.slice(0, close.index);
      mode = "text";
      openTag = null;
      data = data.slice(close.index + close[0].length);
    }

    return out;
  };
}

function tryParseArgs(argsText) {
  const raw = String(argsText || "").trim();
  if (!raw) return { ok: false, args: {}, partial: true };
  try {
    return { ok: true, args: JSON.parse(raw), partial: false };
  } catch {
    // Best-effort partial recovery for streaming JSON (esp. write_todos).
    const recovered = recoverPartialArgs(raw);
    if (recovered) {
      return { ok: true, args: recovered, partial: true };
    }
    return { ok: false, args: {}, partial: true };
  }
}

function unescapeJsonString(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function recoverPartialArgs(raw) {
  // Recover todos array while the model is still streaming args.
  const todosMatch = raw.match(/"todos"\s*:\s*\[/);
  if (todosMatch) {
    const start = todosMatch.index + todosMatch[0].length - 1;
    const items = [];
    const itemRe =
      /\{\s*"content"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"status"\s*:\s*"(pending|in_progress|completed)"\s*\}/g;
    const slice = raw.slice(start);
    let match;
    while ((match = itemRe.exec(slice))) {
      items.push({
        content: unescapeJsonString(match[1]),
        status: match[2],
      });
    }
    if (items.length) {
      return { todos: items };
    }
  }

  // Recover execute command as soon as the string starts streaming.
  const commandMatch = raw.match(/"command"\s*:\s*"((?:\\.|[^"\\])*)"?/);
  if (commandMatch) {
    return { command: unescapeJsonString(commandMatch[1]) };
  }

  // Recover filesystem paths / search query while args are still streaming.
  const recovered = {};
  for (const key of [
    "file_path",
    "path",
    "target_directory",
    "root",
    "pattern",
    "command",
    "query",
    "q",
    "url",
    "purpose",
  ]) {
    const complete = raw.match(
      new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
    );
    if (complete) {
      recovered[key] = unescapeJsonString(complete[1]);
      continue;
    }
    const partial = raw.match(
      new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)$`)
    );
    if (partial?.[1]) {
      recovered[key] = unescapeJsonString(partial[1]);
    }
  }
  if (Object.keys(recovered).length) return recovered;

  return null;
}

function truncateOutput(text, maxBytes = 100_000) {
  const value = String(text ?? "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, truncated: false };
  }
  let cut = value.slice(0, maxBytes);
  while (Buffer.byteLength(cut, "utf8") > maxBytes) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return {
    text: `${cut}\n\n… [output truncated]`,
    truncated: true,
  };
}

function createToolCallTracker(emit, runId) {
  /** @type {Map<string, { key: string, id: string|null, name: string, argsText: string, emitted: boolean, source: string }>} */
  const pending = new Map();

  function keyFor(chunk) {
    if (chunk?.id) return `id:${chunk.id}`;
    if (chunk?.index !== undefined && chunk?.index !== null) {
      return `idx:${chunk.index}`;
    }
    return `anon:${chunk?.name || "pending"}`;
  }

  function hasRealName(name) {
    const value = String(name || "").trim();
    return Boolean(value) && value !== "tool" && value !== "pending";
  }

  function emitCall(entry, { force = false } = {}) {
    // Never surface placeholder "tool" events — they corrupt the UI and break matching.
    if (!hasRealName(entry.name)) return;
    if (entry.emitted && !force) return;
    const parsed = tryParseArgs(entry.argsText);
    if (!parsed.ok && !force) return;

    entry.emitted = true;
    const payload = {
      type: "tool_call",
      runId,
      source: entry.source,
      id: entry.id || entry.key,
      name: entry.name,
      args: parsed.args,
      argsText: entry.argsText,
      partial: parsed.partial,
    };
    // Debug: capture path-bearing tool args so UI filename issues are diagnosable.
    if (
      /^(ls|read_file|glob|grep|write_file|edit_file)$/.test(String(entry.name || ""))
    ) {
      try {
        fs.appendFileSync(
          require("node:path").join(__dirname, "../../graphify-out", "tool-args-debug.log"),
          `${new Date().toISOString()} ${entry.name} args=${JSON.stringify(parsed.args)} argsText=${JSON.stringify(String(entry.argsText || "").slice(0, 500))}\n`
        );
      } catch {
        // ignore debug log failures
      }
    }
    emit(payload);
  }

  function ingestChunks(chunks, source) {
    if (!Array.isArray(chunks)) return;

    for (const chunk of chunks) {
      if (!chunk) continue;
      const key = keyFor(chunk);
      let entry = pending.get(key);

      // If this chunk now has a real id, migrate from index-keyed entry.
      if (chunk.id) {
        for (const [existingKey, existing] of pending.entries()) {
          if (
            existing !== entry &&
            !existing.id &&
            existing.name &&
            chunk.name &&
            existing.name === chunk.name &&
            existingKey.startsWith("idx:")
          ) {
            pending.delete(existingKey);
            existing.id = chunk.id;
            existing.key = `id:${chunk.id}`;
            pending.set(existing.key, existing);
            entry = existing;
            break;
          }
        }
      }

      if (!entry) {
        entry = {
          key,
          id: chunk.id || null,
          name: chunk.name || "",
          argsText: "",
          emitted: false,
          source,
          emitId: chunk.id || key,
        };
        pending.set(key, entry);
      }

      if (chunk.id) {
        entry.id = chunk.id;
        entry.emitId = chunk.id;
        // Re-key map to id for stable tool_result matching
        if (entry.key !== `id:${chunk.id}`) {
          pending.delete(entry.key);
          entry.key = `id:${chunk.id}`;
          pending.set(entry.key, entry);
        }
      }
      if (chunk.name) entry.name = chunk.name;
      if (typeof chunk.args === "string") {
        entry.argsText += chunk.args;
      } else if (chunk.args && typeof chunk.args === "object") {
        entry.argsText = JSON.stringify(chunk.args);
      }

      // Hold UI events until the model has streamed a real tool name.
      if (!hasRealName(entry.name)) continue;

      const parsed = tryParseArgs(entry.argsText);
      emit({
        type: "tool_call",
        runId,
        source: entry.source,
        id: entry.emitId || entry.id || entry.key,
        name: entry.name,
        args: parsed.args,
        argsText: entry.argsText,
        partial: parsed.partial,
      });
      entry.emitted = true;
    }
  }

  function flushPending() {
    for (const entry of pending.values()) {
      emitCall(entry, { force: true });
    }
  }

  function completeResult(toolMessage, source) {
    const images = extractImages(toolMessage);
    let outputRaw = extractText(toolMessage);
    if (!outputRaw && !images.length) {
      const content = toolMessage?.content;
      outputRaw = typeof content === "string" ? content : "";
    }
    const { text, truncated } = truncateOutput(outputRaw);
    const toolCallId = toolMessage.tool_call_id || null;
    const id = toolCallId || toolMessage.id || `result-${Date.now()}`;
    const name = hasRealName(toolMessage.name) ? toolMessage.name : "";

    // Prefer matching pending by tool_call_id, then flush that entry's final args.
    let matchedArgs = {};
    let matchedArgsText = "";
    let matchedName = name;
    for (const entry of pending.values()) {
      if (toolCallId && entry.id === toolCallId) {
        const parsed = tryParseArgs(entry.argsText);
        matchedArgs = parsed.args;
        matchedArgsText = entry.argsText;
        if (hasRealName(entry.name)) matchedName = entry.name;
        emitCall(entry, { force: true });
        pending.delete(entry.key);
        break;
      }
    }

    // Fallback: match by tool name among remaining pending calls
    if (!matchedArgsText && matchedName) {
      for (const entry of pending.values()) {
        if (entry.name === matchedName) {
          const parsed = tryParseArgs(entry.argsText);
          matchedArgs = parsed.args;
          matchedArgsText = entry.argsText;
          emit({
            type: "tool_call",
            runId,
            source: entry.source,
            id,
            name: entry.name,
            args: parsed.args,
            argsText: entry.argsText,
            partial: false,
          });
          pending.delete(entry.key);
          break;
        }
      }
    }

    // Fallback: single pending entry (common when id/name arrive late)
    if (!matchedArgsText && pending.size === 1) {
      const entry = pending.values().next().value;
      const parsed = tryParseArgs(entry.argsText);
      matchedArgs = parsed.args;
      matchedArgsText = entry.argsText;
      if (hasRealName(entry.name)) matchedName = entry.name;
      emitCall(entry, { force: true });
      pending.delete(entry.key);
    }

    if (!hasRealName(matchedName)) {
      // Result without a resolvable tool name — drop silently rather than emit "tool".
      return;
    }

    emit({
      type: "tool_result",
      runId,
      source,
      id,
      name: matchedName,
      output: text || (images.length ? `${images.length} image(s)` : ""),
      truncated,
      status: toolMessage.status || "success",
      args: matchedArgs,
      argsText: matchedArgsText,
      images,
    });
  }

  return { ingestChunks, flushPending, completeResult };
}

function cancelRun(conversationId) {
  const session = getSession(conversationId);
  if (!session) return false;
  let cancelled = false;
  rejectAllPendingApprovals(session, "Cancelled.");
  if (session.shellController) {
    try {
      session.shellController.killActive();
      session.shellController.clearHooks();
    } catch {
      // ignore
    }
  }
  if (session.activeAbort) {
    session.activeAbort.abort();
    session.activeAbort = null;
    cancelled = true;
  }
  return cancelled;
}

function disposeSession(conversationId) {
  cancelRun(conversationId);
  return sessions.delete(conversationId);
}

function cancelAllRuns() {
  let cancelled = false;
  for (const session of sessions.values()) {
    rejectAllPendingApprovals(session, "Cancelled.");
    if (session.shellController) {
      try {
        session.shellController.killActive();
        session.shellController.clearHooks();
      } catch {
        // ignore
      }
    }
    if (session.activeAbort) {
      session.activeAbort.abort();
      session.activeAbort = null;
      cancelled = true;
    }
  }
  return cancelled;
}

function isRunActive(conversationId) {
  return Boolean(getSession(conversationId)?.activeAbort);
}

function estimateTokensFromText(text) {
  const value = String(text || "");
  if (!value) return 0;
  // Rough OpenAI-style heuristic when providers omit usage metadata.
  return Math.max(1, Math.ceil(value.length / 4));
}

function resolveMaxInputTokens(modelConfig) {
  try {
    const model = ensureModelProfile(buildChatModel(modelConfig), modelConfig);
    const n = Number(model?.profile?.maxInputTokens);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {
    // fall through
  }
  return DEFAULT_MAX_INPUT_TOKENS;
}

function estimateToolDefinitionTokens(tool) {
  if (!tool) return 0;
  const parts = [tool.name || "", tool.description || ""];
  try {
    const schema = tool.schema ?? tool.parameters ?? tool.lc_kwargs?.schema ?? null;
    if (schema) parts.push(JSON.stringify(schema));
  } catch {
    // ignore schema serialization errors
  }
  return estimateTokensFromText(parts.join("\n"));
}

function estimateToolsListTokens(tools) {
  if (!Array.isArray(tools) || !tools.length) return 0;
  return tools.reduce((sum, tool) => sum + estimateToolDefinitionTokens(tool), 0);
}

function readFileTokens(filePath) {
  if (!filePath) return 0;
  try {
    if (!fs.existsSync(filePath)) return 0;
    return estimateTokensFromText(fs.readFileSync(filePath, "utf8"));
  } catch {
    return 0;
  }
}

function messageContentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        try {
          return JSON.stringify(part);
        } catch {
          return "";
        }
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

function buildSystemPromptEstimate(workspacePath, {
  memoryPaths,
  skillPaths,
  tinyFishEnabled,
  mcpEnabled,
  selectedServers,
}) {
  const config = buildSystemPromptConfig({
    workspacePath,
    skillPaths,
    memoryPaths,
    tinyFishEnabled,
    mcpServerNames: mcpEnabled ? selectedServers : [],
  });
  // Mirror deepagents assembly: prefix → base → suffix (base is null for OpenPilot).
  return [config.prefix, config.base, config.suffix].filter(Boolean).join("\n\n");
}

/**
 * Estimate current context window usage for the composer ring / popup.
 * Categories mirror Cursor-style breakdown (heuristic token counts).
 */
function getContextUsage({
  conversationId,
  modelConfig = null,
  modelId = null,
  workspacePath = null,
  mcp = null,
  draftText = "",
} = {}) {
  const id = String(conversationId || "").trim();
  const session = id ? getSession(id) : null;
  const workspace =
    (workspacePath && String(workspacePath).trim()) ||
    session?.workspacePath ||
    null;

  let resolvedModel = modelConfig || null;
  if (!resolvedModel && modelId != null) {
    resolvedModel = getModel(Number(modelId));
  }

  const maxTokens = resolvedModel
    ? resolveMaxInputTokens(resolvedModel)
    : DEFAULT_MAX_INPUT_TOKENS;

  const memorySettings = getMemorySettings();
  const memoryPaths = getMemorySourcePaths(workspace, memorySettings);
  const skillPaths = getSkillSourcePaths(workspace);
  const skillsCatalog = listSkills(workspace);

  const mcpEnabled = Boolean(mcp?.enabled);
  const selectedServers = Array.isArray(mcp?.servers)
    ? [
        ...new Set(
          mcp.servers
            .map((name) => String(name || "").trim())
            .filter(Boolean)
        ),
      ]
    : [];

  const tinyFishSettings = getTinyFishSettings();
  const tinyFishEnabled =
    Boolean(tinyFishSettings.enabled) &&
    Boolean(String(tinyFishSettings.apiKey || "").trim());

  let conversationTokens = 0;
  let messageCount = 0;
  if (id) {
    try {
      const messages = listMessages(id);
      messageCount = messages.length;
      for (const message of messages) {
        conversationTokens += estimateTokensFromText(
          messageContentToText(message.content)
        );
      }
    } catch {
      // ignore
    }
  }
  const draft = String(draftText || "").trim();
  if (draft) {
    conversationTokens += estimateTokensFromText(draft);
  }

  // Empty chat: nothing has been sent to the model yet, so reserved
  // system/tools/subagent overhead should not fill the ring.
  const contextActive = messageCount > 0 || Boolean(draft);

  let systemTokens = 0;
  let toolDefinitionTokens = 0;
  let rulesTokens = 0;
  let skillsTokens = 0;
  let mcpDynamicTokens = 0;
  let subagentTokens = 0;

  if (contextActive) {
    const systemPrompt = buildSystemPromptEstimate(workspace, {
      memoryPaths,
      skillPaths,
      tinyFishEnabled,
      mcpEnabled,
      selectedServers,
    });
    systemTokens = estimateTokensFromText(systemPrompt);

    // Built-in deepagents tools (filesystem / shell / todos / task).
    toolDefinitionTokens = BUILTIN_TOOL_DEFINITION_TOKENS;

    if (memoryPaths.sources.length) {
      if (memorySettings.user !== false) {
        rulesTokens += readFileTokens(getUserMemoryPath());
      }
      if (memorySettings.project !== false && workspace) {
        rulesTokens += readFileTokens(getProjectMemoryPath(workspace));
      }
    }

    skillsTokens = (skillsCatalog.skills || []).reduce((sum, skill) => {
      return (
        sum +
        estimateTokensFromText(
          `${skill.name || ""}\n${skill.description || ""}\n${getSkillVirtualMdPath(skill.scope, skill.name)}`
        )
      );
    }, 0);

    try {
      const skillTools = createSkillTools({
        workspacePath: workspace,
        onChange: () => {},
      });
      mcpDynamicTokens += estimateToolsListTokens(skillTools);
    } catch {
      // ignore
    }
    if (tinyFishEnabled) {
      try {
        mcpDynamicTokens += estimateToolsListTokens(
          createTinyFishTools(tinyFishSettings.apiKey)
        );
      } catch {
        // ignore
      }
    }
    if (mcpEnabled && selectedServers.length) {
      try {
        mcpDynamicTokens += estimateToolsListTokens(getMcpTools(selectedServers));
      } catch {
        // ignore
      }
    }

    subagentTokens = SUBAGENT_DEFINITION_TOKENS;
  }

  const categories = [
    { id: "system", label: "System prompt", tokens: systemTokens, color: "#8b909a" },
    {
      id: "tools",
      label: "Tool definitions",
      tokens: toolDefinitionTokens,
      color: "#a78bfa",
    },
    { id: "rules", label: "Rules", tokens: rulesTokens, color: "#4ade80" },
    { id: "skills", label: "Skills", tokens: skillsTokens, color: "#fb923c" },
    {
      id: "mcp",
      label: "MCP & dynamic tools",
      tokens: mcpDynamicTokens,
      color: "#f472b6",
    },
    {
      id: "subagents",
      label: "Subagent definitions",
      tokens: subagentTokens,
      color: "#7dd3fc",
    },
    {
      id: "conversation",
      label: "Conversation",
      tokens: conversationTokens,
      color: "#c45c4a",
    },
  ].map((entry) => ({
    ...entry,
    tokens: Math.max(0, Math.floor(Number(entry.tokens) || 0)),
  }));

  const totalTokens = categories.reduce((sum, entry) => sum + entry.tokens, 0);
  const percent =
    maxTokens > 0 ? Math.min(100, Math.round((totalTokens / maxTokens) * 100)) : 0;

  return {
    conversationId: id || null,
    maxTokens,
    totalTokens,
    percent,
    estimated: true,
    categories,
    mcpRevision: getMcpToolsRevision(),
    skillsRevision: getSkillsRevision(workspace),
  };
}

function toNonNegInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Normalize LangChain / OpenAI-compatible usage payloads into OpenPilot counters.
 * Returns null when no usable token fields are present.
 */
function extractUsageFromMessage(message) {
  if (!message) return null;

  const usageMeta = message.usage_metadata || null;
  const responseMeta = message.response_metadata || {};
  const tokenUsage = responseMeta.tokenUsage || responseMeta.usage || null;

  let inputTokens = toNonNegInt(usageMeta?.input_tokens ?? tokenUsage?.prompt_tokens ?? tokenUsage?.promptTokens ?? tokenUsage?.input_tokens);
  let outputTokens = toNonNegInt(usageMeta?.output_tokens ?? tokenUsage?.completion_tokens ?? tokenUsage?.completionTokens ?? tokenUsage?.output_tokens);
  let cacheReadTokens = toNonNegInt(
    usageMeta?.input_token_details?.cache_read ??
      tokenUsage?.prompt_tokens_details?.cached_tokens ??
      tokenUsage?.input_tokens_details?.cached_tokens
  );
  let cacheWriteTokens = toNonNegInt(
    usageMeta?.input_token_details?.cache_creation ??
      tokenUsage?.prompt_tokens_details?.cache_write_tokens ??
      tokenUsage?.input_tokens_details?.cache_creation
  );

  if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens) {
    return null;
  }

  // OpenAI-compatible APIs often omit cache write; treat uncached input as miss.
  if (!cacheWriteTokens && inputTokens && cacheReadTokens) {
    cacheWriteTokens = Math.max(0, inputTokens - cacheReadTokens);
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function buildEstimatedUsage({ userText, answerText }) {
  return {
    inputTokens: estimateTokensFromText(userText),
    outputTokens: estimateTokensFromText(answerText),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: true,
  };
}

function recordTurnUsage({
  emitForChat,
  runId,
  modelName,
  finalMainUsage,
  mainAnswerText,
  userText,
}) {
  const usageToRecord =
    finalMainUsage ||
    (mainAnswerText
      ? buildEstimatedUsage({ userText, answerText: mainAnswerText })
      : null);

  if (!usageToRecord) return null;

  const recorded = recordTokenUsage({
    modelName,
    ...usageToRecord,
    requestCount: 1,
  });

  emitForChat({
    type: "usage",
    runId,
    modelName,
    estimated: Boolean(usageToRecord.estimated),
    usage: {
      inputTokens: usageToRecord.inputTokens,
      outputTokens: usageToRecord.outputTokens,
      cacheReadTokens: usageToRecord.cacheReadTokens,
      cacheWriteTokens: usageToRecord.cacheWriteTokens,
    },
    totals: recorded,
  });

  return recorded;
}

/**
 * Stream one user turn through DeepAgent for a specific conversation.
 * Other chats keep running — only this conversation's prior run is cancelled.
 * @param {{ conversationId: string, message: string, modelConfig: object, workspacePath?: string|null, agentState?: string|null, mcp?: { enabled?: boolean, servers?: string[] }|null }} params
 * @param {(event: object) => void} emit
 */
async function runChatTurn(
  {
    conversationId,
    message,
    modelConfig,
    workspacePath = null,
    agentState = null,
    mcp = null,
    skills = null,
    attachments = null,
    requireToolApproval = false,
  },
  emit
) {
  const text = String(message || "").trim();
  const normalizedAttachments = normalizeAttachments(attachments);
  if (!text && !normalizedAttachments.length) {
    throw new Error("Message is empty.");
  }
  if (!modelConfig) {
    throw new Error("No model selected. Add a model in Settings.");
  }

  const session = ensureSession(conversationId, { workspacePath, agentState });
  if (!session.workspacePath) {
    throw new Error("Pick a workspace folder first (path chip).");
  }

  // Only cancel an in-flight run on this same chat (re-send / stop+send).
  cancelRun(conversationId);

  const abortController = new AbortController();
  session.activeAbort = abortController;
  const runId = `run-${++runCounter}`;
  const chatId = session.conversationId;
  session.currentRunId = runId;
  session.requireToolApproval = Boolean(requireToolApproval);
  if (!session.pendingApprovals) session.pendingApprovals = new Map();
  if (typeof session.approveAllForSession !== "boolean") {
    session.approveAllForSession = false;
  }

  const emitForChat = (event) => {
    emit({ ...event, conversationId: chatId });
  };
  session.approvalEmit = emitForChat;

  emitForChat({ type: "start", runId });

  const selectedSkills = Array.isArray(skills)
    ? skills
        .map((skill) => ({
          name: String(skill?.name || "").trim(),
          scope: String(skill?.scope || "user").trim().toLowerCase() === "project" ? "project" : "user",
        }))
        .filter((skill) => skill.name)
    : [];

  let textContent = text;
  if (selectedSkills.length) {
    const lines = selectedSkills.map((skill) => {
      const mdPath = getSkillVirtualMdPath(skill.scope, skill.name);
      return `- ${skill.name} (${skill.scope}): read \`${mdPath}\` and follow it`;
    });
    textContent = `[Attached skills — the user explicitly selected these. Before doing other work, read each SKILL.md with filesystem tools and follow those instructions for this turn.]\n${lines.join("\n")}\n\nUser message:\n${text || "(see attached image)"}`;
  }

  const userContent = buildUserMessageContent(textContent, normalizedAttachments);

  /** Final main-agent answer-call usage (tool-loop + subagent ignored). */
  let finalMainUsage = null;
  let mainAnswerText = "";
  /** True after main-agent answer text in the current generation (reset on tool calls). */
  let sawAnswerSinceTools = false;
  const modelName = String(modelConfig.modelName || "").trim() || "unknown";

  const summarizationAtStart = session.lastSummarization?.at || 0;

  try {
    const agent = await getOrCreateAgent(session, modelConfig, mcp || {});
    const thinkSplitter = createThinkStreamSplitter();
    const toolTracker = createToolCallTracker(emitForChat, runId);

    if (session.shellController) {
      session.shellController.setHooks({
        signal: abortController.signal,
        onStart: ({ command }) => {
          if (abortController.signal.aborted) return;
          const cmd = String(command || "");
          // Guarantee the terminal card appears with the command before spawn output.
          // No id — attach to the running execute card (avoid clobbering the model tool id).
          emitForChat({
            type: "tool_call",
            runId,
            name: "execute",
            args: { command: cmd },
            argsText: JSON.stringify({ command: cmd }),
            partial: false,
          });
        },
        onChunk: ({ stream, text }) => {
          if (abortController.signal.aborted) return;
          emitForChat({
            type: "tool_output",
            runId,
            name: "execute",
            stream: stream === "stderr" ? "stderr" : "stdout",
            chunk: String(text || ""),
          });
        },
      });
    }

    const stream = await agent.stream(
      {
        messages: [{ role: "user", content: userContent }],
      },
      {
        configurable: { thread_id: session.threadId },
        streamMode: "messages",
        subgraphs: true,
        signal: abortController.signal,
      }
    );

    for await (const [namespace, chunk] of stream) {
      if (abortController.signal.aborted) break;

      const messageChunk = Array.isArray(chunk) ? chunk[0] : chunk;
      if (!messageChunk) continue;

      const isSubagent = Array.isArray(namespace)
        ? namespace.some((part) => String(part).startsWith("tools:"))
        : false;
      const source = isSubagent ? "subagent" : "main";

      if (source === "main" && AIMessageChunk.isInstance(messageChunk)) {
        const hasTools = Boolean(
          messageChunk.tool_call_chunks?.length || messageChunk.tool_calls?.length
        );
        const hasAnswerText = Boolean(extractStreamParts(messageChunk).text);
        if (hasTools) {
          sawAnswerSinceTools = false;
        }
        if (hasAnswerText) {
          sawAnswerSinceTools = true;
        }
        const usage = extractUsageFromMessage(messageChunk);
        // Only keep usage from the answer generation (not tool-only rounds).
        if (usage && sawAnswerSinceTools) {
          finalMainUsage = usage;
        }
      }

      if (
        AIMessageChunk.isInstance(messageChunk) &&
        messageChunk.tool_call_chunks?.length
      ) {
        toolTracker.ingestChunks(messageChunk.tool_call_chunks, source);
      } else if (
        AIMessageChunk.isInstance(messageChunk) &&
        Array.isArray(messageChunk.tool_calls) &&
        messageChunk.tool_calls.length
      ) {
        // Fallback for non-streaming tool_calls payloads
        toolTracker.ingestChunks(
          messageChunk.tool_calls.map((call) => ({
            id: call.id,
            name: call.name,
            args:
              typeof call.args === "string"
                ? call.args
                : JSON.stringify(call.args || {}),
            index: call.index,
          })),
          source
        );
      }

      if (ToolMessage.isInstance(messageChunk)) {
        toolTracker.completeResult(messageChunk, source);
        continue;
      }

      if (
        AIMessageChunk.isInstance(messageChunk) &&
        (messageChunk.tool_call_chunks?.length || messageChunk.tool_calls?.length)
      ) {
        // Still allow reasoning/text on the same chunk if present
        const parts = extractStreamParts(messageChunk);
        let thinking = parts.thinking;
        let answer = parts.text;
        if (answer) {
          const split = thinkSplitter(answer);
          answer = split.text;
          thinking += split.thinking;
        }
        if (thinking) {
          emitForChat({ type: "thinking", runId, source, text: thinking });
        }
        if (answer) {
          if (source === "main") mainAnswerText += answer;
          emitForChat({ type: "token", runId, source, text: answer });
        }
        continue;
      }

      const parts = extractStreamParts(messageChunk);
      let thinking = parts.thinking;
      let answer = parts.text;

      if (answer) {
        const split = thinkSplitter(answer);
        answer = split.text;
        thinking += split.thinking;
      }

      if (thinking) {
        emitForChat({
          type: "thinking",
          runId,
          source,
          text: thinking,
        });
      }

      if (answer) {
        if (source === "main") mainAnswerText += answer;
        emitForChat({
          type: "token",
          runId,
          source,
          text: answer,
        });
      }
    }

    toolTracker.flushPending();

    // Record even when the user hits Stop — providers rarely send usage on abort,
    // so we fall back to estimating from whatever answer text already streamed.
    recordTurnUsage({
      emitForChat,
      runId,
      modelName,
      finalMainUsage,
      mainAnswerText,
      userText: text,
    });

    if (
      session.lastSummarization?.at &&
      session.lastSummarization.at > summarizationAtStart
    ) {
      emitForChat({
        type: "summarized",
        runId,
        filePath: session.lastSummarization.filePath || null,
        cutoffIndex: session.lastSummarization.cutoffIndex ?? null,
      });
    }

    if (abortController.signal.aborted) {
      emitForChat({ type: "cancelled", runId });
    } else {
      emitForChat({ type: "done", runId });
    }
  } catch (error) {
    if (abortController.signal.aborted || error?.name === "AbortError") {
      recordTurnUsage({
        emitForChat,
        runId,
        modelName,
        finalMainUsage,
        mainAnswerText,
        userText: text,
      });
      emitForChat({ type: "cancelled", runId });
      return;
    }
    emitForChat({
      type: "error",
      runId,
      message: error?.message || String(error),
    });
  } finally {
    // Completion cleanup: clear abort handle and mark run finished.
    rejectAllPendingApprovals(session, "Cancelled.");
    session.approvalEmit = null;
    session.currentRunId = null;
    if (session.shellController) {
      try {
        session.shellController.clearHooks();
      } catch {
        // ignore
      }
    }
    if (session.activeAbort === abortController) {
      session.activeAbort = null;
    }
    session.lastRunCompletedAt = Date.now();
    session.lastRunId = runId;
  }
}

module.exports = {
  ensureSession,
  getSession,
  getWorkspacePath,
  setWorkspacePath,
  resetConversation,
  invalidateAllCachedAgents,
  cancelRun,
  cancelAllRuns,
  disposeSession,
  isRunActive,
  exportAgentState,
  polishPrompt,
  verifyModelConfig,
  listRemoteModels,
  runChatTurn,
  getContextUsage,
  resolveToolApproval,
};
