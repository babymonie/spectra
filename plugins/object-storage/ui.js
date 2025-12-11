// Object Storage UI Integration
// This script runs in the renderer process and adds UI for browsing/importing from object storage

(function(Spectra, pluginId) {
  'use strict';
  
  let storageFiles = [];
  let currentPrefix = '';
  let isConnected = false;
  let storageSettings = null;

  function getBridge() {
    if (typeof globalThis !== 'undefined' && globalThis.electron) return globalThis.electron;
    if (typeof window !== 'undefined' && window.electron) return window.electron;
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

      <div class="storage-controls">
        <div class="search-input-wrapper">
          <span class="material-icons">folder_open</span>
          <input type="text" id="storage-prefix" placeholder="Path prefix (e.g., albums/rock/)" />
        </div>
        <button id="btn-storage-browse" class="btn-secondary" disabled>Browse</button>
      </div>

      <div class="storage-files-container">
        <div class="track-list-header">
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
    // Listen for plugin-pushed updates
    if (window.electron && window.electron.on) {
      window.electron.on('object-storage:files', (files) => {
        storageFiles = files || [];
        const listEl = document.getElementById('storage-files-list');
        const countEl = document.getElementById('storage-file-count');
        if (!storageFiles || storageFiles.length === 0) {
          if (listEl) listEl.innerHTML = '<div class="empty-state">No audio files found. Configure your bucket settings and ensure files exist.</div>';
        } else {
          renderFilesList(storageFiles);
        }
        if (countEl) countEl.textContent = `${storageFiles.length} files`;
        // enable import/refresh controls when files returned
        const btnRefresh = document.getElementById('btn-storage-refresh');
        const btnImportAll = document.getElementById('btn-storage-import-all');
        const btnBrowse = document.getElementById('btn-storage-browse');
        if (btnRefresh) btnRefresh.disabled = false;
        if (btnImportAll) btnImportAll.disabled = storageFiles.length === 0;
        if (btnBrowse) btnBrowse.disabled = false;
      });

      window.electron.on('object-storage:status', (status) => {
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
    const btnBrowse = document.getElementById('btn-storage-browse');
    const prefixInput = document.getElementById('storage-prefix');
    
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
  
  async function testConnection() {
    const statusText = document.getElementById('storage-status-text');
    const btnConnect = document.getElementById('btn-storage-connect');
    
    if (statusText) statusText.textContent = 'Testing connection...';
    if (btnConnect) btnConnect.disabled = true;
    
    try {
      // Retrieve current plugin settings and save them via the existing IPC handler.
      // The plugin watches the config file and will test the connection and push
      // results back via events `object-storage:status` and `object-storage:files`.
      const plugins = await window.electron.getPlugins();
      const p = plugins.find(x => x.id === 'object-storage');
      if (!p) throw new Error('Object Storage plugin not found');

      if (statusText) statusText.textContent = 'Testing connection...';
      if (btnConnect) btnConnect.disabled = true;

      await window.electron.updatePluginSettings('object-storage', p.settings || {});
      // The plugin will emit status/files events which we listen for below.
    } catch (err) {
      isConnected = false;
      if (statusText) statusText.textContent = `Connection failed: ${err && err.message ? err.message : err}`;
    } finally {
      if (btnConnect) btnConnect.disabled = false;
    }
  }
  
  // Import all files with progress feedback using the global notification bar
  async function importAllFiles() {
    if (storageFiles.length === 0) {
      alert('No files to import');
      return;
    }
    if (!confirm(`Import ${storageFiles.length} files from object storage?`)) return;

    const bridge = getBridge();
    if (!bridge) {
      alert('Electron bridge unavailable. Restart the app and try again.');
      return;
    }

    const notif = document.getElementById('notification-bar');
    const msg = document.getElementById('notification-message');
    const prog = document.getElementById('notification-progress');
    const cnt = document.getElementById('notification-count');
    const settings = await getObjectStorageSettings();

    if (notif) notif.classList.add('show');
    if (msg) msg.textContent = 'Importing from Object Storage...';
    if (prog) prog.style.width = '0%';
    if (cnt) cnt.textContent = `0/${storageFiles.length}`;

    let success = 0;
    for (let i = 0; i < storageFiles.length; i++) {
      const f = storageFiles[i];
      const name = (f.Key || '').split('/').pop() || f.Key || 'unknown';
      try {
        if (msg) msg.textContent = `Importing: ${name}`;
        // Prefer cachedPath (local file) so we can add as local file and get full metadata
        if (f.cachedPath) {
          if (typeof bridge.addFiles === 'function') {
            await bridge.addFiles([f.cachedPath]);
          }
        } else if (f.url) {
          const canonical = buildObjectStorageUri(f.Key, settings);
          const remoteUrl = canonical || f.url;
          if (typeof bridge.addRemote === 'function') {
            await bridge.addRemote({ url: remoteUrl, title: name });
          }
        } else if (f.Key) {
          // Try requesting plugin to download to cache via existing API: call plugins:update-settings to nudge plugin
          try {
            const plugins = (typeof bridge.getPlugins === 'function') ? await bridge.getPlugins() : [];
            const p = plugins.find(x => x.id === 'object-storage');
            if (p && typeof bridge.updatePluginSettings === 'function') {
              await bridge.updatePluginSettings('object-storage', p.settings || {});
            }
          } catch (err) {
            console.warn('[object-storage] cache nudge failed', err);
          }
        }
        success++;
      } catch (err) {
        console.warn('[object-storage] import item failed', f.Key, err);
      }

      // update progress
      const percent = Math.round(((i + 1) / storageFiles.length) * 100);
      if (prog) prog.style.width = `${percent}%`;
      if (cnt) cnt.textContent = `${i + 1}/${storageFiles.length}`;
      // brief pause to keep UI responsive for large batches
      await new Promise(r => setTimeout(r, 50));
    }

    if (msg) msg.textContent = `Import complete (${success}/${storageFiles.length})`;
    if (prog) prog.style.width = '100%';
    // allow UI to show completion then hide and refresh library
    setTimeout(async () => {
      if (notif) notif.classList.remove('show');
      try { if (typeof bridge.getLibrary === 'function') await bridge.getLibrary(); } catch (err) { console.warn('Refresh library failed', err); }
      // nudge plugin to refresh listing after import
      try {
        const plugins = typeof bridge.getPlugins === 'function' ? await bridge.getPlugins() : [];
        const p = plugins.find(x => x.id === 'object-storage');
        if (p && typeof bridge.updatePluginSettings === 'function') {
          await bridge.updatePluginSettings('object-storage', p.settings || {});
          storageSettings = { ...(p.settings || {}) };
        }
      } catch (err) {
        console.warn('[object-storage] post-import refresh failed', err);
      }
    }, 1200);
  }
  
  function renderFilesList(files) {
    const listEl = document.getElementById('storage-files-list');
    if (!listEl) return;
    
    listEl.innerHTML = '';
    
    files.forEach(file => {
      const row = document.createElement('div');
      row.className = 'storage-file-row';
      
      const fileName = file.Key.split('/').pop();
      const size = formatBytes(file.Size);
      const modified = new Date(file.LastModified).toLocaleDateString();
      
      row.innerHTML = `
        <div class="col-icon"><span class="material-icons">audio_file</span></div>
        <div class="col-title" title="${file.Key}">${fileName}</div>
        <div class="col-size">${size}</div>
        <div class="col-date">${modified}</div>
        <div class="col-actions">
          <button class="btn-icon" onclick="playStorageFile('${file.Key}')" title="Play Stream">
            <span class="material-icons">play_arrow</span>
          </button>
          <button class="btn-icon" onclick="importStorageFile('${file.Key}')" title="Add to Library">
            <span class="material-icons">playlist_add</span>
          </button>
        </div>
      `;
      
      listEl.appendChild(row);
    });
  }
  
  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }
  
  
  
  // Make functions available globally for inline onclick handlers
  window.playStorageFile = async function(key) {
    const bridge = getBridge();
    if (!bridge || typeof bridge.playTrack !== 'function') {
      alert('Playback bridge not available. Try restarting the app.');
      return;
    }
    try {
      const file = storageFiles.find(f => f.Key === key) || {};
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
        alert('No playable URL available for this file. Try Refresh/Connect.');
        return;
      }

      const title = (key.split('/').pop() || key);
      const trackInfo = { title, path: playbackPath, sourceKey: file.Key };
      await bridge.playTrack(playbackPath, { track: trackInfo });
    } catch (err) {
      alert(`Failed to play: ${err?.message || err}`);
    }
  };

  // Add right-click helper to offer "Add to Object Storage" for local library items
  // We attach a capture listener so plugin can offer upload without modifying core files.
  function installRightClickUploader() {
    // Listen for upload request from main process (triggered by context menu)
    window.electron.on && window.electron.on('object-storage:request-upload', async (event, tracks) => {
      if (!tracks || tracks.length === 0) return;
      
      // For now, just handle the first track to keep UI simple, or loop through them
      // The prompt-based flow is best for single files. For multiple, we might want a different UI.
      // Let's handle one by one or just the first one for now as per previous behavior.
      
      const track = tracks[0];
      const localPath = track.path;
      if (!localPath) return;

      try {
        // Default destination key: basename
        const defaultKey = localPath.split(/[/\\]/).pop();
        const destKey = prompt(`Upload "${defaultKey}" to Object Storage?\n\nEnter destination key (path inside bucket):`, defaultKey);
        if (!destKey) return; // User cancelled

        // Call preload-exposed IPC to upload
        const res = await window.electron.objectStorageUpload(localPath, destKey);
        if (res && res.success) {
          alert('Upload succeeded: ' + res.key);
          // Optionally add uploaded file to library as remote (use canonical URI)
          const addNow = confirm('Add uploaded file to library as a remote track?');
          if (addNow) {
            try {
              // Get bucket from settings to construct canonical URI
              let bucket = 'unknown';
              try {
                const plugins = await window.electron.getPlugins();
                const p = plugins.find(x => x.id === 'object-storage');
                if (p && p.settings && p.settings.bucket) {
                  bucket = p.settings.bucket;
                }
              } catch (e) { console.warn('Failed to get bucket settings', e); }

              const title = defaultKey;
              // Use canonical URI: object-storage://bucket/key
              const uri = `object-storage://${bucket}/${res.key}`;
              
              const r = await window.electron.addRemote({ url: uri, title });
              if (r && r.success) alert('Added uploaded file to library');
              else alert('Failed to add uploaded file to library');
            } catch (err) { console.warn('addRemote failed', err); alert('Failed to add uploaded file to library'); }
          }
          
          // signal plugin to refresh listing
          try { const plugins = await window.electron.getPlugins(); const p = plugins.find(x => x.id === 'object-storage'); if (p) await window.electron.updatePluginSettings('object-storage', p.settings || {}); } catch (e) {}
        } else {
          alert('Upload failed: ' + (res && res.error ? res.error : 'unknown'));
        }
      } catch (err) {
        console.error('Upload failed', err);
        alert('Upload failed: ' + (err && err.message ? err.message : err));
      }
    });
  }

  // Install uploader overlay after DOM ready
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installRightClickUploader); else installRightClickUploader();
  
  window.importStorageFile = async function(key) {
    try {
      const bridge = getBridge();
      if (!bridge) {
        alert('Electron bridge unavailable. Restart the app and try again.');
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
        alert('Imported cached file to library.');
      } else if (file.url) {
        // Add remote reference to library without downloading
        try {
          const canonical = buildObjectStorageUri(file.Key, settings);
          const remoteUrl = canonical || file.url;
          const res = typeof bridge.addRemote === 'function'
            ? await bridge.addRemote({ url: remoteUrl, title: key.split('/').pop() })
            : null;
          if (res && res.success) {
            alert('Added remote track to library.');
          } else {
            alert('Failed to add remote track: ' + (res && res.error ? res.error : 'unknown'));
          }
        } catch (error_) {
          alert('Failed to add remote track: ' + (error_?.message || error_));
        }
      } else {
        alert('No URL or cached file available. Try Refresh/Connect.');
      }
    } catch (err) {
      alert(`Failed to import: ${err.message}`);
    }
  };
  
  // Register this plugin to attach to the application's main content area.
  // When the app adds `.main-content`, our init function will run and return
  // the created nodes and the global functions we expose so the renderer can
  // clean them up when the plugin is disabled/unloaded.
  try {
    if (Spectra && Spectra.ui && typeof Spectra.ui.registerTarget === 'function') {
      Spectra.ui.registerTarget('object-storage', '.main-content', (mainContent, pid) => {
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
          Spectra.plugins['object-storage'].playStorageFile = window.playStorageFile;
          Spectra.plugins['object-storage'].importStorageFile = window.importStorageFile;
        } catch (e) {}

        const globals = [];
        if (window.playStorageFile) globals.push('playStorageFile');
        if (window.importStorageFile) globals.push('importStorageFile');

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
  } catch (e) {
    // No Spectra UI available — fallback to immediate attach
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', createStorageView);
    } else {
      createStorageView();
    }
  }
  
})(window.Spectra, 'object-storage');
