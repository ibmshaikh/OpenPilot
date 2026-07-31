import {
  messagesEl,
  form,
  runStatus,
  input,
  chatListEl,
  sidebarEl,
  sidebarResizer,
  settingsModal,
  shell,
} from "./dom.js";
import {
  state,
  getSession,
  ensureUiSession,
  applyWorkspaceToUi,
  syncShellMode,
  syncSendButton,
  setSending,
  registerRenderChatList,
  ACTIVE_CHAT_KEY,
} from "./state.js";
import {
  createThreadSkeleton,
  createListSkeleton,
  setSkeleton,
} from "./skeleton.js";
import {
  renderMarkdown,
  setTurnContent,
  setThinkingContent,
  pinTurnBottomChrome,
  sealThinkingSegment,
  beginThinkingSegment,
  allThinkingText,
  isInTree,
} from "./markdown.js";
import { initCodeCopyDelegation, copyTextToClipboard } from "./syntax.js";
import {
  basenamePath,
  cancelOpenToolCards,
  settleOpenToolCards,
  extractTodos,
  setSessionTodos,
  extractLatestTodosFromMessages,
  createToolCard,
  updateToolCardHeader,
  fillToolPane,
  attachToolRetry,
  upsertToolCall,
  completeToolResult,
  appendExecuteOutput,
  ensureWorkSummary,
  finalizeWorkSummary,
  syncTodoPanel,
  isGroupedExploreTool,
  turnHasLiveTimelineActivity,
  finalizeExploreGroup,
  restoreExploreGroup,
  showApprovalRequest,
  settleApprovalCards,
  releaseCurrentTextBlock,
  pruneEmptyTimelineNodes,
} from "./tool-renderer.js";
import {
  getComposerPlainText,
  getComposerSelectedSkills,
  clearComposer,
  closeSkillsSlashMenu,
  getSelectedModel,
  syncComposerModelLabel,
  getMcpChatPayload,
  getPendingAttachments,
  clearPendingAttachments,
  renderAttachmentPreviews,
} from "./composer.js";
import { refreshUsagePanel, isAllPermissionsEnabled } from "./settings.js";
import { refreshContextUsage } from "./context-usage.js";

/** Distance (px) from bottom that counts as "away" — unpin follow mode. */
const SCROLL_BOTTOM_THRESHOLD = 96;
/** Must reach this close to bottom to re-pin follow (hysteresis vs unpin). */
const SCROLL_REPIN_THRESHOLD = 8;

let scrollRaf = 0;
let scrollForcePending = false;
/** True while we set scrollTop ourselves — ignore those scroll events for pin state. */
let programmaticScroll = false;
let streamFlushRaf = 0;
/** Guards against stale hydrate/mount after a faster conversation switch. */
let chatLoadSeq = 0;
/** @type {Set<HTMLElement>} */
const dirtyTextBlocks = new Set();
/** @type {Set<object>} */
const dirtyThinkingTurns = new Set();

export function showThreadLoadingSkeleton() {
  if (!messagesEl) return;
  shell?.classList.add("started", "is-loading");
  form?.classList.add("is-loading");
  form?.setAttribute("aria-busy", "true");
  messagesEl.setAttribute("aria-busy", "true");
  messagesEl.replaceChildren(createThreadSkeleton());
}

export function clearThreadLoadingState() {
  shell?.classList.remove("is-loading");
  form?.classList.remove("is-loading");
  form?.removeAttribute("aria-busy");
  messagesEl?.removeAttribute("aria-busy");
}

export function enterConversationMode(conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  if (!session || session.started) {
    if (conversationId === state.activeConversationId) syncShellMode(session);
    return;
  }
  session.started = true;
  if (conversationId === state.activeConversationId) syncShellMode(session);
}

export function distanceFromBottom(el = messagesEl) {
  if (!el) return 0;
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function isNearBottom(el = messagesEl, threshold = SCROLL_BOTTOM_THRESHOLD) {
  if (!el) return true;
  return distanceFromBottom(el) <= threshold;
}

/** Coalesce scroll-to-bottom to once per animation frame. */
export function scrollMessages({ force = false } = {}) {
  if (!messagesEl) return;
  if (force) scrollForcePending = true;
  if (!scrollForcePending && !state.stickToBottom) return;
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const forceNow = scrollForcePending;
    scrollForcePending = false;
    if (!messagesEl) return;
    if (!forceNow && !state.stickToBottom) return;
    programmaticScroll = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    state.stickToBottom = true;
    // Drop the flag after the scroll event from this write has been dispatched.
    requestAnimationFrame(() => {
      programmaticScroll = false;
    });
  });
}

function paintTextBlock(block) {
  if (!block) return;
  const raw = String(block._raw || "");
  // Always render markdown while streaming — rAF batching caps parse cost to ~1/frame.
  block.innerHTML = renderMarkdown(raw);
  block.classList.remove("is-plain-stream");
}

function paintThinkingTurn(turnRef) {
  if (!turnRef) return;
  setThinkingContent(turnRef, turnRef.thinkingRaw || "", { streaming: true });
  pinTurnBottomChrome(turnRef);
}

function flushStreamDom() {
  streamFlushRaf = 0;

  for (const block of dirtyTextBlocks) {
    dirtyTextBlocks.delete(block);
    paintTextBlock(block);
  }

  for (const turn of dirtyThinkingTurns) {
    dirtyThinkingTurns.delete(turn);
    paintThinkingTurn(turn);
  }

  scrollMessages();
}

function scheduleStreamFlush() {
  if (streamFlushRaf) return;
  streamFlushRaf = requestAnimationFrame(() => flushStreamDom());
}

/** Flush any coalesced stream paints immediately (before tools / turn end). */
export function flushPendingStream({ turnRef = null } = {}) {
  if (streamFlushRaf) {
    cancelAnimationFrame(streamFlushRaf);
    streamFlushRaf = 0;
  }
  if (dirtyTextBlocks.size || dirtyThinkingTurns.size) {
    flushStreamDom();
  }
  // turnRef kept for call-site compatibility; paint is already markdown.
  void turnRef;
}

function queueTextBlockPaint(block) {
  if (!block) return;
  dirtyTextBlocks.add(block);
  scheduleStreamFlush();
}

function queueThinkingPaint(turnRef) {
  if (!turnRef) return;
  dirtyThinkingTurns.add(turnRef);
  scheduleStreamFlush();
}

/**
 * Update stick-to-bottom with hysteresis so a small upward wheel/touch does not
 * get immediately re-pinned by the trailing scroll event while still inside the
 * near-bottom band — that race made streaming auto-scroll feel locked.
 */
function syncStickToBottomFromUserScroll() {
  const distance = distanceFromBottom();
  if (distance > SCROLL_BOTTOM_THRESHOLD) {
    state.stickToBottom = false;
  } else if (distance <= SCROLL_REPIN_THRESHOLD) {
    state.stickToBottom = true;
  }
  // Band (REPIN, THRESHOLD]: keep current stickToBottom (hysteresis).
}

export function initScrollListeners() {
  if (!messagesEl) return;
  messagesEl.addEventListener(
    "scroll",
    () => {
      if (!programmaticScroll) syncStickToBottomFromUserScroll();
      collapseExpandedStickyUsers();
    },
    { passive: true }
  );

  messagesEl.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaY < 0) state.stickToBottom = false;
      else if (isNearBottom(messagesEl, SCROLL_REPIN_THRESHOLD)) {
        state.stickToBottom = true;
      }
    },
    { passive: true }
  );

  messagesEl.addEventListener(
    "touchstart",
    (event) => {
      state.touchStartY = event.touches[0]?.clientY ?? 0;
    },
    { passive: true }
  );

  messagesEl.addEventListener(
    "touchmove",
    (event) => {
      const y = event.touches[0]?.clientY ?? state.touchStartY;
      if (y > state.touchStartY + 8) state.stickToBottom = false;
      else if (
        y < state.touchStartY - 8 &&
        isNearBottom(messagesEl, SCROLL_REPIN_THRESHOLD)
      ) {
        state.stickToBottom = true;
      }
    },
    { passive: true }
  );

  initStickyUserObserver();
  initStickyUserCollapseInteractions();
}

/** Detect when a user turn is pinned so we can add stuck chrome. */
let stickyUserObserver = null;
/** Ignore scroll-driven collapse briefly after a click-expand (layout shift). */
let stickyExpandIgnoreScrollUntil = 0;

function clearStickyUserCollapse(userTurn) {
  if (!userTurn) return;
  userTurn.classList.remove("is-collapsed", "is-expanded", "is-collapsible");
  userTurn.removeAttribute("aria-expanded");
  userTurn.removeAttribute("title");
  if (userTurn.getAttribute("role") === "button") {
    userTurn.removeAttribute("role");
    userTurn.removeAttribute("tabindex");
  }
}

/**
 * When a long user bubble is stuck at the top, clamp it to ~2 lines so it
 * doesn't cover streaming content. Click expands; scroll collapses again.
 */
function syncStickyUserCollapse(userTurn, { forceCollapse = false } = {}) {
  if (!userTurn) return;
  const body = userTurn.querySelector(":scope > .turn-body");
  if (!body) {
    clearStickyUserCollapse(userTurn);
    return;
  }

  const keepExpanded =
    !forceCollapse && userTurn.classList.contains("is-expanded");

  // Measure full height without the clamp.
  userTurn.classList.remove("is-collapsed");
  const style = getComputedStyle(body);
  let lineHeight = parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight)) {
    const fontSize = parseFloat(style.fontSize) || 14;
    lineHeight = fontSize * 1.55;
  }
  const paddingY =
    (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const threshold = lineHeight * 2 + paddingY + 2;
  const needsCollapse = body.scrollHeight > threshold;

  if (!needsCollapse) {
    clearStickyUserCollapse(userTurn);
    return;
  }

  userTurn.classList.add("is-collapsible");
  userTurn.setAttribute("role", "button");
  userTurn.setAttribute("tabindex", "0");
  if (keepExpanded) {
    userTurn.classList.add("is-expanded");
    userTurn.classList.remove("is-collapsed");
    userTurn.setAttribute("aria-expanded", "true");
    userTurn.setAttribute("title", "Scroll to collapse");
  } else {
    userTurn.classList.add("is-collapsed");
    userTurn.classList.remove("is-expanded");
    userTurn.setAttribute("aria-expanded", "false");
    userTurn.setAttribute("title", "Click to expand");
  }
}

function collapseExpandedStickyUsers() {
  if (!messagesEl) return;
  if (Date.now() < stickyExpandIgnoreScrollUntil) return;
  messagesEl
    .querySelectorAll(".turn.user.is-stuck.is-expanded.is-collapsible")
    .forEach((turn) => {
      turn.classList.remove("is-expanded");
      turn.classList.add("is-collapsed");
      turn.setAttribute("aria-expanded", "false");
      turn.setAttribute("title", "Click to expand");
    });
}

function toggleStickyUserExpanded(userTurn) {
  if (!userTurn?.classList.contains("is-collapsible")) return;
  if (!userTurn.classList.contains("is-stuck")) return;
  const expand = !userTurn.classList.contains("is-expanded");
  stickyExpandIgnoreScrollUntil = Date.now() + 180;
  userTurn.classList.toggle("is-expanded", expand);
  userTurn.classList.toggle("is-collapsed", !expand);
  userTurn.setAttribute("aria-expanded", expand ? "true" : "false");
  userTurn.setAttribute(
    "title",
    expand ? "Scroll to collapse" : "Click to expand"
  );
}

function initStickyUserCollapseInteractions() {
  if (!messagesEl || messagesEl.dataset.stickyCollapseBound === "1") return;
  messagesEl.dataset.stickyCollapseBound = "1";

  messagesEl.addEventListener("click", (event) => {
    if (event.target.closest("a, button, input, textarea, select")) return;
    const userTurn = event.target.closest(".turn.user.is-stuck.is-collapsible");
    if (!userTurn || !messagesEl.contains(userTurn)) return;
    event.preventDefault();
    toggleStickyUserExpanded(userTurn);
  });

  messagesEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const userTurn = event.target.closest?.(".turn.user.is-stuck.is-collapsible");
    if (!userTurn || event.target !== userTurn) return;
    event.preventDefault();
    toggleStickyUserExpanded(userTurn);
  });
}

function initStickyUserObserver() {
  if (!messagesEl || stickyUserObserver) return;
  stickyUserObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const group = entry.target.parentElement;
        const userTurn = group?.querySelector?.(":scope > .turn.user");
        if (!userTurn) continue;
        const rootTop = entry.rootBounds?.top ?? 0;
        const stuck =
          !entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop + 1;
        const wasStuck = userTurn.classList.contains("is-stuck");
        userTurn.classList.toggle("is-stuck", stuck);
        if (stuck) {
          // Newly stuck → start collapsed. Stay-stuck → keep expand if open.
          syncStickyUserCollapse(userTurn, { forceCollapse: !wasStuck });
        } else {
          clearStickyUserCollapse(userTurn);
        }
      }
    },
    { root: messagesEl, threshold: 0 }
  );
}

function observeStickyGroup(group) {
  if (!group || !stickyUserObserver) return;
  const sentinel = group.querySelector(":scope > .turn-sticky-sentinel");
  if (sentinel) stickyUserObserver.observe(sentinel);
}

export function refreshStickyUserObservers(panel = getSession()?.panel) {
  if (!panel) return;
  initStickyUserObserver();
  if (!stickyUserObserver) return;
  panel.querySelectorAll(".turn-sticky-sentinel").forEach((el) => {
    stickyUserObserver.observe(el);
  });
}

function mountTurnInPanel(session, turn, role, label = null) {
  if (role === "user") {
    const group = document.createElement("section");
    group.className = "turn-group";
    const sentinel = document.createElement("div");
    sentinel.className = "turn-sticky-sentinel";
    sentinel.setAttribute("aria-hidden", "true");
    group.append(sentinel);
    if (label) group.appendChild(label);
    group.appendChild(turn);
    session.panel.appendChild(group);
    session.stickyGroup = group;
    observeStickyGroup(group);
    return;
  }

  const group = session.stickyGroup;
  if (group && session.panel.contains(group)) {
    group.appendChild(turn);
    return;
  }

  session.stickyGroup = null;
  session.panel.appendChild(turn);
}

const EXPLORE_STATUS_TOOLS = new Set([
  "ls",
  "glob",
  "grep",
  "read_file",
  "web_search",
  "web_fetch",
]);

/** Live bottom-of-turn status phases (shimmer word). */
export const STATUS_PHASE = {
  THINKING: "Thinking",
  WRITING: "Writing",
  RUNNING: "Running",
  EXPLORING: "Exploring",
  EDITING: "Editing",
  WORKING: "Working",
  STOPPING: "Stopping",
};

export function statusLabelForTool(toolName) {
  const name = String(toolName || "").trim();
  // Explore / edit / execute own timeline activity — no bottom status word.
  if (name === "execute") return null;
  if (name === "write_file" || name === "edit_file") return null;
  if (EXPLORE_STATUS_TOOLS.has(name)) return null;
  if (name) return STATUS_PHASE.WORKING;
  return STATUS_PHASE.THINKING;
}

/**
 * Single entry-point for live status. Only updates the DOM when the phase changes
 * (avoids flicker from streaming tool_call chunks). Pass null to hide while the
 * Thinking panel owns the "Thinking" signal.
 *
 * Timeline activity (Exploring / Editing / Executing / approval) owns the live
 * signal — bottom shimmer is only a fallback for Thinking / Writing / Stopping.
 */
export function setStatusPhase(conversationId, phase) {
  const session = getSession(conversationId);
  const turn = session?.activeAgentTurn;
  if (!turn?.turn) return null;

  if (!phase) {
    turn.statusPhase = null;
    hideStatusIndicator(conversationId);
    pinTurnBottomChrome(turn);
    return null;
  }

  const status = String(phase).trim() || STATUS_PHASE.THINKING;
  if (!session.isSending && status !== STATUS_PHASE.STOPPING) return null;

  // When the timeline already shows live chrome, don't duplicate at the bottom.
  if (
    status !== STATUS_PHASE.STOPPING &&
    status !== STATUS_PHASE.WRITING &&
    turnHasLiveTimelineActivity(turn)
  ) {
    turn.statusPhase = null;
    hideStatusIndicator(conversationId);
    pinTurnBottomChrome(turn);
    return null;
  }

  // Same phase already visible — keep pinned, skip rewrite.
  // Use turn-tree membership (not isConnected): inactive chats are off-DOM.
  if (
    turn.statusPhase === status &&
    turn.statusIndicatorEl &&
    !turn.statusIndicatorEl.hidden &&
    isInTree(turn.statusIndicatorEl, turn.turn)
  ) {
    pinTurnBottomChrome(turn);
    return turn.statusIndicatorEl;
  }

  turn.statusPhase = status;
  return showStatusIndicator(conversationId, status);
}

export async function stopAgent(conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  if (!session?.isSending || session.isStopping) return;
  session.isStopping = true;
  setStatusPhase(conversationId, STATUS_PHASE.STOPPING);
  if (session.activeAgentTurn?.meta) {
    session.activeAgentTurn.meta.hidden = false;
    session.activeAgentTurn.meta.textContent = "Stopping…";
  }
  cancelOpenToolCards(session.activeAgentTurn);
  try {
    await window.onecode.chat.cancel(conversationId);
  } catch (error) {
    console.error(error);
    session.isStopping = false;
  }
}

export function appendThinkingToken(text, conversationId = state.activeConversationId) {
  if (!text) return;
  const session = getSession(conversationId);
  if (!session) return;
  if (!session.activeAgentTurn) beginAgentTurn(conversationId);
  const turn = session.activeAgentTurn;

  // One-time chrome setup per thinking burst (not per chunk).
  // Keep Exploring open — Thought nests inside the active group.
  if (!turn._thinkingStreamReady) {
    flushPendingStream({ turnRef: turn });
    turn.thinkingSuppressedForExplore = false;
    ensureWorkSummary(turn);
    if (turn.thinkingFrozen || !turn.thinkingPanel) {
      beginThinkingSegment(turn);
    } else if (!turn.thinkingStartedAt) {
      turn.thinkingStartedAt = Date.now();
    }
    releaseCurrentTextBlock(turn);
    turn.meta.hidden = true;
    setStatusPhase(conversationId, null);
    turn._thinkingStreamReady = true;
    turn._textStreamReady = false;
  }

  turn.thinkingRaw = `${turn.thinkingRaw || ""}${text}`;
  if (turn.thinkingPanel) turn.thinkingPanel._thinkingRaw = turn.thinkingRaw;
  queueThinkingPaint(turn);
  if (conversationId === state.activeConversationId) scrollMessages();
}

export function ensureTextBlock(turnRef) {
  finalizeExploreGroup(turnRef);
  freezeThinkingLabel(turnRef);
  if (turnRef.currentTextBlock) return turnRef.currentTextBlock;

  const block = document.createElement("div");
  block.className = "turn-body markdown-body timeline-text";
  turnRef.timeline.appendChild(block);
  turnRef.currentTextBlock = block;
  return block;
}

function freezeThinkingLabel(turnRef) {
  sealThinkingSegment(turnRef);
}

function renderUserAttachments(container, attachments) {
  if (!container || !Array.isArray(attachments) || !attachments.length) return;
  const wrap = document.createElement("div");
  wrap.className = "turn-attachments";
  for (const att of attachments) {
    if (!att?.data) continue;
    const img = document.createElement("img");
    img.className = "turn-attachment-img";
    img.alt = "Attachment";
    img.src = `data:${att.mimeType || "image/png"};base64,${att.data}`;
    wrap.appendChild(img);
  }
  if (wrap.childNodes.length) container.appendChild(wrap);
}

export function attachRetryButton(turnRef, conversationId) {
  if (!turnRef?.turn) return;
  turnRef.turn.querySelector(".turn-actions")?.remove();
  const actions = document.createElement("div");
  actions.className = "turn-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "turn-retry-btn";
  btn.textContent = "Retry";
  btn.addEventListener("click", () => {
    retryLastPrompt(conversationId).catch((error) => {
      console.error(error);
      showChatError(error?.message || "Retry failed.", conversationId);
    });
  });
  actions.appendChild(btn);
  turnRef.turn.appendChild(actions);
}

export function addTurn(text, role, options = {}) {
  const conversationId = options.conversationId || state.activeConversationId;
  const session = getSession(conversationId);
  if (!session) return null;

  enterConversationMode(conversationId);

  const turn = document.createElement("article");
  turn.className = `turn ${role}`;
  if (options.error) turn.classList.add("error");
  if (options.streaming) turn.classList.add("streaming");

  const label = document.createElement("div");
  label.className = "turn-label";
  label.textContent =
    role === "user" ? "You" : options.error ? "Error" : "Agent";

  const timeline = document.createElement("div");
  timeline.className = "turn-timeline";

  const body = document.createElement("div");
  body.className = "turn-body markdown-body";

  const meta = document.createElement("div");
  meta.className = "turn-meta";
  meta.hidden = true;

  if (role === "agent" && !options.error) {
    turn.append(label, timeline, meta);
  } else if (role === "user") {
    // Keep "You" outside the sticky bubble so only the message chip pins.
    turn.append(body, meta);
  } else {
    turn.append(label, body, meta);
  }

  mountTurnInPanel(session, turn, role, label);

  const turnRef = {
    turn,
    body,
    timeline,
    meta,
    label,
    raw: "",
    thinkingRaw: "",
    thinkingPanel: null,
    thinkingSummary: null,
    thinkingLabel: null,
    thinkingContent: null,
    thinkingStartedAt: 0,
    thinkingFrozen: false,
    thinkingSegments: [],
    startedAt: Date.now(),
    toolCards: new Map(),
    activityLabels: new Map(),
    activityStats: null,
    exploreGroups: [],
    activeExploreGroup: null,
    thinkingSuppressedForExplore: false,
    workSummary: null,
    workSummaryLabel: null,
    approvalCards: new Map(),
    currentTextBlock: null,
    statusPhase: null,
    statusIndicatorEl: null,
    statusWordEl: null,
    conversationId,
  };

  if (role === "agent" && !options.error) {
    if (text) {
      turnRef.raw = text;
      const block = ensureTextBlock(turnRef);
      block._raw = text;
      block.innerHTML = renderMarkdown(text);
    }
  } else {
    setTurnContent(turnRef, text);
    if (role === "user") {
      renderUserAttachments(body, options.attachments);
    }
  }

  if (options.error) {
    attachRetryButton(turnRef, conversationId);
  }

  if (conversationId === state.activeConversationId) scrollMessages();
  return turnRef;
}

export function showStatusIndicator(
  conversationId = state.activeConversationId,
  label = STATUS_PHASE.THINKING
) {
  const session = getSession(conversationId);
  if (!session) return null;

  // Never spawn a new turn from a status update — that races with finishAgentTurn.
  const turn = session.activeAgentTurn;
  if (!turn?.turn) return null;
  if (!session.isSending && label !== STATUS_PHASE.STOPPING) return null;

  const status = String(label || STATUS_PHASE.THINKING).trim() || STATUS_PHASE.THINKING;
  let el = turn.statusIndicatorEl;
  // Reuse the existing indicator while it still lives under this turn — even if
  // the chat panel is detached (user switched away mid-stream).
  if (!el || !isInTree(el, turn.turn)) {
    el = document.createElement("div");
    el.className = "status-indicator";
    el.setAttribute("aria-live", "polite");
    const word = document.createElement("span");
    word.className = "status-indicator-word";
    el.appendChild(word);
    turn.statusIndicatorEl = el;
    turn.statusWordEl = word;
  }

  el.classList.remove("is-leaving");
  const wordEl = turn.statusWordEl || el.querySelector(".status-indicator-word");
  if (wordEl) {
    wordEl.textContent = status;
    turn.statusWordEl = wordEl;
  }
  el.setAttribute("aria-label", status);
  el.dataset.status = status.toLowerCase();
  turn.statusPhase = status;

  el.hidden = false;
  pinTurnBottomChrome(turn);
  if (conversationId === state.activeConversationId) scrollMessages();
  return el;
}

export function hideStatusIndicator(conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  const el = session?.activeAgentTurn?.statusIndicatorEl;
  if (el) el.hidden = true;
}

export function clearStatusIndicator(turnRef, { animate = true } = {}) {
  if (!turnRef) return;
  const el = turnRef.statusIndicatorEl;
  turnRef.statusPhase = null;
  if (!el) return;

  const remove = () => {
    el.remove();
    if (turnRef.statusIndicatorEl === el) {
      turnRef.statusIndicatorEl = null;
      turnRef.statusWordEl = null;
    }
  };

  // Skip leave animation when the turn isn't on-screen (detached panel).
  if (!animate || !el.isConnected || el.hidden) {
    remove();
    return;
  }

  el.classList.add("is-leaving");
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    remove();
  };
  el.addEventListener("transitionend", finish, { once: true });
  setTimeout(finish, 220);
}

export function beginAgentTurn(conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  if (!session) return null;
  if (session.activeAgentTurn) return session.activeAgentTurn;

  session.activeAgentTurn = addTurn("", "agent", {
    streaming: true,
    conversationId,
  });
  if (session.activeAgentTurn) {
    const turn = session.activeAgentTurn;
    turn.startedAt = Date.now();
    turn.meta.hidden = true;
    turn.statusPhase = null;
    // Immediate feedback — don't wait for the first model event.
    setStatusPhase(conversationId, STATUS_PHASE.THINKING);
  }
  return session.activeAgentTurn;
}

export function appendAgentToken(text, conversationId = state.activeConversationId) {
  if (!text) return;
  const session = getSession(conversationId);
  if (!session) return;
  if (!session.activeAgentTurn) beginAgentTurn(conversationId);
  const turn = session.activeAgentTurn;

  // One-time chrome when answer text starts (or resumes after thinking).
  if (!turn._textStreamReady) {
    flushPendingStream({ turnRef: turn });
    freezeThinkingLabel(turn);
    ensureWorkSummary(turn);
    turn._thinkingStreamReady = false;
    turn._textStreamReady = true;
  }

  turn.raw = `${turn.raw || ""}${text}`;
  const block = ensureTextBlock(turn);
  block._raw = `${block._raw || ""}${text}`;
  queueTextBlockPaint(block);

  turn.meta.hidden = true;
  setStatusPhase(conversationId, STATUS_PHASE.WRITING);
  if (conversationId === state.activeConversationId) scrollMessages();
}

export function serializeAgentTurn(turnRef) {
  if (!turnRef) {
    return { thinking: "", blocks: [], text: "", error: false };
  }

  const blocks = [];
  if (turnRef.timeline) {
    for (const child of turnRef.timeline.children) {
      if (child.classList.contains("thinking-panel")) {
        const text = String(
          child._thinkingRaw ||
            child.querySelector?.(".thinking-content")?.textContent ||
            ""
        ).trim();
        if (text) blocks.push({ type: "thinking", text });
        continue;
      }
      if (child.classList.contains("timeline-text")) {
        const text = String(child._raw || "");
        if (!text.trim()) continue;
        blocks.push({ type: "text", text });
        continue;
      }
      if (child.classList.contains("explore-group")) {
        const group = (turnRef.exploreGroups || []).find((g) => g.el === child);
        const body = group?.body || child.querySelector?.(".explore-group-body");
        const items = [];
        if (body) {
          for (const entry of body.children) {
            if (entry.classList.contains("thinking-panel")) {
              const text = String(
                entry._thinkingRaw ||
                  entry.querySelector?.(".thinking-content")?.textContent ||
                  ""
              ).trim();
              if (text) items.push({ kind: "thinking", text });
              continue;
            }
            if (!entry.classList.contains("explore-item")) continue;
            const item =
              group?.items?.find((row) => row.el === entry) ||
              (entry.dataset.toolId &&
                group?.itemMap?.get?.(entry.dataset.toolId));
            if (!item?.name || item.name === "tool") continue;
            items.push({
              kind: "tool",
              id: item.id,
              name: item.name,
              args: item.args || {},
              argsText: item.argsText || "",
              output: item.output ?? null,
              status: item.status || "done",
            });
          }
        } else if (group?.items?.length) {
          for (const item of group.items) {
            if (!item.name || item.name === "tool") continue;
            items.push({
              kind: "tool",
              id: item.id,
              name: item.name,
              args: item.args || {},
              argsText: item.argsText || "",
              output: item.output ?? null,
              status: item.status || "done",
            });
          }
        }
        if (items.length) blocks.push({ type: "explore", items });
        continue;
      }
      if (child.classList.contains("activity-label")) {
        continue;
      }
      if (child.classList.contains("tool-card")) {
        const card = turnRef.toolCards.get(child.dataset.toolId);
        if (!card || card.name === "write_todos") continue;
        blocks.push({
          type: "tool",
          id: card.id,
          name: card.name,
          args: card.args || {},
          argsText: card.argsText || "",
          output: card.output ?? null,
          status: card.status || "done",
          images: Array.isArray(card.images) ? card.images : [],
        });
      }
    }
  }

  const session = getSession(turnRef.conversationId);
  if (session?.todos?.length) {
    blocks.push({
      type: "tool",
      id: `todos-${Date.now()}`,
      name: "write_todos",
      args: { todos: session.todos },
      argsText: "",
      output: null,
      status: "done",
    });
  }

  return {
    // Legacy single field — joined segments for older readers.
    thinking: allThinkingText(turnRef),
    blocks,
    text: turnRef.raw || "",
    error: Boolean(turnRef.turn?.classList.contains("error")),
  };
}

export async function persistUserMessage(conversationId, text, attachments = []) {
  try {
    await window.onecode.chats.addMessage(conversationId, {
      role: "user",
      content: {
        text,
        attachments: Array.isArray(attachments) ? attachments : [],
      },
    });
  } catch (error) {
    console.error("Failed to persist user message:", error);
  }
}

export async function persistAgentTurn(conversationId, turnRef) {
  try {
    await window.onecode.chats.addMessage(conversationId, {
      role: "agent",
      content: serializeAgentTurn(turnRef),
    });
  } catch (error) {
    console.error("Failed to persist agent turn:", error);
  }
}

export function finishAgentTurn(status, conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  if (!session?.activeAgentTurn) return;

  const turn = session.activeAgentTurn;
  flushPendingStream({ turnRef: turn });
  turn._thinkingStreamReady = false;
  turn._textStreamReady = false;
  // Drop live status immediately so nothing can race it back on.
  turn.statusPhase = null;
  clearStatusIndicator(turn, { animate: true });
  turn.turn.classList.remove("streaming");

  if (status === "cancelled") {
    cancelOpenToolCards(turn);
  } else {
    // Clear hung spinners / unnamed "tool" ghosts when the run ends.
    settleOpenToolCards(turn);
    settleApprovalCards(turn);
  }

  const hasTools =
    (turn.exploreGroups || []).some((g) => g.items?.length) ||
    [...turn.toolCards.values()].some(
      (card) => card.name && card.name !== "tool"
    );
  const hasThinking = Boolean(allThinkingText(turn).trim());
  const hasText = Boolean(turn.raw?.trim());

  if (!hasText && !hasTools) {
    if (status === "cancelled") {
      const block = ensureTextBlock(turn);
      block._raw = "Cancelled.";
      block.innerHTML = renderMarkdown("Cancelled.");
      turn.raw = "Cancelled.";
    } else if (status !== "error" && !hasThinking) {
      const block = ensureTextBlock(turn);
      block._raw = "(No response)";
      block.innerHTML = renderMarkdown("(No response)");
      turn.raw = "(No response)";
    }
  } else if (hasText && turn.timeline) {
    // Re-render every text segment (not only the last currentTextBlock).
    // After tools, currentTextBlock is cleared, so older segments would be skipped.
    for (const child of turn.timeline.children) {
      if (!child.classList.contains("timeline-text")) continue;
      const raw = child._raw || "";
      if (!raw.trim()) continue;
      child.innerHTML = renderMarkdown(raw);
      child.classList.remove("is-plain-stream");
    }
  }

  // Always finalize the active thinking burst so shimmering "Thinking" never sticks.
  if (turn.thinkingRaw?.trim() && !turn.thinkingFrozen) {
    sealThinkingSegment(turn);
  } else if (turn.thinkingPanel && !turn.thinkingRaw?.trim()) {
    turn.thinkingPanel.hidden = true;
    turn.thinkingPanel.classList.remove("is-streaming");
    turn.thinkingSummary?.classList.remove("is-streaming");
  }

  pruneEmptyTimelineNodes(turn);
  finalizeExploreGroup(turn);
  finalizeWorkSummary(turn);
  pinTurnBottomChrome(turn);

  if (status === "done" || status === "cancelled") {
    turn.meta.hidden = true;
  }

  const finished = turn;
  session.activeAgentTurn = null;
  persistAgentTurn(conversationId, finished);

  // Keep follow-mode users at the end after settle/layout; don't yank if they scrolled away.
  if (conversationId === state.activeConversationId && state.stickToBottom) {
    scrollMessages({ force: true });
  }
}

export function showChatError(message, conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  if (session?.activeAgentTurn) {
    const turn = session.activeAgentTurn;
    clearStatusIndicator(turn);
    turn.turn.classList.add("error");
    turn.label.textContent = "Error";
    cancelOpenToolCards(turn);
    const block = ensureTextBlock(turn);
    block._raw = message;
    block.innerHTML = renderMarkdown(message);
    turn.raw = message;
    turn.meta.hidden = true;
    turn.turn.classList.remove("streaming");
    session.activeAgentTurn = null;
    attachRetryButton(turn, conversationId);
    persistAgentTurn(conversationId, turn);
    return;
  }
  const turn = addTurn(message, "agent", { error: true, conversationId });
  if (turn) persistAgentTurn(conversationId, turn);
}

export async function retryLastPrompt(conversationId = state.activeConversationId) {
  const session = getSession(conversationId);
  if (!session?.lastPrompt || session.isSending) return;
  const { text, skills, attachments, modelId } = session.lastPrompt;
  if (state.activeConversationId !== conversationId) {
    await selectConversation(conversationId);
  }
  // Restore composer text for visibility, then send via the stored payload.
  const { setComposerPlainText } = await import("./composer.js");
  setComposerPlainText(text || "");
  if (Array.isArray(attachments) && attachments.length) {
    session.pendingAttachments = attachments.map((a) => ({ ...a }));
    renderAttachmentPreviews();
  }
  await submitPromptText(text || "", {
    conversationId,
    skills,
    attachments,
    modelId,
    skipComposerRead: true,
  });
}

export async function submitPromptText(
  text,
  {
    conversationId = state.activeConversationId,
    skills = null,
    attachments = null,
    modelId = null,
    skipComposerRead = false,
  } = {}
) {
  let session = getSession(conversationId);
  if (!session) {
    await createNewChat();
    session = getSession();
    conversationId = session?.id;
  }
  if (!session || !conversationId) return;

  if (state.activeConversationId !== conversationId) {
    await selectConversation(conversationId);
    session = getSession(conversationId);
  }
  if (!session) return;

  if (session.isSending) {
    stopAgent(session.id);
    return;
  }

  const selectedSkills = skills || (skipComposerRead ? [] : getComposerSelectedSkills());
  const messageText = String(text || "").trim();
  const pending = Array.isArray(attachments)
    ? attachments
    : skipComposerRead
      ? []
      : getPendingAttachments();

  if (!messageText && !selectedSkills.length && !pending.length) return;
  if (!messageText && !pending.length) return;

  const overrideId = Number(modelId);
  const selected =
    Number.isInteger(overrideId) && overrideId > 0
      ? state.customModels.find((model) => model.id === overrideId) || getSelectedModel()
      : getSelectedModel();
  if (!selected) {
    addTurn("No model selected. Add a model in Settings, then pick it in the composer.", "agent", {
      error: true,
      conversationId: session.id,
    });
    return;
  }

  if (!session.workspacePath) {
    addTurn("Pick a workspace folder first (path chip).", "agent", {
      error: true,
      conversationId: session.id,
    });
    return;
  }

  session.lastPrompt = {
    text: messageText,
    skills: selectedSkills,
    modelId: selected.id,
    mcp: getMcpChatPayload(),
    attachments: pending,
  };
  session.activeRunModelId = selected.id;

  addTurn(messageText || "(image)", "user", {
    conversationId: session.id,
    attachments: pending,
  });
  persistUserMessage(session.id, messageText, pending);
  clearComposer();
  clearPendingAttachments();
  closeSkillsSlashMenu();
  setSending(session.id, true);
  beginAgentTurn(session.id);
  syncComposerModelLabel();
  scrollMessages({ force: true });

  try {
    const result = await window.onecode.chat.send({
      conversationId: session.id,
      message: messageText || "Please analyze the attached image(s).",
      modelId: selected.id,
      mcp: getMcpChatPayload(),
      skills: selectedSkills,
      attachments: pending,
      requireToolApproval: !isAllPermissionsEnabled(),
    });

    if (result?.conversation) {
      session.title = result.conversation.title || session.title;
      const idx = state.conversations.findIndex((c) => c.id === session.id);
      if (idx >= 0) {
        state.conversations[idx] = {
          ...state.conversations[idx],
          title: result.conversation.title,
          updatedAt: result.conversation.updatedAt,
        };
        const [item] = state.conversations.splice(idx, 1);
        state.conversations.unshift(item);
      }
      renderChatList();
    }
  } catch (error) {
    showChatError(error?.message || "Failed to start chat.", session.id);
  } finally {
    session.activeRunModelId = null;
    if (session.activeAgentTurn) {
      finishAgentTurn(session.isStopping ? "cancelled" : "done", session.id);
    }
    setSending(session.id, false);
    syncComposerModelLabel();
    if (state.activeConversationId === session.id) {
      input.focus({ preventScroll: true });
    }
  }
}

export function restoreMessage(session, message) {
  const role = message.role;
  const content = message.content || {};

  if (role === "user") {
    addTurn(content.text || "", "user", {
      conversationId: session.id,
      attachments: content.attachments,
    });
    return;
  }

  if (content.error && !content.blocks?.length && content.text) {
    addTurn(content.text, "agent", {
      error: true,
      conversationId: session.id,
    });
    return;
  }

  const turnRef = addTurn("", "agent", { conversationId: session.id });
  if (!turnRef) return;

  const blocks = Array.isArray(content.blocks) ? content.blocks : null;
  const hasThinkingBlocks = Boolean(
    blocks?.some((block) => block.type === "thinking" && block.text?.trim())
  );

  // Legacy: single top-level thinking blob when segments weren't stored in blocks.
  if (content.thinking && !hasThinkingBlocks) {
    setThinkingContent(turnRef, content.thinking, { streaming: false });
  }

  if (blocks?.length) {
    let exploreBatch = [];
    const flushExploreBatch = () => {
      if (!exploreBatch.length) return;
      restoreExploreGroup(turnRef, exploreBatch);
      exploreBatch = [];
    };

    for (const block of blocks) {
      if (block.type === "thinking") {
        flushExploreBatch();
        const text = block.text || "";
        if (!text.trim()) continue;
        // Each stored burst becomes its own sealed dropdown.
        setThinkingContent(turnRef, text, {
          streaming: false,
          forceNew: true,
        });
        releaseCurrentTextBlock(turnRef);
      } else if (block.type === "text") {
        flushExploreBatch();
        const text = block.text || "";
        if (!text.trim()) continue;
        turnRef.raw = `${turnRef.raw || ""}${text}`;
        const el = ensureTextBlock(turnRef);
        el._raw = text;
        el.innerHTML = renderMarkdown(text);
        releaseCurrentTextBlock(turnRef);
      } else if (block.type === "explore") {
        flushExploreBatch();
        const items = Array.isArray(block.items) ? block.items : [];
        if (items.length) restoreExploreGroup(turnRef, items);
      } else if (block.type === "tool") {
        if (block.name === "write_todos") {
          flushExploreBatch();
          const todos = extractTodos(block.args, block.argsText, block.output);
          if (todos?.length) {
            setSessionTodos(session.id, todos, { force: true });
          }
          continue;
        }
        // Legacy: consecutive explore tool blocks from older sessions.
        if (isGroupedExploreTool(block.name)) {
          exploreBatch.push(block);
          continue;
        }
        flushExploreBatch();
        const card = createToolCard(
          turnRef,
          {
            id: block.id || `tool-${Date.now()}`,
            name: block.name || "tool",
            args: block.args || {},
            argsText: block.argsText || "",
            images: block.images || [],
          },
          { skipActivity: true }
        );
        if (!card) continue;
        card.output = block.output ?? null;
        card.images = Array.isArray(block.images) ? block.images : [];
        card.status = block.status || "done";
        updateToolCardHeader(card);
        fillToolPane(card, {
          args: card.args,
          output: card.output,
          argsText: card.argsText,
          images: card.images,
        });
        const keepOpen =
          card.name === "write_file" ||
          card.name === "edit_file" ||
          card.name === "execute" ||
          card.name === "browser_take_screenshot" ||
          Boolean(card.images?.length) ||
          card.status === "error";
        card.el.open = keepOpen;
        if (card.status === "error") {
          attachToolRetry(card, session.id);
        }
        releaseCurrentTextBlock(turnRef);
      }
    }
    flushExploreBatch();
  } else if (content.text) {
    turnRef.raw = content.text;
    const el = ensureTextBlock(turnRef);
    el._raw = content.text;
    el.innerHTML = renderMarkdown(content.text);
  }

  if (content.error) {
    turnRef.turn.classList.add("error");
    turnRef.label.textContent = "Error";
    attachRetryButton(turnRef, session.id);
  }

  if (turnRef.workSummary) {
    if (turnRef.workSummaryLabel) {
      turnRef.workSummaryLabel.textContent = "Previous work";
    }
    turnRef.workSummary.open = true;
  }

  pruneEmptyTimelineNodes(turnRef);
  pinTurnBottomChrome(turnRef);
}

/** Collapsed workspace group keys; missing key means expanded (default). */
const collapsedChatGroups = new Set();

function workspaceGroupKey(workspacePath) {
  return workspacePath || "__no_workspace__";
}

function workspaceGroupLabel(workspacePath) {
  if (!workspacePath) return "No workspace";
  return basenamePath(workspacePath) || workspacePath;
}

function isChatGroupCollapsed(key) {
  return collapsedChatGroups.has(key);
}

function toggleChatGroupCollapsed(key) {
  if (collapsedChatGroups.has(key)) collapsedChatGroups.delete(key);
  else collapsedChatGroups.add(key);
}

function groupConversationsByWorkspace(conversations) {
  const groups = new Map();
  for (const chat of conversations) {
    const key = workspaceGroupKey(chat.workspacePath);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        workspacePath: chat.workspacePath || null,
        label: workspaceGroupLabel(chat.workspacePath),
        chats: [],
      };
      groups.set(key, group);
    }
    group.chats.push(chat);
  }

  const ordered = [...groups.values()];
  ordered.sort((a, b) => {
    if (!a.workspacePath && b.workspacePath) return 1;
    if (a.workspacePath && !b.workspacePath) return -1;
    return 0;
  });
  return ordered;
}

function createChatListItem(chat) {
  const row = document.createElement("div");
  row.className = "chat-item-row";
  row.dataset.conversationId = chat.id;
  if (chat.id === state.activeConversationId) row.classList.add("active");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chat-item";
  btn.role = "listitem";
  btn.dataset.conversationId = chat.id;
  if (chat.id === state.activeConversationId) btn.classList.add("active");

  const title = document.createElement("span");
  title.className = "chat-item-title";
  title.textContent = chat.title || "New chat";
  btn.appendChild(title);

  const session = getSession(chat.id);
  if (session?.isSending) {
    const dot = document.createElement("span");
    dot.className = "chat-item-running";
    dot.title = "Running";
    btn.appendChild(dot);
  }

  btn.addEventListener("click", () => {
    selectConversation(chat.id).catch((error) => {
      console.error(error);
      showChatError(error?.message || "Failed to open chat.");
    });
  });

  const actions = document.createElement("div");
  actions.className = "chat-item-actions";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "chat-item-delete";
  deleteBtn.title = "Delete conversation";
  deleteBtn.setAttribute("aria-label", "Delete conversation");
  deleteBtn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.5 3.5h9M5.5 3.5V2.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M5 6v4.5M7 6v4.5M9 6v4.5M3.5 3.5l.5 8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  deleteBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteConversation(chat.id).catch((error) => {
      console.error(error);
      showChatError(error?.message || "Failed to delete chat.");
    });
  });

  actions.append(deleteBtn);
  row.append(btn, actions);
  return row;
}

/** Light update: active row + running dots without rebuilding the sidebar. */
export function patchChatListStatus() {
  if (!chatListEl) return;
  const rows = chatListEl.querySelectorAll(".chat-item-row[data-conversation-id]");
  if (!rows.length) {
    renderChatList();
    return;
  }

  for (const row of rows) {
    const id = row.dataset.conversationId;
    const active = id === state.activeConversationId;
    row.classList.toggle("active", active);
    const btn = row.querySelector(".chat-item");
    if (btn) btn.classList.toggle("active", active);

    const session = getSession(id);
    const running = Boolean(session?.isSending);
    let dot = btn?.querySelector(".chat-item-running");
    if (running && btn && !dot) {
      dot = document.createElement("span");
      dot.className = "chat-item-running";
      dot.title = "Running";
      btn.appendChild(dot);
    } else if (!running && dot) {
      dot.remove();
    }
  }
}

export function renderChatList() {
  if (!chatListEl) return;
  chatListEl.innerHTML = "";

  if (!state.conversations.length) {
    const empty = document.createElement("div");
    empty.className = "chat-list-empty";
    empty.textContent = "No chats yet";
    chatListEl.appendChild(empty);
    return;
  }

  const groups = groupConversationsByWorkspace(state.conversations);
  for (const group of groups) {
    const collapsed = isChatGroupCollapsed(group.key);
    const section = document.createElement("section");
    section.className = "chat-group";
    if (collapsed) section.classList.add("collapsed");

    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "chat-group-label";
    heading.setAttribute("aria-expanded", collapsed ? "false" : "true");
    heading.title = group.workspacePath || group.label;

    const chevron = document.createElement("span");
    chevron.className = "chat-group-chevron";
    chevron.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = "chat-group-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = group.workspacePath
      ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h4l1.2 1.5H13.5v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4.5 2.5h5l3 3V13.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.5 2.5v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

    const label = document.createElement("span");
    label.className = "chat-group-name";
    label.textContent = group.label;

    heading.append(chevron, icon, label);
    heading.addEventListener("click", () => {
      toggleChatGroupCollapsed(group.key);
      const nowCollapsed = isChatGroupCollapsed(group.key);
      section.classList.toggle("collapsed", nowCollapsed);
      heading.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
    });
    section.appendChild(heading);

    const items = document.createElement("div");
    items.className = "chat-group-items";
    const itemsInner = document.createElement("div");
    itemsInner.className = "chat-group-items-inner";
    for (const chat of group.chats) {
      itemsInner.appendChild(createChatListItem(chat));
    }
    items.appendChild(itemsInner);
    section.appendChild(items);

    chatListEl.appendChild(section);
  }
}

export async function deleteConversation(conversationId) {
  if (!conversationId) return;

  const chat = state.conversations.find((c) => c.id === conversationId);
  const title = chat?.title || "this chat";
  const confirmed = window.confirm(`Delete “${title}”? This cannot be undone.`);
  if (!confirmed) return;

  const wasActive = conversationId === state.activeConversationId;
  const session = getSession(conversationId);
  if (session?.isSending) {
    try {
      await window.onecode.chat.cancel(conversationId);
    } catch {
      // continue with delete
    }
  }

  await window.onecode.chats.delete(conversationId);

  state.conversations = state.conversations.filter((c) => c.id !== conversationId);
  state.chatSessions.delete(conversationId);

  if (!wasActive) {
    renderChatList();
    return;
  }

  const nextId = state.conversations[0]?.id || null;
  if (nextId) {
    await selectConversation(nextId);
  } else {
    state.activeConversationId = null;
    localStorage.removeItem(ACTIVE_CHAT_KEY);
    messagesEl.replaceChildren();
    await createNewChat();
  }
}

const SIDEBAR_WIDTH_KEY = "onecode.sidebarWidth";
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 300;

function clampSidebarWidth(width) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function applySidebarWidth(width) {
  if (!sidebarEl) return;
  const next = clampSidebarWidth(width);
  sidebarEl.style.setProperty("--sidebar-width", `${next}px`);
  return next;
}

export function initSidebarResize() {
  if (!sidebarEl || !sidebarResizer) return;

  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  applySidebarWidth(Number.isFinite(saved) ? saved : SIDEBAR_DEFAULT_WIDTH);

  let dragging = false;

  const onPointerMove = (event) => {
    if (!dragging) return;
    const next = applySidebarWidth(event.clientX);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  };

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("sidebar-resizing");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDragging);
  };

  sidebarResizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    document.body.classList.add("sidebar-resizing");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDragging);
  });

  sidebarResizer.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 24 : 12;
    let delta = 0;
    if (event.key === "ArrowLeft") delta = -step;
    if (event.key === "ArrowRight") delta = step;
    if (!delta) return;
    event.preventDefault();
    const current = sidebarEl.getBoundingClientRect().width;
    const next = applySidebarWidth(current + delta);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  });
}

export async function refreshConversationList() {
  if (chatListEl && !chatListEl.childElementCount) {
    setSkeleton(chatListEl, createListSkeleton(6, "chat"));
  }
  state.conversations = await window.onecode.chats.list();
  for (const chat of state.conversations) {
    ensureUiSession(chat);
  }
  renderChatList();
}

export async function hydrateSessionMessages(session) {
  if (session.hydrated) return;
  const detail = await window.onecode.chats.get(session.id);
  session.title = detail.title || session.title;
  session.workspacePath = detail.workspacePath || null;
  session.panel.replaceChildren();
  session.stickyGroup = null;
  session.todos = [];
  session.todoFingerprint = "";
  for (const message of detail.messages || []) {
    restoreMessage(session, message);
  }
  const latest = extractLatestTodosFromMessages(detail.messages || []);
  if (latest.length) {
    setSessionTodos(session.id, latest, { force: true });
  }
  session.started = session.panel.childElementCount > 0;
  session.hydrated = true;
}

export async function mountConversation(conversationId) {
  const session = getSession(conversationId);
  if (!session) {
    throw new Error("Conversation not found.");
  }

  state.activeConversationId = conversationId;
  localStorage.setItem(ACTIVE_CHAT_KEY, conversationId);
  messagesEl.replaceChildren(session.panel);
  refreshStickyUserObservers(session.panel);
  scrollMessages({ force: true });

  form.classList.toggle("sending", session.isSending);
  if (runStatus) runStatus.hidden = !session.isSending;
  syncSendButton();
  syncShellMode(session);
  syncTodoPanel(conversationId);
  renderAttachmentPreviews();

  const workspace = await window.onecode.workspace.get(conversationId);
  applyWorkspaceToUi(workspace?.path || session.workspacePath, workspace?.label);
  if (session.workspacePath || workspace?.path) {
    session.workspacePath = workspace?.path || session.workspacePath;
  }
  renderChatList();
}

export async function selectConversation(conversationId) {
  if (!conversationId) return;

  const session = ensureUiSession(
    state.conversations.find((c) => c.id === conversationId) || { id: conversationId }
  );

  if (conversationId === state.activeConversationId && session.hydrated) {
    // Still clear any leftover loading lock (e.g. bootstrap skeleton).
    clearThreadLoadingState();
    syncShellMode(session);
    return;
  }

  const seq = ++chatLoadSeq;
  const needsHydrate = !session.hydrated;

  try {
    if (needsHydrate) {
      showThreadLoadingSkeleton();
      await hydrateSessionMessages(session);
      if (seq !== chatLoadSeq) return;
    }

    await mountConversation(conversationId);
    if (seq !== chatLoadSeq) return;

    clearThreadLoadingState();
    syncShellMode(session);
    input.focus();
    refreshContextUsage();
  } catch (error) {
    if (seq !== chatLoadSeq) return;
    clearThreadLoadingState();
    syncShellMode(getSession());
    throw error;
  }
}

export async function createNewChat() {
  chatLoadSeq += 1;
  clearThreadLoadingState();

  const current = getSession();
  const inheritWorkspace = current?.workspacePath || null;
  const created = await window.onecode.chats.create({
    workspacePath: inheritWorkspace,
  });
  ensureUiSession(created);
  const session = getSession(created.id);
  session.hydrated = true;
  session.started = false;
  session.todos = [];
  session.todoFingerprint = "";
  session.panel.replaceChildren();
  session.stickyGroup = null;
  state.conversations = [created, ...state.conversations.filter((c) => c.id !== created.id)];
  await mountConversation(created.id);
  syncShellMode(session);
  renderChatList();
  input.focus();
  refreshContextUsage();
  return created;
}

export async function pickWorkspace() {
  if (!state.activeConversationId) return;
  const workspace = await window.onecode.workspace.pick(state.activeConversationId);
  if (workspace?.cancelled) return;

  applyWorkspaceToUi(workspace?.path, workspace?.label);
  const session = getSession();
  if (session) session.workspacePath = workspace?.path || null;

  const idx = state.conversations.findIndex((c) => c.id === state.activeConversationId);
  if (idx >= 0) {
    state.conversations[idx] = {
      ...state.conversations[idx],
      workspacePath: workspace?.path || null,
    };
  }
  renderChatList();

  if (session?.started) {
    addTurn(
      `Workspace set to ${workspace?.label || workspace?.path}. Conversation memory reset for the new folder.`,
      "agent",
      { conversationId: state.activeConversationId }
    );
  }

  refreshContextUsage({ force: true });
}

export async function submitPrompt(prefix = "") {
  const text = `${prefix}${getComposerPlainText()}`.trim();
  await submitPromptText(text);
}

function getTurnCopyText(turnEl) {
  if (!turnEl) return "";

  if (turnEl.classList.contains("user")) {
    const body = turnEl.querySelector(":scope > .turn-body");
    if (body && body._raw != null) return String(body._raw);
    return String(body?.innerText || body?.textContent || "").trim();
  }

  // Agent / error: prefer stored markdown source from response text blocks.
  const parts = [];
  const timeline = turnEl.querySelector(":scope > .turn-timeline");
  if (timeline) {
    for (const child of timeline.children) {
      if (!child.classList.contains("timeline-text")) continue;
      const raw = child._raw != null ? String(child._raw) : "";
      if (raw.trim()) parts.push(raw);
    }
  }
  if (parts.length) return parts.join("\n\n").trim();

  const body = turnEl.querySelector(":scope > .turn-body");
  if (body && body._raw != null) return String(body._raw);
  return String(body?.innerText || body?.textContent || "").trim();
}

function findCopyableMessageTurn(target) {
  if (!target?.closest) return null;
  // Let native / specialized UI handle these.
  if (
    target.closest(
      ".tool-card, .explore-group, .thinking-panel, .turn-actions, .status-indicator, .code-copy-btn, button, input, textarea, select, a"
    )
  ) {
    return null;
  }
  return target.closest(".turn.user, .turn.agent");
}

let appContextMenuEl = null;
let appContextMenuCloser = null;

export function closeAppContextMenu() {
  if (appContextMenuCloser) {
    appContextMenuCloser();
    appContextMenuCloser = null;
  }
  if (appContextMenuEl) {
    appContextMenuEl.hidden = true;
    appContextMenuEl.replaceChildren();
  }
}

function ensureAppContextMenu() {
  if (appContextMenuEl) return appContextMenuEl;

  const menu = document.createElement("div");
  menu.className = "msg-context-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  document.body.appendChild(menu);
  appContextMenuEl = menu;
  return menu;
}

/**
 * @param {number} clientX
 * @param {number} clientY
 * @param {Array<{
 *   label: string,
 *   disabled?: boolean,
 *   keepOpen?: boolean,
 *   run?: (btn: HTMLButtonElement) => void | Promise<void>,
 * }>} items
 */
export function openAppContextMenu(clientX, clientY, items) {
  const menu = ensureAppContextMenu();
  closeAppContextMenu();

  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return;

  for (const spec of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-context-menu-item";
    btn.setAttribute("role", "menuitem");
    btn.textContent = spec.label;
    if (spec.disabled) {
      btn.disabled = true;
      btn.classList.add("is-disabled");
    }
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (btn.disabled) return;
      try {
        await spec.run?.(btn);
      } finally {
        if (!spec.keepOpen) closeAppContextMenu();
      }
    });
    menu.appendChild(btn);
  }

  menu.hidden = false;

  const pad = 8;
  const rect = menu.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + rect.width > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (top + rect.height > window.innerHeight - pad) {
    top = Math.max(pad, window.innerHeight - rect.height - pad);
  }
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;

  const onPointerDown = (event) => {
    if (menu.contains(event.target)) return;
    closeAppContextMenu();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") closeAppContextMenu();
  };
  const onScroll = () => closeAppContextMenu();
  const onBlur = () => closeAppContextMenu();

  const openToken = {};
  menu._openToken = openToken;

  window.setTimeout(() => {
    if (menu._openToken !== openToken || menu.hidden) return;
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    messagesEl?.addEventListener("scroll", onScroll, { passive: true });
  }, 0);

  appContextMenuCloser = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onBlur);
    messagesEl?.removeEventListener("scroll", onScroll);
  };
}

function initMessageContextMenu() {
  if (!messagesEl || messagesEl.dataset.msgContextBound === "1") return;
  messagesEl.dataset.msgContextBound = "1";

  messagesEl.addEventListener("contextmenu", (event) => {
    const turn = findCopyableMessageTurn(event.target);
    if (!turn || !messagesEl.contains(turn)) return;

    const text = getTurnCopyText(turn);
    if (!text) return;

    event.preventDefault();
    openAppContextMenu(event.clientX, event.clientY, [
      {
        label: "Copy message",
        keepOpen: true,
        run: async (btn) => {
          const ok = await copyTextToClipboard(text);
          if (ok) {
            btn.textContent = "Copied";
            btn.classList.add("is-copied");
            window.setTimeout(() => closeAppContextMenu(), 700);
          }
        },
      },
    ]);
  });
}

export function initChatEvents() {
  registerRenderChatList(renderChatList, patchChatListStatus);
  initCodeCopyDelegation(messagesEl || document);
  initMessageContextMenu();

  window.onecode.chat.onEvent((event) => {
      if (!event || typeof event !== "object") return;
      const conversationId = event.conversationId || state.activeConversationId;
      if (!conversationId || !getSession(conversationId)) return;
    
      switch (event.type) {
        case "start":
          // Ensure the turn + Thinking shimmer exist as soon as the run begins.
          if (!getSession(conversationId)?.activeAgentTurn) {
            beginAgentTurn(conversationId);
          } else {
            setStatusPhase(conversationId, STATUS_PHASE.THINKING);
          }
          break;
        case "thinking":
          appendThinkingToken(event.text || "", conversationId);
          break;
        case "token":
          appendAgentToken(event.text || "", conversationId);
          break;
        case "tool_call":
          upsertToolCall(event, conversationId);
          {
            // Timeline activity owns live chrome for explore/edit/execute.
            const phase = statusLabelForTool(event.name);
            setStatusPhase(conversationId, phase);
          }
          break;
        case "tool_output":
          appendExecuteOutput(event, conversationId);
          setStatusPhase(conversationId, null);
          break;
        case "approval_request":
          showApprovalRequest(event, conversationId);
          setStatusPhase(conversationId, null);
          break;
        case "tool_result":
          completeToolResult(event, conversationId);
          // Between tool rounds — wait on the model again, unless timeline
          // activity (Exploring / approvals) still owns the chrome.
          if (
            turnHasLiveTimelineActivity(
              getSession(conversationId)?.activeAgentTurn
            )
          ) {
            setStatusPhase(conversationId, null);
          } else {
            setStatusPhase(conversationId, STATUS_PHASE.THINKING);
          }
          break;
        case "error":
          showChatError(event.message || "Agent error.", conversationId);
          {
            const errSession = getSession(conversationId);
            if (errSession) errSession.activeRunModelId = null;
          }
          setSending(conversationId, false);
          syncComposerModelLabel();
          break;
        case "cancelled": {
          const session = getSession(conversationId);
          if (session) session.isStopping = true;
          setStatusPhase(conversationId, STATUS_PHASE.STOPPING);
          refreshContextUsage({ force: true });
          break;
        }
        case "usage":
          if (
            state.activeSettingsSection === "usage" &&
            settingsModal &&
            !settingsModal.hidden
          ) {
            refreshUsagePanel().catch((error) => {
              console.error(error);
            });
          }
          break;
        case "summarized":
          refreshContextUsage({ force: true });
          break;
        case "done": {
          const session = getSession(conversationId);
          if (session?.activeAgentTurn) {
            finishAgentTurn(session.isStopping ? "cancelled" : "done", conversationId);
          } else if (session) {
            // Stray status on a turn that already finished — scrub the panel.
            for (const el of session.panel?.querySelectorAll?.(
              ".status-indicator:not(.is-leaving)"
            ) || []) {
              el.remove();
            }
          }
          setSending(conversationId, false);
          refreshContextUsage({ force: true });
          break;
        }
        default:
          break;
      }
  });
}
