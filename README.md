# OpenPilot

**OpenPilot** is an open-source AI agent harness for your laptop. Bring your own LLM API key, optionally plug in [TinyFish](https://agent.tinyfish.ai) for live web search, and let an agent read, edit, and run tools against a real project folder — with no vendor lock-in.

It is a chat-first desktop app (Electron) that runs locally. You choose the model provider, the workspace, and the tools. Keys stay on your machine.

![OpenPilot demo](assets/hero-demo.gif)

---

## Why OpenPilot?

- **Bring your own model** — Any OpenAI-compatible endpoint works (OpenAI, local servers, custom gateways, and more). You own the key; nothing is locked to a single vendor.
- **Local AI harness** — The agent runs on your machine against a folder you pick, so it can work with real files on disk.
- **TinyFish search** — Optional web search and page fetch so the agent can look up current docs, versions, and facts outside the workspace.
- **Open source** — Inspect the code, fork it, and contribute. MIT licensed.

---

## Features

| Area | What you get |
| --- | --- |
| **Models** | Add multiple OpenAI-compatible models (name, base URL, API key). Switch models per chat. |
| **Workspace** | Point OpenPilot at a project folder; the agent can read and edit files there. |
| **TinyFish** | Optional live web search + URL fetch ([TinyFish Search / Fetch APIs](https://docs.tinyfish.ai)). Search/Fetch do not use TinyFish credits. |
| **Skills** | Reusable playbooks the agent can load (`/` in the composer). User and project skills supported. |
| **MCP** | Connect [Model Context Protocol](https://modelcontextprotocol.io) servers and enable their tools per chat. |
| **Memory** | Persistent memory settings so the agent can retain useful context across work. |
| **Tool UI** | Streaming replies, thinking blocks, file edits, shell/execute output, and approve/deny for sensitive actions. |
| **Usage** | Session and lifetime token usage by model. |
| **Onboarding** | Guided setup: connect a model → pick a workspace → optionally enable TinyFish. |
| **Updates** | Installed builds check [GitHub Releases](https://github.com/ibmshaikh/OpenPilot/releases) for updates. |

---

## Download

Prebuilt installers are published on GitHub Releases:

**→ [Download the latest release](https://github.com/ibmshaikh/OpenPilot/releases/latest)**

| Platform | Artifact |
| --- | --- |
| macOS (Apple Silicon) | `OpenPilot-arm64.dmg` |
| macOS (Intel) | `OpenPilot-x64.dmg` |
| Windows (installer) | `OpenPilot-Setup.exe` |
| Windows (portable) | `OpenPilot-Portable.exe` |

Installed apps can update automatically from GitHub Releases. Running from source with `npm start` does not auto-update.

---

## Quick start (from source)

**Requirements:** [Node.js](https://nodejs.org/) 20+

```bash
git clone https://github.com/ibmshaikh/OpenPilot.git
cd OpenPilot
npm install
npm start
```

On first launch, follow onboarding:

1. **Connect a model** — OpenAI-compatible base URL + API key (or skip and add later in Settings).
2. **Choose a workspace** — The folder the agent should work in.
3. **Optional: TinyFish** — Get a key at [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys) for web search.

If native modules fail after dependency changes:

```bash
npm run rebuild
```

---

## Build installers

```bash
# macOS (.dmg + .zip) and Windows (.exe installer + portable)
npm run dist

# Platform-specific
npm run dist:mac
npm run dist:win
```

Output goes to `dist/`. Artifact names omit the version (e.g. `OpenPilot-arm64.dmg`, `OpenPilot-Setup.exe`); the version appears in **Settings → About**.

Notes:

- macOS builds are unsigned by default (`identity: null`).
- Building Windows from macOS requires Wine (`brew install --cask wine-stable`). Prefer CI or a Windows machine for Windows artifacts.

---

## Project layout

```
src/
  main/       # Electron main process (agent, DB, MCP, TinyFish, updater)
  preload/    # Secure bridge between main and renderer
  renderer/   # Chat UI, settings, onboarding, tool cards
assets/       # App icons
scripts/      # Build / packaging helpers
```

User data (macOS example):

- App data: `~/Library/Application Support/OpenPilot/` (`onecode.sqlite`, `secrets.key`, `mcp.json`)
- Skills / memory: `~/.onecode/`

---

## Contributing

Contributions are welcome — bug fixes, features, docs, and UX polish.

1. **Fork** the repo and create a branch from `main`:
   ```bash
   git checkout -b feat/your-change
   ```
2. **Install and run** locally (`npm install` → `npm start`).
3. Make focused changes; keep PRs small and reviewable.
4. **Open a pull request** against `main` with a short summary of *why* the change helps.
5. For bugs, open a [GitHub Issue](https://github.com/ibmshaikh/OpenPilot/issues) with steps to reproduce when you can.

### Guidelines

- Match existing style in `src/` (no drive-by refactors in unrelated files).
- Prefer clear, user-facing behavior over clever abstractions.
- Do not commit secrets, API keys, or local user data.
- After pulling dependency changes, run `npm run rebuild` if `better-sqlite3` needs a native rebuild.

### Reporting issues

Include:

- OS and OpenPilot version (Settings → About)
- Whether you used a release build or `npm start`
- Steps to reproduce and any relevant logs / screenshots

---

## Releases (maintainers)

Installed apps update from published [GitHub Releases](https://github.com/ibmshaikh/OpenPilot/releases).

1. Bump `version` in `package.json` (e.g. `1.0.3` → `1.0.4`).
2. Commit and push to `main`.
3. Tag and push:
   ```bash
   git tag v1.0.4
   git push origin v1.0.4
   ```
4. GitHub Actions builds macOS + Windows and publishes release assets.
5. Users on installed builds are prompted when an update is ready.

Local publish (needs `GH_TOKEN` with `repo` scope):

```bash
npm run release:mac
# or
npm run release:win
```

Auto-update uses the **zip** (macOS) and **NSIS** (Windows) artifacts. Releases must be **published** (not draft) for clients to see them. macOS auto-update is more reliable with Apple code signing + notarization.

---

## License

MIT — see `package.json`. Use it, fork it, and ship improvements back if you can.

---

## Links

- **Releases:** https://github.com/ibmshaikh/OpenPilot/releases
- **Issues:** https://github.com/ibmshaikh/OpenPilot/issues
- **TinyFish API keys:** https://agent.tinyfish.ai/api-keys
- **TinyFish docs:** https://docs.tinyfish.ai
