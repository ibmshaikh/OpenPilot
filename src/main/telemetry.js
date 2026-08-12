/**
 * Opt-in Aptabase analytics (self-hosted).
 * initializeTelemetry() must run before app.whenReady().
 * track() is a no-op until the user enables sharing and config is set.
 */

const { initialize, trackEvent } = require("@aptabase/electron/main");

// Production defaults (self-hosted Aptabase). Env overrides for local/dev.
const DEFAULT_APP_KEY = "A-SH-1829997278";
const DEFAULT_HOST = "https://telemetry.openpilot.in";

const APP_KEY = String(process.env.APTABASE_APP_KEY || DEFAULT_APP_KEY).trim();
const HOST = String(process.env.APTABASE_HOST || DEFAULT_HOST).trim();

let configured = false;
let enabled = false;

function isConfigured() {
  return Boolean(APP_KEY && HOST);
}

function initializeTelemetry() {
  if (!isConfigured()) {
    configured = false;
    return false;
  }

  try {
    // Fire-and-forget; SDK buffers events until ready.
    void initialize(APP_KEY, { host: HOST });
    configured = true;
    return true;
  } catch (error) {
    console.error("[telemetry] Failed to initialize Aptabase:", error?.message || error);
    configured = false;
    return false;
  }
}

function setTelemetryEnabled(next) {
  enabled = Boolean(next);
  return enabled;
}

function isTelemetryEnabled() {
  return enabled;
}

/**
 * @param {string} name
 * @param {Record<string, string | number> | undefined} props
 */
function track(name, props) {
  if (!configured || !enabled) return;
  const eventName = String(name || "").trim();
  if (!eventName) return;

  let safeProps;
  if (props && typeof props === "object") {
    safeProps = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === "string" || typeof value === "number") {
        safeProps[key] = value;
      }
    }
  }

  try {
    void trackEvent(eventName, safeProps);
  } catch (error) {
    console.error("[telemetry] track failed:", error?.message || error);
  }
}

module.exports = {
  initializeTelemetry,
  setTelemetryEnabled,
  isTelemetryEnabled,
  isConfigured,
  track,
};
