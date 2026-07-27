import {
  todoPanel,
  todoPanelList,
  todoPanelCount,
  todoProgressFill,
} from "./dom.js";
import { state, getSession } from "./state.js";
import { beginAgentTurn, scrollMessages, flushPendingStream } from "./chat.js";
import {
  pinTurnBottomChrome,
  sealThinkingSegment,
  isInTree,
  renderMarkdown,
  createSealedThinkingPanel,
} from "./markdown.js";
import { highlightCodeLines } from "./syntax.js";

function isWebTool(name) {
  return name === "web_search" || name === "web_fetch";
}

export function basenamePath(filePath) {
  const value = String(filePath || "").replace(/[/\\]+$/, "");
  if (!value) return "";
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function unescapeJsonStringLite(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

/** Prefer non-empty next values; never blank out a known file_path/path. */
function mergeToolArgObjects(prev = {}, next = {}) {
  const out = { ...(prev || {}) };
  for (const [key, value] of Object.entries(next || {})) {
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    out[key] = value;
  }
  return out;
}

function recoverExploreArgsFromPartial(raw) {
  const recovered = {};
  const text = String(raw || "");
  const keys = [
    "file_path",
    "path",
    "target_directory",
    "root",
    "pattern",
    "query",
    "q",
    "url",
    "purpose",
  ];
  for (const key of keys) {
    // Completed string value.
    const complete = text.match(
      new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
    );
    if (complete) {
      recovered[key] = unescapeJsonStringLite(complete[1]);
      continue;
    }
    // Streaming: value started but closing quote not yet received.
    const partial = text.match(
      new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)$`)
    );
    if (partial?.[1]) {
      recovered[key] = unescapeJsonStringLite(partial[1]);
    }
  }
  return recovered;
}

/** Merge tool args + streaming argsText so file/folder names show as soon as possible. */
export function resolveToolArgs(eventOrArgs, argsText = "") {
  const source =
    eventOrArgs && typeof eventOrArgs === "object" && !Array.isArray(eventOrArgs)
      ? eventOrArgs
      : {};

  // Only pull real tool-arg objects — never spread the whole tool_call event.
  const base =
    source.args && typeof source.args === "object" && !Array.isArray(source.args)
      ? { ...source.args }
      : !("args" in source) &&
          !("argsText" in source) &&
          !("type" in source) &&
          !("name" in source && "id" in source)
        ? { ...source }
        : {};

  const text = firstNonEmpty(source.argsText, argsText, "");

  let fromText = {};
  if (text) {
    try {
      const parsed = JSON.parse(String(text));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fromText = parsed;
      } else {
        fromText = recoverExploreArgsFromPartial(String(text));
      }
    } catch {
      fromText = recoverExploreArgsFromPartial(String(text));
    }
  }

  // Some providers wrap args as { input: "{...json...}" }.
  const inputRaw = firstNonEmpty(base.input, fromText.input);
  if (inputRaw && typeof inputRaw === "string" && inputRaw.trim().startsWith("{")) {
    try {
      const nested = JSON.parse(inputRaw);
      if (nested && typeof nested === "object") {
        fromText = mergeToolArgObjects(nested, fromText);
      }
    } catch {
      fromText = mergeToolArgObjects(
        recoverExploreArgsFromPartial(inputRaw),
        fromText
      );
    }
  }

  const merged = mergeToolArgObjects(fromText, base);

  // Models often send `path` for read_file — mirror deepagents normalizeFilePathInput.
  if (!firstNonEmpty(merged.file_path) && firstNonEmpty(merged.path)) {
    merged.file_path = merged.path;
  }

  return merged;
}

function workspaceFolderName(conversationId) {
  const session = getSession(conversationId || state.activeConversationId);
  const wp = session?.workspacePath;
  if (!wp) return "workspace";
  return basenamePath(wp) || "workspace";
}

function explorePathFromArgs(name, args, conversationId) {
  const a = args || {};
  if (name === "read_file") {
    return firstNonEmpty(a.file_path, a.path);
  }
  if (name === "ls") {
    return firstNonEmpty(a.path, a.file_path, a.target_directory);
  }
  if (name === "glob") {
    // Prefer the search root folder; fall back to pattern only if needed.
    return firstNonEmpty(a.path, a.target_directory, a.root, a.pattern);
  }
  if (name === "grep") {
    return firstNonEmpty(a.path, a.file_path, a.target_directory, a.pattern);
  }
  if (name === "web_search") {
    return firstNonEmpty(a.query, a.q, a.purpose);
  }
  if (name === "web_fetch") {
    if (Array.isArray(a.urls) && a.urls.length) return String(a.urls[0] || "");
    return firstNonEmpty(a.url);
  }
  return firstNonEmpty(a.file_path, a.path, a.target_directory, a.pattern);
}

function isFolderExploreTarget(name, args) {
  if (name === "ls") return true;
  if (name === "read_file") return false;
  if (name === "glob") {
    return Boolean(
      firstNonEmpty(args?.path, args?.target_directory, args?.root)
    );
  }
  if (name === "grep") {
    const p = firstNonEmpty(args?.path, args?.file_path);
    if (!p) return false;
    if (p === "." || p === "./" || p === "/" || p.endsWith("/") || p.endsWith("\\")) {
      return true;
    }
    const base = basenamePath(p);
    // Treat paths with a file extension as files; bare dirs as folders.
    if (base.includes(".") && !base.startsWith(".")) return false;
    return true;
  }
  return false;
}

export function formatExploreTarget(name, args, conversationId) {
  if (isWebTool(name)) {
    return formatWebTarget(name, args || {}) || "";
  }

  const raw = String(explorePathFromArgs(name, args, conversationId) || "").trim();
  const folderFallback = workspaceFolderName(conversationId);

  if (!raw || raw === "." || raw === "./" || raw === "/") {
    if (name === "ls" || isFolderExploreTarget(name, args)) return folderFallback;
    if (name === "grep" || name === "glob") {
      const pattern = firstNonEmpty(args?.pattern);
      return pattern || folderFallback;
    }
    return "";
  }

  return basenamePath(raw) || raw;
}

/** Running/done verbs for filesystem + web explore tools. */
export function exploreVerbs(name, isFolder = false) {
  switch (String(name || "").trim()) {
    case "ls":
      return {
        running: isFolder ? "Listing" : "Listing",
        done: isFolder ? "Listed" : "Listed",
      };
    case "glob":
      return { running: "Searching", done: "Searched" };
    case "grep":
      return { running: "Searching", done: "Searched" };
    case "web_search":
      return { running: "Searching", done: "Searched" };
    case "web_fetch":
      return { running: "Fetching", done: "Fetched" };
    case "read_file":
      return {
        running: isFolder ? "Reading Folder" : "Reading",
        done: isFolder ? "Read Folder" : "Read",
      };
    default:
      return {
        running: isFolder ? "Reading Folder" : "Reading",
        done: isFolder ? "Read Folder" : "Read",
      };
  }
}

/** Verb + target kept separate so the filename stays visible (shimmer must not clip it away). */
export function exploreItemParts(name, args, conversationId, { done = false } = {}) {
  const resolved = resolveToolArgs(args);
  const target = formatExploreTarget(name, resolved, conversationId);
  const isFolder = isFolderExploreTarget(name, resolved);
  const verbs = exploreVerbs(name, isFolder);
  let fallback = "file";
  if (name === "web_search") {
    fallback = "query";
  } else if (name === "web_fetch") {
    fallback = "URL";
  } else if (isFolder) {
    fallback = workspaceFolderName(conversationId);
  }
  return {
    verb: done ? verbs.done : verbs.running,
    target: target || fallback,
    fullPath:
      explorePathFromArgs(name, resolved, conversationId) ||
      firstNonEmpty(resolved?.query, resolved?.q, resolved?.purpose, target) ||
      "",
    isFolder,
    isQuery: name === "web_search",
    args: resolved,
  };
}

export function exploreItemLabel(name, args, conversationId) {
  const parts = exploreItemParts(name, args, conversationId);
  return `${parts.verb} ${parts.target}`;
}

export function softTruncate(text, limit = 4000) {
  const value = String(text ?? "");
  if (value.length <= limit) {
    return { visible: value, rest: "", truncated: false };
  }
  return {
    visible: value.slice(0, limit),
    rest: value.slice(limit),
    truncated: true,
  };
}

export function attachExpandableText(container, fullText, { previewLines = 7, className = "editor-code" } = {}) {
  const lines = String(fullText ?? "").split("\n");
  const needsExpand = lines.length > previewLines;
  const preview = needsExpand ? lines.slice(0, previewLines).join("\n") : lines.join("\n");

  const code = document.createElement("pre");
  code.className = className;
  code.textContent = preview || " ";
  container.appendChild(code);

  if (!needsExpand) return;

  const actions = document.createElement("div");
  actions.className = "tool-expand-row";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tool-show-more";
  btn.textContent = `Show full file (${lines.length} lines)`;
  let expanded = false;

  btn.addEventListener("click", () => {
    expanded = !expanded;
    if (expanded) {
      code.textContent = lines.join("\n") || " ";
      btn.textContent = "Show less";
      container.classList.add("expanded");
    } else {
      code.textContent = preview || " ";
      btn.textContent = `Show full file (${lines.length} lines)`;
      container.classList.remove("expanded");
    }
  });

  actions.appendChild(btn);
  container.appendChild(actions);
}

export function languageFromPath(filePath) {
  const name = basenamePath(filePath).toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : "";
  const map = {
    js: "JS",
    mjs: "JS",
    cjs: "JS",
    jsx: "JSX",
    ts: "TS",
    tsx: "TSX",
    py: "PY",
    rb: "RB",
    go: "GO",
    rs: "RS",
    java: "JAVA",
    kt: "KT",
    swift: "SWIFT",
    css: "CSS",
    scss: "SCSS",
    html: "HTML",
    htm: "HTML",
    json: "JSON",
    md: "MD",
    markdown: "MD",
    yml: "YML",
    yaml: "YML",
    sh: "SH",
    bash: "SH",
    zsh: "SH",
    sql: "SQL",
    toml: "TOML",
    xml: "XML",
    svg: "SVG",
    txt: "TXT",
  };
  return map[ext] || (ext ? ext.toUpperCase().slice(0, 4) : "FILE");
}

export function countDiffStats(oldText, newText) {
  const rows = computeLineDiff(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === "add") added += 1;
    else if (row.type === "del") removed += 1;
  }
  return { added, removed, rows };
}

export function attachNumberedCode(
  container,
  fullText,
  { previewLines = 7, mark = null, path = "" } = {}
) {
  const source = String(fullText ?? "");
  const lines = source.split("\n");
  const needsExpand = lines.length > previewLines;
  let fullHighlighted = null;

  const table = document.createElement("div");
  table.className = "code-table hljs-code";

  const renderLines = (endIndex) => {
    const slice = lines.slice(0, endIndex).join("\n");
    // Highlight only the visible slice while collapsed — keeps streaming snappy.
    const highlighted =
      endIndex >= lines.length
        ? fullHighlighted || (fullHighlighted = highlightCodeLines(source, path))
        : highlightCodeLines(slice, path);

    clearElement(table);
    for (let i = 0; i < endIndex; i++) {
      const row = document.createElement("div");
      row.className = `code-line${mark === "+" ? " code-add" : mark === "-" ? " code-del" : ""}`;
      const gutter = document.createElement("span");
      gutter.className = "code-gutter";
      gutter.textContent = String(i + 1);
      const markEl = document.createElement("span");
      markEl.className = `code-mark${mark === "+" ? " is-add" : mark === "-" ? " is-del" : ""}`;
      markEl.textContent = mark || " ";
      const code = document.createElement("span");
      code.className = "code-text";
      code.innerHTML = highlighted[i] ?? "";
      row.append(gutter, markEl, code);
      table.appendChild(row);
    }
  };

  renderLines(needsExpand ? previewLines : lines.length);
  container.appendChild(table);

  if (!needsExpand) return;

  const actions = document.createElement("div");
  actions.className = "tool-expand-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tool-show-more";
  btn.textContent = `Show full file (${lines.length} lines)`;
  let expanded = false;
  btn.addEventListener("click", () => {
    expanded = !expanded;
    if (expanded) {
      renderLines(lines.length);
      btn.textContent = "Show less";
      container.classList.add("expanded");
    } else {
      renderLines(previewLines);
      btn.textContent = `Show full file (${lines.length} lines)`;
      container.classList.remove("expanded");
    }
  });
  actions.appendChild(btn);
  container.appendChild(actions);
}

export function attachShowMore(container, rest) {
  if (!rest) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tool-show-more";
  btn.textContent = "Show more";
  btn.addEventListener("click", () => {
    const more = document.createElement("span");
    more.textContent = rest;
    btn.replaceWith(more);
  });
  container.appendChild(btn);
}

export function extractTodos(args, argsText, output) {
  if (Array.isArray(args?.todos) && args.todos.length) return args.todos;
  if (Array.isArray(args?.items) && args.items.length) return args.items;

  const sources = [argsText, output, args ? JSON.stringify(args) : ""];
  for (const source of sources) {
    if (!source) continue;
    try {
      const parsed = typeof source === "string" ? JSON.parse(source) : source;
      if (Array.isArray(parsed?.todos) && parsed.todos.length) return parsed.todos;
      if (Array.isArray(parsed) && parsed.length && parsed[0]?.content) return parsed;
    } catch {
      // continue
    }

    const items = [];
    const itemRe =
      /\{\s*"content"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"status"\s*:\s*"(pending|in_progress|completed)"\s*\}/g;
    let match;
    const text = String(source);
    while ((match = itemRe.exec(text))) {
      items.push({
        content: match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'),
        status: match[2],
      });
    }
    if (items.length) return items;
  }

  return null;
}

export function normalizeTodos(todos) {
  if (!Array.isArray(todos)) return [];
  return todos.map((item) => ({
    content: String(item?.content || item?.text || item?.title || "").trim(),
    status: String(item?.status || item?.state || "pending").toLowerCase(),
  })).filter((item) => item.content);
}

export function todoFingerprint(todos) {
  return normalizeTodos(todos)
    .map((item) => `${item.status}:${item.content}`)
    .join("\n");
}

export function renderTodoPanel(todos) {
  if (!todoPanel || !todoPanelList) return;

  const items = normalizeTodos(todos);
  if (!items.length) {
    todoPanel.hidden = true;
    todoPanelList.replaceChildren();
    if (todoPanelCount) todoPanelCount.textContent = "0/0";
    if (todoProgressFill) todoProgressFill.style.width = "0%";
    return;
  }

  todoPanel.hidden = false;

  const done = items.filter(
    (item) => item.status === "completed" || item.status === "done"
  ).length;
  const total = items.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  if (todoPanelCount) todoPanelCount.textContent = `${done}/${total}`;
  if (todoProgressFill) todoProgressFill.style.width = `${pct}%`;

  todoPanelList.replaceChildren();
  for (const item of items) {
    const li = document.createElement("li");
    li.className = `todo-panel-item status-${item.status}`;

    const mark = document.createElement("span");
    mark.className = "todo-panel-mark";
    mark.textContent =
      item.status === "completed" || item.status === "done"
        ? "✓"
        : item.status === "in_progress"
          ? "…"
          : "○";

    const text = document.createElement("span");
    text.className = "todo-panel-text";
    text.textContent = item.content;

    li.append(mark, text);
    todoPanelList.appendChild(li);
  }
}

export function syncTodoPanel(conversationId = state.activeConversationId) {
  if (conversationId !== state.activeConversationId) return;
  const session = getSession(conversationId);
  renderTodoPanel(session?.todos || []);
}

export function setSessionTodos(conversationId, todos, { force = false } = {}) {
  const session = getSession(conversationId);
  if (!session) return;

  const next = normalizeTodos(todos);
  const fingerprint = todoFingerprint(next);
  if (!force && fingerprint === session.todoFingerprint) return;

  session.todos = next;
  session.todoFingerprint = fingerprint;

  if (conversationId !== state.activeConversationId) return;

  if (state.todoPanelRaf) cancelAnimationFrame(state.todoPanelRaf);
  state.todoPanelRaf = requestAnimationFrame(() => {
    state.todoPanelRaf = 0;
    renderTodoPanel(session.todos);
  });
}

export function updateTodosFromToolEvent(conversationId, event) {
  const name = event?.name || "";
  if (name && name !== "write_todos") return false;

  const todos = extractTodos(event.args, event.argsText, event.output);
  if (!todos?.length) {
    // Still claim write_todos events so they never create chat cards.
    return name === "write_todos";
  }

  setSessionTodos(conversationId, todos);
  return true;
}

export function extractLatestTodosFromMessages(messages) {
  let latest = [];
  for (const message of messages || []) {
    if (message.role !== "agent") continue;
    const blocks = message.content?.blocks;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== "tool" || block.name !== "write_todos") continue;
      const todos = extractTodos(block.args, block.argsText, block.output);
      if (todos?.length) latest = todos;
    }
  }
  return latest;
}

export function isRealToolName(name) {
  const value = String(name || "").trim();
  return Boolean(value) && value !== "tool" && value !== "pending";
}

export function findRunningCard(turnRef, event) {
  const id = String(event.id || "");
  if (id && turnRef.toolCards.has(id)) {
    return turnRef.toolCards.get(id);
  }

  const eventName = String(event.name || "").trim();
  const hasName = isRealToolName(eventName);

  // Match running card by name (handles idx:* → real id transitions)
  if (hasName) {
    for (const existing of turnRef.toolCards.values()) {
      if (existing.status !== "running") continue;
      if (existing.name === eventName) {
        return existing;
      }
    }
  }

  // Only do fuzzy id-prefix matching when we have a real tool name.
  // Nameless / "tool" placeholder events must NOT hijack other running cards.
  if (!hasName) return null;

  for (const existing of turnRef.toolCards.values()) {
    if (existing.status !== "running") continue;
    if (
      String(existing.id).startsWith("idx:") ||
      String(existing.id).startsWith("anon:") ||
      String(existing.id).startsWith("pending:")
    ) {
      if (existing.name === eventName) return existing;
    }
  }

  // If only one tool is running and names match (or existing is still unnamed), bind it.
  const running = [...turnRef.toolCards.values()].filter(
    (card) => card.status === "running"
  );
  if (running.length === 1 && running[0].name === eventName) {
    return running[0];
  }

  return null;
}

export function rekeyCard(turnRef, card, newId) {
  if (!card || !newId || String(card.id) === String(newId)) return card;
  turnRef.toolCards.delete(card.id);
  const prevActivityKey = card.activityKey || `file-action:${card.id}`;
  card.id = String(newId);
  card.el.dataset.toolId = card.id;
  turnRef.toolCards.set(card.id, card);
  if (isFileActionTool(card.name) && turnRef.activityLabels?.has(prevActivityKey)) {
    const entry = turnRef.activityLabels.get(prevActivityKey);
    turnRef.activityLabels.delete(prevActivityKey);
    card.activityKey = `file-action:${card.id}`;
    if (entry) turnRef.activityLabels.set(card.activityKey, entry);
  }
  return card;
}

export function toolTitle(name, args, argsText = "") {
  const a = resolveToolArgs({ args: args || {}, argsText });
  switch (name) {
    case "execute":
      return a.command ? String(a.command) : "Terminal";
    case "write_file":
    case "edit_file":
    case "read_file":
      return a.file_path || a.path || name;
    case "ls":
      return a.path || a.file_path || "/";
    case "glob":
      return a.pattern || "glob";
    case "grep":
      return a.pattern ? `/${a.pattern}/` : "grep";
    case "write_todos":
      return "Todos";
    case "task":
      return a.description || a.task || "Subagent";
    case "web_search":
      return a.query || "Web search";
    case "web_fetch": {
      const urls = Array.isArray(a.urls) ? a.urls : a.url ? [a.url] : [];
      if (!urls.length) return "Fetch URL";
      if (urls.length === 1) return String(urls[0]);
      return `${urls[0]} (+${urls.length - 1})`;
    }
    default:
      return name;
  }
}

export function isFileActionTool(name) {
  return name === "write_file" || name === "edit_file";
}

/** Running vs done verbs for create/edit file tools. */
export function fileActionVerbs(name) {
  if (name === "edit_file") return { running: "Editing", done: "Edited" };
  if (name === "write_file") return { running: "Creating", done: "Created" };
  return null;
}

export function toolLabel(name, status = "done") {
  const running = status === "running";
  if (name === "write_file") return running ? "Creating" : "Created";
  if (name === "edit_file") return running ? "Editing" : "Edited";
  if (name === "execute") return running ? "Running" : "Ran";
  const labels = {
    read_file: running ? "Reading" : "Read",
    ls: running ? "Listing" : "Listed",
    glob: running ? "Searching" : "Searched",
    grep: running ? "Searching" : "Searched",
    write_todos: "Todos",
    task: "Task",
    web_search: running ? "Searching" : "Searched",
    web_fetch: running ? "Fetching" : "Fetched",
  };
  return labels[name] || name;
}

export function executeActionVerbs() {
  return { running: "Running", done: "Ran" };
}

/** Soft-truncate a shell command for the activity row. */
export function formatExecuteTarget(command, limit = 64) {
  const value = String(command || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

export function clearElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function escapeTerminalHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function xterm256ToRgb(n) {
  if (n < 16) {
    const base = [
      [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
      [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
      [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
      [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
    ];
    return base[n] || [204, 204, 204];
  }
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const ramp = [0, 95, 135, 175, 215, 255];
    return [ramp[r], ramp[g], ramp[b]];
  }
  const gray = 8 + (n - 232) * 10;
  return [gray, gray, gray];
}

/** ANSI SGR → HTML (16 / 256 / truecolor). */
function ansiToHtml(text) {
  const source = String(text ?? "");
  if (!source.includes("\u001b[")) return colorizeTerminalPlain(source);

  let out = "";
  let i = 0;
  let open = false;
  const close = () => {
    if (open) {
      out += "</span>";
      open = false;
    }
  };

  while (i < source.length) {
    if (source[i] === "\u001b" && source[i + 1] === "[") {
      const end = source.indexOf("m", i + 2);
      if (end === -1) {
        out += escapeTerminalHtml(source.slice(i));
        break;
      }
      const raw = source.slice(i + 2, end);
      i = end + 1;
      const parts = raw.length ? raw.split(";") : ["0"];
      const codes = parts.map((c) => Number(c));
      close();
      if (!codes.length || codes.includes(0)) continue;

      const classes = [];
      const styles = [];
      for (let c = 0; c < codes.length; c++) {
        const code = codes[c];
        if (Number.isNaN(code)) continue;
        if (code === 1) classes.push("ansi-bold");
        else if (code === 2) classes.push("ansi-dim");
        else if (code === 3) classes.push("ansi-italic");
        else if (code === 4) classes.push("ansi-underline");
        else if (code === 7) classes.push("ansi-inverse");
        else if (code === 9) classes.push("ansi-strike");
        else if (code >= 30 && code <= 37) classes.push(`ansi-fg-${code - 30}`);
        else if (code >= 90 && code <= 97) classes.push(`ansi-fg-bright-${code - 90}`);
        else if (code >= 40 && code <= 47) classes.push(`ansi-bg-${code - 40}`);
        else if (code >= 100 && code <= 107) classes.push(`ansi-bg-bright-${code - 100}`);
        else if (code === 38 || code === 48) {
          const isFg = code === 38;
          const mode = codes[c + 1];
          if (mode === 5 && codes[c + 2] != null) {
            const [r, g, b] = xterm256ToRgb(codes[c + 2]);
            styles.push(`${isFg ? "color" : "background-color"}: rgb(${r},${g},${b})`);
            c += 2;
          } else if (mode === 2 && codes[c + 4] != null) {
            const r = codes[c + 2];
            const g = codes[c + 3];
            const b = codes[c + 4];
            styles.push(`${isFg ? "color" : "background-color"}: rgb(${r},${g},${b})`);
            c += 4;
          }
        }
      }
      if (classes.length || styles.length) {
        const attr = [
          classes.length ? `class="${classes.join(" ")}"` : "",
          styles.length ? `style="${styles.join(";")}"` : "",
        ]
          .filter(Boolean)
          .join(" ");
        out += `<span ${attr}>`;
        open = true;
      }
      continue;
    }
    // Collapse other CSI / OSC noise
    if (source[i] === "\u001b") {
      const next = source[i + 1];
      if (next === "]") {
        const bel = source.indexOf("\u0007", i + 2);
        const st = source.indexOf("\u001b\\", i + 2);
        const cut = bel !== -1 && (st === -1 || bel < st) ? bel + 1 : st !== -1 ? st + 2 : source.length;
        i = cut;
        continue;
      }
      if (next && /[@-Z\\^_`]/.test(next)) {
        i += 2;
        continue;
      }
    }
    out += escapeTerminalHtml(source[i]);
    i += 1;
  }
  close();
  return out;
}

/**
 * Heuristic colorizing for plain (non-ANSI) terminal lines —
 * paths, URLs, numbers, success/error words, git-ish markers.
 */
function colorizeTerminalPlain(text) {
  const source = String(text ?? "");
  if (!source) return "";

  const pattern =
    /(https?:\/\/[^\s]+)|((?:\/|\.\/|\.\.\/|~\/)[^\s:]+(?::\d+(?::\d+)?)?)|(\b(?:error|failed|fatal|exception|denied|traceback|panic)\b)|(\b(?:success|passed|done|ok|complete(?:d)?|ready)\b)|(\b(?:warn(?:ing)?|deprecated)\b)|(\b\d+(?:\.\d+)?%?\b)|("[^"\n]*"|'[^'\n]*')|(\[[^\]]+\])/gi;

  let out = "";
  let last = 0;
  let match;
  while ((match = pattern.exec(source))) {
    out += escapeTerminalHtml(source.slice(last, match.index));
    const [full, url, path, err, ok, warn, num, str, bracket] = match;
    let cls = "term-token";
    if (url) cls = "term-url";
    else if (path) cls = "term-path";
    else if (err) cls = "term-error";
    else if (ok) cls = "term-ok";
    else if (warn) cls = "term-warn";
    else if (num) cls = "term-number";
    else if (str) cls = "term-string";
    else if (bracket) cls = "term-bracket";
    out += `<span class="${cls}">${escapeTerminalHtml(full)}</span>`;
    last = match.index + full.length;
  }
  out += escapeTerminalHtml(source.slice(last));
  return out;
}

function colorizeTerminalLine(line, { stderr = false } = {}) {
  const value = String(line ?? "");
  if (!value) return "";

  if (value.includes("\u001b[")) return ansiToHtml(value);

  // Leading git / diff markers
  if (/^\s*\+/.test(value) && !/^\s*\+\+\+/.test(value)) {
    return `<span class="term-diff-add">${colorizeTerminalPlain(value)}</span>`;
  }
  if (/^\s*-/.test(value) && !/^\s*---/.test(value)) {
    return `<span class="term-diff-del">${colorizeTerminalPlain(value)}</span>`;
  }
  if (/^\s*#/.test(value) || /^\s*\/\//.test(value)) {
    return `<span class="term-comment">${escapeTerminalHtml(value)}</span>`;
  }
  if (stderr) return `<span class="term-error">${colorizeTerminalPlain(value)}</span>`;
  return colorizeTerminalPlain(value);
}

/** Shell-command coloring (flags, strings, paths) — terminal palette, not editor theme. */
function colorizeShellCommand(command) {
  const source = String(command ?? "");
  if (!source) return "";

  let out = "";
  let i = 0;
  let first = true;

  while (i < source.length) {
    if (/\s/.test(source[i])) {
      out += escapeTerminalHtml(source[i]);
      i += 1;
      continue;
    }

    if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\" && quote !== "'") {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += `<span class="term-string">${escapeTerminalHtml(source.slice(i, j))}</span>`;
      i = j;
      first = false;
      continue;
    }

    if (source[i] === "-" && i + 1 < source.length && /[A-Za-z0-9-]/.test(source[i + 1])) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_=-]/.test(source[j])) j += 1;
      out += `<span class="term-flag">${escapeTerminalHtml(source.slice(i, j))}</span>`;
      i = j;
      first = false;
      continue;
    }

    if (source[i] === "$" || source[i] === "~") {
      let j = i + 1;
      while (j < source.length && /[\w{}/.-]/.test(source[j])) j += 1;
      out += `<span class="term-path">${escapeTerminalHtml(source.slice(i, j))}</span>`;
      i = j;
      first = false;
      continue;
    }

    if (/[|&;<>]/.test(source[i])) {
      out += `<span class="term-op">${escapeTerminalHtml(source[i])}</span>`;
      i += 1;
      first = false;
      continue;
    }

    let j = i;
    while (j < source.length && !/[\s"'`$|&;<>]/.test(source[j])) j += 1;
    const token = source.slice(i, j);
    const cls = first
      ? "term-bin"
      : /[\/.~]/.test(token)
        ? "term-path"
        : /^\d/.test(token)
          ? "term-number"
          : "term-arg";
    out += `<span class="${cls}">${escapeTerminalHtml(token)}</span>`;
    i = j;
    first = false;
  }

  return out;
}

function paintTerminalCommand(cmdEl, command) {
  if (!cmdEl) return;
  const value = String(command ?? "");
  cmdEl.innerHTML = value ? colorizeShellCommand(value) : "";
}

function paintTerminalOutput(outEl, text) {
  if (!outEl) return;
  const value = String(text ?? "");
  if (!value) {
    outEl.textContent = "";
    return;
  }

  const lines = value.split("\n");
  let html = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isStderr = line.startsWith("[stderr]");
    const display = isStderr ? line.replace(/^\[stderr\]\s?/, "") : line;
    const cls = isStderr ? "term-line is-stderr" : "term-line";
    html += `<div class="${cls}">${colorizeTerminalLine(display, { stderr: isStderr })}</div>`;
  }
  outEl.innerHTML = html;
}

function terminalHeaderLabel(command) {
  const value = String(command || "").replace(/\s+/g, " ").trim();
  if (!value) return "Terminal";
  return value.length > 72 ? `${value.slice(0, 71)}…` : value;
}

function syncTerminalSummaryTitle(cardRef, command) {
  const label = terminalHeaderLabel(command);
  const titleEl = cardRef?.termTitleEl || cardRef?.titleEl;
  if (!titleEl) return;
  titleEl.textContent = label;
  titleEl.title = String(command || "").trim() || "Terminal";
  cardRef.termTitleEl = titleEl;
}

export function renderTerminalBody(pane, args, output, cardRef = null) {
  clearElement(pane);
  pane.className = "tool-pane tool-terminal";
  pane.dataset.codeBlock = "1";

  const existing =
    cardRef?.streamedOutput != null ? String(cardRef.streamedOutput) : "";
  const incoming = output != null ? String(output) : "";
  const initial =
    incoming && incoming.length >= existing.length ? incoming : existing || incoming;
  const command = args?.command || "";

  // Header lives in <summary> so the card stays collapsible.
  if (cardRef) syncTerminalSummaryTitle(cardRef, command);

  const body = document.createElement("div");
  body.className = "term-body";

  const prompt = document.createElement("div");
  prompt.className = "term-prompt";
  const dollar = document.createElement("span");
  dollar.className = "term-dollar";
  dollar.textContent = "$";
  const cmd = document.createElement("span");
  cmd.className = "term-cmd";
  paintTerminalCommand(cmd, command);
  prompt.append(dollar, cmd);
  body.appendChild(prompt);

  const out = document.createElement("div");
  out.className = "term-output";
  paintTerminalOutput(out, initial);
  body.appendChild(out);

  pane.appendChild(body);

  if (cardRef) {
    cardRef.termOutputEl = out;
    cardRef.termCmdEl = cmd;
    cardRef.streamedOutput = initial;
  }
}

export function updateTerminalCommand(cardRef, command) {
  if (!cardRef) return;
  const next = command != null ? String(command) : "";
  if (!cardRef.args) cardRef.args = {};
  if (next) cardRef.args.command = next;

  syncTerminalSummaryTitle(cardRef, next);

  if (cardRef.termCmdEl && cardRef.pane?.contains(cardRef.termCmdEl)) {
    paintTerminalCommand(cardRef.termCmdEl, next);
    return;
  }

  if (cardRef.pane) {
    renderTerminalBody(
      cardRef.pane,
      cardRef.args,
      cardRef.streamedOutput || "",
      cardRef
    );
  }
}

export function appendToolOutput(cardRef, chunk, { stream = "stdout" } = {}) {
  if (!cardRef) return;
  let text = String(chunk ?? "");
  if (!text) return;
  if (stream === "stderr") {
    // Prefix each line when streaming stderr so it matches final formatting intent.
    text = text
      .split("\n")
      .map((line, i, arr) => {
        if (!line && i === arr.length - 1) return "";
        return line.startsWith("[stderr]") ? line : `[stderr] ${line}`;
      })
      .join("\n");
  }

  cardRef.streamedOutput = `${cardRef.streamedOutput || ""}${text}`;

  const pane = cardRef.pane;
  if (!cardRef.termOutputEl || !pane?.contains(cardRef.termOutputEl)) {
    // Rebuild pane if needed (e.g. fillToolPane recreated it).
    renderTerminalBody(pane, cardRef.args, cardRef.streamedOutput, cardRef);
  } else {
    paintTerminalOutput(cardRef.termOutputEl, cardRef.streamedOutput);
  }

  if (pane) {
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 48;
    if (nearBottom) pane.scrollTop = pane.scrollHeight;
  }
}

export function renderEditorHeader(
  pane,
  { path, added = 0, removed = 0, mode = "write" } = {}
) {
  const tab = document.createElement("div");
  tab.className = "editor-tab";

  const badge = document.createElement("span");
  badge.className = `lang-badge lang-${languageFromPath(path).toLowerCase()}`;
  badge.textContent = languageFromPath(path);

  const name = document.createElement("span");
  name.className = "editor-filename";
  name.textContent = basenamePath(path) || "file";
  name.title = path || "";

  const stats = document.createElement("span");
  stats.className = "editor-stats";
  if (mode === "write") {
    const created = document.createElement("span");
    created.className = "stat-created";
    created.textContent = "Created";
    stats.appendChild(created);
  }
  if (added > 0) {
    const addEl = document.createElement("span");
    addEl.className = "stat-add";
    addEl.textContent = `+${added}`;
    stats.appendChild(addEl);
  }
  if (removed > 0) {
    const delEl = document.createElement("span");
    delEl.className = "stat-del";
    delEl.textContent = `-${removed}`;
    stats.appendChild(delEl);
  }

  tab.append(badge, name, stats);
  tab.dataset.mode = mode;
  pane.appendChild(tab);
  return tab;
}

export function renderEditorBody(pane, { path, content, mode }) {
  clearElement(pane);
  pane.className = `tool-pane tool-editor mode-${mode || "write"}`;
  pane.dataset.codeBlock = "1";

  const text = String(content ?? "");
  const lineCount = text ? text.split("\n").length : 0;
  const added = mode === "write" ? lineCount : 0;
  renderEditorHeader(pane, {
    path,
    added: mode === "read" ? 0 : added,
    removed: 0,
    mode: mode || "write",
  });

  const body = document.createElement("div");
  body.className = "editor-body";
  attachNumberedCode(body, text, {
    previewLines: 7,
    mark: mode === "write" ? "+" : null,
    path: path || "",
  });
  pane.appendChild(body);
}

/**
 * Line-level LCS diff for edit_file previews.
 */
export function computeLineDiff(oldText, newText) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  const n = a.length;
  const m = b.length;

  if (n * m > 250_000) {
    return [
      ...a.map((text, i) => ({
        type: "del",
        text,
        oldLine: i + 1,
        newLine: null,
      })),
      ...b.map((text, i) => ({
        type: "add",
        text,
        oldLine: null,
        newLine: i + 1,
      })),
    ];
  }

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "equal", text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i], oldLine: i + 1, newLine: null });
      i++;
    } else {
      rows.push({ type: "add", text: b[j], oldLine: null, newLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: "del", text: a[i], oldLine: i + 1, newLine: null });
    i++;
  }
  while (j < m) {
    rows.push({ type: "add", text: b[j], oldLine: null, newLine: j + 1 });
    j++;
  }
  return rows;
}

export function renderDiffBody(pane, args) {
  clearElement(pane);
  pane.className = "tool-pane tool-diff";

  const filePath = args?.file_path || args?.path || "file";
  const oldStr = args?.old_string ?? "";
  const newStr = args?.new_string ?? "";
  const { added, removed, rows } = countDiffStats(oldStr, newStr);

  // Highlight old/new sources once, then map each diff row to its line HTML.
  const oldHighlighted = highlightCodeLines(oldStr, filePath);
  const newHighlighted = highlightCodeLines(newStr, filePath);

  pane.dataset.codeBlock = "1";
  renderEditorHeader(pane, {
    path: filePath,
    added,
    removed,
    mode: "edit",
  });

  const table = document.createElement("div");
  table.className = "diff-table hljs-code";

  const PREVIEW = 7;
  const changedIdx = [];
  rows.forEach((row, i) => {
    if (row.type !== "equal") changedIdx.push(i);
  });

  let visible = rows;
  let hiddenPrefix = 0;
  let hiddenSuffix = 0;
  if (rows.length > PREVIEW && changedIdx.length) {
    const first = Math.max(0, changedIdx[0] - 1);
    const last = Math.min(rows.length - 1, changedIdx[changedIdx.length - 1] + 1);
    if (last - first + 1 <= PREVIEW) {
      visible = rows.slice(first, last + 1);
      hiddenPrefix = first;
      hiddenSuffix = rows.length - 1 - last;
    } else {
      visible = rows.slice(first, first + PREVIEW);
      hiddenPrefix = first;
      hiddenSuffix = rows.length - (first + PREVIEW);
    }
  } else if (rows.length > PREVIEW) {
    visible = rows.slice(0, PREVIEW);
    hiddenSuffix = rows.length - PREVIEW;
  }

  const renderRow = (row) => {
    const el = document.createElement("div");
    el.className = `diff-line diff-${row.type}`;
    const gutter = document.createElement("span");
    gutter.className = "diff-gutter";
    gutter.textContent =
      row.newLine != null
        ? String(row.newLine)
        : row.oldLine != null
          ? String(row.oldLine)
          : "";
    const mark = document.createElement("span");
    mark.className = `diff-mark${
      row.type === "add" ? " is-add" : row.type === "del" ? " is-del" : ""
    }`;
    mark.textContent =
      row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
    const code = document.createElement("span");
    code.className = "diff-code";
    if (row.type === "del" && row.oldLine != null) {
      code.innerHTML = oldHighlighted[row.oldLine - 1] ?? "";
    } else if (row.newLine != null) {
      code.innerHTML = newHighlighted[row.newLine - 1] ?? "";
    } else {
      code.textContent = row.text;
    }
    el.append(gutter, mark, code);
    return el;
  };

  if (hiddenPrefix > 0) {
    const more = document.createElement("div");
    more.className = "diff-ellipsis";
    more.textContent = `… ${hiddenPrefix} unchanged lines above`;
    table.appendChild(more);
  }

  for (const row of visible) {
    table.appendChild(renderRow(row));
  }

  if (hiddenSuffix > 0) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tool-show-more";
    btn.textContent = `Show ${hiddenSuffix} more lines`;
    btn.addEventListener("click", () => {
      clearElement(table);
      for (const row of rows) table.appendChild(renderRow(row));
      btn.remove();
    });
    pane.append(table, btn);
    return;
  }

  pane.appendChild(table);
}

export function renderImages(pane, images) {
  if (!Array.isArray(images) || !images.length) return;
  const wrap = document.createElement("div");
  wrap.className = "tool-images";
  for (const image of images) {
    if (!image?.data) continue;
    const mime = image.mimeType || "image/png";
    const figure = document.createElement("figure");
    figure.className = "tool-image-figure";
    const img = document.createElement("img");
    img.className = "tool-image";
    img.alt = "Tool screenshot";
    img.src = `data:${mime};base64,${image.data}`;
    img.loading = "lazy";
    figure.appendChild(img);
    wrap.appendChild(figure);
  }
  if (wrap.childNodes.length) pane.appendChild(wrap);
}

export function renderTodosBody(pane, args, output, argsText) {
  clearElement(pane);
  pane.className = "tool-pane tool-todos";

  const todos = extractTodos(args, argsText, output);

  if (!Array.isArray(todos) || !todos.length) {
    const empty = document.createElement("div");
    empty.className = "tool-empty";
    empty.textContent = output
      ? String(output).slice(0, 400)
      : "Waiting for todo items…";
    pane.appendChild(empty);
    if (args && Object.keys(args).length) {
      const pre = document.createElement("pre");
      pre.className = "tool-generic-pre";
      pre.textContent = JSON.stringify(args, null, 2);
      pane.appendChild(pre);
    }
    return;
  }

  const list = document.createElement("ul");
  list.className = "todo-list";
  for (const item of todos) {
    const li = document.createElement("li");
    const status = String(item.status || item.state || "pending").toLowerCase();
    li.className = `todo-item status-${status}`;
    const mark = document.createElement("span");
    mark.className = "todo-mark";
    mark.textContent =
      status === "completed" || status === "done"
        ? "✓"
        : status === "in_progress"
          ? "…"
          : "○";
    const text = document.createElement("span");
    text.textContent =
      item.content || item.text || item.title || JSON.stringify(item);
    li.append(mark, text);
    list.appendChild(li);
  }
  pane.appendChild(list);
}

export function renderListBody(pane, output, emptyLabel) {
  clearElement(pane);
  pane.className = "tool-pane tool-list";

  const lines = String(output || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length);

  if (!lines.length) {
    const empty = document.createElement("div");
    empty.className = "tool-empty";
    empty.textContent = emptyLabel || "No results";
    pane.appendChild(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "file-list";
  const max = 80;
  for (const line of lines.slice(0, max)) {
    const item = document.createElement("li");
    item.textContent = line;
    list.appendChild(item);
  }
  pane.appendChild(list);
  if (lines.length > max) {
    attachShowMore(pane, lines.slice(max).join("\n"));
  }
}

export function renderGrepBody(pane, args, output) {
  clearElement(pane);
  pane.className = "tool-pane tool-grep";

  const query = document.createElement("div");
  query.className = "grep-query";
  query.textContent = args?.pattern
    ? `pattern: ${args.pattern}${args.path ? ` in ${args.path}` : ""}`
    : "grep";
  pane.appendChild(query);

  const pre = document.createElement("pre");
  pre.className = "grep-results";
  const { visible, rest, truncated } = softTruncate(output || "", 6000);
  pre.textContent = visible || "(no matches)";
  pane.appendChild(pre);
  if (truncated) attachShowMore(pane, rest);
}

function hostnameFromUrl(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseJsonToolOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Some tool wrappers wrap JSON in markdown fences.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fenced) return null;
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      return null;
    }
  }
}

function syncWebSummary(cardRef, { title, meta } = {}) {
  if (!cardRef) return;
  const titleEl = cardRef.webTitleEl || cardRef.titleEl;
  if (titleEl) {
    const label = String(title || (cardRef.name === "web_fetch" ? "Fetch" : "Search"));
    titleEl.textContent = label.length > 72 ? `${label.slice(0, 71)}…` : label;
    titleEl.title = label;
    cardRef.webTitleEl = titleEl;
  }
  if (cardRef.webMetaEl) {
    const metaText = String(meta || "").trim();
    cardRef.webMetaEl.textContent = metaText;
    cardRef.webMetaEl.hidden = !metaText;
  }
}

/** TinyFish web_search — ranked results with title / site / snippet. */
export function renderWebSearchBody(pane, args, output, cardRef = null) {
  clearElement(pane);
  pane.className = "tool-pane tool-web tool-web-search";

  const query = firstNonEmpty(args?.query, args?.q) || "";
  const purpose = firstNonEmpty(args?.purpose);
  const data = parseJsonToolOutput(output);
  const results = Array.isArray(data?.results) ? data.results : [];
  const total = Number(data?.total_results) || results.length;

  syncWebSummary(cardRef, {
    title: query || "Web search",
    meta: results.length
      ? `${results.length}${total > results.length ? ` of ${total}` : ""} result${results.length === 1 ? "" : "s"}`
      : String(output || "").trim()
        ? "No results"
        : cardRef?.status === "running"
          ? "Searching…"
          : "",
  });

  const body = document.createElement("div");
  body.className = "web-body";

  if (purpose) {
    const purposeEl = document.createElement("div");
    purposeEl.className = "web-purpose";
    purposeEl.textContent = purpose;
    purposeEl.title = purpose;
    body.appendChild(purposeEl);
  }

  if (!String(output || "").trim()) {
    const empty = document.createElement("div");
    empty.className = "web-empty";
    empty.textContent = cardRef?.status === "running" ? "Searching…" : "No results yet";
    body.appendChild(empty);
    pane.appendChild(body);
    return;
  }

  if (!data || !results.length) {
    const empty = document.createElement("div");
    empty.className = "web-empty";
    empty.textContent = data?.message || "No search results found.";
    body.appendChild(empty);
    if (!data && String(output || "").trim()) {
      const pre = document.createElement("pre");
      pre.className = "web-raw";
      const { visible, rest, truncated } = softTruncate(output, 6000);
      pre.textContent = visible;
      body.appendChild(pre);
      pane.appendChild(body);
      if (truncated) attachShowMore(pane, rest);
      return;
    }
    pane.appendChild(body);
    return;
  }

  const list = document.createElement("div");
  list.className = "web-results";

  for (const item of results.slice(0, 10)) {
    const row = document.createElement("a");
    row.className = "web-result";
    const href = String(item.url || "").trim();
    if (href) {
      row.href = href;
      row.target = "_blank";
      row.rel = "noopener noreferrer";
      row.addEventListener("click", (e) => e.stopPropagation());
    } else {
      row.href = "#";
      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      row.classList.add("is-nolink");
    }

    const rank = document.createElement("span");
    rank.className = "web-result-rank";
    rank.textContent = String(item.position ?? list.childElementCount + 1);

    const main = document.createElement("div");
    main.className = "web-result-main";

    const title = document.createElement("div");
    title.className = "web-result-title";
    title.textContent = item.title || href || "Untitled";

    const meta = document.createElement("div");
    meta.className = "web-result-meta";
    const site = item.site || hostnameFromUrl(href);
    const bits = [site, item.publisher, item.date].filter(Boolean);
    meta.textContent = bits.join(" · ");

    main.append(title);
    if (bits.length) main.append(meta);
    if (item.snippet) {
      const snip = document.createElement("div");
      snip.className = "web-result-snippet";
      snip.textContent = String(item.snippet);
      main.append(snip);
    }

    row.append(rank, main);
    list.appendChild(row);
  }

  body.appendChild(list);
  pane.appendChild(body);
}

/** TinyFish web_fetch — page title + extracted content. */
export function renderWebFetchBody(pane, args, output, cardRef = null) {
  clearElement(pane);
  pane.className = "tool-pane tool-web tool-web-fetch";

  const urls = Array.isArray(args?.urls)
    ? args.urls.map(String)
    : args?.url
      ? [String(args.url)]
      : [];
  const data = parseJsonToolOutput(output);
  const pages = Array.isArray(data?.results) ? data.results : [];
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const primary = pages[0]?.url || urls[0] || "Fetch URL";

  syncWebSummary(cardRef, {
    title: pages.length > 1 ? `${primary} (+${pages.length - 1})` : primary,
    meta: pages.length
      ? `${pages.length} page${pages.length === 1 ? "" : "s"}`
      : String(output || "").trim()
        ? "Failed"
        : cardRef?.status === "running"
          ? "Fetching…"
          : "",
  });

  const body = document.createElement("div");
  body.className = "web-body";

  if (!String(output || "").trim()) {
    const empty = document.createElement("div");
    empty.className = "web-empty";
    empty.textContent = cardRef?.status === "running" ? "Fetching…" : "No content yet";
    if (urls.length) {
      const pending = document.createElement("div");
      pending.className = "web-fetch-urls";
      for (const u of urls.slice(0, 5)) {
        const chip = document.createElement("div");
        chip.className = "web-fetch-url";
        chip.textContent = u;
        chip.title = u;
        pending.appendChild(chip);
      }
      body.append(empty, pending);
    } else {
      body.appendChild(empty);
    }
    pane.appendChild(body);
    return;
  }

  if (!data) {
    const pre = document.createElement("pre");
    pre.className = "web-raw";
    const { visible, rest, truncated } = softTruncate(output, 8000);
    pre.textContent = visible;
    body.appendChild(pre);
    pane.appendChild(body);
    if (truncated) attachShowMore(pane, rest);
    return;
  }

  if (!pages.length) {
    const empty = document.createElement("div");
    empty.className = "web-empty";
    empty.textContent = "No page content returned.";
    body.appendChild(empty);
  }

  for (const page of pages.slice(0, 5)) {
    const card = document.createElement("article");
    card.className = "web-page";

    const head = document.createElement("div");
    head.className = "web-page-header";

    const title = document.createElement("div");
    title.className = "web-page-title";
    title.textContent = page.title || hostnameFromUrl(page.url) || "Page";

    const link = document.createElement("a");
    link.className = "web-page-url";
    const href = String(page.url || "").trim();
    link.textContent = href || "—";
    if (href) {
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    head.append(title, link);
    card.appendChild(head);

    const content = String(page.content || "").trim();
    if (content) {
      const { visible, rest, truncated } = softTruncate(content, 8000);
      const prose = document.createElement("div");
      prose.className = "web-page-content md";
      prose.innerHTML = renderMarkdown(visible);
      card.appendChild(prose);
      if (truncated) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "web-show-more";
        more.textContent = "Show more";
        more.addEventListener("click", () => {
          prose.innerHTML = renderMarkdown(content);
          more.remove();
        });
        card.appendChild(more);
      }
    }

    body.appendChild(card);
  }

  for (const err of errors.slice(0, 5)) {
    const errEl = document.createElement("div");
    errEl.className = "web-error";
    const msg =
      typeof err === "string"
        ? err
        : err?.message || err?.error || JSON.stringify(err);
    errEl.textContent = msg;
    body.appendChild(errEl);
  }

  pane.appendChild(body);
}

export function webActionVerbs(name) {
  if (name === "web_fetch") return { running: "Fetching", done: "Fetched" };
  return { running: "Searching", done: "Searched" };
}

export function formatWebTarget(name, args, limit = 96) {
  if (name === "web_fetch") {
    const urls = Array.isArray(args?.urls)
      ? args.urls
      : args?.url
        ? [args.url]
        : [];
    if (!urls.length) return "";
    const first = String(urls[0]);
    const host = hostnameFromUrl(first) || first;
    const label = urls.length > 1 ? `${host} (+${urls.length - 1})` : host;
    return label.length > limit ? `${label.slice(0, limit - 1)}…` : label;
  }
  // Prefer the search query parameter; purpose is a soft fallback while streaming.
  const query = firstNonEmpty(args?.query, args?.q, args?.purpose) || "";
  if (!query) return "";
  const clipped =
    query.length > limit ? `${query.slice(0, limit - 1)}…` : query;
  return `"${clipped}"`;
}

/** Live Searching / Fetching activity row for TinyFish web tools. */
export function syncWebActivity(turnRef, cardRef) {
  if (!turnRef?.timeline || !cardRef || !isWebTool(cardRef.name)) return null;

  const verbs = webActionVerbs(cardRef.name);
  const resolved = resolveToolArgs({
    args: cardRef.args,
    argsText: cardRef.argsText,
  });
  const target = formatWebTarget(cardRef.name, resolved);
  const done =
    cardRef.status === "done" ||
    cardRef.status === "error" ||
    cardRef.status === "cancelled";
  const key = `web-action:${cardRef.id}`;

  let el = cardRef.activityEl;
  if (!isInTree(el, turnRef.timeline)) {
    const existing = turnRef.activityLabels?.get(key);
    el = isInTree(existing?.el, turnRef.timeline) ? existing.el : null;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "activity-row activity-label web-action-label";
    if (cardRef.el?.parentNode === turnRef.timeline) {
      turnRef.timeline.insertBefore(el, cardRef.el);
    } else {
      turnRef.timeline.appendChild(el);
    }
    if (!turnRef.activityLabels) turnRef.activityLabels = new Map();
    turnRef.activityLabels.set(key, { el, text: "" });
    releaseCurrentTextBlock(turnRef);
  }

  cardRef.activityEl = el;
  cardRef.activityKey = key;
  if (!turnRef.activityLabels) turnRef.activityLabels = new Map();
  turnRef.activityLabels.set(key, { el, text: done ? verbs.done : verbs.running });

  let verbEl = el.querySelector(".web-action-verb");
  let nameEl = el.querySelector(".web-action-name");
  if (!verbEl || !nameEl || !el.contains(verbEl) || !el.contains(nameEl)) {
    el.textContent = "";
    verbEl = document.createElement("span");
    verbEl.className = "activity-verb web-action-verb";
    nameEl = document.createElement("span");
    nameEl.className = "activity-name web-action-name";
    el.append(verbEl, document.createTextNode(" "), nameEl);
  }

  verbEl.textContent = done ? verbs.done : verbs.running;
  verbEl.classList.toggle("is-shimmer", !done);
  nameEl.hidden = !target;
  nameEl.textContent = target;
  el.classList.toggle("is-running", !done);
  el.title = target
    ? `${done ? verbs.done : verbs.running} ${target}`
    : done
      ? verbs.done
      : verbs.running;

  bindActivityCardToggle(el, cardRef);
  return el;
}

export function renderTaskBody(pane, args, output) {
  clearElement(pane);
  pane.className = "tool-pane tool-task";

  const desc = document.createElement("div");
  desc.className = "task-desc";
  desc.textContent =
    args?.description || args?.task || args?.prompt || "Subagent task";
  pane.appendChild(desc);

  if (args?.subagent_type || args?.agent) {
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = `agent: ${args.subagent_type || args.agent}`;
    pane.appendChild(meta);
  }

  if (output) {
    const pre = document.createElement("pre");
    pre.className = "task-output";
    const { visible, rest, truncated } = softTruncate(output, 5000);
    pre.textContent = visible;
    pane.appendChild(pre);
    if (truncated) attachShowMore(pane, rest);
  }
}

export function renderGenericBody(pane, args, output) {
  clearElement(pane);
  pane.className = "tool-pane tool-generic";

  if (args && Object.keys(args).length) {
    const argsPre = document.createElement("pre");
    argsPre.className = "tool-generic-pre";
    argsPre.textContent = JSON.stringify(args, null, 2);
    pane.appendChild(argsPre);
  }

  if (output != null && String(output).length) {
    const outPre = document.createElement("pre");
    outPre.className = "tool-generic-pre result";
    const { visible, rest, truncated } = softTruncate(output, 6000);
    outPre.textContent = visible;
    pane.appendChild(outPre);
    if (truncated) attachShowMore(pane, rest);
  }
}

export function fillToolPane(cardRef, { args, output, argsText, images } = {}) {
  const name = cardRef.name;
  const pane = cardRef.pane;
  const a = args || cardRef.args || {};
  const text = argsText || cardRef.argsText || "";
  const imgs = images || cardRef.images || [];

  switch (name) {
    case "execute": {
      // Prefer the longer of live buffer vs final output so neither path wipes the other.
      const live = cardRef.streamedOutput || "";
      const final = output != null ? String(output) : "";
      const body =
        final && final.length >= live.length ? final : live || final;
      renderTerminalBody(pane, a, body, cardRef);
      break;
    }
    case "write_file": {
      const resolved = resolveToolArgs({ args: a, argsText: text });
      renderEditorBody(pane, {
        path: resolved.file_path || resolved.path,
        content: resolved.content ?? a.content ?? output,
        mode: "write",
      });
      break;
    }
    case "edit_file": {
      const resolved = resolveToolArgs({ args: a, argsText: text });
      renderDiffBody(pane, resolved);
      if (output) {
        const note = document.createElement("div");
        note.className = "diff-result-note";
        note.textContent = String(output).slice(0, 200);
        pane.appendChild(note);
      }
      break;
    }
    case "read_file":
      renderEditorBody(pane, {
        path: a.file_path || a.path,
        content: output || a.content || "",
        mode: "read",
      });
      break;
    case "ls":
    case "glob":
      renderListBody(pane, output, name === "glob" ? "No matches" : "Empty directory");
      break;
    case "grep":
      renderGrepBody(pane, a, output);
      break;
    case "web_search":
      renderWebSearchBody(pane, a, output, cardRef);
      break;
    case "web_fetch":
      renderWebFetchBody(pane, a, output, cardRef);
      break;
    case "write_todos":
      renderTodosBody(pane, a, output, text);
      break;
    case "task":
      renderTaskBody(pane, a, output);
      break;
    case "browser_take_screenshot":
      clearElement(pane);
      pane.className = "tool-pane tool-generic";
      if (output) {
        const note = document.createElement("div");
        note.className = "tool-empty";
        note.textContent = String(output);
        pane.appendChild(note);
      }
      renderImages(pane, imgs);
      if (!imgs.length && a && Object.keys(a).length) {
        renderGenericBody(pane, a, output);
      }
      break;
    default:
      renderGenericBody(pane, a, output);
      renderImages(pane, imgs);
  }
  cardRef._paneFilledOnce = true;
}

const TOOL_PANE_THROTTLE_MS = 100;

/** Throttle expensive pane rebuilds while tool args are still streaming. */
export function scheduleFillToolPane(cardRef, opts = {}) {
  if (!cardRef) return;
  cardRef._pendingPaneOpts = {
    ...(cardRef._pendingPaneOpts || {}),
    ...opts,
  };

  // First paint is immediate so the card isn't empty.
  if (!cardRef._paneFilledOnce) {
    const first = cardRef._pendingPaneOpts;
    cardRef._pendingPaneOpts = null;
    fillToolPane(cardRef, first);
    return;
  }

  if (cardRef._paneFlushTimer) return;
  cardRef._paneFlushTimer = setTimeout(() => {
    cardRef._paneFlushTimer = 0;
    const pending = cardRef._pendingPaneOpts;
    cardRef._pendingPaneOpts = null;
    if (pending) fillToolPane(cardRef, pending);
  }, TOOL_PANE_THROTTLE_MS);
}

export function flushScheduledToolPane(cardRef) {
  if (!cardRef) return;
  if (cardRef._paneFlushTimer) {
    clearTimeout(cardRef._paneFlushTimer);
    cardRef._paneFlushTimer = 0;
  }
  const pending = cardRef._pendingPaneOpts;
  cardRef._pendingPaneOpts = null;
  if (pending) fillToolPane(cardRef, pending);
}

export function attachToolRetry(cardRef, conversationId) {
  if (!cardRef?.el) return;
  cardRef.el.querySelector(".tool-actions")?.remove();
  if (cardRef.status !== "error") return;

  const actions = document.createElement("div");
  actions.className = "tool-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "turn-retry-btn";
  btn.textContent = "Retry tool";
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const name = cardRef.name || "tool";
    const detail = cardRef.output
      ? `\n\nPrevious error:\n${String(cardRef.output).slice(0, 500)}`
      : "";
    import("./chat.js")
      .then(({ submitPromptText }) =>
        submitPromptText(
          `The tool \`${name}\` failed. Please retry it.${detail}`,
          { conversationId }
        )
      )
      .catch((error) => console.error(error));
  });
  actions.appendChild(btn);
  cardRef.el.appendChild(actions);
}

export function updateToolCardHeader(cardRef) {
  const title = toolTitle(cardRef.name, cardRef.args, cardRef.argsText);
  const keepFullTitle =
    cardRef.name === "execute" ||
    cardRef.name === "web_search" ||
    cardRef.name === "web_fetch";
  const short = keepFullTitle
    ? title.length > 72
      ? `${title.slice(0, 72)}…`
      : title
    : basenamePath(title);

  const activityChrome =
    isFileActionTool(cardRef.name) ||
    cardRef.name === "execute" ||
    isWebTool(cardRef.name);
  cardRef.el?.classList.toggle("has-activity-chrome", activityChrome);
  cardRef.el?.classList.toggle("is-running", cardRef.status === "running");

  if (cardRef.name === "execute") {
    // Collapsible terminal header: >_ + command (summary stays visible when closed).
    cardRef.labelEl.textContent = "";
    cardRef.labelEl.className = "tool-kind";
    cardRef.labelEl.setAttribute("aria-hidden", "true");
    if (cardRef.statusEl) cardRef.statusEl.hidden = true;
    syncTerminalSummaryTitle(
      cardRef,
      cardRef.args?.command || cardRef.argsText || short || "Terminal"
    );
  } else if (isWebTool(cardRef.name)) {
    cardRef.labelEl.textContent = "";
    cardRef.labelEl.className = "tool-kind";
    cardRef.labelEl.setAttribute("aria-hidden", "true");
    if (cardRef.statusEl) cardRef.statusEl.hidden = true;
    const resolved = resolveToolArgs({
      args: cardRef.args,
      argsText: cardRef.argsText,
    });
    syncWebSummary(cardRef, {
      title:
        cardRef.name === "web_fetch"
          ? formatWebTarget(cardRef.name, resolved, 72) || short || "Fetch"
          : firstNonEmpty(resolved.query, resolved.q) || short || "Search",
    });
  } else if (activityChrome) {
    // Activity row owns the verb + path; hide orphan status-only summary.
    cardRef.labelEl.textContent = "";
    cardRef.labelEl.className = "tool-kind";
    cardRef.labelEl.setAttribute("aria-hidden", "true");
    cardRef.titleEl.textContent = "";
    if (cardRef.statusEl) cardRef.statusEl.hidden = false;
  } else {
    cardRef.labelEl.textContent = toolLabel(cardRef.name, cardRef.status);
    cardRef.labelEl.className = "tool-kind";
    cardRef.labelEl.removeAttribute("aria-hidden");
    cardRef.titleEl.textContent = short;
    if (cardRef.statusEl) cardRef.statusEl.hidden = false;
  }
  if (cardRef.name !== "execute" && !isWebTool(cardRef.name)) {
    cardRef.titleEl.title = title;
  }

  cardRef.statusEl.className = `tool-status status-${cardRef.status}`;
  if (cardRef.status === "running") {
    cardRef.statusEl.textContent = "";
    cardRef.statusEl.classList.add("spin");
    cardRef.statusEl.setAttribute("aria-label", "Running");
  } else if (cardRef.status === "done") {
    cardRef.statusEl.textContent = "·";
    cardRef.statusEl.classList.remove("spin");
    cardRef.statusEl.setAttribute("aria-label", "Done");
  } else if (cardRef.status === "cancelled") {
    cardRef.statusEl.textContent = "–";
    cardRef.statusEl.classList.remove("spin");
    cardRef.statusEl.setAttribute("aria-label", "Cancelled");
  } else if (cardRef.status === "error") {
    cardRef.statusEl.textContent = "!";
    cardRef.statusEl.classList.remove("spin");
    cardRef.statusEl.setAttribute("aria-label", "Error");
  }
}

/** Let the activity row expand/collapse the paired tool card (no orphan status pill). */
function bindActivityCardToggle(el, cardRef) {
  if (!el || !cardRef?.el || el._toolToggleBound) return;
  el._toolToggleBound = true;
  el.classList.add("is-toggle");
  el.classList.toggle("is-expanded", Boolean(cardRef.el.open));
  el.title = `${el.title || "Tool"} — click to show or hide details`;
  el.addEventListener("click", () => {
    if (!cardRef.el) return;
    cardRef.el.open = !cardRef.el.open;
    el.classList.toggle("is-expanded", cardRef.el.open);
  });
  if (!cardRef.el._activityToggleSync) {
    cardRef.el._activityToggleSync = true;
    cardRef.el.addEventListener("toggle", () => {
      el.classList.toggle("is-expanded", Boolean(cardRef.el.open));
    });
  }
}

/**
 * Read / search / list / web look-ups — grouped into Exploring / Explored.
 * Terminal (execute) and edit/create (write_file, edit_file) stay as their own rows/cards.
 */
const GROUPED_EXPLORE_TOOLS = new Set([
  "ls",
  "glob",
  "grep",
  "read_file",
  "web_search",
  "web_fetch",
]);

export function isGroupedExploreTool(name) {
  return GROUPED_EXPLORE_TOOLS.has(String(name || "").trim());
}

export function isBlankTimelineText(el) {
  if (!el) return true;
  if (String(el._raw || "").trim()) return false;
  return !String(el.textContent || "").trim();
}

/** Drop the open text segment if it never received real content (avoids flex gaps). */
export function releaseCurrentTextBlock(turnRef) {
  flushPendingStream({ turnRef });
  const block = turnRef?.currentTextBlock;
  const root = turnRef?.timeline || turnRef?.turn;
  if (isInTree(block, root) && isBlankTimelineText(block)) {
    block.remove();
  }
  if (turnRef) turnRef.currentTextBlock = null;
}

/** Remove blank text / empty thinking ghosts that create uneven timeline gaps. */
export function pruneEmptyTimelineNodes(turnRef) {
  if (!turnRef?.timeline) return;
  for (const child of [...turnRef.timeline.children]) {
    if (child.classList.contains("timeline-text") && isBlankTimelineText(child)) {
      child.remove();
      continue;
    }
    if (child.classList.contains("thinking-panel")) {
      const raw = String(
        child._thinkingRaw ||
          child.querySelector?.(".thinking-content")?.textContent ||
          ""
      ).trim();
      if (!raw) {
        child.remove();
        if (turnRef.thinkingPanel === child) {
          turnRef.thinkingPanel = null;
          turnRef.thinkingSummary = null;
          turnRef.thinkingLabel = null;
          turnRef.thinkingContent = null;
          turnRef.thinkingRaw = "";
          turnRef.thinkingFrozen = false;
        }
      }
      continue;
    }
    if (
      child.classList.contains("explore-group") &&
      !child.querySelector?.(".explore-item") &&
      !child.querySelector?.(".thinking-panel")
    ) {
      child.remove();
    }
  }
}

export function ensureActivityLabel(turnRef, text, { key = null } = {}) {
  if (!turnRef?.timeline || !text) return null;

  if (key && turnRef.activityLabels?.has(key)) {
    const existing = turnRef.activityLabels.get(key);
    if (existing?.el) {
      existing.el.textContent = text;
      existing.text = text;
      return existing.el;
    }
  }

  const el = document.createElement("div");
  el.className = "activity-label";
  el.textContent = text;
  turnRef.timeline.appendChild(el);

  if (!turnRef.activityLabels) turnRef.activityLabels = new Map();
  if (key) turnRef.activityLabels.set(key, { el, text });
  releaseCurrentTextBlock(turnRef);
  return el;
}

/**
 * Live "Editing filename" / "Creating filename" label that flips to Edited/Created.
 * Verb shimmers while running; filename stays solid (same pattern as Exploring items).
 */
export function syncFileActionActivity(turnRef, cardRef) {
  if (!turnRef?.timeline || !cardRef || !isFileActionTool(cardRef.name)) return null;

  const verbs = fileActionVerbs(cardRef.name);
  if (!verbs) return null;

  const resolved = resolveToolArgs({
    args: cardRef.args,
    argsText: cardRef.argsText,
  });
  const path = firstNonEmpty(resolved.file_path, resolved.path);
  const filename = basenamePath(path) || "";
  const done =
    cardRef.status === "done" ||
    cardRef.status === "error" ||
    cardRef.status === "cancelled";
  const key = `file-action:${cardRef.id}`;

  let el = cardRef.activityEl;
  if (!isInTree(el, turnRef.timeline)) {
    const existing = turnRef.activityLabels?.get(key);
    el = isInTree(existing?.el, turnRef.timeline) ? existing.el : null;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "activity-row activity-label file-action-label";
    // Insert just before the tool card when possible so label + card stay paired.
    if (cardRef.el?.parentNode === turnRef.timeline) {
      turnRef.timeline.insertBefore(el, cardRef.el);
    } else {
      turnRef.timeline.appendChild(el);
    }
    if (!turnRef.activityLabels) turnRef.activityLabels = new Map();
    turnRef.activityLabels.set(key, { el, text: "" });
    releaseCurrentTextBlock(turnRef);
  }

  cardRef.activityEl = el;
  cardRef.activityKey = key;
  if (!turnRef.activityLabels) turnRef.activityLabels = new Map();
  turnRef.activityLabels.set(key, { el, text: done ? verbs.done : verbs.running });

  let verbEl = el.querySelector(".file-action-verb");
  let nameEl = el.querySelector(".file-action-name");
  if (!verbEl || !nameEl || !el.contains(verbEl) || !el.contains(nameEl)) {
    el.textContent = "";
    verbEl = document.createElement("span");
    verbEl.className = "activity-verb file-action-verb";
    nameEl = document.createElement("span");
    nameEl.className = "activity-name file-action-name";
    el.append(verbEl, document.createTextNode(" "), nameEl);
  }

  if (done) {
    verbEl.textContent = verbs.done;
    verbEl.classList.remove("is-shimmer");
    nameEl.hidden = !filename;
    nameEl.textContent = filename;
    el.classList.remove("is-running");
    el.title = path || `${verbs.done}${filename ? ` ${filename}` : ""}`;
  } else {
    verbEl.textContent = verbs.running;
    verbEl.classList.add("is-shimmer");
    nameEl.hidden = !filename;
    nameEl.textContent = filename;
    el.classList.add("is-running");
    el.title = path || `${verbs.running}${filename ? ` ${filename}` : ""}`;
  }

  bindActivityCardToggle(el, cardRef);
  return el;
}

/**
 * Live "Running command" / "Ran command" activity row for shell tools.
 * Matches the Editing / Exploring verb+target pattern.
 */
export function syncExecuteActivity(turnRef, cardRef) {
  if (!turnRef?.timeline || !cardRef || cardRef.name !== "execute") return null;

  const verbs = executeActionVerbs();
  const resolved = resolveToolArgs({
    args: cardRef.args,
    argsText: cardRef.argsText,
  });
  const command = firstNonEmpty(resolved.command, resolved.cmd);
  const target = formatExecuteTarget(command);
  const done =
    cardRef.status === "done" ||
    cardRef.status === "error" ||
    cardRef.status === "cancelled";
  const key = `execute-action:${cardRef.id}`;

  let el = cardRef.activityEl;
  if (!isInTree(el, turnRef.timeline)) {
    const existing = turnRef.activityLabels?.get(key);
    el = isInTree(existing?.el, turnRef.timeline) ? existing.el : null;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "activity-row activity-label execute-action-label";
    if (cardRef.el?.parentNode === turnRef.timeline) {
      turnRef.timeline.insertBefore(el, cardRef.el);
    } else {
      turnRef.timeline.appendChild(el);
    }
    if (!turnRef.activityLabels) turnRef.activityLabels = new Map();
    turnRef.activityLabels.set(key, { el, text: "" });
    releaseCurrentTextBlock(turnRef);
  }

  cardRef.activityEl = el;
  cardRef.activityKey = key;
  if (!turnRef.activityLabels) turnRef.activityLabels = new Map();
  turnRef.activityLabels.set(key, { el, text: done ? verbs.done : verbs.running });

  let verbEl = el.querySelector(".execute-action-verb");
  let nameEl = el.querySelector(".execute-action-name");
  if (!verbEl || !nameEl || !el.contains(verbEl) || !el.contains(nameEl)) {
    el.textContent = "";
    verbEl = document.createElement("span");
    verbEl.className = "activity-verb execute-action-verb";
    nameEl = document.createElement("span");
    nameEl.className = "activity-name execute-action-name";
    el.append(verbEl, document.createTextNode(" "), nameEl);
  }

  verbEl.textContent = done ? verbs.done : verbs.running;
  verbEl.classList.toggle("is-shimmer", !done);
  nameEl.hidden = !target;
  nameEl.textContent = target;
  el.classList.toggle("is-running", !done);
  el.title = command || `${done ? verbs.done : verbs.running}${target ? ` ${target}` : ""}`;
  bindActivityCardToggle(el, cardRef);
  return el;
}

/** @deprecated Use syncFileActionActivity via tool cards. Kept for any stray callers. */
export function noteToolActivity(turnRef, toolName) {
  if (!turnRef || !isFileActionTool(toolName)) return;
  syncFileActionActivity(turnRef, {
    id: `legacy-${toolName}`,
    name: toolName,
    args: {},
    argsText: "",
    status: "running",
  });
}

/** True when the timeline already shows live activity (hide bottom status). */
export function turnHasLiveTimelineActivity(turnRef) {
  if (!turnRef) return false;
  if (hasActiveExploreGroup(turnRef)) return true;
  if (
    turnRef.thinkingPanel &&
    !turnRef.thinkingFrozen &&
    !turnRef.thinkingPanel.hidden &&
    turnRef.thinkingSummary?.classList.contains("is-streaming")
  ) {
    return true;
  }
  if (turnRef.approvalCards?.size) {
    for (const card of turnRef.approvalCards.values()) {
      if (card?.status === "pending") return true;
    }
  }
  if (turnRef.toolCards) {
    for (const card of turnRef.toolCards.values()) {
      if (card?.status === "running") return true;
    }
  }
  return false;
}

export function hasActiveExploreGroup(turnRef) {
  const group = turnRef?.activeExploreGroup;
  return Boolean(group && !group.finalized);
}

function freezeThinkingQuietly(turnRef) {
  sealThinkingSegment(turnRef, { quietly: true });
}

/** Trailing Thought panels at the end of the timeline (before a new Exploring group). */
function collectTrailingThinkingPanels(timeline) {
  if (!timeline) return [];
  const panels = [];
  for (let i = timeline.children.length - 1; i >= 0; i--) {
    const child = timeline.children[i];
    if (child.classList?.contains("thinking-panel")) {
      panels.unshift(child);
      continue;
    }
    if (
      child.classList?.contains("timeline-text") &&
      isBlankTimelineText(child)
    ) {
      continue;
    }
    break;
  }
  return panels;
}

export function prepareExploreTurnChrome(turnRef) {
  if (!turnRef) return;
  flushPendingStream({ turnRef });
  turnRef._textStreamReady = false;
  ensureWorkSummary(turnRef);
  freezeThinkingQuietly(turnRef);
  turnRef.thinkingSuppressedForExplore = false;
  pinTurnBottomChrome(turnRef);
}

function syncExploreGroupHeader(group) {
  if (!group?.labelEl) return;
  const count = group.items?.length || 0;
  if (group.finalized) {
    group.labelEl.textContent =
      count === 1 ? "Explored · 1 item" : `Explored · ${count} items`;
    group.labelEl.classList.remove("is-shimmer");
    group.el?.classList.remove("is-exploring");
  } else {
    group.labelEl.textContent = "Exploring";
    group.labelEl.classList.add("is-shimmer");
    group.el?.classList.add("is-exploring");
  }
}

function createExploreGroupShell({ open = true } = {}) {
  const root = document.createElement("details");
  root.className = "disclosure-block explore-group";
  root.open = open;

  const summary = document.createElement("summary");
  summary.className = "disclosure-summary explore-group-summary";

  const labelEl = document.createElement("span");
  labelEl.className = "disclosure-label explore-group-label";
  labelEl.textContent = "Exploring";
  summary.appendChild(labelEl);

  const body = document.createElement("div");
  body.className = "explore-group-body";

  root.append(summary, body);
  return { root, labelEl, body, summary };
}

export function ensureActiveExploreGroup(turnRef) {
  if (!turnRef?.timeline) return null;
  if (hasActiveExploreGroup(turnRef)) return turnRef.activeExploreGroup;

  prepareExploreTurnChrome(turnRef);

  const trailingThoughts = collectTrailingThinkingPanels(turnRef.timeline);
  const { root, labelEl, body } = createExploreGroupShell({ open: true });
  for (const panel of trailingThoughts) {
    body.appendChild(panel);
  }
  root.classList.add("is-exploring");
  labelEl.classList.add("is-shimmer");
  turnRef.timeline.appendChild(root);

  const group = {
    el: root,
    labelEl,
    body,
    items: [],
    itemMap: new Map(),
    finalized: false,
  };

  if (!turnRef.exploreGroups) turnRef.exploreGroups = [];
  turnRef.exploreGroups.push(group);
  turnRef.activeExploreGroup = group;
  releaseCurrentTextBlock(turnRef);
  return group;
}

export function finalizeExploreGroup(turnRef, group = null) {
  if (!turnRef) return;
  const target = group || turnRef.activeExploreGroup;
  if (!target || target.finalized) {
    if (turnRef.activeExploreGroup === target) turnRef.activeExploreGroup = null;
    return;
  }

  for (const item of target.items) {
    if (item.status === "running") item.status = "done";
    updateExploreItem(item, { status: item.status });
  }

  target.finalized = true;
  // Collapse by default; click summary to expand Reading lines.
  if (target.el) target.el.open = false;
  syncExploreGroupHeader(target);

  if (turnRef.activeExploreGroup === target) turnRef.activeExploreGroup = null;
  turnRef.thinkingSuppressedForExplore = false;
}

export function updateExploreItem(item, { args, argsText, status, name, conversationId } = {}) {
  if (!item) return;
  if (name) item.name = name;
  if (conversationId) item.conversationId = conversationId;
  if (argsText) item.argsText = argsText;
  if (args && typeof args === "object") {
    item.args = mergeToolArgObjects(item.args, args);
  }
  if (status) item.status = status;

  const resolved = resolveToolArgs({
    args: item.args,
    argsText: item.argsText,
  });
  item.args = mergeToolArgObjects(item.args, resolved);

  const cid = item.conversationId || conversationId || state.activeConversationId;
  const done =
    item.status === "done" ||
    item.status === "error" ||
    item.status === "cancelled";
  const parts = exploreItemParts(
    item.name,
    { args: item.args, argsText: item.argsText },
    cid,
    { done }
  );

  // Keep verb + filename as separate nodes so shimmer never hides the name.
  let verbEl = item.verbEl;
  let nameEl = item.nameEl;
  if (!verbEl || !nameEl || !item.el.contains(verbEl) || !item.el.contains(nameEl)) {
    item.el.textContent = "";
    verbEl = document.createElement("span");
    verbEl.className = "activity-verb explore-item-verb";
    nameEl = document.createElement("span");
    nameEl.className = "activity-name explore-item-name";
    item.el.append(verbEl, document.createTextNode(" "), nameEl);
    item.verbEl = verbEl;
    item.nameEl = nameEl;
  }

  verbEl.textContent = parts.verb;
  nameEl.textContent = parts.target;
  nameEl.hidden = !parts.target;
  nameEl.classList.toggle("is-query", Boolean(parts.isQuery));
  item.el.title = parts.fullPath || `${parts.verb} ${parts.target}`;
  item.el.classList.toggle("has-target", Boolean(parts.target));

  if (item.status === "running") {
    item.el.classList.add("is-running");
    verbEl.classList.add("is-shimmer");
    nameEl.classList.remove("is-shimmer");
  } else {
    item.el.classList.remove("is-running");
    verbEl.classList.remove("is-shimmer");
    nameEl.classList.remove("is-shimmer");
  }
}

export function createExploreItem(group, event, turnRef = null) {
  const name = String(event.name || "").trim();
  const id =
    event.id != null && String(event.id).trim()
      ? String(event.id)
      : `${name}-${Date.now()}`;

  const el = document.createElement("div");
  el.className = "activity-row explore-item is-running";
  el.dataset.toolId = id;

  const resolved = resolveToolArgs(event);
  const item = {
    id,
    name,
    args: resolved,
    argsText: event.argsText || "",
    status: "running",
    el,
    verbEl: null,
    nameEl: null,
    output: null,
    conversationId: turnRef?.conversationId || state.activeConversationId,
  };
  updateExploreItem(item);
  group.body.appendChild(el);
  group.items.push(item);
  group.itemMap.set(id, item);
  syncExploreGroupHeader(group);
  return item;
}

export function upsertExploreTool(turnRef, event) {
  if (!turnRef) return null;
  const name = String(event.name || "").trim();
  if (!isGroupedExploreTool(name)) return null;

  const group = ensureActiveExploreGroup(turnRef);
  if (!group) return null;

  const eventId =
    event.id != null && String(event.id).trim() ? String(event.id) : "";
  let item = eventId ? group.itemMap.get(eventId) : null;

  if (!item) {
    // Match a still-running item with the same tool when id arrives late.
    item = group.items.find(
      (entry) =>
        entry.status === "running" &&
        entry.name === name &&
        (!eventId || entry.id.startsWith(`${name}-`))
    );
    if (item && eventId && item.id !== eventId) {
      group.itemMap.delete(item.id);
      item.id = eventId;
      item.el.dataset.toolId = eventId;
      group.itemMap.set(eventId, item);
    }
  }

  if (!item) {
    item = createExploreItem(
      group,
      { ...event, id: eventId || undefined, name },
      turnRef
    );
  } else {
    updateExploreItem(item, {
      name,
      args: event.args,
      argsText: event.argsText,
      status: "running",
      conversationId: turnRef.conversationId,
    });
  }

  return item;
}

export function completeExploreTool(turnRef, event) {
  if (!turnRef) return null;
  const name = String(event.name || "").trim();
  const id = String(event.id || "");

  // Prefer the active group, then search all groups.
  const groups = [];
  if (turnRef.activeExploreGroup) groups.push(turnRef.activeExploreGroup);
  if (Array.isArray(turnRef.exploreGroups)) {
    for (const g of turnRef.exploreGroups) {
      if (!groups.includes(g)) groups.push(g);
    }
  }

  let item = null;
  let group = null;
  for (const g of groups) {
    if (id && g.itemMap.has(id)) {
      item = g.itemMap.get(id);
      group = g;
      break;
    }
  }
  if (!item) {
    for (const g of groups) {
      const match = g.items.find(
        (entry) => entry.status === "running" && (!name || entry.name === name)
      );
      if (match) {
        item = match;
        group = g;
        break;
      }
    }
  }

  if (!item) {
    // Result arrived before/without a call — start a group and add the item.
    if (!isGroupedExploreTool(name)) return null;
    group = ensureActiveExploreGroup(turnRef);
    item = createExploreItem(
      group,
      {
        id: id || undefined,
        name,
        args: event.args || {},
        argsText: event.argsText || "",
      },
      turnRef
    );
  }

  if (isGroupedExploreTool(name)) item.name = name;
  item.output = event.output ?? null;
  updateExploreItem(item, {
    args: event.args,
    argsText: event.argsText,
    status:
      event.status === "error"
        ? "error"
        : event.status === "cancelled"
          ? "cancelled"
          : "done",
    conversationId: turnRef.conversationId,
  });
  return item;
}

/** Restore a finalized explore group from persisted tool/thinking blocks. */
export function restoreExploreGroup(turnRef, blocks) {
  if (!turnRef || !blocks?.length) return null;
  ensureWorkSummary(turnRef);

  const { root, labelEl, body } = createExploreGroupShell({ open: false });
  turnRef.timeline.appendChild(root);

  const group = {
    el: root,
    labelEl,
    body,
    items: [],
    itemMap: new Map(),
    finalized: true,
  };

  for (const block of blocks) {
    const kind = String(block.kind || block.type || "").trim();
    if (kind === "thinking" || (!block.name && block.text)) {
      const text = String(block.text || "").trim();
      if (!text) continue;
      const panel = createSealedThinkingPanel(text, {
        startedAt: block.startedAt || 0,
      });
      body.appendChild(panel);
      if (!turnRef.thinkingSegments) turnRef.thinkingSegments = [];
      turnRef.thinkingSegments.push({
        el: panel,
        raw: text,
        startedAt: block.startedAt || 0,
      });
      continue;
    }

    const name = String(block.name || "").trim();
    if (!name || name === "tool") continue;
    const id = String(block.id || `${name}-${Date.now()}`);
    const el = document.createElement("div");
    el.className = "activity-row explore-item";
    el.dataset.toolId = id;
    const item = {
      id,
      name,
      args: resolveToolArgs(block),
      argsText: block.argsText || "",
      status: block.status || "done",
      el,
      verbEl: null,
      nameEl: null,
      output: block.output ?? null,
      conversationId: turnRef.conversationId || state.activeConversationId,
    };
    updateExploreItem(item);
    body.appendChild(el);
    group.items.push(item);
    group.itemMap.set(id, item);
  }

  syncExploreGroupHeader(group);
  if (!turnRef.exploreGroups) turnRef.exploreGroups = [];
  turnRef.exploreGroups.push(group);
  releaseCurrentTextBlock(turnRef);
  return group;
}

export function formatWorkedDuration(ms) {
  const totalSec = Math.max(0, Math.round(Number(ms) / 1000));
  if (totalSec < 60) return `Worked for ${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s ? `Worked for ${m}m ${s}s` : `Worked for ${m}m`;
}

export function ensureWorkSummary(turnRef) {
  if (!turnRef?.timeline) return null;
  if (turnRef.workSummary) return turnRef.workSummary;

  const details = document.createElement("details");
  details.className = "disclosure-block work-summary";
  details.open = true;

  const summary = document.createElement("summary");
  summary.className = "disclosure-summary work-summary-label";

  const title = document.createElement("span");
  title.className = "disclosure-label work-summary-title";
  title.textContent = "Working";
  summary.appendChild(title);

  const body = document.createElement("div");
  body.className = "work-summary-body";

  // Move existing timeline children into the collapsible body.
  const children = [...turnRef.timeline.childNodes];
  for (const child of children) body.appendChild(child);

  details.append(summary, body);
  turnRef.timeline.appendChild(details);

  // Redirect future appends into the body.
  turnRef.timelineHost = turnRef.timeline;
  turnRef.timeline = body;
  turnRef.workSummary = details;
  turnRef.workSummaryLabel = title;
  return details;
}

export function finalizeWorkSummary(turnRef) {
  if (!turnRef) return;
  const started = turnRef.startedAt || Date.now();
  const label = formatWorkedDuration(Date.now() - started);
  if (turnRef.workSummaryLabel) {
    turnRef.workSummaryLabel.textContent = label;
  }
  // Stay expanded so activity/tools remain visible; user can still collapse.
  if (turnRef.workSummary) {
    turnRef.workSummary.open = true;
  }
}

export function createToolCard(turnRef, event, { skipActivity = false } = {}) {
  const name = String(event.name || "").trim();
  if (!name || name === "tool") return null;

  // Explore tools render as grouped list items, not expandable cards.
  if (isGroupedExploreTool(name)) return null;

  // Starting a non-explore tool ends the current Exploring burst.
  finalizeExploreGroup(turnRef);

  flushPendingStream({ turnRef });
  turnRef._textStreamReady = false;
  turnRef._thinkingStreamReady = false;
  ensureWorkSummary(turnRef);
  // Seal the current thinking burst when tools begin; next thinking starts fresh.
  if (turnRef.thinkingRaw?.trim() && !turnRef.thinkingFrozen) {
    sealThinkingSegment(turnRef);
  } else {
    pinTurnBottomChrome(turnRef);
  }

  const details = document.createElement("details");
  details.className = `tool-card tool-${name}`;
  // Web search/fetch stay collapsed by default; other cards open to show live work.
  details.open = !isWebTool(name);
  details.dataset.toolId = String(event.id);

  const summary = document.createElement("summary");
  summary.className = "tool-summary";

  const statusEl = document.createElement("span");
  statusEl.className = "tool-status status-running spin";

  const labelEl = document.createElement("span");
  labelEl.className = "tool-kind";

  const titleEl = document.createElement("span");
  titleEl.className = "tool-title";

  if (name === "execute") {
    summary.className = "tool-summary term-header";
    const termIcon = document.createElement("span");
    termIcon.className = "term-header-icon";
    termIcon.setAttribute("aria-hidden", "true");
    termIcon.textContent = ">_";
    titleEl.className = "term-header-title";
    titleEl.textContent = "Terminal";
    const chevron = document.createElement("span");
    chevron.className = "term-header-chevron";
    chevron.setAttribute("aria-hidden", "true");
    statusEl.hidden = true;
    summary.append(termIcon, titleEl, labelEl, statusEl, chevron);
  } else if (isWebTool(name)) {
    summary.className = "tool-summary web-header";
    const webIcon = document.createElement("span");
    webIcon.className = "web-header-icon";
    webIcon.setAttribute("aria-hidden", "true");
    webIcon.textContent = name === "web_fetch" ? "↗" : "⌕";
    titleEl.className = "web-header-title";
    titleEl.textContent = name === "web_fetch" ? "Fetch" : "Search";
    const meta = document.createElement("span");
    meta.className = "web-header-meta";
    meta.hidden = true;
    const chevron = document.createElement("span");
    chevron.className = "web-header-chevron";
    chevron.setAttribute("aria-hidden", "true");
    statusEl.hidden = true;
    summary.append(webIcon, titleEl, meta, labelEl, statusEl, chevron);
  } else if (isFileActionTool(name)) {
    // Editor tab carries filename/badge; keep a compact status-only summary.
    summary.classList.add("tool-summary-compact");
    summary.append(statusEl, labelEl, titleEl);
  } else {
    summary.append(statusEl, labelEl, titleEl);
  }

  const pane = document.createElement("div");
  pane.className = "tool-pane";

  details.append(summary, pane);
  turnRef.timeline.appendChild(details);

  const resolvedArgs = resolveToolArgs({
    args: event.args || {},
    argsText: event.argsText || "",
  });

  const cardRef = {
    id: String(event.id),
    name,
    args: resolvedArgs,
    argsText: event.argsText || "",
    images: Array.isArray(event.images) ? event.images : [],
    status: "running",
    el: details,
    pane,
    labelEl,
    titleEl,
    statusEl,
    streamedOutput: "",
    termOutputEl: null,
    termCmdEl: null,
    termTitleEl: null,
    webTitleEl: isWebTool(name) ? titleEl : null,
    webMetaEl: isWebTool(name) ? summary.querySelector(".web-header-meta") : null,
    activityEl: null,
    activityKey: null,
  };

  updateToolCardHeader(cardRef);
  fillToolPane(cardRef, { args: cardRef.args, argsText: cardRef.argsText });

  if (!skipActivity && isFileActionTool(name)) {
    syncFileActionActivity(turnRef, cardRef);
  }
  if (!skipActivity && name === "execute") {
    syncExecuteActivity(turnRef, cardRef);
  }
  if (!skipActivity && isWebTool(name)) {
    syncWebActivity(turnRef, cardRef);
  }

  if (name === "execute" && turnRef.pendingShellOutput) {
    appendToolOutput(cardRef, turnRef.pendingShellOutput, { stream: "stdout" });
    turnRef.pendingShellOutput = "";
  }

  turnRef.toolCards.set(cardRef.id, cardRef);
  releaseCurrentTextBlock(turnRef);
  return cardRef;
}

export function removeToolCard(turnRef, card) {
  if (!turnRef || !card) return;
  turnRef.toolCards.delete(card.id);
  if (card.activityEl) {
    card.activityEl.remove();
    card.activityEl = null;
  }
  if (card.activityKey && turnRef.activityLabels) {
    turnRef.activityLabels.delete(card.activityKey);
  }
  card.el?.remove();
}

export function settleOpenToolCards(turnRef, { removeUnnamed = true } = {}) {
  if (!turnRef) return;
  if (turnRef.toolCards) {
    for (const card of [...turnRef.toolCards.values()]) {
      const unnamed = !card.name || card.name === "tool";
      if (removeUnnamed && unnamed) {
        removeToolCard(turnRef, card);
        continue;
      }
      if (card.status === "running") {
        card.status = "done";
        updateToolCardHeader(card);
        if (isFileActionTool(card.name)) {
          syncFileActionActivity(turnRef, card);
        }
        if (isWebTool(card.name)) {
          syncWebActivity(turnRef, card);
        }
        const keepOpen =
          isFileActionTool(card.name) || card.name === "execute";
        card.el.open = keepOpen;
        if (isWebTool(card.name) && card.activityEl) {
          card.activityEl.classList.toggle("is-expanded", false);
        }
      }
    }
  }
  finalizeExploreGroup(turnRef);
}

export function upsertToolCall(event, conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  if (!session) return;

  const toolName = String(event.name || "").trim();

  // Todos live in the right-side panel — skip chat cards (avoids stream thrash).
  if (toolName === "write_todos") {
    updateTodosFromToolEvent(conversationId, { ...event, name: "write_todos" });
    if (session.activeAgentTurn) {
      // Drop any placeholder card that was created before the name arrived.
      const turn = session.activeAgentTurn;
      const stray = findRunningCard(turn, event);
      if (stray) removeToolCard(turn, stray);
      turn.meta.hidden = true;
    }
    return;
  }

  // Ignore placeholder names from streaming ("tool") — they used to hijack real cards.
  if (!isRealToolName(toolName)) return;

  if (!session.activeAgentTurn) beginAgentTurn(conversationId);
  const turn = session.activeAgentTurn;

  // Read / search / list / web → compact Exploring group (no tool cards).
  if (isGroupedExploreTool(toolName)) {
    // Drop a stray card if one was created before the name resolved.
    const stray = findRunningCard(turn, event);
    if (stray) removeToolCard(turn, stray);
    upsertExploreTool(turn, event);
    turn.meta.hidden = true;
    if (conversationId === state.activeConversationId) scrollMessages();
    return;
  }

  const eventId = event.id != null && String(event.id).trim() ? String(event.id) : "";
  const id = eventId || `${toolName}-${Date.now()}`;
  let card = findRunningCard(turn, event);

  if (card) {
    // Only rekey when the model provides a real tool-call id.
    if (eventId && eventId !== String(card.id)) {
      rekeyCard(turn, card, eventId);
    }
  } else if (eventId && turn.toolCards.has(eventId)) {
    const existing = turn.toolCards.get(eventId);
    // Never revive a finished card for a new shell/tool invocation.
    if (existing?.status === "running") card = existing;
  }

  if (!card) {
    card = createToolCard(turn, { ...event, id, name: toolName });
    if (!card) return;
  }

  // Never overwrite a real name with a placeholder.
  if (isRealToolName(toolName)) card.name = toolName;
  if (event.argsText) card.argsText = event.argsText;

  if (event.args && Object.keys(event.args).length) {
    card.args = mergeToolArgObjects(card.args, event.args);
  }
  // Recover file_path early from streaming argsText so "Editing filename" appears ASAP.
  if (isFileActionTool(card.name) || isGroupedExploreTool(card.name) || card.argsText) {
    card.args = mergeToolArgObjects(
      card.args,
      resolveToolArgs({
        args: card.args,
        argsText: card.argsText,
      })
    );
  }

  card.status = "running";
  updateToolCardHeader(card);

  // For live terminals, update the command in place so streaming output isn't rebuilt away.
  if (toolName === "execute" && card.termOutputEl && card.pane?.contains(card.termOutputEl)) {
    updateTerminalCommand(card, card.args?.command || "");
  } else {
    scheduleFillToolPane(card, {
      args: card.args,
      argsText: card.argsText,
      output: card.streamedOutput || card.output,
    });
  }

  if (isFileActionTool(card.name)) {
    syncFileActionActivity(turn, card);
  }
  if (card.name === "execute") {
    syncExecuteActivity(turn, card);
  }
  if (isWebTool(card.name)) {
    syncWebActivity(turn, card);
  }

  if (toolName === "execute") {
    card.el.open = true;
    if (turn.pendingShellOutput) {
      appendToolOutput(card, turn.pendingShellOutput, { stream: "stdout" });
      turn.pendingShellOutput = "";
    }
  }

  turn.meta.hidden = true;
  if (conversationId === state.activeConversationId) scrollMessages();
}

export function appendExecuteOutput(event, conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  if (!session) return;

  // Shell chunks can arrive before the model streams a tool_call — open a turn/card.
  if (!session.activeAgentTurn) beginAgentTurn(conversationId);
  const turn = session.activeAgentTurn;
  let card = null;
  const id = String(event.id || "");
  if (id && turn.toolCards.has(id)) {
    card = turn.toolCards.get(id);
  }
  if (!card) {
    card = [...turn.toolCards.values()].find(
      (c) => c.name === "execute" && c.status === "running"
    );
  }

  const chunk = event.chunk || event.text || "";
  if (!card) {
    card = createToolCard(turn, {
      id: id || `execute-live-${Date.now()}`,
      name: "execute",
      args: event.command ? { command: String(event.command) } : {},
    });
    if (!card) {
      turn.pendingShellOutput = `${turn.pendingShellOutput || ""}${chunk}`;
      return;
    }
  }

  if (turn.pendingShellOutput) {
    appendToolOutput(card, turn.pendingShellOutput, { stream: "stdout" });
    turn.pendingShellOutput = "";
  }

  appendToolOutput(card, chunk, {
    stream: event.stream || "stdout",
  });
  card.el.open = true;
  if (conversationId === state.activeConversationId) scrollMessages();
}

export function completeToolResult(event, conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  if (!session) return;

  const toolName = String(event.name || "").trim();

  if (toolName === "write_todos") {
    updateTodosFromToolEvent(conversationId, { ...event, name: "write_todos" });
    if (session.activeAgentTurn) {
      const turn = session.activeAgentTurn;
      const stray = findRunningCard(turn, event);
      if (stray) removeToolCard(turn, stray);
      turn.meta.hidden = true;
    }
    return;
  }

  if (!session.activeAgentTurn) beginAgentTurn(conversationId);
  const turn = session.activeAgentTurn;

  if (isGroupedExploreTool(toolName)) {
    const stray = findRunningCard(turn, event);
    if (stray) removeToolCard(turn, stray);
    completeExploreTool(turn, {
      ...event,
      status: event.status === "error" ? "error" : session.isStopping ? "cancelled" : "done",
    });
    turn.meta.hidden = true;
    releaseCurrentTextBlock(turn);
    if (conversationId === state.activeConversationId) scrollMessages();
    return;
  }

  const id = String(event.id || "");
  let card = findRunningCard(turn, event);

  if (card) {
    rekeyCard(turn, card, id || card.id);
  } else if (id && turn.toolCards.has(id)) {
    card = turn.toolCards.get(id);
  }

  // No matching card and no usable name — ignore (don't spawn a "tool" ghost).
  if (!card && !isRealToolName(toolName)) return;

  if (!card) {
    card = createToolCard(turn, {
      id: id || `result-${Date.now()}`,
      name: toolName,
      args: event.args || {},
    });
    if (!card) return;
  }

  if (event.args && Object.keys(event.args).length) {
    card.args = mergeToolArgObjects(card.args, event.args);
  }
  if (event.argsText) card.argsText = event.argsText;
  if (isRealToolName(toolName)) card.name = toolName;
  if (isFileActionTool(card.name) || card.argsText) {
    card.args = mergeToolArgObjects(
      card.args,
      resolveToolArgs({
        args: card.args,
        argsText: card.argsText,
      })
    );
  }

  card.output = event.output ?? null;
  if (card.name === "execute" && card.output != null) {
    // Prefer authoritative final output for persistence/display.
    card.streamedOutput = String(card.output);
  }
  if (Array.isArray(event.images)) card.images = event.images;
  card.status =
    event.status === "error" ? "error" : session.isStopping ? "cancelled" : "done";
  updateToolCardHeader(card);
  flushScheduledToolPane(card);
  fillToolPane(card, {
    args: card.args,
    output: event.output,
    argsText: card.argsText,
    images: card.images,
  });
  attachToolRetry(card, conversationId);

  if (isFileActionTool(card.name)) {
    syncFileActionActivity(turn, card);
  }
  if (card.name === "execute") {
    syncExecuteActivity(turn, card);
  }
  if (isWebTool(card.name)) {
    syncWebActivity(turn, card);
  }

  // Keep file / terminal / image cards expanded; web tools stay collapsed.
  const keepOpen =
    isFileActionTool(card.name) ||
    card.name === "execute" ||
    card.name === "browser_take_screenshot" ||
    Boolean(card.images?.length) ||
    card.status === "error";
  card.el.open = keepOpen;
  if (isWebTool(card.name) && card.activityEl) {
    card.activityEl.classList.toggle("is-expanded", false);
  }

  turn.meta.hidden = true;
  releaseCurrentTextBlock(turn);
  if (conversationId === state.activeConversationId) scrollMessages();
}

function approvalDetailText(name, args) {
  const resolved = resolveToolArgs({ args: args || {} });
  if (name === "execute") {
    return firstNonEmpty(resolved.command, resolved.cmd) || "Shell command";
  }
  if (name === "write_file" || name === "edit_file") {
    return firstNonEmpty(resolved.file_path, resolved.path) || name;
  }
  try {
    return JSON.stringify(resolved, null, 2);
  } catch {
    return String(name || "tool");
  }
}

function approvalPromptFor(name) {
  if (name === "execute") return "OpenPilot wants to execute terminal command:";
  if (name === "write_file") return "OpenPilot wants to create a file:";
  if (name === "edit_file") return "OpenPilot wants to edit a file:";
  return `OpenPilot wants to run ${name || "tool"}:`;
}

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

function createApprovalShieldIcon() {
  const wrap = document.createElement("div");
  wrap.className = "approval-icon";
  wrap.setAttribute("aria-hidden", "true");

  const svg = createSvgEl("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 16 16",
    fill: "none",
  });
  const path = createSvgEl("path", {
    d: "M8 1.6 3.2 3.5v3.4c0 3.05 2.05 5.85 4.8 6.5 2.75-.65 4.8-3.45 4.8-6.5V3.5L8 1.6Z",
    stroke: "currentColor",
    "stroke-width": "1.35",
    "stroke-linejoin": "round",
  });
  const check = createSvgEl("path", {
    d: "M5.7 7.9 7.25 9.4 10.35 6.2",
    stroke: "currentColor",
    "stroke-width": "1.35",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.append(path, check);
  wrap.appendChild(svg);
  return wrap;
}

function removeApprovalCard(turn, card) {
  if (!turn || !card) return;
  card.el?.remove();
  turn.approvalCards?.delete(card.id);
}

export function showApprovalRequest(event, conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  if (!session) return null;
  if (!session.activeAgentTurn) beginAgentTurn(conversationId);
  const turn = session.activeAgentTurn;
  ensureWorkSummary(turn);

  const id = String(event.id || event.approvalId || `approval-${Date.now()}`);
  const name = String(event.name || "").trim();
  if (!turn.approvalCards) turn.approvalCards = new Map();

  let card = turn.approvalCards.get(id);
  // Reuse while the card still lives under this turn (panel may be off-DOM).
  if (isInTree(card?.el, turn.timeline || turn.turn)) {
    card.args = event.args || card.args;
    if (card.commandEl) {
      const detail = approvalDetailText(name || card.name, card.args);
      if (name === "execute" || card.name === "execute") {
        paintTerminalCommand(card.commandEl, detail);
      } else {
        card.commandEl.textContent = detail;
      }
    }
    return card;
  }

  const el = document.createElement("div");
  el.className = "approval-card";
  el.dataset.approvalId = id;
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Permission required");

  const main = document.createElement("div");
  main.className = "approval-main";

  const info = document.createElement("div");
  info.className = "approval-info";

  const heading = document.createElement("div");
  heading.className = "approval-heading";
  heading.appendChild(createApprovalShieldIcon());

  const title = document.createElement("div");
  title.className = "approval-title";
  title.textContent = "Permission Required";
  heading.appendChild(title);

  const body = document.createElement("div");
  body.className = "approval-body";

  const prompt = document.createElement("div");
  prompt.className = "approval-prompt";
  prompt.textContent = approvalPromptFor(name);

  const detail = approvalDetailText(name, event.args);
  const commandWrap = document.createElement("div");
  commandWrap.className = "approval-command-wrap term-prompt";

  const dollar = document.createElement("span");
  dollar.className = "term-dollar";
  dollar.textContent = name === "execute" ? "$" : "›";

  const command = document.createElement("span");
  command.className = "term-cmd";
  if (name === "execute") {
    paintTerminalCommand(command, detail);
  } else {
    command.textContent = detail;
  }

  commandWrap.append(dollar, command);
  body.append(prompt, commandWrap);
  info.append(heading, body);

  const actions = document.createElement("div");
  actions.className = "approval-actions";

  const denyBtn = document.createElement("button");
  denyBtn.type = "button";
  denyBtn.className = "approval-btn deny";
  denyBtn.textContent = "Deny";

  const allowAllBtn = document.createElement("button");
  allowAllBtn.type = "button";
  allowAllBtn.className = "approval-btn allow-all";
  allowAllBtn.textContent = "Allow all for this session";

  const allowBtn = document.createElement("button");
  allowBtn.type = "button";
  allowBtn.className = "approval-btn approve";
  const playIcon = createSvgEl("svg", {
    width: "11",
    height: "11",
    viewBox: "0 0 12 12",
    fill: "none",
    "aria-hidden": "true",
  });
  playIcon.appendChild(
    createSvgEl("path", {
      d: "M3.2 1.8v8.4L10.2 6 3.2 1.8Z",
      fill: "currentColor",
    })
  );
  const allowLabel = document.createElement("span");
  allowLabel.textContent = "Approve & Run";
  allowBtn.append(playIcon, allowLabel);

  const settle = async ({ approved, allowAllForSession = false }) => {
    if (card.status !== "pending") return;
    denyBtn.disabled = true;
    allowAllBtn.disabled = true;
    allowBtn.disabled = true;
    card.status = approved
      ? allowAllForSession
        ? "allowed-session"
        : "approved"
      : "rejected";
    try {
      await window.onecode.chat.resolveApproval({
        conversationId,
        id,
        approved,
        allowAllForSession,
      });
      removeApprovalCard(turn, card);
    } catch (error) {
      console.error(error);
      card.status = "pending";
      denyBtn.disabled = false;
      allowAllBtn.disabled = false;
      allowBtn.disabled = false;
    }
  };

  denyBtn.addEventListener("click", () => {
    settle({ approved: false }).catch(console.error);
  });
  allowAllBtn.addEventListener("click", () => {
    settle({ approved: true, allowAllForSession: true }).catch(console.error);
  });
  allowBtn.addEventListener("click", () => {
    settle({ approved: true }).catch(console.error);
  });

  actions.append(denyBtn, allowAllBtn, allowBtn);
  main.append(info, actions);
  el.appendChild(main);
  turn.timeline.appendChild(el);

  card = {
    id,
    name,
    args: event.args || {},
    status: "pending",
    el,
    commandEl: command,
    approveBtn: allowBtn,
    rejectBtn: denyBtn,
    allowAllBtn,
  };
  turn.approvalCards.set(id, card);
  releaseCurrentTextBlock(turn);
  if (conversationId === state.activeConversationId) scrollMessages();
  return card;
}

export function settleApprovalCards(turnRef, { rejected = false } = {}) {
  if (!turnRef?.approvalCards) return;
  for (const card of [...turnRef.approvalCards.values()]) {
    if (card.status !== "pending") {
      removeApprovalCard(turnRef, card);
      continue;
    }
    card.status = rejected ? "rejected" : "cancelled";
    removeApprovalCard(turnRef, card);
  }
}

export function cancelOpenToolCards(turnRef) {
  if (!turnRef) return;
  if (turnRef.toolCards) {
    for (const card of [...turnRef.toolCards.values()]) {
      if (!card.name || card.name === "tool") {
        removeToolCard(turnRef, card);
        continue;
      }
      if (card.status === "running") {
        card.status = "cancelled";
        updateToolCardHeader(card);
        if (isFileActionTool(card.name)) {
          syncFileActionActivity(turnRef, card);
        }
        if (card.name === "execute") {
          syncExecuteActivity(turnRef, card);
        }
        card.el.open = false;
      }
    }
  }
  settleApprovalCards(turnRef, { rejected: true });
  if (turnRef.activeExploreGroup && !turnRef.activeExploreGroup.finalized) {
    for (const item of turnRef.activeExploreGroup.items) {
      if (item.status === "running") {
        item.status = "cancelled";
        updateExploreItem(item);
      }
    }
    finalizeExploreGroup(turnRef);
  }
}
