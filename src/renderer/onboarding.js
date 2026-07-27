import {
  onboardingEl,
  onboardingSteps,
  onboardingDots,
  onboardingSkipBtn,
  onboardingBackBtn,
  onboardingNextBtn,
  onboardingModelForm,
  onboardingModelError,
  onboardingModelStatus,
  onboardingWorkspacePath,
  onboardingWorkspacePickBtn,
  onboardingTinyfishForm,
  onboardingTinyfishEnabled,
  onboardingTinyfishApiKey,
  onboardingTinyfishError,
  onboardingTinyfishStatus,
  composerSetupBannerBtn,
  input,
  form,
  shell,
} from "./dom.js";
import { state, SELECTED_MODEL_KEY, applyWorkspaceToUi } from "./state.js";
import { openSettings, renderModelList } from "./settings.js";
import {
  syncComposerModelLabel,
  syncComposerSetupBanner,
  renderModelMenu,
} from "./composer.js";
import { clearThreadLoadingState } from "./chat.js";

export const ONBOARDING_KEY = "onecode.onboardingComplete";

const STEPS = ["welcome", "model", "workspace", "tinyfish"];

let stepIndex = 0;
let onCompleteCb = null;

export async function isOnboardingComplete() {
  try {
    const settings = await window.onecode.settings.getOnboarding();
    if (settings?.completed) return true;
  } catch (error) {
    console.error(error);
  }

  // Migrate any prior localStorage flag into durable app settings.
  if (localStorage.getItem(ONBOARDING_KEY) === "1") {
    await markOnboardingComplete();
    return true;
  }

  return false;
}

export async function markOnboardingComplete() {
  localStorage.setItem(ONBOARDING_KEY, "1");
  try {
    await window.onecode.settings.saveOnboarding({ completed: true });
  } catch (error) {
    console.error(error);
  }
}

function setStep(index) {
  stepIndex = Math.max(0, Math.min(index, STEPS.length - 1));
  const id = STEPS[stepIndex];

  onboardingSteps.forEach((step) => {
    step.hidden = step.dataset.onboardStep !== id;
  });

  onboardingDots.forEach((dot, i) => {
    dot.classList.toggle("is-active", i === stepIndex);
    dot.classList.toggle("is-done", i < stepIndex);
  });

  if (onboardingBackBtn) {
    onboardingBackBtn.hidden = stepIndex === 0;
  }

  if (onboardingNextBtn) {
    onboardingNextBtn.textContent =
      stepIndex === STEPS.length - 1 ? "Get started" : "Next";
  }

  if (id === "workspace") {
    syncWorkspaceStep();
  }
}

function syncWorkspaceStep() {
  if (!onboardingWorkspacePath) return;
  const path = state.activeConversationId
    ? state.chatSessions.get(state.activeConversationId)?.workspacePath
    : null;
  const fromList = state.conversations.find((c) => c.id === state.activeConversationId)?.workspacePath;
  const resolved = path || fromList || null;
  onboardingWorkspacePath.textContent = resolved || "No folder selected yet";
  onboardingWorkspacePath.classList.toggle("is-empty", !resolved);
}

async function pickOnboardingWorkspace() {
  if (!state.activeConversationId) {
    throw new Error("Start a chat first, then pick a workspace folder.");
  }

  const workspace = await window.onecode.workspace.pick(state.activeConversationId);
  if (workspace?.cancelled) return;

  applyWorkspaceToUi(workspace?.path, workspace?.label);
  const session = state.chatSessions.get(state.activeConversationId);
  if (session) session.workspacePath = workspace?.path || null;

  const idx = state.conversations.findIndex((c) => c.id === state.activeConversationId);
  if (idx >= 0) {
    state.conversations[idx] = {
      ...state.conversations[idx],
      workspacePath: workspace?.path || null,
    };
  }
}

async function refreshModelsLocal() {
  state.customModels = await window.onecode.models.list();
  if (state.customModels.length && !state.customModels.some((m) => m.id === state.selectedModelId)) {
    state.selectedModelId = state.customModels[0].id;
    localStorage.setItem(SELECTED_MODEL_KEY, String(state.selectedModelId));
  }
  if (!state.customModels.length) {
    state.selectedModelId = null;
    localStorage.removeItem(SELECTED_MODEL_KEY);
  }
  renderModelList();
  syncComposerSetupBanner();
}

async function saveOnboardingModel(event) {
  event.preventDefault();
  if (!onboardingModelForm) return;

  clearModelError();
  if (onboardingModelStatus) onboardingModelStatus.hidden = true;

  const formData = new FormData(onboardingModelForm);
  const payload = {
    modelName: String(formData.get("modelName") || "").trim(),
    baseUrl: String(formData.get("baseUrl") || "").trim(),
    apiKey: String(formData.get("apiKey") || "").trim(),
    displayName: String(formData.get("displayName") || "").trim(),
  };

  if (!payload.modelName || !payload.baseUrl || !payload.apiKey || !payload.displayName) {
    showModelError("Fill in all model fields, or tap Next to continue without one.");
    return;
  }

  const submitBtn = onboardingModelForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const created = await window.onecode.models.create(payload);
    if (created?.id) {
      state.selectedModelId = created.id;
      localStorage.setItem(SELECTED_MODEL_KEY, String(created.id));
    }
    await refreshModelsLocal();
    onboardingModelForm.reset();
    if (onboardingModelStatus) {
      onboardingModelStatus.hidden = false;
      onboardingModelStatus.textContent = "Model saved. You can add more later in Settings.";
    }
  } catch (error) {
    showModelError(error?.message || "Failed to save model.");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function showModelError(message) {
  if (!onboardingModelError) return;
  onboardingModelError.hidden = false;
  onboardingModelError.textContent = message;
}

function clearModelError() {
  if (!onboardingModelError) return;
  onboardingModelError.hidden = true;
  onboardingModelError.textContent = "";
}

async function saveOnboardingTinyFish(event) {
  event.preventDefault();
  if (!onboardingTinyfishForm) return;

  clearTinyFishError();
  if (onboardingTinyfishStatus) onboardingTinyfishStatus.hidden = true;

  const submitBtn = onboardingTinyfishForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    await window.onecode.settings.saveTinyFish({
      enabled: Boolean(onboardingTinyfishEnabled?.checked),
      apiKey: String(onboardingTinyfishApiKey?.value || "").trim(),
    });
    if (onboardingTinyfishStatus) {
      onboardingTinyfishStatus.hidden = false;
      onboardingTinyfishStatus.textContent = "TinyFish saved. You can change this anytime in Settings.";
    }
  } catch (error) {
    showTinyFishError(error?.message || "Failed to save TinyFish settings.");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function showTinyFishError(message) {
  if (!onboardingTinyfishError) return;
  onboardingTinyfishError.hidden = false;
  onboardingTinyfishError.textContent = message;
}

function clearTinyFishError() {
  if (!onboardingTinyfishError) return;
  onboardingTinyfishError.hidden = true;
  onboardingTinyfishError.textContent = "";
}

function hideOnboardingOverlay() {
  if (!onboardingEl) return;
  onboardingEl.hidden = true;
  onboardingEl.setAttribute("aria-hidden", "true");
  // Electron/Chromium can leave a backdrop-filter layer intercepting hits
  // after display:none — force the overlay out of hit-testing.
  onboardingEl.style.pointerEvents = "none";
  onboardingEl.style.visibility = "hidden";
}

function showOnboardingOverlay() {
  if (!onboardingEl) return;
  onboardingEl.style.pointerEvents = "";
  onboardingEl.style.visibility = "";
  onboardingEl.removeAttribute("aria-hidden");
  onboardingEl.hidden = false;
}

/** Re-enable chat compose after onboarding (loading lock + model UI). */
async function unlockChatAfterOnboarding() {
  clearThreadLoadingState();
  shell?.classList.remove("is-loading");
  form?.classList.remove("is-loading");
  form?.removeAttribute("aria-busy");

  try {
    state.customModels = await window.onecode.models.list();
    if (
      state.customModels.length &&
      !state.customModels.some((m) => m.id === state.selectedModelId)
    ) {
      state.selectedModelId = state.customModels[0].id;
      localStorage.setItem(SELECTED_MODEL_KEY, String(state.selectedModelId));
    }
    if (!state.customModels.length) {
      state.selectedModelId = null;
      localStorage.removeItem(SELECTED_MODEL_KEY);
    }
  } catch (error) {
    console.error(error);
  }

  renderModelList();
  renderModelMenu();
  syncComposerModelLabel();
  syncComposerSetupBanner();

  // Focus after the overlay is fully removed from the compositor.
  requestAnimationFrame(() => {
    input?.focus({ preventScroll: true });
  });
}

async function finishOnboarding() {
  await markOnboardingComplete();
  hideOnboardingOverlay();
  document.body.classList.remove("onboarding-open");
  await unlockChatAfterOnboarding();
  if (typeof onCompleteCb === "function") onCompleteCb();
}

export async function startOnboarding({ onComplete } = {}) {
  if (!onboardingEl || (await isOnboardingComplete())) {
    if (typeof onComplete === "function") onComplete();
    return;
  }

  onCompleteCb = onComplete || null;
  document.body.classList.add("onboarding-open");
  showOnboardingOverlay();
  setStep(0);
}

export function initOnboarding() {
  if (onboardingSkipBtn) {
    onboardingSkipBtn.addEventListener("click", () => {
      finishOnboarding().catch((error) => console.error(error));
    });
  }

  if (onboardingBackBtn) {
    onboardingBackBtn.addEventListener("click", () => {
      setStep(stepIndex - 1);
    });
  }

  if (onboardingNextBtn) {
    onboardingNextBtn.addEventListener("click", () => {
      if (stepIndex >= STEPS.length - 1) {
        finishOnboarding().catch((error) => console.error(error));
        return;
      }
      setStep(stepIndex + 1);
    });
  }

  if (onboardingModelForm) {
    onboardingModelForm.addEventListener("submit", (event) => {
      saveOnboardingModel(event).catch((error) => {
        console.error(error);
        showModelError(error?.message || "Failed to save model.");
      });
    });
  }

  if (onboardingWorkspacePickBtn) {
    onboardingWorkspacePickBtn.addEventListener("click", () => {
      pickOnboardingWorkspace()
        .then(() => syncWorkspaceStep())
        .catch((error) => {
          console.error(error);
          window.alert(error?.message || "Failed to select workspace.");
        });
    });
  }

  if (onboardingTinyfishForm) {
    onboardingTinyfishForm.addEventListener("submit", (event) => {
      saveOnboardingTinyFish(event).catch((error) => {
        console.error(error);
        showTinyFishError(error?.message || "Failed to save TinyFish settings.");
      });
    });
  }

  if (composerSetupBannerBtn) {
    composerSetupBannerBtn.addEventListener("click", () => {
      openSettings("models");
    });
  }

  syncComposerSetupBanner();
}
