import { createRequire } from 'node:module';
import path from 'path';
import net from 'net';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import audioEngine from './audioEngine.js';
import { DeviceMonitor } from './deviceMonitor.js';
import { startUpdateChecker } from './updateChecker.js';
import initSqlJs from 'sql.js';
import { extractMetadata, extractMetadataFromBuffer } from './metadataLookup.js';
import { extractLyrics } from './metadataLookup.js';
import { inferMetadataFromPath, isPlaceholderMetadataValue, isWeakTitleForPath } from './metadataFilename.js';
import db from './database.js';
import RemoteServer from './remoteServer.js';

const require = createRequire(import.meta.url);
const electron = require('electron');
const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, globalShortcut, Tray, nativeImage, shell } = electron;
import  registerThemeIpc  from './themeManager.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plugin system setup
const repoPluginsDir = path.join(__dirname, 'plugins'); // Built-in plugins in repo
const pluginsDir = path.join(app.getPath('userData'), 'plugins');
const pluginConfigPath = path.join(pluginsDir, 'plugins-config.json');
const loadedPlugins = new Map();

// Small persistent app-level settings stored in userData
const appSettingsPath = path.join(app.getPath('userData'), 'app-settings.json');
let appSettings = { minimizeToTray: true };

const cliArgs = (process.argv || []).slice(1).filter((arg) => typeof arg === 'string');

const parseEnvBoolean = (value) => {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const hasCliFlag = (...keys) => {
  for (const rawArg of cliArgs) {
    if (typeof rawArg !== 'string') continue;
    for (const key of keys) {
      const normalizedKey = key.startsWith('--') ? key : `--${key}`;
      if (rawArg === normalizedKey) return true;
      if (rawArg.startsWith(`${normalizedKey}=`)) return true;
    }
  }
  return false;
};

const electronHasSwitch = (...keys) => {
  try {
    return keys.some((key) => {
      const normalizedKey = key.replace(/^--/, '');
      return app.commandLine.hasSwitch(normalizedKey);
    });
  } catch {
    return false;
  }
};

const isServerMode =
  hasCliFlag('server', 'server-mode', 'headless-server', 'headless') ||
  electronHasSwitch('server', 'server-mode', 'headless-server', 'headless') ||
  parseEnvBoolean(process.env.SPECTRA_SERVER) ||
  parseEnvBoolean(process.env.npm_config_server) ||
  parseEnvBoolean(process.env.npm_config_headless);

const getCliOption = (...keys) => {
  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];
    for (const key of keys) {
      const long = `--${key}`;
      if (arg === long && i + 1 < cliArgs.length && !cliArgs[i + 1].startsWith('--')) {
        return cliArgs[i + 1];
      }
      if (arg.startsWith(`${long}=`)) {
        return arg.slice(long.length + 1);
      }
    }
  }

  if (keys && keys.length) {
    for (const key of keys) {
      try {
        const normalizedKey = key.replace(/^--/, '');
        const val = app.commandLine.getSwitchValue(normalizedKey);
        if (val) return val;
      } catch {
        /* noop */
      }
    }
  }
  return undefined;
};

const serverPortValue = getCliOption('server-port', 'remote-port') ?? process.env.SPECTRA_SERVER_PORT;
let remoteServerPort = Number(serverPortValue ?? '3000');
if (!Number.isFinite(remoteServerPort) || remoteServerPort <= 0) {
  remoteServerPort = 3000;
}

const remoteServerHost = getCliOption('server-host', 'remote-host') ?? process.env.SPECTRA_SERVER_HOST ?? '0.0.0.0';
const disableRemoteServer =
  hasCliFlag('no-remote', 'disable-remote') ||
  electronHasSwitch('no-remote', 'disable-remote') ||
  parseEnvBoolean(process.env.SPECTRA_DISABLE_REMOTE) ||
  parseEnvBoolean(process.env.npm_config_no_remote) ||
  parseEnvBoolean(process.env.npm_config_disable_remote);
const shouldStartRemoteServer = !disableRemoteServer;

if (isServerMode) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  console.log('[main] Server mode enabled – no desktop window will be created. CLI args:', cliArgs);
} else {
  console.log('[main] Desktop mode enabled.');
}

function loadAppSettings() {
  try {
    if (fs.existsSync(appSettingsPath)) {
      const j = JSON.parse(fs.readFileSync(appSettingsPath, 'utf8'));
      appSettings = Object.assign({}, appSettings, j || {});
      console.log('[settings] Loaded app settings:', appSettingsPath, appSettings);

      // Restore EQ settings if available
      if (appSettings.eq) {
        audioEngine.setEQ(appSettings.eq);
      }
    } else {
      console.log('[settings] No app settings found, using defaults');
    }
  } catch (e) {
    console.warn('[settings] Failed to load app settings', e);
  }
}

function saveAppSettings() {
  try {
    fs.writeFileSync(appSettingsPath, JSON.stringify(appSettings, null, 2), 'utf8');
    console.log('[settings] Saved app settings:', appSettingsPath, appSettings);
  } catch (e) {
    console.error('[settings] Failed to save app settings', e);
  }
}

if (!fs.existsSync(pluginsDir)) {
  fs.mkdirSync(pluginsDir, { recursive: true });
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'plugins', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

function loadPluginConfig() {
  try {
    if (fs.existsSync(pluginConfigPath)) {
      const cfg = JSON.parse(fs.readFileSync(pluginConfigPath, 'utf8'));
      console.log(`[plugins] Loaded config from ${pluginConfigPath}:`, JSON.stringify(cfg, null, 2));
      return cfg;
    } else {
      console.log(`[plugins] No config file found at ${pluginConfigPath}, using defaults`);
    }
  } catch (e) {
    console.error('Failed to read plugins-config.json', e);
  }
  return {};
}

// Helper: test preferred port and fall back to a free ephemeral port if it's in use
function findAvailablePort(preferredPort, host = '0.0.0.0') {
  return new Promise((resolve) => {
    try {
      const tester = net.createServer();
      tester.once('error', (err) => {
        tester.close?.();
        if (err && err.code === 'EADDRINUSE') {
          // Preferred port in use — bind ephemeral port
          const tester2 = net.createServer();
          tester2.listen(0, host, () => {
            const p = tester2.address().port;
            tester2.close(() => resolve(p));
          });
          tester2.once('error', () => resolve(0));
        } else {
          resolve(0);
        }
      });
      tester.listen(preferredPort, host, () => {
        const p = tester.address().port;
        tester.close(() => resolve(p));
      });
    } catch (e) {
      resolve(0);
    }
  });
}

function savePluginConfig(cfg) {
  try {
    // Ensure the plugins directory exists before saving
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
      console.log(`[plugins] Created plugins directory: ${pluginsDir}`);
    }
    fs.writeFileSync(pluginConfigPath, JSON.stringify(cfg, null, 2), 'utf8');
    console.log(`[plugins] Saved config to ${pluginConfigPath}:`, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('Failed to write plugins-config.json', e);
  }
}

let mainWindow;
let tray = null;
let remoteServer;
let libraryDeduped = false;
let currentTrackMetadata = null;
let currentPlaybackOptions = {};
// Pending files opened before app is ready
const pendingOpenFiles = [];

// Playback queue and modes
let playbackQueue = [];
let queueIndex = -1;
let shuffleMode = false;
let repeatMode = 'off'; // 'off', 'all', 'one'
let originalQueue = []; // For when shuffle is toggled off

const eqPresets = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  rock: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
  pop: [2, 3, 4, 3, 0, -1, -1, 0, 2, 3],
  jazz: [3, 2, 1, 1, -1, -1, 0, 1, 2, 3],
  classical: [4, 3, 2, 0, -1, -1, 0, 2, 3, 4],
  bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 2, 4, 5, 6, 6],
  vocal: [0, 1, 3, 4, 3, 1, 0, 0, 0, 0],
};

function normalizeEqBands(bands) {
  const source = Array.isArray(bands) ? bands : eqPresets.flat;
  return eqPresets.flat.map((_, i) => Math.max(-12, Math.min(12, Number(source[i]) || 0)));
}

function persistEqState() {
  appSettings.eq = audioEngine.getEQ();
  saveAppSettings();
  return appSettings.eq;
}

// Ensure single instance and handle files passed to second instance (Windows)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[main] Another Spectra instance is already running; exiting this process.');
  app.quit();
}
app.on('second-instance', (event, argv) => {
  // argv may include file paths when a user double-clicks an associated file
  try {
    if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }

    const files = parseArgvFiles(argv || []);
    for (const f of files) {
      // if mainWindow ready, handle immediately; otherwise queue
      if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
        handleOpenFile(f);
      } else {
        pendingOpenFiles.push(f);
      }
    }
  } catch (e) {
    console.warn('[main] second-instance file handling failed', e);
  }
});

// macOS: handle files opened via Finder / double-click
app.on('open-file', (event, filePath) => {
  try {
    event.preventDefault();
    if (app.isReady()) handleOpenFile(filePath);
    else pendingOpenFiles.push(filePath);
  } catch (err) {
    console.warn('[main] open-file handler failed', err);
  }
});

function broadcast(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
  if (remoteServer) {
    remoteServer.broadcast(channel, ...args);
  }
}

// Every place that decides "is this an audio file" (dialogs, folder scans,
// drag & drop, network shares) uses this one list.
const AUDIO_EXTENSIONS = [
  'flac', 'wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'alac',
  'dsf', 'dff', 'ape', 'aiff', 'aif', 'caf', 'wv', 'mka', 'tak', 'tta', 'mp4', 'webm',
];
const AUDIO_EXTENSION_SET = new Set(AUDIO_EXTENSIONS.map((e) => `.${e}`));
const CUE_MARKER = '\x00cue\x00';

// Utility: detect if an argument refers to a local audio file path
function isAudioPath(p) {
  if (!p) return false;
  try {
    // Accept file:// URLs too
    if (p.startsWith('file://')) return true;
    return AUDIO_EXTENSION_SET.has(path.extname(p || '').toLowerCase());
  } catch {
    return false;
  }
}

function isRemoteUrl(p) {
  return typeof p === 'string' && /^https?:\/\//i.test(p);
}

// Transport commands (menu, tray, media keys) go through the renderer when a
// window exists: it owns the playback context, shuffle order and the output
// settings. Headless/server mode falls back to the main-process queue.
function sendPlayerCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player:command', command);
    return;
  }
  const playFromQueue = (track) => {
    if (!track) return;
    const { track: _t, startTime: _s, gapless: _g, ...outputOptions } = currentPlaybackOptions || {};
    handlers['audio:play'](track.path, { ...outputOptions, track });
  };
  const status = audioEngine.getStatus();
  if (command === 'toggle') {
    if (status.playing && !status.paused) handlers['audio:pause']();
    else if (status.playing) handlers['audio:resume']();
    else if (queueIndex >= 0 && playbackQueue[queueIndex]) playFromQueue(playbackQueue[queueIndex]);
  } else if (command === 'next') {
    playFromQueue(handlers['queue:next']());
  } else if (command === 'previous') {
    playFromQueue(handlers['queue:previous']());
  } else if (command === 'stop') {
    handlers['audio:stop']();
  }
}

function parseArgvFiles(argv) {
  const files = [];
  for (const a of argv) {
    if (!a) continue;
    // Skip electron executable and app path
    if (String(a).endsWith('electron.exe') || String(a).endsWith('electron')) continue;
    // Normalize file:// URIs
    try {
      if (String(a).startsWith('file://')) {
        const u = new URL(a);
        files.push(u.pathname);
        continue;
      }
    } catch {}
    if (isAudioPath(a) && fs.existsSync(a)) files.push(a);
  }
  return files;
}

async function handleOpenFile(filePath) {
  if (!filePath) return;
  try {
    // Normalize file:// URI
    if (String(filePath).startsWith('file://')) {
      try { filePath = fileURLToPath(filePath); } catch {}
    }

    // If it's a local file, ensure it exists
    if (!filePath.startsWith('http') && !fs.existsSync(filePath)) {
      console.warn('[main] open-file requested but file not found:', filePath);
      return;
    }

    // Add to DB (processAndAddTrack handles idempotency)
    if (!filePath.startsWith('http')) {
      const added = await processAndAddTrack(filePath).catch(() => null);
      // Play the file
      if (added) {
        await handlers['audio:play'](filePath, {});
      } else {
        // Still attempt to play even if DB add failed
        await handlers['audio:play'](filePath, {});
      }
    } else {
      // remote URL: call existing add-remote handler then play
      await handlers['library:add-remote']({ url: filePath }).catch(() => null);
      await handlers['audio:play'](filePath, {});
    }
  } catch (e) {
    console.error('[main] handleOpenFile failed for', filePath, e);
  }
}

function getPlayerState() {
  const status = audioEngine.getStatus();
  return {
    ...status,
    track: currentTrackMetadata
  };
}

function broadcastState() {
  broadcast('player:state', getPlayerState());
}

// Read version from package.json
function getAppVersion() {
  try {
    const packagePath = path.join(__dirname, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return packageJson.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function setupApplicationMenu() {
  const version = getAppVersion();
  const isMac = process.platform === 'darwin';

  const template = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'Add Files to Library...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openFile', 'multiSelections'],
              filters: [
                { name: 'Audio Files', extensions: AUDIO_EXTENSIONS }
              ]
            });
            if (!result.canceled && result.filePaths.length > 0) {
              await processFileList(result.filePaths);
            }
          }
        },
        {
          label: 'Add Folder to Library...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory']
            });
            if (!result.canceled && result.filePaths.length > 0) {
              await handleAddFiles(result.filePaths);
            }
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // Playback menu
    {
      label: 'Playback',
      submenu: [
        // No accelerators here on purpose: a menu accelerator swallows the key
        // window-wide, so "Space" made it impossible to type a space into the
        // search box and Ctrl+Arrow broke word navigation in every text field.
        // The renderer handles these keys when focus is not in an input.
        { label: 'Play/Pause\tSpace', click: () => sendPlayerCommand('toggle') },
        { label: 'Stop', click: () => sendPlayerCommand('stop') },
        { label: 'Next Track\tCtrl+Right', click: () => sendPlayerCommand('next') },
        { label: 'Previous Track\tCtrl+Left', click: () => sendPlayerCommand('previous') },
        { type: 'separator' },
        { label: 'Stop After Current Track', click: () => sendPlayerCommand('stop-after-current') },
        { type: 'separator' },
        { label: 'Volume Up\tCtrl+Up', click: () => sendPlayerCommand('volume-up') },
        { label: 'Volume Down\tCtrl+Down', click: () => sendPlayerCommand('volume-down') },
        { type: 'separator' },
        { label: 'Find\tCtrl+F', click: () => sendPlayerCommand('focus-search') }
      ]
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' }
        ] : [
          { role: 'close' }
        ])
      ]
    },
    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Spectra',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'none',
              title: 'About Spectra',
              message: 'Spectra',
              detail: `Version: ${version}\n\nA modern, high-fidelity music player with exclusive audio support.\n\nBuilt with Electron and ❤️\n\nGitHub: github.com/babymonie/spectra`,
              buttons: ['OK', 'View on GitHub'],
              defaultId: 0,
              cancelId: 0,
              noLink: true
            }).then(result => {
              if (result.response === 1) {
                shell.openExternal('https://github.com/babymonie/spectra');
              }
            });
          }
        },
        {
          label: 'Changelog',
          click: () => {
            shell.openExternal('https://github.com/babymonie/spectra/releases');
          }
        },
        {
          label: 'Report Issue',
          click: () => {
            shell.openExternal('https://github.com/babymonie/spectra/issues/new');
          }
        },
        { type: 'separator' },
        {
          label: 'View on GitHub',
          click: () => {
            shell.openExternal('https://github.com/babymonie/spectra');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  // Prefer bunded app icon when available
  let winIcon = undefined;
  try {
    const winIconPath = path.join(__dirname, 'images', 'icon.png');
    if (fs.existsSync(winIconPath)) winIcon = winIconPath;
  } catch {}

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: winIcon,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // Allow loading local resources (cover art)
      backgroundThrottling: false,
      spellcheck: false
    },
    backgroundColor: '#121212',
    // Platform-specific title bar: hiddenInset on macOS for draggable region, default on Windows, frameless on Linux
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 10, y: 10 } } : {}),
    ...(process.platform === 'linux' ? { frame: false } : {})
  });

  // Handle minimize to tray on Windows
  mainWindow.on('minimize', (event) => {
    if (process.platform === 'win32' && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('close', (event) => {
    if (process.platform === 'win32' && !app.isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  // mainWindow.webContents.openDevTools();
}

// Helper to resolve special URI schemes like object-storage://
async function resolveTrackPath(filePath) {
  if (typeof filePath !== 'string') return filePath;
  const plugin = loadedPlugins.get('object-storage');
  if (plugin?.module?.ObjectStorageAPI?.resolvePath) {
    try {
      const resolved = await plugin.module.ObjectStorageAPI.resolvePath(filePath);
      if (resolved) return resolved;
    } catch (e) {
      console.warn('[main] Failed to resolve object-storage path:', filePath, e);
    }
  }
  // Other plugins (e.g. NAS: WebDAV credentials) may rewrite a path for playback.
  for (const [id, loaded] of loadedPlugins) {
    if (id === 'object-storage' || typeof loaded?.module?.resolvePath !== 'function') continue;
    try {
      const resolved = await loaded.module.resolvePath(filePath);
      if (resolved) return resolved;
    } catch (e) {
      console.warn(`[main] Plugin ${id} failed to resolve path`, e);
    }
  }
  return filePath;
}

// Extra request headers a plugin wants on fetches of this URL (e.g. WebDAV auth).
function getPluginRequestHeaders(url) {
  for (const [id, loaded] of loadedPlugins) {
    if (typeof loaded?.module?.getRequestHeaders !== 'function') continue;
    try {
      const headers = loaded.module.getRequestHeaders(url);
      if (headers && Object.keys(headers).length) return headers;
    } catch (e) {
      console.warn(`[main] Plugin ${id} failed to provide request headers`, e);
    }
  }
  return {};
}

// Shared handlers for IPC and Remote Server
const handlers = {
  'library:get': () => db.getAllTracks(),
  'library:remove-track': (id) => db.removeTrack(id),
  'library:delete-album': (albumName, artistName) => db.deleteAlbum(albumName, artistName),
  'library:update-track': (id, data) => db.updateTrack(id, data),
  'library:get-albums': () => db.getAlbums(),
  'library:get-artists': () => db.getArtists(),
  'library:get-album-tracks': (albumName, artistName) => db.getAlbumTracks(albumName, artistName),

  'library:get-cover-image': async (coverPath) => {
    if (!coverPath || coverPath.startsWith('http')) return coverPath;
    try {
      const imageBuffer = await fs.promises.readFile(coverPath);
      const ext = path.extname(coverPath).toLowerCase();
      let mimeType = 'image/jpeg';
      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.gif') mimeType = 'image/gif';
      return `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
    } catch (err) {
      console.error('Error reading cover image:', coverPath, err);
      return null;
    }
  },
  'library:add-files': async (filePaths = []) => handleAddFiles(filePaths),
  'library:add-remote': async (remoteInfo = {}) => handleAddRemote(remoteInfo),
  'library:add-remote-many': async (list = []) => handleAddRemoteMany(list),

    // Allow renderer to relink a track whose file has moved
    'track:relink': async (info) => {
      console.log('track:relink called with', info);
      // Allow relinking even if renderer didn't provide the track object.
      const requestedFilePath = info?.filePath || null;
      const requestedTrack = info?.track || null;

      // Prefer provided track, otherwise fall back to currentTrackMetadata or DB lookup by path
      let targetTrack = requestedTrack || currentTrackMetadata || (requestedFilePath ? db.getTrackByPath(requestedFilePath) : null);

      // Open dialog regardless so user can pick replacement file
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Locate audio file',
        defaultPath: requestedFilePath || (targetTrack && targetTrack.path) || undefined,
        properties: ['openFile'],
        filters: [
          { name: 'Audio Files', extensions: AUDIO_EXTENSIONS },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      console.log('track:relink dialog result:', { canceled, filePaths });
      if (canceled || !filePaths || !filePaths.length) return { ok: false };

      const newPath = filePaths[0];
      try {
        // If we can identify a track id, update DB path; otherwise skip DB update but still attempt playback
        const trackId = targetTrack?.id || (requestedFilePath ? (db.getTrackByPath(requestedFilePath)?.id) : null);
        if (trackId) {
          try {
            db.updateTrackPath(trackId, newPath);
            console.log(`Updated DB track ${trackId} path ->`, newPath);
          } catch (dbErr) {
            console.error('Failed to update DB track path:', dbErr);
          }
        } else {
          console.log('No track id found to update; skipping DB update');
        }

        if (trackId) {
          currentTrackMetadata = db.getTrackById(trackId) || { ...(targetTrack || {}), id: trackId, path: newPath };
        } else {
          currentTrackMetadata = { ...(targetTrack || {}), path: newPath, title: targetTrack?.title || path.basename(newPath) };
        }

        // Reuse the normal play handler so relink keeps the selected backend,
        // ASIO window handle, EQ compatibility, queue metadata, and broadcasts.
        await handlers['audio:play'](newPath, { ...(currentPlaybackOptions || {}), track: currentTrackMetadata });

        return { ok: true, newPath };
      } catch (e) {
        console.error('Failed to relink and play track', e);
        return { ok: false, error: String(e?.message || e) };
      }
    },
  'audio:play': async (filePath, options = {}) => {
    try {
      const playPath = await resolveTrackPath(filePath);

      // Guard against missing media (e.g., USB drive unplugged) to avoid silent playback attempts.
      // Remote URLs are not checked; cue virtual tracks are checked by their audio file.
      const localPath = typeof playPath === 'string' ? playPath.split(CUE_MARKER)[0] : playPath;
      try {
        if (!isRemoteUrl(playPath) && !fs.existsSync(localPath)) {
          const err = `File not found: ${localPath}`;
          console.warn('[main] audio:play aborted:', err);
          broadcast('audio:error', { message: err, filePath: localPath, track: options.track || currentTrackMetadata });
          return;
        }
      } catch {}

      if (options.volume !== undefined) {
        options.volume = Number(options.volume);
      }

      if (typeof options.deviceId === 'string' && options.deviceId.startsWith('asio:')) {
        options.mode = 'asio';
      }

      if (options.mode === 'asio' && mainWindow && !mainWindow.isDestroyed()) {
        options.windowHandle = mainWindow.getNativeWindowHandle();
      }

      // Store track metadata if provided
      if (options.track) {
        currentTrackMetadata = options.track;
      } else {
        // Try to find it in DB or just use path
        const track = db.getTrackByPath(filePath);
        currentTrackMetadata = track || { path: filePath, title: path.basename(filePath) };
      }

      // Propagate gapless intent from queue:next's __gapless flag or explicit options.gapless
      const isGapless = !!(options.gapless || options.track?.__gapless);
      currentPlaybackOptions = { ...options, track: currentTrackMetadata, gapless: isGapless };
      const startedTrack = currentTrackMetadata;
      await audioEngine.playFile(playPath, () => {
        emitPluginEvent('track-stopped', startedTrack);
        broadcast('audio:ended', { id: startedTrack?.id ?? null, path: startedTrack?.path ?? null });
        broadcastState();
      }, (err) => {
        console.error('Playback error:', err);
        // Notify renderer about playback error (e.g. missing file)
        broadcast('audio:error', {
          message: String(err && err.message ? err.message : err),
          filePath,
          track: currentTrackMetadata
        });
        broadcastState();
      }, currentPlaybackOptions);

      // Emit track started event to plugins
      emitPluginEvent('track-started', currentTrackMetadata);

      broadcastState();
    } catch (e) {
      console.error('Play failed:', e);
      broadcast('audio:error', {
          message: String(e && e.message ? e.message : e),
          filePath,
          track: currentTrackMetadata
        });
    }
  },
  'audio:get-devices': () => audioEngine.getDevices(),
  'audio:open-asio-control-panel': (deviceId) => {
    const options = { deviceId };
    if (mainWindow && !mainWindow.isDestroyed()) {
      options.windowHandle = mainWindow.getNativeWindowHandle();
    }
    return audioEngine.openAsioControlPanel(options);
  },
  'audio:get-status': () => {
    try {
      return audioEngine.getStatus();
    } catch (e) {
      return { error: String(e) };
    }
  },
  // EQ
  'audio:get-eq': () => audioEngine.getEQ(),
  'audio:set-eq-enabled': (enabled) => {
    const eq = audioEngine.getEQ();
    audioEngine.setEQ({ ...eq, enabled });
    return persistEqState();
  },
  'audio:set-eq-preset': (preset) => {
    const eq = audioEngine.getEQ();
    const name = Object.hasOwn(eqPresets, preset) ? preset : 'flat';
    const bands = eqPresets[name];

    audioEngine.setEQ({ ...eq, preset: name, bands });
    return persistEqState();
  },
  'audio:set-eq-bands': (bands) => {
    const eq = audioEngine.getEQ();
    audioEngine.setEQ({ ...eq, bands: normalizeEqBands(bands), preset: 'custom' });
    return persistEqState();
  },
  // Pre-amp
  'audio:get-preamp': () => audioEngine.getPreamp(),
  'audio:set-preamp': (db) => {
    const result = audioEngine.setPreamp(db);
    broadcastState();
    return result;
  },
  // ReplayGain
  'audio:get-replaygain-mode': () => audioEngine.getReplayGainMode(),
  'audio:set-replaygain-mode': (mode) => {
    const result = audioEngine.setReplayGainMode(mode);
    broadcastState();
    return result;
  },
  // Cue sheet import
  'cue:import': async (cuePath) => {
    try {
      const { loadCueFile, encodeCueTrackPath } = await import('./cueParser.js');
      const tracks = loadCueFile(cuePath);
      return tracks.map((t, i) => ({
        id: `cue-${cuePath}-${i}`,
        path: encodeCueTrackPath(t.filePath, t.startSec, t.endSec),
        title: t.title || `Track ${t.trackNumber}`,
        artist: t.performer || '',
        album: t.album || '',
        genre: t.genre || '',
        year: t.year || '',
        trackNumber: t.trackNumber,
        duration: t.endSec != null ? t.endSec - t.startSec : null,
        format: path.extname(t.filePath).replace('.', '').toLowerCase(),
      }));
    } catch (e) {
      console.error('[cue] import failed:', e);
      throw e;
    }
  },
  // Playlists
  'playlists:create': (name) => db.createPlaylist(name),
  'playlists:list': () => db.getAllPlaylists(),
  'playlists:get-tracks': (playlistId) => db.getPlaylistTracks(playlistId),
  'playlists:export': async (playlistId) => {
    try {
      // Find playlist metadata
      const pls = db.getAllPlaylists();
      const pl = pls.find(p => String(p.id) === String(playlistId));
      if (!pl) return { success: false, error: 'Playlist not found' };

      // Ask user where to save
      const defaultName = `${pl.name || 'playlist'}.playlist`;
      const defaultDir = app.getPath('downloads') || app.getPath('home') || __dirname;
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export playlist',
        defaultPath: path.join(defaultDir, defaultName),
        filters: [
          { name: 'Spectra Playlist', extensions: ['playlist'] },
          { name: 'M3U8 Playlist (other players)', extensions: ['m3u8'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      if (canceled || !filePath) return { success: false, canceled: true };

      // Standard M3U8 so the playlist opens in foobar2000, VLC, etc.
      if (/\.m3u8?$/i.test(filePath)) {
        const lines = ['#EXTM3U'];
        for (const t of db.getPlaylistTracks(playlistId) || []) {
          const seconds = Math.round(Number(t.duration) || -1);
          const label = [t.artist, t.title].filter(Boolean).join(' - ') || path.basename(String(t.path));
          lines.push(`#EXTINF:${seconds},${label}`);
          lines.push(String(t.path).split(CUE_MARKER)[0]);
        }
        fs.writeFileSync(filePath, lines.join('\r\n') + '\r\n', 'utf8');
        return { success: true, path: filePath };
      }

      // Create a new sqlite DB at the chosen path and populate with playlist + tracks
      const SQL = await initSqlJs();
      const outDb = new SQL.Database();
      outDb.run(`
        CREATE TABLE playlists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at DATETIME, updated_at DATETIME);
        CREATE TABLE tracks (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT, artist TEXT, album TEXT, album_artist TEXT, duration REAL, format TEXT, cover_path TEXT, lyrics TEXT, created_at DATETIME);
        CREATE TABLE playlist_tracks (playlist_id INTEGER, track_id INTEGER, track_order INTEGER, PRIMARY KEY (playlist_id, track_id));
      `);

      // Insert playlist row (keep original id for portability)
      outDb.run('INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [pl.id, pl.name, pl.created_at || null, pl.updated_at || pl.created_at || null]);

      // Insert tracks and playlist_tracks
      const tracks = db.getPlaylistTracks(playlistId) || [];
      let order = 1;
      for (const t of tracks) {
        outDb.run('INSERT INTO tracks (id, path, title, artist, album, album_artist, duration, format, cover_path, lyrics, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [t.id, t.path, t.title || null, t.artist || null, t.album || null, t.album_artist || null, t.duration || null, t.format || null, t.cover_path || null, t.lyrics || null, t.created_at || null]);
        outDb.run('INSERT INTO playlist_tracks (playlist_id, track_id, track_order) VALUES (?, ?, ?)', [pl.id, t.id, order++]);
      }

      // Export to file
      const data = outDb.export();
      fs.writeFileSync(filePath, data);
      outDb.close();
      return { success: true, path: filePath };
    } catch (e) {
      console.error('playlists:export failed', e);
      return { success: false, error: String(e) };
    }
  },
  'playlists:import': async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Import playlist',
        properties: ['openFile'],
        filters: [
          { name: 'Playlists', extensions: ['playlist', 'm3u', 'm3u8'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      if (canceled || !filePaths || !filePaths.length) return { success: false, canceled: true };
      const impPath = filePaths[0];

      // M3U / M3U8 from other players
      if (/\.m3u8?$/i.test(impPath)) {
        const text = fs.readFileSync(impPath, 'utf8').replace(/^﻿/, '');
        const baseDir = path.dirname(impPath);
        const created = db.createPlaylist(path.basename(impPath).replace(/\.m3u8?$/i, '') || 'Imported Playlist');
        let playlistId = created && created.lastInsertRowid ? created.lastInsertRowid : null;
        if (!playlistId) {
          const all = db.getAllPlaylists();
          playlistId = all.length ? Math.max(...all.map((p) => Number(p.id) || 0)) : null;
        }
        let added = 0;
        let missing = 0;
        let pendingInfo = null;
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) continue;
          if (line.startsWith('#EXTINF:')) {
            const m = line.match(/^#EXTINF:(-?\d+(?:\.\d+)?)[^,]*,(.*)$/);
            if (m) pendingInfo = { duration: Number(m[1]) > 0 ? Number(m[1]) : 0, label: m[2].trim() };
            continue;
          }
          if (line.startsWith('#')) continue;
          const info = pendingInfo;
          pendingInfo = null;
          try {
            let stored = null;
            if (isRemoteUrl(line)) {
              const [artist, ...rest] = (info?.label || '').split(' - ');
              const res = await handleAddRemote({
                url: line,
                title: rest.length ? rest.join(' - ') : (info?.label || undefined),
                artist: rest.length ? artist : undefined,
                duration: info?.duration || undefined,
              });
              stored = res?.success ? res.track : null;
            } else {
              let filePath = line.startsWith('file://') ? fileURLToPath(line) : line;
              if (!path.isAbsolute(filePath)) filePath = path.resolve(baseDir, filePath);
              if (!fs.existsSync(filePath)) { missing++; continue; }
              stored = await processAndAddTrack(filePath);
            }
            if (stored?.id && playlistId) { db.addTrackToPlaylist(playlistId, stored.id); added++; }
          } catch (e) {
            missing++;
            console.warn('[main] m3u import skipped entry', line, e?.message ?? e);
          }
        }
        return { success: true, playlistId, added, missing };
      }

      // Open provided sqlite file and read playlist + tracks
      const SQL = await initSqlJs();
      const buffer = fs.readFileSync(impPath);
      const srcDb = new SQL.Database(buffer);

      // Read playlists (take first)
      const stmt1 = srcDb.prepare('SELECT * FROM playlists ORDER BY id LIMIT 1');
      stmt1.step();
      const plRow = stmt1.getAsObject();
      stmt1.free();
      if (!plRow || !plRow.id) { srcDb.close(); return { success: false, error: 'No playlist data found' }; }

      // Create playlist in main DB
      const res = db.createPlaylist(plRow.name || 'Imported Playlist');
      const newPlaylistId = res && res.lastInsertRowid ? res.lastInsertRowid : null;
      // Read tracks joined to playlist_tracks if available
      let rows = [];
      try {
        const stmt2 = srcDb.prepare(`SELECT t.*, pt.track_order FROM tracks t JOIN playlist_tracks pt ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.track_order ASC`);
        stmt2.bind([plRow.id]);
        while (stmt2.step()) {
          rows.push(stmt2.getAsObject());
        }
        stmt2.free();
      } catch {
        // Fallback: read tracks table alone
        try {
          const stmt3 = srcDb.prepare('SELECT * FROM tracks ORDER BY id ASC');
          while (stmt3.step()) {
            rows.push(stmt3.getAsObject());
          }
          stmt3.free();
        } catch { rows = []; }
      }

      // For each track, insert/update into main DB and add to playlist in order
      for (const r of rows) {
        try {
          const candidateTrack = {
            path: r.path,
            title: r.title,
            artist: r.artist,
            album: r.album,
            album_artist: r.album_artist,
            duration: r.duration,
            format: r.format,
            cover_path: r.cover_path || null,
            bitrate: r.bitrate ?? null,
            sample_rate: r.sample_rate ?? null,
            bit_depth: r.bit_depth ?? null,
            channels: r.channels ?? null,
            lossless: r.lossless ?? null,
            codec: r.codec ?? null,
            quality_score: r.quality_score ?? null,
          };
          if (candidateTrack.quality_score == null) {
            candidateTrack.quality_score = computeQualityScore(candidateTrack);
          }
          const storedTrack = storeTrackWithDedup(candidateTrack);
          if (storedTrack && newPlaylistId) {
            db.addTrackToPlaylist(newPlaylistId, storedTrack.id);
          }
        } catch (e) {
          console.warn('Failed to import track', r.path, e);
        }
      }

      srcDb.close();
      return { success: true, playlistId: newPlaylistId };
    } catch (e) {
      console.error('playlists:import failed', e);
      return { success: false, error: String(e) };
    }
  },
  'playlists:add-track': (playlistId, trackId) => db.addTrackToPlaylist(playlistId, trackId),
  'playlists:rename': (playlistId, name) => db.renamePlaylist(playlistId, name),
  'playlists:delete': (playlistId) => db.deletePlaylist(playlistId),
  'playlists:remove-track': (playlistId, trackId) => db.removeTrackFromPlaylist(playlistId, trackId),
  'playlists:reorder': (playlistId, orderedTrackIds) => db.reorderPlaylist(playlistId, orderedTrackIds),
  // Queue management
  'queue:get': () => ({ queue: playbackQueue, index: queueIndex }),
  'queue:set': (tracks, current = null) => {
    playbackQueue = Array.isArray(tracks) ? tracks : [];
    queueIndex = playbackQueue.length > 0 ? 0 : -1;
    if (playbackQueue.length > 0 && current != null) {
      if (typeof current === 'number' && current >= 0 && current < playbackQueue.length) {
        queueIndex = current;
      } else if (typeof current === 'object') {
        const byId = current.id != null
          ? playbackQueue.findIndex((t) => t && t.id != null && t.id === current.id)
          : -1;
        if (byId !== -1) queueIndex = byId;
        else if (current.path) {
          const byPath = playbackQueue.findIndex((t) => t && t.path && t.path === current.path);
          if (byPath !== -1) queueIndex = byPath;
        }
      } else if (typeof current === 'string') {
        const byPath = playbackQueue.findIndex((t) => t && t.path && t.path === current);
        if (byPath !== -1) queueIndex = byPath;
      }
    }
    originalQueue = [...playbackQueue];
    return { queue: playbackQueue, index: queueIndex };
  },
  'queue:add': (track) => {
    playbackQueue.push(track);
    if (queueIndex === -1) queueIndex = 0;
    return { queue: playbackQueue, index: queueIndex };
  },
  'queue:set-current': (current) => {
    if (!playbackQueue.length) {
      queueIndex = -1;
      return { queue: playbackQueue, index: queueIndex };
    }
    let idx = -1;
    if (typeof current === 'number' && current >= 0 && current < playbackQueue.length) {
      idx = current;
    } else if (typeof current === 'object' && current) {
      if (current.id != null) {
        idx = playbackQueue.findIndex((t) => t && t.id != null && t.id === current.id);
      }
      if (idx === -1 && current.path) {
        idx = playbackQueue.findIndex((t) => t && t.path && t.path === current.path);
      }
    } else if (typeof current === 'string') {
      idx = playbackQueue.findIndex((t) => t && t.path && t.path === current);
    }
    if (idx >= 0) queueIndex = idx;
    return { queue: playbackQueue, index: queueIndex };
  },
  'queue:remove': (index) => {
    if (index >= 0 && index < playbackQueue.length) {
      playbackQueue.splice(index, 1);
      // If a track before the current one was removed, shift index down.
      // If the current track itself was removed, keep the index so the
      // track that slid into its slot becomes the new current. Clamp.
      if (index < queueIndex) queueIndex--;
      if (queueIndex >= playbackQueue.length) queueIndex = playbackQueue.length - 1;
      if (playbackQueue.length === 0) queueIndex = -1;
    }
    return { queue: playbackQueue, index: queueIndex };
  },
  'queue:clear': () => {
    playbackQueue = [];
    queueIndex = -1;
    originalQueue = [];
    return { queue: playbackQueue, index: queueIndex };
  },
  'queue:next': () => {
    if (playbackQueue.length === 0) return null;
    if (repeatMode === 'one') return { ...playbackQueue[queueIndex], __gapless: true };
    queueIndex++;
    if (queueIndex >= playbackQueue.length) {
      if (repeatMode === 'all') queueIndex = 0;
      else return null;
    }
    // Signal gapless intent — renderer passes this as options.gapless to audio:play
    return { ...playbackQueue[queueIndex], __gapless: true };
  },
  'queue:previous': () => {
    if (playbackQueue.length === 0) return null;
    queueIndex--;
    if (queueIndex < 0) queueIndex = playbackQueue.length - 1;
    return playbackQueue[queueIndex];
  },
  // Shuffle and Repeat
  'player:set-shuffle': (enabled) => {
    if (enabled && !shuffleMode) {
      // Enable shuffle: save original and shuffle current queue
      originalQueue = [...playbackQueue];
      const currentTrack = queueIndex >= 0 ? playbackQueue[queueIndex] : null;
      // Fisher-Yates shuffle
      for (let i = playbackQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [playbackQueue[i], playbackQueue[j]] = [playbackQueue[j], playbackQueue[i]];
      }
      // Ensure current track stays at current position
      if (currentTrack) {
        const newIdx = playbackQueue.findIndex(t => t.id === currentTrack.id);
        if (newIdx !== -1 && newIdx !== queueIndex) {
          [playbackQueue[queueIndex], playbackQueue[newIdx]] = [playbackQueue[newIdx], playbackQueue[queueIndex]];
        }
      }
    } else if (!enabled && shuffleMode) {
      // Disable shuffle: restore original queue
      const currentTrack = queueIndex >= 0 ? playbackQueue[queueIndex] : null;
      playbackQueue = [...originalQueue];
      if (currentTrack) {
        queueIndex = playbackQueue.findIndex(t => t.id === currentTrack.id);
        if (queueIndex === -1) queueIndex = 0;
      }
    }
    shuffleMode = enabled;
    return { shuffle: shuffleMode, repeat: repeatMode };
  },
  'player:set-repeat': (mode) => {
    if (['off', 'all', 'one'].includes(mode)) {
      repeatMode = mode;
    }
    return { shuffle: shuffleMode, repeat: repeatMode };
  },
  'player:get-modes': () => ({ shuffle: shuffleMode, repeat: repeatMode }),
  // Equalizer
  'eq:get': () => audioEngine.getEQ(),
  'eq:set-enabled': (enabled) => {
    const eq = audioEngine.getEQ();
    audioEngine.setEQ({ ...eq, enabled: !!enabled });
    return persistEqState();
  },
  'eq:set-preset': (preset) => {
    const eq = audioEngine.getEQ();
    const name = Object.hasOwn(eqPresets, preset) ? preset : 'flat';
    audioEngine.setEQ({ ...eq, preset: name, bands: eqPresets[name] });
    return persistEqState();
  },
  'eq:set-bands': (bands) => {
    const eq = audioEngine.getEQ();
    audioEngine.setEQ({ ...eq, bands: normalizeEqBands(bands), preset: 'custom' });
    return persistEqState();
  },
  'player:get-state': () => getPlayerState(),
  'lyrics:get': async (opts = {}) => {
    const { filePath, external = false, artist, title } = opts || {};
    if (filePath) {
      try {
        // Resolve special URI schemes (object-storage:// etc.) to a usable path/URL
        const resolvedPath = await resolveTrackPath(filePath).catch(() => filePath);
        const embedded = await extractLyrics(resolvedPath);
        if (embedded && typeof embedded === 'string' && embedded !== '[object Object]') {
          return { source: 'embedded', lyrics: embedded };
        }
      } catch (e) {
        console.error('[main] extractLyrics error:', e);
      }
    }
    if (external && artist && title) {
      try {
        const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
        const res = await fetch(url, { timeout: 5000 }).catch(() => null);
        if (res && res.ok) {
          const body = await res.json().catch(() => null);
          if (body) {
            if (body.syncedLyrics) {
              return { source: 'online', lyrics: body.syncedLyrics, isSynced: true };
            }
            const text = body.plainLyrics || body.lyrics;
            if (text) {
              return { source: 'online', lyrics: text, isSynced: false };
            }
          }
        }
      } catch (e) {
        console.error('[main] online lyrics fetch failed', e);
      }
    }
    return { source: 'none', lyrics: null };
  },
  'lyrics:save': async (opts = {}) => {
    const { trackId, lyrics } = opts || {};
    try {
      if (!trackId) return { success: false, error: 'missing trackId' };
      const updated = db.updateTrackLyrics(trackId, String(lyrics || ''));
      return { success: true, changes: updated.changes };
    } catch (e) {
      console.error('[main] lyrics:save failed', e);
      return { success: false, error: String(e) };
    }
  },
  'audio:pause': () => {
    audioEngine.pause();
    emitPluginEvent('track-paused', currentTrackMetadata);
    broadcastState();
  },
  'audio:resume': () => {
    audioEngine.resume();
    emitPluginEvent('track-resumed', currentTrackMetadata);
    broadcastState();
  },
  'audio:stop': () => {
    audioEngine.stop();
    emitPluginEvent('track-stopped', currentTrackMetadata);
    broadcastState();
  },
  'audio:set-volume': (val) => { audioEngine.setVolume(val); broadcastState(); },
  'audio:seek': (time) => { audioEngine.seek(time); broadcastState(); },
  'audio:get-time': () => audioEngine.getTime(),
  'remote:toggle': async (enable) => {
    // Lazily create RemoteServer if missing
    if (!remoteServer) {
      remoteServer = new RemoteServer(path.join(__dirname, 'renderer'), async (channel, ...args) => {
        if (handlers[channel]) return handlers[channel](...args);
        throw new Error(`Unknown channel: ${channel}`);
      }, { pluginRoots: [pluginsDir, repoPluginsDir] });
    }

    if (enable) {
      try {
        const chosen = await findAvailablePort(remoteServerPort, remoteServerHost);
        if (chosen && chosen !== remoteServerPort) {
          console.log(`[main] Preferred remote port ${remoteServerPort} unavailable, using ${chosen}`);
          remoteServerPort = chosen;
        }
      } catch (e) {
        console.warn('[main] Failed to find available port for remote server', e);
      }
      await remoteServer.start(remoteServerPort, remoteServerHost);
      // Broadcast current remote info to renderer and remote clients
      try {
        broadcast('remote:info', { host: remoteServerHost, port: remoteServerPort, isRunning: !!remoteServer.isRunning });
      } catch (e) { /* noop */ }
    } else {
      await remoteServer.stop();
      try {
        broadcast('remote:info', { host: remoteServerHost, port: remoteServerPort, isRunning: !!remoteServer.isRunning });
      } catch (e) { /* noop */ }
    }
    return remoteServer.isRunning;
  },
  'remote:get-info': () => ({ host: remoteServerHost, port: remoteServerPort, isRunning: !!(remoteServer && remoteServer.isRunning) }),
  'plugins:list': async () => {
    const plugins = [];
    const cfg = loadPluginConfig();

    const searchDirs = [repoPluginsDir, pluginsDir];
    const seen = new Set();

    for (const searchDir of searchDirs) {
      if (!fs.existsSync(searchDir)) continue;

      const dirs = fs.readdirSync(searchDir, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const manifestPath = path.join(searchDir, d.name, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;

        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          const pluginId = manifest.id || d.name;

          if (seen.has(pluginId)) continue;
          seen.add(pluginId);

          const enabled = cfg[pluginId]?.enabled !== false;
          const savedSettings = cfg[pluginId]?.settings || manifest.settings || {};
          plugins.push({
            id: pluginId,
            enabled,
            ...manifest,
            settings: savedSettings,
          });
        } catch (e) {
          console.error('Failed to load plugin manifest', d.name, e);
        }
      }
    }
    return plugins;
  },
  'plugins:set-enabled': async (id, enabled) => {
    console.log(`[plugins] Setting plugin ${id} enabled=${enabled}`);
    const cfg = loadPluginConfig();
    cfg[id] = { ...(cfg[id] || {}), enabled: !!enabled };
    console.log(`[plugins] Updated config for ${id}:`, cfg[id]);
    savePluginConfig(cfg);

    try {
      const isEnabled = !!enabled;
      const loaded = loadedPlugins.get(id);
      if (!isEnabled && loaded) {
        deactivatePlugin(id);
      }
      if (isEnabled && !loaded) {
        for (const base of [pluginsDir, repoPluginsDir]) {
          const candidate = path.join(base, id);
          if (!fs.existsSync(path.join(candidate, 'manifest.json'))) continue;
          if (await loadPluginFromDir(candidate, loadPluginConfig())) break;
        }
      }
    } catch (err) {
      console.error('[plugins] Error handling set-enabled:', err);
    }

    return cfg[id];
  },
  'plugins:update-settings': async (id, settings) => {
    const cfg = loadPluginConfig();
    cfg[id] = { ...(cfg[id] || {}), settings: settings };
    savePluginConfig(cfg);
    // Update the loaded plugin's context settings
    const plugin = loadedPlugins.get(id);
    if (plugin && plugin.context) {
      plugin.context.settings = settings;
    }
    return cfg[id];
  },
  'plugins:ready-for-reload': async () => {
    try {
      ipcMain.emit('plugins:ready-for-reload', { sender: null });
    } catch (e) {
      console.warn('[plugins] Failed to forward remote reload acknowledgement', e);
    }
    return { acknowledged: true };
  },
  'plugins:reload': async () => {
    // Notify renderer so it can cleanup plugin DOM/UI before reload
    try {
      if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('plugins:will-reload');
    } catch (notifyErr) {
      console.warn('Failed to notify renderer about plugin reload', notifyErr);
    }
    // Wait for renderer to acknowledge cleanup to avoid race conditions
    try {
      await new Promise((resolve) => {
        let done = false;
        const timeout = setTimeout(() => {
          if (!done) {
            done = true;
            console.warn('[plugins] Timeout waiting for renderer cleanup ack; continuing reload');
            resolve();
          }
        }, 2000); // 2s timeout

        const handler = () => {
          if (!done) {
            done = true;
            clearTimeout(timeout);
            try { ipcMain.removeListener('plugins:ready-for-reload', handler); } catch (e) { console.warn('ipc removeListener failed', e); }
            resolve();
          }
        };
        try { ipcMain.once('plugins:ready-for-reload', handler); } catch (e) { console.warn('ipc once failed', e); resolve(); }
      });
    } catch (err) {
      console.warn('[plugins] Error while waiting for renderer ack; continuing', err);
    }

    // Deactivate all plugins (also unregisters their IPC channels so the
    // reload can register them again without "second handler" errors)
    for (const id of Array.from(loadedPlugins.keys())) deactivatePlugin(id);
    loadedPlugins.clear();
    pluginEventHandlers.clear();

    // Reload plugins
    await loadPlugins();
    try {
      if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('plugins:reloaded');
    } catch (notifyErr) {
      console.warn('Failed to notify renderer after plugin reload', notifyErr);
    }
    return { success: true, count: loadedPlugins.size };
  },
  'shell:open-external': (url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  },
  // Allow renderer/plugins to request saving/downloading a track file to disk
  // This starts the save task and returns immediately with a download id; progress
  // events are broadcast using `download:*` channels so UIs can subscribe.
  'track:download': async (opts = {}) => {
    const { filePath, suggestedName } = opts || {};
    if (!filePath) return { success: false, error: 'missing filePath' };

    const id = `dl_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    // Kick off background task (do not block the IPC response)
    (async () => {
      try {
        broadcast('download:start', { id, filePath, suggestedName });

        const defaultName = suggestedName || path.basename(filePath);
        const defaultDir = app.getPath('downloads') || app.getPath('home') || __dirname;
        const { canceled, filePath: savePath } = await dialog.showSaveDialog(mainWindow, {
          title: 'Save track as',
          defaultPath: path.join(defaultDir, defaultName),
          filters: [ { name: 'Audio', extensions: ['mp3','flac','wav','m4a','aac','ogg','dsf','dff'] }, { name: 'All Files', extensions: ['*'] } ]
        });

        if (canceled || !savePath) {
          broadcast('download:canceled', { id });
          return;
        }

        // Helper to emit progress
        const emitProgress = (data) => broadcast('download:progress', Object.assign({ id }, data));

        if (/^https?:\/\//i.test(filePath)) {
          // Remote download with progress
          const res = await fetch(filePath);
          if (!res || !res.ok) {
            broadcast('download:error', { id, error: `Download failed: ${res?.status || 'error'}` });
            return;
          }

          const total = Number(res.headers.get && res.headers.get('content-length')) || null;
          const writeStream = fs.createWriteStream(savePath);

          const body = res.body;
          let downloaded = 0;

          if (body && typeof body.pipe === 'function') {
            // Node-style stream
            body.on('data', (chunk) => {
              downloaded += chunk.length;
              emitProgress({ downloaded, total });
            });
            body.on('error', (err) => broadcast('download:error', { id, error: String(err) }));
            body.on('end', () => {
              writeStream.end();
              broadcast('download:complete', { id, savedPath: savePath });
            });
            body.pipe(writeStream);
          } else if (body && typeof body.getReader === 'function') {
            // WHATWG ReadableStream
            const reader = body.getReader();
            async function pump() {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = Buffer.from(value);
                downloaded += chunk.length;
                writeStream.write(chunk);
                emitProgress({ downloaded, total });
              }
              writeStream.end();
              broadcast('download:complete', { id, savedPath: savePath });
            }
            pump().catch((err) => broadcast('download:error', { id, error: String(err) }));
          } else {
            // Fallback: read whole body
            const ab = await res.arrayBuffer();
            await fs.promises.writeFile(savePath, Buffer.from(ab));
            broadcast('download:complete', { id, savedPath: savePath });
          }
        } else {
          // Local file copy with progress
          try {
            const stat = await fs.promises.stat(filePath);
            const total = stat.size;
            const read = fs.createReadStream(filePath);
            const write = fs.createWriteStream(savePath);
            let copied = 0;
            read.on('data', (chunk) => {
              copied += chunk.length;
              emitProgress({ downloaded: copied, total });
            });
            read.on('error', (err) => broadcast('download:error', { id, error: String(err) }));
            read.on('end', () => {
              write.end();
              broadcast('download:complete', { id, savedPath: savePath });
            });
            read.pipe(write);
          } catch (err) {
            // If stat fails, fallback to simple copy
            console.warn('[main] download stat fallback', err);
            try {
              await fs.promises.copyFile(filePath, savePath);
              broadcast('download:complete', { id, savedPath: savePath });
            } catch (copyErr) {
              broadcast('download:error', { id, error: String(copyErr) });
            }
          }
        }
      } catch (e) {
        console.error('[main] download task failed', e);
        broadcast('download:error', { id, error: String(e && e.message ? e.message : e) });
      }
    })();

    return { started: true, id };
  }
};

function createTray() {
  if (process.platform !== 'win32') return; // Only create tray on Windows for now
  // Prefer a packaged app icon at `images/icon.png` when available; fall back to an embedded data URL.
  let trayImage = null;
  try {
    const iconPath = path.join(__dirname, 'images', 'icon.png');
    if (fs.existsSync(iconPath)) {
      trayImage = nativeImage.createFromPath(iconPath);
    }
  } catch (e) {
    if (e) {
      console.warn('[tray] Failed to load tray icon from disk', e);
    }
  }

  if (!trayImage) {
    trayImage = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAFJSURBVDiNpZO9SgNBFIW/2U0kIGKhYGVhYWVrYWOhYGNhYWNhIWLhH1hYWFhYWFhY+AAWFhYWFhYWFhYWFhYWFhYWFhY+gIWFhYWFhYVfMTPZzO4mG0jIgYGZe+6ZM/fHGGNwiQiKCCKCiKCIICIoIogIiggigvw3RASMMZgLMMZgjMEYgzEGYwzGGIwxGGMwxmCMwRiDMQZjDMYYjDH/AowxGGMwxnABxhiMMZwDjDEYYzgDGGMwxnAKMMZgjOEEYIzBGMMxwBiDMYYjgDEGYwyHAGMMxhgOAMYYjDHsA4wxGGPYAxhjMMawCzDGYIxhB2CMwRjDNsAYgzGGLYAxBmMMmwBjDMYYNgDGGIwxrAOMMRhjWAMYYzDGsAowxmCMYQVgjMEYwzLAGIMxhiWAMQZjDIsAYwzGGBYAxhiMMcwDjDEYY5gDGGMwxjAL+AA8VFf3p3YAAAAASUVORK5CYII=');
  }

  tray = new Tray(trayImage);
  tray.setToolTip('Spectra Music Player');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Spectra',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Play/Pause',
      click: () => sendPlayerCommand('toggle')
    },
    { label: 'Next Track', click: () => sendPlayerCommand('next') },
    { label: 'Previous Track', click: () => sendPlayerCommand('previous') },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Double-click to show window
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  protocol.registerFileProtocol('plugins', (request, callback) => {
    const url = request.url.slice('plugins://'.length);

    // Check repo plugins first (source/dev)
    let p = path.join(repoPluginsDir, url);
    if (fs.existsSync(p)) {
      callback({ path: p });
      return;
    }

    // Check user data plugins
    p = path.join(pluginsDir, url);
    if (fs.existsSync(p)) {
      callback({ path: p });
      return;
    }

    callback({ error: -2 });
  });

  // Load app settings so we can respect minimize-to-tray preference
  loadAppSettings();
  repairExistingLibraryMetadataFromPaths();
  dedupeLibrary();

  if (!isServerMode) {
    createWindow();
    setupApplicationMenu();
    if (appSettings.minimizeToTray) createTray();
  } else {
    console.log('[main] Server mode: skipping desktop window and tray.');
  }

  // Process any files that were requested before the app was ready
  try {
    // Files passed on the command line at startup
    const initialFiles = parseArgvFiles(process.argv || []);
    for (const f of initialFiles) pendingOpenFiles.push(f);
    // Handle queued files
    while (pendingOpenFiles.length) {
      const fp = pendingOpenFiles.shift();
      await handleOpenFile(fp);
    }
  } catch (e) {
    console.warn('[main] initial file open processing failed', e);
  }

  // Initialize Remote Server
  if (shouldStartRemoteServer) {
    remoteServer = new RemoteServer(path.join(__dirname, 'renderer'), async (channel, ...args) => {
      if (handlers[channel]) {
        return handlers[channel](...args);
      }
      throw new Error(`Unknown channel: ${channel}`);
    }, { pluginRoots: [pluginsDir, repoPluginsDir] });

    // Choose an available port: prefer configured port, but fall back to a free port if in use
    try {
      const chosen = await findAvailablePort(remoteServerPort, remoteServerHost);
      if (chosen && chosen !== remoteServerPort) {
        console.log(`[main] Preferred remote port ${remoteServerPort} unavailable, using ${chosen}`);
        remoteServerPort = chosen;
      }
    } catch (e) {
      console.warn('[main] Failed to pick alternative remote port, using configured port', e);
    }

    await remoteServer.start(remoteServerPort, remoteServerHost);
  } else {
    console.log('[main] Remote server disabled via CLI/env flag.');
  }
  // Register theme IPC handlers (themeManager exports an object with registerThemeIpc)
  try {
    if (registerThemeIpc && typeof registerThemeIpc.registerThemeIpc === 'function') {
      registerThemeIpc.registerThemeIpc();
      console.log('[themes] Theme IPC handlers registered');
    } else if (typeof registerThemeIpc === 'function') {
      // fallback if the import was the function itself
      registerThemeIpc();
      console.log('[themes] Theme IPC handlers registered (function)');
    }
  } catch (e) {
    console.error('[themes] Failed to register theme IPC handlers', e);
  }

  // Load plugins after app is ready
  await loadPlugins();

  // Start background update checker
  startUpdateChecker(broadcast);

  // Start PnP device monitor — polls for audio device add/remove
  const deviceMonitor = new DeviceMonitor({ getDevices: () => audioEngine.getDevices() });
  deviceMonitor.on('device-added', (d) => {
    console.log('[devices] Device connected:', d.name || d.id);
    broadcast('audio:device-added', d);
  });
  deviceMonitor.on('device-removed', (d) => {
    console.log('[devices] Device disconnected:', d.name || d.id);
    broadcast('audio:device-removed', d);
  });
  deviceMonitor.on('changed', () => {
    broadcast('audio:devices-changed', deviceMonitor.getKnownDevices());
  });
  deviceMonitor.start();

  // Register global keyboard shortcuts
  const registerShortcuts = () => {
    // Only real media keys are grabbed system-wide. Ctrl+Left/Right used to be
    // registered globally too, which stole word navigation from every other
    // application while Spectra was running.
    const bind = (accelerator, command) => {
      try {
        if (!globalShortcut.register(accelerator, () => sendPlayerCommand(command))) {
          console.warn(`[main] Could not register global shortcut ${accelerator}`);
        }
      } catch (e) {
        console.warn(`[main] Failed to register global shortcut ${accelerator}`, e);
      }
    };
    bind('MediaPlayPause', 'toggle');
    bind('MediaNextTrack', 'next');
    bind('MediaPreviousTrack', 'previous');
    bind('MediaStop', 'stop');
  };

  if (!isServerMode) {
    registerShortcuts();
  } else {
    console.log('[main] Server mode: global media shortcuts disabled.');
  }

  app.on('activate', function () {
    if (!isServerMode && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (isServerMode) {
    // Keep running to serve the web UI and native audio output.
    return;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();

  // Clean up system tray
  if (tray) {
    tray.destroy();
    tray = null;
  }

  // Deactivate all plugins on quit
  for (const id of Array.from(loadedPlugins.keys())) deactivatePlugin(id);

  try { audioEngine.stop(); } catch {}
  try { db.flushDb(); } catch {}
});

// Register IPC Handlers
for (const [channel, handler] of Object.entries(handlers)) {
  ipcMain.handle(channel, (event, ...args) => handler(...args));
}

// Allow renderer to toggle minimize-to-tray preference (persisted)
ipcMain.handle('app:set-minimize-to-tray', (event, enabled) => {
  try {
    appSettings.minimizeToTray = !!enabled;
    if (appSettings.minimizeToTray) {
      if (!tray) createTray();
    } else {
      if (tray) {
        try { tray.destroy(); } catch (e) { console.warn('Failed to destroy tray', e); }
        tray = null;
      }
    }
    saveAppSettings();
    return { minimizeToTray: appSettings.minimizeToTray };
  } catch (e) {
    console.error('[settings] app:set-minimize-to-tray handler failed', e);
    return { error: String(e) };
  }
});

// Specific IPC handlers that need event.sender or are local-only
ipcMain.handle('context-menu:show-album', async (event, albumInfo) => {
  const { albumName, artistName, trackCount } = albumInfo || {};
  const template = [
    {
      label: `Delete Album "${albumName || 'Unknown'}"`,
      click: () => {
        event.sender.send('album:delete-confirm', { albumName, artistName, trackCount });
      }
    },
    { type: 'separator' },
    {
      label: 'View Album',
      click: () => {
        event.sender.send('album:view', { albumName, artistName });
      }
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  menu.popup(BrowserWindow.fromWebContents(event.sender));
});

ipcMain.handle('context-menu:show-track', async (event, tracks) => {
  // `tracks` may be a single object or an array of track objects
  const items = Array.isArray(tracks) ? tracks : (tracks ? [tracks] : []);
  const first = items[0] || null;
  const template = [];
  template.push({
    label: 'Play Next',
    click: () => { event.sender.send('queue:play-next', items); }
  });
  template.push({
    label: 'Add to Queue',
    click: () => { event.sender.send('queue:append', items); }
  });
  template.push({ type: 'separator' });
  if (items.length === 1) {
    template.push({
      label: 'Show in Folder',
      enabled: !!first?.path && !isRemoteUrl(first.path),
      click: () => { try { shell.showItemInFolder(String(first.path).split(CUE_MARKER)[0]); } catch {} }
    });
    template.push({
      label: 'Edit Info',
      click: () => { event.sender.send('track:edit', first); }
    });
    template.push({ type: 'separator' });
  }
  template.push({
    label: items.length > 1 ? `Remove ${items.length} tracks from Library` : 'Remove from Library',
    click: () => {
      const ids = items.map(t => t.id).filter(Boolean);
      if (ids.length === 1) event.sender.send('track:remove', ids[0]);
      else event.sender.send('tracks:remove', ids);
    }
  });

  // Add 'Add to Playlist' submenu if playlists exist
  try {
    const playlists = db.getAllPlaylists();
    if (playlists && playlists.length) {
      const submenu = playlists.map(p => ({
        label: p.name,
        click: () => {
          const ids = items.map(t => t.id).filter(Boolean);
          for (const tid of ids) {
            try {
              db.addTrackToPlaylist(p.id, tid);
            } catch (err) {
              console.error('[main] addTrackToPlaylist failed', err);
            }
          }
          // Notify renderer that tracks were added
          event.sender.send('playlist:added', { playlistId: p.id, trackIds: ids });
        }
      }));
      // Add a separator and 'New playlist...' action at the end
      submenu.push({ type: 'separator' });
      submenu.push({
        label: 'New playlist...',
        click: () => {
          const ids = items.map(t => t.id).filter(Boolean);
          // Ask renderer to prompt for a name and create+add
          event.sender.send('playlist:create-from-selection', { trackIds: ids });
        }
      });

      template.push({
        label: items.length > 1 ? `Add ${items.length} tracks to Playlist` : 'Add to Playlist',
        submenu
      });
    } else {
      // No playlists yet, provide quick 'New playlist...' option
      template.push({
        label: 'Add to Playlist',
        submenu: [{
          label: 'New playlist...',
          click: () => {
            const ids = items.map(t => t.id).filter(Boolean);
            event.sender.send('playlist:create-from-selection', { trackIds: ids });
          }
        }]
      });
    }
  } catch (err) {
    console.error('[main] Failed to build playlist submenu', err);
  }

  // Allow plugins to add context menu items
  for (const [id, plugin] of loadedPlugins) {
    if (plugin.module && typeof plugin.module.getTrackContextMenuItems === 'function') {
      try {
        const pluginItems = await plugin.module.getTrackContextMenuItems(items, mainWindow);
        if (Array.isArray(pluginItems) && pluginItems.length > 0) {
          template.push({ type: 'separator' });
          template.push(...pluginItems);
        }
      } catch (e) {
        console.error(`[main] Plugin ${id} failed to provide context menu items:`, e);
      }
    }
  }

  const menu = Menu.buildFromTemplate(template);
  menu.popup(BrowserWindow.fromWebContents(event.sender));
});

ipcMain.handle('library:import-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }]
  });

  if (canceled) return;
  await processFileList(filePaths);
});

ipcMain.handle('library:import-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });

  if (canceled) return;
  const folderPath = filePaths[0];
  const files = await getAudioFiles(folderPath);
  await processFileList(files);
});

ipcMain.handle('window:set-fullscreen', (event, flag) => {
  if (mainWindow) {
    mainWindow.setFullScreen(flag);
    mainWindow.setMenuBarVisibility(!flag);
  }
});

// Helper to recursively get all audio files
async function getAudioFiles(dir) {
  let results = [];
  async function scan(d) {
    try {
      const files = await fs.promises.readdir(d, { withFileTypes: true });
      for (const file of files) {
        const res = path.resolve(d, file.name);
        if (file.isDirectory()) {
          await scan(res);
        } else {
          const ext = path.extname(res).toLowerCase();
          if (AUDIO_EXTENSION_SET.has(ext)) {
            try {
              const st = await fs.promises.stat(res).catch(() => null);
              // Skip tiny files (< 1KB) which are likely bogus/placeholder files
              if (st && typeof st.size === 'number' && st.size < 1024) {
                continue;
              }
            } catch (e) {
              // ignore stat errors and include file
            }
            results.push(res);
          }
        }
      }
    } catch (e) {
      console.error('Error scanning directory:', d, e);
    }
  }
  await scan(dir);
  return results;
}

const QUALITY_SCORE_EPSILON = 5000;
const DURATION_FUZZ_SECONDS = 3;

function normalizeForKey(value) {
  if (!value) return '';
  return String(value).trim().toLowerCase();
}

function normalizeAlbumValue(value) {
  const normalized = normalizeForKey(value);
  if (!normalized || normalized === 'unknown album') return '';
  return normalized;
}

function hasUsefulMetadataValue(value) {
  return !isPlaceholderMetadataValue(value);
}

function durationsRoughlyEqual(a, b) {
  const aNum = typeof a === 'number' ? a : Number(a);
  const bNum = typeof b === 'number' ? b : Number(b);
  if (!Number.isFinite(aNum) || aNum <= 0) return false;
  if (!Number.isFinite(bNum) || bNum <= 0) return false;
  return Math.abs(aNum - bNum) <= DURATION_FUZZ_SECONDS;
}

function computeQualityScore(meta = {}) {
  const bitrate = Number(meta.bitrate ?? 0);
  const sampleRate = Number(meta.sampleRate ?? meta.sample_rate ?? 0);
  const bitDepth = Number(meta.bitDepth ?? meta.bit_depth ?? 0);
  const channels = Number(meta.channels ?? 0);
  const isLossless = meta.lossless === true || meta.lossless === 1 || meta.lossless === '1';
  let score = 0;
  if (isLossless) score += 1_000_000_000;
  if (bitrate > 0) score += bitrate;
  if (sampleRate > 0 && bitDepth > 0 && channels > 0) {
    score += sampleRate * bitDepth * channels;
  } else if (sampleRate > 0 && channels > 0) {
    score += sampleRate * channels * 100;
  }
  return Math.round(score);
}

function computeStoredTrackQuality(track) {
  if (!track) return 0;
  if (track.quality_score) return Number(track.quality_score);
  return computeQualityScore(track);
}

function tracksLikelySameSong(incomingTrack, existingTrack) {
  if (!incomingTrack || !existingTrack) return false;
  const albumsMatch = normalizeAlbumValue(incomingTrack.album) === normalizeAlbumValue(existingTrack.album)
    || !normalizeAlbumValue(incomingTrack.album)
    || !normalizeAlbumValue(existingTrack.album);
  return albumsMatch && durationsRoughlyEqual(incomingTrack.duration, existingTrack.duration);
}

function recordsLikelySameSong(a, b) {
  if (!a || !b) return false;
  const sameTitle = normalizeForKey(a.title) === normalizeForKey(b.title);
  const sameArtist = normalizeForKey(a.artist) === normalizeForKey(b.artist);
  if (!sameTitle || !sameArtist) return false;
  const albumsMatch = normalizeAlbumValue(a.album) === normalizeAlbumValue(b.album)
    || !normalizeAlbumValue(a.album)
    || !normalizeAlbumValue(b.album);
  return albumsMatch && durationsRoughlyEqual(a.duration, b.duration);
}

function collectMetadataImprovements(existing, incoming) {
  const updates = {};
  const existingPath = existing.path || incoming.path || '';

  if (hasUsefulMetadataValue(incoming.title) && isWeakTitleForPath(existing.title, existingPath)) {
    updates.title = incoming.title;
  }
  if (hasUsefulMetadataValue(incoming.artist) && isPlaceholderMetadataValue(existing.artist)) {
    updates.artist = incoming.artist;
  }
  if (incoming.cover_path && !existing.cover_path) updates.cover_path = incoming.cover_path;
  if (hasUsefulMetadataValue(incoming.album) && isPlaceholderMetadataValue(existing.album)) updates.album = incoming.album;
  if (hasUsefulMetadataValue(incoming.album_artist) && isPlaceholderMetadataValue(existing.album_artist)) updates.album_artist = incoming.album_artist;
  if (incoming.duration && (!existing.duration || existing.duration <= 0)) updates.duration = incoming.duration;
  if (incoming.format && (!existing.format || existing.format === 'remote')) updates.format = incoming.format;
  if (incoming.bitrate && !existing.bitrate) updates.bitrate = incoming.bitrate;
  if (incoming.sample_rate && !existing.sample_rate) updates.sample_rate = incoming.sample_rate;
  if (incoming.bit_depth && !existing.bit_depth) updates.bit_depth = incoming.bit_depth;
  if (incoming.channels && !existing.channels) updates.channels = incoming.channels;
  if (incoming.lossless !== null && incoming.lossless !== undefined && (existing.lossless === null || existing.lossless === undefined)) {
    updates.lossless = incoming.lossless;
  }
  if (incoming.codec && !existing.codec) updates.codec = incoming.codec;
  const incomingQuality = incoming.quality_score ?? computeQualityScore(incoming);
  const existingQuality = existing.quality_score ?? computeQualityScore(existing);
  if (incomingQuality && (!existingQuality || incomingQuality > existingQuality)) {
    updates.quality_score = incomingQuality;
  }
  return updates;
}

function repairExistingLibraryMetadataFromPaths() {
  try {
    const tracks = db.getAllTracks();
    let repaired = 0;
    for (const track of tracks) {
      if (!track?.id || !track.path || String(track.path).startsWith('http')) continue;
      const inferred = inferMetadataFromPath(track.path);
      const candidate = {
        ...track,
        title: inferred.title || track.title,
        artist: inferred.artist || track.artist,
        album: inferred.album || track.album,
        album_artist: inferred.albumArtist || track.album_artist,
      };
      const updates = collectMetadataImprovements(track, candidate);
      if (Object.keys(updates).length === 0) continue;
      db.updateTrackFields(track.id, updates);
      repaired++;
    }
    if (repaired > 0) {
      console.log(`[main] Repaired filename metadata for ${repaired} track(s).`);
    }
  } catch (err) {
    console.warn('[main] Unable to repair filename metadata', err);
  }
}
function dedupeLibrary() {
  if (libraryDeduped) return;
  libraryDeduped = true;
  try {
    const tracks = db.getAllTracks();
    const groups = new Map();
    for (const track of tracks) {
      const titleKey = normalizeForKey(track.title);
      const artistKey = normalizeForKey(track.artist);
      if (!titleKey || !artistKey) continue;
      const albumKey = normalizeAlbumValue(track.album);
      const key = `${artistKey}::${albumKey}::${titleKey}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(track);
    }
    let removed = 0;
    for (const group of groups.values()) {
      if (!group || group.length < 2) continue;
      group.sort((a, b) => computeStoredTrackQuality(b) - computeStoredTrackQuality(a));
      const keeper = group[0];
      let aggregatedUpdates = {};
      for (let i = 1; i < group.length; i++) {
        const candidate = group[i];
        if (!recordsLikelySameSong(keeper, candidate)) continue;
        const upgrades = collectMetadataImprovements(keeper, candidate);
        if (Object.keys(upgrades).length > 0) {
          aggregatedUpdates = { ...aggregatedUpdates, ...upgrades };
          Object.assign(keeper, upgrades);
        }
        db.removeTrack(candidate.id);
        removed++;
      }
      if (Object.keys(aggregatedUpdates).length > 0) {
        db.updateTrackFields(keeper.id, aggregatedUpdates);
      }
    }
    if (removed > 0) {
      console.log(`[main] Deduped ${removed} duplicate track(s) on startup.`);
    }
  } catch (err) {
    console.warn('[main] Unable to dedupe library', err);
  }
}

function storeTrackWithDedup(track) {
  if (!track) return null;
  const normalizedTitle = normalizeForKey(track.title);
  const normalizedArtist = normalizeForKey(track.artist);
  const newScore = track.quality_score ?? computeQualityScore(track);
  track.quality_score = newScore;

  const duplicates = normalizedTitle && normalizedArtist
    ? (db.findTracksByTitleArtist(track.title, track.artist) || [])
    : [];

  const comparable = duplicates.filter(existing => tracksLikelySameSong(track, existing));

  if (comparable.length > 0) {
    const scoredExisting = comparable
      .map(candidate => ({ record: candidate, score: computeStoredTrackQuality(candidate) }))
      .sort((a, b) => b.score - a.score);

    const keeper = scoredExisting[0];
    const keeperId = keeper.record.id;
    const keeperScore = keeper.score;

    if (newScore > keeperScore + QUALITY_SCORE_EPSILON) {
      db.updateTrackFields(keeperId, track);
      for (const { record } of scoredExisting.slice(1)) {
        if (record.id !== keeperId) db.removeTrack(record.id);
      }
      console.log(`[main] Upgraded duplicate track with higher quality: ${track.title}`);
      return db.getTrackById(keeperId);
    }

    const metadataUpdates = collectMetadataImprovements(keeper.record, track);
    if (Object.keys(metadataUpdates).length > 0) {
      db.updateTrackFields(keeperId, metadataUpdates);
      Object.assign(keeper.record, metadataUpdates);
    }

    for (const { record } of scoredExisting.slice(1)) {
      if (record.id !== keeperId) db.removeTrack(record.id);
    }

    return db.getTrackById(keeperId);
  }

  const inserted = db.addTrack(track);
  if (inserted?.id) {
    console.log(`[main] Added track: ${track.title}, cover: ${track.cover_path}`);
  }
  return inserted;
}

// Helper to process a list of files with progress
async function processFileList(files) {
  const total = files.length;
  if (total === 0) return;

  console.log('[main] processFileList: starting import of', total, 'files');
  broadcast('import:start', { total });

  // Mark bulk import in progress so other subsystems can avoid noisy actions
  // (e.g. avoid triggering playback restarts while we're scanning files).
  try {
    global.__spectra_bulk_import = true;
  } catch {}

  let failed = 0;
  try {
    for (let i = 0; i < total; i++) {
      try {
        await processAndAddTrack(files[i]);
      } catch (err) {
        failed++;
        console.warn('[main] import skipped unreadable file:', files[i], err?.message ?? err);
      }
      broadcast('import:progress', {
        current: i + 1,
        total,
        filename: path.basename(files[i])
      });
      // Yield so audio pumping and IPC stay responsive during big imports.
      if (i % 8 === 7) await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    try { global.__spectra_bulk_import = false; } catch {}
    broadcast('import:complete', { total, failed });
    console.log(`[main] processFileList: import complete (${total - failed}/${total} added)`);
  }
}

async function processAndAddTrack(filePath) {
  const existing = db.getTrackByPath(filePath);

  try {
    const meta = await extractMetadata(filePath);

    const track = {
      path: filePath,
      title: meta.title || path.basename(filePath, path.extname(filePath)),
      artist: meta.artist || 'Unknown Artist',
      album: meta.album || 'Unknown Album',
      album_artist: meta.albumArtist || null,
      duration: meta.duration || 0,
      format: meta.format || path.extname(filePath).slice(1),
      cover_path: meta.coverPath || null,
      bitrate: meta.bitrate ?? null,
      sample_rate: meta.sampleRate ?? null,
      bit_depth: meta.bitDepth ?? null,
      channels: meta.channels ?? null,
      lossless: meta.lossless ?? null,
      codec: meta.codec ?? null,
      quality_score: computeQualityScore(meta),
    };

    // Normalize album artist from DB if available
    if (track.album) {
      const normalizedAlbumArtist = db.getAlbumArtist(track.album, track.artist);
      if (normalizedAlbumArtist) {
        track.album_artist = normalizedAlbumArtist;
      }
    }

    // If no cover yet, try existing DB cover for this album/artist
    if (!track.cover_path) {
      const existingCover = db.getAlbumCover(track.album, track.album_artist || track.artist);
      if (existingCover) {
        track.cover_path = existingCover;
        console.log(`[main] Reusing existing cover for album "${track.album}": ${existingCover}`);
      }
    }

    if (existing) {
      const metadataUpdates = collectMetadataImprovements(existing, track);
      if (Object.keys(metadataUpdates).length > 0) {
        db.updateTrackFields(existing.id, metadataUpdates);
        return db.getTrackById(existing.id) || { ...existing, ...metadataUpdates };
      }
      return existing;
    }

    const stored = storeTrackWithDedup(track);
    return stored;
  } catch (e) {
    if (existing) return existing;
    console.error('Failed to process track', filePath, e);
    throw e;
  }
}
async function handleAddFiles(filePaths = []) {
  if (!Array.isArray(filePaths)) {
    return { success: false, error: 'filePaths must be an array' };
  }

  let allFiles = [];
  for (const filePath of filePaths) {
    if (!filePath) continue;
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) continue;

    if (stat.isDirectory()) {
      const dirFiles = await getAudioFiles(filePath);
      allFiles = allFiles.concat(dirFiles);
    } else if (isAudioPath(filePath)) {
      // Ignore tiny files (<1KB) which are likely fake/placeholder
      try {
        const s = stat && stat.size ? stat.size : (await fs.promises.stat(filePath).catch(() => ({ size: 0 }))).size;
        if (typeof s === 'number' && s < 1024) {
          continue;
        }
      } catch (e) {
        // if stat fails, fall back to including the file
      }
      allFiles.push(filePath);
    }
  }

  if (!allFiles.length) {
    return { success: true, count: 0 };
  }

  await processFileList(allFiles);
  return { success: true, count: allFiles.length };
}

function titleFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    return name.replace(/\.[a-z0-9]{2,5}$/i, '') || url;
  } catch {
    return path.basename(String(url));
  }
}

async function handleAddRemote(remoteInfo = {}) {
  try {
    const {
      url,
      title: providedTitle,
      artist: providedArtist,
      album: providedAlbum,
      duration: providedDuration,
      coverUrl,
      sampleRate, bitDepth, channels, format,
      skipProbe = false,
    } = remoteInfo || {};
    if (!url || typeof url !== 'string') {
      return { success: false, error: 'missing url' };
    }

    // Already in the library: fill in anything new and return it.
    const already = db.getTrackByPath(url);

    let track = {
      path: url,
      title: providedTitle || titleFromUrl(url),
      artist: providedArtist || 'Unknown Artist',
      album: providedAlbum || 'Unknown Album',
      album_artist: null,
      duration: Number(providedDuration) > 0 ? Number(providedDuration) : 0,
      format: format || 'remote',
      cover_path: coverUrl && isRemoteUrl(coverUrl) ? coverUrl : null,
      bitrate: null,
      sample_rate: Number(sampleRate) || null,
      bit_depth: Number(bitDepth) || null,
      channels: Number(channels) || null,
      lossless: null,
      codec: null,
      quality_score: null,
    };

    // The source already described the track well enough (UPnP browse results):
    // skip the network probe so adding a whole folder stays fast.
    const haveEnough = providedTitle && providedArtist && track.duration > 0;
    if (!skipProbe && !haveEnough) {
      try {
        const fetchUrl = await resolveTrackPath(url);
        let meta = null;

        if (fetchUrl !== url && !isRemoteUrl(fetchUrl)) {
          meta = await extractMetadata(fetchUrl).catch(() => null);
        } else {
          const MAX_BYTES = 2 * 1024 * 1024;
          const headers = { Range: `bytes=0-${MAX_BYTES - 1}`, ...getPluginRequestHeaders(url) };
          // Credentials travel in the Authorization header, never in the URL.
          let cleanUrl = url;
          try { const u = new URL(url); u.username = ''; u.password = ''; cleanUrl = u.href; } catch {}
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          try {
            const res = await fetch(cleanUrl, { method: 'GET', headers, redirect: 'follow', signal: controller.signal });
            if (res && (res.status === 206 || res.status === 200)) {
              // Servers that ignore Range would send the whole file: read only the head.
              const reader = res.body?.getReader?.();
              const chunks = [];
              let received = 0;
              if (reader) {
                while (received < MAX_BYTES) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  chunks.push(Buffer.from(value));
                  received += value.length;
                }
                try { await reader.cancel(); } catch {}
              }
              const buf = Buffer.concat(chunks);
              if (buf.length) meta = await extractMetadataFromBuffer(buf, url).catch(() => null);
            } else if (res && (res.status === 401 || res.status === 403)) {
              console.warn('[main] remote metadata fetch unauthorized for', cleanUrl);
            }
          } catch (fetchErr) {
            console.warn('[main] remote metadata fetch failed:', fetchErr?.message ?? fetchErr);
          } finally {
            clearTimeout(timer);
          }
        }

        if (meta) {
          track.title = providedTitle || meta.title || track.title;
          track.artist = providedArtist || meta.artist || track.artist;
          track.album = providedAlbum || meta.album || track.album;
          track.album_artist = meta.albumArtist || null;
          track.duration = track.duration || meta.duration || 0;
          track.format = meta.format || track.format;
          if (meta.coverPath) track.cover_path = meta.coverPath;
          track.bitrate = meta.bitrate ?? track.bitrate;
          track.sample_rate = meta.sampleRate ?? track.sample_rate;
          track.bit_depth = meta.bitDepth ?? track.bit_depth;
          track.channels = meta.channels ?? track.channels;
          track.lossless = meta.lossless ?? track.lossless;
          track.codec = meta.codec ?? track.codec;
        }
      } catch (inner) {
        console.warn('[main] remote metadata fetch failed', inner);
      }
    }

    track.quality_score = track.quality_score ?? computeQualityScore(track);

    if (already) {
      const updates = collectMetadataImprovements(already, track);
      if (Object.keys(updates).length) db.updateTrackFields(already.id, updates);
      const refreshed = db.getTrackById(already.id) || already;
      return { success: true, id: refreshed.id, track: refreshed, existed: true };
    }

    const stored = storeTrackWithDedup(track);
    if (!stored) {
      return { success: false, error: 'failed to store track' };
    }

    return { success: true, id: stored.id, track: stored };
  } catch (err) {
    console.error('[main] library:add-remote failed', err);
    return { success: false, error: String(err?.message || err) };
  }
}

// Add many remote tracks (a UPnP/WebDAV folder) with the same progress events
// as a local import. Returns the stored track ids in input order.
async function handleAddRemoteMany(list = []) {
  const items = Array.isArray(list) ? list.filter((it) => it && it.url) : [];
  const ids = [];
  let failed = 0;
  if (!items.length) return { success: true, count: 0, ids, failed };
  broadcast('import:start', { total: items.length });
  try {
    for (let i = 0; i < items.length; i++) {
      const res = await handleAddRemote(items[i]);
      if (res?.success) ids.push(res.id); else failed++;
      broadcast('import:progress', { current: i + 1, total: items.length, filename: items[i].title || titleFromUrl(items[i].url) });
    }
  } finally {
    broadcast('import:complete', { total: items.length, failed });
  }
  return { success: true, count: ids.length, ids, failed };
}

// Plugin loading system
function pluginNeedsInstall(pluginDir) {
  const packageJsonPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return false;
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const dependencies = Object.keys(packageJson.dependencies || {});
    if (!dependencies.length) return false;
    const nodeModulesPath = path.join(pluginDir, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) return true;
    return dependencies.some((dep) => !fs.existsSync(path.join(nodeModulesPath, dep)));
  } catch (e) {
    console.error(`[plugins] Error checking dependencies in ${pluginDir}:`, e);
    return false;
  }
}

async function installPluginDependencies(pluginDir, pluginId) {
  console.log(`[plugins] Installing dependencies for ${pluginId}...`);
  const { spawn } = await import('child_process');
  await new Promise((resolve) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    let installProcess;
    try {
      installProcess = spawn(npmCmd, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: pluginDir,
        stdio: 'inherit',
        shell: true
      });
    } catch (err) {
      console.error(`[plugins] Error installing dependencies for ${pluginId}:`, err);
      return done();
    }
    // A hung npm must not keep the plugin (or the others) from ever loading.
    const timer = setTimeout(() => {
      console.error(`[plugins] npm install for ${pluginId} timed out`);
      try { installProcess.kill(); } catch {}
      done();
    }, 180000);
    installProcess.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) console.log(`[plugins] Dependencies installed for ${pluginId}`);
      else console.error(`[plugins] Failed to install dependencies for ${pluginId} (exit code: ${code})`);
      done();
    });
    installProcess.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[plugins] Error installing dependencies for ${pluginId}:`, err);
      done();
    });
  });
}

// One context factory for every way a plugin gets activated (startup, reload,
// enable toggle), so all of them get the full API.
function createPluginContext(pluginId, settings) {
  const channels = new Set();
  const context = {
    settings,
    on: (event, handler) => {
      const list = pluginEventHandlers.get(event);
      if (list) list.push(handler);
      else pluginEventHandlers.set(event, [handler]);
    },
    registerRemoteHandler: (channel, handler) => {
      handlers[channel] = handler;
      channels.add(channel);
      // Re-registration (plugin reload / re-enable) must replace, not throw.
      try { ipcMain.removeHandler(channel); } catch {}
      ipcMain.handle(channel, (event, ...args) => handler(...args));
    },
    broadcast: (channel, ...args) => {
      try {
        broadcast(channel, ...args);
      } catch (err) {
        console.warn(`[plugins] broadcast failed for ${channel}`, err);
      }
    },
    // Persist plugin-owned settings (e.g. NAS shares) across restarts.
    saveSettings: (nextSettings) => {
      const cfg = loadPluginConfig();
      const value = nextSettings && typeof nextSettings === 'object' ? nextSettings : context.settings;
      cfg[pluginId] = { ...(cfg[pluginId] || {}), settings: value };
      savePluginConfig(cfg);
      context.settings = value;
      return value;
    },
  };
  return { context, channels };
}

function deactivatePlugin(id) {
  const loaded = loadedPlugins.get(id);
  if (!loaded) return;
  try {
    if (loaded.module.deactivate) {
      console.log(`[plugins] Deactivating plugin: ${id}`);
      loaded.module.deactivate();
    }
  } catch (e) {
    console.error(`[plugins] Error deactivating plugin ${id}:`, e);
  }
  for (const channel of loaded.channels || []) {
    try { ipcMain.removeHandler(channel); } catch {}
    delete handlers[channel];
  }
  loadedPlugins.delete(id);
}

// Load + activate one plugin directory. Returns true when it is active.
async function loadPluginFromDir(pluginDir, cfg, { bustCache = false } = {}) {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return false;
  let pluginId = path.basename(pluginDir);
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    pluginId = manifest.id || pluginId;

    // Skip if already loaded from a different location
    if (loadedPlugins.has(pluginId)) return true;

    if (cfg[pluginId]?.enabled === false) {
      console.log(`[plugins] Skipping disabled plugin: ${pluginId}`);
      return false;
    }

    const pluginMainPath = path.join(pluginDir, manifest.main || 'plugin.js');
    if (!fs.existsSync(pluginMainPath)) {
      console.error(`[plugins] Plugin main file not found: ${pluginMainPath}`);
      return false;
    }

    // Import the plugin (ESM). A query string forces a fresh module on reload.
    const pluginUrl = pathToFileURL(pluginMainPath);
    if (bustCache) pluginUrl.searchParams.set('v', String(Date.now()));
    const pluginModule = await import(pluginUrl.href);

    if (!pluginModule.activate) {
      console.error(`[plugins] Plugin ${pluginId} missing activate function`);
      return false;
    }

    const savedSettings = cfg[pluginId]?.settings || manifest.settings || {};
    const { context, channels } = createPluginContext(pluginId, savedSettings);

    console.log(`[plugins] Activating plugin: ${pluginId}`);
    await pluginModule.activate(context);

    loadedPlugins.set(pluginId, { id: pluginId, module: pluginModule, manifest, context, channels });
    console.log(`[plugins] OK Loaded plugin: ${pluginId}`);
    return true;
  } catch (e) {
    console.error(`[plugins] Failed to load plugin ${pluginId}:`, e);
    return false;
  }
}

let pluginsLoadedOnce = false;

async function loadPlugins() {
  console.log('[plugins] Loading plugins...');
  const cfg = loadPluginConfig();
  const bustCache = pluginsLoadedOnce;
  pluginsLoadedOnce = true;

  // Check both user data plugins and repo plugins (prefer user plugins)
  const ready = [];
  const needInstall = [];
  for (const searchDir of [pluginsDir, repoPluginsDir]) {
    if (!fs.existsSync(searchDir)) continue;
    for (const d of fs.readdirSync(searchDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const pluginDir = path.join(searchDir, d.name);
      if (!fs.existsSync(path.join(pluginDir, 'manifest.json'))) continue;
      (pluginNeedsInstall(pluginDir) ? needInstall : ready).push(pluginDir);
    }
  }

  // Plugins without pending installs come up immediately...
  for (const pluginDir of ready) await loadPluginFromDir(pluginDir, cfg, { bustCache });
  console.log(`[plugins] Loaded ${loadedPlugins.size} plugin(s)`);

  // ...the rest install in the background instead of holding everything
  // (network browsing, UPnP) hostage to a slow `npm install`.
  if (needInstall.length) {
    (async () => {
      for (const pluginDir of needInstall) {
        const id = path.basename(pluginDir);
        if (cfg[id]?.enabled === false) continue;
        await installPluginDependencies(pluginDir, id);
        if (await loadPluginFromDir(pluginDir, cfg, { bustCache })) {
          try { mainWindow?.webContents?.send('plugins:reloaded'); } catch {}
        }
      }
    })().catch((e) => console.error('[plugins] background plugin install failed', e));
  }
}

// Plugin event system
const pluginEventHandlers = new Map();

function emitPluginEvent(eventName, data) {
  const handlers = pluginEventHandlers.get(eventName);
  if (!handlers || handlers.length === 0) return;

  for (const handler of handlers) {
    try {
      handler(data);
    } catch (e) {
      console.error(`[plugins] Error in ${eventName} handler:`, e);
    }
  }
}


