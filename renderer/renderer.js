const { electron } = window;

// State
let tracks = [];
let libraryCache = [];
let currentTrack = null;
let isPlaying = false;
let shuffleEnabled = false;
let repeatMode = 'off'; // 'off', 'all', 'one'
let playbackQueue = [];
let queueIndex = -1;

// DOM Elements (assigned in init)
let trackList;
let btnPlay;
let btnPrev;
let btnNext;
let seekSlider;
let volumeSlider;
let npTitle;
let npArtist;
let npArt;
let currentTimeEl;
let totalTimeEl;

// Settings Elements
let deviceSelect;
let modeSelect;
let bitPerfectCheckbox;
let strictBitPerfectCheckbox;
let remoteEnableCheckbox;
let sampleRateSelect;
let sampleRateCustomInput;

// Navigation Elements
let navLibrary;
let navPlaylists;
let navSettings;
let navAlbums;
let navArtists;
let viewLibrary;
let viewPlaylists;
let viewSettings;
let viewAlbums;
let viewArtists;

// Other DOM elements assigned in init
let btnImportFile;
let btnImportFolder;
let btnImportUrl;
let editModal;
let editTitle;
let editArtist;
let editAlbum;
let btnSaveEdit;
let btnCancelEdit;
let notificationBar;
let notificationMessage;
let notificationProgress;
let notificationCount;

let isSeeking = false;
// When set, searches and library view are scoped to this album (lowercase name and optional artist)
let currentAlbumFilter = null;
let currentArtistFilter = null;

// Helper function to update repeat button visual state

// Normalizes strings for comparison: trim, lower-case, unicode normalize, and remove diacritics
function normalizeForCompare(s) {
  if (!s && s !== '') return '';
  try {
    return s.toString().trim().toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  } catch (e) {
    // Fallback for environments without full unicode property support
    return s.toString().trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }
}
function updateRepeatButton(btn) {
  if (!btn) return;
  btn.classList.remove('active', 'repeat-one');
  if (repeatMode === 'all') {
    btn.classList.add('active');
  } else if (repeatMode === 'one') {
    btn.classList.add('active', 'repeat-one');
  }
}

// Helper function to render queue
async function renderQueue() {
  const queueList = document.getElementById('queue-list');
  if (!queueList) return;

  try {
    const queue = await electron.getQueue();
    playbackQueue = queue.queue || [];
    queueIndex = queue.index || -1;

    if (playbackQueue.length === 0) {
      queueList.innerHTML = `
        <div class="queue-empty">
          <span class="material-icons">queue_music</span>
          <p>Queue is empty</p>
        </div>
      `;
      return;
    }

    queueList.innerHTML = '';
    playbackQueue.forEach((track, index) => {
      const item = document.createElement('div');
      item.className = 'queue-item';
      if (index === queueIndex) item.classList.add('current');

      item.innerHTML = `
        <div class="queue-item-index">${index + 1}</div>
        <div class="queue-item-info">
          <div class="queue-item-title">${track.title || 'Unknown Title'}</div>
          <div class="queue-item-artist">${track.artist || 'Unknown Artist'}</div>
        </div>
        <button class="queue-item-remove icon-btn">
          <span class="material-icons">close</span>
        </button>
      `;

      // Click to play
      item.addEventListener('click', async (e) => {
        if (e.target.closest('.queue-item-remove')) return;
        await playTrack(track);
      });

      // Remove button
      const removeBtn = item.querySelector('.queue-item-remove');
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await electron.removeFromQueue(index);
        await renderQueue();
      });

      queueList.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to render queue:', err);
    queueList.innerHTML = '<div class="queue-empty"><p>Error loading queue</p></div>';
  }
}

// Playlist editor
let currentEditingPlaylist = null;
let playlistEditorTracks = [];

async function openPlaylistEditor(playlistId) {
  const modal = document.getElementById('playlist-editor-modal');
  const nameInput = document.getElementById('playlist-name-input');
  const tracksContainer = document.getElementById('playlist-editor-tracks');

  if (!modal || !nameInput || !tracksContainer) return;

  currentEditingPlaylist = playlistId;

  // Load playlist data
  const playlists = await electron.getPlaylists();
  const playlist = playlists.find(p => p.id === playlistId);
  const tracks = await electron.getPlaylistTracks(playlistId);

  if (!playlist) return;

  nameInput.value = playlist.name || '';
  playlistEditorTracks = tracks || [];

  renderPlaylistEditorTracks();
  modal.style.display = 'flex';
}

function renderPlaylistEditorTracks() {
  const tracksContainer = document.getElementById('playlist-editor-tracks');
  if (!tracksContainer) return;

  if (playlistEditorTracks.length === 0) {
    tracksContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">No tracks in playlist</div>';
    return;
  }

  tracksContainer.innerHTML = '';
  playlistEditorTracks.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = 'playlist-track-item';
    item.draggable = true;
    item.dataset.index = index;

    item.innerHTML = `
      <span class="material-icons playlist-track-drag-handle">drag_indicator</span>
      <div class="playlist-track-info">
        <div class="playlist-track-title">${track.title || 'Unknown Title'}</div>
        <div class="playlist-track-artist">${track.artist || 'Unknown Artist'}</div>
      </div>
      <button class="playlist-track-remove icon-btn">
        <span class="material-icons">close</span>
      </button>
    `;

    // Drag events
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index);
      item.classList.add('dragging');
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
      const toIndex = parseInt(item.dataset.index);

      if (fromIndex !== toIndex) {
        // Reorder array
        const [movedTrack] = playlistEditorTracks.splice(fromIndex, 1);
        playlistEditorTracks.splice(toIndex, 0, movedTrack);
        renderPlaylistEditorTracks();
      }
    });

    // Remove button
    const removeBtn = item.querySelector('.playlist-track-remove');
    removeBtn.addEventListener('click', () => {
      playlistEditorTracks.splice(index, 1);
      renderPlaylistEditorTracks();
    });

    tracksContainer.appendChild(item);
  });
}

// Load Settings
let settings = {
  deviceId: localStorage.getItem('spectra_deviceId') || '',
  mode: localStorage.getItem('spectra_mode') || 'shared',
  bitPerfect: localStorage.getItem('spectra_bitPerfect') === 'true',
  strictBitPerfect: localStorage.getItem('spectra_strictBitPerfect') === 'true',
  remoteEnabled: localStorage.getItem('spectra_remoteEnabled') === 'true',
  sampleRate: localStorage.getItem('spectra_sampleRate') || ''
};

// Add minimize-to-tray preference (persisted in localStorage and informed to main)
settings.minimizeToTray = localStorage.getItem('spectra_minimizeToTray') === 'true';

// Apply Settings to UI
const loadSettingsUI = async () => {
  // Load devices
  const devices = await electron.getDevices();
  deviceSelect.innerHTML = '<option value="">Default</option>';
  if (Array.isArray(devices)) {
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      if (d.id === settings.deviceId) opt.selected = true;
      deviceSelect.appendChild(opt);
    });
    // Helper: update sample rate options based on device capabilities
    const updateSampleRateOptions = (deviceId) => {
      // gather device sample rates if available
      let dev = devices.find(x => x.id === deviceId);
      let rates = [];
      if (dev && Array.isArray(dev.sampleRates) && dev.sampleRates.length) {
        rates = dev.sampleRates.map(r => String(r));
      }
      // common rates to always offer
      const common = ['44100','48000','88200','96000','176400','192000'];
      const combined = [];
      // Auto option
      combined.push({ v: '', label: 'Auto (Default)' });
      // add device-supported rates first
      for (const r of rates) {
        combined.push({ v: r, label: r });
      }
      // add remaining common rates not already included
      for (const r of common) {
        if (!rates.includes(r)) combined.push({ v: r, label: r });
      }
      // custom option at end
      combined.push({ v: 'custom', label: 'Custom…' });

      // Rebuild select options
      if (!sampleRateSelect) return;
      const prev = sampleRateSelect.value;
      sampleRateSelect.innerHTML = '';
      for (const it of combined) {
        const o = document.createElement('option');
        o.value = it.v;
        o.textContent = it.label;
        sampleRateSelect.appendChild(o);
      }
      // restore previous selection if still valid
      const validVals = Array.from(sampleRateSelect.options).map(o => o.value);
      if (prev && validVals.includes(prev)) sampleRateSelect.value = prev;
      else {
        // if settings.sampleRate matches a numeric option, select it
        if (settings.sampleRate && validVals.includes(String(settings.sampleRate))) sampleRateSelect.value = String(settings.sampleRate);
        else if (settings.sampleRate) {
          // show custom
          sampleRateSelect.value = 'custom';
          if (sampleRateCustomInput) {
            sampleRateCustomInput.style.display = 'inline-block';
            sampleRateCustomInput.value = settings.sampleRate;
          }
        } else sampleRateSelect.value = '';
      }
    };
    // initialize sample rate options for current device selection
    updateSampleRateOptions(settings.deviceId);
    // update options when device changes
    deviceSelect.addEventListener('change', () => {
      updateSampleRateOptions(deviceSelect.value);
    });
  }

  modeSelect.value = settings.mode;
  bitPerfectCheckbox.checked = settings.bitPerfect;
  strictBitPerfectCheckbox.checked = settings.strictBitPerfect;
  // Initialize sample rate UI: select + optional custom input
  if (sampleRateSelect) {
    if (!settings.sampleRate) {
      sampleRateSelect.value = '';
      if (sampleRateCustomInput) sampleRateCustomInput.style.display = 'none';
    } else if (['44100','48000','88200','96000','176400','192000'].includes(String(settings.sampleRate))) {
      sampleRateSelect.value = String(settings.sampleRate);
      if (sampleRateCustomInput) sampleRateCustomInput.style.display = 'none';
    } else {
      sampleRateSelect.value = 'custom';
      if (sampleRateCustomInput) {
        sampleRateCustomInput.style.display = 'inline-block';
        sampleRateCustomInput.value = settings.sampleRate;
      }
    }
    // toggle custom input when selection changes
    if (sampleRateSelect && sampleRateCustomInput) {
      sampleRateSelect.addEventListener('change', () => {
        if (sampleRateSelect.value === 'custom') {
          sampleRateCustomInput.style.display = 'inline-block';
          sampleRateCustomInput.focus();
        } else {
          sampleRateCustomInput.style.display = 'none';
        }
      });
    }
  }
  if (remoteEnableCheckbox) {
    remoteEnableCheckbox.checked = settings.remoteEnabled;
    electron.toggleRemote(settings.remoteEnabled);
  }
  // Minimize-to-tray checkbox
  const minimizeTrayCheckbox = document.getElementById('minimize-tray-checkbox');
  if (minimizeTrayCheckbox) {
    minimizeTrayCheckbox.checked = !!settings.minimizeToTray;
  }
};

// Save Settings
const saveSettings = () => {
  settings.deviceId = deviceSelect.value;
  settings.mode = modeSelect.value;
  settings.bitPerfect = bitPerfectCheckbox.checked;
  settings.strictBitPerfect = strictBitPerfectCheckbox.checked;
  if (sampleRateSelect) {
    if (sampleRateSelect.value === 'custom' && sampleRateCustomInput) {
      settings.sampleRate = sampleRateCustomInput.value ? String(sampleRateCustomInput.value).trim() : '';
    } else {
      settings.sampleRate = sampleRateSelect.value ? String(sampleRateSelect.value) : '';
    }
  }
  if (remoteEnableCheckbox) {
    settings.remoteEnabled = remoteEnableCheckbox.checked;
    localStorage.setItem('spectra_remoteEnabled', settings.remoteEnabled);
    electron.toggleRemote(settings.remoteEnabled);
  }

  // Minimize-to-tray
  const minimizeTrayCheckbox = document.getElementById('minimize-tray-checkbox');
  if (minimizeTrayCheckbox) {
    settings.minimizeToTray = !!minimizeTrayCheckbox.checked;
    localStorage.setItem('spectra_minimizeToTray', settings.minimizeToTray);
    try { electron.setMinimizeToTray(settings.minimizeToTray); } catch (e) { console.warn('Failed to set minimize-to-tray:', e); }
  }

  localStorage.setItem('spectra_deviceId', settings.deviceId);
  localStorage.setItem('spectra_mode', settings.mode);
  localStorage.setItem('spectra_bitPerfect', settings.bitPerfect);
  localStorage.setItem('spectra_strictBitPerfect', settings.strictBitPerfect);
  if (settings.sampleRate) localStorage.setItem('spectra_sampleRate', settings.sampleRate);
  else localStorage.removeItem('spectra_sampleRate');
};

// Settings Event Listeners
// Navigation Logic
const switchView = (viewId, preserveLibrary = false) => {
  // Hide all views (including plugin-provided views that use class `view`)
  document.querySelectorAll('.view').forEach(el => el.style.display = 'none');
  // Remove active state from all sidebar items
  document.querySelectorAll('.sidebar nav li').forEach(el => el.classList.remove('active'));

  // Prefer a view element named `view-<viewId>` so plugins can register their own views
  const targetId = `view-${viewId}`;
  const targetView = document.getElementById(targetId);
  if (targetView) {
    targetView.style.display = 'block';
    const navEl = document.getElementById(`nav-${viewId}`);
    if (navEl) navEl.classList.add('active');

    // Keep legacy behavior for known views
    if (viewId === 'library') {
      if (!preserveLibrary) {
        // Clear any album-scoped filter when doing a full library load
        currentAlbumFilter = null;
        currentArtistFilter = null;
        loadLibrary();
      }
    } else if (viewId === 'albums') {
      renderAlbums();
    } else if (viewId === 'artists') {
      renderArtists();
    } else if (viewId === 'settings') {
      loadSettingsUI();
    }
    return;
  }

  // Fallback: handle built-in views by id if explicit `view-<id>` element wasn't found
  if (viewId === 'library') {
    if (viewLibrary) viewLibrary.style.display = 'block';
    if (navLibrary) navLibrary.classList.add('active');
    if (!preserveLibrary) loadLibrary();
  } else if (viewId === 'playlists') {
    if (viewPlaylists) viewPlaylists.style.display = 'block';
    if (navPlaylists) navPlaylists.classList.add('active');
    renderPlaylists();
  } else if (viewId === 'albums') {
    if (viewAlbums) viewAlbums.style.display = 'block';
    if (navAlbums) navAlbums.classList.add('active');
    renderAlbums();
  } else if (viewId === 'settings') {
    if (viewSettings) viewSettings.style.display = 'block';
    if (navSettings) navSettings.classList.add('active');
    loadSettingsUI();
  }
};


// Format time
const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// Now Playing bar helpers
function showNowPlaying() {
  const bar = document.querySelector('.now-playing-bar');
  if (!bar) return;
  bar.classList.add('show');
  bar.classList.remove('hidden');
}

// Sidebar playlists removed: playlists are rendered on the Playlists page only.

async function renderPlaylists() {
  try {
    const container = document.getElementById('playlists-container');
    if (!container) return;
    container.innerHTML = '';

    const pls = await electron.getPlaylists();
    if (!Array.isArray(pls) || pls.length === 0) {
      container.innerHTML = '<div class="empty">No playlists</div>';
      return;
    }

    for (const p of pls) {
      const card = document.createElement('div');
      card.className = 'album-card';

      const title = document.createElement('div');
      title.className = 'album-title';
      title.textContent = p.name || `Playlist ${p.id}`;

      const meta = document.createElement('div');
      meta.className = 'album-artist';
      meta.textContent = new Date(p.created_at).toLocaleString();

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '8px';
      actions.style.marginTop = '8px';

      const btnView = document.createElement('button');
      btnView.className = 'btn-secondary';
      btnView.textContent = 'View';
      btnView.onclick = async () => {
        const tracksIn = await electron.getPlaylistTracks(p.id);
        if (Array.isArray(tracksIn)) {
          tracks = tracksIn;
          renderLibrary();
          switchView('library', true);
        }
      };

      const btnPlay = document.createElement('button');
      btnPlay.className = 'btn-secondary';
      btnPlay.textContent = 'Play';
      btnPlay.onclick = async () => {
        const tracksIn = await electron.getPlaylistTracks(p.id);
        if (Array.isArray(tracksIn) && tracksIn.length > 0) {
          tracks = tracksIn;
          await playTrack(tracks[0]);
        } else {
          alert('Playlist is empty');
        }
      };

      const btnEdit = document.createElement('button');
      btnEdit.className = 'btn-text';
      btnEdit.innerHTML = '<span class="material-icons">edit</span>';
      btnEdit.title = 'Edit Playlist';
      btnEdit.onclick = () => openPlaylistEditor(p.id);

      const btnExport = document.createElement('button');
      btnExport.className = 'btn-text';
      btnExport.innerHTML = '<span class="material-icons">save_alt</span>';
      btnExport.title = 'Export Playlist';
      btnExport.onclick = async (e) => {
        e.stopPropagation();
        try {
          const res = await electron.exportPlaylist(p.id);
          if (res && res.success) alert('Playlist exported to: ' + res.path);
          else if (res && res.canceled) {/* user canceled */}
          else alert('Export failed: ' + (res && res.error ? res.error : 'unknown'));
        } catch (err) { console.error('Export playlist failed', err); alert('Export failed'); }
      };

      // count: load tracks length
      const count = document.createElement('div');
      count.className = 'album-count';
      try {
        const tlist = await electron.getPlaylistTracks(p.id);
        count.textContent = `${Array.isArray(tlist) ? tlist.length : 0} tracks`;
      } catch {
        count.textContent = '';
      }

      actions.appendChild(btnView);
      actions.appendChild(btnPlay);
      actions.appendChild(btnExport);
      actions.appendChild(btnEdit);

      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(count);
      card.appendChild(actions);

      container.appendChild(card);
      // Make the whole card clickable to view the playlist (except when clicking buttons)
      card.style.cursor = 'pointer';
      card.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return; // ignore clicks on controls
        const tracksIn = await electron.getPlaylistTracks(p.id);
        if (Array.isArray(tracksIn)) {
          tracks = tracksIn;
          renderLibrary();
          switchView('library', true);
        }
      });
    }
  } catch (e) {
    console.error('renderPlaylists failed', e);
  }
}

function hideNowPlaying() {
  const bar = document.querySelector('.now-playing-bar');
  if (!bar) return;
  bar.classList.remove('show');
  bar.classList.add('hidden');
}

function saveLastPlayed(track, elapsed) {
  try {
    if (!track) return;
    const obj = { id: track.id, path: track.path, title: track.title, artist: track.artist, duration: track.duration, elapsed: Number(elapsed) || 0 };
    localStorage.setItem('spectra_lastPlayed', JSON.stringify(obj));
  } catch (e) {
    // ignore
  }
}

function getSavedLastPlayed() {
  try {
    const raw = localStorage.getItem('spectra_lastPlayed');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Simple custom prompt function for Electron (prompt() is not supported)
function customPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal-content">
        <h3>${message}</h3>
        <div class="form-group">
          <input type="text" id="custom-prompt-input" value="${defaultValue}" style="width: 100%;">
        </div>
        <div class="modal-actions">
          <button id="custom-prompt-cancel" class="btn-text">Cancel</button>
          <button id="custom-prompt-ok" class="btn-secondary">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    
    const input = modal.querySelector('#custom-prompt-input');
    const btnOk = modal.querySelector('#custom-prompt-ok');
    const btnCancel = modal.querySelector('#custom-prompt-cancel');
    
    input.focus();
    input.select();
    
    const cleanup = (value) => {
      document.body.removeChild(modal);
      resolve(value);
    };
    
    btnOk.onclick = () => cleanup(input.value);
    btnCancel.onclick = () => cleanup(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') cleanup(input.value);
      if (e.key === 'Escape') cleanup(null);
    };
    modal.onclick = (e) => {
      if (e.target === modal) cleanup(null);
    };
  });
}

// Render Library
const renderLibrary = () => {
  trackList.innerHTML = '';
  // Selection state for library items
  if (!globalThis.__spectra_selectedTrackIds) globalThis.__spectra_selectedTrackIds = new Set();
  const selectedTrackIds = globalThis.__spectra_selectedTrackIds;
  for (const track of tracks) {
    const el = document.createElement('div');
    const isSelected = selectedTrackIds.has(track.id);
    el.className = `track-item ${currentTrack && currentTrack.id === track.id ? 'active' : ''} ${isSelected ? 'selected' : ''}`;
    // Store path in dataset for right-click actions
    if (track.path) el.dataset.path = track.path;
    
    // Fallback for title if missing, using simple string manipulation instead of path module
    const displayTitle = track.title || (track.path ? track.path.split(/[/\\]/).pop() : 'Unknown Title');
    
    el.innerHTML = `
      <div class="col-title">${displayTitle}</div>
      <div class="col-artist">${track.artist || 'Unknown Artist'}</div>
      <div class="col-album">${track.album || 'Unknown Album'}</div>
      <div class="col-duration">${formatTime(track.duration)}</div>
    `;
    el.addEventListener('click', (e) => {
      // Ctrl/Cmd-click toggles selection without playing
      if (e.ctrlKey || e.metaKey) {
        if (selectedTrackIds.has(track.id)) selectedTrackIds.delete(track.id);
        else selectedTrackIds.add(track.id);
        // re-render only this item class
        el.classList.toggle('selected', selectedTrackIds.has(track.id));
        return;
      }
      // Otherwise select single and play
      selectedTrackIds.clear();
      selectedTrackIds.add(track.id);
      // re-render library to update classes
      renderLibrary();
      playTrack(track);
    });
    
    // Context Menu
    el.oncontextmenu = (e) => {
      e.preventDefault();
      // If this item is not part of selection, select it only
      if (!selectedTrackIds.has(track.id)) {
        selectedTrackIds.clear();
        selectedTrackIds.add(track.id);
        renderLibrary();
      }
      // Build array of selected track objects to send to main
      const selected = tracks.filter(t => selectedTrackIds.has(t.id)).map(t => (typeof structuredClone === 'function' ? structuredClone(t) : JSON.parse(JSON.stringify(t))));
      electron.showTrackContextMenu(selected);
    };
    
    trackList.appendChild(el);
  }
};

// Load Library
const loadLibrary = async () => {
  libraryCache = await electron.getLibrary();
  
  const searchInput = document.getElementById('search-input');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  
  // If an album filter is active, scope the base set to that album first
  let base = libraryCache;
  if (currentAlbumFilter && currentAlbumFilter.album) {
    base = libraryCache.filter(t => {
      const trackAlbum = (t.album || '').toString().trim().toLowerCase();
      const trackArtist = (t.artist || '').toString().trim().toLowerCase();
      if (currentAlbumFilter.artist) {
        return trackAlbum === currentAlbumFilter.album && trackArtist === currentAlbumFilter.artist;
      }
      return trackAlbum === currentAlbumFilter.album;
    });
  } else if (currentArtistFilter) {
    base = libraryCache.filter(t => {
      const trackArtist = (t.artist || '').toString().trim().toLowerCase();
      return trackArtist === currentArtistFilter;
    });
  }

  if (query) {
    // Support prefixes: +term (required), -term (exclude), and field:value (title:, artist:, album:)
    const tokens = query.split(/\s+/).filter(Boolean);
    const parsed = tokens.map(tok => {
      let type = 'include';
      let text = tok;
      if (tok.startsWith('-')) { type = 'exclude'; text = tok.slice(1); }
      else if (tok.startsWith('+')) { type = 'include'; text = tok.slice(1); }
      // fielded search
      const m = text.match(/^(title|artist|album):(.+)$/);
      if (m) return { type, field: m[1], text: m[2] };
      return { type, field: null, text };
    });

    const matchesToken = (t, token) => {
      const text = (token.text || '').toLowerCase();
      if (!text) return true;
      if (token.field) {
        const v = ((t[token.field] || '') + '').toLowerCase();
        return v.includes(text);
      }
      // default: search title, artist, album
      const title = (t.title || '').toLowerCase();
      const artist = (t.artist || '').toLowerCase();
      const album = (t.album || '').toLowerCase();
      return title.includes(text) || artist.includes(text) || album.includes(text);
    };

    tracks = base.filter(t => {
      // All include tokens must match; no exclude tokens must match
      for (const tok of parsed) {
        if (tok.type === 'exclude') {
          if (matchesToken(t, tok)) return false;
        } else {
          // include
          if (!matchesToken(t, tok)) return false;
        }
      }
      return true;
    });
  } else {
    tracks = base;
  }
  
  renderLibrary();
};

// Render Albums view
function renderAlbums() {
  // Clear view
  viewAlbums.innerHTML = '<h2>Albums</h2>';

  electron.getAlbums().then((albums) => {
    if (!Array.isArray(albums) || albums.length === 0) {
      viewAlbums.innerHTML = '<div class="empty">No albums found</div>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'album-grid';

    for (const album of albums) {
      const card = document.createElement('div');
      card.className = 'album-card';

      const img = document.createElement('img');
      img.className = 'album-art';
      if (album.cover_path) {
        if (album.cover_path.startsWith('http') || album.cover_path.startsWith('data:')) {
          img.src = album.cover_path;
        } else {
          // Load via IPC to avoid file:// protocol security issues
          electron.getCoverImage(album.cover_path).then(dataUrl => {
            if (dataUrl) {
              img.src = dataUrl;
            } else {
              img.classList.add('placeholder');
            }
          }).catch(() => {
            img.classList.add('placeholder');
          });
        }
        img.alt = album.album || 'Album art';
      } else {
        img.classList.add('placeholder');
        img.alt = '';
      }

      const title = document.createElement('div');
      title.className = 'album-title';
      // DB returns album name as either `album` or `name` depending on source; normalize here
      const albumName = (album.album || album.name || '').toString();
      title.textContent = albumName || 'Unknown Album';

      const artist = document.createElement('div');
      artist.className = 'album-artist';
      artist.textContent = (album.artist || album.artist_name || 'Unknown Artist');

      const count = document.createElement('div');
      count.className = 'album-count';
      count.textContent = `${album.track_count || album.trackCount || 0} tracks`;

      card.appendChild(img);
      card.appendChild(title);
      card.appendChild(artist);
      card.appendChild(count);

      // Clicking an album filters the library view to that album
      // Use closure to capture current album value
      // Clicking an album filters the library view to that album. Preserve the filtered
      // view when switching programmatically to the library so the filter isn't immediately
      // overwritten by a full reload.
      card.onclick = ((albumToFilter) => {
        return async () => {
          const allTracks = await electron.getLibrary();
          // Get album name, handling both 'album' and 'name' properties
          const albumNameRaw = albumToFilter.album || albumToFilter.name || '';
          const nameToMatch = normalizeForCompare(albumNameRaw);
          
          const artistNameRaw = albumToFilter.artist || albumToFilter.artist_name || '';
          const artistToMatch = normalizeForCompare(artistNameRaw) || null;

          // Don't filter if album name is empty
          if (!nameToMatch) {
            console.warn('Album click: empty album name, skipping filter');
            return;
          }

          // Set the global album filter so searches are scoped to this album
          currentAlbumFilter = { album: nameToMatch, artist: artistToMatch };

          tracks = allTracks.filter(t => {
            const trackAlbum = normalizeForCompare(t.album || '');
            const trackArtist = normalizeForCompare(t.artist || '');
            if (artistToMatch) {
              return trackAlbum === nameToMatch && trackArtist === artistToMatch;
            }
            return trackAlbum === nameToMatch;
          });
          if (!tracks || tracks.length === 0) {
            console.warn('[renderAlbums] album click produced 0 matches for', { album: albumNameRaw, nameToMatch, artistToMatch });
          }
          renderLibrary();
          switchView('library', true); // preserve current filtered library (do not auto-reload)
        };
      })(album);

      grid.appendChild(card);
    }

    viewAlbums.appendChild(grid);
  }).catch((err) => {
    console.error('renderAlbums error', err);
    viewAlbums.innerHTML = '<div class="empty">Failed to load albums</div>';
  });
}

function renderArtists() {
  viewArtists.innerHTML = '<h2>Artists</h2>';

  electron.getArtists().then((artists) => {
    if (!Array.isArray(artists) || artists.length === 0) {
      viewArtists.innerHTML = '<div class="empty">No artists found</div>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'album-grid'; // Reuse album grid styles

    for (const artist of artists) {
      const card = document.createElement('div');
      card.className = 'album-card';

      const img = document.createElement('img');
      img.className = 'album-art';
      // Use artist image if available (from DB query)
      if (artist.cover_path) {
         if (artist.cover_path.startsWith('http') || artist.cover_path.startsWith('data:')) {
          img.src = artist.cover_path;
        } else {
          electron.getCoverImage(artist.cover_path).then(dataUrl => {
            if (dataUrl) img.src = dataUrl;
            else img.classList.add('placeholder');
          }).catch(() => img.classList.add('placeholder'));
        }
      } else {
        img.classList.add('placeholder');
      }
      
      const title = document.createElement('div');
      title.className = 'album-title';
      title.textContent = artist.name || 'Unknown Artist';

      const count = document.createElement('div');
      count.className = 'album-artist';
      count.textContent = `${artist.album_count} albums, ${artist.track_count} tracks`;

      card.appendChild(img);
      card.appendChild(title);
      card.appendChild(count);

      card.onclick = async () => {
        const allTracks = await electron.getLibrary();
        const artistToMatch = (artist.name || '').toString().trim().toLowerCase();
        
        currentArtistFilter = artistToMatch;
        currentAlbumFilter = null;

        tracks = allTracks.filter(t => {
          const trackArtist = (t.artist || '').toString().trim().toLowerCase();
          return trackArtist === artistToMatch;
        });
        renderLibrary();
        switchView('library', true);
      };

      grid.appendChild(card);
    }
    viewArtists.appendChild(grid);
  }).catch((err) => {
    console.error('renderArtists error', err);
    viewArtists.innerHTML = '<div class="empty">Failed to load artists</div>';
  });
}

// Play Track
const playTrack = async (track) => {
  currentTrack = track;
  // Show UI animation for now playing
  showNowPlaying();
  // record start as lastPlayed with zero elapsed until periodic saver updates it
  saveLastPlayed(currentTrack, 0);
  // Normalize sample rate: parse to integer and validate reasonable range
  let sr;
  if (settings.sampleRate) {
    const parsed = Number.parseInt(String(settings.sampleRate).trim(), 10);
    if (!Number.isNaN(parsed) && parsed > 8000 && parsed < 1000000) sr = parsed;
    else sr = undefined;
  } else sr = undefined;

  await electron.playTrack(track.path, {
    deviceId: settings.deviceId,
    mode: settings.mode,
    bitPerfect: settings.bitPerfect,
    strictBitPerfect: settings.strictBitPerfect,
    sampleRate: sr,
    volume: Number(volumeSlider.value), // Pass current volume as number
    track: track
  });
  isPlaying = true;
  updateNowPlaying();
  renderLibrary(); // Update active state
  updatePlayButton();
};

// Show a simple playback error notification with option to relink file
const showPlaybackError = async (errInfo) => {
  console.log('showPlaybackError called with', errInfo);
  if (!errInfo || !errInfo.filePath) return;
  const friendly = errInfo.message || 'Playback failed.';
  const wantRelink = window.confirm(`${friendly}\n\nFile: ${errInfo.filePath}\n\nLocate the file in a new location?`);
  console.log('user chose to relink:', wantRelink);
  if (!wantRelink) return;
  // Ask main process to let user pick a replacement file and update DB
  try {
    console.log('calling electron.relinkTrack');
    const result = await electron.relinkTrack({ filePath: errInfo.filePath, track: errInfo.track });
    console.log('relinkTrack returned:', result);
    // After relink, reload library so the path is updated
    await loadLibrary();
  } catch (e) {
    console.error('Failed to relink track', e);
  }
};

// Listen for playback errors from main and show relink prompt
electron.on('audio:error', (errInfo) => {
  showPlaybackError(errInfo);
});

// Update Now Playing UI
const updateNowPlaying = async () => {
  if (!currentTrack) return;
  npTitle.textContent = currentTrack.title || 'Unknown Title';
  npArtist.textContent = currentTrack.artist || 'Unknown Artist';
  
  if (currentTrack.cover_path) {
    if (currentTrack.cover_path.startsWith('http') || currentTrack.cover_path.startsWith('data:')) {
      npArt.src = currentTrack.cover_path;
      npArt.classList.remove('placeholder');
      npArt.style.display = 'block';
    } else {
      // Load via IPC to avoid file:// protocol security issues
      try {
        const dataUrl = await electron.getCoverImage(currentTrack.cover_path);
        if (dataUrl) {
          npArt.src = dataUrl;
          npArt.classList.remove('placeholder');
          npArt.style.display = 'block';
        } else {
          npArt.src = ''; 
          npArt.classList.add('placeholder');
          npArt.style.display = 'flex';
        }
      } catch (err) {
        npArt.src = ''; 
        npArt.classList.add('placeholder');
        npArt.style.display = 'flex';
      }
    }
  } else {
    npArt.src = ''; 
    npArt.classList.add('placeholder');
    npArt.style.display = 'flex'; // Flex for centering icon
  }
  
  totalTimeEl.textContent = formatTime(currentTrack.duration);
};

// Fullscreen view handlers
let currentSyncedLyrics = null; // Array of { time: number, text: string }

function parseSyncedLyrics(lrc) {
  const lines = lrc.split('\n');
  const result = [];
  const timeReg = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
  for (const line of lines) {
    const match = timeReg.exec(line);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = parseInt(match[3].padEnd(3, '0'), 10);
      const time = min * 60 + sec + ms / 1000;
      const text = line.replace(timeReg, '').trim();
      if (text) result.push({ time, text });
    }
  }
  return result;
}

function renderSyncedLyrics(lyricsData) {
  const fsLyrics = document.getElementById('fs-lyrics');
  if (!fsLyrics) return;
  fsLyrics.innerHTML = '';
  
  if (!lyricsData || lyricsData.length === 0) {
    fsLyrics.textContent = 'No synced lyrics available.';
    return;
  }

  lyricsData.forEach((line, index) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.dataset.time = line.time;
    div.dataset.index = index;
    div.textContent = line.text;
    div.onclick = () => {
      electron.seek(line.time);
    };
    fsLyrics.appendChild(div);
  });
}

function showFullscreen() {
  const overlay = document.getElementById('fullscreen-player');
  const fsArt = document.getElementById('fs-art');
  const fsBgArt = document.getElementById('fs-bg-art');
  const fsTitle = document.getElementById('fs-title');
  const fsArtist = document.getElementById('fs-artist');
  const fsLyrics = document.getElementById('fs-lyrics');
  
  // Progress elements
  const fsCurrentTime = document.getElementById('fs-current-time');
  const fsTotalTime = document.getElementById('fs-total-time');
  const fsProgressFill = document.getElementById('fs-progress-fill');

  // Controls
  const btnFsPlay = document.getElementById('fs-btn-play');
  const btnFsPrev = document.getElementById('fs-btn-prev');
  const btnFsNext = document.getElementById('fs-btn-next');
  const btnFsShuffle = document.getElementById('fs-btn-shuffle');
  const btnFsRepeat = document.getElementById('fs-btn-repeat');

  if (!overlay || !currentTrack) return;
  
  // Enter actual fullscreen
  electron.setFullscreen(true);

  // Populate
  fsTitle.textContent = currentTrack.title || 'Unknown Title';
  fsArtist.textContent = currentTrack.artist || 'Unknown Artist';
  
  // Update time immediately
  if (fsTotalTime) fsTotalTime.textContent = formatTime(currentTrack.duration);
  
  // Wire up controls
  if (btnFsPlay) {
    btnFsPlay.onclick = async () => {
      if (isPlaying) {
        await electron.pause();
        isPlaying = false;
      } else {
        // Resume logic similar to main play button
        try {
          const status = await electron.getAudioStatus();
          if (status && status.playing && status.paused) {
             await electron.resume();
          } else {
             // If for some reason we are not playing/paused, play current
             if (currentTrack) await playTrack(currentTrack);
             else await electron.resume();
          }
        } catch(e) { await electron.resume(); }
        isPlaying = true;
      }
      updatePlayButton();
    };
  }
  
  if (btnFsPrev) {
    btnFsPrev.onclick = () => {
      if (!currentTrack || tracks.length === 0) return;
      const idx = tracks.findIndex(t => t.id === currentTrack.id);
      if (idx > 0) {
        playTrack(tracks[idx - 1]);
      }
    };
  }

  if (btnFsNext) {
    btnFsNext.onclick = () => {
      if (!currentTrack || tracks.length === 0) return;
      const idx = tracks.findIndex(t => t.id === currentTrack.id);
      if (idx >= 0 && idx < tracks.length - 1) {
        playTrack(tracks[idx + 1]);
      }
    };
  }

  // Shuffle/Repeat logic
  if (btnFsShuffle) {
    btnFsShuffle.onclick = async () => {
      shuffleEnabled = !shuffleEnabled;
      await electron.setShuffle(shuffleEnabled);
      btnFsShuffle.classList.toggle('active', shuffleEnabled);
    };
    // Set initial state
    btnFsShuffle.classList.toggle('active', shuffleEnabled);
  }
  
  if (btnFsRepeat) {
    btnFsRepeat.onclick = async () => {
      // Cycle through: off -> all -> one -> off
      if (repeatMode === 'off') repeatMode = 'all';
      else if (repeatMode === 'all') repeatMode = 'one';
      else repeatMode = 'off';
      await electron.setRepeat(repeatMode);
      updateRepeatButton(btnFsRepeat);
    };
    updateRepeatButton(btnFsRepeat);
  }

  // Equalizer controls
  const eqEnabled = document.getElementById('eq-enabled');
  const eqPreset = document.getElementById('eq-preset');
  const eqSliders = document.querySelectorAll('.eq-slider');

  // Load current EQ state
  (async () => {
    try {
      const eq = await electron.getEQ();
      if (eq) {
        if (eqEnabled) eqEnabled.checked = eq.enabled;
        if (eqPreset) eqPreset.value = eq.preset;
        if (eq.bands && eqSliders.length === eq.bands.length) {
          eqSliders.forEach((slider, i) => {
            slider.value = eq.bands[i];
          });
        }
      }
    } catch (err) {
      console.error('Failed to load EQ state:', err);
    }
  })();

  // EQ event handlers
  if (eqEnabled) {
    eqEnabled.onchange = async () => {
      await electron.setEQEnabled(eqEnabled.checked);
    };
  }

  if (eqPreset) {
    eqPreset.onchange = async () => {
      await electron.setEQPreset(eqPreset.value);
      // Reload bands after preset change
      const eq = await electron.getEQ();
      if (eq && eq.bands && eqSliders.length === eq.bands.length) {
        eqSliders.forEach((slider, i) => {
          slider.value = eq.bands[i];
        });
      }
    };
  }

  if (eqSliders.length > 0) {
    eqSliders.forEach((slider, index) => {
      slider.oninput = async () => {
        // Get current bands
        const eq = await electron.getEQ();
        if (eq && eq.bands) {
          const newBands = [...eq.bands];
          newBands[index] = parseFloat(slider.value);
          await electron.setEQBands(newBands);
          // Switch to custom preset when manually adjusting
          if (eqPreset) {
            eqPreset.value = 'custom';
          }
        }
      };
    });
  }

  // Handle Art
  const setArt = (src) => {
    fsArt.src = src || '';
    if (fsBgArt) fsBgArt.src = src || '';
    if (!src) {
      fsArt.classList.add('placeholder');
    } else {
      fsArt.classList.remove('placeholder');
    }
  };

  if (currentTrack.cover_path) {
    if (currentTrack.cover_path.startsWith('http') || currentTrack.cover_path.startsWith('data:')) {
      setArt(currentTrack.cover_path);
    } else {
      // Local file, try to get it via IPC
      electron.getCoverImage(currentTrack.cover_path).then(dataUrl => {
        setArt(dataUrl);
      }).catch(() => setArt(''));
    }
  } else {
    setArt('');
  }

  // Reset lyrics state
  currentSyncedLyrics = null;
  fsLyrics.textContent = 'Loading lyrics…';

  (async () => {
    try {
      // Check if we already have lyrics in memory
      let lyricsText = currentTrack.lyrics;
      // Filter out bad data
      if (lyricsText === '[object Object]') lyricsText = null;
      
      let isSynced = false;

      // If not in memory, fetch
      if (!lyricsText) {
        const res = await electron.getLyrics({ filePath: currentTrack.path, external: true, artist: currentTrack.artist, title: currentTrack.title });
        if (res && res.lyrics && res.lyrics !== '[object Object]') {
          lyricsText = res.lyrics;
          isSynced = res.isSynced; // Flag from main process
          
          // Persist fetched lyrics into DB
          if (res.source === 'online' || res.source === 'embedded') {
            try {
              if (currentTrack && currentTrack.id) {
                const saveRes = await electron.saveLyrics({ trackId: currentTrack.id, lyrics: res.lyrics });
                if (saveRes && saveRes.success) {
                  currentTrack.lyrics = res.lyrics;
                }
              }
            } catch (saveErr) {
              console.warn('Failed to save lyrics:', saveErr);
            }
          }
        }
      } else {
        // Check if stored lyrics look like LRC
        if (lyricsText.includes('[00:')) isSynced = true;
      }

      if (lyricsText) {
        if (isSynced) {
          currentSyncedLyrics = parseSyncedLyrics(lyricsText);
          renderSyncedLyrics(currentSyncedLyrics);
        } else {
          fsLyrics.textContent = lyricsText;
        }
      } else {
        fsLyrics.textContent = 'Lyrics not available for this track.';
      }
    } catch (e) {
      if (currentTrack && currentTrack.lyrics) fsLyrics.textContent = currentTrack.lyrics;
      else fsLyrics.textContent = 'Lyrics not available for this track.';
    }
  })();

  overlay.classList.remove('hidden');

  // Close handlers
  const closeBtn = document.getElementById('fs-close');
  function escHandler(e) { if (e.key === 'Escape') hideFullscreen(); }
  closeBtn.onclick = hideFullscreen;
  document.addEventListener('keydown', escHandler);
  // store handler reference on element so we can remove later
  overlay._escHandler = escHandler;
  
  // Start updating progress bar in fullscreen
  startFullscreenProgressLoop();
}

let fsProgressInterval;
function startFullscreenProgressLoop() {
  if (fsProgressInterval) clearInterval(fsProgressInterval);
  const fsCurrentTime = document.getElementById('fs-current-time');
  const fsProgressFill = document.getElementById('fs-progress-fill');
  const btnFsPlay = document.getElementById('fs-btn-play');
  
  fsProgressInterval = setInterval(async () => {
    // Update Play/Pause Icon
    if (btnFsPlay) {
      const icon = btnFsPlay.querySelector('.material-icons');
      if (icon) icon.textContent = isPlaying ? 'pause_circle_filled' : 'play_circle_filled';
    }

    if (!isPlaying) return;
    const time = await electron.getAudioStatus().then(s => s.currentTime).catch(() => 0);
    if (fsCurrentTime) fsCurrentTime.textContent = formatTime(time);
    if (fsProgressFill && currentTrack && currentTrack.duration) {
      const pct = (time / currentTrack.duration) * 100;
      fsProgressFill.style.width = `${pct}%`;
    }

    // Update Synced Lyrics
    if (currentSyncedLyrics && currentSyncedLyrics.length > 0) {
      const fsLyrics = document.getElementById('fs-lyrics');
      // Find current line
      let activeIndex = -1;
      for (let i = 0; i < currentSyncedLyrics.length; i++) {
        if (time >= currentSyncedLyrics[i].time) {
          activeIndex = i;
        } else {
          break;
        }
      }

      if (activeIndex !== -1) {
        const lines = fsLyrics.querySelectorAll('.lyric-line');
        lines.forEach((line, idx) => {
          if (idx === activeIndex) {
            if (!line.classList.contains('active')) {
              line.classList.add('active');
              line.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          } else {
            line.classList.remove('active');
          }
        });
      }
    }
  }, 500); // Update faster for smoother lyrics
}

function hideFullscreen() {
  const overlay = document.getElementById('fullscreen-player');
  if (!overlay) return;
  
  // Exit actual fullscreen
  electron.setFullscreen(false);
  
  overlay.classList.add('hidden');
  const handler = overlay._escHandler;
  if (handler) {
    document.removeEventListener('keydown', handler);
    overlay._escHandler = null;
  }
  if (fsProgressInterval) clearInterval(fsProgressInterval);
}

// Attach click on now-playing art to toggle fullscreen
function initFullscreenClick() {
  const npArtEl = document.getElementById('np-art');
  if (npArtEl) {
    npArtEl.style.cursor = 'pointer';
    npArtEl.onclick = () => {
      if (!currentTrack) return;
      showFullscreen();
    };
  }

  // Fullscreen seek bar
  const fsProgressBar = document.querySelector('.fs-progress-bar');
  if (fsProgressBar) {
    fsProgressBar.style.cursor = 'pointer';
    fsProgressBar.onclick = (e) => {
      if (!currentTrack || !currentTrack.duration) return;
      const rect = fsProgressBar.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, x / rect.width));
      const time = pct * currentTrack.duration;
      electron.seek(time);
      
      // Optimistic update
      const fsProgressFill = document.getElementById('fs-progress-fill');
      if (fsProgressFill) fsProgressFill.style.width = `${pct * 100}%`;
      const fsCurrentTime = document.getElementById('fs-current-time');
      if (fsCurrentTime) fsCurrentTime.textContent = formatTime(time);
    };
  }
}

// Lyrics editor handlers
function initLyricsEditor() {
  const editBtn = document.getElementById('fs-edit-lyrics');
  const editor = document.getElementById('fs-lyrics-editor');
  const display = document.getElementById('fs-lyrics');
  const textarea = document.getElementById('fs-lyrics-textarea');
  const saveBtn = document.getElementById('fs-lyrics-save');
  const cancelBtn = document.getElementById('fs-lyrics-cancel');
  if (!editBtn || !editor || !display || !textarea || !saveBtn || !cancelBtn) return;

  editBtn.onclick = () => {
    // populate editor with current lyrics if any
    if (currentTrack && currentTrack.lyrics) {
      textarea.value = currentTrack.lyrics;
    } else if (display.textContent === 'Lyrics not available for this track.') {
      textarea.value = '';
    } else {
      textarea.value = display.textContent || '';
    }
    editor.classList.remove('hidden');
    display.classList.add('hidden');
  };

  cancelBtn.onclick = () => {
    editor.classList.add('hidden');
    display.classList.remove('hidden');
  };

  saveBtn.onclick = async () => {
    const text = textarea.value || '';
    // Persist via IPC
    try {
      if (currentTrack && currentTrack.id) {
        const res = await electron.saveLyrics({ trackId: currentTrack.id, lyrics: text });
        if (res && res.success) {
          // reflect saved lyrics in UI and in-memory track object
          display.textContent = text || 'Lyrics not available for this track.';
          if (currentTrack) currentTrack.lyrics = text;
        }
      }
    } catch (err) {
      console.warn('Failed to save lyrics', err);
    }
    editor.classList.add('hidden');
    display.classList.remove('hidden');
  };
}


const updatePlayButton = () => {
  const icon = btnPlay.querySelector('.material-icons');
  icon.textContent = isPlaying ? 'pause_circle_filled' : 'play_circle_filled';
};

// Event listeners are attached in init()

// Search
const initSearch = () => {
  const searchInput = document.getElementById('search-input');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    
    // If searching, ensure we are on the library view
    if (query) {
      switchView('library', true);
    }
    // Determine base set: either whole library or scoped to selected album
    let base = libraryCache;
    if (currentAlbumFilter && currentAlbumFilter.album) {
      base = libraryCache.filter(t => {
        const trackAlbum = (t.album || '').toString().toLowerCase();
        const trackArtist = (t.artist || '').toString().toLowerCase();
        if (currentAlbumFilter.artist) return trackAlbum === currentAlbumFilter.album && trackArtist === currentAlbumFilter.artist;
        return trackAlbum === currentAlbumFilter.album;
      });
    }

    if (!query) {
      tracks = base;
    } else {
      const tokens = query.split(/\s+/).filter(Boolean);
      const parsed = tokens.map(tok => {
        let type = 'include';
        let text = tok;
        if (tok.startsWith('-')) { type = 'exclude'; text = tok.slice(1); }
        else if (tok.startsWith('+')) { type = 'include'; text = tok.slice(1); }
        const m = text.match(/^(title|artist|album):(.+)$/);
        if (m) return { type, field: m[1], text: m[2] };
        return { type, field: null, text };
      });

      const matchesToken = (t, token) => {
        const text = (token.text || '').toLowerCase();
        if (!text) return true;
        if (token.field) {
          const v = ((t[token.field] || '') + '').toLowerCase();
          return v.includes(text);
        }
        const title = (t.title || '').toLowerCase();
        const artist = (t.artist || '').toLowerCase();
        const album = (t.album || '').toLowerCase();
        return title.includes(text) || artist.includes(text) || album.includes(text);
      };

      tracks = base.filter(t => {
        for (const tok of parsed) {
          if (tok.type === 'exclude') {
            if (matchesToken(t, tok)) return false;
          } else {
            if (!matchesToken(t, tok)) return false;
          }
        }
        return true;
      });
    }
    renderLibrary();
  });
};

// Sync state from server
const syncState = (state) => {
  if (!state) return;
  
  // Update isPlaying
  isPlaying = state.playing && !state.paused;
  updatePlayButton();

  // Update currentTrack if changed
  if (state.track && (!currentTrack || currentTrack.id !== state.track.id)) {
      currentTrack = state.track;
      updateNowPlaying();
      renderLibrary();
  }

  // Update Volume
  if (volumeSlider && state.volume !== undefined) {
      if (document.activeElement !== volumeSlider) {
           volumeSlider.value = state.volume;
      }
  }
};

// Plugin System API (sandboxed via factory)
const SPECTRA_PLUGIN_API_VERSION = 1;

// Internal plugin registry: tracks registrations and nodes created by plugins
const _pluginRegistry = new Map(); // pluginId -> [ { selector, initFn, nodes: Set<Element> } ]
let _pluginMutationObserver = null;
function _ensurePluginObserver() {
  if (_pluginMutationObserver) return;
  try {
    _pluginMutationObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes || [])) {
          if (node.nodeType !== 1) continue;
          for (const [pluginId, regs] of _pluginRegistry.entries()) {
            for (const reg of regs) {
              try {
                if (node.matches && node.matches(reg.selector)) {
                  // call init for this matched node
                  try {
                    const res = reg.initFn(node, pluginId) || null;
                    let globals = null;
                    let nodes = null;
                    if (res && typeof res === 'object' && !Array.isArray(res) && (res.nodes || res.globals)) {
                      nodes = res.nodes || null;
                      globals = res.globals || null;
                    } else if (res) {
                      nodes = Array.isArray(res) ? res : [res];
                    }
                    if (nodes) {
                      for (const n of nodes) if (n && n instanceof Element) { n.dataset.pluginId = pluginId; reg.nodes.add(n); }
                    } else {
                      node.dataset.pluginId = pluginId;
                      reg.nodes.add(node);
                    }
                    if (globals && Array.isArray(globals)) {
                      reg.globals = reg.globals || new Set();
                      for (const g of globals) {
                        try { reg.globals.add(g); } catch (ee) {}
                      }
                    }
                  } catch (e) { console.error('plugin initFn error:', e); }
                }
                // also check descendants
                const found = node.querySelectorAll ? node.querySelectorAll(reg.selector) : [];
                for (const f of Array.from(found || [])) {
                  try {
                    const res = reg.initFn(f, pluginId) || null;
                    let globals = null;
                    let nodes = null;
                    if (res && typeof res === 'object' && !Array.isArray(res) && (res.nodes || res.globals)) {
                      nodes = res.nodes || null;
                      globals = res.globals || null;
                    } else if (res) {
                      nodes = Array.isArray(res) ? res : [res];
                    }
                    if (nodes) {
                      for (const n of nodes) if (n && n instanceof Element) { n.dataset.pluginId = pluginId; reg.nodes.add(n); }
                    } else {
                      f.dataset.pluginId = pluginId;
                      reg.nodes.add(f);
                    }
                    if (globals && Array.isArray(globals)) {
                      reg.globals = reg.globals || new Set();
                      for (const g of globals) {
                        try { reg.globals.add(g); } catch (ee) {}
                      }
                    }
                  } catch (e) { console.error('plugin initFn error:', e); }
                }
              } catch (err) {
                // ignore per-registration errors
              }
            }
          }
        }
      }
    });
    if (document && document.body) _pluginMutationObserver.observe(document.body, { childList: true, subtree: true });
  } catch (e) {
    console.warn('Failed to create plugin mutation observer:', e);
    _pluginMutationObserver = null;
  }
}

const Spectra = {
  core: {
    getApiVersion: () => SPECTRA_PLUGIN_API_VERSION,
    getVersion: () => '1.0.0'
  },
  ui: {
    addNowPlayingButton: ({ id, icon, title, onClick }) => {
      const container = document.getElementById('plugin-controls');
      if (!container) return;
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      if (title) btn.title = title;
      btn.dataset.pluginId = id;
      btn.innerHTML = `<span class="material-icons">${icon}</span>`;
      btn.onclick = onClick;
      container.appendChild(btn);
    },
    registerFullscreenView: ({ id, render }) => {
      const container = document.getElementById('plugin-overlays');
      if (!container) return;
      let div = document.getElementById(id);
      if (!div) {
        div = document.createElement('div');
        div.id = id;
        div.className = 'fullscreen-overlay hidden';
        container.appendChild(div);
      }
      render(div);
    },
    showFullscreenView: (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('hidden');
      const handler = (e) => {
        if (e.key === 'Escape') {
          el.classList.add('hidden');
          document.removeEventListener('keydown', handler);
        }
      };
      document.addEventListener('keydown', handler);
    },
    hideFullscreenView: (id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    }
    ,
    // Register a selector so the plugin can attach UI to elements developers add
    // `initFn(container, pluginId)` should either mutate the container or return
    // the created node (or array of nodes). Returned nodes will be tracked for cleanup.
    registerTarget: (pluginId, selector, initFn) => {
      try {
        if (!pluginId || !selector || typeof initFn !== 'function') return;
        let regs = _pluginRegistry.get(pluginId) || [];
        const reg = { selector, initFn, nodes: new Set() };
        regs.push(reg);
        _pluginRegistry.set(pluginId, regs);

        // Attach to any existing matching elements
        try {
          document.querySelectorAll(selector).forEach(el => {
            try {
              const res = initFn(el, pluginId) || null;
              if (res) {
                const arr = Array.isArray(res) ? res : [res];
                for (const n of arr) if (n && n instanceof Element) { n.dataset.pluginId = pluginId; reg.nodes.add(n); }
              } else {
                el.dataset.pluginId = pluginId;
                reg.nodes.add(el);
              }
            } catch (e) { console.error('plugin initFn error:', e); }
          });
        } catch (e) { /* ignore selector errors */ }

        // Ensure we observe future DOM insertions
        _ensurePluginObserver();
      } catch (e) {
        console.warn('registerTarget failed', e);
      }
    },
    // Remove all registered targets and nodes for a plugin (cleanup)
    unregisterPluginTargets: (pluginId) => {
      try {
        const regs = _pluginRegistry.get(pluginId) || [];
        for (const reg of regs) {
          for (const n of Array.from(reg.nodes || [])) {
            try {
              if (n && n.parentNode) n.parentNode.removeChild(n);
              if (n && n.dataset) delete n.dataset.pluginId;
            } catch (e) { /* ignore per-node removal errors */ }
          }
          // Remove any globals the plugin promised to expose
          if (reg.globals && reg.globals.size) {
            try {
              for (const g of Array.from(reg.globals)) {
                try { if (window && window[g]) delete window[g]; } catch (ee) {}
                try { if (window.Spectra && window.Spectra.plugins && window.Spectra.plugins[pluginId]) delete window.Spectra.plugins[pluginId][g]; } catch (ee) {}
              }
            } catch (e) {}
          }
          // Attempt to remove any IPC listeners the plugin may have registered
          try {
            if (window && window.electron && typeof window.electron.off === 'function') {
              try { window.electron.off(`${pluginId}:files`); } catch (e) {}
              try { window.electron.off(`${pluginId}:status`); } catch (e) {}
            }
          } catch (e) {}
        }
        _pluginRegistry.delete(pluginId);
      } catch (e) {
        console.warn('unregisterPluginTargets failed', e);
      }
    }
  },
  library: {
    getTracks: async () => electron.getLibrary(),
    onChanged: (cb) => {
      electron.on('import:complete', cb);
    }
  },
  playback: {
    getCurrentTrack: () => currentTrack,
    onTrackChanged: (cb) => {
      electron.on('player:state', (state) => {
        if (state && state.track) cb(state.track, state);
      });
    },
    onTime: (cb) => {
      setInterval(async () => {
        if (!currentTrack) return;
        const t = await electron.getTime();
        cb(t, currentTrack);
      }, 1000);
    },
    play: (path, options) => electron.playTrack(path, options || {}),
    pause: () => electron.pause(),
    resume: () => electron.resume(),
    seek: (time) => electron.seek(time),
    setVolume: (v) => electron.setVolume(v)
  },
  storage: {
    getStore: (pluginId) => ({
      get: (key, defVal) => {
        const raw = localStorage.getItem(`plugin_${pluginId}`);
        if (!raw) return defVal;
        try {
          const obj = JSON.parse(raw);
          return key in obj ? obj[key] : defVal;
        } catch {
          return defVal;
        }
      },
      set: (key, value) => {
        let obj = {};
        const raw = localStorage.getItem(`plugin_${pluginId}`);
        if (raw) {
          try { obj = JSON.parse(raw) || {}; } catch { obj = {}; }
        }
        obj[key] = value;
        localStorage.setItem(`plugin_${pluginId}`, JSON.stringify(obj));
      }
    })
  }
};

// Renderer-side plugin lifecycle hooks: allow main to notify renderer
async function cleanupPluginDOM() {
  try {
    const pluginControls = document.getElementById('plugin-controls');
    const pluginOverlays = document.getElementById('plugin-overlays');
    if (pluginControls) pluginControls.innerHTML = '';
    if (pluginOverlays) pluginOverlays.innerHTML = '';

    // Remove elements that explicitly mark plugin ownership
    document.querySelectorAll('[data-plugin-id]').forEach(el => el.remove());

    // Remove plugin UI elements but preserve settings UI elements
    // Don't remove: plugins-list, plugin-card, plugin-settings, plugin-toggle, plugin-status
    document.querySelectorAll('[id^="plugin-view-"]').forEach(el => el.remove());
    document.querySelectorAll('[id^="plugin-nav-"]').forEach(el => el.remove());
    document.querySelectorAll('.spectra-plugin').forEach(el => el.remove());

    // Additionally, remove DOM nodes and assets that reference disabled plugins.
    // Ask the main process for the current plugin list and remove any elements
    // that include the plugin id in id/src/href attributes (covers plugins
    // that create ids like `view-object-storage`, `nav-object-storage`, or
    // add stylesheet links like `plugins://object-storage/styles.css`).
    let plugins = [];
    try {
      plugins = await electron.getPlugins();
    } catch (e) {
      // If we can't get the list, fall back to best-effort cleanup above
      plugins = [];
    }

    for (const p of plugins) {
      // If plugin is enabled, skip aggressive removals for it
      if (p.enabled) continue;

      // Ensure any registered targets for this disabled plugin are removed
      try { Spectra.ui.unregisterPluginTargets(p.id); } catch (e) {}

      const pid = p.id;
      if (!pid) continue;

      // Remove nav/view elements specifically (common plugin UI pattern)
      try { document.getElementById(`nav-${pid}`)?.remove(); } catch (e) {}
      try { document.getElementById(`view-${pid}`)?.remove(); } catch (e) {}
      
      // Remove plugin-prefixed elements (but not settings UI)
      try {
        document.querySelectorAll(`[id^="${pid}-"]`).forEach(el => el.remove());
      } catch (e) { /* ignore selector errors */ }

      // Remove stylesheet/script/img/link tags referencing the plugin via plugins://
      try {
        document.querySelectorAll(`link[href*="plugins://${pid}/"], script[src*="plugins://${pid}/"], img[src*="plugins://${pid}/"]`).forEach(el => el.remove());
      } catch (e) {}

      // Remove a well-known style id pattern used by some plugins
      try { document.getElementById(`style-${pid}`)?.remove(); } catch (e) {}
    }

  } catch (err) {
    console.warn('cleanupPluginDOM error:', err);
  }
}

// Listen for main process reload notifications
try {
  electron.on('plugins:will-reload', async () => {
    try {
      await cleanupPluginDOM();
    } catch (e) {}
    // Notify main we're ready for it to proceed with deactivation
    try { if (typeof electron.signalPluginsReadyForReload === 'function') electron.signalPluginsReadyForReload(); } catch (e) {}
  });
  electron.on('plugins:reloaded', () => {
    // Re-run plugin loading in renderer to pick up new/updated UI entries
    try { loadPlugins(); } catch (e) { console.warn('Failed to reload plugins in renderer', e); }
  });
} catch (e) {
  // If electron.on is not available for some reason, ignore silently
}

const loadPlugins = async () => {
  try {
    const plugins = await electron.getPlugins();
    const pluginsListEl = document.getElementById('plugins-list');
    if (pluginsListEl) pluginsListEl.innerHTML = '';

    // FIRST: Clean up all disabled plugin DOM elements
    for (const p of plugins) {
      if (!p.enabled && p.id) {
        const pid = p.id;
        console.log(`[renderer] Cleaning up disabled plugin DOM: ${pid}`);
        try {
          // Remove nav/view elements
          document.getElementById(`nav-${pid}`)?.remove();
          document.getElementById(`view-${pid}`)?.remove();
          // Remove any elements with IDs starting with the plugin ID
          document.querySelectorAll(`[id^="${pid}-"]`).forEach(el => el.remove());
          // Remove plugin assets
          document.querySelectorAll(`link[href*="plugins://${pid}/"], script[src*="plugins://${pid}/"], img[src*="plugins://${pid}/"]`).forEach(el => el.remove());
          document.getElementById(`style-${pid}`)?.remove();
        } catch (e) {
          console.warn(`Failed to cleanup ${pid}:`, e);
        }
      }
    }

    // Generic cleanup: remove any DOM nodes that plugins may have added
    // Plugins should set `dataset.pluginId` or predictable ids like `plugin-...`,
    // but some plugins may append arbitrary nodes — remove common patterns.
    // Note: cleanupPluginDOM() is called separately by the plugins:will-reload event
    try {
      // Remove elements that explicitly mark plugin ownership
      document.querySelectorAll('[data-plugin-id]').forEach(el => el.remove());

      // Remove plugin UI elements but NOT settings UI (avoid removing plugins-list, plugin-card, etc.)
      document.querySelectorAll('[id^="plugin-view-"]').forEach(el => el.remove());
      document.querySelectorAll('[id^="plugin-nav-"]').forEach(el => el.remove());
      document.querySelectorAll('.spectra-plugin').forEach(el => el.remove());
    } catch (cleanupErr) {
      console.warn('Plugin cleanup error:', cleanupErr);
    }

    for (const p of plugins) {
      // Render in settings UI
      if (pluginsListEl) {
        const card = document.createElement('div');
        card.className = 'plugin-card';

        const iconSrc = p.icon ? `plugins://${p.id}/${p.icon}` : '';
        const iconHtml = iconSrc ? `<img src="${iconSrc}" alt="${p.name || p.id} icon" style="width:100%;height:100%;object-fit:contain;">` : '<span class="material-icons">extension</span>';

        // Build settings HTML if settings exist
        let settingsHtml = '';
        if (p.settings && typeof p.settings === 'object') {
          settingsHtml = '<div class="plugin-settings">';
          for (const [key, value] of Object.entries(p.settings)) {
            const settingId = `plugin-setting-${p.id}-${key}`;
            // Render a provider dropdown for the object-storage plugin
            if (p.id === 'object-storage' && key === 'provider') {
              const options = ['minio','s3','gcs','digitalocean','wasabi','backblaze'];
              let optsHtml = '';
              for (const o of options) {
                optsHtml += `<option value="${o}" ${String(value) === o ? 'selected' : ''}>${o}</option>`;
              }
              settingsHtml += `
                <div class="setting-item">
                  <label for="${settingId}">Provider</label>
                  <select id="${settingId}" data-setting-key="${key}">
                    ${optsHtml}
                  </select>
                </div>`;
            } else if (typeof value === 'boolean') {
              settingsHtml += `
                <div class="setting-item checkbox">
                  <input type="checkbox" id="${settingId}" ${value ? 'checked' : ''} data-setting-key="${key}">
                  <label for="${settingId}">${key}</label>
                </div>`;
            } else if (typeof value === 'string') {
              settingsHtml += `
                <div class="setting-item">
                  <label for="${settingId}">${key}</label>
                  <input type="text" id="${settingId}" value="${value || ''}" data-setting-key="${key}">
                </div>`;
            } else if (typeof value === 'number') {
              settingsHtml += `
                <div class="setting-item">
                  <label for="${settingId}">${key}</label>
                  <input type="number" id="${settingId}" value="${value}" data-setting-key="${key}">
                </div>`;
            }
          }
          settingsHtml += '</div>';
        }

        card.innerHTML = `
          <div class="plugin-header">
            <div class="plugin-icon">${iconHtml}</div>
            <div class="plugin-meta">
              <div class="plugin-name">${p.name || p.id}</div>
              <div class="plugin-info">${p.author || ''} ${p.version ? '• v' + p.version : ''}</div>
            </div>
          </div>
          <div class="plugin-description">${p.description || 'No description available.'}</div>
          ${settingsHtml}
          <div class="plugin-actions">
            <label class="plugin-toggle">
              <input type="checkbox" ${p.enabled ? 'checked' : ''} />
              <span>Enabled</span>
            </label>
            <div class="plugin-status">${p.enabled ? 'Active' : 'Disabled'}</div>
          </div>`;

        const checkbox = card.querySelector('.plugin-toggle input[type="checkbox"]');
        checkbox.addEventListener('change', async (e) => {
          try {
            const newEnabledState = e.target.checked;
            await electron.setPluginEnabled(p.id, newEnabledState);
            // Update status text
            const statusEl = card.querySelector('.plugin-status');
            if (statusEl) statusEl.textContent = newEnabledState ? 'Active - Reload to apply' : 'Disabled - Reload to apply';
            
            // Update the local plugin object
            p.enabled = newEnabledState;
            
            // If disabling, immediately clean up plugin DOM elements
            if (!newEnabledState) {
              const pid = p.id;
              console.log(`[renderer] User disabled plugin ${pid}, cleaning up DOM`);
              try {
                // Remove nav/view elements specifically
                document.getElementById(`nav-${pid}`)?.remove();
                document.getElementById(`view-${pid}`)?.remove();
                // Remove plugin-prefixed elements (but not settings UI card)
                document.querySelectorAll(`[id^="${pid}-"]:not(.plugin-card):not(.plugin-card *)`).forEach(el => {
                  console.log(`[renderer] Removing element: ${el.id}`);
                  el.remove();
                });
                // Remove plugin assets
                document.querySelectorAll(`link[href*="plugins://${pid}/"], script[src*="plugins://${pid}/"], img[src*="plugins://${pid}/"]`).forEach(el => {
                  console.log(`[renderer] Removing asset: ${el.tagName} ${el.href || el.src}`);
                  el.remove();
                });
                document.getElementById(`style-${pid}`)?.remove();
                // Unregister plugin UI targets
                if (typeof Spectra !== 'undefined' && Spectra.ui && Spectra.ui.unregisterPluginTargets) {
                  Spectra.ui.unregisterPluginTargets(pid);
                }
                console.log(`[renderer] Cleanup complete for ${pid}`);
              } catch (cleanupErr) {
                console.warn(`Failed to cleanup DOM for plugin ${pid}:`, cleanupErr);
              }
            } else {
              // If enabling, user should click "Reload Plugins" to activate
              console.log(`[renderer] User enabled plugin ${p.id}, will activate on next reload`);
            }
          } catch (err) {
            console.error('Failed to toggle plugin:', err);
            // Revert checkbox on error
            e.target.checked = !e.target.checked;
          }
        });

        // Add listeners for settings inputs
        const settingInputs = card.querySelectorAll('.plugin-settings input, .plugin-settings select, .plugin-settings textarea');
        settingInputs.forEach(input => {
          input.addEventListener('change', async (e) => {
            const settingKey = e.target.dataset.settingKey;
            let settingValue;
            if (e.target.type === 'checkbox') {
              settingValue = e.target.checked;
            } else if (e.target.type === 'number') {
              settingValue = parseFloat(e.target.value) || 0;
            } else {
              settingValue = e.target.value;
            }
            
            // Update the settings object
            const updatedSettings = { ...p.settings };
            updatedSettings[settingKey] = settingValue;
            
            // Save to backend. Do NOT reload all plugins automatically —
            // let the user decide when to reload to avoid disruptive restarts.
            try {
              await electron.updatePluginSettings(p.id, updatedSettings);
              // Optionally show a brief notice in the UI (status text)
              const statusEl = card.querySelector('.plugin-status');
              if (statusEl) {
                statusEl.textContent = 'Saved — click Reload to apply';
                setTimeout(() => { statusEl.textContent = p.enabled ? 'Active' : 'Disabled'; }, 3000);
              }
            } catch (err) {
              console.error('Failed to save plugin settings:', err);
            }
            // Update local plugin reference
            p.settings = updatedSettings;
          });
        });

        pluginsListEl.appendChild(card);
      }

      // Load enabled plugins into runtime
      // IMPORTANT: Check enabled status BEFORE fetching/executing plugin code
      if (!p.enabled) {
        console.log(`[renderer] Skipping disabled plugin UI: ${p.id}`);
        continue;
      }
      if (!p.entry) {
        console.log(`[renderer] Plugin ${p.id} has no entry point, skipping UI load`);
        continue;
      }
      
      // Double-check plugin is still enabled before loading UI (prevents race conditions)
      try {
        const latestPlugins = await electron.getPlugins();
        const latestState = latestPlugins.find(x => x.id === p.id);
        if (!latestState || !latestState.enabled) {
          console.log(`[renderer] Plugin ${p.id} was disabled, skipping UI load`);
          continue;
        }
      } catch (checkErr) {
        console.warn(`[renderer] Could not verify plugin ${p.id} state, proceeding with caution:`, checkErr);
      }
      
      try {
        // Resolve plugin entry path. If the manifest provides a relative path
        // (e.g. "ui.js"), fetch it via the registered `plugins://` protocol
        // so it loads from the plugin folder in the app's data or repo plugins.
        let entryUrl = p.entry;
        // If entry looks like a simple filename (no scheme/host), build plugins:// URL
        if (!/^\w+:\/\//.test(entryUrl) && !entryUrl.startsWith('plugins://') && !entryUrl.startsWith('/')) {
          entryUrl = `plugins://${p.id}/${entryUrl}`;
        }

        console.log(`[renderer] Loading plugin UI: ${p.id} from ${entryUrl}`);
        const res = await fetch(entryUrl);
        const code = await res.text();
        const factory = new Function('Spectra', 'pluginId', code);
        factory(Spectra, p.id);
        console.log(`[renderer] Successfully loaded plugin UI: ${p.id}`);
      } catch (e) {
        console.error('Failed to execute plugin', p.id, e);
      }
    }
  } catch (e) {
    console.error('Failed to load plugins:', e);
  }
};

// Initialize on DOM ready: assign DOM elements and attach listeners
async function init() {
  // Assign DOM elements
  trackList = document.getElementById('track-list');
  btnPlay = document.getElementById('btn-play');
  btnPrev = document.getElementById('btn-prev');
  btnNext = document.getElementById('btn-next');
  const btnShuffle = document.getElementById('btn-shuffle');
  const btnRepeat = document.getElementById('btn-repeat');
  const btnQueue = document.getElementById('btn-queue');
  seekSlider = document.getElementById('seek-slider');
  volumeSlider = document.getElementById('volume-slider');
  npTitle = document.getElementById('np-title');
  npArtist = document.getElementById('np-artist');
  npArt = document.getElementById('np-art');
  currentTimeEl = document.getElementById('current-time');
  totalTimeEl = document.getElementById('total-time');

  // Queue panel elements
  const queuePanel = document.getElementById('queue-panel');
  const btnCloseQueue = document.getElementById('btn-close-queue');
  const btnClearQueue = document.getElementById('btn-clear-queue');
  const queueList = document.getElementById('queue-list');

  deviceSelect = document.getElementById('device-select');
  modeSelect = document.getElementById('mode-select');
  bitPerfectCheckbox = document.getElementById('bitperfect-checkbox');
  strictBitPerfectCheckbox = document.getElementById('strict-bitperfect-checkbox');
  remoteEnableCheckbox = document.getElementById('remote-enable-checkbox');
  sampleRateSelect = document.getElementById('samplerate-select');
  sampleRateCustomInput = document.getElementById('samplerate-custom');

  // Plugins reload button
  const btnReloadPlugins = document.getElementById('btn-reload-plugins');
  if (btnReloadPlugins) {
    btnReloadPlugins.onclick = async () => {
      try {
        btnReloadPlugins.disabled = true;
        btnReloadPlugins.textContent = 'Reloading...';
        // Just trigger the reload - the plugins:reloaded event handler will call loadPlugins()
        await electron.reloadPlugins();
        btnReloadPlugins.textContent = 'Reload Plugins';
      } catch (e) {
        console.error('Failed to reload plugins:', e);
        btnReloadPlugins.textContent = 'Reload Failed';
      } finally {
        btnReloadPlugins.disabled = false;
        setTimeout(() => {
          btnReloadPlugins.textContent = 'Reload Plugins';
        }, 2000);
      }
    };
  }

  navLibrary = document.getElementById('nav-library');
  navPlaylists = document.getElementById('nav-playlists');
  navSettings = document.getElementById('nav-settings');
  navAlbums = document.getElementById('nav-albums');
  navArtists = document.getElementById('nav-artists');
  viewLibrary = document.getElementById('view-library');
  viewPlaylists = document.getElementById('view-playlists');
  viewSettings = document.getElementById('view-settings');
  viewAlbums = document.getElementById('view-albums');
  viewArtists = document.getElementById('view-artists');

  btnImportFile = document.getElementById('btn-import-file');
  btnImportFolder = document.getElementById('btn-import-folder');
  const btnNewPlaylist = document.getElementById('btn-new-playlist');
  btnImportUrl = document.getElementById('btn-import-url');
  const btnImportPlaylist = document.getElementById('btn-import-playlist');

  editModal = document.getElementById('edit-modal');
  editTitle = document.getElementById('edit-title');
  editArtist = document.getElementById('edit-artist');
  editAlbum = document.getElementById('edit-album');
  btnSaveEdit = document.getElementById('btn-save-edit');
  btnCancelEdit = document.getElementById('btn-cancel-edit');

  notificationBar = document.getElementById('notification-bar');
  notificationMessage = document.getElementById('notification-message');
  notificationProgress = document.getElementById('notification-progress');
  notificationCount = document.getElementById('notification-count');

  // Settings event listeners
  if (deviceSelect) deviceSelect.onchange = saveSettings;
  if (modeSelect) modeSelect.onchange = saveSettings;
  if (bitPerfectCheckbox) bitPerfectCheckbox.onchange = saveSettings;
  if (strictBitPerfectCheckbox) strictBitPerfectCheckbox.onchange = saveSettings;
  if (remoteEnableCheckbox) remoteEnableCheckbox.onchange = saveSettings;

  // Queue panel handlers
  if (btnQueue) {
    btnQueue.onclick = async () => {
      if (queuePanel) {
        queuePanel.classList.toggle('hidden');
        if (!queuePanel.classList.contains('hidden')) {
          await renderQueue();
        }
      }
    };
  }

  if (btnCloseQueue) {
    btnCloseQueue.onclick = () => {
      if (queuePanel) queuePanel.classList.add('hidden');
    };
  }

  if (btnClearQueue) {
    btnClearQueue.onclick = async () => {
      await electron.clearQueue();
      playbackQueue = [];
      queueIndex = -1;
      await renderQueue();
    };
  }

  // Shuffle/Repeat handlers for main player
  if (btnShuffle) {
    btnShuffle.onclick = async () => {
      shuffleEnabled = !shuffleEnabled;
      await electron.setShuffle(shuffleEnabled);
      btnShuffle.classList.toggle('active', shuffleEnabled);
    };
  }

  if (btnRepeat) {
    btnRepeat.onclick = async () => {
      if (repeatMode === 'off') repeatMode = 'all';
      else if (repeatMode === 'all') repeatMode = 'one';
      else repeatMode = 'off';
      await electron.setRepeat(repeatMode);
      updateRepeatButton(btnRepeat);
    };
  }

  // Load initial states
  (async () => {
    try {
      const modes = await electron.getPlayerModes();
      if (modes) {
        shuffleEnabled = modes.shuffle;
        repeatMode = modes.repeat;
        if (btnShuffle) btnShuffle.classList.toggle('active', shuffleEnabled);
        if (btnRepeat) updateRepeatButton(btnRepeat);
      }
    } catch (err) {
      console.error('Failed to load player modes:', err);
    }
  })();

  // Navigation
  if (navLibrary) navLibrary.onclick = () => switchView('library');
  if (navPlaylists) navPlaylists.onclick = () => switchView('playlists');
  if (navSettings) navSettings.onclick = () => switchView('settings');
  if (navAlbums) navAlbums.onclick = () => switchView('albums');
  if (navArtists) navArtists.onclick = () => switchView('artists');

  // Import buttons
  if (btnImportFile) btnImportFile.onclick = async () => { await electron.importFile(); loadLibrary(); };
  if (btnImportFolder) btnImportFolder.onclick = async () => { await electron.importFolder(); loadLibrary(); };
  if (btnNewPlaylist) btnNewPlaylist.onclick = async () => {
    const name = await customPrompt('New playlist name:');
    if (!name || !name.trim()) return;
    try {
      await electron.createPlaylist(name.trim());
      // Refresh playlists view if currently visible
      if (viewPlaylists && viewPlaylists.style.display !== 'none') renderPlaylists();
    } catch (e) {
      console.error('Failed to create playlist', e);
      alert('Failed to create playlist');
    }
  };
  if (btnImportPlaylist) btnImportPlaylist.onclick = async () => {
    try {
      const res = await electron.importPlaylist();
      if (res && res.success) {
        await renderPlaylists();
        alert('Playlist imported');
      } else if (res && res.canceled) {
        // user canceled
      } else {
        alert('Import failed: ' + (res && res.error ? res.error : 'unknown'));
      }
    } catch (e) {
      console.error('Import playlist failed', e);
      alert('Import failed');
    }
  };
  if (btnImportUrl) btnImportUrl.onclick = async () => {
    try {
      const url = await customPrompt('Enter remote audio URL (http or https):');
      if (!url || !url.trim()) return;
      
      const trimmedUrl = url.trim();
      if (!/^https?:\/\//i.test(trimmedUrl)) {
        alert('Please enter a valid http(s) URL');
        return;
      }

      // Ask optional metadata info
      const title = await customPrompt('Optional: provide a title for this track (leave blank to use filename):');
      const artist = await customPrompt('Optional: provide an artist name (leave blank for Remote):');

      const res = await electron.addRemote({ 
        url: trimmedUrl, 
        title: title && title.trim() ? title.trim() : undefined,
        artist: artist && artist.trim() ? artist.trim() : undefined
      });
      
      if (res && res.success) {
        await loadLibrary();
        const playNow = confirm('Track added to library. Play it now?');
        if (playNow) {
          // Refresh library and find the just-added track
          const lib = await electron.getLibrary();
          const t = lib.find(x => x.path === trimmedUrl);
          if (t) await playTrack(t);
        }
      } else {
        alert('Failed to add remote track: ' + (res && res.error ? res.error : 'unknown'));
      }
    } catch (e) {
      console.error('addImportUrl error', e);
      alert('Error adding remote URL: ' + (e && e.message ? e.message : e));
    }
  };

  // Play button
  if (btnPlay) btnPlay.onclick = async () => {
    if (isPlaying) {
      await electron.pause();
      isPlaying = false;
    } else {
      if (currentTrack) {
        // Query engine status to decide whether to resume or start playback
        try {
          const status = await electron.getAudioStatus();
          // If engine already has an active process (playing or paused), resume if paused
          if (status && status.playing) {
            if (status.paused) {
              await electron.resume();
              isPlaying = true;
            } else {
              // already playing
              isPlaying = true;
            }
          } else {
            // No active process — start playback from the current track
            await playTrack(currentTrack);
            // playTrack sets isPlaying
          }
        } catch (e) {
          // Fallback: attempt to start playback
          await playTrack(currentTrack);
        }
      } else if (tracks.length > 0) {
        await playTrack(tracks[0]);
      }
    }
    updatePlayButton();
  };

  // Prev/Next buttons
  if (btnPrev) btnPrev.onclick = () => {
    if (!currentTrack || tracks.length === 0) return;
    const idx = tracks.findIndex(t => t.id === currentTrack.id);
    if (idx > 0) {
      playTrack(tracks[idx - 1]);
    }
  };

  if (btnNext) btnNext.onclick = () => {
    if (!currentTrack || tracks.length === 0) return;
    const idx = tracks.findIndex(t => t.id === currentTrack.id);
    if (idx >= 0 && idx < tracks.length - 1) {
      playTrack(tracks[idx + 1]);
    }
  };

  // Volume/seek
  if (volumeSlider) {
    // Restore saved volume or default to 100
    const savedVol = Number(localStorage.getItem('spectra_volume') || 100);
    volumeSlider.value = String(savedVol);
    try { electron.setVolume(Number(savedVol)); } catch (e) {}

    volumeSlider.oninput = (e) => {
      const v = Number(e.target.value);
      localStorage.setItem('spectra_volume', String(v));
      electron.setVolume(Number(v));
    };
  }
  if (seekSlider) {
    seekSlider.onchange = (e) => {
      if (currentTrack) {
        const time = (e.target.value / 100) * currentTrack.duration;
        electron.seek(time);
      }
      isSeeking = false;
    };
    seekSlider.oninput = () => { isSeeking = true; };
  }

  // Drag and drop
  document.body.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  document.body.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const files = [];
    for (const f of e.dataTransfer.files) if (f.path) files.push(f.path);
    if (files.length > 0) { await electron.addFiles(files); loadLibrary(); }
  });

  // Edit modal logic
  let editingTrackId = null;
  const closeEditModal = () => { if (editModal) editModal.style.display = 'none'; editingTrackId = null; };
  if (btnCancelEdit) btnCancelEdit.onclick = closeEditModal;
  if (btnSaveEdit) btnSaveEdit.onclick = async () => {
    if (!editingTrackId) return;
    const data = { title: editTitle.value, artist: editArtist.value, album: editAlbum.value };
    await electron.updateTrack(editingTrackId, data);
    closeEditModal();
    loadLibrary();
    if (currentTrack && currentTrack.id === editingTrackId) { currentTrack = { ...currentTrack, ...data }; updateNowPlaying(); }
  };

  // Playlist editor modal logic
  const playlistEditorModal = document.getElementById('playlist-editor-modal');
  const btnCancelPlaylistEdit = document.getElementById('btn-cancel-playlist-edit');
  const btnSavePlaylistEdit = document.getElementById('btn-save-playlist-edit');
  const btnDeletePlaylist = document.getElementById('btn-delete-playlist');
  const playlistNameInput = document.getElementById('playlist-name-input');

  const closePlaylistEditorModal = () => {
    if (playlistEditorModal) playlistEditorModal.style.display = 'none';
    currentEditingPlaylist = null;
    playlistEditorTracks = [];
  };

  if (btnCancelPlaylistEdit) {
    btnCancelPlaylistEdit.onclick = closePlaylistEditorModal;
  }

  if (btnSavePlaylistEdit) {
    btnSavePlaylistEdit.onclick = async () => {
      if (!currentEditingPlaylist) return;

      try {
        const newName = playlistNameInput.value.trim();
        if (newName) {
          await electron.renamePlaylist(currentEditingPlaylist, newName);
        }

        // Clear and re-add tracks in new order
        const currentTracks = await electron.getPlaylistTracks(currentEditingPlaylist);
        // Remove all tracks
        for (const track of currentTracks) {
          await electron.removeTrackFromPlaylist(currentEditingPlaylist, track.id);
        }
        // Add tracks in new order
        for (const track of playlistEditorTracks) {
          await electron.addTrackToPlaylist(currentEditingPlaylist, track.id);
        }

        closePlaylistEditorModal();
        await renderPlaylists();
      } catch (err) {
        console.error('Failed to save playlist edits:', err);
        alert('Failed to save changes');
      }
    };
  }

  if (btnDeletePlaylist) {
    btnDeletePlaylist.onclick = async () => {
      if (!currentEditingPlaylist) return;
      
      const confirmed = confirm('Are you sure you want to delete this playlist? This cannot be undone.');
      if (!confirmed) return;

      try {
        await electron.deletePlaylist(currentEditingPlaylist);
        closePlaylistEditorModal();
        await renderPlaylists();
      } catch (err) {
        console.error('Failed to delete playlist:', err);
        alert('Failed to delete playlist');
      }
    };
  }

  // IPC handlers
  electron.on('track:edit', (track) => {
    editingTrackId = track.id;
    if (editTitle) editTitle.value = track.title || '';
    if (editArtist) editArtist.value = track.artist || '';
    if (editAlbum) editAlbum.value = track.album || '';
    if (editModal) editModal.style.display = 'flex';
  });

  electron.on('track:remove', async (trackId) => {
    if (confirm('Are you sure you want to remove this track from the library?')) {
      await electron.removeTrack(trackId);
      loadLibrary();
    }
  });

  // Handle multi-remove initiated from context menu
  electron.on('tracks:remove', async (trackIds) => {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return;
    if (confirm(`Are you sure you want to remove ${trackIds.length} tracks from the library?`)) {
      for (const id of trackIds) {
        await electron.removeTrack(id);
      }
      loadLibrary();
    }
  });

  window.onclick = (event) => { if (event.target === editModal) closeEditModal(); };

  // Import progress notifications
  electron.on('import:start', ({ total }) => {
    if (!notificationBar) return;
    notificationBar.classList.add('show');
    notificationMessage.textContent = 'Adding tracks...';
    notificationProgress.style.width = '0%';
    notificationCount.textContent = `0/${total}`;
  });
  electron.on('import:progress', ({ current, total, filename }) => {
    if (!notificationBar) return;
    const percent = (current / total) * 100;
    notificationProgress.style.width = `${percent}%`;
    notificationCount.textContent = `${current}/${total}`;
    notificationMessage.textContent = `Adding: ${filename}`;
  });
  electron.on('import:complete', () => {
    if (!notificationBar) return;
    notificationMessage.textContent = 'Import complete!';
    notificationProgress.style.width = '100%';
    setTimeout(() => { notificationBar.classList.remove('show'); loadLibrary(); }, 2000);
  });

  electron.on('player:state', syncState);

  // When main asks renderer to create a playlist from the current selection
  electron.on('playlist:create-from-selection', async ({ trackIds }) => {
    try {
      const name = await customPrompt('New playlist name:');
      if (!name || !name.trim()) return;
      await electron.createPlaylist(name.trim());
      // Refresh playlists and locate the created playlist (best-effort)
      const pls = await electron.getPlaylists();
      let created = null;
      if (Array.isArray(pls) && pls.length) {
        // Pick most recently-created playlist with this name
        const matches = pls.filter(p => p.name === name.trim());
        if (matches.length === 1) created = matches[0];
        else if (matches.length > 1) created = matches.sort((a,b) => new Date(b.created_at) - new Date(a.created_at))[0];
        else created = pls[pls.length - 1];
      }
      if (!created) {
        // fallback: just refresh UI
        await renderPlaylists();
        return;
      }
      const pid = created.id;
      if (Array.isArray(trackIds) && trackIds.length) {
        for (const tid of trackIds) {
          await electron.addTrackToPlaylist(pid, tid).catch(() => {});
        }
      }
      await renderPlaylists();
      alert(`Created playlist "${created.name}" and added ${Array.isArray(trackIds) ? trackIds.length : 0} tracks.`);
    } catch (e) {
      console.error('playlist:create-from-selection handler failed', e);
    }
  });

  // Refresh playlists view when main notifies tracks were added
  electron.on('playlist:added', async () => {
    try { await renderPlaylists(); } catch (_) {}
  });

  // Periodic UI updates
  setInterval(async () => {
      if (currentTrack) {
        // Always query current time for UI and persistence (even if paused)
        const time = await electron.getTime();
        if (currentTimeEl) currentTimeEl.textContent = formatTime(time);
        if (!isSeeking && currentTrack.duration > 0 && seekSlider) seekSlider.value = (time / currentTrack.duration) * 100;
        // Persist last played position
        saveLastPlayed(currentTrack, time);
        // Ensure Now Playing bar visible when we have a current track
        showNowPlaying();
      }
  }, 500);

  // Initial load
  await loadLibrary();
  // Keyboard: Ctrl/Cmd + A => select all tracks in current view
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      if (!globalThis.__spectra_selectedTrackIds) globalThis.__spectra_selectedTrackIds = new Set();
      const sel = globalThis.__spectra_selectedTrackIds;
      sel.clear();
      for (const t of tracks) sel.add(t.id);
      renderLibrary();
    }
  });
  initSearch();
  await loadSettingsUI();
  // Push current settings to main (ensure minimize-to-tray preference applied at startup)
  try { saveSettings(); } catch (e) { console.warn('Initial saveSettings failed', e); }

  // Init fullscreen cover click handler
  initFullscreenClick();
  // Init lyrics editor handlers
  initLyricsEditor();

  // Load Plugins
  await loadPlugins();

  // Ensure Playlists page is populated so playlists are visible without user action
  try { await renderPlaylists(); } catch (err) { console.warn('Initial renderPlaylists failed', err); }

  // Initial sync with server state
  const initialState = await electron.getPlayerState();
  syncState(initialState);

  // Restore last played track and position (Spotify-like behaviour)
  // Only if server is not playing
  if (!initialState || (!initialState.playing && !initialState.paused)) {
    const last = getSavedLastPlayed();
    if (last) {
      const found = tracks.find(t => String(t.id) === String(last.id) || t.path === last.path);
      if (found) {
        currentTrack = found;
        // update UI but do not auto-play
        updateNowPlaying();
        // restore seek slider and time display
        if (currentTimeEl) currentTimeEl.textContent = formatTime(last.elapsed || 0);
        if (seekSlider && currentTrack.duration > 0) {
          seekSlider.value = ((last.elapsed || 0) / currentTrack.duration) * 100;
        }
        // show the now playing bar as a remembered last track
        showNowPlaying();
      }
    }
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
