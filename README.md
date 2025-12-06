
# **Spectra**

A high-quality desktop audio player built with **Electron**, featuring native exclusive audio output, metadata extraction, playlists, plugins, and an optional remote web client.

![Screenshot](images/screenshot.png)

---

## **✨ Features**

* ⚡ **Modern Electron UI** with album-scoped search & smooth transitions
* 🎵 **FFmpeg decoding pipeline** with support for high-resolution formats
* 🔊 **Native exclusive/shared audio output**

  * WASAPI (Windows)
  * CoreAudio (macOS)
  * ALSA (Linux)
* 🗂️ **SQLite music library** (tracks, playlists, metadata, covers)
* 🧩 **Plugin system** (`plugins/`) with Discord Presence, Object Storage & Last.fm examples
* 🌐 **Remote control mode** (Express + Socket.IO) with full UI over LAN
* 📦 **Electron Builder packaging** for Windows, macOS, and Linux

---

## **🚀 Quick Start (Windows PowerShell)**

```powershell
cd "C:\Users\aloys\Downloads\spectra-archive\spectra"
npm install
npm run rebuild-electron   # rebuild native addon for your Electron version
npm start
```

### If you get errors:

* Ensure **Visual Studio Build Tools** are installed
* Enable "Desktop development with C++"
* Restart PowerShell after installation

---

## **🛠️ Build the Native Audio Addon**

The exclusive audio engine is a Node-API addon.

| Item              | Path                                 |
| ----------------- | ------------------------------------ |
| **Source**        | `src/exclusive_audio.cc`             |
| **Build config**  | `binding.gyp`                        |
| **Helper script** | `scripts/build.ps1`                  |
| **Output**        | `build/Release/exclusive_audio.node` |

### **Requirements per platform**

#### **Windows**

* Visual Studio Build Tools
* Windows 10 SDK
* Python 3.x

#### **macOS**

* Xcode Command Line Tools

#### **Linux**

```bash
sudo apt install build-essential libasound2-dev
```

### **Manual build**

```powershell
npx electron-rebuild   # recommended
# or
npx node-gyp rebuild
```

---

## **📦 Packaging**

Spectra uses **electron-builder**, configured in `package.json`.

### **Build for your platform**

```powershell
npm run build
```

Outputs:

* Windows: `.exe` installer & portable folder
* macOS: `.app` + `.dmg`
* Linux: `.AppImage` / `.deb` (depending on your config)

---

## **🎨 Icons**

| Purpose             | Location                          |
| ------------------- | --------------------------------- |
| Runtime app icon    | `images/icon.png`                 |
| Installer/packaging | `build/icon.png`, `.ico`, `.icns` |
| README screenshot   | `images/screenshot.png`           |

Recommended export sizes:

* **1024×1024 PNG** (base source)
* **256×256 PNG** (app window)
* **Windows `.ico`** generated from source
* **macOS `.icns`**

---

## **🔌 Plugins & Remote Control**

### Plugins (in `plugins/`)

Includes:

* **Discord Presence**
* **Object Storage uploader**
* **Last.fm scrobbler**
* Custom plugins can add:

  * Menus
  * UI overlays
  * Playback hooks
  * Library modifications

### Remote Mode

* Server: `remoteServer.js`
* Tech: **Express + Socket.IO**
* Serves:

  * HTML UI
  * Real-time playback state
  * Invoke API for remote commands

## Plugins & Remote
- See `plugins/README.md` for details (Discord Presence, Object Storage, Last.fm).
- Plugin API docs: `plugins/API_DOCS.md` — describes `manifest.json`, `plugin.js` lifecycle, `context.invoke` channels, events and examples.
- Remote server: `remoteServer.js` (Express + Socket.IO) serves UI and provides invoke API.

Plugin setup (quick steps)

1. Copy the plugin folder into the repository `plugins/` directory (e.g. `plugins/my-plugin`).
2. If the plugin has a `package.json`, install its dependencies:

```powershell
cd plugins\my-plugin
npm install
```

3. Restart Spectra (or reload plugins from the app settings) and enable the plugin in Settings → Plugins.

Notes:
- Plugins should include a valid `manifest.json` and export `activate(context)` from `plugin.js`.
- Use `plugins/API_DOCS.md` for recommended `context` usage and example code.
Launches automatically when user enables it in settings.

---

## **💎 Roadmap / Paid Features (Planned)**

These are future premium extensions:

* 🎧 **ASIO driver plugin** (Windows native audio with ultra-low latency)
* 📱 **Advanced remote mobile app** (iOS / Android)
* 💿 **CD ripping module** (secure rip with FLAC/ALAC/MP3 encoding)
* 🎨 **Custom themes / full skinning engine**

---

## **🧰 Troubleshooting**

### **Native addon won't load**

* Check console for `exclusiveLoadError`
* ABI mismatch → run:

```powershell
npm run rebuild-electron
```

### **No audio output**

* Another app may already hold the audio device exclusively
* Disable exclusive mode or choose shared output in settings

### **Covers/DB missing**

Spectra stores data in:

```
%APPDATA%/Spectra/
~/Library/Application Support/Spectra/
~/.config/Spectra/
```

---

## **📄 License**

This project is licensed. See the `LICENSE` file for details.

