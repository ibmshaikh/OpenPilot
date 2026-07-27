import {
  aboutCheckUpdateBtn,
  aboutInstallUpdateBtn,
  aboutUpdateStatusEl,
  aboutUpdateProgressEl,
  aboutUpdateProgressFill,
  aboutUpdateProgressLabel,
  sidebarUpdateBtn,
  sidebarUpdateLabel,
  updateOverlay,
  updateOverlayTitle,
  updateOverlayMessage,
  updateOverlayProgress,
  updateOverlayProgressFill,
  updateOverlayPercent,
  settingsStatus,
} from "./dom.js";

/** @type {{
 *   status: string,
 *   currentVersion?: string,
 *   latestVersion?: string | null,
 *   percent?: number,
 *   message?: string,
 * }} */
let updateState = {
  status: "idle",
  latestVersion: null,
  percent: 0,
  message: "",
};

let installing = false;
let unsubscribe = null;

function canInstall(status = updateState.status) {
  return (
    status === "available" ||
    status === "downloading" ||
    status === "downloaded" ||
    status === "installing"
  );
}

function showSidebarUpdate(show) {
  if (!sidebarUpdateBtn) return;
  sidebarUpdateBtn.hidden = !show;
}

function setAboutInstallVisible(show) {
  if (!aboutInstallUpdateBtn) return;
  aboutInstallUpdateBtn.hidden = !show;
  aboutInstallUpdateBtn.disabled = installing && updateState.status === "installing";
}

function setAboutProgress(visible, percent = 0, label = "") {
  if (!aboutUpdateProgressEl) return;
  aboutUpdateProgressEl.hidden = !visible;
  const clamped = Math.max(0, Math.min(100, Math.round(percent || 0)));
  if (aboutUpdateProgressFill) {
    aboutUpdateProgressFill.style.width = `${clamped}%`;
  }
  if (aboutUpdateProgressLabel) {
    aboutUpdateProgressLabel.textContent = label || `${clamped}%`;
  }
}

function setOverlayProgress(visible, percent = 0) {
  if (!updateOverlayProgress) return;
  updateOverlayProgress.hidden = !visible;
  const clamped = Math.max(0, Math.min(100, Math.round(percent || 0)));
  if (updateOverlayProgressFill) {
    updateOverlayProgressFill.style.width = `${clamped}%`;
  }
  if (updateOverlayPercent) {
    updateOverlayPercent.textContent = `${clamped}%`;
  }
}

function showUpdateOverlay({ title, message, percent = null } = {}) {
  if (!updateOverlay) return;
  updateOverlay.hidden = false;
  document.body.classList.add("update-in-progress");
  if (updateOverlayTitle && title) updateOverlayTitle.textContent = title;
  if (updateOverlayMessage && message) updateOverlayMessage.textContent = message;
  if (percent == null) {
    setOverlayProgress(false);
  } else {
    setOverlayProgress(true, percent);
  }
}

function hideUpdateOverlay() {
  if (!updateOverlay) return;
  if (installing && updateState.status === "installing") return;
  updateOverlay.hidden = true;
  document.body.classList.remove("update-in-progress");
  setOverlayProgress(false);
}

function applyUpdateState(next = {}) {
  updateState = {
    ...updateState,
    ...next,
  };

  const status = updateState.status;
  const version = updateState.latestVersion;
  const percent = Number(updateState.percent) || 0;
  const message =
    updateState.message ||
    (status === "available" && version
      ? `Update ${version} is available.`
      : status === "downloaded" && version
        ? `Update ${version} is ready to install.`
        : "");

  if (aboutUpdateStatusEl && (message || status !== "idle")) {
    aboutUpdateStatusEl.dataset.locked = "1";
    aboutUpdateStatusEl.textContent =
      message || "Updates apply to installed builds only.";
  }

  const actionable = canInstall(status);
  showSidebarUpdate(actionable && status !== "installing");
  setAboutInstallVisible(actionable);

  if (sidebarUpdateLabel) {
    if (status === "downloading") {
      sidebarUpdateLabel.textContent = `Downloading… ${Math.round(percent)}%`;
    } else if (status === "downloaded") {
      sidebarUpdateLabel.textContent = version
        ? `Install ${version}`
        : "Install update";
    } else if (status === "available") {
      sidebarUpdateLabel.textContent = version
        ? `Update ${version}`
        : "Update available";
    } else {
      sidebarUpdateLabel.textContent = "Update available";
    }
  }

  if (aboutInstallUpdateBtn) {
    if (status === "downloading") {
      aboutInstallUpdateBtn.textContent = "Update in progress…";
    } else if (status === "installing") {
      aboutInstallUpdateBtn.textContent = "Installing…";
    } else if (status === "downloaded") {
      aboutInstallUpdateBtn.textContent = "Restart & update";
    } else {
      aboutInstallUpdateBtn.textContent = "Update OpenPilot";
    }
  }

  if (status === "downloading") {
    setAboutProgress(true, percent, `Downloading… ${Math.round(percent)}%`);
    if (installing) {
      showUpdateOverlay({
        title: "Updating OpenPilot",
        message: "Downloading update…",
        percent,
      });
    }
  } else if (status === "installing") {
    setAboutProgress(true, 100, "Installing…");
    showUpdateOverlay({
      title: "Updating OpenPilot",
      message: "Installing update… OpenPilot will restart.",
      percent: 100,
    });
  } else if (status === "downloaded" && installing) {
    setAboutProgress(true, 100, "Ready to install");
    showUpdateOverlay({
      title: "Updating OpenPilot",
      message: "Installing update… OpenPilot will restart.",
      percent: 100,
    });
  } else if (status === "downloaded") {
    setAboutProgress(false);
    if (!installing) hideUpdateOverlay();
  } else if (status === "error") {
    setAboutProgress(false);
    if (installing) {
      showUpdateOverlay({
        title: "Update failed",
        message: message || "Something went wrong while updating.",
      });
      installing = false;
      window.setTimeout(() => hideUpdateOverlay(), 2400);
    } else {
      hideUpdateOverlay();
    }
  } else {
    setAboutProgress(false);
    if (!installing) hideUpdateOverlay();
  }
}

export async function refreshAboutPanel() {
  // Version refresh lives in settings.js; keep update status in sync here.
  try {
    if (window.onecode?.app?.getUpdateState) {
      const state = await window.onecode.app.getUpdateState();
      if (state) applyUpdateState(state);
    }
  } catch (error) {
    console.error(error);
  }
}

export async function checkForAppUpdates() {
  if (!window.onecode?.app?.checkForUpdates) {
    throw new Error("Update checks are not available in this build.");
  }

  if (aboutCheckUpdateBtn) {
    aboutCheckUpdateBtn.disabled = true;
    aboutCheckUpdateBtn.textContent = "Checking…";
  }
  if (aboutUpdateStatusEl) {
    aboutUpdateStatusEl.dataset.locked = "1";
    aboutUpdateStatusEl.textContent = "Checking GitHub Releases…";
  }

  try {
    const result = await window.onecode.app.checkForUpdates();
    applyUpdateState(result || {});

    const message =
      result?.message ||
      (result?.status === "available"
        ? `Update ${result.latestVersion} is available.`
        : result?.status === "downloaded"
          ? `Update ${result.latestVersion || ""} is ready to install.`
          : result?.status === "up-to-date"
            ? `OpenPilot ${result.currentVersion || ""} is up to date.`
            : "Update check finished.");

    if (aboutUpdateStatusEl) {
      aboutUpdateStatusEl.textContent = message;
    }
    if (settingsStatus) {
      settingsStatus.hidden = false;
      settingsStatus.textContent = message;
      window.setTimeout(() => {
        settingsStatus.hidden = true;
      }, 2500);
    }
    return result;
  } finally {
    if (aboutCheckUpdateBtn) {
      aboutCheckUpdateBtn.disabled = false;
      aboutCheckUpdateBtn.textContent = "Check for updates";
    }
  }
}

export async function installAppUpdate() {
  if (!window.onecode?.app?.installUpdate) {
    throw new Error("Installing updates is not available in this build.");
  }

  installing = true;
  showUpdateOverlay({
    title: "Updating OpenPilot",
    message:
      updateState.status === "downloaded"
        ? "Installing update… OpenPilot will restart."
        : "Downloading update…",
    percent: updateState.status === "downloaded" ? 100 : updateState.percent || 0,
  });

  if (aboutInstallUpdateBtn) {
    aboutInstallUpdateBtn.disabled = true;
    aboutInstallUpdateBtn.textContent = "Update in progress…";
  }
  if (sidebarUpdateBtn) {
    sidebarUpdateBtn.disabled = true;
  }

  try {
    const result = await window.onecode.app.installUpdate();
    applyUpdateState(result || { status: "installing" });

    if (result?.status === "up-to-date" || result?.status === "dev") {
      installing = false;
      hideUpdateOverlay();
      if (aboutUpdateStatusEl) {
        aboutUpdateStatusEl.textContent = result.message || "OpenPilot is up to date.";
      }
    } else if (result?.status === "error") {
      installing = false;
      throw new Error(result.message || "Failed to install update.");
    }

    return result;
  } catch (error) {
    installing = false;
    hideUpdateOverlay();
    applyUpdateState({
      status: "error",
      message: error?.message || String(error),
    });
    throw error;
  } finally {
    if (sidebarUpdateBtn) sidebarUpdateBtn.disabled = false;
    if (aboutInstallUpdateBtn && updateState.status !== "installing") {
      aboutInstallUpdateBtn.disabled = false;
    }
  }
}

export function initUpdaterUi() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  if (window.onecode?.app?.onUpdateEvent) {
    unsubscribe = window.onecode.app.onUpdateEvent((payload) => {
      applyUpdateState(payload || {});
    });
  }

  if (sidebarUpdateBtn) {
    sidebarUpdateBtn.addEventListener("click", () => {
      installAppUpdate().catch((error) => {
        console.error(error);
        window.alert(error?.message || "Failed to install update.");
      });
    });
  }

  if (aboutInstallUpdateBtn) {
    aboutInstallUpdateBtn.addEventListener("click", () => {
      installAppUpdate().catch((error) => {
        console.error(error);
        window.alert(error?.message || "Failed to install update.");
      });
    });
  }

  if (window.onecode?.app?.getUpdateState) {
    window.onecode.app
      .getUpdateState()
      .then((state) => {
        if (state) applyUpdateState(state);
      })
      .catch((error) => console.error(error));
  }
}
