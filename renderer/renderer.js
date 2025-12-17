const { electron } = globalThis;

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
let notificationDetail;
let notificationClose;
let notificationTrack;

let isSeeking = false;
// When set, searches and library view are scoped to this album (lowercase name and optional artist)
let currentAlbumFilter = null;
let currentArtistFilter = null;
let currentPlaylistFilter = null;
let currentPlaylistTracks = [];
let currentView = 'library';
let libraryContext = { type: 'library', name: null, artist: null };
let albumsCache = [];
let artistsCache = [];
let playlistsCache = [];
let libraryTitleEl;
let searchInputEl;
let lastAutoAdvancedTrackId = null;
const AUTO_ADVANCE_EPS = 0.9; // seconds before end to trigger advance
let lastKnownPosition = 0; // seconds, updated from player state/time polls

// Helper function to update repeat button visual state

// Normalizes strings for comparison: trim, lower-case, unicode normalize, and remove diacritics
function normalizeForCompare(s) {
  if (!s && s !== '') return '';
  try {
    return s.toString().trim().toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  } catch {
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

// --- Fullscreen background canvas animation helpers ---
const __fsBg = { raf: null, canvas: null, ctx: null, mouseX: 0.5, mouseY: 0.5, running: false, onMouse: null };

function sampleColorsFromImage(img, maxColors = 5) {
  try {
    const w = 64, h = 64;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0, w, h);
    const data = cx.getImageData(0, 0, w, h).data;
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] >> 4; const g = data[i+1] >> 4; const b = data[i+2] >> 4;
      const key = (r<<8) | (g<<4) | b;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const arr = Array.from(counts.entries()).sort((a,b) => b[1]-a[1]).slice(0, maxColors);
    const colors = arr.map(([key]) => {
      const r = ((key >> 8) & 0xF) << 4;
      const g = ((key >> 4) & 0xF) << 4;
      const b = (key & 0xF) << 4;
      return `rgba(${r+8},${g+8},${b+8},`;
    });
    return colors.length ? colors : ['rgba(24,24,24,', 'rgba(40,40,40,', 'rgba(16,16,16,'];
  } catch (e) {
    return ['rgba(24,24,24,', 'rgba(40,40,40,', 'rgba(16,16,16,'];
  }
}

function startFsBgAnimationFromSrc(src) {
  try {
    const canvas = document.getElementById('fs-bg-canvas');
    if (!canvas) return;
    if (!__fsBg.canvas) {
      __fsBg.canvas = canvas;
      __fsBg.ctx = canvas.getContext('2d');
    }
    const ctx = __fsBg.ctx;
    let img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src || '';

    img.onload = () => {
      const palette = sampleColorsFromImage(img, 4);
      // Build layers
      const layers = palette.map((base, i) => ({
        colorBase: base,
        alpha: 0.18 + (i * 0.08),
        speed: 0.2 + i*0.18,
        amplitude: 30 + i*24,
        wavelength: 0.006 + i*0.004,
        phase: Math.random()*Math.PI*2
      }));

      // Resize canvas to display size
      function resize() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, canvas.clientWidth);
        const h = Math.max(1, canvas.clientHeight);
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      resize();
      window.addEventListener('resize', resize);

      // Mouse parallax
      __fsBg.onMouse = (e) => {
        const rect = canvas.getBoundingClientRect();
        __fsBg.mouseX = ((e.clientX - rect.left) / rect.width);
        __fsBg.mouseY = ((e.clientY - rect.top) / rect.height);
      };
      canvas.addEventListener('mousemove', __fsBg.onMouse);

      let start = performance.now();
      __fsBg.running = true;
      function frame(t) {
        const time = (t - start) / 1000;
        const w = canvas.clientWidth; const h = canvas.clientHeight;
        ctx.clearRect(0,0,w,h);

        // Draw multiple layered waves
        for (let li = 0; li < layers.length; li++) {
          const layer = layers[li];
          ctx.beginPath();
          const baseY = h * (0.35 + li * 0.12) + ( (__fsBg.mouseY - 0.5) * 80 * (li+1) );
          ctx.moveTo(0, h);
          ctx.lineTo(0, baseY);
          const step = Math.max(8, Math.floor(w / 60));
          for (let x = 0; x <= w; x += step) {
            const y = baseY + Math.sin((x * layer.wavelength) + (time * layer.speed) + layer.phase) * layer.amplitude * (1 + li*0.2);
            ctx.lineTo(x, y);
          }
          ctx.lineTo(w, h);
          ctx.closePath();
          const rgba = layer.colorBase + (layer.alpha) + ')';
          ctx.fillStyle = rgba;
          ctx.fill();
        }

        // subtle vignette overlay
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.fillRect(0,0,w,h);

        __fsBg.raf = requestAnimationFrame(frame);
      }
      if (__fsBg.raf) cancelAnimationFrame(__fsBg.raf);
      __fsBg.raf = requestAnimationFrame(frame);
    };
    img.onerror = () => {
      // fallback: clear canvas
      const c = __fsBg.canvas; if (c && __fsBg.ctx) __fsBg.ctx.clearRect(0,0,c.width,c.height);
    };
  } catch (err) {
    console.warn('Failed to start fullscreen bg animation', err);
  }
}

function stopFsBgAnimation() {
  try {
    if (__fsBg.raf) cancelAnimationFrame(__fsBg.raf);
    __fsBg.raf = null;
    if (__fsBg.canvas && __fsBg.onMouse) {
      __fsBg.canvas.removeEventListener('mousemove', __fsBg.onMouse);
      __fsBg.onMouse = null;
    }
    // clear canvas
    if (__fsBg.ctx && __fsBg.canvas) {
      __fsBg.ctx.clearRect(0,0,__fsBg.canvas.width, __fsBg.canvas.height);
    }
    __fsBg.running = false;
  } catch (e) {}
}

// ------------------------------------------------------

const tokenizeQuery = (query) => {
  if (!query) return [];
  return String(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      let type = 'include';
      let text = tok;
      if (tok.startsWith('-')) { type = 'exclude'; text = tok.slice(1); }
      else if (tok.startsWith('+')) { type = 'include'; text = tok.slice(1); }
      const fieldMatch = text.match(/^(title|artist|album):(.+)$/);
      if (fieldMatch) {
        return { type, field: fieldMatch[1], text: fieldMatch[2] };
      }
      return { type, field: null, text };
    });
};

const matchesTrackToken = (track, token) => {
  const needle = (token.text || '').toLowerCase();
  if (!needle) return true;
  if (token.field) {
    const val = ((track?.[token.field] || '') + '').toLowerCase();
    return val.includes(needle);
  }
  const title = (track?.title || '').toLowerCase();
  const artist = (track?.artist || '').toLowerCase();
  const album = (track?.album || '').toLowerCase();
  return title.includes(needle) || artist.includes(needle) || album.includes(needle);
};

const filterTracksByQuery = (base, query) => {
  if (!Array.isArray(base)) return [];
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return base;
  return base.filter((track) => {
    for (const tok of tokens) {
      if (tok.type === 'exclude') {
        if (matchesTrackToken(track, tok)) return false;
      } else if (!matchesTrackToken(track, tok)) {
        return false;
      }
    }
    return true;
  });
};

const computeLibraryBase = () => {
  if (libraryContext.type === 'playlist' && currentPlaylistFilter) {
    return Array.isArray(currentPlaylistTracks) ? [...currentPlaylistTracks] : [];
  }

  let base = Array.isArray(libraryCache) ? libraryCache : [];

  if (currentAlbumFilter && currentAlbumFilter.album) {
    base = base.filter((t) => {
      const trackAlbum = normalizeForCompare(t.album || '');
      const trackArtist = normalizeForCompare(t.artist || '');
      const trackAlbumArtist = normalizeForCompare(t.album_artist || '');
      if (currentAlbumFilter.artist) {
        // Match album name AND (artist OR album_artist matches the filter)
        return trackAlbum === currentAlbumFilter.album && 
               (trackArtist === currentAlbumFilter.artist || trackAlbumArtist === currentAlbumFilter.artist);
      }
      return trackAlbum === currentAlbumFilter.album;
    });
  } else if (currentArtistFilter) {
    base = base.filter((t) => {
      const trackArtist = normalizeForCompare(t.artist || '');
      return trackArtist === currentArtistFilter;
    });
  }

  return base;
};

const applyLibrarySearch = (query) => {
  const base = computeLibraryBase();
  tracks = filterTracksByQuery(base, query);
  renderLibrary();
};

function setLibraryContext(type, details = {}) {
  const normalized = type || 'library';
  libraryContext = {
    type: normalized,
    name: details?.name ?? null,
    artist: details?.artist ?? null,
    id: details?.id ?? null,
  };

  if (normalized === 'library') {
    currentAlbumFilter = null;
    currentArtistFilter = null;
    currentPlaylistFilter = null;
    currentPlaylistTracks = [];
  } else if (normalized === 'playlist') {
    currentAlbumFilter = null;
    currentArtistFilter = null;
    currentPlaylistFilter = { id: details?.id ?? null, name: details?.name ?? null };
  }

  updateLibraryHeader();
  updateSearchPlaceholder();
}

function updateLibraryHeader() {
  if (!libraryTitleEl) libraryTitleEl = document.querySelector('#view-library h2');
  if (!libraryTitleEl) return;

  const isFiltered = libraryContext.type === 'album' || libraryContext.type === 'artist' || libraryContext.type === 'playlist';
  
  if (libraryContext.type === 'album') {
    // When viewing an album we render a dedicated album header in the library view.
    // Hide the smaller H2 header to avoid duplicating the title.
    libraryTitleEl.style.display = 'none';
    return;
  } else if (libraryContext.type === 'artist') {
    const label = libraryContext.name ? `Artist · ${libraryContext.name}` : 'Artist';
    libraryTitleEl.innerHTML = `<span class="back-to-library" title="Back to Library"><span class="material-icons">arrow_back</span></span> ${label}`;
  } else if (libraryContext.type === 'playlist') {
    const label = libraryContext.name ? `Playlist · ${libraryContext.name}` : 'Playlist';
    libraryTitleEl.innerHTML = `<span class="back-to-library" title="Back to Library"><span class="material-icons">arrow_back</span></span> ${label}`;
  } else {
    libraryTitleEl.textContent = 'Library';
  }
  
  // Add click handler to back button
  const backBtn = libraryTitleEl.querySelector('.back-to-library');
  if (backBtn) {
    backBtn.onclick = async () => {
      currentAlbumFilter = null;
      currentArtistFilter = null;
      currentPlaylistFilter = null;
      currentPlaylistTracks = [];
      setLibraryContext('library');
      await loadLibrary();
    };
  }
}

function updateSearchPlaceholder() {
  if (!searchInputEl) searchInputEl = document.getElementById('search-input');
  if (!searchInputEl) return;

  if (currentView === 'albums') {
    searchInputEl.placeholder = 'Search albums...';
  } else if (currentView === 'artists') {
    searchInputEl.placeholder = 'Search artists...';
  } else if (currentView === 'playlists') {
    searchInputEl.placeholder = 'Search playlists...';
  } else if (libraryContext.type === 'album') {
    searchInputEl.placeholder = 'Search this album...';
  } else if (libraryContext.type === 'artist') {
    searchInputEl.placeholder = 'Search this artist...';
  } else if (libraryContext.type === 'playlist') {
    searchInputEl.placeholder = 'Search this playlist...';
  } else {
    searchInputEl.placeholder = 'Search library...';
  }
}

const albumMatchesQuery = (album, query) => {
  const needle = (query || '').toLowerCase();
  if (!needle) return true;
  const name = (album?.name || album?.album || '').toLowerCase();
  const artist = (album?.artist || '').toLowerCase();
  return name.includes(needle) || artist.includes(needle);
};

const artistMatchesQuery = (artist, query) => {
  const needle = (query || '').toLowerCase();
  if (!needle) return true;
  const name = (artist?.name || '').toLowerCase();
  return name.includes(needle);
};

const playlistMatchesQuery = (playlist, query) => {
  const needle = (query || '').toLowerCase();
  if (!needle) return true;
  const name = (playlist?.name || '').toLowerCase();
  return name.includes(needle);
};

async function ensureAlbumsCache(force = false) {
  if (!force && Array.isArray(albumsCache) && albumsCache.length) {
    return albumsCache;
  }
  try {
    const albums = await electron.getAlbums();
    albumsCache = Array.isArray(albums) ? albums : [];
  } catch (err) {
    console.error('Failed to load albums:', err);
    albumsCache = [];
  }
  return albumsCache;
}

async function ensureArtistsCache(force = false) {
  if (!force && Array.isArray(artistsCache) && artistsCache.length) {
    return artistsCache;
  }
  try {
    const artists = await electron.getArtists();
    artistsCache = Array.isArray(artists) ? artists : [];
  } catch (err) {
    console.error('Failed to load artists:', err);
    artistsCache = [];
  }
  return artistsCache;
}

async function ensurePlaylistsCache(force = false) {
  if (!force && Array.isArray(playlistsCache) && playlistsCache.length) {
    return playlistsCache;
  }
  try {
    const playlists = await electron.getPlaylists();
    playlistsCache = Array.isArray(playlists) ? playlists : [];
  } catch (err) {
    console.error('Failed to load playlists:', err);
    playlistsCache = [];
  }
  return playlistsCache;
}

async function handleSearchInput(rawValue = '') {
  const query = (rawValue || '').toLowerCase().trim();

  if (currentView === 'albums') {
    const source = await ensureAlbumsCache();
    const filtered = query ? source.filter((album) => albumMatchesQuery(album, query)) : source;
    await renderAlbums({ data: filtered });
    return;
  }

  if (currentView === 'artists') {
    const source = await ensureArtistsCache();
    const filtered = query ? source.filter((artist) => artistMatchesQuery(artist, query)) : source;
    await renderArtists({ data: filtered });
    return;
  }

  if (currentView === 'playlists') {
    const source = await ensurePlaylistsCache();
    const filtered = query ? source.filter((playlist) => playlistMatchesQuery(playlist, query)) : source;
    await renderPlaylists({ data: filtered });
    return;
  }

  applyLibrarySearch(query);
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
  currentView = viewId || 'library';

  document.querySelectorAll('.view').forEach((el) => { el.style.display = 'none'; });
  document.querySelectorAll('.sidebar nav li').forEach((el) => el.classList.remove('active'));

  const targetId = `view-${viewId}`;
  const targetView = document.getElementById(targetId);
  const navEl = document.getElementById(`nav-${viewId}`);
  if (targetView) {
    targetView.style.display = 'block';
    if (navEl) navEl.classList.add('active');

    if (viewId === 'library') {
      if (!preserveLibrary) {
        setLibraryContext('library');
        loadLibrary();
      } else {
        updateLibraryHeader();
        const currentQuery = searchInputEl ? searchInputEl.value : '';
        void handleSearchInput(currentQuery);
      }
    } else if (viewId === 'albums') {
      void renderAlbums({ forceReload: !albumsCache.length });
    } else if (viewId === 'artists') {
      void renderArtists({ forceReload: !artistsCache.length });
    } else if (viewId === 'settings') {
      loadSettingsUI();
    }

    updateSearchPlaceholder();
    if (viewId !== 'library') {
      const currentQuery = searchInputEl ? searchInputEl.value : '';
      void handleSearchInput(currentQuery);
    }
    return;
  }

  if (viewId === 'library') {
    if (viewLibrary) viewLibrary.style.display = 'block';
    if (navLibrary) navLibrary.classList.add('active');
    if (!preserveLibrary) {
      setLibraryContext('library');
      loadLibrary();
    } else {
      updateLibraryHeader();
      const currentQuery = searchInputEl ? searchInputEl.value : '';
      void handleSearchInput(currentQuery);
    }
  } else if (viewId === 'playlists') {
    if (viewPlaylists) viewPlaylists.style.display = 'block';
    if (navPlaylists) navPlaylists.classList.add('active');
    void renderPlaylists({ forceReload: !playlistsCache.length });
    const currentQuery = searchInputEl ? searchInputEl.value : '';
    void handleSearchInput(currentQuery);
  } else if (viewId === 'albums') {
    if (viewAlbums) viewAlbums.style.display = 'block';
    if (navAlbums) navAlbums.classList.add('active');
    void renderAlbums({ forceReload: !albumsCache.length });
    const currentQuery = searchInputEl ? searchInputEl.value : '';
    void handleSearchInput(currentQuery);
  } else if (viewId === 'settings') {
    if (viewSettings) viewSettings.style.display = 'block';
    if (navSettings) navSettings.classList.add('active');
    loadSettingsUI();
  }

  updateSearchPlaceholder();
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

async function renderPlaylists({ data, forceReload = false } = {}) {
  try {
    const container = document.getElementById('playlists-container');
    if (!container) return;
    const source = Array.isArray(data) ? data : await ensurePlaylistsCache(forceReload);

    if (!Array.isArray(source) || source.length === 0) {
      container.innerHTML = '<div class="empty">No playlists</div>';
      return;
    }

    container.innerHTML = '';

    const openPlaylist = async (playlist, { autoplay = false } = {}) => {
      try {
        const tracksIn = await electron.getPlaylistTracks(playlist.id);
        currentPlaylistTracks = Array.isArray(tracksIn) ? tracksIn : [];
        setLibraryContext('playlist', { id: playlist.id, name: playlist.name });
        currentAlbumFilter = null;
        currentArtistFilter = null;
        const currentQuery = searchInputEl ? searchInputEl.value : '';
        switchView('library', true);
        await handleSearchInput(currentQuery);
        if (autoplay) {
          const target = tracks.length > 0 ? tracks[0] : null;
          if (target) await playTrack(target);
          else notify('Playlist is empty', 'warning', { autoClose: 2200 });
        }
      } catch (err) {
        console.error('Failed to open playlist', err);
        notify('Failed to load playlist', 'error', { autoClose: 3600 });
      }
    };

    for (const p of source) {
      const card = document.createElement('div');
      card.className = 'album-card';

      const title = document.createElement('div');
      title.className = 'album-title';
      title.textContent = p.name || `Playlist ${p.id}`;

      const meta = document.createElement('div');
      meta.className = 'album-artist';
      meta.textContent = p.created_at ? new Date(p.created_at).toLocaleString() : '';

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '8px';
      actions.style.marginTop = '8px';

      const btnView = document.createElement('button');
      btnView.className = 'btn-secondary';
      btnView.textContent = 'View';
      btnView.onclick = () => openPlaylist(p, { autoplay: false });

      const btnPlay = document.createElement('button');
      btnPlay.className = 'btn-secondary';
      btnPlay.textContent = 'Play';
      btnPlay.onclick = () => openPlaylist(p, { autoplay: true });

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
          if (res && res.success) notify(`Playlist exported to ${res.path}`, 'success', { autoClose: 2600 });
          else if (res && res.canceled) { /* user canceled */ }
          else notify(`Export failed: ${res && res.error ? res.error : 'unknown'}`, 'error');
        } catch (err) {
          console.error('Export playlist failed', err);
          notify('Export failed', 'error');
        }
      };

      const count = document.createElement('div');
      count.className = 'album-count';
      if (typeof p._trackCount === 'number') {
        count.textContent = `${p._trackCount} tracks`;
      } else {
        try {
          const tlist = await electron.getPlaylistTracks(p.id);
          const trackCount = Array.isArray(tlist) ? tlist.length : 0;
          p._trackCount = trackCount;
          count.textContent = `${trackCount} tracks`;
        } catch {
          count.textContent = '';
        }
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
      card.style.cursor = 'pointer';
      card.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        void openPlaylist(p, { autoplay: false });
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

function customConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'flex';

    const content = document.createElement('div');
    content.className = 'modal-content';

    const title = document.createElement('h3');
    title.textContent = options.title || 'Confirm';
    content.appendChild(title);

    const body = document.createElement('p');
    body.textContent = message || '';
    body.style.marginBottom = '16px';
    content.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'custom-confirm-cancel';
    cancelBtn.className = 'btn-text';
    cancelBtn.textContent = options.cancelLabel || 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.id = 'custom-confirm-ok';
    okBtn.className = options.confirmClass || 'btn-secondary';
    okBtn.textContent = options.confirmLabel || 'OK';

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    content.appendChild(actions);
    modal.appendChild(content);
    document.body.appendChild(modal);

    const cleanup = (accepted) => {
      try { document.body.removeChild(modal); } catch {}
      resolve(Boolean(accepted));
    };

    cancelBtn.onclick = () => cleanup(false);
    okBtn.onclick = () => cleanup(true);

    const keyHandler = (event) => {
      if (event.key === 'Escape') {
        cleanup(false);
        document.removeEventListener('keydown', keyHandler);
      } else if (event.key === 'Enter') {
        cleanup(true);
        document.removeEventListener('keydown', keyHandler);
      }
    };

    document.addEventListener('keydown', keyHandler);
    modal.onclick = (event) => {
      if (event.target === modal) {
        cleanup(false);
        document.removeEventListener('keydown', keyHandler);
      }
    };
  });
}

const NotificationCenter = (() => {
  let current = null;
  let hideTimer = null;

  const ensureDom = () => {
    notificationBar = notificationBar || document.getElementById('notification-bar');
    notificationMessage = notificationMessage || document.getElementById('notification-message');
    notificationDetail = notificationDetail || document.getElementById('notification-detail');
    notificationProgress = notificationProgress || document.getElementById('notification-progress');
    notificationCount = notificationCount || document.getElementById('notification-count');
    notificationClose = notificationClose || document.getElementById('notification-close');
    notificationTrack = notificationTrack || document.querySelector('#notification-bar .progress-track');

    return {
      bar: notificationBar,
      messageEl: notificationMessage,
      detailEl: notificationDetail,
      progressTrack: notificationTrack,
      progressEl: notificationProgress,
      countEl: notificationCount,
      closeBtn: notificationClose
    };
  };

  const setType = (bar, type) => {
    if (!bar) return;
    const classes = ['type-info', 'type-success', 'type-error', 'type-warning', 'type-progress'];
    for (const cls of classes) bar.classList.remove(cls);
    const normalized = type ? String(type).toLowerCase() : 'info';
    const cls = classes.find(c => c.endsWith(normalized));
    if (cls) bar.classList.add(cls);
  };

  const applyState = (state) => {
    const dom = ensureDom();
    if (!dom.bar || !dom.messageEl) return;

    dom.bar.classList.add('show');
    setType(dom.bar, state.type);

    dom.messageEl.textContent = state.message || '';

    if (dom.detailEl) {
      dom.detailEl.textContent = state.detail || '';
      dom.detailEl.style.display = state.detail ? 'block' : 'none';
    }

    if (dom.progressTrack) {
      const showProgress = state.mode === 'progress';
      dom.progressTrack.classList.toggle('hidden', !showProgress);
      if (dom.progressEl && typeof state.progress === 'number') {
        const pct = Math.max(0, Math.min(100, state.progress));
        dom.progressEl.style.width = `${pct}%`;
      }
    }

    if (dom.countEl) {
      if (state.mode === 'progress' && state.count) {
        dom.countEl.textContent = state.count;
        dom.countEl.classList.remove('hidden');
      } else {
        dom.countEl.classList.add('hidden');
      }
    }

    if (dom.closeBtn) {
      dom.closeBtn.style.display = state.dismissible === false ? 'none' : 'flex';
      dom.closeBtn.onclick = () => hide();
    }
  };

  const scheduleHide = (state) => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (!state.sticky && state.autoClose) {
      hideTimer = setTimeout(() => hide(), state.autoClose);
    }
  };

  const show = (config = {}) => {
    const mode = config.mode || (typeof config.progress === 'number' ? 'progress' : 'message');
    const type = config.type || (mode === 'progress' ? 'progress' : 'info');
    const next = {
      message: config.message || '',
      detail: config.detail || '',
      type,
      mode,
      progress: typeof config.progress === 'number' ? config.progress : 0,
      count: config.count || '',
      autoClose: config.autoClose === undefined ? (mode === 'progress' ? null : 4000) : config.autoClose,
      sticky: config.sticky === undefined ? mode === 'progress' : config.sticky,
      dismissible: config.dismissible === undefined ? true : config.dismissible,
      onClose: typeof config.onClose === 'function' ? config.onClose : null
    };
    current = next;
    applyState(current);
    scheduleHide(current);
  };

  const update = (partial = {}) => {
    if (!current) {
      show(partial);
      return;
    }
    current = {
      ...current,
      ...partial
    };
    if (!current.mode) current.mode = typeof current.progress === 'number' ? 'progress' : 'message';
    if (!current.type) current.type = current.mode === 'progress' ? 'progress' : 'info';
    applyState(current);
    scheduleHide(current);
  };

  const hide = () => {
    const dom = ensureDom();
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (dom.bar) dom.bar.classList.remove('show');
    const closeCb = current && current.onClose;
    current = null;
    if (typeof closeCb === 'function') {
      try { closeCb(); } catch (err) {
        console.warn('Notification onClose failed', err);
      }
    }
  };

  return { show, update, hide, ensureDom };
})();

// Render Library
const renderLibrary = () => {
  trackList.innerHTML = '';

  // If we're viewing an album, render a large Spotify-like album header
  try {
    const viewLib = document.getElementById('view-library');
    if (viewLib) {
      // remove existing header if present
      const existing = viewLib.querySelector('.album-header');
      if (existing) existing.remove();

      if (libraryContext.type === 'album') {
        const header = document.createElement('div');
        header.className = 'album-header';

        header.innerHTML = `
          <div class="album-header-left">
            <img class="album-header-art" src="" alt="Album art">
          </div>
          <div class="album-header-main">
            <div style="display:flex;align-items:center;gap:12px;">
              <span class="back-to-library" title="Back to Library"><span class="material-icons">arrow_back</span></span>
              <div class="album-type">Album</div>
            </div>
            <div class="album-title-large">${libraryContext.name || ''}</div>
            <div class="album-artist-meta">${libraryContext.artist || ''} · ${tracks.length} songs</div>
            <div class="album-actions">
              <button class="btn-play btn-primary">Play</button>
              <button class="btn-secondary btn-shuffle">Shuffle</button>
              <button class="btn-text btn-more"><span class="material-icons">more_horiz</span></button>
            </div>
          </div>
        `;

        // Insert header above the track list header
        const trackHeader = viewLib.querySelector('.track-list-header');
        if (trackHeader) trackHeader.parentNode.insertBefore(header, trackHeader);

        // Load cover art from first available track or albumsCache
        const artEl = header.querySelector('.album-header-art');
        (async () => {
          try {
            let cover = null;
            // Prefer album-level cached cover
            const cached = (Array.isArray(albumsCache) ? albumsCache.find(a => normalizeForCompare(a.name || a.album || '') === normalizeForCompare(libraryContext.name || '')) : null);
            if (cached && (cached.cover_path || cached.coverPath)) cover = cached.cover_path || cached.coverPath;
            // fallback to first track cover
            if (!cover) {
              const first = tracks.find(t => t && (t.cover_path || t.coverPath));
              if (first) cover = first.cover_path || first.coverPath;
            }
            if (cover) {
              if (cover.startsWith('http') || cover.startsWith('data:')) artEl.src = cover;
              else {
                const url = await electron.getCoverImage(cover).catch(() => null);
                if (url) artEl.src = url;
                else artEl.classList.add('placeholder');
              }
            } else {
              artEl.classList.add('placeholder');
            }
          } catch (err) {
            artEl.classList.add('placeholder');
          }
        })();

        // Wire up play button to play first track in the filtered album
        const playBtn = header.querySelector('.btn-play');
        if (playBtn) playBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          if (tracks && tracks.length) {
            await playTrack(tracks[0]);
          }
        });

        const shuffleBtn = header.querySelector('.btn-shuffle');
        if (shuffleBtn) shuffleBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          // Quick shuffle: randomize tracks and play first
          if (!tracks || !tracks.length) return;
          const copy = [...tracks].sort(() => Math.random() - 0.5);
          tracks = copy;
          renderLibrary();
          await playTrack(tracks[0]);
        });

        // Back button in the album header should restore library view
        const backBtn = header.querySelector('.back-to-library');
        if (backBtn) backBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          currentAlbumFilter = null;
          currentArtistFilter = null;
          currentPlaylistFilter = null;
          currentPlaylistTracks = [];
          setLibraryContext('library');
          await loadLibrary();
        });
      }
    }
  } catch (e) {
    console.warn('Failed to render album header', e);
  }
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
      <div class="col-artist clickable-filter">${track.artist || 'Unknown Artist'}</div>
      <div class="col-album clickable-filter">${track.album || 'Unknown Album'}</div>
      <div class="col-duration">${formatTime(track.duration)}</div>
    `;
    
    // Click on artist to filter by artist
    const artistCell = el.querySelector('.col-artist');
    artistCell.addEventListener('click', async (e) => {
      e.stopPropagation();
      const artistName = track.artist || '';
      if (!artistName || artistName === 'Unknown Artist') return;
      
      const artistToMatch = normalizeForCompare(artistName);
      currentArtistFilter = artistToMatch;
      currentAlbumFilter = null;
      currentPlaylistFilter = null;
      currentPlaylistTracks = [];
      setLibraryContext('artist', { name: artistName });
      
      const currentQuery = searchInputEl ? searchInputEl.value : '';
      await handleSearchInput(currentQuery);
    });
    
    // Click on album to filter by album
    const albumCell = el.querySelector('.col-album');
    albumCell.addEventListener('click', async (e) => {
      e.stopPropagation();
      const albumName = track.album || '';
      const artistName = track.album_artist || track.artist || '';
      if (!albumName || albumName === 'Unknown Album') return;
      
      const nameToMatch = normalizeForCompare(albumName);
      const artistToMatch = normalizeForCompare(artistName) || null;
      currentAlbumFilter = { album: nameToMatch, artist: artistToMatch };
      currentArtistFilter = null;
      currentPlaylistFilter = null;
      currentPlaylistTracks = [];
      setLibraryContext('album', { name: albumName, artist: artistName });
      
      const currentQuery = searchInputEl ? searchInputEl.value : '';
      await handleSearchInput(currentQuery);
    });
    
    el.addEventListener('click', (e) => {
      // If clicked on artist/album filter cell, don't play
      if (e.target.classList.contains('clickable-filter')) return;
      
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
      const sameTrack = currentTrack && (
        (track.id && currentTrack.id && track.id === currentTrack.id) ||
        (!track.id && currentTrack.path && track.path && currentTrack.path === track.path)
      );
      playTrack(track, { forceRestart: Boolean(sameTrack) });
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

// Show album context menu (right-click menu for albums)
const showAlbumContextMenu = async (event, albumInfo) => {
  // Use native context menu via IPC (works for both desktop and web)
  if (electron.showAlbumContextMenu) {
    electron.showAlbumContextMenu(albumInfo);
  } else {
    // Fallback for web UI - show a simple custom menu
    showWebAlbumContextMenu(event, albumInfo);
  }
};

// Fallback context menu for web UI
const showWebAlbumContextMenu = (event, albumInfo) => {
  const { albumName, artistName, trackCount } = albumInfo;
  
  // Remove any existing context menu
  const existing = document.querySelector('.album-context-menu');
  if (existing) existing.remove();
  
  const menu = document.createElement('div');
  menu.className = 'album-context-menu';
  menu.style.cssText = `
    position: fixed;
    left: ${event.clientX}px;
    top: ${event.clientY}px;
    background: #282828;
    border: 1px solid #383838;
    border-radius: 4px;
    padding: 4px 0;
    min-width: 180px;
    z-index: 10000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  `;
  
  const deleteItem = document.createElement('div');
  deleteItem.textContent = `Delete Album "${albumName}"`;
  deleteItem.style.cssText = `
    padding: 8px 16px;
    cursor: pointer;
    color: #fff;
    font-size: 14px;
  `;
  deleteItem.onmouseenter = () => deleteItem.style.background = '#383838';
  deleteItem.onmouseleave = () => deleteItem.style.background = 'transparent';
  deleteItem.onclick = () => {
    menu.remove();
    handleAlbumDeleteConfirm({ albumName, artistName, trackCount });
  };
  
  const viewItem = document.createElement('div');
  viewItem.textContent = 'View Album';
  viewItem.style.cssText = `
    padding: 8px 16px;
    cursor: pointer;
    color: #fff;
    font-size: 14px;
  `;
  viewItem.onmouseenter = () => viewItem.style.background = '#383838';
  viewItem.onmouseleave = () => viewItem.style.background = 'transparent';
  viewItem.onclick = () => {
    menu.remove();
    handleAlbumView({ albumName, artistName });
  };
  
  menu.appendChild(deleteItem);
  menu.appendChild(viewItem);
  document.body.appendChild(menu);
  
  // Close on click outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
};

// Handle album delete confirmation
const handleAlbumDeleteConfirm = async (albumInfo) => {
  const { albumName, artistName, trackCount } = albumInfo;
  
  const confirmed = window.confirm(
    `Delete album "${albumName}" by ${artistName || 'Unknown Artist'}?\n\nThis will remove all ${trackCount} track(s) from your library.\n\nThis cannot be undone.`
  );
  
  if (confirmed) {
    try {
      const result = await electron.deleteAlbum(albumName, artistName);
      if (result && result.deleted > 0) {
        // Refresh library and albums view
        await loadLibrary();
        albumsCache = [];
        await renderAlbums({ forceReload: true });
      }
    } catch (err) {
      console.error('Failed to delete album:', err);
      alert('Failed to delete album: ' + (err.message || err));
    }
  }
};

// Handle album view from context menu
const handleAlbumView = async (albumInfo) => {
  const { albumName, artistName } = albumInfo;
  const nameToMatch = normalizeForCompare(albumName);
  const artistToMatch = normalizeForCompare(artistName) || null;
  
  if (!nameToMatch) return;
  
  currentAlbumFilter = { album: nameToMatch, artist: artistToMatch };
  currentArtistFilter = null;
  currentPlaylistFilter = null;
  currentPlaylistTracks = [];
  setLibraryContext('album', { name: albumName, artist: artistName });
  
  const currentQuery = searchInputEl ? searchInputEl.value : '';
  switchView('library', true);
  await handleSearchInput(currentQuery);
};

// Load Library
const loadLibrary = async () => {
  libraryCache = await electron.getLibrary();

  // Invalidate derived caches (albums/artists) so views reflect current library state
  albumsCache = [];
  artistsCache = [];

  const querySource = searchInputEl || document.getElementById('search-input');
  const query = querySource ? querySource.value.toLowerCase().trim() : '';

  if (libraryContext.type === 'playlist' && currentPlaylistFilter?.id) {
    try {
      const refreshed = await electron.getPlaylistTracks(currentPlaylistFilter.id);
      currentPlaylistTracks = Array.isArray(refreshed) ? refreshed : [];
    } catch (err) {
      console.warn('Failed to refresh playlist tracks', err);
      currentPlaylistTracks = [];
    }
  }

  applyLibrarySearch(query);
};

// Render Albums view
async function renderAlbums({ data, forceReload = false } = {}) {
  if (!viewAlbums) return;
  const container = document.getElementById('albums-container');
  if (!container) return;

  const source = Array.isArray(data) ? data : await ensureAlbumsCache(forceReload);

  if (!Array.isArray(source) || source.length === 0) {
    container.innerHTML = '<div class="empty">No albums found</div>';
    return;
  }

  container.innerHTML = '';

  for (const album of source) {
    const card = document.createElement('div');
    card.className = 'album-card';

    const img = document.createElement('img');
    img.className = 'album-art';
    const coverPath = album.cover_path || album.coverPath || '';
    if (coverPath) {
      if (coverPath.startsWith('http') || coverPath.startsWith('data:')) {
        img.src = coverPath;
      } else {
        electron.getCoverImage(coverPath).then((dataUrl) => {
          if (dataUrl) img.src = dataUrl;
          else img.classList.add('placeholder');
        }).catch(() => img.classList.add('placeholder'));
      }
      img.alt = (album.name || album.album || 'Album art');
    } else {
      img.classList.add('placeholder');
      img.alt = '';
    }

    const title = document.createElement('div');
    title.className = 'album-title';
    const albumName = (album.name || album.album || '').toString();
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

    card.onclick = (() => {
      const albumNameRaw = album.name || album.album || '';
      const nameToMatch = normalizeForCompare(albumNameRaw);
      const artistNameRaw = album.artist || album.artist_name || '';
      const artistToMatch = normalizeForCompare(artistNameRaw) || null;

      return async () => {
        if (!nameToMatch) {
          console.warn('Album click: empty album name, skipping filter');
          return;
        }

        currentAlbumFilter = { album: nameToMatch, artist: artistToMatch };
        currentArtistFilter = null;
        currentPlaylistFilter = null;
        currentPlaylistTracks = [];
        setLibraryContext('album', { name: albumNameRaw, artist: artistNameRaw });

        // When opening an album, ignore any existing search input so the full
        // album's tracks are shown (previous searches could unintentionally
        // filter out tracks). Clear the query passed to the search handler.
        const currentQuery = '';
        switchView('library', true);
        await handleSearchInput(currentQuery);
      };
    })();

    // Right-click context menu for album deletion
    card.oncontextmenu = (e) => {
      e.preventDefault();
      const albumNameRaw = album.name || album.album || '';
      const artistNameRaw = album.artist || album.artist_name || '';
      const trackCount = album.track_count || album.trackCount || 0;
      
      // Show a custom context menu
      showAlbumContextMenu(e, {
        albumName: albumNameRaw,
        artistName: artistNameRaw,
        trackCount: trackCount
      });
    };

    container.appendChild(card);
  }
}

async function renderArtists({ data, forceReload = false } = {}) {
  if (!viewArtists) return;
  const container = document.getElementById('artists-container');
  if (!container) return;

  const source = Array.isArray(data) ? data : await ensureArtistsCache(forceReload);

  if (!Array.isArray(source) || source.length === 0) {
    container.innerHTML = '<div class="empty">No artists found</div>';
    return;
  }

  container.innerHTML = '';

  for (const artist of source) {
    const card = document.createElement('div');
    card.className = 'album-card';

    const img = document.createElement('img');
    img.className = 'album-art';
    const coverPath = artist.cover_path || '';
    if (coverPath) {
      if (coverPath.startsWith('http') || coverPath.startsWith('data:')) {
        img.src = coverPath;
      } else {
        electron.getCoverImage(coverPath).then((dataUrl) => {
          if (dataUrl) img.src = dataUrl;
          else img.classList.add('placeholder');
        }).catch(() => img.classList.add('placeholder'));
      }
    } else {
      img.classList.add('placeholder');
    }
    
    const title = document.createElement('div');
    title.className = 'album-title';
    const artistName = (artist.name || '').toString();
    title.textContent = artistName || 'Unknown Artist';

    const count = document.createElement('div');
    count.className = 'album-artist';
    count.textContent = `${artist.album_count || 0} albums, ${artist.track_count || 0} tracks`;

    card.appendChild(img);
    card.appendChild(title);
    card.appendChild(count);

    card.onclick = (() => {
      const artistToMatch = normalizeForCompare(artistName);
      return async () => {
        currentArtistFilter = artistToMatch;
        currentAlbumFilter = null;
        currentPlaylistFilter = null;
        currentPlaylistTracks = [];
        setLibraryContext('artist', { name: artistName });

        const currentQuery = searchInputEl ? searchInputEl.value : '';
        switchView('library', true);
        await handleSearchInput(currentQuery);
      };
    })();

    container.appendChild(card);
  }
}

// Play Track
const playTrack = async (track, opts = {}) => {
  const { startTime, forceRestart = true } = opts || {};
  
  // Check if same track BEFORE updating currentTrack
  const isSameTrack = currentTrack && track && currentTrack.id === track.id;
  
  currentTrack = track;
  // Show UI animation for now playing
  showNowPlaying();
  // record start as lastPlayed with zero elapsed until periodic saver updates it
  const startPos = typeof startTime === 'number' && startTime >= 0 ? startTime : 0;
  saveLastPlayed(currentTrack, startPos);
  // Normalize sample rate: parse to integer and validate reasonable range
  let sr;
  if (settings.sampleRate) {
    const parsed = Number.parseInt(String(settings.sampleRate).trim(), 10);
    if (!Number.isNaN(parsed) && parsed > 8000 && parsed < 1000000) sr = parsed;
    else sr = undefined;
  } else sr = undefined;

  const playbackOptions = {
    deviceId: settings.deviceId,
    mode: settings.mode,
    bitPerfect: settings.bitPerfect,
    strictBitPerfect: settings.strictBitPerfect,
    sampleRate: sr,
    volume: Number(volumeSlider.value), // Pass current volume as number
    track: track
  };
  if (typeof startTime === 'number' && startTime >= 0) playbackOptions.startTime = startTime;
  // If we are already on this track and not forcing restart, just resume
  if (!forceRestart && isPlaying && isSameTrack) {
    await electron.resume();
  } else {
    await electron.playTrack(track.path, playbackOptions);
  }

  isPlaying = true;
  lastKnownPosition = startPos;
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
  const fsTotalTime = document.getElementById('fs-total-time');

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
  // Provide full text in title attribute so users can see the full name on hover
  try {
    fsTitle.title = fsTitle.textContent || '';
    fsArtist.title = fsArtist.textContent || '';
  } catch (e) {
    // ignore if elements missing
  }
  
  // Update time immediately
  if (fsTotalTime) fsTotalTime.textContent = formatTime(currentTrack.duration);
  
  // Wire up controls
  if (btnFsPlay) {
    btnFsPlay.onclick = async () => {
      try {
        // Capture latest position before toggling state
        const status = await electron.getAudioStatus().catch(() => null);
        if (status && typeof status.currentTime === 'number') {
          lastKnownPosition = status.currentTime;
        }

        if (isPlaying) {
          await electron.pause();
          isPlaying = false;
        } else {
          if (status && status.playing && status.paused) {
            await electron.resume();
          } else if (currentTrack) {
            // If engine lost state, restart from the last known position instead of 0
            await playTrack(currentTrack, { startTime: lastKnownPosition, forceRestart: true });
          } else {
            await electron.resume();
          }
          isPlaying = true;
        }
        updatePlayButton();
      } catch (err) {
        console.warn('Fullscreen play toggle failed', err);
      }
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
    if (src) startFsBgAnimationFromSrc(src);
    if (!src) {
      fsArt.classList.add('placeholder');
    } else {
      fsArt.classList.remove('placeholder');
    }
  };
  // Start animated canvas background when we set art for fullscreen
  if (fsBgArt) {
    // whenever fsBgArt.src changes we will start the animation
    const obs = new MutationObserver(() => {
      const src = fsBgArt.src || '';
      if (src) startFsBgAnimationFromSrc(src);
    });
    // If image already has src, start immediately
    if (fsBgArt.src) startFsBgAnimationFromSrc(fsBgArt.src);
    // observe attribute changes (src)
    obs.observe(fsBgArt, { attributes: true, attributeFilter: ['src'] });
    // store observer so we can disconnect on hideFullscreen if desired
    fsBgArt._fsObserver = obs;
  }
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
  // Stop animated background and clean up any observers
  try {
    stopFsBgAnimation();
    const fsBgArt = document.getElementById('fs-bg-art');
    if (fsBgArt && fsBgArt._fsObserver) {
      try { fsBgArt._fsObserver.disconnect(); } catch(e) {}
      fsBgArt._fsObserver = null;
    }
  } catch (e) {}
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
    // Delegate to the scoped search handler which respects currentView and libraryContext
    void handleSearchInput(query);
  });

  // Enter key should also run the scoped search immediately
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = e.target.value.toLowerCase().trim();
      void handleSearchInput(q);
    }
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
      // reset auto-advance marker when track changes
      lastAutoAdvancedTrackId = null;
      updateNowPlaying();
      showNowPlaying();
      renderLibrary();
  } else if (state.track && currentTrack) {
      // Even if same track, ensure the now playing bar is visible
      showNowPlaying();
  }

  // Update Volume
  if (volumeSlider && state.volume !== undefined) {
      if (document.activeElement !== volumeSlider) {
           volumeSlider.value = state.volume;
      }
  }
};

// Advance playback to the next track based on current context (playlist vs library)
async function advanceToNext() {
  if (!currentTrack) return;
  // If repeat one, restart same track
  if (repeatMode === 'one') {
    try { await playTrack(currentTrack); } catch (e) { console.warn('advanceToNext replay failed', e); }
    return;
  }

  // Determine source list
  let sourceList = [];
  if (libraryContext.type === 'playlist' && Array.isArray(currentPlaylistTracks) && currentPlaylistTracks.length) {
    sourceList = currentPlaylistTracks;
  } else if (Array.isArray(tracks) && tracks.length) {
    sourceList = tracks;
  } else if (Array.isArray(libraryCache) && libraryCache.length) {
    sourceList = libraryCache;
  }

  if (!sourceList || sourceList.length === 0) return;

  // Find current index in sourceList
  let idx = sourceList.findIndex(t => (t.id && currentTrack.id && t.id === currentTrack.id) || (t.path && currentTrack.path && t.path === currentTrack.path));

  // Shuffle handling
  if (shuffleEnabled) {
    const randIdx = Math.floor(Math.random() * sourceList.length);
    const next = sourceList[randIdx];
    if (next) await playTrack(next);
    return;
  }

  // Next index
  if (idx === -1) idx = 0;
  const nextIdx = idx + 1;
  if (nextIdx < sourceList.length) {
    await playTrack(sourceList[nextIdx]);
  } else {
    // End of list
    if (repeatMode === 'all') {
      await playTrack(sourceList[0]);
    } else {
      // stop playback
      try { await electron.pause(); } catch {}
      isPlaying = false;
      updatePlayButton();
    }
  }
}

// Plugin System API (sandboxed via factory)
const SPECTRA_PLUGIN_API_VERSION = 1;

const isWebClient = typeof window !== 'undefined' && window.location && /^http/.test(window.location.protocol || '');

const convertPluginProtocolUrl = (url) => {
  if (typeof url !== 'string') return url;
  if (!url.startsWith('plugins://')) return url;
  const remainder = url.slice('plugins://'.length);
  return `/plugins/${remainder}`;
};

const resolvePluginResource = (pluginId, resourcePath) => {
  if (!resourcePath) return resourcePath;
  let resourceUrl = resourcePath;
  if (!resourceUrl.startsWith('plugins://') && !/^\w+:\/\//.test(resourceUrl) && !resourceUrl.startsWith('/')) {
    resourceUrl = `plugins://${pluginId}/${resourceUrl}`;
  }
  if (isWebClient) {
    return convertPluginProtocolUrl(resourceUrl);
  }
  return resourceUrl;
};

const removePluginAssets = (pluginId) => {
  if (!pluginId) return;
  const selectors = [
    `link[href*="plugins://${pluginId}/"]`,
    `script[src*="plugins://${pluginId}/"]`,
    `img[src*="plugins://${pluginId}/"]`
  ];
  if (isWebClient) {
    selectors.push(
      `link[href*="/plugins/${pluginId}/"]`,
      `script[src*="/plugins/${pluginId}/"]`,
      `img[src*="/plugins/${pluginId}/"]`
    );
  }
  selectors.forEach((selector) => {
    try {
      document.querySelectorAll(selector).forEach((el) => el.remove());
    } catch (err) {
      console.warn('Failed to remove plugin asset', selector, err);
    }
  });
};

if (isWebClient) {
  const normalizeElementResourceAttrs = (element) => {
    if (!element || element.nodeType !== 1) return;
    if (element.hasAttribute('src')) {
      const src = element.getAttribute('src');
      const converted = convertPluginProtocolUrl(src);
      if (converted !== src) element.setAttribute('src', converted);
    }
    if (element.hasAttribute('href')) {
      const href = element.getAttribute('href');
      const converted = convertPluginProtocolUrl(href);
      if (converted !== href) element.setAttribute('href', converted);
    }
  };

  const scanAndNormalize = (root) => {
    if (!root) return;
    if (root.nodeType === 1) normalizeElementResourceAttrs(root);
    if (root.querySelectorAll) {
      root.querySelectorAll('[src],[href]').forEach((node) => normalizeElementResourceAttrs(node));
    }
  };

  scanAndNormalize(document);

  const urlObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        normalizeElementResourceAttrs(mutation.target);
        continue;
      }
      if (mutation.type === 'childList') {
        Array.from(mutation.addedNodes || []).forEach((node) => {
          if (node.nodeType !== 1) return;
          scanAndNormalize(node);
        });
      }
    }
  });

  try {
    urlObserver.observe(document.documentElement || document.body || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href']
    });
  } catch (observerErr) {
    console.warn('Failed to initialize plugin resource normalizer', observerErr);
  }
}

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
    notify: (options) => {
      if (!options) return;
      if (typeof options === 'string') NotificationCenter.show({ message: options });
      else NotificationCenter.show(options);
    },
    notifyUpdate: (options) => {
      if (!options) return;
      NotificationCenter.update(options);
    },
    dismissNotification: () => {
      NotificationCenter.hide();
    },
    prompt: (message, defaultValue) => customPrompt(message, defaultValue),
    confirm: (message, opts) => customConfirm(message, opts),
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
        } catch { /* ignore selector errors */ }

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
            } catch { /* ignore per-node removal errors */ }
          }
          // Remove any globals the plugin promised to expose
          if (reg.globals && reg.globals.size) {
            try {
              for (const g of Array.from(reg.globals)) {
                try { if (window && window[g]) delete window[g]; } catch {}
                try { if (window.Spectra && window.Spectra.plugins && window.Spectra.plugins[pluginId]) delete window.Spectra.plugins[pluginId][g]; } catch {}
              }
            } catch {}
          }
          // Attempt to remove any IPC listeners the plugin may have registered
          try {
            if (window && window.electron && typeof window.electron.off === 'function') {
              try { window.electron.off(`${pluginId}:files`); } catch {}
              try { window.electron.off(`${pluginId}:status`); } catch {}
            }
          } catch {}
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
      try { Spectra.ui.unregisterPluginTargets(p.id); } catch {}

      const pid = p.id;
      if (!pid) continue;

      // Remove nav/view elements specifically (common plugin UI pattern)
      try { document.getElementById(`nav-${pid}`)?.remove(); } catch {}
      try { document.getElementById(`view-${pid}`)?.remove(); } catch {}

      // Remove plugin-prefixed elements (but not settings UI)
      try {
        document.querySelectorAll(`[id^="${pid}-"]`).forEach((el) => el.remove());
      } catch { /* ignore selector errors */ }

      removePluginAssets(pid);

      // Remove a well-known style id pattern used by some plugins
      try { document.getElementById(`style-${pid}`)?.remove(); } catch {}
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
    } catch {}
    // Notify main we're ready for it to proceed with deactivation
    try {
      if (typeof electron.signalPluginsReadyForReload === 'function') {
        Promise.resolve(electron.signalPluginsReadyForReload()).catch((err) => {
          console.warn('Failed to notify main about plugin reload readiness', err);
        });
      }
    } catch {}
  });
  electron.on('plugins:reloaded', () => {
    // Re-run plugin loading in renderer to pick up new/updated UI entries
    try { loadPlugins(); } catch (e) { console.warn('Failed to reload plugins in renderer', e); }
  });
} catch {
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
          removePluginAssets(pid);
          document.getElementById(`style-${pid}`)?.remove();
        } catch (err) {
          console.warn(`Failed to cleanup ${pid}:`, err);
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

        const iconSrc = p.icon ? resolvePluginResource(p.id, p.icon) : '';
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
                removePluginAssets(pid);
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
        let entryUrl = resolvePluginResource(p.id, p.entry);
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
  notificationDetail = document.getElementById('notification-detail');
  notificationClose = document.getElementById('notification-close');
  notificationTrack = document.querySelector('#notification-bar .progress-track');

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

  // Listen for library refresh requests (e.g., from plugins)
  window.addEventListener('spectra:refresh-library', async () => {
    await loadLibrary();
  });

  // Import buttons
  if (btnImportFile) btnImportFile.onclick = async () => { await electron.importFile(); loadLibrary(); };
  if (btnImportFolder) btnImportFolder.onclick = async () => { await electron.importFolder(); loadLibrary(); };
  if (btnNewPlaylist) btnNewPlaylist.onclick = async () => {
    const name = await customPrompt('New playlist name:');
    if (!name || !name.trim()) return;
    try {
      await electron.createPlaylist(name.trim());
      // Refresh playlists view if currently visible
      playlistsCache = [];
      if (viewPlaylists && viewPlaylists.style.display !== 'none') renderPlaylists({ forceReload: true });
    } catch (e) {
      console.error('Failed to create playlist', e);
      alert('Failed to create playlist');
    }
  };
  if (btnImportPlaylist) btnImportPlaylist.onclick = async () => {
    try {
      const res = await electron.importPlaylist();
      if (res && res.success) {
        playlistsCache = [];
        await renderPlaylists({ forceReload: true });
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
        } catch {
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
    try { electron.setVolume(Number(savedVol)); } catch {}

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

  // Album context menu actions
  electron.on('album:delete-confirm', (albumInfo) => {
    handleAlbumDeleteConfirm(albumInfo);
  });

  electron.on('album:view', (albumInfo) => {
    handleAlbumView(albumInfo);
  });

  window.onclick = (event) => { if (event.target === editModal) closeEditModal(); };

  // Import progress notifications
  electron.on('import:start', ({ total }) => {
    NotificationCenter.show({
      message: 'Adding tracks...',
      mode: 'progress',
      progress: 0,
      count: `0/${total}`,
      sticky: true,
      dismissible: false
    });
  });
  electron.on('import:progress', ({ current, total, filename }) => {
    NotificationCenter.update({
      message: filename ? `Adding: ${filename}` : 'Adding tracks...',
      mode: 'progress',
      progress: total ? (current / total) * 100 : 0,
      count: `${current}/${total}`
    });
  });
  electron.on('import:complete', () => {
    NotificationCenter.show({
      message: 'Import complete!',
      type: 'success',
      autoClose: 2600,
      sticky: false,
      onClose: async () => {
        try { await loadLibrary(); } catch (err) { console.warn('Library refresh after import failed', err); }
      }
    });
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
      playlistsCache = [];
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
        await renderPlaylists({ forceReload: true });
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
    try { playlistsCache = []; await renderPlaylists({ forceReload: true }); } catch {}
  });

  // Periodic UI updates
  setInterval(async () => {
      if (currentTrack) {
        // Prefer full audio status when available
        let status = null;
        try { status = await electron.getAudioStatus(); } catch {}
        let time = 0;
        if (status && typeof status.currentTime === 'number') time = status.currentTime;
        else {
          try { time = await electron.getTime(); } catch {}
        }
        if (time > 0) lastKnownPosition = time;
        if (currentTimeEl) currentTimeEl.textContent = formatTime(time);
        if (!isSeeking && currentTrack.duration > 0 && seekSlider) seekSlider.value = (time / currentTrack.duration) * 100;
        // Persist last played position
        saveLastPlayed(currentTrack, time);
        // Ensure Now Playing bar visible when we have a current track
        showNowPlaying();

        // Auto-advance detection: if player reports not playing/paused and time is at/after end
        try {
          const playingFlag = status ? Boolean(status.playing) : isPlaying;
          const pausedFlag = status ? Boolean(status.paused) : !isPlaying;
          const nearEnd = currentTrack.duration > 0 && time >= Math.max(0, currentTrack.duration - AUTO_ADVANCE_EPS);
          if (nearEnd && (!playingFlag || pausedFlag)) {
            if (lastAutoAdvancedTrackId !== (currentTrack && currentTrack.id)) {
              lastAutoAdvancedTrackId = currentTrack && currentTrack.id;
              void advanceToNext();
            }
          }
        } catch (err) {
          // ignore
        }
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
