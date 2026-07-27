import {
  workspacePicker,
  workspaceChip,
  workspaceMenu,
  workspaceChangeBtn,
  workspaceOpenBtn,
  workspaceOpenLabel,
  workspaceCopyBtn,
  workspaceMenuDivider,
  workspaceMenuFiles,
  workspaceMenuFilesBar,
  workspaceUpBtn,
  workspaceMenuCrumb,
  workspaceMenuList,
  workspaceMenuEmpty,
  workspaceMenuUnset,
} from "./dom.js";
import { state, getSession } from "./state.js";
import { pickWorkspace, showChatError } from "./chat.js";
import { createListSkeleton, setSkeleton } from "./skeleton.js";

/** Relative path inside the workspace currently listed in the menu. */
let browseRelativePath = "";

function openInLabel() {
  const platform = window.onecode?.platform;
  if (platform === "darwin") return "Open in Finder";
  if (platform === "win32") return "Open in File Explorer";
  return "Open in file manager";
}

/** Match composer column: same center line, width at 0.7× composer. */
function syncWorkspacePickerWidth() {
  if (!workspacePicker) return;
  const composer = document.getElementById("composer");
  const titlebar = document.getElementById("titlebar");
  if (!composer || !titlebar) return;

  const composerRect = composer.getBoundingClientRect();
  const titlebarRect = titlebar.getBoundingClientRect();
  if (composerRect.width <= 0 || titlebarRect.width <= 0) return;

  const width = Math.max(180, Math.round(composerRect.width * 0.7));
  const composerCenter = composerRect.left + composerRect.width / 2;
  const left = composerCenter - titlebarRect.left - width / 2;

  workspacePicker.style.setProperty("--workspace-picker-width", `${width}px`);
  workspacePicker.style.width = `${width}px`;
  workspacePicker.style.left = `${Math.round(left)}px`;
  workspacePicker.style.right = "auto";
  workspacePicker.style.transform = "translateY(-50%)";
}

function activeWorkspacePath() {
  return getSession()?.workspacePath || null;
}

function folderIcon() {
  return `<svg class="workspace-menu-item-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4.5h4l1.2 1.5H13.5v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
}

function fileIcon() {
  return `<svg class="workspace-menu-item-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 2.5h5l3 3V13.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.5 2.5v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
}

function chevronIcon() {
  return `<svg class="workspace-menu-item-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3.5 2.5 6.5 5 3.5 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function parentRelative(rel) {
  const parts = String(rel || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function crumbLabel(rel) {
  if (!rel) return "Workspace root";
  const parts = rel.split("/").filter(Boolean);
  return parts[parts.length - 1] || "Workspace root";
}

function fileExtensionMeta(name) {
  const base = String(name || "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "File";
  return `${base.slice(dot + 1).toUpperCase()} file`;
}

function changeButtonLabel() {
  return workspaceChangeBtn?.querySelector("span:last-child") || workspaceChangeBtn?.querySelector("span");
}

export function closeWorkspaceMenu() {
  if (!workspaceMenu || !workspacePicker || !workspaceChip) return;
  workspaceMenu.hidden = true;
  workspacePicker.classList.remove("open");
  workspaceChip.setAttribute("aria-expanded", "false");
}

function createEntryButton(entry) {
  const isDir = entry.type === "dir";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `workspace-menu-item ${isDir ? "is-dir" : "is-file"}`;
  btn.setAttribute("role", "listitem");
  btn.title = isDir
    ? `Open folder “${entry.name}”`
    : `Reveal “${entry.name}” in ${openInLabel().replace(/^Open in /, "")}`;

  const badge = document.createElement("span");
  badge.className = "workspace-menu-item-badge";
  badge.innerHTML = isDir ? folderIcon() : fileIcon();

  const body = document.createElement("span");
  body.className = "workspace-menu-item-body";

  const name = document.createElement("span");
  name.className = "workspace-menu-item-name";
  name.textContent = entry.name;

  const meta = document.createElement("span");
  meta.className = "workspace-menu-item-meta";
  meta.textContent = isDir ? "Folder" : fileExtensionMeta(entry.name);

  body.append(name, meta);
  btn.append(badge, body);
  if (isDir) {
    const chevron = document.createElement("span");
    chevron.innerHTML = chevronIcon();
    btn.append(chevron.firstElementChild);
  }

  btn.addEventListener("click", () => {
    onEntryClick(entry).catch((error) => {
      showChatError(error?.message || "Failed to open item.");
    });
  });

  return btn;
}

async function loadEntries(relativePath = "") {
  const conversationId = state.activeConversationId;
  if (!conversationId || !activeWorkspacePath()) return;

  browseRelativePath = relativePath || "";
  if (workspaceMenuCrumb) workspaceMenuCrumb.textContent = crumbLabel(browseRelativePath);
  if (workspaceMenuFilesBar) workspaceMenuFilesBar.hidden = false;
  if (workspaceUpBtn) workspaceUpBtn.hidden = !browseRelativePath;
  if (workspaceMenuList) {
    setSkeleton(workspaceMenuList, createListSkeleton(7, "file"));
  }
  if (workspaceMenuEmpty) {
    workspaceMenuEmpty.hidden = true;
    const title = workspaceMenuEmpty.querySelector(".workspace-menu-empty-title");
    const body = workspaceMenuEmpty.querySelector(".workspace-menu-empty-body");
    if (title) title.textContent = "Empty folder";
    if (body) body.textContent = "No files in this directory.";
  }

  try {
    const result = await window.onecode.workspace.list(conversationId, browseRelativePath);
    const entries = Array.isArray(result?.entries) ? result.entries : [];

    if (workspaceMenuList) workspaceMenuList.replaceChildren();

    if (!entries.length) {
      if (workspaceMenuEmpty) workspaceMenuEmpty.hidden = false;
      return;
    }

    for (const entry of entries) {
      workspaceMenuList?.appendChild(createEntryButton(entry));
    }
  } catch (error) {
    if (workspaceMenuList) workspaceMenuList.replaceChildren();
    if (workspaceMenuEmpty) {
      workspaceMenuEmpty.hidden = false;
      const title = workspaceMenuEmpty.querySelector(".workspace-menu-empty-title");
      const body = workspaceMenuEmpty.querySelector(".workspace-menu-empty-body");
      if (title) title.textContent = "Couldn't load files";
      if (body) body.textContent = error?.message || "Something went wrong.";
    }
  }
}

async function onEntryClick(entry) {
  const conversationId = state.activeConversationId;
  if (!conversationId) return;

  if (entry.type === "dir") {
    await loadEntries(entry.relativePath);
    return;
  }

  await window.onecode.workspace.reveal(conversationId, entry.relativePath);
}

function syncMenuChrome() {
  const hasWorkspace = Boolean(activeWorkspacePath());

  if (workspaceOpenLabel) workspaceOpenLabel.textContent = openInLabel();
  if (workspaceOpenBtn) workspaceOpenBtn.hidden = !hasWorkspace;
  if (workspaceCopyBtn) workspaceCopyBtn.hidden = !hasWorkspace;
  if (workspaceMenuDivider) workspaceMenuDivider.hidden = !hasWorkspace;
  if (workspaceMenuFiles) workspaceMenuFiles.hidden = !hasWorkspace;
  if (workspaceMenuUnset) workspaceMenuUnset.hidden = hasWorkspace;

  const label = changeButtonLabel();
  if (label) {
    label.textContent = hasWorkspace ? "Change workspace…" : "Select workspace…";
  }
}

export async function openWorkspaceMenu() {
  if (!workspaceMenu || !workspacePicker || !workspaceChip) return;

  syncMenuChrome();
  workspaceMenu.hidden = false;
  workspacePicker.classList.add("open");
  workspaceChip.setAttribute("aria-expanded", "true");

  if (activeWorkspacePath()) {
    await loadEntries("");
  }
}

export async function toggleWorkspaceMenu() {
  if (!workspaceMenu) return;
  if (workspaceMenu.hidden) {
    await openWorkspaceMenu();
  } else {
    closeWorkspaceMenu();
  }
}

export function initWorkspaceMenu() {
  if (!workspaceChip) return;

  syncWorkspacePickerWidth();
  const composer = document.getElementById("composer");
  const sidebar = document.getElementById("sidebar");
  const shell = document.getElementById("shell");
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => syncWorkspacePickerWidth());
    if (composer) observer.observe(composer);
    if (sidebar) observer.observe(sidebar);
    if (shell) observer.observe(shell);
  }
  window.addEventListener("resize", syncWorkspacePickerWidth);

  workspaceChip.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleWorkspaceMenu().catch((error) => {
      showChatError(error?.message || "Failed to open workspace menu.");
    });
  });

  workspaceMenu?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  workspaceChangeBtn?.addEventListener("click", () => {
    closeWorkspaceMenu();
    pickWorkspace().catch((error) => {
      showChatError(error?.message || "Failed to pick workspace.");
    });
  });

  workspaceOpenBtn?.addEventListener("click", () => {
    const conversationId = state.activeConversationId;
    if (!conversationId || !activeWorkspacePath()) return;
    window.onecode.workspace
      .open(conversationId, "")
      .catch((error) => {
        showChatError(error?.message || "Failed to open workspace.");
      });
  });

  workspaceCopyBtn?.addEventListener("click", async () => {
    const fullPath = activeWorkspacePath();
    if (!fullPath) return;
    try {
      await navigator.clipboard.writeText(fullPath);
      closeWorkspaceMenu();
    } catch (error) {
      showChatError(error?.message || "Failed to copy path.");
    }
  });

  workspaceUpBtn?.addEventListener("click", () => {
    loadEntries(parentRelative(browseRelativePath)).catch((error) => {
      showChatError(error?.message || "Failed to go up.");
    });
  });

  document.addEventListener("click", (event) => {
    if (!workspacePicker || workspaceMenu?.hidden) return;
    if (workspacePicker.contains(event.target)) return;
    closeWorkspaceMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && workspaceMenu && !workspaceMenu.hidden) {
      closeWorkspaceMenu();
    }
  });
}
