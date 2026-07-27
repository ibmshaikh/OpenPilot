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

Output goes to `dist/`. macOS builds are unsigned by default. Building Windows from macOS requires Wine (`brew install --cask wine-stable`).

## Notes

- User data: `~/Library/Application Support/OpenPilot/` (`onecode.sqlite`, `secrets.key`, `mcp.json`)
- Skills / memory: `~/.onecode/`
- `npm start` clears `ELECTRON_RUN_AS_NODE` so Electron launches correctly in Cursor/CI shells
- After pulling dependency changes: `npm run rebuild` (native `better-sqlite3`)
