# Spectra Plugin API

This document describes the plugin manifest, lifecycle, events and recommended APIs for writing plugins for Spectra. It complements `plugins/README.md` and the example plugins in `plugins/` (e.g. `discord-presence`, `object-storage`).

## Plugin folder layout

- `my-plugin/`
  - `manifest.json`  — plugin metadata and settings schema
  - `plugin.js`      — main plugin code (ESM, must export `activate`/`deactivate`)
  - `package.json`   — optional, for dependencies
  - static assets (icons, HTML, styles)

## manifest.json (recommended fields)

Example:

```json
{
  "id": "com.babymonie.myplugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Short description",
  "main": "plugin.js",
  "settings": {
    "enabled": true,
    "options": {
      "apiKey": { "type": "string", "title": "API Key" },
      "showCover": { "type": "boolean", "title": "Show album cover", "default": true }
    }
  },
  "permissions": ["invoke","storage"]
}
```

- `id`: unique plugin id
- `main`: entry script
- `settings`: optional declarative settings schema (UI may render these)
- `permissions`: optional list of requested capabilities (see `context.invoke` below)

## plugin.js (API surface)

Your plugin must export an `activate(context)` function. Optionally export `deactivate()`.

The `context` object (provided by Spectra) exposes a minimal, stable API:

- `context.on(eventName, handler)`: subscribe to player events
- `context.off(eventName, handler)`: remove subscription
- `await context.invoke(channel, args)`: call into main process functionality (returns a Promise)
- `context.getSetting(key, defaultValue)`: read a persisted plugin setting
- `context.setSetting(key, value)`: persist a plugin setting
- `context.log(level, message)`: log to the main process console (levels like `info`, `warn`, `error`)

Note: The exact `context` implementation may vary; use the above surface to build portable plugins. If your plugin requires more, check the `plugins/README.md` examples.

## Lifecycle

- `activate(context)` is called when the plugin is enabled/loaded. Use it to register event listeners and initialize state.
- `deactivate()` is called when the plugin is disabled or Spectra shuts down. Clean up listeners and resources here.

### Example plugin skeleton

```js
export function activate(context) {
  context.log('info', 'My Plugin activated');

  // Listen for track start
  const onTrackStarted = (track) => {
    context.log('info', 'Now playing: ' + (track.title || track.path));
  };

  context.on('track-started', onTrackStarted);

  // Provide a small dispose helper on context so deactivate can clean up (optional)
  context._myPluginCleanup = () => {
    context.off('track-started', onTrackStarted);
  };
}

export function deactivate() {
  // if context exposes per-plugin cleanup, call it; otherwise rely on main to remove listeners
}
```

## Events

Plugins receive these player events (at minimum):

- `track-started` — payload: track metadata object { id, title, artist, album, path, duration, coverUrl? }
- `track-paused`
- `track-resumed`
- `track-stopped`

Additional events that may be available depending on Spectra version:

- `queue-changed` — when playback queue is modified
- `library-updated` — when library imports/edits happen
- `playback-progress` — periodic updates about elapsed/timeRemaining

When in doubt, log events you receive to inspect payload shapes.

## Invoking host APIs from plugin

Use `context.invoke(channel, args)` to request main-process actions (for example, to query library or control playback). Example channels (subject to host availability):

- `getLibrary` — returns the full library (array of track objects)
- `playTrack` — args: { trackId }
- `getAlbums` — returns album list

Always `await` the Promise and handle errors. The host will enforce permissions declared in `manifest.json`.

Example:

```js
const albums = await context.invoke('getAlbums');
context.log('info', `Found ${albums.length} albums`);
```

## Settings & storage

If your plugin declares `settings` in `manifest.json`, the host will render a settings UI for plugin users. Use `context.getSetting(key)` and `context.setSetting(key, value)` to read/write plugin settings.

## UI integration

Spectra supports simple plugin UI patterns (examples in `plugins/`). Common approaches:

- Provide an HTML fragment or JS-driven UI and use `context.invoke('openPluginView', { id, htmlPath })` (if supported) to let the host open it inside the app.
- Emit events and let the app's main UI react via `context.invoke('notify', { title, body })`.

Refer to the example plugins in `plugins/` for concrete patterns (Discord presence shows how to use remote server album covers, Object Storage shows remote file browsing integration).

## Security & best practices

- Request the minimal `permissions` needed in `manifest.json`.
- Avoid long-running synchronous work on the main thread.
- Catch and log errors — plugin exceptions should not crash Spectra.
- Respect user privacy: never exfiltrate library or personal data without clear user consent.

## Example: Discord Presence (pseudo-code)

```js
export async function activate(context) {
  const settings = { showAlbum: context.getSetting('showAlbum', true) };
  context.on('track-started', async (track) => {
    // fetch cover via remote server URL or track.coverUrl
    const cover = track.coverUrl || await context.invoke('getAlbumCoverUrl', { album: track.album, artist: track.artist });
    // call host to update presence
    await context.invoke('discord.updatePresence', { track, cover, settings });
  });
}
```

## Troubleshooting

- If your plugin doesn't load, check Spectra main process logs for `plugin` loader errors.
- Ensure `manifest.json` is valid JSON and `main` points to an existing `plugin.js` file.
- Use `context.log('error', err.message)` to surface runtime errors.

## Further reading

- Look at the example plugins in `plugins/` for working code. `plugins/README.md` contains setup notes specific to example plugins.

---
If you want, I can also:

- generate a small plugin scaffold (`plugins/my-plugin`) with a working `manifest.json` and `plugin.js` sample, or
- extend this doc with exact `context.invoke` channel names found in the current `main.js` implementation after scanning it.
