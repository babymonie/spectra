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

// The list of tracks the current playback session is drawing from. This is
// separate from `tracks` (the list currently shown in the library view) so
// that browsing a different album while music is playing does not change
// what plays next. Set by startPlayback() and used by advanceToNext/Prev/Next.
let playbackContext = { list: [], type: 'library', key: null };

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
let dsdTransportSelect;
let bitPerfectCheckbox;
let strictBitPerfectCheckbox;
let remoteEnableCheckbox;
let sampleRateSelect;
let sampleRateModeSelect;
let sampleRateCustomInput;
let bufferMsSelect;
let bufferFramesInput;
let asioControlPanelButton;
let outputDevices = [];

// Navigation Elements
let navLibrary;
let navPlaylists;
let navSettings;
let navAlbums;
let navArtists;
let navUpnp;
let navNas;
let viewLibrary;
let viewPlaylists;
let viewSettings;
let viewAlbums;
let viewArtists;

// UPnP state
let upnpServers = [];
let upnpSelectedUsn = null;
let upnpBreadcrumb = [];

// NAS state
let nasShares = [];
let nasSelectedShareId = null;
let nasBreadcrumb = [];
let showNasModal = null; // set by initNasModal, called from renderNasShares

// Other DOM elements assigned in init
let btnImportFile;
let btnImportFolder;
let btnImportUrl;
let editModal;
let editTitle;
let editArtist;
let editAlbum;
let editAlbumArtist;
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
let currentAlbumTracks = [];
let currentAlbumTracksKey = null;
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
let lastStatusDuration = 0; // duration reported by the engine (network tracks have none in the DB)
let engineActive = false; // engine has a track loaded (playing or paused)
let stopAfterCurrent = false;
let pendingResumePosition = null; // restored "last played" position, used by the first Play
let playInstance = 0; // bumped on every playTrack(); guards against double auto-advance
let advancedInstance = -1;
let endedPolls = 0;
let playRequestsInFlight = 0;
let libraryRenderToken = 0;
let librarySort = { key: null, dir: 1 };
let playHistory = [];
let shufflePlayed = new Set();
let forcedNext = []; // "Play Next" items, honoured before list order / shuffle

const trackKey = (t) => (t && t.id != null ? `id:${t.id}` : `path:${t?.path || ''}`);
const tracksMatch = (a, b) => !!a && !!b && (
  (a.id != null && b.id != null && String(a.id) === String(b.id)) ||
  (!!a.path && !!b.path && a.path === b.path)
);
const effectiveDuration = () => {
  const own = Number(currentTrack?.duration);
  return own > 0 ? own : (lastStatusDuration || 0);
};

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

const UNKNOWN_ARTIST_RE = /^(unknown|unknown artist|<unknown>|n\/?a|none|null|-|—)$/i;
const cleanArtistName = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const isMeaningfulArtistName = (value) => {
  const cleaned = cleanArtistName(value);
  return !!cleaned && !UNKNOWN_ARTIST_RE.test(cleaned);
};
const splitArtistNames = (value) => {
  const raw = cleanArtistName(value);
  if (!isMeaningfulArtistName(raw)) return [];
  return raw
    .replace(/\s+(feat\.?|ft\.?|featuring|with)\s+/gi, ';')
    .split(/\s*(?:,|;|\/|\||&|\band\b|،|，|、|؛)\s*/i)
    .map(cleanArtistName)
    .filter(isMeaningfulArtistName);
};

const getTrackArtistNames = (track) => {
  const artists = splitArtistNames(track?.artist);
  if (artists.length) return artists;
  return splitArtistNames(track?.album_artist || track?.name);
};

const getDisplayArtistName = (track) => {
  const rawArtist = cleanArtistName(track?.artist);
  if (isMeaningfulArtistName(rawArtist)) return rawArtist;
  return getTrackArtistNames(track)[0] || 'Unknown Artist';
};

const normalizeAlbumArtistKey = (trackOrArtist) => {
  if (typeof trackOrArtist === 'string') return normalizeForCompare(cleanArtistName(trackOrArtist));
  const albumArtist = isMeaningfulArtistName(trackOrArtist?.album_artist) ? trackOrArtist.album_artist : '';
  const primary = albumArtist || getTrackArtistNames(trackOrArtist)[0] || '';
  return normalizeForCompare(primary);
};

const getTrackArtistKeys = (track) => getTrackArtistNames(track).map((name) => normalizeForCompare(name));

const canonicalArtistDisplayName = (trackOrArtist) => {
  const raw = typeof trackOrArtist === 'string'
    ? trackOrArtist
    : (trackOrArtist?.name || trackOrArtist?.artist || trackOrArtist?.album_artist || '');
  const cleaned = cleanArtistName(raw);
  return isMeaningfulArtistName(cleaned) ? cleaned : 'Unknown Artist';
};
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

// Ensure a <style> element with the given id exists and return it
function ensureStyleEl(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  return el;
}

async function applyActiveThemeNow() {
  const { themeCss, quickCss } = await window.themes.getActiveCss();
  ensureStyleEl('spectra-theme-style').textContent = themeCss || '';
  ensureStyleEl('spectra-quickcss-style').textContent = quickCss || '';
}

// call on app load
document.addEventListener('DOMContentLoaded', () => {
  // Ensure style elements exist once at startup
  ensureStyleEl('spectra-theme-style');
  ensureStyleEl('spectra-quickcss-style');

  applyActiveThemeNow().catch(console.error);
});

async function refreshThemeGrid() {
  const grid = document.getElementById("themesGrid");
  if (!grid) return;

  const { themes, selectedTheme } = await window.themes.list();

  grid.innerHTML = "";

  // Default theme card
  grid.appendChild(makeThemeCard({
    name: "Default",
    desc: "Built-in Spectra theme",
    active: selectedTheme == null,
    selectableName: null,
    removable: false
  }));

  for (const t of themes) {
    grid.appendChild(makeThemeCard({
      name: t.name,
      desc: `Local theme • ${t.filename}`,
      active: selectedTheme === t.name,
      selectableName: t.name,
      removable: true
    }));
  }
}

function makeThemeCard({ name, desc, active, selectableName, removable }) {
  const card = document.createElement("div");
  card.className = `theme-card ${active ? "active" : ""}`;

  // left column: preview + meta
  const left = document.createElement("div");
  left.className = "theme-left";

  const preview = document.createElement("div");
  preview.className = "theme-preview";
  // preview can be styled dynamically later (background, gradients, etc.)

  const meta = document.createElement("div");
  meta.className = "theme-meta";
  meta.innerHTML = `
    <div class="theme-name">${escapeHtml(name)}</div>
    <div class="theme-desc">${escapeHtml(desc)}</div>
  `;

  left.appendChild(preview);
  left.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "theme-actions-inline";

  const btnSelect = document.createElement("button");
  btnSelect.className = `theme-iconbtn select ${active ? "active" : ""}`;
  btnSelect.title = "Select theme";
  btnSelect.innerHTML = '<span class="material-icons">check</span>';

  btnSelect.addEventListener("click", async () => {
    const { themeCss, quickCss } = await window.themes.select(selectableName); // null => default
    document.getElementById("spectra-theme-style").textContent = themeCss || "";
    document.getElementById("spectra-quickcss-style").textContent = quickCss || "";
    await refreshThemeGrid();
  });

  actions.appendChild(btnSelect);

  if (removable) {
    const btnRemove = document.createElement("button");
    btnRemove.className = "theme-iconbtn";
    btnRemove.title = "Delete theme";
    btnRemove.innerHTML = '<span class="material-icons">delete</span>';

    btnRemove.addEventListener("click", async () => {
      await window.themes.remove(selectableName);
      // After remove, re-apply active css in case active theme got deleted
      const { themeCss, quickCss } = await window.themes.getActiveCss();
      document.getElementById("spectra-theme-style").textContent = themeCss || "";
      document.getElementById("spectra-quickcss-style").textContent = quickCss || "";
      await refreshThemeGrid();
    });

    actions.appendChild(btnRemove);
  }

  card.appendChild(left);
  card.appendChild(actions);
  return card;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initThemesSettingsUI() {
  // Tabs
  const tabs = document.querySelectorAll(".themes-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      const target = tab.dataset.tab;
      document.getElementById("themes-panel-local").classList.toggle("active", target === "local");
      document.getElementById("themes-panel-quickcss").classList.toggle("active", target === "quickcss");
    });
  });

  // Buttons
  document.getElementById("btnOpenThemesFolder")?.addEventListener("click", () => window.themes.openFolder());
  document.getElementById("btnImportTheme")?.addEventListener("click", async () => {
    await window.themes.importDialog();
    await refreshThemeGrid();
  });
  document.getElementById("btnReloadThemes")?.addEventListener("click", refreshThemeGrid);

  // QuickCSS
  const editor = document.getElementById("quickCssEditor");
  if (editor) {
    window.themes.getQuickCss().then(({ quickCss }) => (editor.value = quickCss || ""));

    document.getElementById("btnSaveQuickCss")?.addEventListener("click", async () => {
      await window.themes.setQuickCss(editor.value);
      // apply immediately
      const { themeCss, quickCss } = await window.themes.getActiveCss();
      document.getElementById("spectra-theme-style").textContent = themeCss || "";
      document.getElementById("spectra-quickcss-style").textContent = quickCss || "";
    });

    document.getElementById("btnClearQuickCss")?.addEventListener("click", async () => {
      editor.value = "";
      await window.themes.setQuickCss("");
      document.getElementById("spectra-quickcss-style").textContent = "";
    });
  }

  refreshThemeGrid().catch(console.error);
}

// Call this when your Settings page is mounted/created
initThemesSettingsUI();

// Query syntax (foobar-style, all terms must match):
//   word            matches title / artist / album / album artist / file name
//   "exact phrase"  quoted phrases stay together
//   -word           excludes
//   field:value     title: artist: album: albumartist: genre: year: format: codec: path:
// Matching ignores case and accents ("beyonce" finds "Beyoncé").
const SEARCH_FIELDS = {
  title: ['title'],
  artist: ['artist', 'album_artist'],
  album: ['album'],
  albumartist: ['album_artist'],
  genre: ['genre'],
  year: ['year'],
  format: ['format', 'codec'],
  codec: ['codec', 'format'],
  path: ['path'],
  file: ['path'],
};

const tokenizeQuery = (query) => {
  if (!query) return [];
  const tokens = [];
  const re = /([+-]?)(?:([a-z_]+):)?(?:"([^"]*)"?|(\S+))/gi;
  let m;
  while ((m = re.exec(String(query))) !== null) {
    let field = m[2] ? m[2].toLowerCase() : null;
    let text = m[3] !== undefined ? m[3] : (m[4] || '');
    if (field && !SEARCH_FIELDS[field]) {
      // Not a field we know ("re:stacks"): treat the whole thing as text.
      text = `${m[2]}:${text}`;
      field = null;
    }
    text = normalizeForCompare(text);
    if (!text) continue;
    tokens.push({ type: m[1] === '-' ? 'exclude' : 'include', field, text });
  }
  return tokens;
};

const trackSearchCache = new WeakMap();
const trackHaystack = (track) => {
  let hay = trackSearchCache.get(track);
  if (hay === undefined) {
    const fileName = track?.path ? String(track.path).split(/[/\\]/).pop() : '';
    hay = normalizeForCompare([track?.title, track?.artist, track?.album, track?.album_artist, fileName].filter(Boolean).join(' \u0001 '));
    trackSearchCache.set(track, hay);
  }
  return hay;
};

const matchesTrackToken = (track, token) => {
  const needle = token.text || '';
  if (!needle) return true;
  if (token.field) {
    return SEARCH_FIELDS[token.field].some((key) => normalizeForCompare(track?.[key] ?? '').includes(needle));
  }
  return trackHaystack(track).includes(needle);
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

// Column sorting (click a column header). No sort = the list's natural order.
const sortTracks = (list) => {
  if (!librarySort.key || !Array.isArray(list)) return list;
  const { key, dir } = librarySort;
  const text = (t) => (key === 'artist' ? getDisplayArtistName(t) : String(t?.[key] ?? ''));
  return [...list].sort((a, b) => {
    if (key === 'duration') return ((Number(a?.duration) || 0) - (Number(b?.duration) || 0)) * dir;
    return text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
};

const computeLibraryBase = () => {
  if (libraryContext.type === 'playlist' && currentPlaylistFilter) {
    return Array.isArray(currentPlaylistTracks) ? [...currentPlaylistTracks] : [];
  }

  let base = Array.isArray(libraryCache) ? libraryCache : [];

  if (currentAlbumFilter && currentAlbumFilter.album) {
    const albumKey = currentAlbumFilter.album;
    const artistKey = currentAlbumFilter.artist || '';
    base = base.filter((t) => {
      const trackAlbum = normalizeForCompare(t.album || '');
      if (trackAlbum !== albumKey) return false;
      if (!artistKey) return true;
      return normalizeAlbumArtistKey(t) === artistKey;
    });
  } else if (currentArtistFilter) {
    base = base.filter((t) => getTrackArtistKeys(t).includes(currentArtistFilter));
  }

  return base;
};

const applyLibrarySearch = (query) => {
  const base = computeLibraryBase();
  tracks = sortTracks(filterTracksByQuery(base, query));
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
    currentAlbumTracks = [];
    currentAlbumTracksKey = null;
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

  if (libraryContext.type === 'album') {
    // When viewing an album we render a dedicated album header in the library view.
    // Hide the smaller H2 header to avoid duplicating the title.
    libraryTitleEl.style.display = 'none';
    return;
  } else if (libraryContext.type === 'artist') {
    const label = libraryContext.name ? `Artist - ${libraryContext.name}` : 'Artist';
    libraryTitleEl.innerHTML = `<span class="back-to-library" title="Back to Library"><span class="material-icons">arrow_back</span></span> ${esc(label)}`;
  } else if (libraryContext.type === 'playlist') {
    const label = libraryContext.name ? `Playlist - ${libraryContext.name}` : 'Playlist';
    libraryTitleEl.innerHTML = `<span class="back-to-library" title="Back to Library"><span class="material-icons">arrow_back</span></span> ${esc(label)}`;
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
  const needles = normalizeForCompare(query || '').split(/\s+/).filter(Boolean);
  if (!needles.length) return true;
  const hay = normalizeForCompare(`${album?.name || album?.album || ''} ${album?.artist || ''}`);
  return needles.every((n) => hay.includes(n));
};

const artistMatchesQuery = (artist, query) => {
  const needles = normalizeForCompare(query || '').split(/\s+/).filter(Boolean);
  if (!needles.length) return true;
  const hay = normalizeForCompare(artist?.name || '');
  return needles.every((n) => hay.includes(n));
};

const playlistMatchesQuery = (playlist, query) => {
  const needles = normalizeForCompare(query || '').split(/\s+/).filter(Boolean);
  if (!needles.length) return true;
  const hay = normalizeForCompare(playlist?.name || '');
  return needles.every((n) => hay.includes(n));
};

async function ensureAlbumsCache(force = false) {
  if (!force && Array.isArray(albumsCache) && albumsCache.length) {
    return albumsCache;
  }
  try {
    const albums = await electron.getAlbums();
    const raw = Array.isArray(albums) ? albums : [];
    const merged = new Map();
    for (const album of raw) {
      const name = String(album?.name || album?.album || '').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      const artist = canonicalArtistDisplayName(album?.artist || album?.artist_name || '');
      const key = `${normalizeForCompare(name)}::${normalizeAlbumArtistKey(artist)}`;
      if (!merged.has(key)) {
        merged.set(key, {
          name,
          artist: artist || 'Unknown Artist',
          track_count: 0,
          cover_path: album?.cover_path || album?.coverPath || '',
        });
      }
      const row = merged.get(key);
      const trk = Number(album?.track_count ?? album?.trackCount ?? 0);
      if (Number.isFinite(trk) && trk > 0) row.track_count += trk;
      if (!row.cover_path && (album?.cover_path || album?.coverPath)) {
        row.cover_path = album.cover_path || album.coverPath;
      }
    }
    albumsCache = Array.from(merged.values()).sort((a, b) =>
      String(a.artist || '').localeCompare(String(b.artist || ''), undefined, { sensitivity: 'base' }) ||
      String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    );
  } catch (err) {
    console.error('Failed to load albums:', err);
    albumsCache = [];
    artistsCache = [];
  }
  return albumsCache;
}

async function ensureArtistsCache(force = false) {
  if (!force && Array.isArray(artistsCache) && artistsCache.length) {
    return artistsCache;
  }
  try {
    const artists = await electron.getArtists();
    const raw = Array.isArray(artists) ? artists : [];
    const merged = new Map();
    for (const artist of raw) {
      const name = canonicalArtistDisplayName(artist?.name || artist?.artist || '');
      const key = normalizeForCompare(name);
      if (!key) continue;
      if (!merged.has(key)) {
        merged.set(key, {
          name,
          track_count: 0,
          album_count: 0,
          cover_path: artist?.cover_path || '',
        });
      }
      const row = merged.get(key);
      const trk = Number(artist?.track_count ?? artist?.trackCount ?? 0);
      const alb = Number(artist?.album_count ?? artist?.albumCount ?? 0);
      if (Number.isFinite(trk) && trk > 0) row.track_count += trk;
      if (Number.isFinite(alb) && alb > row.album_count) row.album_count = alb;
      if (!row.cover_path && artist?.cover_path) row.cover_path = artist.cover_path;
    }
    artistsCache = Array.from(merged.values()).sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    );
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

async function ensureAlbumTracks(albumNameRaw, albumArtistRaw = '', force = false) {
  const key = normalizeForCompare(albumNameRaw || '');
  const artistKey = normalizeForCompare(albumArtistRaw || '');
  const cacheKey = `${key}::${artistKey}`;
  if (!key) return [];

  if (!force && currentAlbumTracksKey === cacheKey && Array.isArray(currentAlbumTracks)) {
    return currentAlbumTracks;
  }

  try {
    if (electron && typeof electron.getAlbumTracks === 'function') {
      const list = await electron.getAlbumTracks(albumNameRaw, albumArtistRaw || null);
      currentAlbumTracks = Array.isArray(list) ? list : [];
      currentAlbumTracksKey = cacheKey;
      return currentAlbumTracks;
    }
  } catch (err) {
    console.warn('getAlbumTracks failed for', albumNameRaw, err);
  }

  // Fallback: derive from cached library.
  const fallback = Array.isArray(libraryCache)
    ? libraryCache.filter((t) => {
      const albumMatch = normalizeForCompare(t.album || '') === key;
      if (!albumMatch) return false;
      if (!artistKey) return true;
      return normalizeAlbumArtistKey(t) === artistKey;
    })
    : [];

  currentAlbumTracks = fallback;
  currentAlbumTracksKey = cacheKey;
  return fallback;
}

async function handleSearchInput(rawValue = '', { fromUser = false } = {}) {
  const query = (rawValue || '').trim();

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

  // Network browsers: filter what is on screen (Enter searches the server).
  if (currentView === 'upnp' || currentView === 'nas') {
    applyNetFilter(currentView, query);
    return;
  }

  // Any other view (Settings, plugin pages) has nothing to filter: typing a
  // query there jumps to the library results instead of silently doing nothing.
  if (currentView !== 'library') {
    if (fromUser && query) switchView('library', true);
    return;
  }

  // Album view loads tracks by normalized album + album artist context.
  if (libraryContext.type === 'album' && libraryContext.name) {
    const base = await ensureAlbumTracks(libraryContext.name, libraryContext.artist);
    tracks = sortTracks(filterTracksByQuery(base, query));
    renderLibrary();
    return;
  }

  applyLibrarySearch(query);
}

// Escape HTML to prevent injection when rendering track metadata from DB
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Render a single queue row (Spotify-like): thumbnail + title/artist + duration + remove
function buildQueueItem(track, index, { isCurrent = false } = {}) {
  const item = document.createElement('div');
  item.className = 'queue-item' + (isCurrent ? ' current' : '');
  item.dataset.index = String(index);

  const title = track.title || (track.path ? String(track.path).split(/[/\\]/).pop() : 'Unknown Title');
  const artist = getDisplayArtistName(track);
  const album = track.album || '';
  const durationStr = typeof track.duration === 'number' && isFinite(track.duration) && track.duration > 0
    ? formatTime(track.duration)
    : '';

  item.innerHTML = `
    <div class="queue-item-art-wrap">
      <div class="queue-item-art placeholder">
        <span class="material-icons">music_note</span>
      </div>
      ${isCurrent ? '<div class="queue-item-playing-indicator"><span class="material-icons">equalizer</span></div>' : ''}
    </div>
    <div class="queue-item-info">
      <div class="queue-item-title">${esc(title)}</div>
      <div class="queue-item-artist">${esc(artist)}${album ? ' - ' + esc(album) : ''}</div>
    </div>
    <div class="queue-item-duration">${durationStr}</div>
    <button class="queue-item-remove icon-btn" title="Remove">
      <span class="material-icons">close</span>
    </button>
  `;

  // Load cover art asynchronously without blocking render
  const artEl = item.querySelector('.queue-item-art');
  const cover = track.cover_path || track.coverPath;
  if (cover) {
    if (cover.startsWith('http') || cover.startsWith('data:')) {
      artEl.style.backgroundImage = `url('${cover}')`;
      artEl.classList.remove('placeholder');
      artEl.innerHTML = '';
    } else if (electron && electron.getCoverImage) {
      electron.getCoverImage(cover).then((url) => {
        if (url) {
          artEl.style.backgroundImage = `url('${url}')`;
          artEl.classList.remove('placeholder');
          artEl.innerHTML = '';
        }
      }).catch(() => {});
    }
  }

  // Clicking a queue row plays that track. Keep the current playback context
  // (the queue itself) — don't reset it.
  item.addEventListener('click', async (e) => {
    if (e.target.closest('.queue-item-remove')) return;
    await startPlayback(track, playbackQueue, {
      type: playbackContext.type || 'queue',
      key: playbackContext.key || null,
    });
    await renderQueue();
  });

  const removeBtn = item.querySelector('.queue-item-remove');
  removeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await electron.removeFromQueue(index);
    await renderQueue();
  });

  return item;
}

// Helper function to render queue in a Spotify-like grouped layout:
// "Now Playing" on top, then "Next Up" with remaining tracks.
async function renderQueue() {
  const queueList = document.getElementById('queue-list');
  if (!queueList) return;

  try {
    const queue = await electron.getQueue();
    playbackQueue = queue.queue || [];
    queueIndex = typeof queue.index === 'number' ? queue.index : -1;

    if (playbackQueue.length === 0) {
      queueList.innerHTML = `
        <div class="queue-empty">
          <span class="material-icons">queue_music</span>
          <p>Queue is empty</p>
          <p class="queue-empty-hint">Play something from your library and it'll appear here.</p>
        </div>
      `;
      return;
    }

    queueList.innerHTML = '';

    // Resolve "current" for the queue header — prefer queueIndex, else match currentTrack
    let currentIdx = queueIndex;
    if ((currentIdx < 0 || currentIdx >= playbackQueue.length) && currentTrack) {
      currentIdx = playbackQueue.findIndex((t) =>
        (t.id && currentTrack.id && t.id === currentTrack.id) ||
        (t.path && currentTrack.path && t.path === currentTrack.path)
      );
    }

    // Now Playing section
    if (currentIdx >= 0 && currentIdx < playbackQueue.length) {
      const sectionNow = document.createElement('div');
      sectionNow.className = 'queue-section';
      sectionNow.innerHTML = '<div class="queue-section-title">Now Playing</div>';
      sectionNow.appendChild(buildQueueItem(playbackQueue[currentIdx], currentIdx, { isCurrent: true }));
      queueList.appendChild(sectionNow);
    }

    // Next Up section
    const upcoming = [];
    for (let i = 0; i < playbackQueue.length; i++) {
      if (i === currentIdx) continue;
      if (currentIdx >= 0 && i < currentIdx) continue; // only show forward queue
      upcoming.push({ track: playbackQueue[i], index: i });
    }

    if (upcoming.length) {
      const sectionNext = document.createElement('div');
      sectionNext.className = 'queue-section';
      const contextLabel = playbackContext.key
        ? ` - From ${esc(String(playbackContext.key))}`
        : '';
      sectionNext.innerHTML = `<div class="queue-section-title">Next Up${contextLabel}</div>`;
      for (const { track, index } of upcoming) {
        sectionNext.appendChild(buildQueueItem(track, index));
      }
      queueList.appendChild(sectionNext);
    }
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
        <div class="playlist-track-title">${esc(track.title || 'Unknown Title')}</div>
        <div class="playlist-track-artist">${esc(getDisplayArtistName(track))}</div>
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
const savedSampleRate = localStorage.getItem('spectra_sampleRate') || '';
let settings = {
  deviceId: localStorage.getItem('spectra_deviceId') || '',
  mode: localStorage.getItem('spectra_mode') || 'shared',
  dsdTransport: localStorage.getItem('spectra_dsdTransport') || 'pcm',
  bitPerfect: localStorage.getItem('spectra_bitPerfect') === 'true',
  strictBitPerfect: localStorage.getItem('spectra_strictBitPerfect') === 'true',
  remoteEnabled: localStorage.getItem('spectra_remoteEnabled') === 'true',
  sampleRateMode: localStorage.getItem('spectra_sampleRateMode') || (savedSampleRate ? 'fixed' : 'source'),
  sampleRate: savedSampleRate,
  bufferMs: localStorage.getItem('spectra_bufferMs') || '100',
  bufferFrames: localStorage.getItem('spectra_bufferFrames') || ''
};


const getSelectedOutputDevice = () => {
  const deviceId = deviceSelect ? deviceSelect.value : settings.deviceId;
  return outputDevices.find(d => d.id === deviceId) || null;
};
const formatHzList = (rates = []) => {
  const nums = Array.from(new Set((rates || []).map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
  return nums.length ? nums.join(', ') : 'Unknown';
};
const updateAsioControlPanelState = () => {
  if (!asioControlPanelButton) return;
  const deviceId = deviceSelect ? deviceSelect.value : settings.deviceId;
  const dev = outputDevices.find(d => d.id === deviceId);
  const isAsio = !!(deviceId && deviceId.startsWith('asio:')) || dev?.api === 'asio' || (modeSelect && modeSelect.value === 'asio');
  asioControlPanelButton.disabled = !isAsio;
};
const renderAudioOutputStatus = (status = null) => {
  const dev = getSelectedOutputDevice();
  const byId = (id) => document.getElementById(id);
  const output = status?.output || null;
  const source = status?.source || null;
  const deviceName = dev?.name || (settings.deviceId ? settings.deviceId : 'Default');
  const rates = dev ? formatHzList(dev.sampleRates) : 'Default device';
  const backend = output?.requestedBackend === 'dop'
    ? 'DoP over WASAPI Exclusive'
    : (output?.requestedBackend === 'native-dsd' ? 'Native DSD over ASIO' : (output?.backend || (status?.playing ? 'Opening...' : 'Not playing')));
  const sourceText = source?.sampleRate ? 'source ' + source.sampleRate + ' Hz' + (source.bitDepth ? ' / ' + source.bitDepth + '-bit' : '') : 'source idle';
  const format = output?.sampleRate ? output.sampleRate + ' Hz / ' + (output.sampleFormat || ((output.bitDepth || '?') + '-bit')) + ' / ' + (output.channels || '?') + 'ch (' + sourceText + ')' : 'Not playing';
  const buffer = output?.bufferFrames ? Math.round(output.bufferFrames) + ' samples' + (output.bufferMs ? ' / ' + Number(output.bufferMs).toFixed(2) + ' ms' : '') : 'Not playing';
  const fallback = output?.fallback ? (output.fallbackReason || 'Yes') : 'No';
  const dsp = output?.dsp === 'bypassed' ? 'Bypassed for bit-perfect/DSD' : (output?.dsp === 'eq' ? 'Equalizer active' : 'None');
  if (byId('audio-status-device')) byId('audio-status-device').textContent = deviceName;
  if (byId('audio-status-rates')) byId('audio-status-rates').textContent = rates;
  if (byId('audio-status-backend')) byId('audio-status-backend').textContent = backend;
  if (byId('audio-status-format')) byId('audio-status-format').textContent = format;
  if (byId('audio-status-buffer')) byId('audio-status-buffer').textContent = buffer;
  if (byId('audio-status-fallback')) byId('audio-status-fallback').textContent = fallback;
  if (byId('audio-status-dsp')) byId('audio-status-dsp').textContent = dsp;
};

// Add minimize-to-tray preference (persisted in localStorage and informed to main)
settings.minimizeToTray = localStorage.getItem('spectra_minimizeToTray') === 'true';

// Apply Settings to UI
const loadSettingsUI = async () => {
  // Load devices
  const devices = await electron.getDevices();
  outputDevices = Array.isArray(devices) ? devices : [];
  deviceSelect.innerHTML = '<option value="">Default</option>';
  if (Array.isArray(devices)) {
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
        const apiLabel = d.api === 'asio' ? 'ASIO' : (d.api === 'wasapi' ? 'WASAPI' : 'Audio');
        opt.textContent = d.name.includes('[') ? d.name : `[${apiLabel}] ${d.name}`;
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
      const common = ['44100','48000','88200','96000','176400','192000','352800','705600'];
      const combined = [];
      // Auto option
      combined.push({ v: '', label: 'Source native / no resampling' });
      // add device-supported rates first
      for (const r of rates) {
        combined.push({ v: r, label: r });
      }
      // add remaining common rates not already included
      for (const r of common) {
        if (!rates.includes(r)) combined.push({ v: r, label: r });
      }
      // custom option at end
      combined.push({ v: 'custom', label: 'Custom...' });

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
      if (deviceSelect.value.startsWith('asio:') && modeSelect) {
        modeSelect.value = 'asio';
      }
      updateAsioControlPanelState();
      renderAudioOutputStatus();
    });
  }

  modeSelect.value = settings.mode;
  if (sampleRateModeSelect) sampleRateModeSelect.value = settings.sampleRateMode || 'source';
  if (dsdTransportSelect) dsdTransportSelect.value = settings.dsdTransport;
  bitPerfectCheckbox.checked = settings.bitPerfect;
  strictBitPerfectCheckbox.checked = settings.strictBitPerfect;
  if (bufferMsSelect) bufferMsSelect.value = settings.bufferMs || '100';
  if (bufferFramesInput) bufferFramesInput.value = settings.bufferFrames || '';
  updateAsioControlPanelState();
  renderAudioOutputStatus();
  // Initialize sample rate UI: select + optional custom input
  if (sampleRateSelect) {
    if (!settings.sampleRate) {
      sampleRateSelect.value = '';
      if (sampleRateCustomInput) sampleRateCustomInput.style.display = 'none';
    } else if (['44100','48000','88200','96000','176400','192000','352800','705600'].includes(String(settings.sampleRate))) {
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
    // Ensure UI shows actual runtime remote URL/port
    electron.toggleRemote(settings.remoteEnabled).then(async () => {
      try {
        const info = await electron.getRemoteInfo();
        updateRemoteUrlDisplay(info);
      } catch (e) { /* noop */ }
    }).catch(() => {});
  }
  // Minimize-to-tray checkbox
  const minimizeTrayCheckbox = document.getElementById('minimize-tray-checkbox');
  if (minimizeTrayCheckbox) {
    minimizeTrayCheckbox.checked = !!settings.minimizeToTray;
  }
};

const didOutputSettingsChange = (prev, next) => (
  String(prev?.deviceId || '') !== String(next?.deviceId || '') ||
  String(prev?.mode || '') !== String(next?.mode || '') ||
  String(prev?.dsdTransport || '') !== String(next?.dsdTransport || '') ||
  Boolean(prev?.bitPerfect) !== Boolean(next?.bitPerfect) ||
  Boolean(prev?.strictBitPerfect) !== Boolean(next?.strictBitPerfect) ||
  String(prev?.sampleRateMode || '') !== String(next?.sampleRateMode || '') ||
  String(prev?.sampleRate || '') !== String(next?.sampleRate || '') ||
  String(prev?.bufferMs || '') !== String(next?.bufferMs || '') ||
  String(prev?.bufferFrames || '') !== String(next?.bufferFrames || '')
);

let outputSwitchInFlight = false;
let outputSwitchPending = false;

const applyOutputSettingsToActivePlayback = async () => {
  if (outputSwitchInFlight) {
    outputSwitchPending = true;
    return;
  }
  if (!currentTrack) return;

  const status = await electron.getAudioStatus().catch(() => null);
  if (!status || !status.playing) return;

  outputSwitchInFlight = true;
  try {
    const currentTime = Number.isFinite(status.currentTime) ? status.currentTime : (lastKnownPosition || 0);
    // Ensure startTime is non-zero so audioEngine dedup logic never swallows
    // a same-track re-open intended to switch output device.
    const restartAt = currentTime > 0.01 ? currentTime : 0.06;
    await playTrack(currentTrack, { startTime: restartAt, forceRestart: true });

    // Preserve paused state after reconfigure.
    if (status.paused) {
      await electron.pause();
      isPlaying = false;
      updatePlayButton();
    }
  } catch (err) {
    console.error('Failed to apply output device/settings live:', err);
    notify('Failed to switch audio output', 'error', { autoClose: 2600 });
  } finally {
    outputSwitchInFlight = false;
    if (outputSwitchPending) {
      outputSwitchPending = false;
      await applyOutputSettingsToActivePlayback();
    }
  }
};

// Save Settings
const saveSettings = async () => {
  const prevSettings = { ...settings };
  settings.deviceId = deviceSelect.value;
  settings.mode = modeSelect.value;
  if (settings.deviceId.startsWith('asio:')) {
    settings.mode = 'asio';
    if (modeSelect) modeSelect.value = 'asio';
  }
  settings.dsdTransport = dsdTransportSelect ? dsdTransportSelect.value : 'pcm';
  settings.sampleRateMode = sampleRateModeSelect ? (sampleRateModeSelect.value || 'source') : 'source';
  settings.bitPerfect = bitPerfectCheckbox.checked;
  settings.strictBitPerfect = strictBitPerfectCheckbox.checked;
  settings.bufferMs = bufferMsSelect ? (bufferMsSelect.value || '100') : '100';
  settings.bufferFrames = bufferFramesInput ? String(bufferFramesInput.value || '').trim() : '';
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
    electron.toggleRemote(settings.remoteEnabled).then(async () => {
      try {
        const info = await electron.getRemoteInfo();
        updateRemoteUrlDisplay(info);
      } catch (e) {}
    }).catch(() => {});
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
  localStorage.setItem('spectra_dsdTransport', settings.dsdTransport);
  localStorage.setItem('spectra_bitPerfect', settings.bitPerfect);
  localStorage.setItem('spectra_strictBitPerfect', settings.strictBitPerfect);
  localStorage.setItem('spectra_sampleRateMode', settings.sampleRateMode || 'source');
  if (settings.sampleRate) localStorage.setItem('spectra_sampleRate', settings.sampleRate);
  else localStorage.removeItem('spectra_sampleRate');
  localStorage.setItem('spectra_bufferMs', settings.bufferMs || '100');
  if (settings.bufferFrames) localStorage.setItem('spectra_bufferFrames', settings.bufferFrames);
  else localStorage.removeItem('spectra_bufferFrames');
  updateAsioControlPanelState();
  renderAudioOutputStatus();

  if (didOutputSettingsChange(prevSettings, settings)) {
    await applyOutputSettingsToActivePlayback();
  }
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
      initEqualizerControls();
      void syncEqualizerControls();
    } else if (viewId === 'upnp') {
      void loadUpnpView();
    } else if (viewId === 'nas') {
      void loadNasView();
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
    initEqualizerControls();
    void syncEqualizerControls();
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
          // Play from the playlist's own track list — NOT the global `tracks`
          // array, which may have been filtered by search, losing tracks.
          const source = currentPlaylistTracks.length ? currentPlaylistTracks : tracks;
          const target = source.length > 0 ? source[0] : null;
          if (target) {
            await startPlayback(target, source, { type: 'playlist', key: playlist.name || playlist.id });
          } else {
            notify('Playlist is empty', 'warning', { autoClose: 2200 });
          }
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
      // Prefer the track_count returned by getAllPlaylists (single SQL query).
      // Fall back to cached _trackCount or a one-off fetch for older backends.
      const directCount = Number.isFinite(p.track_count) ? p.track_count : null;
      if (directCount !== null) {
        count.textContent = `${directCount} track${directCount === 1 ? '' : 's'}`;
      } else if (typeof p._trackCount === 'number') {
        count.textContent = `${p._trackCount} track${p._trackCount === 1 ? '' : 's'}`;
      } else {
        try {
          const tlist = await electron.getPlaylistTracks(p.id);
          const trackCount = Array.isArray(tlist) ? tlist.length : 0;
          p._trackCount = trackCount;
          count.textContent = `${trackCount} track${trackCount === 1 ? '' : 's'}`;
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

// Native alert / confirm dialogs leave Electron text inputs unfocusable on Windows
// afterwards (the search box "stops working"); messages go through the in-app
// notification bar and dialogs instead.
function uiAlert(message, type) {
  const text = String(message ?? '');
  const kind = type || (/fail|error|invalid|could not|unable/i.test(text) ? 'error' : 'info');
  NotificationCenter.show({ message: text, type: kind, autoClose: 4500 });
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


        const artistMeta = (() => {
          const set = new Set();
          for (const t of (Array.isArray(tracks) ? tracks : [])) {
            const a = (t?.album_artist || t?.artist || '').toString().trim();
            if (a) set.add(a);
            if (set.size > 1) break;
          }
          if (set.size > 1) return 'Various Artists';
          if (set.size === 1) return Array.from(set)[0];
          return (libraryContext.artist || '').toString();
        })();

        header.innerHTML = `
          <div class="album-header-left">
            <img class="album-header-art" src="" alt="Album art">
          </div>
          <div class="album-header-main">
            <div style="display:flex;align-items:center;gap:12px;">
              <span class="back-to-library" title="Back to Library"><span class="material-icons">arrow_back</span></span>
              <div class="album-type">Album</div>
            </div>
            <div class="album-title-large">${esc(libraryContext.name || '')}</div>
            <div class="album-artist-meta">${esc(artistMeta)} - ${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}</div>
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
            await startPlayback(tracks[0], tracks, {
              type: 'album',
              key: libraryContext.name || null,
            });
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
          await startPlayback(tracks[0], tracks, {
            type: 'album',
            key: libraryContext.name || null,
          });
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
  const setSingleSelection = (el, track) => {
    selectedTrackIds.clear();
    selectedTrackIds.add(track.id);
    trackList.querySelectorAll('.track-item.selected').forEach((n) => n.classList.remove('selected'));
    el.classList.add('selected');
  };
  const buildRow = (track) => {
    const el = document.createElement('div');
    const isSelected = selectedTrackIds.has(track.id);
    el.className = `track-item ${tracksMatch(currentTrack, track) ? 'active' : ''} ${isSelected ? 'selected' : ''}`;
    if (track.id != null) el.dataset.trackId = String(track.id);
    // Store path in dataset for right-click actions
    if (track.path) el.dataset.path = track.path;

    // Fallback for title if missing, using simple string manipulation instead of path module
    const displayTitle = track.title || (track.path ? track.path.split(/[/\\]/).pop() : 'Unknown Title');

    el.innerHTML = `
      <div class="col-title">${esc(displayTitle)}</div>
      <div class="col-artist clickable-filter">${esc(getDisplayArtistName(track))}</div>
      <div class="col-album clickable-filter">${esc(track.album || 'Unknown Album')}</div>
      <div class="col-duration">${formatTime(track.duration)}</div>
    `;

    // Click on artist to filter by artist
    const artistCell = el.querySelector('.col-artist');
    artistCell.addEventListener('click', async (e) => {
      e.stopPropagation();
      const artistName = getTrackArtistNames(track)[0] || '';
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
      const artistToMatch = normalizeAlbumArtistKey(artistName);
      currentAlbumFilter = { album: nameToMatch, artist: artistToMatch || null };
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
      // Otherwise select single and play. Only classes change: rebuilding the
      // whole list here reset long libraries back to their first page.
      setSingleSelection(el, track);
      const sameTrack = currentTrack && (
        (track.id && currentTrack.id && track.id === currentTrack.id) ||
        (!track.id && currentTrack.path && track.path && currentTrack.path === track.path)
      );
      // Establish playback context = the list currently shown so Next/Prev
      // traverse the list the user just picked from.
      if (sameTrack) {
        playTrack(track, { forceRestart: true });
      } else {
        startPlayback(track, tracks, {
          type: libraryContext.type || 'library',
          key: libraryContext.name || libraryContext.id || null,
        });
      }
    });

    // Context Menu
    el.oncontextmenu = (e) => {
      e.preventDefault();
      // If this item is not part of selection, select it only
      if (!selectedTrackIds.has(track.id)) setSingleSelection(el, track);
      // Build array of selected track objects to send to main
      const selected = tracks.filter(t => selectedTrackIds.has(t.id)).map(t => (typeof structuredClone === 'function' ? structuredClone(t) : JSON.parse(JSON.stringify(t))));
      electron.showTrackContextMenu(selected);
    };

    return el;
  };

  // Render in pages: building tens of thousands of rows per keystroke made
  // search and navigation crawl on large libraries.
  const BATCH = 400;
  const token = ++libraryRenderToken;
  const list = tracks;
  let index = 0;
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'net-empty-hint';
    const q = searchInputEl ? searchInputEl.value.trim() : '';
    empty.textContent = q ? `No tracks match "${q}"` : 'No tracks here yet';
    trackList.appendChild(empty);
    return;
  }
  const appendBatch = () => {
    if (token !== libraryRenderToken) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(list.length, index + BATCH);
    for (; index < end; index++) frag.appendChild(buildRow(list[index]));
    trackList.appendChild(frag);
    if (index >= list.length) return;
    const sentinel = document.createElement('div');
    sentinel.style.height = '1px';
    trackList.appendChild(sentinel);
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      sentinel.remove();
      appendBatch();
    }, { rootMargin: '800px' });
    observer.observe(sentinel);
  };
  appendBatch();
};

// Move the "now playing" highlight without rebuilding the list.
function updateActiveTrackRow() {
  if (!trackList) return;
  const id = currentTrack && currentTrack.id != null ? String(currentTrack.id) : null;
  trackList.querySelectorAll('.track-item.active').forEach((n) => {
    if (n.dataset.trackId !== id) n.classList.remove('active');
  });
  if (id != null) {
    for (const n of trackList.querySelectorAll('.track-item')) {
      if (n.dataset.trackId === id) { n.classList.add('active'); break; }
    }
  }
}

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
    background: var(--bg-hover);
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

  const confirmed = await customConfirm(
    `Delete album "${albumName}" by ${artistName || 'Unknown Artist'}?\n\nThis will remove all ${trackCount} track(s) from your library.\n\nThis cannot be undone.`
  );

  if (confirmed) {
    try {
      const result = await electron.deleteAlbum(albumName, artistName);
      if (result && result.deleted > 0) {
        // Refresh library and albums view
        await loadLibrary();
        albumsCache = [];
        artistsCache = [];
        await renderAlbums({ forceReload: true });
      }
    } catch (err) {
      console.error('Failed to delete album:', err);
      uiAlert('Failed to delete album: ' + (err.message || err));
    }
  }
};

// Handle album view from context menu
const handleAlbumView = async (albumInfo) => {
  const { albumName, artistName } = albumInfo;
  const nameToMatch = normalizeForCompare(albumName);
  if (!nameToMatch) return;
  const artistToMatch = normalizeAlbumArtistKey(artistName || '');

  currentAlbumFilter = { album: nameToMatch, artist: artistToMatch || null };
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
  const query = querySource ? querySource.value.trim() : '';

  if (libraryContext.type === 'playlist' && currentPlaylistFilter?.id) {
    try {
      const refreshed = await electron.getPlaylistTracks(currentPlaylistFilter.id);
      currentPlaylistTracks = Array.isArray(refreshed) ? refreshed : [];
    } catch (err) {
      console.warn('Failed to refresh playlist tracks', err);
      currentPlaylistTracks = [];
    }
  }

  await handleSearchInput(query);
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
    const trackCount = Number(album.track_count ?? album.trackCount ?? 0) || 0;
    count.textContent = `${trackCount} ${trackCount === 1 ? 'track' : 'tracks'}`;

    card.appendChild(img);
    card.appendChild(title);
    card.appendChild(artist);
    card.appendChild(count);

    card.onclick = (() => {
      const albumNameRaw = album.name || album.album || '';
      const nameToMatch = normalizeForCompare(albumNameRaw);
      const artistNameRaw = album.artist || album.artist_name || '';

      return async () => {
        if (!nameToMatch) {
          console.warn('Album click: empty album name, skipping filter');
          return;
        }

        const artistToMatch = normalizeAlbumArtistKey(artistNameRaw || '');
        currentAlbumFilter = { album: nameToMatch, artist: artistToMatch || null };
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
    const artistName = canonicalArtistDisplayName((artist.name || '').toString());
    title.textContent = artistName || 'Unknown Artist';

    const count = document.createElement('div');
    count.className = 'album-artist';
    const albCount = Number(artist.album_count ?? 0) || 0;
    const trkCount = Number(artist.track_count ?? 0) || 0;
    const albLabel = `${albCount} ${albCount === 1 ? 'album' : 'albums'}`;
    const trkLabel = `${trkCount} ${trkCount === 1 ? 'track' : 'tracks'}`;
    count.textContent = `${albLabel} - ${trkLabel}`;

    card.appendChild(img);
    card.appendChild(title);
    card.appendChild(count);

    card.onclick = (() => {
      const artistToMatch = normalizeAlbumArtistKey(artistName);
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

// Begin playing a track AND establish a new playback context (the list that
// Next/Previous/auto-advance should traverse). Call this from UI entry points
// where the user picked a track out of a specific list (library, album,
// playlist). playTrack() without a contextList is used for Next/Prev inside
// the existing context — it preserves playbackContext as-is.
// Mirror the playback list into the main-process queue so the queue panel,
// remote clients and headless mode see the same list.
async function mirrorQueueToMain(list, track) {
  try {
    const seed = list.map((t) => ({
      id: t.id,
      path: t.path,
      title: t.title,
      artist: t.artist,
      album: t.album,
      album_artist: t.album_artist,
      duration: t.duration,
      cover_path: t.cover_path || t.coverPath || null,
    }));
    const currentIndex = Math.max(0, seed.findIndex((t) => tracksMatch(t, track)));
    await electron.setQueue(seed, currentIndex);
  } catch (err) {
    console.warn('setQueue failed:', err);
  }
}

const startPlayback = async (track, list, meta = {}) => {
  if (!track) return;
  if (Array.isArray(list) && list.length) {
    playbackContext = {
      list: [...list],
      type: meta.type || 'library',
      key: meta.key || null,
    };
    playHistory = [];
    shufflePlayed = new Set();
    forcedNext = [];
    await mirrorQueueToMain(playbackContext.list, track);
  }
  return playTrack(track, { forceRestart: true });
};

const getAutoSampleRateForOutput = () => undefined;
// Play Track
const playTrack = async (track, opts = {}) => {
  if (!track || !track.path) return;
  const { startTime, forceRestart = true, gapless = false } = opts || {};

  // Check if same track BEFORE updating currentTrack
  const isSameTrack = tracksMatch(currentTrack, track);

  currentTrack = track;
  playInstance++;
  endedPolls = 0;
  pendingResumePosition = null;
  lastStatusDuration = 0;
  // Show UI animation for now playing
  showNowPlaying();
  // record start as lastPlayed with zero elapsed until periodic saver updates it
  const startPos = typeof startTime === 'number' && startTime >= 0 ? startTime : 0;
  saveLastPlayed(currentTrack, startPos);
  // Normalize sample rate: parse to integer and validate reasonable range
  let sr;
  if (settings.sampleRateMode !== 'source' && settings.sampleRate) {
    const parsed = Number.parseInt(String(settings.sampleRate).trim(), 10);
    if (!Number.isNaN(parsed) && parsed > 8000 && parsed < 1000000) sr = parsed;
    else sr = undefined;
  } else sr = getAutoSampleRateForOutput();

  const playbackOptions = {
    deviceId: settings.deviceId,
    mode: settings.mode,
    dsdTransport: settings.dsdTransport,
    bitPerfect: settings.bitPerfect,
    strictBitPerfect: settings.strictBitPerfect,
    sampleRatePolicy: settings.sampleRateMode || 'source',
    sampleRate: sr,
    bufferMs: Number.parseInt(String(settings.bufferMs || '100'), 10) || 100,
    bufferFrames: Number.parseInt(String(settings.bufferFrames || '0'), 10) || 0,
    volume: Number(volumeSlider.value), // Pass current volume as number
    // Auto-advance appends to the open device (gapless); a user-initiated
    // change cuts over immediately.
    gapless: gapless === true,
    track: track
  };
  if (typeof startTime === 'number' && startTime >= 0) playbackOptions.startTime = startTime;

  // Update the UI first so rapid Next/Prev presses feel instant.
  isPlaying = true;
  lastKnownPosition = startPos;
  updateNowPlaying();
  updateActiveTrackRow();
  updatePlayButton();
  if (currentTimeEl) currentTimeEl.textContent = formatTime(startPos);
  if (seekSlider && !isSeeking) {
    const dur = effectiveDuration();
    seekSlider.value = dur > 0 ? Math.min(100, (startPos / dur) * 100) : 0;
  }

  const myInstance = playInstance;
  playRequestsInFlight++;
  try {
    // If we are already on this track and not forcing restart, just resume
    if (!forceRestart && isSameTrack && engineActive) {
      await electron.resume();
    } else {
      await electron.playTrack(track.path, playbackOptions);
    }
  } finally {
    playRequestsInFlight--;
  }
  if (myInstance !== playInstance) return; // a newer request superseded this one

  if (!playHistory.length || !tracksMatch(playHistory[playHistory.length - 1], track)) {
    playHistory.push(track);
    if (playHistory.length > 200) playHistory.shift();
  }
  shufflePlayed.add(trackKey(track));

  // Keep main-process queue index in sync when tracks change from renderer
  // controls (Prev/Next/click), so media keys continue from the correct slot.
  try {
    if (electron.setQueueCurrent && track) {
      await electron.setQueueCurrent({ id: track.id, path: track.path });
    }
  } catch {}

  if (isFullscreenVisible()) {
    showFullscreen();
  }
};

// Show a simple playback error notification with option to relink file
const showPlaybackError = async (errInfo) => {
  console.log('showPlaybackError called with', errInfo);
  if (!errInfo) return;
  isPlaying = false;
  updatePlayButton();
  const friendly = errInfo.message || 'Playback failed.';
  const filePath = errInfo.filePath || '';
  const isMissingLocalFile = !!filePath && !/^https?:\/\//i.test(filePath) && /not found|ENOENT/i.test(friendly);
  if (!isMissingLocalFile) {
    // Device / decoder / network errors: relinking a file would not help.
    NotificationCenter.show({ message: 'Playback failed', detail: friendly, type: 'error', autoClose: 7000 });
    return;
  }
  const wantRelink = await customConfirm(`${friendly}\n\nLocate the file in a new location?`, {
    title: 'File not found', confirmLabel: 'Locate…',
  });
  if (!wantRelink) return;
  // Ask main process to let user pick a replacement file and update DB
  try {
    await electron.relinkTrack({ filePath: errInfo.filePath, track: errInfo.track });
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

// Main process emits this when FFmpeg reaches natural end-of-stream.
// Use it as the primary auto-advance trigger so pause state never skips tracks.
electron.on('audio:ended', (info) => {
  if (!currentTrack) return;
  // Ignore an end event for a track the user already navigated away from.
  if (info && (info.id != null || info.path) && !tracksMatch(info, currentTrack)) return;
  if (advancedInstance === playInstance) return;
  advancedInstance = playInstance;
  void advanceToNext();
});

// Update the remote URL display in settings
const updateRemoteUrlDisplay = (info) => {
  try {
    const el = document.getElementById('remote-url-display');
    if (!el) return;
    if (!info || !info.port) {
      el.textContent = 'http://localhost:3000';
      return;
    }
    const host = (info.host === '0.0.0.0' || info.host === '::') ? 'localhost' : info.host;
    el.textContent = `${host.startsWith('http') ? host : 'http://' + host}:${info.port}`;
  } catch (e) { /* noop */ }
};

// Listen for runtime updates when remote server starts/stops or changes port
electron.on('remote:info', (info) => {
  updateRemoteUrlDisplay(info);
});

// Update Now Playing UI
const updateNowPlaying = async () => {
  if (!currentTrack) return;
  npTitle.textContent = currentTrack.title || 'Unknown Title';
  npArtist.textContent = getDisplayArtistName(currentTrack);

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

  totalTimeEl.textContent = formatTime(effectiveDuration());
};

// Fullscreen view handlers
let currentSyncedLyrics = null; // Array of { time: number, text: string }
let fullscreenLyricsToken = 0;

const getTrackIdentityKey = (track) => {
  if (!track) return '';
  if (track.id != null) return `id:${track.id}`;
  return `path:${track.path || ''}`;
};

const isFullscreenVisible = () => {
  const overlay = document.getElementById('fullscreen-player');
  return !!(overlay && !overlay.classList.contains('hidden'));
};

function parseSyncedLyrics(lrc) {
  if (typeof lrc !== 'string' || !lrc.trim()) return [];
  const lines = lrc.split(/\r?\n/);
  const result = [];
  const timeReg = /\[(\d{1,2}):(\d{2})(?:[.,:](\d{1,3}))?\]/g;
  for (const line of lines) {
    timeReg.lastIndex = 0;
    const tags = [...line.matchAll(timeReg)];
    if (!tags.length) continue;
    timeReg.lastIndex = 0;
    const text = line.replace(timeReg, '').trim();
    if (!text) continue;
    for (const tag of tags) {
      const min = parseInt(tag[1], 10) || 0;
      const sec = parseInt(tag[2], 10) || 0;
      const frac = String(tag[3] || '0');
      const ms = parseInt(frac.padEnd(3, '0').slice(0, 3), 10) || 0;
      result.push({ time: min * 60 + sec + ms / 1000, text });
    }
  }
  result.sort((a, b) => a.time - b.time);
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

let eqControlsInitialized = false;

async function syncEqualizerControls() {
  const eqEnabled = document.getElementById('eq-enabled');
  const eqPreset = document.getElementById('eq-preset');
  const eqSliders = document.querySelectorAll('.eq-slider');

  try {
    const eq = await electron.getEQ();
    if (!eq) return;
    if (eqEnabled) eqEnabled.checked = !!eq.enabled;
    if (eqPreset) eqPreset.value = eq.preset || 'flat';
    if (eq.bands && eqSliders.length === eq.bands.length) {
      eqSliders.forEach((slider, i) => {
        slider.value = eq.bands[i];
      });
    }
  } catch (err) {
    console.error('Failed to load EQ state:', err);
  }
}

function initEqualizerControls() {
  if (eqControlsInitialized) return;

  const eqEnabled = document.getElementById('eq-enabled');
  const eqPreset = document.getElementById('eq-preset');
  const eqSliders = document.querySelectorAll('.eq-slider');

  if (eqEnabled) {
    eqEnabled.onchange = async () => {
      await electron.setEQEnabled(eqEnabled.checked);
      await syncEqualizerControls();
    };
  }

  if (eqPreset) {
    eqPreset.onchange = async () => {
      await electron.setEQPreset(eqPreset.value);
      await syncEqualizerControls();
    };
  }

  if (eqSliders.length > 0) {
    eqSliders.forEach((slider, index) => {
      slider.oninput = async () => {
        const eq = await electron.getEQ();
        if (eq && eq.bands) {
          const newBands = [...eq.bands];
          newBands[index] = parseFloat(slider.value);
          await electron.setEQBands(newBands);
          if (eqPreset) eqPreset.value = 'custom';
        }
      };
    });
  }

  eqControlsInitialized = true;
  void syncEqualizerControls();
}

function showFullscreen() {
  const activeTrack = currentTrack;
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

  if (!overlay || !activeTrack) return;

  const trackKeyAtOpen = getTrackIdentityKey(activeTrack);
  const token = ++fullscreenLyricsToken;

  // Enter actual fullscreen
  try { electron.setFullscreen(true); } catch {}

  // Populate
  fsTitle.textContent = activeTrack.title || 'Unknown Title';
  fsArtist.textContent = getDisplayArtistName(activeTrack);
  // Provide full text in title attribute so users can see the full name on hover
  try {
    fsTitle.title = fsTitle.textContent || '';
    fsArtist.title = fsArtist.textContent || '';
  } catch (e) {
    // ignore if elements missing
  }

  // Update time immediately
  if (fsTotalTime) fsTotalTime.textContent = formatTime(activeTrack.duration);

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
      if (!currentTrack) return;
      const list = playbackContext.list.length ? playbackContext.list : tracks;
      if (!list.length) return;
      const idx = list.findIndex(t => t.id === currentTrack.id);
      if (idx > 0) playTrack(list[idx - 1]);
      else if (repeatMode === 'all') playTrack(list[list.length - 1]);
    };
  }

  if (btnFsNext) {
    btnFsNext.onclick = () => {
      if (!currentTrack) return;
      const list = playbackContext.list.length ? playbackContext.list : tracks;
      if (!list.length) return;
      const idx = list.findIndex(t => t.id === currentTrack.id);
      if (idx >= 0 && idx < list.length - 1) playTrack(list[idx + 1]);
      else if (repeatMode === 'all' && list.length) playTrack(list[0]);
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
  if (activeTrack.cover_path) {
    if (activeTrack.cover_path.startsWith('http') || activeTrack.cover_path.startsWith('data:')) {
      setArt(activeTrack.cover_path);
    } else {
      // Local file, try to get it via IPC
      electron.getCoverImage(activeTrack.cover_path).then(dataUrl => {
        if (token !== fullscreenLyricsToken) return;
        if (getTrackIdentityKey(currentTrack) !== trackKeyAtOpen) return;
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
      if (token !== fullscreenLyricsToken) return;
      if (getTrackIdentityKey(currentTrack) !== trackKeyAtOpen) return;
      // Check if we already have lyrics in memory
      let lyricsText = activeTrack.lyrics;
      // Filter out bad data
      if (lyricsText === '[object Object]') lyricsText = null;

      let isSynced = false;

      // If not in memory, fetch
      if (!lyricsText) {
        const res = await electron.getLyrics({ filePath: activeTrack.path, external: true, artist: activeTrack.artist, title: activeTrack.title });
        if (token !== fullscreenLyricsToken) return;
        if (getTrackIdentityKey(currentTrack) !== trackKeyAtOpen) return;
        if (res && res.lyrics && res.lyrics !== '[object Object]') {
          lyricsText = res.lyrics;
          isSynced = res.isSynced; // Flag from main process

          // Persist fetched lyrics into DB
          if (res.source === 'online' || res.source === 'embedded') {
            try {
              if (activeTrack && activeTrack.id) {
                const saveRes = await electron.saveLyrics({ trackId: activeTrack.id, lyrics: res.lyrics });
                if (saveRes && saveRes.success) {
                  if (getTrackIdentityKey(currentTrack) === trackKeyAtOpen) {
                    currentTrack.lyrics = res.lyrics;
                  }
                }
              }
            } catch (saveErr) {
              console.warn('Failed to save lyrics:', saveErr);
            }
          }
        }
      } else {
        // Check if stored lyrics look like LRC
        if (/\[\d{1,2}:\d{2}(?:[.,:]\d{1,3})?\]/.test(lyricsText)) isSynced = true;
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
      if (activeTrack && activeTrack.lyrics) fsLyrics.textContent = activeTrack.lyrics;
      else fsLyrics.textContent = 'Lyrics not available for this track.';
    }
  })();

  overlay.classList.remove('hidden');

  // Close handlers
  const closeBtn = document.getElementById('fs-close');
  const prevHandler = overlay._escHandler;
  if (prevHandler) {
    document.removeEventListener('keydown', prevHandler);
    overlay._escHandler = null;
  }
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
    const status = await electron.getAudioStatus().catch(() => null);
    const playingNow = status ? (Boolean(status.playing) && !Boolean(status.paused)) : isPlaying;
    const time = (status && typeof status.currentTime === 'number') ? status.currentTime : 0;

    // Update Play/Pause Icon
    if (btnFsPlay) {
      const icon = btnFsPlay.querySelector('.material-icons');
      if (icon) icon.textContent = playingNow ? 'pause_circle_filled' : 'play_circle_filled';
    }

    if (!playingNow) return;
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
  try { electron.setFullscreen(false); } catch {}
  fullscreenLyricsToken++;

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
  searchInputEl = searchInput;

  // Debounced so each keystroke does not re-filter and re-render the library.
  let timer = null;
  const run = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    void handleSearchInput(searchInput.value, { fromUser: true });
  };
  searchInput.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 120);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // In the UPnP browser, Enter asks the server to search its whole library.
      if (currentView === 'upnp' && searchInput.value.trim()) {
        if (timer) { clearTimeout(timer); timer = null; }
        void searchUpnp(searchInput.value);
      } else {
        run();
      }
    } else if (e.key === 'Escape') {
      searchInput.value = '';
      run();
      searchInput.blur();
    }
  });
};

function focusSearch() {
  const input = searchInputEl || document.getElementById('search-input');
  if (!input) return;
  input.focus();
  input.select();
}

// Column-header sorting for the track list.
function initLibrarySorting() {
  const header = document.querySelector('#view-library .track-list-header');
  if (!header) return;
  const columns = { '.col-title': 'title', '.col-artist': 'artist', '.col-album': 'album', '.col-duration': 'duration' };
  const cells = [];
  const refresh = () => {
    for (const { el, key } of cells) {
      let mark = el.querySelector('.sort-indicator');
      if (!mark) {
        mark = document.createElement('span');
        mark.className = 'sort-indicator';
        mark.style.cssText = 'margin-left:4px;font-size:10px;opacity:.8';
        el.appendChild(mark);
      }
      mark.textContent = librarySort.key === key ? (librarySort.dir === 1 ? '▲' : '▼') : '';
    }
  };
  for (const [selector, key] of Object.entries(columns)) {
    const el = header.querySelector(selector);
    if (!el) continue;
    cells.push({ el, key });
    el.style.cursor = 'pointer';
    el.title = 'Click to sort';
    el.onclick = () => {
      if (librarySort.key !== key) librarySort = { key, dir: 1 };
      else if (librarySort.dir === 1) librarySort = { key, dir: -1 };
      else librarySort = { key: null, dir: 1 };
      refresh();
      void handleSearchInput(searchInputEl ? searchInputEl.value : '');
    };
  }
  refresh();
}

// Sync state from server
const syncState = (state) => {
  if (!state) return;

  // Update isPlaying (not while our own play request is still starting up)
  if (!playRequestsInFlight) {
    isPlaying = !!state.playing && !state.paused;
    updatePlayButton();
  }
  engineActive = !!state.playing;

  // Update currentTrack if changed (e.g. started from a remote client)
  if (state.track && state.playing && !playRequestsInFlight && !tracksMatch(currentTrack, state.track)) {
      currentTrack = state.track;
      playInstance++;
      lastStatusDuration = 0;
      updateNowPlaying();
      if (isFullscreenVisible()) showFullscreen();
      showNowPlaying();
      updateActiveTrackRow();
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

// Advance playback to the next track based on the active PLAYBACK context,
// not the currently-viewed list. That way browsing a different album while
// music plays doesn't redirect Next/auto-advance to that album.
function getPlaybackList() {
  if (Array.isArray(playbackContext.list) && playbackContext.list.length) return playbackContext.list;
  // Fallbacks for sessions that started without a context (restored track,
  // playback started from a remote client).
  if (Array.isArray(tracks) && tracks.length) return tracks;
  if (Array.isArray(libraryCache) && libraryCache.length) return libraryCache;
  return [];
}

// Shuffle without repeats: every track plays once before any plays again.
function pickShuffleNext(list) {
  const currentKey = trackKey(currentTrack);
  let candidates = list.filter((t) => !shufflePlayed.has(trackKey(t)) && trackKey(t) !== currentKey);
  if (!candidates.length) {
    if (repeatMode !== 'all') return null;
    shufflePlayed = new Set();
    candidates = list.filter((t) => trackKey(t) !== currentKey);
    if (!candidates.length) candidates = list;
  }
  return candidates[Math.floor(Math.random() * candidates.length)] || null;
}

// Move to the next track of the active PLAYBACK context (not the list being
// viewed). `auto` = the previous track ended by itself → gapless hand-over.
async function playNext({ auto = false } = {}) {
  if (!currentTrack) return false;
  if (auto && repeatMode === 'one') {
    await playTrack(currentTrack, { gapless: true });
    return true;
  }

  const list = getPlaybackList();
  let next = null;
  while (forcedNext.length && !next) {
    const candidate = forcedNext.shift();
    if (candidate && candidate.path) next = candidate;
  }
  if (!next && list.length) {
    if (shuffleEnabled) {
      next = pickShuffleNext(list);
    } else {
      const idx = list.findIndex((t) => tracksMatch(t, currentTrack));
      if (idx + 1 < list.length) next = list[idx + 1];
      else if (repeatMode === 'all') next = list[0];
    }
  }

  if (!next) {
    if (auto) {
      // End of the list: the engine lets the tail play out and releases the device.
      isPlaying = false;
      updatePlayButton();
    }
    return false;
  }
  await playTrack(next, { gapless: auto });
  return true;
}

async function playPrevious() {
  if (!currentTrack) return;
  // Like every other player: Previous first rewinds, a second press goes back.
  if (engineActive && lastKnownPosition > 3) {
    lastKnownPosition = 0;
    if (currentTimeEl) currentTimeEl.textContent = formatTime(0);
    if (seekSlider) seekSlider.value = 0;
    await electron.seek(0);
    return;
  }
  if (shuffleEnabled && playHistory.length > 1) {
    playHistory.pop(); // current
    const prev = playHistory.pop();
    if (prev) { await playTrack(prev); return; }
  }
  const list = getPlaybackList();
  if (!list.length) return;
  const idx = list.findIndex((t) => tracksMatch(t, currentTrack));
  if (idx > 0) await playTrack(list[idx - 1]);
  else if (repeatMode === 'all') await playTrack(list[list.length - 1]);
  else await playTrack(currentTrack);
}

async function advanceToNext() {
  if (!currentTrack) return;
  if (stopAfterCurrent) {
    stopAfterCurrent = false;
    isPlaying = false;
    updatePlayButton();
    NotificationCenter.show({ message: 'Stopped after current track', type: 'info', autoClose: 2500 });
    return;
  }
  try {
    await playNext({ auto: true });
  } catch (e) {
    console.warn('advanceToNext failed', e);
  }
}

async function togglePlayback() {
  if (isPlaying) {
    isPlaying = false;
    updatePlayButton();
    await electron.pause();
    return;
  }
  if (currentTrack) {
    let status = null;
    try { status = await electron.getAudioStatus(); } catch {}
    if (status && status.playing) {
      // Engine has this track loaded: resume if paused.
      if (status.paused) await electron.resume();
      isPlaying = true;
    } else {
      // Nothing loaded (fresh start or playback finished): start the current
      // track, continuing from the remembered position after a restart.
      const resumeAt = Number(pendingResumePosition) >= 1 ? Number(pendingResumePosition) : undefined;
      await playTrack(currentTrack, resumeAt !== undefined ? { startTime: resumeAt } : {});
    }
  } else if (tracks.length > 0) {
    await startPlayback(tracks[0], tracks, {
      type: libraryContext.type || 'library',
      key: libraryContext.name || libraryContext.id || null,
    });
  }
  updatePlayButton();
}

function setVolumeRelative(delta) {
  if (!volumeSlider) return;
  const next = Math.max(0, Math.min(100, Number(volumeSlider.value) + delta));
  volumeSlider.value = String(next);
  try { localStorage.setItem('spectra_volume', String(next)); } catch {}
  electron.setVolume(next);
}

async function seekRelative(deltaSeconds) {
  if (!currentTrack || !engineActive) return;
  const dur = effectiveDuration();
  let target = Math.max(0, lastKnownPosition + deltaSeconds);
  if (dur > 0) target = Math.min(target, Math.max(0, dur - 1));
  lastKnownPosition = target;
  if (currentTimeEl) currentTimeEl.textContent = formatTime(target);
  await electron.seek(target);
}

// "Play Next" / "Add to Queue" from the track context menu.
async function enqueueTracks(items, { next = false } = {}) {
  const incoming = (Array.isArray(items) ? items : [items]).filter((t) => t && t.path);
  if (!incoming.length) return;
  if (!currentTrack) {
    await startPlayback(incoming[0], incoming, { type: 'queue' });
    return;
  }
  const fresh = incoming.filter((t) => !tracksMatch(t, currentTrack));
  if (!fresh.length) return;
  const base = (playbackContext.list.length ? playbackContext.list : [currentTrack])
    .filter((t) => tracksMatch(t, currentTrack) || !fresh.some((n) => tracksMatch(n, t)));
  const idx = Math.max(0, base.findIndex((t) => tracksMatch(t, currentTrack)));
  if (next) {
    base.splice(idx + 1, 0, ...fresh);
    forcedNext = [...fresh, ...forcedNext.filter((t) => !fresh.some((n) => tracksMatch(n, t)))];
  } else {
    base.push(...fresh);
  }
  playbackContext = { ...playbackContext, list: base };
  for (const t of fresh) shufflePlayed.delete(trackKey(t));
  await mirrorQueueToMain(base, currentTrack);
  NotificationCenter.show({
    message: next
      ? `${fresh.length === 1 ? `"${fresh[0].title || 'Track'}"` : `${fresh.length} tracks`} will play next`
      : `${fresh.length} track${fresh.length !== 1 ? 's' : ''} added to queue`,
    type: 'success', autoClose: 2200,
  });
  const queuePanel = document.getElementById('queue-panel');
  if (queuePanel && !queuePanel.classList.contains('hidden')) { try { await renderQueue(); } catch {} }
}

async function removeSelectedTracks() {
  const ids = Array.from(globalThis.__spectra_selectedTrackIds || []).filter((id) => id != null);
  if (!ids.length) return;
  const ok = await customConfirm(
    ids.length === 1 ? 'Remove this track from the library?' : `Remove ${ids.length} tracks from the library?`,
    { title: 'Remove from library', confirmLabel: 'Remove' }
  );
  if (!ok) return;
  for (const id of ids) await electron.removeTrack(id);
  globalThis.__spectra_selectedTrackIds.clear();
  await loadLibrary();
}

function handlePlayerCommand(command) {
  switch (command) {
    case 'toggle': void togglePlayback(); break;
    case 'next': void playNext(); break;
    case 'previous': void playPrevious(); break;
    case 'stop':
      isPlaying = false;
      updatePlayButton();
      void electron.stop();
      break;
    case 'stop-after-current':
      stopAfterCurrent = !stopAfterCurrent;
      NotificationCenter.show({
        message: stopAfterCurrent ? 'Will stop after the current track' : 'Stop after current: off',
        type: 'info', autoClose: 2200,
      });
      break;
    case 'volume-up': setVolumeRelative(5); break;
    case 'volume-down': setVolumeRelative(-5); break;
    case 'focus-search': focusSearch(); break;
    default: break;
  }
}

// Keyboard shortcuts. They live here (not as menu accelerators) so that keys
// typed into text fields are never stolen.
function initKeyboardShortcuts() {
  const isTextTarget = (el) => {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(el.type);
  };
  const modalOpen = () => Array.from(document.querySelectorAll('.modal')).some((m) => m.style.display && m.style.display !== 'none');

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (mod && !e.altKey && (key === 'f' || key === 'F')) {
      e.preventDefault();
      focusSearch();
      return;
    }
    if (isTextTarget(e.target) || modalOpen() || e.altKey) return;

    if (key === ' ' && !mod) {
      if (e.target && e.target.tagName === 'BUTTON') return; // let the focused button act
      e.preventDefault();
      void togglePlayback();
    } else if (mod && key === 'ArrowRight') { e.preventDefault(); void playNext(); }
    else if (mod && key === 'ArrowLeft') { e.preventDefault(); void playPrevious(); }
    else if (mod && key === 'ArrowUp') { e.preventDefault(); setVolumeRelative(5); }
    else if (mod && key === 'ArrowDown') { e.preventDefault(); setVolumeRelative(-5); }
    else if (!mod && key === 'ArrowRight' && e.target?.type !== 'range') { e.preventDefault(); void seekRelative(e.shiftKey ? 30 : 5); }
    else if (!mod && key === 'ArrowLeft' && e.target?.type !== 'range') { e.preventDefault(); void seekRelative(e.shiftKey ? -30 : -5); }
    else if (mod && (key === 'a' || key === 'A') && currentView === 'library') {
      e.preventDefault();
      if (!globalThis.__spectra_selectedTrackIds) globalThis.__spectra_selectedTrackIds = new Set();
      const sel = globalThis.__spectra_selectedTrackIds;
      sel.clear();
      for (const t of tracks) sel.add(t.id);
      if (trackList) trackList.querySelectorAll('.track-item').forEach((n) => n.classList.add('selected'));
    } else if (key === 'Delete' && currentView === 'library') {
      e.preventDefault();
      void removeSelectedTracks();
    } else if (key === 'Enter' && currentView === 'library') {
      const sel = globalThis.__spectra_selectedTrackIds;
      const first = sel && sel.size ? tracks.find((t) => sel.has(t.id)) : null;
      if (first) {
        e.preventDefault();
        void startPlayback(first, tracks, {
          type: libraryContext.type || 'library',
          key: libraryContext.name || libraryContext.id || null,
        });
      }
    } else if (key === '/' && !mod) {
      e.preventDefault();
      focusSearch();
    }
  });
}

// "FLAC · 96 kHz · 24-bit → WASAPI exclusive" under the now-playing title.
function updateTechLine(status) {
  let el = document.getElementById('np-tech');
  if (!el) {
    const host = document.querySelector('.now-playing-info .track-details');
    if (!host) return;
    el = document.createElement('div');
    el.id = 'np-tech';
    el.className = 'track-tech';
    el.style.cssText = 'font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px';
    host.appendChild(el);
  }
  let text = '';
  if (status && status.playing && status.source) {
    const src = status.source;
    const out = status.output || {};
    const khz = (hz) => (hz ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : '');
    const parts = [];
    if (src.codec) parts.push(String(src.codec).split(/[ (]/)[0].toUpperCase());
    if (src.sampleRate) parts.push(khz(src.sampleRate));
    if (src.bitDepth) parts.push(`${src.bitDepth}-bit`);
    else if (src.bitrate) parts.push(`${Math.round(src.bitrate / 1000)} kbps`);
    let outText = out.backend ? String(out.backend) : '';
    if (out.sampleRate && out.sampleRate !== src.sampleRate) outText += ` ${khz(out.sampleRate)}`;
    if (out.bitPerfect) outText += ' · bit-perfect';
    if (stopAfterCurrent) outText += ' · stop after current';
    text = parts.join(' · ') + (outText ? ` → ${outText}` : '');
  }
  if (el.textContent !== text) el.textContent = text;
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
  dsdTransportSelect = document.getElementById('dsd-transport-select');
  bitPerfectCheckbox = document.getElementById('bitperfect-checkbox');
  strictBitPerfectCheckbox = document.getElementById('strict-bitperfect-checkbox');
  remoteEnableCheckbox = document.getElementById('remote-enable-checkbox');
  sampleRateSelect = document.getElementById('samplerate-select');
  sampleRateModeSelect = document.getElementById('samplerate-mode-select');
  sampleRateCustomInput = document.getElementById('samplerate-custom');
  bufferMsSelect = document.getElementById('buffer-ms-select');
  bufferFramesInput = document.getElementById('buffer-frames-input');
  asioControlPanelButton = document.getElementById('btn-asio-control-panel');

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
  navUpnp = document.getElementById('nav-upnp');
  navNas = document.getElementById('nav-nas');
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
  editAlbumArtist = document.getElementById('edit-album-artist');
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
  if (deviceSelect) deviceSelect.onchange = () => { void saveSettings(); };
  if (modeSelect) modeSelect.onchange = () => { updateAsioControlPanelState(); void saveSettings(); };
  if (dsdTransportSelect) dsdTransportSelect.onchange = () => { void saveSettings(); };
  if (bitPerfectCheckbox) bitPerfectCheckbox.onchange = () => { void saveSettings(); };
  if (strictBitPerfectCheckbox) strictBitPerfectCheckbox.onchange = () => { void saveSettings(); };
  if (bufferMsSelect) bufferMsSelect.onchange = () => { void saveSettings(); };
  if (bufferFramesInput) bufferFramesInput.onchange = () => { void saveSettings(); };
  if (remoteEnableCheckbox) remoteEnableCheckbox.onchange = () => { void saveSettings(); };
  if (sampleRateModeSelect) sampleRateModeSelect.onchange = () => { void saveSettings(); };
  if (sampleRateSelect) sampleRateSelect.onchange = () => { void saveSettings(); };
  if (sampleRateCustomInput) sampleRateCustomInput.onchange = () => { void saveSettings(); };
  if (asioControlPanelButton) {
    asioControlPanelButton.onclick = async () => {
      try {
        asioControlPanelButton.disabled = true;
        await electron.openAsioControlPanel(settings.deviceId);
      } catch (err) {
        console.error('Failed to open ASIO control panel:', err);
        NotificationCenter.show({ message: 'Failed to open ASIO control panel', detail: String(err?.message || err), type: 'error', autoClose: 3600 });
      } finally {
        updateAsioControlPanelState();
      }
    };
  }
  initEqualizerControls();

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
  if (navUpnp) navUpnp.onclick = () => switchView('upnp');
  if (navNas) navNas.onclick = () => switchView('nas');

  // UPnP broadcast listeners
  electron.on('upnp:servers-found', (data) => {
    if (!data || !data.servers) return;
    upnpServers = data.servers;
    renderUpnpServers(upnpServers);
    const statusEl = document.getElementById('upnp-status');
    if (statusEl) statusEl.textContent = `${upnpServers.length} server${upnpServers.length !== 1 ? 's' : ''} found`;
  });
  electron.on('upnp:servers-updated', (data) => {
    if (!data || !data.servers) return;
    upnpServers = data.servers;
    if (currentView === 'upnp') renderUpnpServers(upnpServers);
  });

  initNasModal();

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
      uiAlert('Failed to create playlist');
    }
  };
  if (btnImportPlaylist) btnImportPlaylist.onclick = async () => {
    try {
      const res = await electron.importPlaylist();
      if (res && res.success) {
        playlistsCache = [];
        await renderPlaylists({ forceReload: true });
        uiAlert('Playlist imported');
      } else if (res && res.canceled) {
        // user canceled
      } else {
        uiAlert('Import failed: ' + (res && res.error ? res.error : 'unknown'));
      }
    } catch (e) {
      console.error('Import playlist failed', e);
      uiAlert('Import failed');
    }
  };
  if (btnImportUrl) btnImportUrl.onclick = async () => {
    try {
      const url = await customPrompt('Enter remote audio URL (http or https):');
      if (!url || !url.trim()) return;

      const trimmedUrl = url.trim();
      if (!/^https?:\/\//i.test(trimmedUrl)) {
        uiAlert('Please enter a valid http(s) URL');
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
        const playNow = await customConfirm('Track added to library. Play it now?');
        if (playNow) {
          // Refresh library and find the just-added track
          const lib = await electron.getLibrary();
          const t = lib.find(x => x.path === trimmedUrl);
          if (t) await playTrack(t);
        }
      } else {
        uiAlert('Failed to add remote track: ' + (res && res.error ? res.error : 'unknown'));
      }
    } catch (e) {
      console.error('addImportUrl error', e);
      uiAlert('Error adding remote URL: ' + (e && e.message ? e.message : e));
    }
  };

  // Play button
  if (btnPlay) btnPlay.onclick = () => { void togglePlayback(); };

  // Prev/Next buttons — use the saved playback context, not the currently
  // visible list, so viewing a different album while music plays doesn't
  // hijack the next-track target. Shuffle and repeat are honoured.
  if (btnPrev) btnPrev.onclick = () => { void playPrevious(); };
  if (btnNext) btnNext.onclick = () => { void playNext(); };

  // Transport commands from the menu, tray and media keys
  electron.on('player:command', handlePlayerCommand);
  electron.on('queue:play-next', (items) => { void enqueueTracks(items, { next: true }); });
  electron.on('queue:append', (items) => { void enqueueTracks(items, { next: false }); });
  initKeyboardShortcuts();

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
    seekSlider.step = '0.05'; // 1% steps were 36 s jumps on an hour-long track
    seekSlider.onchange = (e) => {
      const dur = effectiveDuration();
      if (currentTrack && dur > 0) {
        const time = (Number(e.target.value) / 100) * dur;
        lastKnownPosition = time;
        if (currentTimeEl) currentTimeEl.textContent = formatTime(time);
        if (engineActive) electron.seek(time);
        else pendingResumePosition = time; // not loaded yet: start there on Play
      }
      isSeeking = false;
    };
    seekSlider.oninput = (e) => {
      isSeeking = true;
      const dur = effectiveDuration();
      if (dur > 0 && currentTimeEl) currentTimeEl.textContent = formatTime((Number(e.target.value) / 100) * dur);
    };
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
    const data = { title: editTitle.value, artist: editArtist.value, album: editAlbum.value, album_artist: editAlbumArtist ? editAlbumArtist.value : null };
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

        // Reorder atomically instead of remove-all + re-add, which would drop
        // the tracks entirely if the Add step fails partway through.
        const orderedIds = playlistEditorTracks.map((t) => t.id).filter(Boolean);
        if (electron.reorderPlaylist) {
          await electron.reorderPlaylist(currentEditingPlaylist, orderedIds);
        } else {
          // Fallback for older preloads: remove-then-add (best-effort).
          const currentTracks = await electron.getPlaylistTracks(currentEditingPlaylist);
          for (const track of currentTracks) {
            await electron.removeTrackFromPlaylist(currentEditingPlaylist, track.id);
          }
          for (const id of orderedIds) {
            await electron.addTrackToPlaylist(currentEditingPlaylist, id);
          }
        }

        // If the edited playlist is the one currently opened in the library
        // view, refresh its track list too.
        if (libraryContext.type === 'playlist' && currentPlaylistFilter?.id === currentEditingPlaylist) {
          try {
            const refreshed = await electron.getPlaylistTracks(currentEditingPlaylist);
            currentPlaylistTracks = Array.isArray(refreshed) ? refreshed : [];
            tracks = [...currentPlaylistTracks];
            renderLibrary();
          } catch (err) {
            console.warn('Failed to refresh current playlist tracks after save', err);
          }
        }

        closePlaylistEditorModal();
        playlistsCache = [];
        await renderPlaylists({ forceReload: true });
      } catch (err) {
        console.error('Failed to save playlist edits:', err);
        uiAlert('Failed to save changes');
      }
    };
  }

  if (btnDeletePlaylist) {
    btnDeletePlaylist.onclick = async () => {
      if (!currentEditingPlaylist) return;

      const confirmed = await customConfirm('Are you sure you want to delete this playlist? This cannot be undone.');
      if (!confirmed) return;

      try {
        const deletedId = currentEditingPlaylist;
        await electron.deletePlaylist(deletedId);

        // If the deleted playlist was open in the library view, fall back to
        // the root library so the user isn't left staring at phantom tracks.
        if (libraryContext.type === 'playlist' && currentPlaylistFilter?.id === deletedId) {
          setLibraryContext('library');
          await loadLibrary();
        }

        closePlaylistEditorModal();
        playlistsCache = [];
        await renderPlaylists({ forceReload: true });
      } catch (err) {
        console.error('Failed to delete playlist:', err);
        uiAlert('Failed to delete playlist');
      }
    };
  }

  // IPC handlers
  electron.on('track:edit', (track) => {
    editingTrackId = track.id;
    if (editTitle) editTitle.value = track.title || '';
    if (editArtist) editArtist.value = track.artist || '';
    if (editAlbum) editAlbum.value = track.album || '';
    if (editAlbumArtist) editAlbumArtist.value = track.album_artist || '';
    if (editModal) editModal.style.display = 'flex';
  });

  electron.on('track:remove', async (trackId) => {
    if (await customConfirm('Are you sure you want to remove this track from the library?')) {
      await electron.removeTrack(trackId);
      loadLibrary();
    }
  });

  // Handle multi-remove initiated from context menu
  electron.on('tracks:remove', async (trackIds) => {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return;
    if (await customConfirm(`Are you sure you want to remove ${trackIds.length} tracks from the library?`)) {
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
  electron.on('import:complete', (info) => {
    NotificationCenter.show({
      message: info && info.failed
        ? `Import complete — ${info.failed} of ${info.total} could not be read`
        : 'Import complete!',
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
      uiAlert(`Created playlist "${created.name}" and added ${Array.isArray(trackIds) ? trackIds.length : 0} tracks.`);
    } catch (e) {
      console.error('playlist:create-from-selection handler failed', e);
    }
  });

  // Refresh playlists view when main notifies tracks were added
  electron.on('playlist:added', async () => {
    try { playlistsCache = []; await renderPlaylists({ forceReload: true }); } catch {}
  });

  // Update notifications
  electron.on('update:available', ({ type, currentVersion, latestVersion, url }) => {
    const isMajor = type === 'major';
    const message = isMajor
      ? `Major update available: v${latestVersion}`
      : `Update available: v${latestVersion}`;
    const detail = isMajor
      ? `You're on v${currentVersion} — major release, click to download`
      : `You're on v${currentVersion} — click to download`;

    NotificationCenter.show({
      message,
      detail,
      type: isMajor ? 'warning' : 'info',
      sticky: isMajor,
      autoClose: isMajor ? null : 12000,
      dismissible: true,
    });

    // Make the bar clickable to open release page
    try {
      const { bar } = NotificationCenter.ensureDom();
      if (bar) {
        bar.style.cursor = 'pointer';
        bar.onclick = (e) => {
          if (e.target.closest('#notification-close')) return; // don't intercept close btn
          if (typeof electron.openExternal === 'function') {
            electron.openExternal(url);
          } else {
            window.open(url, '_blank');
          }
        };
      }
    } catch {}
  });

  // Periodic UI updates
  setInterval(async () => {
    if (!currentTrack) return;
    let status = null;
    try { status = await electron.getAudioStatus(); } catch {}
    const ok = status && !status.error;
    if (ok) engineActive = !!status.playing;
    renderAudioOutputStatus(status);
    updateTechLine(status);

    if (ok && !playRequestsInFlight) {
      // Keep the play button honest (end of list, device errors, remote control).
      const nowPlaying = engineActive && !status.paused;
      if (nowPlaying !== isPlaying) { isPlaying = nowPlaying; updatePlayButton(); }
      if (engineActive && status.duration > 0 && Math.abs(status.duration - lastStatusDuration) > 0.5) {
        lastStatusDuration = status.duration;
        if (totalTimeEl) totalTimeEl.textContent = formatTime(effectiveDuration());
      }
    }

    // Only a loaded track has a meaningful position; otherwise keep showing
    // (and keep saved) the remembered one instead of overwriting it with 0.
    if (ok && engineActive && typeof status.currentTime === 'number' && !playRequestsInFlight) {
      const time = status.currentTime;
      lastKnownPosition = time;
      if (!isSeeking) {
        if (currentTimeEl) currentTimeEl.textContent = formatTime(time);
        const dur = effectiveDuration();
        if (dur > 0 && seekSlider) seekSlider.value = Math.min(100, (time / dur) * 100);
      }
      saveLastPlayed(currentTrack, time);
    }
    showNowPlaying();

    // Safety net for a missed 'audio:ended' event: the engine reports the
    // track as finished on two consecutive polls and nobody advanced yet.
    if (ok && status.ended && advancedInstance !== playInstance && !playRequestsInFlight) {
      if (++endedPolls >= 2) {
        endedPolls = 0;
        advancedInstance = playInstance;
        void advanceToNext();
      }
    } else {
      endedPolls = 0;
    }
  }, 500);

  // Initial load
  await loadLibrary();
  initSearch();
  initLibrarySorting();
  await loadSettingsUI();
  // Push current settings to main (ensure minimize-to-tray preference applied at startup)
  try { void saveSettings(); } catch (e) { console.warn('Initial saveSettings failed', e); }

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
        pendingResumePosition = Number(last.elapsed) || 0;
        // Finished (or nearly finished) last time: start over instead.
        if (found.duration > 0 && pendingResumePosition > found.duration - Math.min(5, found.duration * 0.1)) pendingResumePosition = 0;
        lastKnownPosition = pendingResumePosition;
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

// ─── Network browsers: shared helpers ────────────────────────────────────────

function netFormatDuration(dur) {
  if (dur == null || dur === '') return '';
  if (typeof dur === 'number') return dur > 0 ? formatTime(dur) : '';
  const parts = String(dur).split(':');
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseInt(parts[2], 10);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  return dur;
}

const netNotify = (message, type = 'info', autoClose = 3000) =>
  NotificationCenter.show({ message: String(message), type, autoClose });

const netErrorText = (err) => String(err && err.message ? err.message : err)
  .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function netShowMessage(container, text, className = 'net-empty-hint') {
  container.innerHTML = '';
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text; // textContent: server-supplied text is never parsed as HTML
  container.appendChild(el);
  return el;
}

function netIconButton(icon, title, onClick, { danger = false, size = null } = {}) {
  const btn = document.createElement('button');
  btn.title = title;
  if (danger) btn.className = 'danger';
  const span = document.createElement('span');
  span.className = 'material-icons';
  span.textContent = icon;
  if (size) span.style.fontSize = `${size}px`;
  btn.appendChild(span);
  btn.onclick = async (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    try { await onClick(e); } finally { btn.disabled = false; }
  };
  return btn;
}

function netToolbarButton(icon, label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'btn-secondary';
  const span = document.createElement('span');
  span.className = 'material-icons';
  span.style.cssText = 'font-size:16px;vertical-align:middle;margin-right:4px';
  span.textContent = icon;
  btn.appendChild(span);
  btn.appendChild(document.createTextNode(label));
  btn.onclick = async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await onClick(); } catch (err) { netNotify(netErrorText(err), 'error', 4000); } finally { btn.disabled = false; }
  };
  return btn;
}

function renderNetBreadcrumb(container, crumbs, onNavigate) {
  container.innerHTML = '';
  crumbs.forEach((crumb, i) => {
    const span = document.createElement('span');
    span.className = 'net-breadcrumb-item' + (i === crumbs.length - 1 ? ' current' : '');
    span.textContent = crumb.name;
    if (i < crumbs.length - 1) span.onclick = () => onNavigate(i);
    container.appendChild(span);
    if (i < crumbs.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'net-breadcrumb-sep';
      sep.textContent = '›';
      container.appendChild(sep);
    }
  });
}

// Filter the rows currently shown in a network browser by the search box.
function applyNetFilter(kind, rawQuery = '') {
  const fb = document.getElementById(kind === 'upnp' ? 'upnp-filebrowser' : 'nas-filebrowser');
  if (!fb) return;
  const needles = normalizeForCompare(rawQuery).split(/\s+/).filter(Boolean);
  let shown = 0;
  let total = 0;
  fb.querySelectorAll('.net-file-item').forEach((row) => {
    total++;
    const hay = row.dataset.search || '';
    const match = needles.every((n) => hay.includes(n));
    row.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  let note = fb.querySelector('.net-filter-note');
  if (!needles.length || !total) {
    if (note) note.remove();
    return;
  }
  if (!note) {
    note = document.createElement('div');
    note.className = 'net-empty-hint net-filter-note';
    const list = fb.querySelector('.net-file-list');
    if (list) fb.insertBefore(note, list); else fb.appendChild(note);
  }
  const scope = kind === 'upnp' && upnpSelectedUsn ? ' — press Enter to search the whole server' : '';
  note.textContent = `${shown} of ${total} shown in this folder${scope}`;
}

async function refreshLibraryCaches() {
  try {
    libraryCache = await electron.getLibrary();
    albumsCache = [];
    artistsCache = [];
  } catch (err) {
    console.warn('Failed to refresh library after network add', err);
  }
}

/**
 * Put network items into the library and return their library rows.
 * `items`: [{ path, remote: boolean, title?, artist?, album?, duration?, coverUrl?, ... }]
 */
async function registerNetworkTracks(items) {
  const list = (items || []).filter((it) => it && it.path);
  if (!list.length) return [];
  const remote = list.filter((it) => it.remote);
  const local = list.filter((it) => !it.remote);

  const idByPath = new Map();
  if (remote.length === 1) {
    const { path: url, remote: _r, ...info } = remote[0];
    const res = await electron.addRemote({ url, ...info });
    if (res?.success) idByPath.set(url, res.track || { id: res.id, path: url });
    else throw new Error(res?.error || 'Could not add the track to the library');
  } else if (remote.length > 1) {
    await electron.addRemoteMany(remote.map(({ path: url, remote: _r, ...info }) => ({ url, ...info })));
  }
  if (local.length) await electron.addFiles(local.map((it) => it.path));

  await refreshLibraryCaches();
  const byPath = new Map((libraryCache || []).map((t) => [t.path, t]));
  const out = [];
  for (const it of list) {
    const row = byPath.get(it.path) || idByPath.get(it.path);
    if (row && row.id != null) out.push(row);
  }
  return out;
}

async function addNetworkItemsToLibrary(items, label) {
  if (!items.length) { netNotify('No audio files here', 'info'); return; }
  const rows = await registerNetworkTracks(items);
  if (!rows.length) throw new Error('Nothing could be added to the library');
  netNotify(
    rows.length === 1 ? `Added "${label || rows[0].title}" to library` : `${rows.length} tracks added to library`,
    'success'
  );
}

// ─── Network → Playlist helpers ──────────────────────────────────────────────

function showPlaylistPicker() {
  return new Promise(async (resolve) => {
    const modal = document.getElementById('playlist-picker-modal');
    const list = document.getElementById('playlist-picker-list');
    const cancelBtn = document.getElementById('btn-playlist-picker-cancel');
    const newBtn = document.getElementById('btn-playlist-picker-new');
    if (!modal) { resolve(null); return; }

    let playlists = [];
    try { playlists = await electron.getPlaylists(); } catch {}

    const close = () => {
      modal.style.display = 'none';
      if (cancelBtn) cancelBtn.onclick = null;
      if (newBtn) newBtn.onclick = null;
      modal.onclick = null;
    };

    list.innerHTML = '';
    if (!playlists.length) {
      netShowMessage(list, 'No playlists yet — create one below').style.cssText = 'opacity:.6;font-size:13px;padding:8px 0';
    } else {
      playlists.forEach((pl) => {
        const btn = document.createElement('button');
        btn.className = 'btn-text';
        btn.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 4px;font-size:14px';
        btn.textContent = pl.name;
        btn.onclick = () => { close(); resolve(pl); };
        list.appendChild(btn);
      });
    }

    if (cancelBtn) cancelBtn.onclick = () => { close(); resolve(null); };
    if (newBtn) {
      newBtn.onclick = async () => {
        // window.prompt() does not exist in Electron — use the in-app prompt.
        const name = await customPrompt('New playlist name:');
        if (!name || !name.trim()) return;
        try {
          const result = await electron.createPlaylist(name.trim());
          playlistsCache = [];
          close();
          resolve({ id: result.lastInsertRowid, name: name.trim() });
        } catch (err) {
          netNotify('Failed to create playlist: ' + netErrorText(err), 'error', 4000);
        }
      };
    }
    modal.onclick = (e) => { if (e.target === modal) { close(); resolve(null); } };
    modal.style.display = 'flex';
  });
}

async function addNetworkItemsToPlaylist(items) {
  if (!items.length) { netNotify('No audio files here', 'info'); return; }
  const pl = await showPlaylistPicker();
  if (!pl) return;
  try {
    const rows = await registerNetworkTracks(items);
    for (const row of rows) await electron.addTrackToPlaylist(pl.id, row.id);
    playlistsCache = [];
    netNotify(`${rows.length} track${rows.length !== 1 ? 's' : ''} added to "${pl.name}"`, rows.length ? 'success' : 'error');
  } catch (err) {
    netNotify(netErrorText(err), 'error', 4000);
  }
}

// ─── UPnP / DLNA Browser ─────────────────────────────────────────────────────

const upnpToTrack = (t) => ({
  id: 'upnp:' + (t.id || t.url),
  path: t.url,
  title: t.title || '',
  artist: t.artist || '',
  album: t.album || '',
  duration: Number(t.duration) || 0,
  cover_path: t.albumArt || null,
});

const upnpToLibraryItem = (t) => ({
  path: t.url,
  remote: true,
  title: t.title || undefined,
  artist: t.artist || undefined,
  album: t.album || undefined,
  duration: Number(t.duration) || undefined,
  coverUrl: t.albumArt || undefined,
  sampleRate: t.sampleRate || undefined,
  bitDepth: t.bitDepth || undefined,
  channels: t.channels || undefined,
});

function renderUpnpServers(servers) {
  const list = document.getElementById('upnp-servers-list');
  if (!list) return;
  if (!servers || !servers.length) {
    netShowMessage(list, 'No servers found on network');
    return;
  }
  list.innerHTML = '';
  servers.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'net-server-item' + (s.usn === upnpSelectedUsn ? ' active' : '');
    item.dataset.usn = s.usn;
    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.textContent = 'dns';
    const name = document.createElement('span');
    name.textContent = s.friendlyName || s.usn;
    name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    item.appendChild(icon);
    item.appendChild(name);
    if (s.manual) {
      const actions = document.createElement('div');
      actions.className = 'net-server-item-actions';
      actions.appendChild(netIconButton('delete', 'Remove server', async () => {
        await electron.upnpRemoveServer({ usn: s.usn });
        upnpServers = upnpServers.filter((x) => x.usn !== s.usn);
        if (upnpSelectedUsn === s.usn) {
          upnpSelectedUsn = null;
          const fb = document.getElementById('upnp-filebrowser');
          if (fb) netShowMessage(fb, 'Select a server to browse');
        }
        renderUpnpServers(upnpServers);
      }, { danger: true, size: 16 }));
      item.appendChild(actions);
    }
    item.onclick = () => {
      upnpSelectedUsn = s.usn;
      upnpBreadcrumb = [{ id: '0', name: s.friendlyName || 'Root' }];
      renderUpnpServers(upnpServers);
      browseUpnp(s.usn, '0');
    };
    list.appendChild(item);
  });
}

let upnpBrowseToken = 0;

async function browseUpnp(usn, objectId) {
  const fb = document.getElementById('upnp-filebrowser');
  if (!fb) return;
  const token = ++upnpBrowseToken;
  netShowMessage(fb, 'Loading…', 'net-loading');
  try {
    const items = await electron.upnpBrowse({ usn, objectId });
    if (token !== upnpBrowseToken) return; // a newer navigation won
    renderUpnpItems(fb, usn, items, { objectId });
    if (searchInputEl && searchInputEl.value.trim()) applyNetFilter('upnp', searchInputEl.value);
  } catch (err) {
    if (token !== upnpBrowseToken) return;
    netShowMessage(fb, `Error: ${netErrorText(err)}`);
  }
}

async function searchUpnp(query) {
  const fb = document.getElementById('upnp-filebrowser');
  const q = String(query || '').trim();
  if (!fb || !q) return;
  if (!upnpSelectedUsn) { netNotify('Select a server first', 'info'); return; }
  const usn = upnpSelectedUsn;
  const token = ++upnpBrowseToken;
  netShowMessage(fb, `Searching for "${q}"…`, 'net-loading');
  try {
    const items = await electron.upnpSearch({ usn, query: q });
    if (token !== upnpBrowseToken) return;
    const root = upnpBreadcrumb[0] || { id: '0', name: 'Root' };
    upnpBreadcrumb = [root, { id: null, name: `Search: ${q}` }];
    renderUpnpItems(fb, usn, items, { objectId: null, emptyText: `No results for "${q}"` });
  } catch (err) {
    if (token !== upnpBrowseToken) return;
    // Not every server implements Search; fall back to filtering what is on screen.
    netNotify(`This server cannot search (${netErrorText(err)}) — filtering the current folder instead`, 'info', 4500);
    const last = upnpBreadcrumb[upnpBreadcrumb.length - 1];
    await browseUpnp(usn, (last && last.id) || '0');
  }
}

function renderUpnpItems(fb, usn, items, { objectId = null, emptyText = 'Empty folder' } = {}) {
  fb.innerHTML = '';

  const breadEl = document.createElement('div');
  breadEl.className = 'net-breadcrumb';
  renderNetBreadcrumb(breadEl, upnpBreadcrumb, (idx) => {
    upnpBreadcrumb = upnpBreadcrumb.slice(0, idx + 1);
    browseUpnp(usn, upnpBreadcrumb[upnpBreadcrumb.length - 1].id || '0');
  });
  fb.appendChild(breadEl);

  const fileList = document.createElement('div');
  fileList.className = 'net-file-list';

  if (!items || !items.length) {
    netShowMessage(fileList, emptyText);
    fb.appendChild(fileList);
    return;
  }

  const trackItems = items.filter((it) => it.type === 'track');
  const hasFolders = items.some((it) => it.type === 'container');
  const playList = trackItems.map(upnpToTrack);

  const toolbar = document.createElement('div');
  toolbar.className = 'net-folder-toolbar';
  if (trackItems.length) {
    toolbar.appendChild(netToolbarButton('play_arrow', 'Play all', async () => {
      await startPlayback(playList[0], playList, { type: 'upnp', key: usn });
    }));
    toolbar.appendChild(netToolbarButton('library_add', 'Add all to library', () =>
      addNetworkItemsToLibrary(trackItems.map(upnpToLibraryItem))));
    toolbar.appendChild(netToolbarButton('playlist_add', 'Add all to playlist', () =>
      addNetworkItemsToPlaylist(trackItems.map(upnpToLibraryItem))));
  }
  if (hasFolders && objectId != null) {
    toolbar.appendChild(netToolbarButton('create_new_folder', 'Add folder + subfolders to library', async () => {
      netNotify('Scanning server folders…', 'info', 6000);
      const all = await electron.upnpListRecursive({ usn, objectId });
      await addNetworkItemsToLibrary((all || []).map(upnpToLibraryItem));
    }));
  }
  if (toolbar.childElementCount) fb.appendChild(toolbar);

  items.forEach((it) => {
    const isFolder = it.type === 'container';
    const row = document.createElement('div');
    row.className = 'net-file-item ' + (isFolder ? 'is-folder' : 'is-track');
    row.dataset.search = normalizeForCompare([it.title, it.artist, it.album].filter(Boolean).join(' '));

    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.textContent = isFolder ? 'folder' : 'audio_file';

    const meta = document.createElement('div');
    meta.className = 'net-file-item-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'net-file-item-name';
    nameEl.textContent = it.title || it.name || '(untitled)';
    meta.appendChild(nameEl);

    if (!isFolder && (it.artist || it.album)) {
      const sub = document.createElement('div');
      sub.className = 'net-file-item-sub';
      sub.textContent = [it.artist, it.album].filter(Boolean).join(' · ');
      meta.appendChild(sub);
    }

    row.appendChild(icon);
    row.appendChild(meta);

    if (isFolder) {
      const actions = document.createElement('div');
      actions.className = 'net-file-item-actions';
      actions.appendChild(netIconButton('library_add', 'Add this folder (with subfolders) to library', async () => {
        try {
          netNotify(`Scanning "${it.title}"…`, 'info', 6000);
          const all = await electron.upnpListRecursive({ usn, objectId: it.id });
          await addNetworkItemsToLibrary((all || []).map(upnpToLibraryItem));
        } catch (err) { netNotify(netErrorText(err), 'error', 4000); }
      }));
      row.appendChild(actions);
      row.onclick = () => {
        // Leaving search results: restart the trail from the server root.
        const trail = upnpBreadcrumb.filter((c) => c.id != null);
        upnpBreadcrumb = [...trail, { id: it.id, name: it.title || it.name || 'Folder' }];
        browseUpnp(usn, it.id);
      };
    } else {
      const durText = netFormatDuration(it.duration);
      if (durText) {
        const dur = document.createElement('div');
        dur.className = 'net-file-item-duration';
        dur.textContent = durText;
        row.appendChild(dur);
      }

      const play = () => startPlayback(upnpToTrack(it), playList, { type: 'upnp', key: usn });
      const actions = document.createElement('div');
      actions.className = 'net-file-item-actions';
      actions.appendChild(netIconButton('play_circle', 'Play', play));
      actions.appendChild(netIconButton('library_add', 'Add to library', async () => {
        try { await addNetworkItemsToLibrary([upnpToLibraryItem(it)], it.title); }
        catch (err) { netNotify(netErrorText(err), 'error', 4000); }
      }));
      actions.appendChild(netIconButton('playlist_add', 'Add to playlist', () =>
        addNetworkItemsToPlaylist([upnpToLibraryItem(it)])));
      row.appendChild(actions);
      row.ondblclick = play;
    }

    fileList.appendChild(row);
  });

  fb.appendChild(fileList);
}

function setUpnpStatus(text) {
  const statusEl = document.getElementById('upnp-status');
  if (statusEl) statusEl.textContent = text;
}

async function loadUpnpView() {
  const scanBtn = document.getElementById('btn-upnp-scan');

  if (scanBtn && !scanBtn._bound) {
    scanBtn._bound = true;
    scanBtn.onclick = async () => {
      setUpnpStatus('Scanning…');
      scanBtn.disabled = true;
      try {
        upnpServers = (await electron.upnpScan()) || [];
        renderUpnpServers(upnpServers);
        setUpnpStatus(upnpServers.length
          ? `${upnpServers.length} server${upnpServers.length !== 1 ? 's' : ''} found`
          : 'No servers found — check that the server is on and Windows Firewall allows Spectra, or add it by URL');
      } catch (err) {
        setUpnpStatus(`Scan failed: ${netErrorText(err)}`);
        console.error('[upnp] scan error', err);
      } finally {
        scanBtn.disabled = false;
      }
    };

    // "Add by URL" for networks where multicast discovery is blocked.
    const addBtn = document.createElement('button');
    addBtn.id = 'btn-upnp-add';
    addBtn.className = 'btn-secondary';
    addBtn.title = 'Add a server by its device description URL';
    addBtn.textContent = 'Add by URL';
    addBtn.onclick = async () => {
      const url = await customPrompt('Server description URL (e.g. http://192.168.1.10:8200/rootDesc.xml):');
      if (!url || !url.trim()) return;
      setUpnpStatus('Connecting…');
      try {
        const server = await electron.upnpAddServer({ location: url.trim() });
        upnpServers = (await electron.upnpGetServers()) || [server];
        renderUpnpServers(upnpServers);
        setUpnpStatus(`Added ${server.friendlyName || 'server'}`);
      } catch (err) {
        setUpnpStatus('');
        netNotify(`Could not add server: ${netErrorText(err)}`, 'error', 5000);
      }
    };
    scanBtn.insertAdjacentElement('afterend', addBtn);
  }

  if (!upnpServers.length) {
    try {
      const cached = await electron.upnpGetServers();
      if (cached && cached.length) {
        upnpServers = cached;
        setUpnpStatus(`${upnpServers.length} server${upnpServers.length !== 1 ? 's' : ''}`);
      }
    } catch (err) {
      setUpnpStatus(/No handler registered/i.test(String(err))
        ? 'UPnP plugin is not running — enable it in Settings → Plugins'
        : `Unavailable: ${netErrorText(err)}`);
    }
  }
  renderUpnpServers(upnpServers);
}

// ─── NAS / Network Storage Browser ───────────────────────────────────────────

const nasShareIsRemote = (shareId) => nasShares.find((s) => s.id === shareId)?.type === 'webdav';
const nasTitle = (name) => String(name || '').replace(/\.[^.]+$/, '');

const nasToTrack = (t) => ({
  id: 'nas:' + t.path,
  path: t.path,
  title: nasTitle(t.name),
  artist: '',
  album: '',
  duration: 0,
});

const nasToLibraryItem = (shareId) => {
  const remote = nasShareIsRemote(shareId);
  return (t) => (remote ? { path: t.path, remote: true } : { path: t.path, remote: false });
};

function renderNasShares(shares) {
  const list = document.getElementById('nas-shares-list');
  if (!list) return;
  if (!shares || !shares.length) {
    netShowMessage(list, 'No shares yet — click "Add Share"');
    return;
  }
  list.innerHTML = '';
  shares.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'net-server-item' + (s.id === nasSelectedShareId ? ' active' : '');
    item.title = s.url || s.path || '';

    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.textContent = s.type === 'webdav' ? 'cloud' : 'storage';

    const name = document.createElement('span');
    name.textContent = s.name;
    name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    const badge = document.createElement('span');
    badge.className = 'net-share-type-badge';
    badge.textContent = s.type;

    const actions = document.createElement('div');
    actions.className = 'net-server-item-actions';
    actions.appendChild(netIconButton('edit', 'Edit share', () => { if (showNasModal) showNasModal(s); }, { size: 16 }));
    actions.appendChild(netIconButton('wifi_tethering', 'Test connection', async () => {
      try {
        const res = await electron.nasTestShare({ shareId: s.id });
        netNotify(res.message, res.ok ? 'success' : 'error', 4000);
      } catch (err) {
        netNotify(netErrorText(err), 'error', 4000);
      }
    }, { size: 16 }));
    actions.appendChild(netIconButton('delete', 'Remove share', async () => {
      const ok = await customConfirm(`Remove share "${s.name}"? Tracks already added to the library stay there.`, {
        title: 'Remove share', confirmLabel: 'Remove',
      });
      if (!ok) return;
      try {
        await electron.nasRemoveShare({ shareId: s.id });
        if (nasSelectedShareId === s.id) {
          nasSelectedShareId = null;
          nasBreadcrumb = [];
          const fb = document.getElementById('nas-filebrowser');
          if (fb) netShowMessage(fb, 'Select a share to browse');
        }
        await loadNasView();
      } catch (err) {
        netNotify(netErrorText(err), 'error', 4000);
      }
    }, { danger: true, size: 16 }));

    item.appendChild(icon);
    item.appendChild(name);
    item.appendChild(badge);
    item.appendChild(actions);
    item.onclick = () => openNasShare(s);
    list.appendChild(item);
  });
}

function openNasShare(share) {
  nasSelectedShareId = share.id;
  nasBreadcrumb = [{ path: null, name: share.name }];
  renderNasShares(nasShares);
  browseNas(share.id, null);
}

let nasBrowseToken = 0;

async function browseNas(shareId, subPath) {
  const fb = document.getElementById('nas-filebrowser');
  if (!fb) return;
  const token = ++nasBrowseToken;
  netShowMessage(fb, 'Loading…', 'net-loading');
  try {
    const items = await electron.nasBrowse({ shareId, subPath });
    if (token !== nasBrowseToken) return;
    renderNasItems(fb, shareId, subPath, items);
    if (searchInputEl && searchInputEl.value.trim()) applyNetFilter('nas', searchInputEl.value);
  } catch (err) {
    if (token !== nasBrowseToken) return;
    fb.innerHTML = '';
    const breadEl = document.createElement('div');
    breadEl.className = 'net-breadcrumb';
    renderNetBreadcrumb(breadEl, nasBreadcrumb, (idx) => {
      nasBreadcrumb = nasBreadcrumb.slice(0, idx + 1);
      browseNas(shareId, nasBreadcrumb[nasBreadcrumb.length - 1].path);
    });
    fb.appendChild(breadEl);
    const msg = document.createElement('div');
    msg.className = 'net-empty-hint';
    msg.textContent = `Could not open this location: ${netErrorText(err)}`;
    fb.appendChild(msg);
  }
}

function renderNasItems(fb, shareId, currentPath, items) {
  fb.innerHTML = '';

  const breadEl = document.createElement('div');
  breadEl.className = 'net-breadcrumb';
  renderNetBreadcrumb(breadEl, nasBreadcrumb, (idx) => {
    nasBreadcrumb = nasBreadcrumb.slice(0, idx + 1);
    browseNas(shareId, nasBreadcrumb[nasBreadcrumb.length - 1].path);
  });
  fb.appendChild(breadEl);

  const toLibraryItem = nasToLibraryItem(shareId);
  const remote = nasShareIsRemote(shareId);
  const trackItems = (items || []).filter((it) => it.type === 'file');
  const playList = trackItems.map(nasToTrack);

  // Add a whole folder (with subfolders): local/SMB folders go through the
  // normal folder import; WebDAV folders are listed recursively on the server.
  const addFolderToLibrary = async (folderPath, label) => {
    if (!remote) {
      const target = folderPath || nasShares.find((s) => s.id === shareId)?.path;
      if (!target) throw new Error('Share has no path');
      const res = await electron.addFiles([target]);
      await refreshLibraryCaches();
      netNotify(res && res.count ? `${res.count} tracks added from "${label}"` : `No audio files found in "${label}"`, res && res.count ? 'success' : 'info');
      return;
    }
    netNotify(`Scanning "${label}"…`, 'info', 6000);
    const all = await electron.nasListRecursive({ shareId, subPath: folderPath });
    await addNetworkItemsToLibrary((all || []).map(toLibraryItem));
  };

  const currentLabel = nasBreadcrumb[nasBreadcrumb.length - 1]?.name || 'folder';
  const toolbar = document.createElement('div');
  toolbar.className = 'net-folder-toolbar';
  if (trackItems.length) {
    toolbar.appendChild(netToolbarButton('play_arrow', 'Play all', async () => {
      await startPlayback(playList[0], playList, { type: 'nas', key: shareId });
    }));
    toolbar.appendChild(netToolbarButton('playlist_add', 'Add all to playlist', () =>
      addNetworkItemsToPlaylist(trackItems.map(toLibraryItem))));
  }
  toolbar.appendChild(netToolbarButton('library_add', 'Add this folder to library', () =>
    addFolderToLibrary(currentPath, currentLabel)));
  fb.appendChild(toolbar);

  const fileList = document.createElement('div');
  fileList.className = 'net-file-list';

  if (!items || !items.length) {
    netShowMessage(fileList, 'No folders or audio files here');
    fb.appendChild(fileList);
    return;
  }

  items.forEach((it) => {
    const isFolder = it.type === 'directory';
    const row = document.createElement('div');
    row.className = 'net-file-item ' + (isFolder ? 'is-folder' : 'is-track');
    row.dataset.search = normalizeForCompare(it.name);

    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.textContent = isFolder ? 'folder' : 'audio_file';

    const meta = document.createElement('div');
    meta.className = 'net-file-item-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'net-file-item-name';
    nameEl.textContent = it.name;
    meta.appendChild(nameEl);

    row.appendChild(icon);
    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'net-file-item-actions';

    if (isFolder) {
      actions.appendChild(netIconButton('library_add', 'Add this folder (with subfolders) to library', async () => {
        try { await addFolderToLibrary(it.path, it.name); }
        catch (err) { netNotify(netErrorText(err), 'error', 4000); }
      }));
      row.appendChild(actions);
      row.onclick = () => {
        nasBreadcrumb = [...nasBreadcrumb, { path: it.path, name: it.name }];
        browseNas(shareId, it.path);
      };
    } else {
      const play = () => startPlayback(nasToTrack(it), playList, { type: 'nas', key: shareId });
      actions.appendChild(netIconButton('play_circle', 'Play', play));
      actions.appendChild(netIconButton('library_add', 'Add to library', async () => {
        try { await addNetworkItemsToLibrary([toLibraryItem(it)], nasTitle(it.name)); }
        catch (err) { netNotify(netErrorText(err), 'error', 4000); }
      }));
      actions.appendChild(netIconButton('playlist_add', 'Add to playlist', () =>
        addNetworkItemsToPlaylist([toLibraryItem(it)])));
      row.appendChild(actions);
      row.ondblclick = play;
    }

    fileList.appendChild(row);
  });

  fb.appendChild(fileList);
}

async function loadNasView() {
  try {
    nasShares = (await electron.nasListShares()) || [];
    renderNasShares(nasShares);
  } catch (err) {
    nasShares = [];
    const list = document.getElementById('nas-shares-list');
    if (list) {
      netShowMessage(list, /No handler registered/i.test(String(err))
        ? 'Network Storage plugin is not running — enable it in Settings → Plugins'
        : `Unavailable: ${netErrorText(err)}`);
    }
  }
}

function initNasModal() {
  const modal = document.getElementById('nas-share-modal');
  const addBtn = document.getElementById('btn-nas-add');
  const cancelBtn = document.getElementById('btn-nas-modal-cancel');
  const saveBtn = document.getElementById('btn-nas-modal-save');
  const modalTitle = document.getElementById('nas-modal-title');
  const typeSelect = document.getElementById('nas-share-type');
  const urlGroup = document.getElementById('nas-url-group');
  const pathGroup = document.getElementById('nas-path-group');
  const credsGroup = document.getElementById('nas-creds-group');
  const nameInput = document.getElementById('nas-share-name');
  const urlInput = document.getElementById('nas-share-url');
  const pathInput = document.getElementById('nas-share-path');
  const userInput = document.getElementById('nas-share-user');
  const passInput = document.getElementById('nas-share-pass');

  if (!modal || !typeSelect || !saveBtn) return;

  let editShareId = null;

  // Inline status line + Test button (created once).
  let statusEl = modal.querySelector('.nas-modal-status');
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.className = 'nas-modal-status';
    statusEl.style.cssText = 'min-height:18px;font-size:12px;margin:6px 0 2px;white-space:pre-wrap';
    saveBtn.parentElement.insertAdjacentElement('beforebegin', statusEl);
  }
  let testBtn = document.getElementById('btn-nas-modal-test');
  if (!testBtn) {
    testBtn = document.createElement('button');
    testBtn.id = 'btn-nas-modal-test';
    testBtn.className = 'btn-text';
    testBtn.textContent = 'Test';
    saveBtn.insertAdjacentElement('beforebegin', testBtn);
  }

  const setStatus = (text, kind = '') => {
    statusEl.textContent = text || '';
    statusEl.style.color = kind === 'error' ? '#ff6b6b' : kind === 'ok' ? '#51cf66' : '';
  };

  const updateTypeVisibility = () => {
    const t = typeSelect.value;
    urlGroup.style.display = t === 'webdav' ? '' : 'none';
    pathGroup.style.display = t !== 'webdav' ? '' : 'none';
    if (credsGroup) credsGroup.style.display = t === 'local' || t === 'nfs' ? 'none' : '';
  };

  // Exposed so renderNasShares can open modal in edit mode
  showNasModal = (existingShare = null) => {
    editShareId = existingShare?.id || null;
    if (modalTitle) modalTitle.textContent = editShareId ? 'Edit Share' : 'Add Share';
    nameInput.value = existingShare?.name || '';
    urlInput.value = existingShare?.url || '';
    pathInput.value = existingShare?.path || '';
    userInput.value = existingShare?.credentials?.username || '';
    passInput.value = '';
    passInput.placeholder = existingShare?.credentials?.hasPassword ? '(unchanged)' : '';
    const wanted = existingShare?.type || 'webdav';
    typeSelect.value = Array.from(typeSelect.options).some((o) => o.value === wanted) ? wanted : typeSelect.options[0]?.value;
    updateTypeVisibility();
    setStatus('');
    modal.style.display = 'flex';
    setTimeout(() => nameInput.focus(), 0);
  };

  const hideModal = () => { modal.style.display = 'none'; editShareId = null; };

  // Read + validate the form. Returns null (and shows why) when incomplete.
  const readForm = () => {
    const type = typeSelect.value;
    const url = urlInput.value.trim();
    const sharePath = pathInput.value.trim();
    const user = userInput.value.trim();
    const pass = passInput.value;
    let name = nameInput.value.trim();

    if (type === 'webdav' && !url) { setStatus('Enter the WebDAV URL, e.g. http://192.168.1.10:5005/music', 'error'); urlInput.focus(); return null; }
    if (type !== 'webdav' && !sharePath) { setStatus('Enter the path, e.g. \\\\server\\share or /mnt/nas', 'error'); pathInput.focus(); return null; }
    if (!name) {
      // A missing name should not block saving: derive one.
      name = type === 'webdav'
        ? url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0]
        : sharePath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || sharePath;
      nameInput.value = name;
    }

    const usesCreds = type === 'webdav' || type === 'smb';
    return {
      id: editShareId || ('nas-' + Date.now()),
      name,
      type,
      ...(type === 'webdav' ? { url } : { path: sharePath }),
      ...(usesCreds && (user || pass) ? { credentials: { username: user, password: pass } } : {}),
    };
  };

  if (addBtn) addBtn.onclick = () => showNasModal(null);
  if (cancelBtn) cancelBtn.onclick = hideModal;
  // Close only when the press started on the backdrop, so selecting text in a
  // field and releasing outside the dialog does not discard the form.
  let pressedOnBackdrop = false;
  modal.onmousedown = (e) => { pressedOnBackdrop = e.target === modal; };
  modal.onclick = (e) => { if (e.target === modal && pressedOnBackdrop) hideModal(); };
  modal.onkeydown = (e) => {
    if (e.key === 'Escape') hideModal();
    else if (e.key === 'Enter' && e.target.tagName === 'INPUT') saveBtn.click();
  };

  typeSelect.onchange = () => { updateTypeVisibility(); setStatus(''); };

  testBtn.onclick = async () => {
    const share = readForm();
    if (!share) return;
    testBtn.disabled = true;
    setStatus('Testing…');
    try {
      const res = await electron.nasTestShare({ shareId: editShareId, share });
      setStatus(res.message, res.ok ? 'ok' : 'error');
    } catch (err) {
      setStatus(netErrorText(err), 'error');
    } finally {
      testBtn.disabled = false;
    }
  };

  saveBtn.onclick = async () => {
    const share = readForm();
    if (!share) return;
    saveBtn.disabled = true;
    try {
      const res = await electron.nasAddShare(share);
      hideModal();
      await loadNasView();
      const saved = nasShares.find((s) => s.id === (res?.share?.id || share.id));
      if (saved) openNasShare(saved); // show its contents right away
      netNotify(`Share "${share.name}" saved`, 'success', 2500);
    } catch (err) {
      setStatus(/No handler registered/i.test(String(err))
        ? 'Network Storage plugin is not running — enable it in Settings → Plugins'
        : `Could not save: ${netErrorText(err)}`, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  };
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
