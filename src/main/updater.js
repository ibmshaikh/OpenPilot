const { app, BrowserWindow } = require("electron");

let checking = false;
let installing = false;
let autoUpdater = null;

/** @type {{
 *   status: string,
 *   currentVersion: string,
 *   latestVersion: string | null,
 *   percent: number,
 *   message: string,
 * }} */
let updateState = {
  status: "idle",
  currentVersion: "",
  latestVersion: null,
  percent: 0,
  message: "",
};

function getAutoUpdater() {
  if (!autoUpdater) {
    ({ autoUpdater } = require("electron-updater"));
  }
  return autoUpdater;
}

function currentVersion() {
  try {
    return app.getVersion();
  } catch {
    return updateState.currentVersion || "";
  }
}

function getUpdateState() {
  return {
    ...updateState,
    currentVersion: currentVersion(),
  };
}

function broadcast(partial = {}) {
  updateState = {
    ...updateState,
    currentVersion: currentVersion(),
    ...partial,
  };

  const payload = getUpdateState();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("app:update-event", payload);
    }
  }
  return payload;
}

function setupAutoUpdater() {
  updateState.currentVersion = currentVersion();

  if (!app.isPackaged) {
    broadcast({
      status: "dev",
      message: "Updates only work in installed OpenPilot builds.",
    });
    return;
  }

  const updater = getAutoUpdater();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.on("checking-for-update", () => {
    broadcast({
      status: "checking",
      percent: 0,
      message: "Checking for updates…",
    });
  });

  updater.on("update-available", (info) => {
    broadcast({
      status: "available",
      latestVersion: info?.version || null,
      percent: 0,
      message: info?.version
        ? `Update ${info.version} is available.`
        : "A new update is available.",
    });
  });

  updater.on("download-progress", (progress) => {
    const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
    broadcast({
      status: "downloading",
      percent,
      message: `Downloading update… ${Math.round(percent)}%`,
    });
  });

  updater.on("update-downloaded", (info) => {
    const version = info?.version || updateState.latestVersion;
    broadcast({
      status: "downloaded",
      latestVersion: version || null,
      percent: 100,
      message: version
        ? `Update ${version} is ready to install.`
        : "Update is ready to install.",
    });
  });

  updater.on("update-not-available", (info) => {
    const version = currentVersion();
    broadcast({
      status: "up-to-date",
      latestVersion: info?.version || version,
      percent: 0,
      message: `OpenPilot ${version} is up to date.`,
    });
  });

  updater.on("error", (error) => {
    if (installing) return;
    broadcast({
      status: "error",
      message: error?.message || String(error),
    });
  });

  // Delay so startup UI isn't blocked by the network check.
  setTimeout(() => {
    checkForUpdates().catch((error) => {
      console.error("Auto-update check failed:", error?.message || error);
    });
  }, 4000);
}

async function checkForUpdates() {
  const version = currentVersion();

  if (!app.isPackaged) {
    return broadcast({
      status: "dev",
      currentVersion: version,
      message:
        "Updates only work in installed OpenPilot builds, not when running with npm start.",
    });
  }

  if (installing) {
    return getUpdateState();
  }

  if (checking) {
    return broadcast({
      status: updateState.status === "idle" ? "checking" : updateState.status,
      message: updateState.message || "An update check is already running.",
    });
  }

  // Already have a ready update — don't re-check away from that state.
  if (updateState.status === "downloaded") {
    return getUpdateState();
  }

  checking = true;
  const updater = getAutoUpdater();

  try {
    return await new Promise((resolve) => {
      let settled = false;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        updater.removeListener("update-available", onAvailable);
        updater.removeListener("update-not-available", onNotAvailable);
        updater.removeListener("error", onError);
        resolve(broadcast(payload));
      };

      const onAvailable = (info) => {
        finish({
          status: "available",
          latestVersion: info?.version || null,
          percent: 0,
          message: info?.version
            ? `Update ${info.version} is available and downloading.`
            : "A new update is available and downloading.",
        });
      };

      const onNotAvailable = (info) => {
        finish({
          status: "up-to-date",
          latestVersion: info?.version || version,
          percent: 0,
          message: `OpenPilot ${version} is up to date.`,
        });
      };

      const onError = (error) => {
        finish({
          status: "error",
          message: error?.message || String(error),
        });
      };

      broadcast({
        status: "checking",
        percent: 0,
        message: "Checking for updates…",
      });

      updater.once("update-available", onAvailable);
      updater.once("update-not-available", onNotAvailable);
      updater.once("error", onError);

      updater.checkForUpdates().catch((error) => {
        finish({
          status: "error",
          message: error?.message || String(error),
        });
      });
    });
  } finally {
    checking = false;
  }
}

function waitForDownloaded(updater, timeoutMs = 10 * 60 * 1000) {
  if (updateState.status === "downloaded") {
    return Promise.resolve(getUpdateState());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while downloading the update."));
    }, timeoutMs);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      updater.removeListener("update-downloaded", onDownloaded);
      updater.removeListener("error", onError);
    };

    const onDownloaded = () => {
      cleanup();
      resolve(getUpdateState());
    };

    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    updater.once("update-downloaded", onDownloaded);
    updater.once("error", onError);

    if (updateState.status === "available" || updateState.status === "idle") {
      updater.downloadUpdate().catch(onError);
    }
  });
}

async function installUpdate() {
  const version = currentVersion();

  if (!app.isPackaged) {
    return broadcast({
      status: "dev",
      currentVersion: version,
      message:
        "Updates only work in installed OpenPilot builds, not when running with npm start.",
    });
  }

  if (installing) {
    return getUpdateState();
  }

  const updater = getAutoUpdater();

  try {
    if (
      updateState.status !== "downloaded" &&
      updateState.status !== "available" &&
      updateState.status !== "downloading"
    ) {
      const checked = await checkForUpdates();
      if (checked.status === "up-to-date" || checked.status === "dev") {
        return checked;
      }
      if (checked.status === "error") {
        return checked;
      }
    }

    if (updateState.status !== "downloaded") {
      broadcast({
        status: "downloading",
        percent: updateState.percent || 0,
        message: "Downloading update…",
      });
      await waitForDownloaded(updater);
    }

    installing = true;
    broadcast({
      status: "installing",
      percent: 100,
      message: "Installing update… OpenPilot will restart.",
    });

    setTimeout(() => {
      try {
        updater.quitAndInstall(false, true);
      } catch (error) {
        installing = false;
        broadcast({
          status: "error",
          message: error?.message || String(error),
        });
      }
    }, 700);

    return getUpdateState();
  } catch (error) {
    installing = false;
    return broadcast({
      status: "error",
      message: error?.message || String(error),
    });
  }
}

module.exports = {
  setupAutoUpdater,
  checkForUpdates,
  installUpdate,
  getUpdateState,
};
