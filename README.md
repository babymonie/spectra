# Spectra

High-quality desktop audio player built with Electron. It supports native exclusive audio output, metadata extraction, playlists, plugins, and an optional remote web client.

![Screenshot](images/screenshot.png)

## Overview
- Modern Electron UI (renderer) with album-scoped search in Library view
- FFmpeg decoding pipeline + native addon for exclusive/shared audio output
- SQLite library with covers, metadata, and playlists
- Plugin system (`plugins/`) and remote control server

## Quick Start (Windows PowerShell)
```powershell
cd "C:\Users\aloys\Downloads\spectra-archive\spectra"
npm install
npm run rebuild-electron
npm start
```

## Build the native addon
- Source: `src/exclusive_audio.cc`
- Config: `binding.gyp`
- Helper: `scripts/build.ps1` (uses `electron-rebuild` or `node-gyp rebuild`)
- Requirements: VS Build Tools (Windows) / Xcode CLI (macOS) / build-essential + ALSA headers (Linux)

## Packaging
Uses `electron-builder` via `package.json` `build` configuration.
```powershell
npm run build
```

## Icons
- Runtime + packaging icon: `images/icon.png`
- README screenshot: `images/screenshot.png`
- For release builds, prefer: 1024×1024 PNG, Windows `.ico`, macOS `.icns`

## Plugins & Remote
- See `plugins/README.md` for details (Discord Presence, Object Storage, Last.fm).
- Remote server: `remoteServer.js` (Express + Socket.IO) serves UI and provides invoke API.

## Planned Paid Features
- ASIO driver plugin (Windows)
- Advanced remote app
- CD ripping + HQ encoding
- Themes/skins

## Troubleshooting
- If native addon fails, playback falls back to renderer; check `exclusiveLoadError` logs in main process.
- Covers/DB live under `app.getPath('userData')`.

## License
No license added yet. Consider adding `LICENSE` (e.g., MIT).

---
Visit the GitHub repo: https://github.com/babymonie/spectra
