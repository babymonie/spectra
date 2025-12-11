
// web-client.js
// This file is loaded only in the web browser version to mock the electron API
const ioPort = Number(document.documentElement?.dataset?.spectraRemotePort || window.__SPECTRA_REMOTE_PORT__ || 0);
const ioHost = document.documentElement?.dataset?.spectraRemoteHost || window.__SPECTRA_REMOTE_HOST__ || undefined;
const socket = io(ioPort ? `http://${ioHost || window.location.hostname}:${ioPort}` : undefined, {
  transports: ['websocket'],
  forceNew: true,
});

// Generate a unique ID for requests
const generateId = () => Math.random().toString(36).substr(2, 9);

// Map to store pending requests
const pendingRequests = new Map();

socket.on('response', ({ id, result, error }) => {
  if (pendingRequests.has(id)) {
    const { resolve, reject } = pendingRequests.get(id);
    pendingRequests.delete(id);
    if (error) {
      reject(new Error(error));
    } else {
      resolve(result);
    }
  }
});

// Handle events from server (e.g. push notifications)
const eventListeners = new Map();

const emitEvent = (channel, ...args) => {
  if (!eventListeners.has(channel)) return;
  const listeners = eventListeners.get(channel) || [];
  for (const callback of listeners) {
    try {
      callback(...args);
    } catch (error) {
      console.error('[web-client] event listener error', channel, error);
    }
  }
};

socket.on('push-event', ({ channel, args }) => {
  emitEvent(channel, ...(Array.isArray(args) ? args : []));
});

const removeAllListenersForChannel = (channel) => {
  if (!channel) return;
  eventListeners.delete(channel);
};

globalThis.electron = {
  importFile: () => Promise.reject(new Error("Not supported in web mode")),
  importFolder: () => Promise.reject(new Error("Not supported in web mode")),
  addFiles: (paths) => invoke('library:add-files', paths),
  addRemote: (info) => invoke('library:add-remote', info),
  
  getLibrary: () => invoke('library:get'),
  getAlbums: () => invoke('library:get-albums'),
  getCoverImage: (coverPath) => invoke('library:get-cover-image', coverPath),
  removeTrack: (id) => invoke('library:remove-track', id),
  updateTrack: (id, data) => invoke('library:update-track', id, data),
  showTrackContextMenu: async (input) => {
    const tracks = Array.isArray(input) ? input : (input ? [input] : []);
    if (tracks.length === 0) return;

    const existing = document.getElementById('web-context-menu');
    const existingOverlay = document.getElementById('web-context-menu-overlay');
    if (existing) existing.remove();
    if (existingOverlay) existingOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'web-context-menu-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.zIndex = '9999';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';

    const menu = document.createElement('div');
    menu.id = 'web-context-menu';
    menu.style.position = 'fixed';
    menu.style.top = '50%';
    menu.style.left = '50%';
    menu.style.transform = 'translate(-50%, -50%)';
    menu.style.backgroundColor = '#2b2b2b';
    menu.style.border = '1px solid #444';
    menu.style.padding = '12px';
    menu.style.zIndex = '10000';
    menu.style.boxShadow = '0 4px 18px rgba(0,0,0,0.6)';
    menu.style.minWidth = '260px';
    menu.style.borderRadius = '6px';
    menu.style.color = '#eee';
    menu.style.fontSize = '14px';

    const title = document.createElement('div');
    title.textContent = tracks.length === 1 ? (tracks[0].title || 'Unknown Track') : `${tracks.length} tracks selected`;
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '12px';
    title.style.borderBottom = '1px solid #444';
    title.style.paddingBottom = '6px';
    title.style.fontSize = '15px';
    menu.appendChild(title);

    const addMenuButton = (label, handler, opts = {}) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.display = 'block';
      btn.style.width = '100%';
      btn.style.textAlign = 'left';
      btn.style.background = 'none';
      btn.style.border = 'none';
      btn.style.color = '#fff';
      btn.style.padding = '8px';
      btn.style.cursor = 'pointer';
      btn.style.fontSize = '14px';
      btn.style.borderRadius = '4px';
      btn.onmouseover = () => { btn.style.backgroundColor = '#3d3d3d'; };
      btn.onmouseout = () => { btn.style.backgroundColor = 'transparent'; };
      if (opts.disabled) {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'default';
      } else {
        btn.onclick = async () => {
          try {
            await handler();
          } finally {
            menu.remove();
            overlay.remove();
          }
        };
      }
      menu.appendChild(btn);
      return btn;
    };

    const closeMenu = () => {
      menu.remove();
      overlay.remove();
    };

    if (tracks.length === 1) {
      addMenuButton('Edit Info', async () => {
        emitEvent('track:edit', tracks[0]);
      });
      menu.appendChild(document.createElement('hr')).style.borderColor = '#444';
    }

    addMenuButton(tracks.length > 1 ? `Remove ${tracks.length} tracks from Library` : 'Remove from Library', async () => {
      if (tracks.length === 1) {
        emitEvent('track:remove', tracks[0].id);
      } else {
        const ids = tracks.map((t) => t.id).filter(Boolean);
        emitEvent('tracks:remove', ids);
      }
    });

    let playlists = [];
    try {
      playlists = await window.electron.getPlaylists();
    } catch (error) {
      console.warn('[web-client] Failed to load playlists for context menu', error);
    }

    const ids = tracks.map((t) => t.id).filter(Boolean);

    if (playlists.length) {
      const playlistLabel = playlists.length === 1 ? 'Add to Playlist' : 'Add to Playlist…';
      const playlistBtn = addMenuButton(playlistLabel, async () => {}, { disabled: true });
      playlistBtn.style.position = 'relative';
      playlistBtn.style.fontWeight = 'bold';
      playlistBtn.style.cursor = 'default';
      playlistBtn.style.opacity = '1';

      const list = document.createElement('div');
      list.style.marginTop = '4px';
      list.style.marginBottom = '8px';
      list.style.paddingLeft = '8px';
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '4px';

      playlists.forEach((pl) => {
        const plBtn = document.createElement('button');
        plBtn.textContent = pl.name;
        plBtn.style.textAlign = 'left';
        plBtn.style.background = '#1f1f1f';
        plBtn.style.border = '1px solid #333';
        plBtn.style.color = '#fff';
        plBtn.style.padding = '6px 8px';
        plBtn.style.borderRadius = '4px';
        plBtn.style.cursor = 'pointer';
        plBtn.onmouseover = () => { plBtn.style.backgroundColor = '#2d2d2d'; };
        plBtn.onmouseout = () => { plBtn.style.backgroundColor = '#1f1f1f'; };
        plBtn.onclick = async () => {
          try {
            for (const trackId of ids) {
              await window.electron.addTrackToPlaylist(pl.id, trackId);
            }
            emitEvent('playlist:added', { playlistId: pl.id, trackIds: ids });
          } finally {
            closeMenu();
          }
        };
        list.appendChild(plBtn);
      });

      const newPlaylistBtn = document.createElement('button');
      newPlaylistBtn.textContent = 'New playlist…';
      newPlaylistBtn.style.textAlign = 'left';
      newPlaylistBtn.style.background = '#1f1f1f';
      newPlaylistBtn.style.border = '1px solid #333';
      newPlaylistBtn.style.color = '#fff';
      newPlaylistBtn.style.padding = '6px 8px';
      newPlaylistBtn.style.borderRadius = '4px';
      newPlaylistBtn.style.cursor = 'pointer';
      newPlaylistBtn.onmouseover = () => { newPlaylistBtn.style.backgroundColor = '#2d2d2d'; };
      newPlaylistBtn.onmouseout = () => { newPlaylistBtn.style.backgroundColor = '#1f1f1f'; };
      newPlaylistBtn.onclick = () => {
        emitEvent('playlist:create-from-selection', { trackIds: ids });
        closeMenu();
      };
      list.appendChild(newPlaylistBtn);

      menu.appendChild(list);
    } else {
      addMenuButton('Add to Playlist…', async () => {
        emitEvent('playlist:create-from-selection', { trackIds: ids });
      });
    }

    addMenuButton('Add to Object Storage', async () => {
      const first = tracks[0];
      const key = prompt('Enter destination key (leave empty for default):');
      if (key !== null) {
        const result = await invoke('object-storage:upload', first.path, key);
        if (result.success) alert('Upload successful: ' + result.key);
        else alert('Upload failed: ' + result.error);
      }
    });

    addMenuButton('Cancel', async () => {});

    overlay.onclick = (event) => {
      if (event.target === overlay) {
        closeMenu();
      }
    };

    document.body.appendChild(overlay);
    document.body.appendChild(menu);
  },
  
  // Audio playback is handled by the server (main process), not the browser.
  // The browser sends a command to the server to play the audio on the host machine.
  playTrack: (path, options) => invoke('audio:play', path, options),
  pause: () => invoke('audio:pause'),
  resume: () => invoke('audio:resume'),
  getAudioStatus: () => invoke('audio:get-status'),
  stop: () => invoke('audio:stop'),
  
  getLyrics: (opts) => invoke('lyrics:get', opts),
  saveLyrics: (opts) => invoke('lyrics:save', opts),
  
  setFullscreen: () => console.log('Fullscreen toggle handled locally or ignored'),
  
  seek: (time) => invoke('audio:seek', time),
  getTime: () => invoke('audio:get-time'),
  setVolume: (val) => invoke('audio:set-volume', val),
  getDevices: () => invoke('audio:get-devices'),
  getPlayerState: () => invoke('player:get-state'),
  toggleRemote: () => Promise.resolve(true), // No-op on web client
  getPlugins: () => invoke('plugins:list'),
  setPluginEnabled: (id, enabled) => invoke('plugins:set-enabled', id, enabled),
  updatePluginSettings: (id, settings) => invoke('plugins:update-settings', id, settings),
  reloadPlugins: () => invoke('plugins:reload'),
  signalPluginsReadyForReload: () => invoke('plugins:ready-for-reload'),
  objectStorageUpload: (localPath, key) => invoke('object-storage:upload', localPath, key),
  objectStorageGetUrl: (key) => invoke('object-storage:get-url', key),
  objectStorageList: (prefix) => invoke('object-storage:list', prefix),
  off: (channel) => {
    removeAllListenersForChannel(channel);
  },
  
  on: (channel, callback) => {
    if (!eventListeners.has(channel)) {
      eventListeners.set(channel, []);
    }
    eventListeners.get(channel).push(callback);
    // Return a cleanup function if needed, though existing code might not use it
  }
};

function invoke(channel, ...args) {
  return new Promise((resolve, reject) => {
    const id = generateId();
    pendingRequests.set(id, { resolve, reject });
    socket.emit('invoke', { id, channel, args });
  });
}

console.log('Web client initialized, window.electron mocked via Socket.IO');
