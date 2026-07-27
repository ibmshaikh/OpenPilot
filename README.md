# OpenPilot

Proper Electron app rebuilt from the Windows `OneCode-1.0.0-x64.exe` extract.

Source lives under `src/` (`main`, `preload`, `renderer`); app icons under `assets/icons/`.

## Run

```bash
cd ~/Desktop/OpenPilot
npm start
```

Requires Node 20+ (Homebrew: `/opt/homebrew/bin/node`).

## Build installers

```bash
# macOS (.dmg + .zip) + Windows (.exe installer + portable)
npm run dist

# Platform-specific
npm run dist:mac
npm run dist:win
```

Output goes to `dist/`. Artifact filenames omit the version (for example `OpenPilot-arm64.dmg`, `OpenPilot-Setup.exe`). The version is shown only in **Settings → About**. macOS builds are unsigned by default. Building Windows from macOS requires Wine (`brew install --cask wine-stable`).

## Auto-updates (GitHub Releases)

Installed OpenPilot apps check [GitHub Releases](https://github.com/ibmshaikh/OpenPilot/releases) on startup via `electron-updater`. Source/`npm start` does not auto-update.

### Publish a release

1. Bump `version` in `package.json` (for example `1.0.0` → `1.0.1`).
2. Commit and push to `main`.
3. Create and push a matching tag:

```bash
git tag v1.0.1
git push origin v1.0.1
```

4. GitHub Actions builds macOS + Windows and publishes the release assets.
5. Users on installed builds get prompted to restart when the download finishes.

Local publish (needs `GH_TOKEN` with `repo` scope):

```bash
npm run release:mac
# or
npm run release:win
```

### Notes

- Auto-update uses the **zip** (macOS) and **NSIS** (Windows) artifacts, not only the `.dmg`.
- macOS auto-update is more reliable with Apple code signing + notarization. Current builds set `"identity": null` (unsigned).
- Releases must be published (not left as draft) for clients to see them.

## Notes

- User data: `~/Library/Application Support/OpenPilot/` (`onecode.sqlite`, `secrets.key`, `mcp.json`)
- Skills / memory: `~/.onecode/`
- `npm start` clears `ELECTRON_RUN_AS_NODE` so Electron launches correctly in Cursor/CI shells
- After pulling dependency changes: `npm run rebuild` (native `better-sqlite3`)
