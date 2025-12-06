
// web-client.js
// This file is loaded only in the web browser version to mock the electron API

const socket = io();

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

socket.on('push-event', ({ channel, args }) => {
  if (eventListeners.has(channel)) {
    eventListeners.get(channel).forEach(callback => callback(...args));
  }
});

window.electron = {
  importFile: () => Promise.reject(new Error("Not supported in web mode")),
  importFolder: () => Promise.reject(new Error("Not supported in web mode")),
  addFiles: (paths) => Promise.reject(new Error("Not supported in web mode")),
  
  getLibrary: () => invoke('library:get'),
  getAlbums: () => invoke('library:get-albums'),
  getCoverImage: (coverPath) => invoke('library:get-cover-image', coverPath),
  removeTrack: (id) => invoke('library:remove-track', id),
  updateTrack: (id, data) => invoke('library:update-track', id, data),
  showTrackContextMenu: (track) => {
    // Remove existing menu if any
    const existing = document.getElementById('web-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'web-context-menu';
    menu.style.position = 'fixed';
    menu.style.top = '50%';
    menu.style.left = '50%';
    menu.style.transform = 'translate(-50%, -50%)';
    menu.style.backgroundColor = '#2b2b2b';
    menu.style.border = '1px solid #444';
    menu.style.padding = '10px';
    menu.style.zIndex = '10000';
    menu.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
    menu.style.minWidth = '250px';
    menu.style.borderRadius = '4px';
    menu.style.color = '#eee';

    const title = document.createElement('div');
    title.textContent = track.title || 'Unknown Track';
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '10px';
    title.style.borderBottom = '1px solid #444';
    title.style.paddingBottom = '5px';
    title.style.fontSize = '14px';
    menu.appendChild(title);

    // Add to Object Storage
    const btnUpload = document.createElement('button');
    btnUpload.textContent = 'Add to Object Storage';
    btnUpload.style.display = 'block';
    btnUpload.style.width = '100%';
    btnUpload.style.textAlign = 'left';
    btnUpload.style.background = 'none';
    btnUpload.style.border = 'none';
    btnUpload.style.color = '#fff';
    btnUpload.style.padding = '8px';
    btnUpload.style.cursor = 'pointer';
    btnUpload.style.fontSize = '14px';
    btnUpload.onmouseover = () => btnUpload.style.backgroundColor = '#3d3d3d';
    btnUpload.onmouseout = () => btnUpload.style.backgroundColor = 'transparent';
    
    btnUpload.onclick = async () => {
      menu.remove();
      const key = prompt('Enter destination key (leave empty for default):');
      if (key !== null) {
        try {
          const result = await invoke('object-storage:upload', track.path, key);
          if (result.success) {
            alert('Upload successful: ' + result.key);
          } else {
            alert('Upload failed: ' + result.error);
          }
        } catch (e) {
          alert('Upload error: ' + e.message);
        }
      }
    };
    menu.appendChild(btnUpload);

    // Close button (or click outside to close)
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.zIndex = '9999';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
    overlay.onclick = () => {
      menu.remove();
      overlay.remove();
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
  
  setFullscreen: (flag) => console.log('Fullscreen toggle handled locally or ignored'),
  
  seek: (time) => invoke('audio:seek', time),
  getTime: () => invoke('audio:get-time'),
  setVolume: (val) => invoke('audio:set-volume', val),
  getDevices: () => invoke('audio:get-devices'),
  getPlayerState: () => invoke('player:get-state'),
  toggleRemote: (enable) => Promise.resolve(true), // No-op on web client
  
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
