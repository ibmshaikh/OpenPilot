/** VS Code–style syntax highlighting + shared code block chrome. */

const MAX_HIGHLIGHT_CHARS = 120_000;
const MAX_AUTO_DETECT_CHARS = 3_000;

const EXT_TO_HLJS = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  css: "css",
  scss: "scss",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  toml: "ini",
  ini: "ini",
};

const LANG_BADGE = {
  javascript: "JS",
  typescript: "TS",
  python: "PY",
  ruby: "RB",
  go: "GO",
  rust: "RS",
  java: "JAVA",
  kotlin: "KT",
  swift: "SWIFT",
  css: "CSS",
  scss: "SCSS",
  xml: "HTML",
  json: "JSON",
  markdown: "MD",
  yaml: "YML",
  bash: "SH",
  sql: "SQL",
  ini: "TOML",
};

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function hljsLanguageFromPath(filePathOrLang) {
  const value = String(filePathOrLang || "").trim();
  if (!value) return "";

  const lower = value.toLowerCase();
  if (EXT_TO_HLJS[lower]) return EXT_TO_HLJS[lower];
  if (LANG_BADGE[lower]) return lower;

  const name = value.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (EXT_TO_HLJS[ext]) return EXT_TO_HLJS[ext];

  // Bare language ids from markdown fences (e.g. ```js)
  const aliases = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    sh: "bash",
    shell: "bash",
    yml: "yaml",
    html: "xml",
    htm: "xml",
    md: "markdown",
  };
  return aliases[lower] || "";
}

export function languageBadgeLabel(filePathOrLang) {
  const lang = hljsLanguageFromPath(filePathOrLang);
  if (lang && LANG_BADGE[lang]) return LANG_BADGE[lang];
  const name = String(filePathOrLang || "")
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .pop() || "";
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return (ext || lang || "CODE").toUpperCase().slice(0, 4);
}

/**
 * Split highlighted HTML on newlines without breaking open tags across lines.
 */
function splitHighlightedHtml(html) {
  const lines = [];
  let current = "";
  const openStack = [];
  let i = 0;

  const pushLine = () => {
    lines.push(current);
    current = openStack.join("");
  };

  while (i < html.length) {
    if (html[i] === "\n") {
      for (let s = 0; s < openStack.length; s++) current += "</span>";
      pushLine();
      i += 1;
      continue;
    }

    if (html[i] === "<") {
      const close = html.indexOf(">", i);
      if (close === -1) {
        current += escapeHtml(html.slice(i));
        break;
      }
      const tag = html.slice(i, close + 1);
      if (tag.startsWith("</")) {
        openStack.pop();
        current += tag;
      } else if (tag.startsWith("<span")) {
        openStack.push(tag);
        current += tag;
      } else {
        current += tag;
      }
      i = close + 1;
      continue;
    }

    current += html[i];
    i += 1;
  }

  lines.push(current);
  return lines;
}

function highlightHtml(source, language) {
  const hljs = window.hljs;
  if (!hljs || typeof hljs.highlight !== "function") return null;

  try {
    if (language && typeof hljs.getLanguage === "function" && hljs.getLanguage(language)) {
      return hljs.highlight(source, { language, ignoreIllegals: true }).value;
    }
    if (
      source.length <= MAX_AUTO_DETECT_CHARS &&
      typeof hljs.highlightAuto === "function"
    ) {
      return hljs.highlightAuto(source).value;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Highlight source and return one HTML string per line. */
export function highlightCodeLines(code, languageOrPath) {
  const source = String(code ?? "");
  if (!source) return [""];

  const plain = () => source.split("\n").map((line) => escapeHtml(line));
  if (source.length > MAX_HIGHLIGHT_CHARS) return plain();

  const language = hljsLanguageFromPath(languageOrPath);
  const highlighted = highlightHtml(source, language);
  if (!highlighted) return plain();
  return splitHighlightedHtml(highlighted);
}

export function highlightCodeLine(line, languageOrPath) {
  return highlightCodeLines(line, languageOrPath)[0] ?? escapeHtml(String(line ?? ""));
}

export async function copyTextToClipboard(text) {
  const value = String(text ?? "");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function flashCopied(button, label = "Copy") {
  if (!button) return;
  const prev = button.textContent;
  button.textContent = "Copied";
  button.classList.add("is-copied");
  window.setTimeout(() => {
    button.textContent = prev || label;
    button.classList.remove("is-copied");
  }, 1200);
}

function lineRowHtml({ lineNo, mark, html, kind = "" }) {
  const markClass =
    mark === "+" ? " is-add" : mark === "-" ? " is-del" : "";
  const rowClass = kind ? ` code-line ${kind}` : " code-line";
  return `<div class="${rowClass.trim()}">` +
    `<span class="code-gutter">${lineNo != null ? escapeHtml(String(lineNo)) : ""}</span>` +
    `<span class="code-mark${markClass}">${mark ? escapeHtml(mark) : " "}</span>` +
    `<span class="code-text">${html}</span>` +
    `</div>`;
}

/**
 * Build a VS Code–style fenced code block (markdown + shared chrome).
 * Includes language badge, copy button, and numbered highlighted lines.
 */
export function renderCodeBlockHtml({
  code,
  language = "",
  path = "",
  filename = "",
  mark = null,
} = {}) {
  const source = String(code ?? "");
  const lang = hljsLanguageFromPath(path || language);
  const badge = languageBadgeLabel(path || language || lang);
  const title =
    filename ||
    (path ? String(path).split(/[/\\]/).pop() : "") ||
    (language ? String(language) : lang || "code");
  const highlighted = highlightCodeLines(source, path || language || lang);

  const rows = highlighted
    .map((html, i) =>
      lineRowHtml({
        lineNo: i + 1,
        mark: mark || " ",
        html,
        kind: mark === "+" ? "code-add" : mark === "-" ? "code-del" : "",
      })
    )
    .join("");

  const pathAttr = path ? ` title="${escapeHtml(path)}"` : "";
  const langClass = `lang-${badge.toLowerCase()}`;

  return (
    `<div class="code-block hljs-code" data-code-block="1">` +
    `<div class="code-block-header">` +
    `<span class="lang-badge ${langClass}">${escapeHtml(badge)}</span>` +
    `<span class="code-block-title"${pathAttr}>${escapeHtml(title)}</span>` +
    `<button type="button" class="code-copy-btn" aria-label="Copy code">Copy</button>` +
    `</div>` +
    `<div class="code-table">${rows}</div>` +
    `<textarea class="code-copy-source" readonly hidden>${escapeHtml(source)}</textarea>` +
    `</div>`
  );
}

/** Wire copy buttons inside a root (event delegation). */
export function initCodeCopyDelegation(root = document) {
  if (!root || root._codeCopyBound) return;
  root._codeCopyBound = true;

  root.addEventListener("click", async (event) => {
    const btn = event.target?.closest?.(".code-copy-btn");
    if (!btn || !root.contains(btn)) return;
    event.preventDefault();
    event.stopPropagation();

    const block =
      btn.closest("[data-code-block], .tool-editor, .tool-diff, .code-block") ||
      btn.parentElement;
    let text = "";
    const source = block?.querySelector?.(".code-copy-source");
    if (source) {
      text = source.value || source.textContent || "";
    } else if (typeof btn._copyText === "function") {
      text = btn._copyText() || "";
    } else if (btn.dataset.copyText != null) {
      text = btn.dataset.copyText;
    } else {
      const lines = block?.querySelectorAll?.(".code-text, .diff-code");
      if (lines?.length) {
        text = Array.from(lines)
          .map((el) => el.textContent || "")
          .join("\n");
      }
    }

    const ok = await copyTextToClipboard(text);
    if (ok) flashCopied(btn);
  });
}

/** Attach a copy control to a tool editor/diff header. */
export function attachCopyButton(parent, getText) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "code-copy-btn";
  btn.setAttribute("aria-label", "Copy code");
  btn.textContent = "Copy";
  btn._copyText = typeof getText === "function" ? getText : () => String(getText ?? "");
  parent.appendChild(btn);
  return btn;
}
