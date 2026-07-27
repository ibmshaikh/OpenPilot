import { renderCodeBlockHtml } from "./syntax.js";

export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

if (typeof marked !== "undefined") {
  marked.setOptions({
    gfm: true,
    breaks: true,
  });

  // Marked v18 link tokens use { href, title, tokens } — not { text }.
  // Passing a stripped object (or binding an unbound Renderer) throws during
  // parseInline, and renderMarkdown then falls back to escaped raw markdown.
  marked.use({
    renderer: {
      link(token) {
        const html = marked.Renderer.prototype.link.call(this, token);
        return String(html || "").replace(
          "<a ",
          '<a target="_blank" rel="noopener noreferrer" '
        );
      },
      code({ text, lang }) {
        return renderCodeBlockHtml({
          code: text,
          language: lang || "",
        });
      },
    },
  });
}

/** Post-process marked HTML for production chat presentation. */
function enhanceMarkdownHtml(html) {
  let out = String(html || "");

  // Scroll shell for wide GFM tables (skip if already wrapped).
  out = out.replace(/<table\b[\s\S]*?<\/table>/gi, (table, offset, full) => {
    const before = String(full).slice(Math.max(0, offset - 32), offset);
    if (before.endsWith('<div class="md-table-wrap">')) return table;
    return `<div class="md-table-wrap">${table}</div>`;
  });

  // Soft-wrap images so they don't blow out the thread width.
  out = out.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
    if (/\bclass\s*=/.test(attrs)) {
      return full.replace(
        /\bclass\s*=\s*(["'])([^"']*)\1/i,
        (_m, q, cls) => {
          if (/\bmd-image\b/.test(cls)) return `class=${q}${cls}${q}`;
          return `class=${q}${cls} md-image${q}`;
        }
      );
    }
    return `<img class="md-image"${attrs}>`;
  });

  return out;
}

export function renderMarkdown(markdown) {
  const source = String(markdown ?? "");
  if (!source.trim()) return "";

  try {
    let html =
      typeof marked !== "undefined" && typeof marked.parse === "function"
        ? marked.parse(source)
        : escapeHtml(source).replaceAll("\n", "<br>");

    // Guard against accidental async marked config returning a Promise.
    if (html && typeof html.then === "function") {
      console.error("Markdown render returned a Promise; using sync fallback.");
      html = escapeHtml(source).replaceAll("\n", "<br>");
    }

    html = enhanceMarkdownHtml(html);

    if (typeof DOMPurify !== "undefined") {
      return DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        ADD_TAGS: ["button", "textarea"],
        ADD_ATTR: [
          "target",
          "rel",
          "type",
          "aria-label",
          "data-code-block",
          "readonly",
          "hidden",
          "title",
          "class",
          "checked",
          "disabled",
        ],
      });
    }

    return html;
  } catch (error) {
    console.error("Markdown render failed:", error);
    return escapeHtml(source).replaceAll("\n", "<br>");
  }
}

export function setTurnContent(turnRef, markdown) {
  // Legacy helper for user/error turns that use a single body.
  turnRef.raw = String(markdown ?? "");
  if (turnRef.body) {
    turnRef.body.innerHTML = renderMarkdown(turnRef.raw);
  }
}

/**
 * True if `el` still lives under `root`. Prefer this over `el.isConnected` —
 * switching chats detaches the thread panel from the document, so `isConnected`
 * goes false while the live turn DOM (and streaming updates) remain valid.
 */
export function isInTree(el, root) {
  return Boolean(el && root && (el === root || root.contains(el)));
}

/** Keep live status chrome pinned under the turn body/timeline. */
export function pinTurnBottomChrome(turnRef) {
  if (!turnRef?.turn) return;
  const status = turnRef.statusIndicatorEl;
  if (!status) return;
  // Skip no-op reparent — appendChild on an already-last child still costs.
  if (
    status.parentNode === turnRef.turn &&
    turnRef.turn.lastElementChild === status
  ) {
    return;
  }
  turnRef.turn.appendChild(status);
}

function thinkingDurationLabel(startedAt = 0) {
  const start = startedAt || 0;
  const elapsedMs = start ? Date.now() - start : 0;
  // When restoring historical turns, startedAt is 0 — use "Thought".
  if (!start || elapsedMs < 2000) return "Thought";
  return `Thought for ${Math.max(1, Math.round(elapsedMs / 1000))}s`;
}

function bindThinkingPanel(turnRef, panel) {
  turnRef.thinkingPanel = panel;
  turnRef.thinkingSummary = panel.querySelector(".thinking-summary");
  turnRef.thinkingLabel = panel.querySelector(".thinking-summary-label");
  turnRef.thinkingContent = panel.querySelector(".thinking-content");
  turnRef.thinkingRaw = panel._thinkingRaw || "";
}

/**
 * Create or reuse the active (unsealed) thinking dropdown.
 * Sealed panels stay in the timeline; a new burst gets a fresh panel.
 * While Exploring is active, Thought nests inside that group.
 */
export function ensureThinkingPanel(turnRef, { forceNew = false } = {}) {
  const exploreBody =
    turnRef.activeExploreGroup &&
    !turnRef.activeExploreGroup.finalized &&
    turnRef.activeExploreGroup.body
      ? turnRef.activeExploreGroup.body
      : null;
  const mountRoot = exploreBody || turnRef.timeline || turnRef.turn;

  if (
    !forceNew &&
    turnRef.thinkingPanel &&
    isInTree(turnRef.thinkingPanel, mountRoot) &&
    !turnRef.thinkingFrozen
  ) {
    return turnRef.thinkingPanel;
  }

  const panel = document.createElement("details");
  panel.className = "disclosure-block thinking-panel";
  panel._thinkingRaw = "";

  const summary = document.createElement("summary");
  summary.className = "disclosure-summary thinking-summary";

  const label = document.createElement("span");
  label.className = "disclosure-label thinking-summary-label";
  label.textContent = "Thinking";
  summary.appendChild(label);

  const content = document.createElement("div");
  content.className = "thinking-content";

  panel.append(summary, content);

  if (mountRoot) {
    mountRoot.appendChild(panel);
  }

  if (!turnRef.thinkingSegments) turnRef.thinkingSegments = [];
  turnRef.thinkingFrozen = false;
  turnRef.thinkingRaw = "";
  bindThinkingPanel(turnRef, panel);
  return panel;
}

/** Build a sealed Thought disclosure (for restore / explore nesting). */
export function createSealedThinkingPanel(text, { startedAt = 0 } = {}) {
  const panel = document.createElement("details");
  panel.className = "disclosure-block thinking-panel";
  panel.dataset.sealed = "1";
  panel.open = false;
  panel._thinkingRaw = String(text || "");

  const summary = document.createElement("summary");
  summary.className = "disclosure-summary thinking-summary";

  const label = document.createElement("span");
  label.className = "disclosure-label thinking-summary-label";
  label.textContent = thinkingDurationLabel(startedAt);
  summary.appendChild(label);

  const content = document.createElement("div");
  content.className = "thinking-content";
  content.textContent = panel._thinkingRaw;

  panel.append(summary, content);
  panel.hidden = !panel._thinkingRaw.trim();
  return panel;
}

/** Finalize the current thinking burst so the next one starts empty. */
export function sealThinkingSegment(turnRef, { quietly = false } = {}) {
  if (!turnRef?.thinkingPanel || turnRef.thinkingFrozen) return false;
  const raw = String(turnRef.thinkingRaw || "").trim();
  if (!raw) return false;

  turnRef.thinkingFrozen = true;
  turnRef.thinkingPanel._thinkingRaw = turnRef.thinkingRaw;
  turnRef.thinkingPanel.dataset.sealed = "1";

  const labelEl =
    turnRef.thinkingLabel ||
    turnRef.thinkingSummary?.querySelector?.(".thinking-summary-label");
  const label = thinkingDurationLabel(turnRef.thinkingStartedAt);
  if (labelEl) labelEl.textContent = label;

  turnRef.thinkingSummary?.classList.remove("is-streaming");
  turnRef.thinkingPanel.classList.remove("is-streaming");
  turnRef.thinkingPanel.hidden = false;

  if (!quietly) {
    // Keep content as plain text (already set while streaming).
    if (turnRef.thinkingContent) {
      turnRef.thinkingContent.textContent = turnRef.thinkingRaw;
    }
  }

  if (!turnRef.thinkingSegments) turnRef.thinkingSegments = [];
  const alreadyTracked = turnRef.thinkingSegments.some(
    (seg) => seg.el === turnRef.thinkingPanel
  );
  if (!alreadyTracked) {
    turnRef.thinkingSegments.push({
      el: turnRef.thinkingPanel,
      raw: turnRef.thinkingRaw,
      startedAt: turnRef.thinkingStartedAt || 0,
    });
  }
  return true;
}

/**
 * Start a fresh thinking burst after a sealed one (or when none exists).
 * Clears prior text so the new dropdown only shows this segment.
 */
export function beginThinkingSegment(turnRef) {
  if (!turnRef) return null;
  if (turnRef.thinkingPanel && !turnRef.thinkingFrozen) {
    return turnRef.thinkingPanel;
  }
  // Drop refs to the sealed panel — it remains visible in the timeline.
  turnRef.thinkingPanel = null;
  turnRef.thinkingSummary = null;
  turnRef.thinkingLabel = null;
  turnRef.thinkingContent = null;
  turnRef.thinkingRaw = "";
  turnRef.thinkingFrozen = false;
  turnRef.thinkingStartedAt = Date.now();
  turnRef.thinkingSuppressedForExplore = false;
  return ensureThinkingPanel(turnRef, { forceNew: true });
}

export function setThinkingContent(
  turnRef,
  markdown,
  { streaming = false, startedAt = 0, forceNew = false } = {}
) {
  if (forceNew || (streaming && turnRef.thinkingFrozen)) {
    beginThinkingSegment(turnRef);
  } else {
    ensureThinkingPanel(turnRef);
  }

  turnRef.thinkingRaw = String(markdown ?? "");
  turnRef.thinkingPanel._thinkingRaw = turnRef.thinkingRaw;
  if (turnRef.thinkingContent) {
    turnRef.thinkingContent.textContent = turnRef.thinkingRaw;
  }

  const labelEl =
    turnRef.thinkingLabel ||
    turnRef.thinkingSummary?.querySelector?.(".thinking-summary-label") ||
    turnRef.thinkingSummary;

  if (streaming) {
    if (labelEl) labelEl.textContent = "Thinking";
    turnRef.thinkingSummary?.classList.add("is-streaming");
    turnRef.thinkingPanel.classList.add("is-streaming");
    turnRef.thinkingFrozen = false;
  } else {
    turnRef.thinkingSummary?.classList.remove("is-streaming");
    turnRef.thinkingPanel.classList.remove("is-streaming");
    const label = thinkingDurationLabel(
      startedAt || turnRef.thinkingStartedAt || 0
    );
    if (labelEl) labelEl.textContent = label;
    turnRef.thinkingFrozen = true;
    turnRef.thinkingPanel.dataset.sealed = "1";
    if (!turnRef.thinkingSegments) turnRef.thinkingSegments = [];
    if (!turnRef.thinkingSegments.some((seg) => seg.el === turnRef.thinkingPanel)) {
      turnRef.thinkingSegments.push({
        el: turnRef.thinkingPanel,
        raw: turnRef.thinkingRaw,
        startedAt: startedAt || turnRef.thinkingStartedAt || 0,
      });
    }
  }

  const hasText = Boolean(turnRef.thinkingRaw.trim());
  // Keep sealed segments visible. Unfinished panels stay visible too when nested
  // in Exploring; only hide empty ones.
  turnRef.thinkingPanel.hidden = !hasText;

  // If expanded while streaming, keep the latest tokens in view.
  if (streaming && turnRef.thinkingPanel.open && turnRef.thinkingContent) {
    turnRef.thinkingContent.scrollTop = turnRef.thinkingContent.scrollHeight;
  }

  pinTurnBottomChrome(turnRef);
}

/** Combined thinking text across all segments (legacy persist field). */
export function allThinkingText(turnRef) {
  if (!turnRef) return "";
  const parts = [];
  if (Array.isArray(turnRef.thinkingSegments)) {
    for (const seg of turnRef.thinkingSegments) {
      const text = String(seg?.raw || seg?.el?._thinkingRaw || "").trim();
      if (text) parts.push(text);
    }
  }
  // Include an unsealed active segment not yet pushed.
  if (
    turnRef.thinkingPanel &&
    !turnRef.thinkingFrozen &&
    turnRef.thinkingRaw?.trim()
  ) {
    const active = turnRef.thinkingRaw.trim();
    if (!parts.includes(active)) parts.push(active);
  }
  if (!parts.length && turnRef.thinkingRaw?.trim()) {
    return turnRef.thinkingRaw;
  }
  return parts.join("\n\n");
}
