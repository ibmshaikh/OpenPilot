import {
  onboardingEl,
  onboardingSteps,
  onboardingDots,
  onboardingSkipBtn,
  onboardingBackBtn,
  onboardingNextBtn,
  onboardingModelError,
  onboardingModelStatus,
  onboardingAddModelBtn,
  onboardingWorkspacePath,
  onboardingWorkspacePickBtn,
  onboardingTinyfishForm,
  onboardingTinyfishEnabled,
  onboardingTinyfishApiKey,
  onboardingTinyfishError,
  onboardingTinyfishStatus,
  onboardingTelemetryEnabled,
  composerSetupBannerBtn,
  input,
  form,
  shell,
} from "./dom.js";
import { state, applyWorkspaceToUi } from "./state.js";
import { openSettings, openModelForm, renderModelList } from "./settings.js";
import {
  syncComposerModelLabel,
  syncComposerSetupBanner,
  renderModelMenu,
  setSelectedModel,
  setDefaultModel,
} from "./composer.js";
import { clearThreadLoadingState } from "./chat.js";

export const ONBOARDING_KEY = "onecode.onboardingComplete";

const STEPS = ["welcome", "model", "workspace", "tinyfish", "telemetry"];

let stepIndex = 0;
let onCompleteCb = null;
let advancing = false;

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

  if (id === "model") {
    refreshModelsLocal()
      .then(() => {
        clearModelError();
        if (onboardingModelStatus) onboardingModelStatus.hidden = true;
      })
      .catch((error) => console.error(error));
  }

  if (id === "model" || id === "workspace" || id === "tinyfish" || id === "telemetry") {
    window.onecode?.telemetry?.track?.("onboarding_step", { step: id }).catch?.(() => {});
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
  const [models, defaultResult] = await Promise.all([
    window.onecode.models.list(),
    window.onecode.models.getDefault().catch(() => ({ id: null })),
  ]);
  state.customModels = models;

  const persistedDefault = Number(defaultResult?.id) || null;
  const isValid = (id) =>
    id != null && state.customModels.some((m) => m.id === id);

  state.defaultModelId = isValid(persistedDefault)
    ? persistedDefault
    : state.customModels[0]?.id || null;

  if (!isValid(state.selectedModelId)) {
    setSelectedModel(state.defaultModelId);
  } else {
    syncComposerModelLabel();
    renderModelMenu();
  }
  renderModelList();
  syncComposerSetupBanner();
}

/**
 * Model step uses the shared Settings "Add model" form (provider picker).
 * Leaving blank is allowed — configure later in Settings.
 * @returns {Promise<boolean>}
 */
async function persistModelStep() {
  clearModelError();
  if (onboardingModelStatus) onboardingModelStatus.hidden = true;
  try {
    await refreshModelsLocal();
    return true;
  } catch (error) {
    showModelError(error?.message || "Failed to load models.");
    return false;
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

function getOnboardingTinyFishPayload() {
  return {
    enabled: Boolean(onboardingTinyfishEnabled?.checked),
    apiKey: String(onboardingTinyfishApiKey?.value || "").trim(),
  };
}

/**
 * Persist TinyFish when finishing onboarding or submitting the form.
 * @param {{ strict?: boolean }} opts - when strict, validation errors block finish
 * @returns {Promise<boolean>}
 */
async function persistTinyFishStep({ strict = false } = {}) {
  const payload = getOnboardingTinyFishPayload();
  if (!payload.enabled && !payload.apiKey) return true;

  clearTinyFishError();
  if (onboardingTinyfishStatus) onboardingTinyfishStatus.hidden = true;

  try {
    await window.onecode.settings.saveTinyFish(payload);
    if (onboardingTinyfishStatus) {
      onboardingTinyfishStatus.hidden = false;
      onboardingTinyfishStatus.textContent = "TinyFish saved.";
    }
    return true;
  } catch (error) {
    if (strict) {
      showTinyFishError(error?.message || "Failed to save TinyFish settings.");
      return false;
    }
    console.error(error);
    return true;
  }
}

async function saveOnboardingTinyFish(event) {
  event.preventDefault();
  const ok = await persistTinyFishStep({ strict: true });
  if (ok && onboardingTinyfishStatus) {
    onboardingTinyfishStatus.textContent =
      "TinyFish saved. You can change this anytime in Settings.";
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

/**
 * Persist the Share usage preference from onboarding (default on).
 * @returns {Promise<boolean>}
 */
async function persistTelemetryStep() {
  const enabled = onboardingTelemetryEnabled
    ? Boolean(onboardingTelemetryEnabled.checked)
    : true;
  try {
    await window.onecode.settings.saveTelemetry({ enabled });
    return true;
  } catch (error) {
    console.error(error);
    return true;
  }
}

function hideOnboardingOverlay() {
  if (!onboardingEl) return;
  onboardingEl.hidden = true;
  onboardingEl.setAttribute("aria-hidden", "true");
  onboardingEl.setAttribute("inert", "");
  // Electron/Chromium can leave a backdrop-filter layer intercepting hits
  // after display:none — force the overlay out of hit-testing entirely.
  onboardingEl.style.pointerEvents = "none";
  onboardingEl.style.visibility = "hidden";
  onboardingEl.style.display = "none";
  onboardingEl.style.backdropFilter = "none";
  onboardingEl.style.webkitBackdropFilter = "none";
}

function showOnboardingOverlay() {
  if (!onboardingEl) return;
  onboardingEl.style.pointerEvents = "";
  onboardingEl.style.visibility = "";
  onboardingEl.style.display = "";
  onboardingEl.style.backdropFilter = "";
  onboardingEl.style.webkitBackdropFilter = "";
  onboardingEl.removeAttribute("aria-hidden");
  onboardingEl.removeAttribute("inert");
  onboardingEl.hidden = false;
}

/** Re-enable chat compose after onboarding (loading lock + model UI). */
async function unlockChatAfterOnboarding() {
  clearThreadLoadingState();
  shell?.classList.remove("is-loading");
  form?.classList.remove("is-loading");
  form?.removeAttribute("aria-busy");
  form?.classList.remove("sending");

  try {
    const [models, defaultResult] = await Promise.all([
      window.onecode.models.list(),
      window.onecode.models.getDefault().catch(() => ({ id: null })),
    ]);
    state.customModels = models;
    const persistedDefault = Number(defaultResult?.id) || null;
    const isValid = (id) =>
      id != null && state.customModels.some((m) => m.id === id);
    state.defaultModelId = isValid(persistedDefault)
      ? persistedDefault
      : state.customModels[0]?.id || null;
    if (!isValid(state.selectedModelId)) {
      setSelectedModel(state.defaultModelId);
    }
  } catch (error) {
    console.error(error);
  }

  renderModelList();
  renderModelMenu();
  syncComposerModelLabel();
  syncComposerSetupBanner();

  // Two frames: let the overlay leave the compositor before focusing.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
    });
  });
}

async function finishOnboarding({ persistFilled = true, strictPersist = false } = {}) {
  if (persistFilled) {
    const modelOk = await persistModelStep();
    if (!modelOk) return false;
    const tinyOk = await persistTinyFishStep({ strict: strictPersist });
    if (!tinyOk) return false;
  }

  // Always persist the Share usage choice (defaults to on if skip before that step).
  await persistTelemetryStep();

  window.onecode?.telemetry?.track?.("onboarding_step", { step: "done" }).catch?.(() => {});
  await markOnboardingComplete();
  hideOnboardingOverlay();
  document.body.classList.remove("onboarding-open");
  await unlockChatAfterOnboarding();
  if (typeof onCompleteCb === "function") onCompleteCb();
  return true;
}

async function advanceOnboarding() {
  if (advancing) return;
  advancing = true;
  if (onboardingNextBtn) onboardingNextBtn.disabled = true;

  try {
    const step = STEPS[stepIndex];

    if (step === "model") {
      const ok = await persistModelStep();
      if (!ok) return;
    }

    if (stepIndex >= STEPS.length - 1) {
      await finishOnboarding({ persistFilled: true, strictPersist: true });
      return;
    }

    setStep(stepIndex + 1);
  } finally {
    advancing = false;
    if (onboardingNextBtn) onboardingNextBtn.disabled = false;
  }
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
      // Skip remaining steps, but still persist any complete values already entered.
      finishOnboarding({ persistFilled: true, strictPersist: false }).catch((error) =>
        console.error(error)
      );
    });
  }

  if (onboardingBackBtn) {
    onboardingBackBtn.addEventListener("click", () => {
      setStep(stepIndex - 1);
    });
  }

  if (onboardingNextBtn) {
    onboardingNextBtn.addEventListener("click", () => {
      advanceOnboarding().catch((error) => console.error(error));
    });
  }

  if (onboardingAddModelBtn) {
    onboardingAddModelBtn.addEventListener("click", () => {
      openModelForm();
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
