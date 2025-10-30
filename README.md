# Kaspa Mixer - Standalone

Standalone command-line and Electron GUI for the Kaspa Mixer.

## Requirements

- Windows 10+ (build targets are Windows by default)
- Node.js 18+
- A Kaspa node (`kaspad.exe`) – the app can auto-start it if present

Optional (for GUI installer):
- NSIS is bundled via `electron-builder`, no manual install needed

## Project Layout

- `index.js` – CLI entry
- `electron-main.js` – GUI entry (main process)
- `gui/` – Renderer UI (HTML/CSS/JS)
- `lib/` – Core logic (sessions, wallet, monitor, rpc, etc.)
- `pool/` – Mining pool (optional) UI controls and config

## Install

```powershell
npm install
```

## Building & Running

### CLI (packaged .exe)
```powershell
# Build single-file CLI executable
npm run build

# Run it
 .\mixer-cli.exe
```

During startup the CLI attempts to auto-start `kaspad.exe` (if found) or use `start-kaspad.bat` if present.

### GUI (development)
```powershell
# Start Electron in dev mode
npm run electron
```

### GUI (installer)
```powershell
# Optional: provide a local kaspad.exe so it’s bundled (recommended)
$env:KASPAD_LOCAL_EXE = 'C:\path\to\kaspad.exe'

# Build Windows installer
npm run build:gui
```

Outputs:
- `dist/win-unpacked/` – unpacked app (contains `Kaspa Mixer.exe`, `kaspad.exe`, `start-kaspad.bat`)
- `dist/Kaspa Mixer Setup x.y.z.exe` – NSIS installer

The GUI auto-starts `kaspad.exe` on first launch if present. In dev, it looks in the project folder; in packaged mode, it checks beside the app exe and in `resources`.

## How the node binary is bundled

- We do not commit `kaspad.exe` to git.
- For installer builds, place `kaspad.exe` at `standalone-mixer/kaspa/kaspad.exe` or set `KASPAD_LOCAL_EXE` to a valid path. The build copies it next to the installed app so the GUI can auto-start it.

## Commands (CLI)

- `create` – Create new mixing session
- `status <id>` – Check session status
- `list` – List all sessions
- `wallet import <key>` – Import wallet private key
- `wallet send <address> <amount>` – Send funds
- `wallet balance` – Check balance
- `node` – Check node status
- `help` – Show all commands

## Features

### Both Versions
- ✅ Create mixing sessions with up to 10 destinations
- ✅ Automatic deposit detection and processing
- ✅ Intermediate address mixing for privacy
- ✅ Wallet integration (import private key, send funds)
- ✅ Session recovery from blockchain
- ✅ Auto-start Kaspa node (if found)

### GUI Only
- 🎨 Modern, intuitive interface
- 📊 Real-time session status updates
- 🔒 Secure private key handling
- 📱 Tab-based navigation
- 💰 Wallet balance display

## Data & Storage

Runtime data is stored per-user in `%APPDATA%\Kaspa Mixer\` (Electron) and/or `%USERPROFILE%\.kaspa-mixer\` (CLI):

- Sessions: `sessions.json`
- Wallet: `wallet.json`

Back up this folder if you need to preserve sessions or wallet state. It contains private keys – protect it.


## Troubleshooting

- Node not found: start `kaspad.exe` manually or place it at `kaspa/kaspad.exe` and rebuild the GUI installer.
- Ports: default Borsh WS `127.0.0.1:17110`, JSON-RPC `127.0.0.1:16110`.
- Dev tools: run with `DEBUG=1 npm run electron` to open DevTools automatically.


