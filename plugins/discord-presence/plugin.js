// discord-presence plugin.js
import { Client } from 'discord-rpc';

const CLIENT_ID = '1446530569553842251'; // You'll need to create a Discord app and replace this

let rpcClient = null;
let currentActivity = null;
let startTimestamp = null;
let settings = {};

export async function activate(context) {
  console.log('[discord-presence] Activating...');
  settings = context.settings || {};

  try {
    rpcClient = new Client({ transport: 'ipc' });

    rpcClient.on('ready', () => {
      console.log('[discord-presence] Connected to Discord');
    });

    rpcClient.on('error', (err) => {
      console.warn('[discord-presence] RPC client error:', err && err.message ? err.message : err);
    });

    // Some transports may emit 'disconnected' or 'close' events; listen loosely
    try {
      rpcClient.on('disconnected', () => {
        console.warn('[discord-presence] Discord RPC disconnected');
      });
    } catch (e) {}

    try {
      await rpcClient.login({ clientId: CLIENT_ID });
    } catch (err) {
      console.error('[discord-presence] Failed to connect to Discord:', err && err.message ? err.message : err);
      // Keep rpcClient reference so deactivate can cleanup
    }
  } catch (e) {
    console.error('[discord-presence] Failed to initialize RPC client:', e && e.message ? e.message : e);
    rpcClient = null;
  }

  // Listen to playback events
  context.on('track-started', handleTrackStarted);
  context.on('track-paused', handleTrackPaused);
  context.on('track-resumed', handleTrackResumed);
  context.on('track-stopped', handleTrackStopped);
}

export function deactivate() {
  console.log('[discord-presence] Deactivating...');
  if (rpcClient) {
    try {
      rpcClient.clearActivity && rpcClient.clearActivity();
    } catch (e) {}
    try {
      // destroy may return a promise
      const res = rpcClient.destroy && rpcClient.destroy();
      if (res && typeof res.then === 'function') res.catch(() => {});
    } catch (e) {}
    rpcClient = null;
  }
}

async function getCoverImageUrl(coverPath) {
  if (!coverPath) return null;
  
  // If it's already a URL, use it directly
  if (coverPath.startsWith('http://') || coverPath.startsWith('https://')) {
    return coverPath;
  }
  
  // For local files, we need to use the remote server
  // Assuming remote server is running on port 3000
  // The cover files are served from the covers directory via the static file handler
  try {
    // Extract just the filename from the path
    const fileName = coverPath.split(/[/\\]/).pop();
    const coverUrl = `http://localhost:3000/covers/${fileName}`;
    return coverUrl;
  } catch (err) {
    console.error('[discord-presence] Failed to get cover URL:', err);
    return null;
  }
}

async function handleTrackStarted(metadata) {
  if (!rpcClient || !metadata) return;
  
  startTimestamp = Date.now();
  const title = metadata.title || 'Unknown Track';
  const artist = metadata.artist || 'Unknown Artist';
  const album = metadata.album || '';
  
  currentActivity = {
    details: title,
    state: settings.showArtist ? `by ${artist}` : undefined,
    startTimestamp: settings.showTimeElapsed ? startTimestamp : undefined,
    largeImageKey: 'spectra_logo', // Default fallback
    largeImageText: settings.largeImageText || 'Spectra Player',
    smallImageKey: 'playing',
    smallImageText: 'Playing',
    instance: false,
  };
  
  // Try to use album cover if enabled and available
  if (settings.showAlbumCover && metadata.cover_path) {
    const coverUrl = await getCoverImageUrl(metadata.cover_path);
    if (coverUrl) {
      currentActivity.largeImageKey = coverUrl;
      currentActivity.largeImageText = album || settings.largeImageText || 'Spectra Player';
    }
  }
  
  if (settings.showAlbum && album) {
    currentActivity.state = `${artist} • ${album}`;
  }
  
  setActivity(currentActivity);
}

function handleTrackPaused() {
  if (!rpcClient || !currentActivity) return;
  
  currentActivity.smallImageKey = 'paused';
  currentActivity.smallImageText = 'Paused';
  delete currentActivity.startTimestamp;
  
  setActivity(currentActivity);
}

function handleTrackResumed() {
  if (!rpcClient || !currentActivity) return;
  
  currentActivity.smallImageKey = 'playing';
  currentActivity.smallImageText = 'Playing';
  if (settings.showTimeElapsed) {
    currentActivity.startTimestamp = Date.now();
  }
  
  setActivity(currentActivity);
}

function handleTrackStopped() {
  if (!rpcClient) return;
  rpcClient.clearActivity();
  currentActivity = null;
}

function setActivity(activity) {
  if (!rpcClient) return;
  rpcClient.setActivity(activity).catch(err => {
    console.error('[discord-presence] Failed to set activity:', err);
  });
}

export function updateSettings(newSettings) {
  settings = { ...settings, ...newSettings };
}
