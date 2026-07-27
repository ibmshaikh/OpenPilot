/**
 * Build Markdown / HTML exports from a conversation + messages payload.
 */

function safeTitle(title) {
  const raw = String(title || "chat").trim() || "chat";
  return raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").slice(0, 80);
}

function escapeMd(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

function toolBlockToMarkdown(block) {
  const name = block.name || "tool";
  const status = block.status ? ` (${block.status})` : "";
  const lines = [`### Tool: \`${name}\`${status}`];

  if (block.args && Object.keys(block.args).length) {
    lines.push("", "```json", JSON.stringify(block.args, null, 2), "```");
  } else if (block.argsText) {
    lines.push("", "```", escapeMd(block.argsText), "```");
  }

  if (block.output != null && String(block.output).length) {
    lines.push("", "**Result**", "", "```", escapeMd(String(block.output)), "```");
  }

  if (Array.isArray(block.images) && block.images.length) {
    lines.push("", `_${block.images.length} image(s) attached_`);
  }

  return lines.join("\n");
}

function conversationToMarkdown(conversation) {
  const title = conversation?.title || "Chat";
  const workspace = conversation?.workspacePath || "";
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const parts = [
    `# ${escapeMd(title)}`,
    "",
    workspace ? `Workspace: \`${escapeMd(workspace)}\`` : null,
    workspace ? "" : null,
    `Exported: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ].filter((line) => line !== null);

  for (const message of messages) {
    const role = message.role === "user" ? "You" : "Agent";
    const content = message.content || {};
    parts.push(`## ${role}`, "");

    if (message.role === "user") {
      if (content.text) parts.push(escapeMd(content.text), "");
      if (Array.isArray(content.attachments) && content.attachments.length) {
        parts.push(`_${content.attachments.length} attachment(s)_`, "");
      }
      continue;
    }

    if (content.error) {
      parts.push(`**Error:** ${escapeMd(content.text || "Unknown error")}`, "");
    }

    if (content.thinking) {
      parts.push("<details><summary>Thinking</summary>", "", escapeMd(content.thinking), "", "</details>", "");
    }

    const blocks = Array.isArray(content.blocks) ? content.blocks : null;
    if (blocks?.length) {
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          parts.push(escapeMd(block.text), "");
        } else if (block.type === "tool") {
          parts.push(toolBlockToMarkdown(block), "");
        }
      }
    } else if (content.text && !content.error) {
      parts.push(escapeMd(content.text), "");
    }
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function conversationToHtml(conversation) {
  const md = conversationToMarkdown(conversation);
  const title = escapeHtml(conversation?.title || "Chat");
  // Lightweight markdown-ish HTML: preserve structure via <pre> for code fences
  // and paragraphs for the rest — good enough for printToPDF.
  const body = md
    .split(/\n{2,}/)
    .map((chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("```")) {
        const lines = trimmed.split("\n");
        const inner = lines.slice(1, lines[lines.length - 1] === "```" ? -1 : undefined).join("\n");
        return `<pre><code>${escapeHtml(inner)}</code></pre>`;
      }
      if (trimmed.startsWith("# ")) {
        return `<h1>${escapeHtml(trimmed.slice(2))}</h1>`;
      }
      if (trimmed.startsWith("## ")) {
        return `<h2>${escapeHtml(trimmed.slice(3))}</h2>`;
      }
      if (trimmed.startsWith("### ")) {
        return `<h3>${escapeHtml(trimmed.slice(4))}</h3>`;
      }
      if (trimmed.startsWith("---")) {
        return "<hr />";
      }
      return `<p>${escapeHtml(trimmed).replace(/\n/g, "<br />")}</p>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 12px; line-height: 1.5; color: #111; margin: 32px; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    h3 { font-size: 13px; margin: 14px 0 6px; }
    pre { background: #f4f4f5; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 11px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    p { margin: 0 0 10px; white-space: pre-wrap; }
    hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

module.exports = {
  safeTitle,
  conversationToMarkdown,
  conversationToHtml,
};
