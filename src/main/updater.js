const { app, dialog } = require("electron");

let checking = false;
let promptedForRestart = false;
let autoUpdater = null;

function getAutoUpdater() {
  if (!autoUpdater) {
    ({ autoUpdater } = require("electron-updater"));
  }
  return autoUpdater;
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    return;
  }

  const updater = getAutoUpdater();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.on("error", (error) => {
    console.error("Auto-update error:", error?.message || error);
  });

  updater.on("update-available", (info) => {
    console.log(`Update available: ${info.version}`);
  });

  updater.on("update-downloaded", async (info) => {
    if (promptedForRestart) return;
    promptedForRestart = true;

    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Update ready",
      message: `OpenPilot ${info.version} is ready to install.`,
      detail: "Restart now to apply the update, or continue and it will install on quit.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) {
      updater.quitAndInstall(false, true);
    }
  });

  // Delay so startup UI isn't blocked by the network check.
  setTimeout(() => {
    checkForUpdates().catch((error) => {
      console.error("Auto-update check failed:", error?.message || error);
    });
  }, 4000);
}

async function checkForUpdates() {
  const currentVersion = app.getVersion();

  if (!app.isPackaged) {
    return {
      status: "dev",
      currentVersion,
      message: "Updates only work in installed OpenPilot builds, not when running with npm start.",
    };
  }

  if (checking) {
    return {
      status: "busy",
      currentVersion,
      message: "An update check is already running.",
    };
  }

  checking = true;
  const updater = getAutoUpdater();

  try {
    return await new Promise((resolve) => {
      const finish = (payload) => {
        updater.removeListener("update-available", onAvailable);
        updater.removeListener("update-not-available", onNotAvailable);
        updater.removeListener("error", onError);
        resolve(payload);
      };

      const onAvailable = (info) => {
        finish({
          status: "available",
          currentVersion,
          latestVersion: info.version,
          message: `Update ${info.version} is available and downloading.`,
        });
      };

      const onNotAvailable = (info) => {
        finish({
          status: "up-to-date",
          currentVersion,
          latestVersion: info?.version || currentVersion,
          message: `OpenPilot ${currentVersion} is up to date.`,
        });
      };

      const onError = (error) => {
        finish({
          status: "error",
          currentVersion,
          message: error?.message || String(error),
        });
      };

      updater.once("update-available", onAvailable);
      updater.once("update-not-available", onNotAvailable);
      updater.once("error", onError);

      updater.checkForUpdates().catch((error) => {
        finish({
          status: "error",
          currentVersion,
          message: error?.message || String(error),
        });
      });
    });
  } finally {
    checking = false;
  }
}

module.exports = {
  setupAutoUpdater,
  checkForUpdates,
};
