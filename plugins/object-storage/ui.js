// Object Storage UI Integration
// This script runs in the renderer process and adds UI for browsing/importing from object storage

(function(Spectra, pluginId) {
  'use strict';
  
  let storageFiles = [];
  let currentPrefix = '';
  let isConnected = false;
  let storageSettings = null;
  const selectedKeys = new Set();
  let currentPlayingKey = null;
  let currentPlayingTrack = null;

  function notify(messageOrOptions, type = 'info', options = {}) {
    const payload = typeof messageOrOptions === 'string'
      ? { message: messageOrOptions, type, ...options }
      : (messageOrOptions ? { ...messageOrOptions } : null);
    if (!payload || !payload.message) return;
    if (!payload.type && type) payload.type = type;
    if (Spectra?.ui?.notify) {
      Spectra.ui.notify(payload);
    } else if (payload.type === 'error') {
      console.error('[object-storage]', payload.message);
    } else {
      console.log('[object-storage]', payload.message);
    }
  }

  function notifySuccess(message, options = {}) {
    notify(message, 'success', { autoClose: 2600, ...options, type: 'success' });
  }

  function notifyError(message, options = {}) {
    notify(message, 'error', { autoClose: 4200, ...options, type: 'error' });
  }

  async function confirmDialog(message, options = {}) {
    if (Spectra?.ui?.confirm) {
      return Spectra.ui.confirm(message, options);
    }
    if (typeof globalThis.confirm === 'function') {
      return globalThis.confirm(message);
    }
    return false;
  }

  async function promptDialog(message, defaultValue = '') {
    if (Spectra?.ui?.prompt) {
      return Spectra.ui.prompt(message, defaultValue);
    }
    if (typeof globalThis.prompt === 'function') {
      return globalThis.prompt(message, defaultValue);
    }
    return null;
  }

  function extractStorageKeyFromTrack(track) {
    if (!track) return null;
    if (track.sourceKey) return track.sourceKey;
    const potential = track.path || track.url;
    if (typeof potential === 'string' && potential.startsWith('object-storage://')) {
      const withoutScheme = potential.slice('object-storage://'.length);
      const slashIndex = withoutScheme.indexOf('/');
      if (slashIndex >= 0) {
        const keyPart = withoutScheme.slice(slashIndex + 1);
        try { return decodeURIComponent(keyPart); } catch { return keyPart; }
      }
    }
    if (track.extra && track.extra.sourceKey) return track.extra.sourceKey;
    return null;
  }

  function getBridge() {
    if (typeof globalThis !== 'undefined' && globalThis.electron) return globalThis.electron;
    const win = typeof globalThis !== 'undefined' ? globalThis.window : undefined;
    if (win && win.electron) return win.electron;
    return null;
  }

  async function getObjectStorageSettings(force = false) {
    if (!force && storageSettings) return storageSettings;
    const bridge = getBridge();
    if (!bridge || typeof bridge.getPlugins !== 'function') return storageSettings || {};
    try {
      const plugins = await bridge.getPlugins();
      const plugin = plugins.find(x => x.id === 'object-storage');
      if (plugin && plugin.settings) {
        storageSettings = { ...(plugin.settings || {}), enabled: plugin.enabled };
      }
    } catch (err) {
      console.warn('[object-storage] failed to load settings', err);
    }
    return storageSettings || {};
  }

  function buildObjectStorageUri(key, settings) {
    if (!key) return null;
    const cfg = settings || storageSettings || {};
    if (!cfg.bucket) return null;
    const encodedKey = key
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    return `object-storage://${cfg.bucket}/${encodedKey}`;
  }

  // Load plugin styles
  function loadStyles() {
    const id = `style-${pluginId}`;
    if (document.getElementById(id)) return;
    
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `plugins://${pluginId}/styles.css`;
    document.head.appendChild(link);
  }
  
  // Add navigation item for Object Storage
  function createStorageView() {
    loadStyles();
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    // Avoid creating duplicate views/nav items if they already exist
    if (document.getElementById('view-object-storage')) return;
    
    // Create view
    const storageView = document.createElement('div');
    storageView.id = 'view-object-storage';
    storageView.className = 'view';
    storageView.style.display = 'none';
    storageView.innerHTML = `
      <div class="storage-header">
        <h2>Object Storage</h2>
        <div class="storage-actions">
          <button id="btn-storage-connect" class="btn-primary">
            <span class="material-icons">link</span> Connect
          </button>
          <button id="btn-storage-refresh" class="btn-secondary" disabled title="Refresh List">
            <span class="material-icons">refresh</span>
          </button>
          <button id="btn-storage-import-selected" class="btn-secondary" disabled title="Import Selected">
            <span class="material-icons">library_add</span> Import Selected
          </button>
          <button id="btn-storage-import-all" class="btn-secondary" disabled title="Import All">
            <span class="material-icons">playlist_add</span> Import All
          </button>
        </div>
      </div>
      
      <div class="storage-status-bar">
        <div class="status-indicator">
          <span id="storage-status-icon" class="material-icons status-icon">cloud_off</span>
          <span id="storage-status-text">Not connected</span>
        </div>
        <span id="storage-file-count" class="file-count"></span>
      </div>

      <div class="storage-now-playing" id="storage-now-playing" hidden>
        <div class="np-indicator">
          <span class="material-icons">equalizer</span>
        </div>
        <div class="np-meta">
          <div class="np-label">Now Playing</div>
          <div id="storage-now-playing-title" class="np-title"></div>
          <div id="storage-now-playing-context" class="np-context"></div>
        </div>
        <button id="btn-storage-locate-playing" class="btn-secondary" hidden>
          <span class="material-icons">my_location</span> Locate
        </button>
      </div>

      <div class="storage-controls">
        <div class="search-input-wrapper">
          <span class="material-icons">folder_open</span>
          <input type="text" id="storage-prefix" placeholder="Path prefix (e.g., albums/rock/)" />
        </div>
        <button id="btn-storage-browse" class="btn-secondary" disabled>Browse</button>
      </div>

      <div class="storage-files-container">
        <div class="track-list-header">
          <div class="col-select">
            <input type="checkbox" id="storage-select-all" aria-label="Select all files" />
          </div>
          <div class="col-icon"></div>
          <div class="col-title">File Name</div>
          <div class="col-size">Size</div>
          <div class="col-date">Last Modified</div>
          <div class="col-actions">Actions</div>
        </div>
        <div class="storage-files-list" id="storage-files-list">
          <!-- Files will be listed here -->
          <div class="empty-state">
            <span class="material-icons">cloud_queue</span>
            <p>Connect to view files</p>
          </div>
        </div>
      </div>
    `;
    
    mainContent.appendChild(storageView);
    
    // Add navigation item (only if not present)
    const sidebar = document.querySelector('.sidebar nav ul');
    if (sidebar && !document.getElementById('nav-object-storage')) {
      const navItem = document.createElement('li');
      navItem.id = 'nav-object-storage';
      navItem.innerHTML = '<span class="material-icons">cloud</span> Object Storage';
      navItem.onclick = () => switchToStorageView();
      sidebar.appendChild(navItem);
    }
    
    // Set up event listeners
    setupEventListeners();
    setupPlaybackListeners();
    // Listen for plugin-pushed updates
    const bridge = getBridge();
    if (bridge && typeof bridge.on === 'function') {
      bridge.on('object-storage:files', (files) => {
        storageFiles = Array.isArray(files) ? files : [];
        for (const key of Array.from(selectedKeys)) {
          if (!storageFiles.some((f) => f.Key === key)) selectedKeys.delete(key);
        }

        const listEl = document.getElementById('storage-files-list');
        const countEl = document.getElementById('storage-file-count');
        if (!storageFiles || storageFiles.length === 0) {
          if (listEl) listEl.innerHTML = '<div class="empty-state">No audio files found. Configure your bucket settings and ensure files exist.</div>';
        } else {
          renderFilesList(storageFiles);
        }
        if (countEl) countEl.textContent = `${storageFiles.length} files`;

        const btnRefresh = document.getElementById('btn-storage-refresh');
        const btnImportAll = document.getElementById('btn-storage-import-all');
        const btnBrowse = document.getElementById('btn-storage-browse');
        if (btnRefresh) btnRefresh.disabled = false;
        if (btnImportAll) btnImportAll.disabled = storageFiles.length === 0;
        if (btnBrowse) btnBrowse.disabled = false;

        updateSelectionUI();
        updatePlayingIndicator();
        updateNowPlayingPanel();
      });

      bridge.on('object-storage:status', (status) => {
        const statusText = document.getElementById('storage-status-text');
        const statusIcon = document.getElementById('storage-status-icon');
        
        if (!status) return;
        
        if (status.connected) {
          if (statusText) statusText.textContent = `Connected`;
          if (statusIcon) {
            statusIcon.textContent = 'cloud_done';
            statusIcon.style.color = '#4caf50';
          }
          getObjectStorageSettings(true);
          // enable controls when connected
          const btnRefresh = document.getElementById('btn-storage-refresh');
          const btnImportAll = document.getElementById('btn-storage-import-all');
          const btnBrowse = document.getElementById('btn-storage-browse');
          if (btnRefresh) btnRefresh.disabled = false;
          if (btnImportAll) btnImportAll.disabled = false;
          if (btnBrowse) btnBrowse.disabled = false;
        } else {
          if (statusText) statusText.textContent = status.message || 'Not connected';
          if (statusIcon) {
            statusIcon.textContent = 'cloud_off';
            statusIcon.style.color = '#ff6b6b';
          }
          storageSettings = null;
          // disable refresh when not connected
          const btnRefresh = document.getElementById('btn-storage-refresh');
          const btnImportAll = document.getElementById('btn-storage-import-all');
          const btnBrowse = document.getElementById('btn-storage-browse');
          if (btnRefresh) btnRefresh.disabled = true;
          if (btnImportAll) btnImportAll.disabled = true;
          if (btnBrowse) btnBrowse.disabled = true;
        }
        isConnected = !!status.connected;
      });
    }
  }
  
  function setupEventListeners() {
    const btnConnect = document.getElementById('btn-storage-connect');
    const btnRefresh = document.getElementById('btn-storage-refresh');
    const btnImportAll = document.getElementById('btn-storage-import-all');
    const btnImportSelected = document.getElementById('btn-storage-import-selected');
    const btnBrowse = document.getElementById('btn-storage-browse');
    const prefixInput = document.getElementById('storage-prefix');
    const selectAllCheckbox = document.getElementById('storage-select-all');
    
    if (btnConnect) {
      btnConnect.onclick = async () => {
        await testConnection();
      };
    }
    
    if (btnRefresh) {
      btnRefresh.onclick = async () => {
        // Request an updated file listing from the plugin and re-render
        try {
          const bridge = getBridge();
          if (!bridge || typeof bridge.objectStorageList !== 'function') {
            alert('Object Storage bridge not available');
            return;
          }
          if (!isConnected) {
            alert('Not connected. Please Connect first.');
            return;
          }
          const res = await bridge.objectStorageList();
          if (!res || !res.success) {
            console.warn('Refresh failed', res?.error);
            alert('Failed to refresh listing: ' + (res?.error || 'unknown'));
            return;
          }
          storageFiles = res.files || [];
          storageSettings = await getObjectStorageSettings(true);
          const listEl = document.getElementById('storage-files-list');
          const countEl = document.getElementById('storage-file-count');
          if (storageFiles.length === 0) {
            if (listEl) listEl.innerHTML = '<div class="empty-state">No audio files found. Configure your bucket settings and ensure files exist.</div>';
          } else {
            renderFilesList(storageFiles);
          }
          if (countEl) countEl.textContent = `${storageFiles.length} files`;
          const btnImportAll = document.getElementById('btn-storage-import-all');
          if (btnImportAll) btnImportAll.disabled = storageFiles.length === 0;
        } catch (err) {
          console.warn('Refresh failed', err);
          alert('Refresh failed: ' + (err?.message || err));
        }
      };
    }
    
    if (btnImportAll) {
      btnImportAll.onclick = async () => {
          await importAllFiles();
      };
    }

    if (btnImportSelected) {
      btnImportSelected.onclick = async () => {
        await importSelectedFiles();
      };
    }

    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', (event) => {
        if (event.target.checked) {
          for (const file of storageFiles) selectedKeys.add(file.Key);
        } else {
          selectedKeys.clear();
        }
        updateSelectionUI();
      });
    }
    
    if (btnBrowse) {
      btnBrowse.onclick = async () => {
        currentPrefix = prefixInput.value || '';
        try {
          const bridge = getBridge();
          const plugins = bridge && typeof bridge.getPlugins === 'function' ? await bridge.getPlugins() : [];
          const p = plugins.find(x => x.id === 'object-storage');
          const newSettings = { ...(p ? p.settings : {}), pathPrefix: currentPrefix };
          if (bridge && typeof bridge.updatePluginSettings === 'function') {
            await bridge.updatePluginSettings('object-storage', newSettings);
            storageSettings = { ...(storageSettings || {}), ...newSettings };
          }
        } catch (e) {
          console.warn('Browse failed', e);
        }
      };
    }
  }
  
  function switchToStorageView() {
    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.querySelectorAll('.sidebar nav li').forEach(li => li.classList.remove('active'));
    
    // Show storage view
    const storageView = document.getElementById('view-object-storage');
    if (storageView) {
      storageView.style.display = 'block';
    }
    
    const navItem = document.getElementById('nav-object-storage');
    if (navItem) {
      navItem.classList.add('active');
    }
  }
  
  function setupPlaybackListeners() {
    const playback = Spectra?.playback;
    if (!playback) return;

    try {
      const initial = typeof playback.getCurrentTrack === 'function' ? playback.getCurrentTrack() : null;
      currentPlayingTrack = initial || null;
      currentPlayingKey = extractStorageKeyFromTrack(initial);
      updatePlayingIndicator();
      updateNowPlayingPanel();
    } catch (err) {
      console.warn('[object-storage] failed to read current playback state', err);
    }

    if (typeof playback.onTrackChanged === 'function') {
      playback.onTrackChanged((track) => {
        currentPlayingTrack = track || null;
        currentPlayingKey = extractStorageKeyFromTrack(track) || null;
        updatePlayingIndicator();
        updateNowPlayingPanel();
      });
    }
  }

  async function testConnection() {
    const statusText = document.getElementById('storage-status-text');
    const btnConnect = document.getElementById('btn-storage-connect');
    
    if (statusText) statusText.textContent = 'Testing connection...';
    if (btnConnect) btnConnect.disabled = true;
    
    try {
      // Retrieve current plugin settings and save them via the existing IPC handler.
      // The plugin watches the config file and will test the connection and push
      // results back via events `object-storage:status` and `object-storage:files`.
      const bridge = getBridge();
      const plugins = await bridge?.getPlugins?.();
      const p = plugins.find(x => x.id === 'object-storage');
      if (!p) throw new Error('Object Storage plugin not found');

      if (statusText) statusText.textContent = 'Testing connection...';
      if (btnConnect) btnConnect.disabled = true;

      await bridge?.updatePluginSettings?.('object-storage', p.settings || {});
      // The plugin will emit status/files events which we listen for below.
    } catch (err) {
      isConnected = false;
      if (statusText) statusText.textContent = `Connection failed: ${err?.message || err}`;
    } finally {
      if (btnConnect) btnConnect.disabled = false;
    }
  }
  
  // Import all files with progress feedback using the global notification bar
  async function importSingleFile(file, settings, bridge) {
    if (!file) throw new Error('Missing file metadata');
    const name = (file.Key || '').split('/').pop() || file.Key || 'unknown';

    if (file.cachedPath && typeof bridge.addFiles === 'function') {
      await bridge.addFiles([file.cachedPath]);
      return true;
    }

    if (file.url && typeof bridge.addRemote === 'function') {
      const canonical = buildObjectStorageUri(file.Key, settings);
      const remoteUrl = canonical || file.url;
      const res = await bridge.addRemote({ url: remoteUrl, title: name });
      if (res && res.success) return true;
      throw new Error(res && res.error ? res.error : 'Failed to add remote track');
    }

    if (file.Key) {
      try {
        const plugins = typeof bridge.getPlugins === 'function' ? await bridge.getPlugins() : [];
        const p = plugins.find((x) => x.id === 'object-storage');
        if (p && typeof bridge.updatePluginSettings === 'function') {
          await bridge.updatePluginSettings('object-storage', p.settings || {});
        }
      } catch (err) {
        console.warn('[object-storage] cache nudge failed', err);
      }
      return true;
    }

    throw new Error('No URL or cached file available. Try Refresh/Connect.');
  }

  async function importFilesBatch(files, options = {}) {
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    if (!list.length) {
      notify('No files to import.', 'info');
      return;
    }

    const bridge = getBridge();
    if (!bridge) {
      notifyError('Electron bridge unavailable. Restart the app and try again.');
      return;
    }

    const confirmMessage = options.confirmMessage || `Import ${list.length} file${list.length === 1 ? '' : 's'} from object storage?`;
    if (!options.skipConfirm) {
      const confirmed = await confirmDialog(confirmMessage, { confirmLabel: 'Import' });
      if (!confirmed) return;
    }

    const settings = await getObjectStorageSettings();
    const notifyFn = Spectra?.ui?.notify;
    const notifyUpdateFn = Spectra?.ui?.notifyUpdate;

    if (typeof notifyFn === 'function') {
      notifyFn({
        message: options.progressMessage || 'Importing from Object Storage...',
        mode: 'progress',
        progress: 0,
        count: `0/${list.length}`,
        sticky: true,
        dismissible: false
      });
    }

    let success = 0;

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const name = (file.Key || '').split('/').pop() || file.Key || 'unknown';

      if (typeof notifyUpdateFn === 'function') {
        notifyUpdateFn({
          message: `${options.progressLabel || 'Importing'}: ${name}`,
          mode: 'progress',
          progress: ((i + 1) / list.length) * 100,
          count: `${i + 1}/${list.length}`
        });
      }

      try {
        await importSingleFile(file, settings, bridge);
        success++;
      } catch (err) {
        console.warn('[object-storage] import item failed', file?.Key, err);
      }

      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    if (typeof notifyFn === 'function') {
      notifyFn({
        message: `Import complete (${success}/${list.length})`,
        type: success === list.length ? 'success' : 'warning',
        autoClose: 2800
      });
    }

    try {
      if (typeof bridge.getLibrary === 'function') await bridge.getLibrary();
    } catch (err) {
      console.warn('Refresh library failed', err);
    }

    try {
      const plugins = typeof bridge.getPlugins === 'function' ? await bridge.getPlugins() : [];
      const p = plugins.find((x) => x.id === 'object-storage');
      if (p && typeof bridge.updatePluginSettings === 'function') {
        await bridge.updatePluginSettings('object-storage', p.settings || {});
        storageSettings = { ...(p.settings || {}) };
      }
    } catch (err) {
      console.warn('[object-storage] post-import refresh failed', err);
    }

    if (!options.preserveSelection) {
      selectedKeys.clear();
      updateSelectionUI();
    }
  }

  async function importAllFiles() {
    await importFilesBatch(storageFiles, {
      confirmMessage: `Import ${storageFiles.length} file${storageFiles.length === 1 ? '' : 's'} from object storage?`,
      progressMessage: 'Importing from Object Storage...',
      progressLabel: 'Importing'
    });
  }

  async function importSelectedFiles() {
    const files = storageFiles.filter((f) => selectedKeys.has(f.Key));
    if (!files.length) {
      notify('Select at least one file to import.', 'info');
      return;
    }
    await importFilesBatch(files, {
      confirmMessage: `Import ${files.length} selected file${files.length === 1 ? '' : 's'}?`,
      progressMessage: 'Importing selected files',
      progressLabel: 'Importing'
    });
  }
  
  function renderFilesList(files) {
    const listEl = document.getElementById('storage-files-list');
    if (!listEl) return;

    listEl.innerHTML = '';

    if (!files || files.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No audio files found. Configure your bucket settings and ensure files exist.</div>';
      updateSelectionUI();
      updatePlayingIndicator();
      updateNowPlayingPanel();
      return;
    }

    for (const file of files) {
      const row = document.createElement('div');
      row.className = 'storage-file-row';
      row.dataset.key = file.Key;

      const fileName = (file.Key || '').split('/').pop() || file.Key || 'unknown';
      const size = formatBytes(file.Size);
      const modified = file.LastModified ? new Date(file.LastModified).toLocaleString() : '';
      const isSelected = selectedKeys.has(file.Key);
      const isPlaying = currentPlayingKey === file.Key;

      if (isSelected) row.classList.add('selected');
      if (isPlaying) row.classList.add('playing');

      const selectCol = document.createElement('div');
      selectCol.className = 'col-select';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'storage-select';
      checkbox.dataset.key = file.Key;
      checkbox.checked = isSelected;
      checkbox.setAttribute('aria-label', `Select ${fileName}`);
      selectCol.appendChild(checkbox);

      const iconCol = document.createElement('div');
      iconCol.className = 'col-icon';
      const icon = document.createElement('span');
      icon.className = 'material-icons';
      icon.textContent = isPlaying ? 'equalizer' : 'audio_file';
      iconCol.appendChild(icon);

      const titleCol = document.createElement('div');
      titleCol.className = 'col-title';
      titleCol.title = file.Key;
      titleCol.textContent = fileName;

      const sizeCol = document.createElement('div');
      sizeCol.className = 'col-size';
      sizeCol.textContent = size;

      const dateCol = document.createElement('div');
      dateCol.className = 'col-date';
      dateCol.textContent = modified;

      const actionsCol = document.createElement('div');
      actionsCol.className = 'col-actions';

      const playBtn = document.createElement('button');
      playBtn.className = 'btn-icon';
      playBtn.title = 'Play Stream';
      const playIcon = document.createElement('span');
      playIcon.className = 'material-icons';
      playIcon.textContent = 'play_arrow';
      playBtn.appendChild(playIcon);
      playBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (typeof globalThis.playStorageFile === 'function') {
          globalThis.playStorageFile(file.Key);
        }
      });

      const importBtn = document.createElement('button');
      importBtn.className = 'btn-icon';
      importBtn.title = 'Add to Library';
      const importIcon = document.createElement('span');
      importIcon.className = 'material-icons';
      importIcon.textContent = 'playlist_add';
      importBtn.appendChild(importIcon);
      importBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (typeof globalThis.importStorageFile === 'function') {
          await globalThis.importStorageFile(file.Key);
        }
      });

      actionsCol.appendChild(playBtn);
      actionsCol.appendChild(importBtn);

      row.appendChild(selectCol);
      row.appendChild(iconCol);
      row.appendChild(titleCol);
      row.appendChild(sizeCol);
      row.appendChild(dateCol);
      row.appendChild(actionsCol);

      checkbox.addEventListener('change', (event) => {
        event.stopPropagation();
        if (event.target.checked) selectedKeys.add(file.Key);
        else selectedKeys.delete(file.Key);
        updateSelectionUI();
      });

      row.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && (event.target.closest('.col-actions') || event.target.closest('.col-select'))) {
          return;
        }
        if (selectedKeys.has(file.Key)) selectedKeys.delete(file.Key);
        else selectedKeys.add(file.Key);
        updateSelectionUI();
      });

      listEl.appendChild(row);
    }

    updateSelectionUI();
    updatePlayingIndicator();
    updateNowPlayingPanel();
  }

  function updateSelectionUI() {
    const importSelectedBtn = document.getElementById('btn-storage-import-selected');
    if (importSelectedBtn) importSelectedBtn.disabled = selectedKeys.size === 0;

    const selectAll = document.getElementById('storage-select-all');
    if (selectAll) {
      const total = storageFiles.length;
      const selected = selectedKeys.size;
      selectAll.checked = total > 0 && selected === total;
      selectAll.indeterminate = selected > 0 && selected < total;
    }

    const listEl = document.getElementById('storage-files-list');
    if (!listEl) return;
    listEl.querySelectorAll('.storage-file-row').forEach((row) => {
      const key = row.dataset.key;
      const isSelected = key ? selectedKeys.has(key) : false;
      row.classList.toggle('selected', isSelected);
      const checkbox = row.querySelector('input.storage-select');
      if (checkbox) checkbox.checked = isSelected;
    });
  }

  function updatePlayingIndicator() {
    const listEl = document.getElementById('storage-files-list');
    if (!listEl) return;
    listEl.querySelectorAll('.storage-file-row').forEach((row) => {
      const key = row.dataset.key;
      const isPlaying = key && key === currentPlayingKey;
      row.classList.toggle('playing', isPlaying);
      const icon = row.querySelector('.col-icon .material-icons');
      if (icon) icon.textContent = isPlaying ? 'equalizer' : 'audio_file';
    });
  }

  function updateNowPlayingPanel() {
    const panel = document.getElementById('storage-now-playing');
    if (!panel) return;
    if (!currentPlayingKey) {
      panel.hidden = true;
      return;
    }

    const titleEl = document.getElementById('storage-now-playing-title');
    const contextEl = document.getElementById('storage-now-playing-context');
    const locateBtn = document.getElementById('btn-storage-locate-playing');
    const match = storageFiles.find((f) => f.Key === currentPlayingKey);
    const displayName = currentPlayingTrack?.title || (match ? match.Key.split('/').pop() : currentPlayingKey.split('/').pop() || currentPlayingKey);

    if (titleEl) titleEl.textContent = displayName || currentPlayingKey;
    if (contextEl) {
      contextEl.textContent = match
        ? `In current list • ${match.Key}`
        : 'Playing from object storage (outside current prefix)';
    }
    if (locateBtn) {
      if (match) {
        locateBtn.hidden = false;
        locateBtn.onclick = () => scrollToStorageKey(currentPlayingKey);
      } else {
        locateBtn.hidden = true;
        locateBtn.onclick = null;
      }
    }

    panel.hidden = false;
  }

  function scrollToStorageKey(key) {
    if (!key) return;
    const listEl = document.getElementById('storage-files-list');
    if (!listEl) return;
    const selector = `.storage-file-row[data-key="${escapeSelector(key)}"]`;
    const row = listEl.querySelector(selector);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('selected');
    }
  }

  function escapeSelector(value) {
    const str = String(value);
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(str);
    }
    let escaped = '';
    for (const ch of str) {
      if (ch === '"' || ch === "'" || ch === '\\') escaped += `\\${ch}`;
      else escaped += ch;
    }
    return escaped;
  }
  
  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }
  
  
  
  // Make functions available globally for inline onclick handlers
  globalThis.playStorageFile = async function(key) {
    const bridge = getBridge();
    if (!bridge || typeof bridge.playTrack !== 'function') {
      notifyError('Playback bridge not available. Try restarting the app.');
      return;
    }
    try {
      const file = storageFiles.find((f) => f.Key === key) || {};
      const settings = await getObjectStorageSettings();
      let playbackPath = buildObjectStorageUri(file.Key, settings);

      if (!playbackPath && file.cachedPath) playbackPath = file.cachedPath;

      if (!playbackPath && file.Key && typeof bridge.objectStorageGetUrl === 'function') {
        try {
          const res = await bridge.objectStorageGetUrl(file.Key);
          if (res?.path) playbackPath = res.path;
          else if (res?.url) playbackPath = res.url;
        } catch (err) {
          console.warn('[object-storage] get-url failed', err);
        }
      }

      if (!playbackPath && file.url) playbackPath = file.url;

      if (!playbackPath) {
        notifyError('No playable URL available for this file. Try Refresh/Connect.');
        return;
      }

      const title = key.split('/').pop() || key;
      const trackInfo = { title, path: playbackPath, sourceKey: file.Key };
      await bridge.playTrack(playbackPath, { track: trackInfo });
      currentPlayingTrack = trackInfo;
      currentPlayingKey = file.Key || currentPlayingKey;
      updatePlayingIndicator();
      updateNowPlayingPanel();
    } catch (err) {
      notifyError(`Failed to play: ${err?.message || err}`);
    }
  };

  // Add right-click helper to offer "Add to Object Storage" for local library items
  // We attach a capture listener so plugin can offer upload without modifying core files.
  function installRightClickUploader() {
    const bridge = getBridge();
    if (!bridge || typeof bridge.on !== 'function') return;

    bridge.on('object-storage:request-upload', async (_event, tracks) => {
      if (!Array.isArray(tracks) || tracks.length === 0) return;

      const track = tracks[0];
      const localPath = track?.path;
      if (!localPath) return;

      const defaultKey = localPath.split(/[/\\]/).pop();
      const destKey = await promptDialog(`Upload "${defaultKey}" to Object Storage?\n\nEnter destination key (path inside bucket):`, defaultKey);
      if (!destKey) return;

      try {
        const uploadResult = await bridge.objectStorageUpload?.(localPath, destKey);
        if (!uploadResult?.success) {
          notifyError(`Upload failed: ${uploadResult?.error || 'unknown error'}`);
          return;
        }

        notifySuccess(`Upload succeeded: ${uploadResult.key}`);

        const addNow = await confirmDialog('Add uploaded file to library as a remote track?', { confirmLabel: 'Add' });
        if (addNow) {
          try {
            let bucket = 'unknown';
            try {
              const plugins = await bridge.getPlugins?.();
              const plugin = Array.isArray(plugins) ? plugins.find((x) => x.id === 'object-storage') : null;
              bucket = plugin?.settings?.bucket || bucket;
            } catch (settingsErr) {
              console.warn('[object-storage] failed to read bucket settings', settingsErr);
            }

            const title = defaultKey;
            const uri = `object-storage://${bucket}/${uploadResult.key}`;
            const addResponse = await bridge.addRemote?.({ url: uri, title });
            if (addResponse?.success) notifySuccess('Uploaded file added to library.');
            else notifyError(`Failed to add uploaded file to library: ${addResponse?.error || 'unknown error'}`);
          } catch (libraryErr) {
            console.warn('[object-storage] addRemote failed', libraryErr);
            notifyError('Failed to add uploaded file to library.');
          }
        }

        try {
          const plugins = await bridge.getPlugins?.();
          const plugin = Array.isArray(plugins) ? plugins.find((x) => x.id === 'object-storage') : null;
          if (plugin && typeof bridge.updatePluginSettings === 'function') {
            await bridge.updatePluginSettings('object-storage', plugin.settings || {});
          }
        } catch (refreshErr) {
          console.warn('[object-storage] refresh after upload failed', refreshErr);
        }
      } catch (err) {
        console.error('[object-storage] upload failed', err);
        notifyError(`Upload failed: ${err?.message || err}`);
      }
    });
  }

  // Install uploader overlay after DOM ready
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installRightClickUploader); else installRightClickUploader();
  
  globalThis.importStorageFile = async function(key) {
    try {
      const bridge = getBridge();
      if (!bridge) {
        notifyError('Electron bridge unavailable. Restart the app and try again.');
        return;
      }
      const settings = await getObjectStorageSettings();
      const file = storageFiles.find(f => f.Key === key) || {};
      // Prefer cachedPath for importing (local copy). If none, fall back to asking
      // the user to download via the main download flow.
      if (file.cachedPath) {
        if (typeof bridge.addFiles === 'function') {
          await bridge.addFiles([file.cachedPath]);
        }
        notifySuccess('Imported cached file to library.');
      } else if (file.url) {
        // Add remote reference to library without downloading
        try {
          const canonical = buildObjectStorageUri(file.Key, settings);
          const remoteUrl = canonical || file.url;
          const res = typeof bridge.addRemote === 'function'
            ? await bridge.addRemote({ url: remoteUrl, title: key.split('/').pop() })
            : null;
          if (res?.success) {
            notifySuccess('Added remote track to library.');
          } else {
            notifyError(`Failed to add remote track: ${res?.error || 'unknown'}`);
          }
        } catch (error_) {
          notifyError(`Failed to add remote track: ${error_?.message || error_}`);
        }
      } else {
        notifyError('No URL or cached file available. Try Refresh/Connect.');
      }
    } catch (err) {
      notifyError(`Failed to import: ${err?.message || err}`);
    }
  };
  
  // Register this plugin to attach to the application's main content area.
  // When the app adds `.main-content`, our init function will run and return
  // the created nodes and the global functions we expose so the renderer can
  // clean them up when the plugin is disabled/unloaded.
  try {
    if (Spectra && Spectra.ui && typeof Spectra.ui.registerTarget === 'function') {
      Spectra.ui.registerTarget('object-storage', '.main-content', () => {
        // If view already exists, return it so we don't duplicate
        if (document.getElementById('view-object-storage')) return { nodes: [document.getElementById('view-object-storage')] };
        // create view inside provided container
        createStorageView();
        const view = document.getElementById('view-object-storage');
        const nav = document.getElementById('nav-object-storage');

        // Expose helpers under Spectra.plugins for safer cleanup
        try {
          if (!Spectra.plugins) Spectra.plugins = {};
          if (!Spectra.plugins['object-storage']) Spectra.plugins['object-storage'] = {};
          Spectra.plugins['object-storage'].playStorageFile = globalThis.playStorageFile;
          Spectra.plugins['object-storage'].importStorageFile = globalThis.importStorageFile;
        } catch {}

        const globals = [];
        if (globalThis.playStorageFile) globals.push('playStorageFile');
        if (globalThis.importStorageFile) globals.push('importStorageFile');

        const nodes = [];
        if (view) nodes.push(view);
        if (nav) nodes.push(nav);

        return { nodes, globals };
      });
    } else {
      // Fallback: attach immediately if registerTarget not available
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createStorageView);
      } else {
        createStorageView();
      }
    }
  } catch {
    // No Spectra UI available — fallback to immediate attach
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', createStorageView);
    } else {
      createStorageView();
    }
  }
  
})(window.Spectra, 'object-storage');
