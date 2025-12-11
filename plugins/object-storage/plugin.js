// object-storage plugin.js
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { ipcMain } from 'electron';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'fs';
import { mkdir, access, stat, readdir, unlink, readFile } from 'fs/promises';
import { join, basename, extname, dirname } from 'path';
import { pipeline } from 'stream/promises';
import { app, BrowserWindow } from 'electron';
import { Readable } from 'stream';

let s3Client = null;
let settings = {};
let syncInterval = null;
let cachePath = null;
let isInitialized = false;
let remoteBroadcast = null;

// Supported audio formats
const AUDIO_FORMATS = ['.flac', '.wav', '.mp3', '.aac', '.ogg', '.m4a', '.alac', '.wma', '.dsf', '.dff', '.ape', '.aiff'];

function extractKeyFromUrl(url) {
  if (!url || typeof url !== 'string' || !settings.endpoint) return null;
  try {
    const endpointUrl = new URL(settings.endpoint);
    const incoming = new URL(url);

    let bucketFromUrl = null;
    let keyPart = '';

    if (incoming.host === endpointUrl.host) {
      // Path-style: endpoint host matches; bucket is first path segment
      let pathPart = incoming.pathname || '';
      if (pathPart.startsWith('/')) pathPart = pathPart.slice(1);
      if (!pathPart) return null;
      const segments = pathPart.split('/');
      bucketFromUrl = segments.shift();
      keyPart = segments.join('/');
    } else if (incoming.host.endsWith(`.${endpointUrl.host}`)) {
      // Virtual-host style: bucket in hostname, key in path
      bucketFromUrl = incoming.host.substring(0, incoming.host.length - endpointUrl.host.length - 1);
      keyPart = incoming.pathname.startsWith('/') ? incoming.pathname.slice(1) : incoming.pathname;
    } else {
      return null;
    }

    if (!keyPart) return null;

    const decodedKey = decodeURIComponent(keyPart);
    if (bucketFromUrl && settings.bucket && bucketFromUrl !== settings.bucket) {
      console.warn(`[object-storage] URL bucket '${bucketFromUrl}' differs from configured bucket '${settings.bucket}'.`);
    }
    return decodedKey;
  } catch (err) {
    console.warn('[object-storage] Failed to parse object-storage URL:', err?.message ?? err);
    return null;
  }
}

export function activate(context) {
  console.log('[object-storage] Activating...');
  settings = context.settings || {};
  remoteBroadcast = typeof context.broadcast === 'function' ? context.broadcast : null;
  
  // Set up cache directory
  const userDataPath = app.getPath('userData');
  cachePath = join(userDataPath, 'object-storage-cache');
  
  initializeClient();
  // Start watching config so UI requests (which update settings) will trigger actions
  watchPluginConfig();
  // Try an initial listing if already initialized
  (async () => {
    try {
      if (isInitialized) {
        const objects = await listObjects('');
        pushFilesToRenderers(objects);
        pushStatusToRenderers({ connected: true, count: objects.length });
      }
    } catch (e) {
      pushStatusToRenderers({ connected: false, message: e?.message || String(e) });
    }
  })();
  
  // Start auto-sync if enabled
  if (settings.autoSync && settings.syncInterval > 0) {
    startAutoSync();
  }
  
  console.log('[object-storage] Plugin activated');

  const handleUpload = async (localPath, destKey) => {
    if (!localPath) return { success: false, error: 'missing localPath' };
    if (!isInitialized) return { success: false, error: 'object-storage not initialized (check credentials)' };
    try {
      // Default key: basename of file if not provided
      const key = destKey && String(destKey).trim() ? destKey : join(settings.pathPrefix || '', basename(localPath)).replace(/\\/g, '/');

      // Use high-level Upload helper for multipart when needed
      const fileStream = createReadStream(localPath);
      const uploadParams = {
        Bucket: settings.bucket,
        Key: key,
        Body: fileStream,
      };

      const uploader = new Upload({ client: s3Client, params: uploadParams });
      await uploader.done();

      // Generate a presigned URL for immediate use (short-lived)
      let url = null;
      try { url = await getPresignedUrl(key, 3600); } catch { url = null; }

      // Optionally notify renderers to refresh listing
      pushStatusToRenderers({ uploaded: true, key });
      return { success: true, key, url };
    } catch (err) {
      console.error('[object-storage] upload failed', err);
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  };

  // Register IPC to allow renderer to request uploading a local file to object storage
  try {
    ipcMain.handle('object-storage:upload', (event, localPath, destKey) => handleUpload(localPath, destKey));
    
    if (context.registerRemoteHandler) {
      context.registerRemoteHandler('object-storage:upload', handleUpload);
    }
    // Provide an IPC handler to request a presigned URL or cached path for a key
    const handleGetUrl = async (event, key) => {
      try {
        if (!key) return { error: 'missing key' };
        if (!isInitialized) return { error: 'object-storage not initialized' };
        if (settings.cacheFiles) {
          // Return local cached path (download if needed)
          const local = await downloadToCache(key);
          return { path: local };
        }
        const url = await getPresignedUrl(key);
        return { url };
      } catch (err) {
        console.error('[object-storage] get-url failed', err);
        return { error: String(err && err.message ? err.message : err) };
      }
    };

    ipcMain.handle('object-storage:get-url', (event, key) => handleGetUrl(event, key));
    if (context.registerRemoteHandler) {
      context.registerRemoteHandler('object-storage:get-url', handleGetUrl);
    }
    // Provide an IPC handler to list objects (enhanced) on demand for renderer refresh
    const handleList = async (event, prefix = '') => {
      try {
        const objects = await listObjects(prefix || '');
        // Build enhanced list (presigned URLs or cached info) without forcing downloads
        const enhanced = [];
        for (const o of (objects || [])) {
          try {
            let presigned = null;
            try { presigned = await getPresignedUrl(o.Key); } catch { presigned = null; }

            let cachedPath = null;
            if (settings.cacheFiles && cachePath) {
              try {
                const localName = basename(o.Key);
                const localPath = join(cachePath, localName);
                await access(localPath);
                cachedPath = localPath;
              } catch {
                cachedPath = null;
              }
            }

            enhanced.push({ Key: o.Key, Size: o.Size, LastModified: o.LastModified, url: presigned, cachedPath });
          } catch {
            enhanced.push({ Key: o.Key, Size: o.Size, LastModified: o.LastModified, url: null });
          }
        }

        return { success: true, files: enhanced };
      } catch (err) {
        return { success: false, error: String(err && err.message ? err.message : err) };
      }
    };

    ipcMain.handle('object-storage:list', (event, prefix) => handleList(event, prefix));
    if (context.registerRemoteHandler) {
      context.registerRemoteHandler('object-storage:list', handleList);
    }
  } catch (e) {
    console.warn('[object-storage] failed to register ipc upload handler', e);
  }
}

export function deactivate() {
  console.log('[object-storage] Deactivating...');
  
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  
  s3Client = null;
  isInitialized = false;
  remoteBroadcast = null;

  try {
    if (typeof ipcMain.removeHandler === 'function') {
      ipcMain.removeHandler('object-storage:upload');
    }
  } catch {}
  try {
    if (typeof ipcMain.removeHandler === 'function') {
      ipcMain.removeHandler('object-storage:get-url');
    }
  } catch {}
  try {
    if (typeof ipcMain.removeHandler === 'function') {
      ipcMain.removeHandler('object-storage:list');
    }
  } catch {}
  
  console.log('[object-storage] Plugin deactivated');
}

function initializeClient() {
  if (!settings.accessKeyId || !settings.secretAccessKey) {
    console.warn('[object-storage] Missing credentials. Please configure in settings.');
    isInitialized = false;
    return;
  }
  
  try {
    const clientConfig = {
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      region: settings.region || 'us-east-1',
    };
    
    // Add custom endpoint for Minio, S3-compatible services
    if (settings.endpoint && settings.endpoint !== '') {
      clientConfig.endpoint = settings.endpoint;
      clientConfig.forcePathStyle = true; // Required for Minio
    }
    
    s3Client = new S3Client(clientConfig);
    isInitialized = true;
    console.log('[object-storage] S3 client initialized');
  } catch (err) {
    console.error('[object-storage] Failed to initialize S3 client:', err);
    isInitialized = false;
  }
}

async function ensureCacheDir() {
  try {
    await mkdir(cachePath, { recursive: true });
  } catch (err) {
    console.error('[object-storage] Failed to create cache directory:', err);
  }
}

async function listObjects(prefix = '') {
  if (!isInitialized || !s3Client) {
    throw new Error('S3 client not initialized. Please check your settings.');
  }
  
  const fullPrefix = settings.pathPrefix 
    ? join(settings.pathPrefix, prefix).replace(/\\/g, '/')
    : prefix;
  
  try {
    const command = new ListObjectsV2Command({
      Bucket: settings.bucket,
      Prefix: fullPrefix,
    });
    
    const response = await s3Client.send(command);
    const objects = response.Contents || [];
    
    // Filter only audio files
    return objects.filter(obj => {
      const ext = extname(obj.Key).toLowerCase();
      return AUDIO_FORMATS.includes(ext);
    });
  } catch (err) {
    console.error('[object-storage] Failed to list objects:', err);
    throw err;
  }
}

async function getPresignedUrl(key, expiresIn = 3600) {
  if (!isInitialized || !s3Client) {
    throw new Error('S3 client not initialized');
  }
  
  try {
    const command = new GetObjectCommand({
      Bucket: settings.bucket,
      Key: key,
    });
    
    const url = await getSignedUrl(s3Client, command, { expiresIn });
    return url;
  } catch (err) {
    console.error('[object-storage] Failed to generate presigned URL:', err);
    throw err;
  }
}

async function downloadToCache(key) {
  if (!isInitialized || !s3Client) {
    throw new Error('S3 client not initialized');
  }
  
  await ensureCacheDir();
  
  const fileName = basename(key);
  const localPath = join(cachePath, fileName);
  
  // Check if already cached
  try {
    await access(localPath);
    console.log('[object-storage] File already cached:', fileName);
    return localPath;
  } catch {
    // File not in cache, download it
  }
  
  try {
    console.log('[object-storage] Downloading to cache:', key);
    
    const command = new GetObjectCommand({
      Bucket: settings.bucket,
      Key: key,
    });
    
    const response = await s3Client.send(command);
    const writeStream = createWriteStream(localPath);
    
    // Convert Web Stream to Node Stream if needed
    const bodyStream = response.Body instanceof Readable 
      ? response.Body 
      : Readable.from(response.Body);
    
    await pipeline(bodyStream, writeStream);
    
    console.log('[object-storage] Downloaded successfully:', fileName);
    
    // Clean up cache if it exceeds max size
    await cleanupCache();
    
    return localPath;
  } catch (err) {
    console.error('[object-storage] Failed to download file:', err);
    throw err;
  }
}

async function getCacheSize() {
  try {
    await ensureCacheDir();
    const files = await readdir(cachePath);
    let totalSize = 0;
    
    for (const file of files) {
      const filePath = join(cachePath, file);
      const stats = await stat(filePath);
      totalSize += stats.size;
    }
    
    return totalSize / (1024 * 1024); // Convert to MB
  } catch (err) {
    console.error('[object-storage] Failed to calculate cache size:', err);
    return 0;
  }
}

async function cleanupCache() {
  const maxSizeMB = settings.maxCacheSize || 1024;
  const currentSizeMB = await getCacheSize();
  
  if (currentSizeMB <= maxSizeMB) {
    return;
  }
  
  console.log(`[object-storage] Cache cleanup needed. Current: ${currentSizeMB.toFixed(2)}MB, Max: ${maxSizeMB}MB`);
  
  try {
    const files = await readdir(cachePath);
    const fileStats = [];
    
    for (const file of files) {
      const filePath = join(cachePath, file);
      const stats = await stat(filePath);
      fileStats.push({
        path: filePath,
        atime: stats.atime,
        size: stats.size,
      });
    }
    
    // Sort by access time (oldest first)
    fileStats.sort((a, b) => a.atime - b.atime);
    
    let freedSpace = 0;
    const targetFreeMB = (currentSizeMB - maxSizeMB) * 1.2; // Free 20% more than needed
    
    for (const file of fileStats) {
      if (freedSpace >= targetFreeMB * 1024 * 1024) break;
      
      await unlink(file.path);
      freedSpace += file.size;
      console.log('[object-storage] Deleted cached file:', basename(file.path));
    }
    
    console.log(`[object-storage] Freed ${(freedSpace / (1024 * 1024)).toFixed(2)}MB`);
  } catch (err) {
    console.error('[object-storage] Failed to cleanup cache:', err);
  }
}

async function clearCache() {
  try {
    const files = await readdir(cachePath);
    for (const file of files) {
      await unlink(join(cachePath, file));
    }
    console.log('[object-storage] Cache cleared');
  } catch (err) {
    console.error('[object-storage] Failed to clear cache:', err);
  }
}

function startAutoSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
  }
  
  const intervalMs = (settings.syncInterval || 300) * 1000;
  
  syncInterval = setInterval(async () => {
    console.log('[object-storage] Auto-sync triggered');
    try {
      const objects = await listObjects();
      console.log(`[object-storage] Found ${objects.length} audio files`);
      // Could trigger library refresh here if needed
    } catch (err) {
      console.error('[object-storage] Auto-sync failed:', err);
    }
  }, intervalMs);
  
  console.log(`[object-storage] Auto-sync started (interval: ${settings.syncInterval}s)`);
}

// Watch plugin config for settings updates so renderer can request operations
// by updating settings via the existing IPC `plugins:update-settings` (no main.js edits needed).
function watchPluginConfig() {
  try {
    const cfgPath = join(app.getPath('userData'), 'plugins', 'plugins-config.json');
    // Polling approach: check every 1s for changes to avoid fs.watch cross-platform issues
    let lastMtime = 0;
    setInterval(async () => {
      try {
        const st = await stat(cfgPath).catch(() => null);
        if (!st) return;
        const mtime = +st.mtime;
        if (mtime === lastMtime) return;
        lastMtime = mtime;
        const raw = await readFile(cfgPath, 'utf8');
        let cfg = {};
        try { cfg = JSON.parse(raw); } catch { cfg = {}; }
        const mySettings = cfg['object-storage'];
        if (mySettings) {
          // Apply new settings and reinitialize
          updateSettings(mySettings);
          // After updating, try listing objects and push to renderers
          try {
            if (isInitialized) {
              const objects = await listObjects('');
              pushFilesToRenderers(objects);
              pushStatusToRenderers({ connected: true, count: objects.length });
            } else {
              pushStatusToRenderers({ connected: false, message: 'Not initialized (check credentials)' });
            }
          } catch (error) {
            pushStatusToRenderers({ connected: false, message: String(error && error.message ? error.message : error) });
          }
        }
      } catch {
        // ignore transient errors
      }
    }, 1000);
  } catch (err) {
    console.error('[object-storage] Failed to start config watcher:', err);
  }
}

// Helper to push file list to all renderer windows
function pushFilesToRenderers(objects) {
  const wins = BrowserWindow.getAllWindows();
  // Build enhanced list with downloadable URL or cached path
  (async () => {
    const enhanced = [];
    for (const o of (objects || [])) {
      // Do NOT trigger downloads here. If `cacheFiles` is enabled, only use
      // an already-cached file (do not download). Otherwise generate a
      // presigned URL for streaming.
      try {
        // Prefer presigned URL for streaming.
        let presigned = null;
        try {
          presigned = await getPresignedUrl(o.Key);
        } catch {
          presigned = null;
        }

        // Check for an existing cached copy but do NOT prefer it for streaming.
        let cachedPath = null;
        if (settings.cacheFiles && cachePath) {
          try {
            const localName = basename(o.Key);
            const localPath = join(cachePath, localName);
            await access(localPath);
            cachedPath = localPath;
          } catch {
            cachedPath = null;
          }
        }

        enhanced.push({ Key: o.Key, Size: o.Size, LastModified: o.LastModified, url: presigned, cachedPath });
      } catch {
        enhanced.push({ Key: o.Key, Size: o.Size, LastModified: o.LastModified, url: null });
      }
    }

    for (const w of wins) {
      try {
        w.webContents.send('object-storage:files', enhanced);
      } catch {}
    }
    if (remoteBroadcast) {
      try {
        remoteBroadcast('object-storage:files', enhanced);
      } catch (err) {
        console.warn('[object-storage] remote broadcast for files failed', err);
      }
    }
  })();
}

function pushStatusToRenderers(status) {
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    try {
      w.webContents.send('object-storage:status', status);
    } catch {}
  }
  if (remoteBroadcast) {
    try {
      remoteBroadcast('object-storage:status', status);
    } catch (err) {
      console.warn('[object-storage] remote broadcast for status failed', err);
    }
  }
}

// no-op (read via fs/promises.readFile above)

// Export API for renderer or other plugins
export const ObjectStorageAPI = {
  async listFiles(prefix = '') {
    return await listObjects(prefix);
  },
  
  async getFileUrl(key) {
    if (settings.cacheFiles) {
      return await downloadToCache(key);
    } else {
      return await getPresignedUrl(key);
    }
  },
  
  async downloadFile(key) {
    return await downloadToCache(key);
  },
  
  async getCacheInfo() {
    const sizeMB = await getCacheSize();
    return {
      path: cachePath,
      sizeMB: sizeMB.toFixed(2),
      maxSizeMB: settings.maxCacheSize || 1024,
    };
  },
  
  async clearCache() {
    await clearCache();
  },
  
  isInitialized() {
    return isInitialized;
  },
  
  getSettings() {
    return { ...settings };
  },
  
  async testConnection() {
    try {
      await listObjects('');
      return { success: true, message: 'Connection successful' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  },

  async resolvePath(uri) {
    if (!uri || typeof uri !== 'string') return null;

    if (uri.startsWith('object-storage://')) {
      const pathPart = uri.substring(17); // length of 'object-storage://'
      const firstSlash = pathPart.indexOf('/');
      if (firstSlash === -1) return null;

      const bucket = pathPart.substring(0, firstSlash);
      const key = decodeURIComponent(pathPart.substring(firstSlash + 1));

      if (settings.bucket && bucket !== settings.bucket) {
        console.warn(`[object-storage] URI bucket '${bucket}' does not match configured bucket '${settings.bucket}'. Attempting download anyway.`);
      }

      if (settings.cacheFiles) {
        return await downloadToCache(key);
      }
      return await getPresignedUrl(key);
    }

    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      const key = extractKeyFromUrl(uri);
      if (key) {
        if (settings.cacheFiles) {
          return await downloadToCache(key);
        }
        return await getPresignedUrl(key);
      }
      // No matching key – fall back to streaming original URL
      return uri;
    }

    return null;
  },
};

export function getTrackContextMenuItems(tracks, mainWindow) {
  if (!tracks || tracks.length === 0) return [];
  
  // Only show if we have valid paths that are not already remote/object-storage
  const validTracks = tracks.filter(t => t.path && !t.path.startsWith('http') && !t.path.startsWith('object-storage://'));
  if (validTracks.length === 0) return [];

  return [
    {
      label: 'Add to Object Storage',
      click: () => {
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('object-storage:request-upload', validTracks);
        }
      }
    }
  ];
}

export function updateSettings(newSettings) {
  const oldEndpoint = settings.endpoint;
  const oldCredentials = `${settings.accessKeyId}:${settings.secretAccessKey}`;
  
  settings = { ...settings, ...newSettings };
  
  const newEndpoint = settings.endpoint;
  const newCredentials = `${settings.accessKeyId}:${settings.secretAccessKey}`;
  
  // Reinitialize client if credentials or endpoint changed
  if (oldEndpoint !== newEndpoint || oldCredentials !== newCredentials) {
    initializeClient();
  }
  
  // Update auto-sync
  if (settings.autoSync && settings.syncInterval > 0) {
    startAutoSync();
  } else if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}
