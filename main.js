
import { app, BrowserWindow, ipcMain, dialog, Menu, protocol, globalShortcut, Tray, nativeImage, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import audioEngine from './audioEngine.js';
import initSqlJs from 'sql.js';
import { extractMetadata, extractMetadataFromBuffer } from './metadataLookup.js';
import { extractLyrics } from './metadataLookup.js';
import db from './database.js';
import RemoteServer from './remoteServer.js';

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
// Pending files opened before app is ready
const pendingOpenFiles = [];

// Playback queue and modes
let playbackQueue = [];
let queueIndex = -1;
let shuffleMode = false;
let repeatMode = 'off'; // 'off', 'all', 'one'
let originalQueue = []; // For when shuffle is toggled off

// Equalizer state
let eqEnabled = false;
let eqPreset = 'flat';
let eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 10-band EQ

// Ensure single instance and handle files passed to second instance (Windows)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
app.on('second-instance', (event, argv) => {
  // argv may include file paths when a user double-clicks an associated file
  try {
    const files = parseArgvFiles(argv || []);
    for (const f of files) {
      // if mainWindow ready, handle immediately; otherwise queue
      if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
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

// Utility: detect if an argument refers to a local audio file path
function isAudioPath(p) {
  if (!p) return false;
  try {
    // Accept file:// URLs too
    if (p.startsWith('file://')) return true;
    const ext = path.extname(p || '').toLowerCase();
    return ['.flac', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.dsf', '.dff', '.ape', '.aiff', '.caf'].includes(ext);
  } catch {
    return false;
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
      await handlers['library:add-remote'](null, { url: filePath }).catch(() => null);
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
                { name: 'Audio Files', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma'] }
              ]
            });
            if (!result.canceled && result.filePaths.length > 0) {
              for (const filePath of result.filePaths) {
                await handleOpenFile(filePath);
              }
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
              mainWindow?.webContents.send('library:import-folder', result.filePaths[0]);
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
        {
          label: 'Play/Pause',
          accelerator: 'Space',
          click: () => {
            const status = audioEngine.getStatus();
            if (status.playing && !status.paused) {
              handlers['audio:pause']();
            } else {
              handlers['audio:resume']();
            }
          }
        },
        {
          label: 'Next Track',
          accelerator: 'CmdOrCtrl+Right',
          click: () => handlers['queue:next']()
        },
        {
          label: 'Previous Track',
          accelerator: 'CmdOrCtrl+Left',
          click: () => handlers['queue:previous']()
        },
        { type: 'separator' },
        {
          label: 'Volume Up',
          accelerator: 'CmdOrCtrl+Up',
          click: () => {
            const status = audioEngine.getStatus();
            const newVolume = Math.min(1, (status.volume || 0.5) + 0.1);
            handlers['audio:set-volume'](newVolume);
          }
        },
        {
          label: 'Volume Down',
          accelerator: 'CmdOrCtrl+Down',
          click: () => {
            const status = audioEngine.getStatus();
            const newVolume = Math.max(0, (status.volume || 0.5) - 0.1);
            handlers['audio:set-volume'](newVolume);
          }
        }
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
      webSecurity: false // Allow loading local resources (cover art)
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
  return filePath;
}

// Shared handlers for IPC and Remote Server
const handlers = {
  'library:get': () => db.getAllTracks(),
  'library:remove-track': (id) => db.removeTrack(id),
  'library:delete-album': (albumName, artistName) => db.deleteAlbum(albumName, artistName),
  'library:update-track': (id, data) => db.updateTrack(id, data),
  'library:get-albums': () => db.getAlbums(),
  'library:get-artists': () => db.getArtists(),
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

    // Allow renderer to relink a track whose file has moved
    'track:relink': async (event, info) => {
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
          { name: 'Audio Files', extensions: ['flac','wav','mp3','m4a','aac','ogg','opus','dsf','dff'] },
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

        // Try to play again with updated path
        await audioEngine.playFile(newPath, () => {
          broadcast('audio:ended');
          broadcastState();
        }, (err) => {
          console.error('Playback error after relink:', err);
          broadcast('audio:error', {
            message: String(err?.message || err),
            filePath: newPath,
            track: currentTrackMetadata
          });
          broadcastState();
        }, { ...currentPlaybackOptions, track: currentTrackMetadata });

        return { ok: true, newPath };
      } catch (e) {
        console.error('Failed to relink and play track', e);
        return { ok: false, error: String(e?.message || e) };
      }
    },
  'audio:play': async (filePath, options = {}) => {
    try {
      // If a bulk import is running and we are already playing, avoid reopening the exclusive stream (prevents hiss/static during imports)
      try {
        if (global.__spectra_bulk_import) {
          const status = audioEngine.getStatus();
          if (status && status.playing) {
            console.log('[main] audio:play suppressed during bulk import while already playing');
            return;
          }
        }
      } catch {}

      const playPath = await resolveTrackPath(filePath);

      // Guard against missing media (e.g., USB drive unplugged) to avoid “background” silent playback attempts
      // Skip file existence check for remote URLs (presigned URLs from object storage)
      const isRemoteUrl = playPath.startsWith('http://') || playPath.startsWith('https://');
      try {
        if (!isRemoteUrl && !fs.existsSync(playPath)) {
          const err = `File not found: ${playPath}`;
          console.warn('[main] audio:play aborted:', err);
          broadcast('audio:error', { message: err, filePath: playPath, track: currentTrackMetadata });
          return;
        }
      } catch {}

      if (options.volume !== undefined) {
        options.volume = Number(options.volume);
      }
      
      // Store track metadata if provided
      if (options.track) {
        currentTrackMetadata = options.track;
      } else {
        // Try to find it in DB or just use path
        const track = db.getTrackByPath(filePath);
        currentTrackMetadata = track || { path: filePath, title: path.basename(filePath) };
      }

      await audioEngine.playFile(playPath, () => {
        emitPluginEvent('track-stopped', currentTrackMetadata);
        broadcast('audio:ended');
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
      }, options);
      
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
    appSettings.eq = audioEngine.getEQ();
    saveAppSettings();
  },
  'audio:set-eq-preset': (preset) => {
    const eq = audioEngine.getEQ();
    let bands = [...eq.bands];
    if (preset === 'flat') bands = [0,0,0,0,0,0,0,0,0,0];
    else if (preset === 'bass') bands = [6,5,4,2,0,0,0,0,0,0];
    else if (preset === 'treble') bands = [0,0,0,0,0,0,2,4,5,6];
    else if (preset === 'vocal') bands = [-2,-2,-1,0,4,4,2,0,-1,-2];
    
    audioEngine.setEQ({ ...eq, preset, bands });
    appSettings.eq = audioEngine.getEQ();
    saveAppSettings();
  },
  'audio:set-eq-bands': (bands) => {
    const eq = audioEngine.getEQ();
    audioEngine.setEQ({ ...eq, bands, preset: 'custom' });
    appSettings.eq = audioEngine.getEQ();
    saveAppSettings();
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
        filters: [{ name: 'Spectra Playlist', extensions: ['playlist'] }, { name: 'All Files', extensions: ['*'] }]
      });
      if (canceled || !filePath) return { success: false, canceled: true };

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
        filters: [{ name: 'Spectra Playlist', extensions: ['playlist'] }, { name: 'All Files', extensions: ['*'] }]
      });
      if (canceled || !filePaths || !filePaths.length) return { success: false, canceled: true };
      const impPath = filePaths[0];

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
  'queue:set': (tracks) => {
    playbackQueue = Array.isArray(tracks) ? tracks : [];
    queueIndex = playbackQueue.length > 0 ? 0 : -1;
    originalQueue = [...playbackQueue];
    return { queue: playbackQueue, index: queueIndex };
  },
  'queue:add': (track) => {
    playbackQueue.push(track);
    if (queueIndex === -1) queueIndex = 0;
    return { queue: playbackQueue, index: queueIndex };
  },
  'queue:remove': (index) => {
    if (index >= 0 && index < playbackQueue.length) {
      playbackQueue.splice(index, 1);
      if (queueIndex >= index && queueIndex > 0) queueIndex--;
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
    if (repeatMode === 'one') return playbackQueue[queueIndex];
    queueIndex++;
    if (queueIndex >= playbackQueue.length) {
      if (repeatMode === 'all') queueIndex = 0;
      else return null;
    }
    return playbackQueue[queueIndex];
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
  'eq:get': () => ({ enabled: eqEnabled, preset: eqPreset, bands: eqBands }),
  'eq:set-enabled': (enabled) => {
    eqEnabled = !!enabled;
    return { enabled: eqEnabled, preset: eqPreset, bands: eqBands };
  },
  'eq:set-preset': (preset) => {
    const presets = {
      flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      rock: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
      pop: [2, 3, 4, 3, 0, -1, -1, 0, 2, 3],
      jazz: [3, 2, 1, 1, -1, -1, 0, 1, 2, 3],
      classical: [4, 3, 2, 0, -1, -1, 0, 2, 3, 4],
      bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
      treble: [0, 0, 0, 0, 0, 2, 4, 5, 6, 6],
      vocal: [0, 1, 3, 4, 3, 1, 0, 0, 0, 0]
    };
    if (presets[preset]) {
      eqPreset = preset;
      eqBands = presets[preset];
    }
    return { enabled: eqEnabled, preset: eqPreset, bands: eqBands };
  },
  'eq:set-bands': (bands) => {
    if (Array.isArray(bands) && bands.length === 10) {
      eqBands = bands.map(v => Math.max(-12, Math.min(12, Number(v) || 0)));
      eqPreset = 'custom';
    }
    return { enabled: eqEnabled, preset: eqPreset, bands: eqBands };
  },
  'player:get-state': () => getPlayerState(),
  'lyrics:get': async (opts = {}) => {
    const { filePath, external = false, artist, title } = opts || {};
    if (filePath) {
      try {
        const embedded = await extractLyrics(filePath);
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
  'remote:toggle': (enable) => {
    if (!remoteServer) {
      console.warn('[main] remote:toggle invoked but remote server is unavailable');
      return false;
    }
    if (enable) {
      remoteServer.start(remoteServerPort, remoteServerHost);
    } else {
      remoteServer.stop();
    }
    return remoteServer.isRunning;
  },
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

    // If plugin is currently loaded and is being disabled, deactivate it now
    try {
      const isEnabled = !!enabled;
      const loaded = loadedPlugins.get(id);
      if (!isEnabled && loaded) {
        try {
          if (loaded.module.deactivate) {
            console.log(`[plugins] Deactivating plugin due to disable request: ${id}`);
            loaded.module.deactivate();
          }
        } catch (e) { console.error(`[plugins] Error deactivating plugin ${id}:`, e); }
        loadedPlugins.delete(id);
      }

      // If plugin is being enabled and not yet loaded, attempt to load and activate it
      if (isEnabled && !loaded) {
        // Try to locate plugin folder in user plugins then repo plugins
        const tryDirs = [pluginsDir, repoPluginsDir];
        for (const base of tryDirs) {
          const candidate = path.join(base, id);
          const manifestPath = path.join(candidate, 'manifest.json');
          if (!fs.existsSync(manifestPath)) continue;
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const pluginMainPath = path.join(candidate, manifest.main || 'plugin.js');
            if (!fs.existsSync(pluginMainPath)) continue;
            const pluginUrl = new URL(`file:///${pluginMainPath.replace(/\\/g, '/')}`);
            const pluginModule = await import(pluginUrl.href);
            if (pluginModule.activate) {
              const savedSettings = cfg[id]?.settings || manifest.settings || {};
              const context = { settings: savedSettings, on: (event, handler) => {
                const handlers = pluginEventHandlers.get(event);
                if (handlers) handlers.push(handler); else pluginEventHandlers.set(event, [handler]);
              } };
              console.log(`[plugins] Activating plugin due to enable request: ${id}`);
              pluginModule.activate(context);
              loadedPlugins.set(id, { id, module: pluginModule, manifest, context });
            }
            break; // stop after first successful load
          } catch (e) {
            console.error(`[plugins] Failed to load enabled plugin ${id} from ${candidate}:`, e);
            continue;
          }
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

    // Deactivate all plugins
    for (const [id, plugin] of loadedPlugins) {
      try {
        if (plugin.module.deactivate) {
          console.log(`[plugins] Deactivating plugin: ${id}`);
          plugin.module.deactivate();
        }
      } catch (e) { console.warn('error waiting for renderer ack', e); resolve(); }
    }
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
      click: async () => {
        try {
          const status = await audioEngine.getStatus();
          if (status.playing && status.paused) {
            await audioEngine.resume();
          } else if (status.playing) {
            await audioEngine.pause();
          }
        } catch (err) {
          console.error('Tray play/pause error:', err);
        }
      }
    },
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

    remoteServer.start(remoteServerPort, remoteServerHost);
  } else {
    console.log('[main] Remote server disabled via CLI/env flag.');
  }
  
  // Load plugins after app is ready
  await loadPlugins();

  // Register global keyboard shortcuts
  const registerShortcuts = () => {
    globalShortcut.register('MediaPlayPause', () => {
      const status = audioEngine.getStatus();
      if (status.playing && !status.paused) {
        handlers['audio:pause']();
      } else {
        handlers['audio:resume']();
      }
    });
    globalShortcut.register('MediaNextTrack', () => {
      const nextTrack = handlers['queue:next']();
      if (nextTrack) handlers['audio:play'](nextTrack.path, { track: nextTrack });
    });
    globalShortcut.register('MediaPreviousTrack', () => {
      const prevTrack = handlers['queue:previous']();
      if (prevTrack) handlers['audio:play'](prevTrack.path, { track: prevTrack });
    });
    globalShortcut.register('MediaStop', () => {
      handlers['audio:stop']();
    });
    
    // Custom shortcuts
    globalShortcut.register('CommandOrControl+Shift+P', () => {
      const status = audioEngine.getStatus();
      if (status.playing && !status.paused) {
        handlers['audio:pause']();
      } else {
        handlers['audio:resume']();
      }
    });
    globalShortcut.register('CommandOrControl+Right', () => {
      const nextTrack = handlers['queue:next']();
      if (nextTrack) handlers['audio:play'](nextTrack.path, { track: nextTrack });
    });
    globalShortcut.register('CommandOrControl+Left', () => {
      const prevTrack = handlers['queue:previous']();
      if (prevTrack) handlers['audio:play'](prevTrack.path, { track: prevTrack });
    });
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
  for (const [id, plugin] of loadedPlugins) {
    try {
      if (plugin.module.deactivate) {
        console.log(`[plugins] Deactivating plugin: ${id}`);
        plugin.module.deactivate();
      }
    } catch (e) {
      console.error(`[plugins] Error deactivating plugin ${id}:`, e);
    }
  }
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
  if (items.length === 1) {
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
    filters: [{ name: 'Audio', extensions: ['flac', 'wav', 'mp3', 'aac', 'ogg', 'm4a', 'alac', 'wma','dsf','dff', 'ape', 'dsd', 'aiff', 'caf'] }]
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
          if (['.flac', '.wav', '.mp3', '.aac', '.ogg', '.m4a'].includes(ext)) {
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
  if (incoming.cover_path && !existing.cover_path) updates.cover_path = incoming.cover_path;
  if (incoming.album && incoming.album !== 'Unknown Album' && (!existing.album || existing.album === 'Unknown Album')) updates.album = incoming.album;
  if (incoming.album_artist && (!existing.album_artist || existing.album_artist === 'Unknown Artist')) updates.album_artist = incoming.album_artist;
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

  for (let i = 0; i < total; i++) {
    await processAndAddTrack(files[i]);
    broadcast('import:progress', { 
      current: i + 1, 
      total, 
      filename: path.basename(files[i]) 
    });
  }

  broadcast('import:complete');
  console.log('[main] processFileList: import complete');

  try {
    global.__spectra_bulk_import = false;
  } catch {}
}

async function processAndAddTrack(filePath) {
  // Skip if already in DB
  const existing = db.getTrackByPath(filePath);
  if (existing) return existing;

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

    const stored = storeTrackWithDedup(track);
    return stored;
  } catch (e) {
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

async function handleAddRemote(remoteInfo = {}) {
  try {
    const { url, title: providedTitle, artist: providedArtist, album: providedAlbum, duration: providedDuration } = remoteInfo || {};
    if (!url) {
      return { success: false, error: 'missing url' };
    }

    let track = {
      path: url,
      title: providedTitle || path.basename(url),
      artist: providedArtist || 'Remote',
      album: providedAlbum || '',
      album_artist: null,
      duration: providedDuration || 0,
      format: 'remote',
      cover_path: null,
      bitrate: null,
      sample_rate: null,
      bit_depth: null,
      channels: null,
      lossless: null,
      codec: null,
      quality_score: null,
    };

    try {
      const fetchUrl = await resolveTrackPath(url);
      let meta = null;

      if (fetchUrl !== url && !fetchUrl.startsWith('http')) {
        meta = await extractMetadata(fetchUrl).catch(() => null);
      } else {
        const MAX_BYTES = 2 * 1024 * 1024;
        const headers = { Range: `bytes=0-${MAX_BYTES - 1}` };
        const res = await fetch(fetchUrl, { method: 'GET', headers, redirect: 'follow', timeout: 10000 }).catch(() => null);
        if (res && (res.status === 206 || res.status === 200)) {
          const ab = await res.arrayBuffer();
          const buf = Buffer.from(ab);
          meta = await extractMetadataFromBuffer(buf, url).catch(() => null);
        }
      }

      if (meta) {
        track.title = providedTitle || meta.title || track.title;
        track.artist = providedArtist || meta.artist || track.artist;
        track.album = providedAlbum || meta.album || track.album;
        track.album_artist = meta.albumArtist || null;
        track.duration = providedDuration || meta.duration || track.duration;
        track.format = meta.format || 'remote';
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

    track.quality_score = track.quality_score ?? computeQualityScore(track);
    const stored = storeTrackWithDedup(track);
    if (!stored) {
      return { success: false, error: 'failed to store track' };
    }

    return { success: true, id: stored.id, track: stored };
  } catch (err) {
    console.error('[main] library:add-remote failed', err);
    return { success: false, error: String(err) };
  }
}

// Plugin loading system
async function checkPluginDependencies(pluginDir, pluginId) {
  const packageJsonPath = path.join(pluginDir, 'package.json');
  
  // If no package.json, no dependencies to check
  if (!fs.existsSync(packageJsonPath)) {
    return;
  }
  
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const dependencies = packageJson.dependencies || {};
    
    // If no dependencies defined, nothing to do
    if (Object.keys(dependencies).length === 0) {
      return;
    }
    
    // Check if node_modules exists and has the required packages
    const nodeModulesPath = path.join(pluginDir, 'node_modules');
    let needsInstall = !fs.existsSync(nodeModulesPath);
    
    if (!needsInstall) {
      // Check if all dependencies are installed
      for (const dep of Object.keys(dependencies)) {
        const depPath = path.join(nodeModulesPath, dep);
        if (!fs.existsSync(depPath)) {
          needsInstall = true;
          break;
        }
      }
    }
    
    if (needsInstall) {
      console.log(`[plugins] Installing dependencies for ${pluginId}...`);
      
      // Run npm install in the plugin directory
      const { spawn } = await import('child_process');
      
      await new Promise((resolve) => {
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const installProcess = spawn(npmCmd, ['install'], {
          cwd: pluginDir,
          stdio: 'inherit',
          shell: true
        });
        
        installProcess.on('close', (code) => {
          if (code === 0) {
            console.log(`[plugins] Dependencies installed for ${pluginId}`);
            resolve();
          } else {
            console.error(`[plugins] Failed to install dependencies for ${pluginId} (exit code: ${code})`);
            resolve(); // Don't reject, just continue
          }
        });
        
        installProcess.on('error', (err) => {
          console.error(`[plugins] Error installing dependencies for ${pluginId}:`, err);
          resolve(); // Don't reject, just continue
        });
      });
    }
  } catch (e) {
    console.error(`[plugins] Error checking dependencies for ${pluginId}:`, e);
  }
}

async function loadPlugins() {
  console.log('[plugins] Loading plugins...');
  const cfg = loadPluginConfig();
  
  // Check both user data plugins and repo plugins (prefer user plugins)
  const searchDirs = [pluginsDir, repoPluginsDir];
  
  for (const searchDir of searchDirs) {
    if (!fs.existsSync(searchDir)) continue;
    
    const dirs = fs.readdirSync(searchDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      
      const pluginDir = path.join(searchDir, d.name);
      const manifestPath = path.join(pluginDir, 'manifest.json');
      
      if (!fs.existsSync(manifestPath)) continue;
      
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const pluginId = manifest.id || d.name;
        
        // Skip if already loaded from a different location
        if (loadedPlugins.has(pluginId)) continue;
        
        // Check if plugin is enabled (default: true)
        const enabled = cfg[pluginId]?.enabled !== false;
        if (!enabled) {
          console.log(`[plugins] Skipping disabled plugin: ${pluginId}`);
          continue;
        }
        
        // Check and install plugin dependencies if needed
        await checkPluginDependencies(pluginDir, pluginId);
        
        // Load the plugin module
        const pluginMainPath = path.join(pluginDir, manifest.main || 'plugin.js');
        if (!fs.existsSync(pluginMainPath)) {
          console.error(`[plugins] Plugin main file not found: ${pluginMainPath}`);
          continue;
        }
        
        // Import the plugin (ESM)
        const pluginUrl = new URL(`file:///${pluginMainPath.replace(/\\/g, '/')}`);
        const pluginModule = await import(pluginUrl.href);
        
        if (!pluginModule.activate) {
          console.error(`[plugins] Plugin ${pluginId} missing activate function`);
          continue;
        }
        
        // Create plugin context with settings from config (or defaults from manifest)
        const savedSettings = cfg[pluginId]?.settings || manifest.settings || {};
        const context = {
          settings: savedSettings,
          on: (event, handler) => {
            const handlers = pluginEventHandlers.get(event);
            if (handlers) {
              handlers.push(handler);
            } else {
              pluginEventHandlers.set(event, [handler]);
            }
          },
          registerRemoteHandler: (channel, handler) => {
            handlers[channel] = handler;
          },
          broadcast: (channel, ...args) => {
            try {
              broadcast(channel, ...args);
            } catch (err) {
              console.warn(`[plugins] broadcast failed for ${channel}`, err);
            }
          }
        };
        
        // Activate the plugin
        console.log(`[plugins] Activating plugin: ${pluginId}`);
        pluginModule.activate(context);
        
        loadedPlugins.set(pluginId, {
          id: pluginId,
          module: pluginModule,
          manifest,
          context,
        });
        
        console.log(`[plugins] OK Loaded plugin: ${pluginId}`);
      } catch (e) {
        console.error(`[plugins] Failed to load plugin ${d.name}:`, e);
      }
    }
  }
  
  console.log(`[plugins] Loaded ${loadedPlugins.size} plugin(s)`);
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


