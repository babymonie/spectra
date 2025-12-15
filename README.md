Here’s a clean, fully redone **README.md** (no “ChatGPT-y” wording, no “if you need me” lines). Copy-paste as your new README.

---

# Spectra

A high-quality desktop audio player built with **Electron**, featuring a modern library UI, playlists, plugins, and an optional LAN remote control mode.

Download binaries, installers, and extras: **[https://spectra.f4ust.com](https://spectra.f4ust.com)**

---

## Features

* ⚡ Modern Electron UI with fast library browsing & search
* 🎵 FFmpeg decoding pipeline (wide format support)
* 🔊 Native audio output modes (exclusive/shared depending on platform support)

  * WASAPI (Windows)
  * CoreAudio (macOS)
  * ALSA (Linux)
* 🗂️ SQLite music library (tracks, playlists, metadata, covers)
* 🧩 Plugin system (`plugins/`) with example plugins (e.g., Discord Presence, Object Storage, Last.fm)
* 🌐 Remote control mode (Express + Socket.IO) for LAN control
* 📦 Electron Builder packaging for Windows, macOS, Linux

---

## Download & Install

### Windows

* Download the installer from the releases page/site and run it.
* If SmartScreen appears, choose **More info → Run anyway** (only if you trust the source).

### macOS

* Download the `.dmg` or `.zip`, then drag **Spectra.app** into **Applications**.
* If macOS blocks the app as “damaged” or “can’t be opened”, see the Gatekeeper troubleshooting section below.

### Linux

* Use the provided AppImage / deb / rpm (depending on the release).
* Ensure the file is executable if using AppImage:

  ```bash
  chmod +x Spectra.AppImage
  ```

---

## macOS Gatekeeper Troubleshooting (local testing)

Unsigned apps (or apps downloaded outside the App Store) may be quarantined by Gatekeeper. For local testing, you can remove the quarantine attribute.

**Clear extended attributes recursively:**

```bash
sudo xattr -cr /path/to/Spectra.app
```

**Or remove only the quarantine attribute explicitly:**

```bash
sudo xattr -rd com.apple.quarantine /path/to/Spectra.app
```

Replace `/path/to/Spectra.app` with the real path, for example:

* `~/Downloads/Spectra-darwin-x64/Spectra.app`
* `/Applications/Spectra.app`

> Note: These are workarounds intended for local testing. For public distribution, the recommended approach is **Developer ID signing + notarization**.

---

## Build From Source

### Requirements

* Node.js (LTS recommended)
* npm or pnpm
* FFmpeg available on your system (or packaged as part of your build flow)

### Install dependencies

```bash
npm install
```

### Run in development

```bash
npm run dev
```

### Build packaged releases

```bash
npm run build
```

(Exact script names depend on your `package.json`. If your repo uses different commands like `electron:dev` / `electron:build`, keep those instead.)

---

## Plugins

Spectra supports a plugin folder-based system.

* Plugins live in:

  * `plugins/` (development)
  * or the app’s plugin directory in user data (depending on your runtime design)

Typical capabilities:

* Add menu items / UI panels
* Add integrations (Discord Presence, scrobbling, cloud/object storage)
* Extend metadata behavior or playlist workflows

If you include example plugins in the repo, list them here:

* **Discord Presence** — show currently playing track on Discord
* **Object Storage** — upload/export media or playlist assets
* **Last.fm** — scrobble plays (optional)

---

## Remote Control Mode (LAN)

Spectra can run a local server (Express + Socket.IO) to allow control from another device on the same network.

Typical flow:

* Enable Remote Mode in the app
* Open the provided LAN URL in a browser on your phone/PC
* Control playback, browse library, manage queue/playlists

(If you have a config flag or CLI arg, document it here.)

---

## Data & Storage

Spectra stores app data in the OS user data directory, including:

* SQLite database (library index)
* cover art cache
* settings
* plugins (if you load from user directory)

Location examples:

* macOS: `~/Library/Application Support/Spectra`
* Windows: `%APPDATA%\Spectra`
* Linux: `~/.config/Spectra`

---

## Developer Notes: Git hooks & version bump

This repo includes an optional post-commit version bump flow to keep the `package.json` **patch** version moving automatically.

### Tracked files

* `.githooks/post-commit` — wrapper hook
* `scripts/post-commit-bump.js` — bumps patch version and commits with:
  `chore: bump version to X.Y.Z`

### Enable the tracked hooks directory

```bash
git config core.hooksPath .githooks
```

After enabling, each `git commit` will trigger a bump commit **unless** the latest commit already matches `chore: bump version to ...` (prevents loops).

### Run bump manually

```bash
npm run bump-version
```

### Disable hooks (restore default)

```bash
git config --unset core.hooksPath
```

---

## Roadmap (optional)

* ASIO driver support (paid)
* CD ripping plugin (paid)
* Mobile remote (paid)
* Themes (paid)

---

## Recent Changes

* Minor UI fixes: improved album/artist filtering and clickable artist/album cells in the library view.


## License

This project is licensed. See `LICENSE` for details.
