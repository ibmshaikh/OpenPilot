const { spawn } = require("node:child_process");

const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

/**
 * Wrap a LocalShellBackend (or any backend with public `cwd`) so `execute`
 * streams stdout/stderr via hooks while the process runs.
 *
 * Hooks are mutable and set per chat turn:
 *   { onStart({ command }), onChunk({ stream, text }), signal?: AbortSignal }
 *
 * @param {object} backend
 * @param {{ timeoutSec?: number, maxOutputBytes?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ backend: object, controller: { setHooks: Function, killActive: Function, clearHooks: Function } }}
 */
function wrapWithStreamingShell(backend, options = {}) {
  if (!backend || typeof backend !== "object") {
    throw new Error("wrapWithStreamingShell requires a backend");
  }

  const timeoutSec = Number(options.timeoutSec) > 0 ? Number(options.timeoutSec) : DEFAULT_TIMEOUT_SEC;
  const maxOutputBytes =
    Number(options.maxOutputBytes) > 0 ? Number(options.maxOutputBytes) : DEFAULT_MAX_OUTPUT_BYTES;
  const env = options.env || { ...process.env };

  /** @type {{ onStart?: Function, onChunk?: Function, signal?: AbortSignal } | null} */
  let hooks = null;
  /** @type {import("node:child_process").ChildProcess | null} */
  let activeChild = null;

  function setHooks(next) {
    hooks = next && typeof next === "object" ? next : null;
  }

  function clearHooks() {
    hooks = null;
  }

  function killActive() {
    const child = activeChild;
    if (!child || child.killed) return false;
    try {
      child.kill("SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  function emitStart(command) {
    try {
      hooks?.onStart?.({ command: String(command || "") });
    } catch (error) {
      console.error("[onecode] shell onStart failed:", error);
    }
  }

  function emitChunk(stream, text) {
    const value = String(text ?? "");
    if (!value) return;
    try {
      hooks?.onChunk?.({ stream, text: value });
    } catch (error) {
      console.error("[onecode] shell onChunk failed:", error);
    }
  }

  async function streamingExecute(command) {
    if (!command || typeof command !== "string") {
      return {
        output: "Error: Command must be a non-empty string.",
        exitCode: 1,
        truncated: false,
      };
    }

    const cwd = backend.cwd || process.cwd();

    // Surface the command in the UI before the process starts producing output.
    emitStart(command);

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let totalBytes = 0;
      let truncated = false;

      const child = spawn(command, {
        shell: true,
        env,
        cwd,
      });
      activeChild = child;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abortHandler && signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        if (activeChild === child) activeChild = null;
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }, timeoutSec * 1000);

      const signal = hooks?.signal;
      const abortHandler = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      };
      if (signal) {
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }

      const pushStdout = (chunk) => {
        const text = chunk.toString();
        stdout += text;
        totalBytes += Buffer.byteLength(text);
        if (totalBytes <= maxOutputBytes) {
          emitChunk("stdout", text);
        } else if (!truncated) {
          truncated = true;
        }
      };

      const pushStderr = (chunk) => {
        const text = chunk.toString();
        stderr += text;
        totalBytes += Buffer.byteLength(text);
        if (totalBytes <= maxOutputBytes) {
          emitChunk("stderr", text);
        } else if (!truncated) {
          truncated = true;
        }
      };

      child.stdout?.on("data", pushStdout);
      child.stderr?.on("data", pushStderr);

      child.on("error", (err) => {
        const message = `Error executing command: ${err.message}`;
        emitChunk("stderr", message);
        finish({
          output: message,
          exitCode: 1,
          truncated: false,
        });
      });

      child.on("close", (code, signalName) => {
        if (timedOut || signalName === "SIGTERM") {
          const aborted = Boolean(signal?.aborted);
          const message = aborted
            ? "Error: Command cancelled."
            : `Error: Command timed out after ${timeoutSec.toFixed(1)} seconds.`;
          emitChunk("stderr", `\n${message}`);
          finish({
            output: message,
            exitCode: aborted ? 130 : 124,
            truncated: false,
          });
          return;
        }

        const outputParts = [];
        if (stdout) outputParts.push(stdout);
        if (stderr) {
          const stderrLines = stderr.trim().split("\n");
          outputParts.push(...stderrLines.map((line) => `[stderr] ${line}`));
        }

        let output = outputParts.length > 0 ? outputParts.join("\n") : "<no output>";
        let wasTruncated = truncated;
        if (output.length > maxOutputBytes) {
          output = output.slice(0, maxOutputBytes);
          output += `\n\n... Output truncated at ${maxOutputBytes} bytes.`;
          wasTruncated = true;
        }

        const exitCode = code ?? 1;
        if (exitCode !== 0) output = `${output.trimEnd()}\n\nExit code: ${exitCode}`;

        finish({
          output,
          exitCode,
          truncated: wasTruncated,
        });
      });
    });
  }

  backend.execute = streamingExecute;

  return {
    backend,
    controller: {
      setHooks,
      clearHooks,
      killActive,
    },
  };
}

module.exports = {
  wrapWithStreamingShell,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_MAX_OUTPUT_BYTES,
};
