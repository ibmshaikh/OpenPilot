import {
  form,
  input,
  sendBtn,
  runStatusBtn,
  planPill,
  multitaskPill,
  polishChip,
  polishChipLabel,
  newChatBtn,
  modelChip,
  modelPicker,
  mcpPicker,
  mcpPill,
  mcpEnabledToggle,
  mcpSelectAllBtn,
  mcpSelectNoneBtn,
  mcpMenuOpenSettings,
  mcpMenu,
  modelMenu,
  skillsSlashMenu,
  settingsBtn,
  settingsClose,
  settingsCancel,
  addModelBtn,
  addSkillBtn,
  skillForm,
  skillFormClose,
  skillFormCancel,
  skillFormModal,
  skillsRevealUserBtn,
  skillsRevealProjectBtn,
  settingsNavItems,
  usageRefreshBtn,
  usageResetBtn,
  aboutCheckUpdateBtn,
  tinyfishForm,
  memoryForm,
  agentForm,
  memoryRevealUserBtn,
  memoryRevealProjectBtn,
  mcpReloadBtn,
  mcpOpenConfigBtn,
  mcpRevealConfigBtn,
  mcpRefreshLogsBtn,
  mcpBannerEl,
  modelForm,
  modelFormClose,
  modelFormCancel,
  modelFormModal,
  settingsModal,
  shell,
} from "./dom.js";

const platform = window.onecode?.platform || "darwin";
document.body.classList.add(
  platform === "darwin"
    ? "platform-mac"
    : platform === "win32"
      ? "platform-win"
      : "platform-linux"
);
import { state, getSession, syncSendButton, ACTIVE_CHAT_KEY } from "./state.js";
import {
  handleComposerKeydown,
  handleComposerInput,
  getComposerPlainText,
  getComposerSelectedSkills,
  getSelectedModel,
  setComposerPlainText,
  closeSkillsSlashMenu,
  updateSkillsSlashMenu,
  toggleModelMenu,
  closeModelMenu,
  closeMcpMenu,
  toggleMcpMenu,
  setMcpChatEnabled,
  selectAllMcpServers,
  selectNoMcpServers,
  syncComposerModelLabel,
  syncComposerSetupBanner,
  renderModelMenu,
  renderMcpChatControls,
  initAttachments,
  addAttachmentsFromFiles,
} from "./composer.js";
import {
  openSettings,
  closeSettings,
  openModelForm,
  closeModelForm,
  saveModel,
  openSkillForm,
  closeSkillForm,
  saveSkill,
  showSkillFormError,
  revealSkillsDir,
  setSettingsSection,
  refreshUsagePanel,
  resetUsagePanel,
  checkForAppUpdates,
  saveTinyFishSettings,
  showTinyFishFormError,
  saveMemorySettings,
  saveAgentSettings,
  revealMemoryFile,
  renderMcpStatus,
  refreshMcpLogs,
  refreshModels,
} from "./settings.js";
import { initOnboarding, startOnboarding } from "./onboarding.js";
import {
  stopAgent,
  submitPrompt,
  createNewChat,
  addTurn,
  showChatError,
  initScrollListeners,
  initChatEvents,
  initSidebarResize,
  selectConversation,
  refreshConversationList,
  showThreadLoadingSkeleton,
  clearThreadLoadingState,
} from "./chat.js";
import { initContextUsage, refreshContextUsage } from "./context-usage.js";
import { initWorkspaceMenu } from "./workspace-menu.js";

initScrollListeners();
initChatEvents();
initSidebarResize();
initContextUsage();
initAttachments();
initWorkspaceMenu();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const session = getSession();
  if (session?.isSending) {
    stopAgent(session.id);
    return;
  }
  submitPrompt();
});

if (sendBtn) {
  sendBtn.addEventListener("click", (event) => {
    const session = getSession();
    if (!session?.isSending) return;
    event.preventDefault();
    stopAgent(session.id);
  });
}

if (runStatusBtn) {
  runStatusBtn.addEventListener("click", () => {
    stopAgent();
  });
}

input.addEventListener("keydown", handleComposerKeydown);
input.addEventListener("input", handleComposerInput);
input.addEventListener("paste", (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const imageFiles = items
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);

  if (imageFiles.length) {
    event.preventDefault();
    addAttachmentsFromFiles(imageFiles).catch((error) => console.error(error));
    const text = event.clipboardData?.getData("text/plain") || "";
    if (text) document.execCommand("insertText", false, text);
    return;
  }

  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") || "";
  document.execCommand("insertText", false, text);
});
input.addEventListener("keyup", () => {
  // Keep menu in sync after delete/navigation
  if (!state.slashMenuOpen) return;
  updateSkillsSlashMenu().catch((error) => console.error(error));
});
input.addEventListener("blur", () => {
  // Delay so mousedown on menu items can fire
  window.setTimeout(() => {
    if (!skillsSlashMenu?.contains(document.activeElement)) {
      closeSkillsSlashMenu();
    }
  }, 150);
});
document.addEventListener("mousedown", (event) => {
  if (!state.slashMenuOpen) return;
  if (skillsSlashMenu?.contains(event.target) || input?.contains(event.target)) return;
  closeSkillsSlashMenu();
});
syncSendButton();

planPill.addEventListener("click", () => {
  if (!getComposerPlainText().trim() && !getComposerSelectedSkills().length) {
    setComposerPlainText("Plan a new idea: ");
    input.focus();
    return;
  }
  submitPrompt("Plan: ");
});

multitaskPill.addEventListener("click", () => {
  addTurn("Multitask mode — describe parallel tasks to run.", "agent");
  input.focus();
});

let polishInFlight = false;
/** Captured on pointerdown so focus loss cannot race the click handler. */
let polishDraftCapture = "";

function readPolishDraft() {
  const live = document.getElementById("message-input");
  const fromHelper = getComposerPlainText();
  if (fromHelper.trim()) return fromHelper;

  if (!live) return "";
  return String(live.innerText || live.textContent || "").replace(/\u00a0/g, " ");
}

async function polishComposerPrompt(prefetchedDraft = "") {
  if (!polishChip || polishInFlight) return;

  if (typeof window.onecode?.chat?.polishPrompt !== "function") {
    showChatError("Polish is unavailable. Restart the app to load the latest version.");
    return;
  }

  const draft = String(prefetchedDraft || polishDraftCapture || readPolishDraft()).trim();
  polishDraftCapture = "";

  if (!draft) {
    showChatError("Type a prompt first, then click Polish.");
    input?.focus();
    return;
  }

  const model = getSelectedModel();
  if (!model?.id) {
    showChatError("No model selected. Add a model in Settings, then pick it in the composer.");
    return;
  }

  polishInFlight = true;
  polishChip.classList.add("is-busy");
  polishChip.disabled = true;
  if (polishChipLabel) polishChipLabel.textContent = "Polishing…";

  try {
    const result = await window.onecode.chat.polishPrompt({
      text: draft,
      modelId: model.id,
    });
    const polished = String(result?.text || "").trim();
    if (!polished) {
      throw new Error("Model returned an empty polished prompt.");
    }
    setComposerPlainText(polished);
    input?.focus();
    refreshContextUsage();
  } catch (error) {
    console.error(error);
    showChatError(error?.message || "Failed to polish prompt.");
  } finally {
    polishInFlight = false;
    polishChip.classList.remove("is-busy");
    polishChip.disabled = false;
    if (polishChipLabel) polishChipLabel.textContent = "Polish";
  }
}

if (polishChip) {
  polishChip.addEventListener("pointerdown", () => {
    polishDraftCapture = readPolishDraft();
  });
  polishChip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const draft = polishDraftCapture || readPolishDraft();
    polishComposerPrompt(draft);
  });
}

if (newChatBtn) {
  newChatBtn.addEventListener("click", () => {
    createNewChat().catch((error) => {
      console.error(error);
      showChatError(error?.message || "Failed to create chat.");
    });
  });
}

modelChip.addEventListener("click", (event) => {
  event.stopPropagation();
  closeMcpMenu();
  toggleModelMenu();
});

document.addEventListener("click", (event) => {
  if (!modelPicker.contains(event.target)) {
    closeModelMenu();
  }
  if (mcpPicker && !mcpPicker.contains(event.target)) {
    closeMcpMenu();
  }
});

if (mcpPill) {
  mcpPill.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMcpMenu();
  });
}

if (mcpEnabledToggle) {
  mcpEnabledToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setMcpChatEnabled(!(mcpEnabledToggle.getAttribute("aria-checked") === "true"));
  });
}

if (mcpSelectAllBtn) {
  mcpSelectAllBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    selectAllMcpServers();
  });
}

if (mcpSelectNoneBtn) {
  mcpSelectNoneBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    selectNoMcpServers();
  });
}

if (mcpMenuOpenSettings) {
  mcpMenuOpenSettings.addEventListener("click", () => {
    closeMcpMenu();
    state.activeSettingsSection = "mcp";
    openSettings();
  });
}

settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsCancel.addEventListener("click", closeSettings);
addModelBtn.addEventListener("click", () => openModelForm());

if (addSkillBtn) {
  addSkillBtn.addEventListener("click", () => openSkillForm());
}

if (skillForm) {
  skillForm.addEventListener("submit", (event) => {
    saveSkill(event).catch((error) => {
      console.error(error);
      showSkillFormError(error?.message || "Failed to save skill.");
    });
  });
}

if (skillFormClose) skillFormClose.addEventListener("click", closeSkillForm);
if (skillFormCancel) skillFormCancel.addEventListener("click", closeSkillForm);

if (skillsRevealUserBtn) {
  skillsRevealUserBtn.addEventListener("click", () => {
    revealSkillsDir("user").catch((error) => {
      console.error(error);
      window.alert(error?.message || "Failed to open user skills folder.");
    });
  });
}

if (skillsRevealProjectBtn) {
  skillsRevealProjectBtn.addEventListener("click", () => {
    revealSkillsDir("project").catch((error) => {
      console.error(error);
      window.alert(error?.message || "Failed to open project skills folder.");
    });
  });
}

settingsNavItems.forEach((item) => {
  item.addEventListener("click", () => {
    setSettingsSection(item.dataset.section);
  });
});

if (usageRefreshBtn) {
  usageRefreshBtn.addEventListener("click", () => {
    refreshUsagePanel().catch((error) => {
      console.error(error);
    });
  });
}

if (usageResetBtn) {
  usageResetBtn.addEventListener("click", () => {
    resetUsagePanel().catch((error) => {
      console.error(error);
      window.alert(error?.message || "Failed to reset usage.");
    });
  });
}

if (aboutCheckUpdateBtn) {
  aboutCheckUpdateBtn.addEventListener("click", () => {
    checkForAppUpdates().catch((error) => {
      console.error(error);
      window.alert(error?.message || "Failed to check for updates.");
    });
  });
}

if (tinyfishForm) {
  tinyfishForm.addEventListener("submit", (event) => {
    saveTinyFishSettings(event).catch((error) => {
      console.error(error);
      showTinyFishFormError(error?.message || "Failed to save TinyFish settings.");
    });
  });
}

if (memoryForm) {
  memoryForm.addEventListener("submit", (event) => {
    saveMemorySettings(event).catch((error) => {
      console.error(error);
      window.alert(error?.message || "Failed to save Memory settings.");
    });
  });
}

if (agentForm) {
  agentForm.addEventListener("submit", (event) => {
    try {
      saveAgentSettings(event);
    } catch (error) {
      console.error(error);
      window.alert(error?.message || "Failed to save Agent settings.");
    }
  });
}

if (memoryRevealUserBtn) {
  memoryRevealUserBtn.addEventListener("click", () => {
    revealMemoryFile("user").catch((error) => {
      console.error(error);
      window.alert(error?.message || "Failed to open user memory file.");
    });
  });
}

if (memoryRevealProjectBtn) {
  memoryRevealProjectBtn.addEventListener("click", () => {
    revealMemoryFile("project").catch((error) => {
      console.error(error);
      window.alert(error?.message || "Failed to open project memory file.");
    });
  });
}

if (mcpReloadBtn) {
  mcpReloadBtn.addEventListener("click", () => {
    mcpReloadBtn.disabled = true;
    window.onecode.mcp
      .reload()
      .then((status) => {
        renderMcpStatus(status);
        return refreshMcpLogs();
      })
      .catch((error) => {
        console.error(error);
        if (mcpBannerEl) {
          mcpBannerEl.hidden = false;
          mcpBannerEl.className = "mcp-banner is-error";
          mcpBannerEl.textContent = error?.message || "Failed to retest MCP servers.";
        }
      })
      .finally(() => {
        mcpReloadBtn.disabled = false;
      });
  });
}

if (mcpOpenConfigBtn) {
  mcpOpenConfigBtn.addEventListener("click", () => {
    window.onecode.mcp.openConfig().catch((error) => {
      console.error(error);
      if (mcpBannerEl) {
        mcpBannerEl.hidden = false;
        mcpBannerEl.className = "mcp-banner is-error";
        mcpBannerEl.textContent = error?.message || "Failed to open MCP config.";
      }
    });
  });
}

if (mcpRevealConfigBtn) {
  mcpRevealConfigBtn.addEventListener("click", () => {
    window.onecode.mcp.revealConfig().catch((error) => {
      console.error(error);
      if (mcpBannerEl) {
        mcpBannerEl.hidden = false;
        mcpBannerEl.className = "mcp-banner is-error";
        mcpBannerEl.textContent = error?.message || "Failed to reveal MCP config.";
      }
    });
  });
}

if (mcpRefreshLogsBtn) {
  mcpRefreshLogsBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    refreshMcpLogs().catch((error) => {
      console.error(error);
    });
  });
}

const mcpLogsDetails = document.getElementById("mcp-logs-details");
if (mcpLogsDetails) {
  mcpLogsDetails.addEventListener("toggle", () => {
    if (mcpLogsDetails.open) {
      refreshMcpLogs().catch((error) => {
        console.error(error);
      });
    }
  });
}

if (window.onecode?.mcp?.onEvent) {
  window.onecode.mcp.onEvent((status) => {
    renderMcpStatus(status);
    if (
      state.activeSettingsSection === "mcp" &&
      !settingsModal.hidden &&
      mcpLogsDetails?.open
    ) {
      refreshMcpLogs().catch((error) => {
        console.error(error);
      });
    }
  });
}

modelForm.addEventListener("submit", saveModel);
modelFormClose.addEventListener("click", closeModelForm);
modelFormCancel.addEventListener("click", closeModelForm);

settingsModal.addEventListener("click", (event) => {
  if (event.target === settingsModal) closeSettings();
});

modelFormModal.addEventListener("click", (event) => {
  if (event.target === modelFormModal) closeModelForm();
});

if (skillFormModal) {
  skillFormModal.addEventListener("click", (event) => {
    if (event.target === skillFormModal) closeSkillForm();
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;

  if (document.body.classList.contains("onboarding-open")) {
    return;
  }

  if (state.slashMenuOpen) {
    closeSkillsSlashMenu();
    return;
  }

  if (!modelMenu.hidden) {
    closeModelMenu();
    return;
  }

  if (mcpMenu && !mcpMenu.hidden) {
    closeMcpMenu();
    return;
  }

  if (!modelFormModal.hidden) {
    closeModelForm();
    return;
  }

  if (skillFormModal && !skillFormModal.hidden) {
    closeSkillForm();
    return;
  }

  if (!settingsModal.hidden) {
    closeSettings();
  }
});

async function bootstrapChats() {
  showThreadLoadingSkeleton();
  try {
    await refreshConversationList();

    const savedId = localStorage.getItem(ACTIVE_CHAT_KEY);
    const preferred =
      (savedId && state.conversations.find((c) => c.id === savedId)?.id) ||
      state.conversations[0]?.id ||
      null;

    if (preferred) {
      await selectConversation(preferred);
      clearThreadLoadingState();
      return;
    }

    clearThreadLoadingState();
    await createNewChat();
  } catch (error) {
    clearThreadLoadingState();
    throw error;
  }
}

Promise.all([
  refreshModels(),
  bootstrapChats(),
  window.onecode.mcp.status(),
])
  .then(([, , status]) => {
    renderMcpStatus(status);
    syncComposerModelLabel();
    renderModelMenu();
    renderMcpChatControls();
    syncComposerSetupBanner();
  })
  .catch((error) => {
    console.error(error);
    syncComposerModelLabel();
    renderModelMenu();
    renderMcpChatControls();
    syncComposerSetupBanner();
  })
  .finally(() => {
    clearThreadLoadingState();
    initOnboarding();
    startOnboarding({
      onComplete: () => {
        clearThreadLoadingState();
        shell?.classList.remove("is-loading");
        form?.classList.remove("is-loading");
        form?.removeAttribute("aria-busy");
        syncComposerModelLabel();
        syncComposerSetupBanner();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => input?.focus({ preventScroll: true }));
        });
      },
    }).catch((error) => {
      console.error(error);
      clearThreadLoadingState();
      input?.focus({ preventScroll: true });
    });
  });
