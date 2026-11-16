/**
 * NAS / Network Storage plugin for Spectra.
 *
 * Supports:
 *   - WebDAV (HTTP PROPFIND) — works with most NAS devices (Synology, QNAP, etc.)
 *   - UNC paths (\\server\share) — Windows SMB/CIFS via OS-level access
 *   - Mounted paths — NFS/SMB already mounted by OS appear as local directories
 *
 * FFmpeg handles actual streaming — this plugin only handles browsing.
 * No extra npm packages required.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const AUDIO_EXTS = new Set([
  '.flac', '.wav', '.mp3', '.aac', '.ogg', '.m4a', '.alac',
  '.wma', '.dsf', '.dff', '.ape', '.aiff', '.aif', '.opus',
  '.mka', '.wv', '.tak', '.tta', '.caf',
]);

const SHARE_TYPES = new Set(['webdav', 'smb', 'nfs', 'local']);
const RECURSIVE_LIMIT = 5000;

function isAudioFile(name) {
  return AUDIO_EXTS.has(path.extname(name).toLowerCase());
}

const byTypeThenName = (a, b) => {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
};

// ─── WebDAV client ────────────────────────────────────────────────────────────

function webdavRequest(url, method, headers = {}, body = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(body, 'utf8') : null;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      timeout: timeoutMs,
      headers: {
        'Accept': 'text/xml,application/xml',
        'Content-Type': 'application/xml; charset=utf-8',
        ...(payload ? { 'Content-Length': payload.length } : {}),
        ...headers,
      },
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('WebDAV request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function xmlTag(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function xmlTags(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

function decodeXmlEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function normalizedPathname(u) {
  try {
    return safeDecodeURIComponent(new URL(u).pathname).replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** Share URL as a directory URL (always ends with "/") so relative resolution stays inside it. */
function webdavRoot(share) {
  const u = new URL(share.url);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.username = '';
  u.password = '';
  u.hash = '';
  return u.href;
}

function basicAuthHeader(credentials) {
  if (!credentials || !credentials.username) return {};
  const token = Buffer.from(`${credentials.username}:${credentials.password || ''}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

function webdavErrorMessage(status) {
  if (status === 401) return 'Authentication failed (HTTP 401) — check the username and password';
  if (status === 403) return 'Access denied (HTTP 403)';
  if (status === 404) return 'Folder not found on the server (HTTP 404) — check the URL path';
  if (status === 405) return 'Server does not support WebDAV at this URL (HTTP 405)';
  return `WebDAV request failed: HTTP ${status}`;
}

async function webdavList(share, targetUrl = null) {
  const root = webdavRoot(share);
  let url = root;
  if (targetUrl) {
    url = new URL(targetUrl, root).href;
    // Never send the share's credentials to a different host.
    if (new URL(url).origin !== new URL(root).origin) throw new Error('Path is outside this share');
    if (!url.endsWith('/')) url += '/';
  }

  const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontenttype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;

  let resp = await webdavRequest(url, 'PROPFIND', { ...basicAuthHeader(share.credentials), Depth: '1' }, propfindBody);
  // Some servers redirect "/music" → "/music/": follow once.
  if ([301, 302, 307, 308].includes(resp.status) && resp.headers?.location) {
    const redirected = new URL(resp.headers.location, url).href;
    if (new URL(redirected).origin === new URL(root).origin) {
      url = redirected;
      resp = await webdavRequest(url, 'PROPFIND', { ...basicAuthHeader(share.credentials), Depth: '1' }, propfindBody);
    }
  }
  if (resp.status >= 400) throw new Error(webdavErrorMessage(resp.status));
  if (resp.status !== 207 && !/multistatus/i.test(resp.body)) {
    throw new Error(`Server did not return a WebDAV listing (HTTP ${resp.status})`);
  }

  const selfPath = normalizedPathname(url);
  const items = [];
  const seen = new Set();

  for (const block of xmlTags(resp.body, 'response')) {
    const href = decodeXmlEntities(xmlTag(block, 'href') || '');
    if (!href) continue;

    let itemUrl;
    try { itemUrl = new URL(href, url).href; } catch { continue; }
    const itemPath = normalizedPathname(itemUrl);
    // PROPFIND Depth:1 always includes the folder itself — skip it.
    if (itemPath === selfPath) continue;
    if (seen.has(itemPath)) continue;
    seen.add(itemPath);

    const resourceType = xmlTag(block, 'resourcetype') || '';
    const isCollection = /<(?:[\w.-]+:)?collection\b/i.test(resourceType);
    const fileName = safeDecodeURIComponent(itemPath.split('/').pop() || '');
    const displayName = decodeXmlEntities(xmlTag(block, 'displayname') || '') || fileName;
    if (!displayName || displayName.startsWith('.')) continue;

    if (isCollection) {
      items.push({ name: displayName, path: itemUrl.endsWith('/') ? itemUrl : itemUrl + '/', type: 'directory' });
    } else if (isAudioFile(fileName) || isAudioFile(displayName)) {
      const size = parseInt(xmlTag(block, 'getcontentlength') || '0', 10) || 0;
      items.push({ name: displayName, path: itemUrl, type: 'file', size });
    }
  }

  return items.sort(byTypeThenName);
}

// ─── Local/UNC path browser ────────────────────────────────────────────────────

/** Resolve a browse target inside a share root; rejects anything that escapes it. */
function resolveLocalTarget(root, subPath) {
  const base = path.resolve(root);
  if (!subPath) return base;
  // The renderer passes back the full path it was given for a folder.
  const target = path.isAbsolute(subPath) ? path.resolve(subPath) : path.resolve(base, subPath);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside this share');
  return target;
}

async function localList(dirPath) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
    const fullPath = path.join(dirPath, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = await fs.promises.stat(fullPath);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch { continue; }
    }
    if (isDir) {
      items.push({ name: e.name, path: fullPath, type: 'directory' });
    } else if (isFile && isAudioFile(e.name)) {
      let size = 0;
      try { size = (await fs.promises.stat(fullPath)).size; } catch {}
      items.push({ name: e.name, path: fullPath, type: 'file', size });
    }
  }
  return items.sort(byTypeThenName);
}

/** `\\server\share\sub\dir` → `\\server\share` (what `net use` expects). */
function uncShareRoot(p) {
  const m = String(p || '').replace(/\//g, '\\').match(/^\\\\[^\\]+\\[^\\]+/);
  return m ? m[0] : null;
}

async function connectSmb(share) {
  if (process.platform !== 'win32' || !share.credentials?.username) return null;
  const root = uncShareRoot(share.path);
  if (!root) return null;
  try {
    await execFileAsync('net', ['use', root, share.credentials.password || '', `/user:${share.credentials.username}`], {
      timeout: 15000, windowsHide: true,
    });
    return null;
  } catch (err) {
    const text = `${err?.stderr || ''} ${err?.stdout || ''} ${err?.message || ''}`;
    // 1219: already connected to this server with (possibly other) credentials — browsing may still work.
    if (/\b1219\b/.test(text)) return null;
    if (/\b1326\b/.test(text) || /\b86\b/.test(text)) return 'Wrong username or password for this share';
    if (/\b53\b/.test(text) || /\b67\b/.test(text)) return 'Network path not found — check the server and share name';
    return null; // unknown: let the directory read report the real problem
  }
}

function friendlyFsError(err, target) {
  const code = err?.code;
  if (code === 'ENOENT') return new Error(`Path not found: ${target}`);
  if (code === 'EACCES' || code === 'EPERM') return new Error(`Access denied: ${target}`);
  if (code === 'ENOTDIR') return new Error(`Not a folder: ${target}`);
  if (code === 'UNKNOWN' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT') {
    return new Error(`Cannot reach ${target} — is the server online and the share name correct?`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ─── Share bookkeeping ────────────────────────────────────────────────────────

let shares = [];

function normalizeShare(input, existing = null) {
  if (!input || typeof input !== 'object') throw new Error('Invalid share');
  const type = String(input.type || '').toLowerCase();
  if (!SHARE_TYPES.has(type)) throw new Error(`Unknown share type "${input.type}"`);
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Share name is required');

  const share = { id: String(input.id || `nas-${Date.now()}`), name, type };

  if (type === 'webdav') {
    let raw = String(input.url || '').trim();
    if (!raw) throw new Error('URL is required for WebDAV shares');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error(`"${raw}" is not a valid URL`); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('WebDAV URL must start with http:// or https://');
    // Credentials typed into the URL move into the credentials field.
    if (parsed.username && !input.credentials?.username) {
      input = { ...input, credentials: { username: safeDecodeURIComponent(parsed.username), password: safeDecodeURIComponent(parsed.password) } };
    }
    parsed.username = '';
    parsed.password = '';
    share.url = parsed.href;
  } else {
    let p = String(input.path || '').trim().replace(/^["']|["']$/g, '');
    if (!p) throw new Error('Path is required');
    // Accept smb://server/share and //server/share as UNC on Windows.
    const smbUrl = p.match(/^smb:\/\/(.+)$/i);
    if (smbUrl) p = `//${smbUrl[1]}`;
    if (process.platform === 'win32' && /^\/\/[^/]/.test(p)) p = p.replace(/\//g, '\\');
    share.path = p;
  }

  const creds = input.credentials;
  if (creds && (creds.username || creds.password)) {
    const username = String(creds.username || '').trim();
    // An edit that leaves the password blank keeps the stored one.
    const password = creds.password
      ? String(creds.password)
      : (existing?.credentials?.username === username ? existing.credentials.password || '' : '');
    share.credentials = { username, password };
  }
  return share;
}

/** What the UI may see: never the stored password. */
function publicShare(s) {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    url: s.url || null,
    path: s.path || null,
    credentials: s.credentials
      ? { username: s.credentials.username || '', hasPassword: !!s.credentials.password }
      : null,
  };
}

function findWebdavShareFor(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  let target;
  try { target = new URL(url); } catch { return null; }
  let best = null;
  for (const s of shares) {
    if (s.type !== 'webdav' || !s.url) continue;
    let root;
    try { root = new URL(webdavRoot(s)); } catch { continue; }
    if (root.origin !== target.origin) continue;
    const rootPath = safeDecodeURIComponent(root.pathname);
    if (!safeDecodeURIComponent(target.pathname + '/').startsWith(rootPath)) continue;
    if (!best || rootPath.length > best.rootPath.length) best = { share: s, rootPath };
  }
  return best ? best.share : null;
}

/**
 * Host hook: turn a library path into something FFmpeg can open.
 * WebDAV tracks are stored without credentials; add them only at play time.
 */
export function resolvePath(filePath) {
  const share = findWebdavShareFor(filePath);
  if (!share?.credentials?.username) return null;
  try {
    const u = new URL(filePath);
    if (u.username) return null;
    u.username = share.credentials.username;
    u.password = share.credentials.password || '';
    return u.href;
  } catch {
    return null;
  }
}

/** Host hook: extra headers needed to fetch a URL (metadata probing, downloads). */
export function getRequestHeaders(url) {
  const share = findWebdavShareFor(url);
  return share ? basicAuthHeader(share.credentials) : null;
}

// ─── Plugin activation ────────────────────────────────────────────────────────

export function activate(context) {
  shares = Array.isArray(context.settings?.shares) ? context.settings.shares.filter(s => s && s.id) : [];

  const persist = () => {
    const next = { ...(context.settings || {}), shares };
    context.settings = next;
    if (typeof context.saveSettings === 'function') {
      try { context.saveSettings(next); } catch (err) { console.error('[nas] failed to save shares', err); }
    }
  };

  const requireShare = (shareId) => {
    const share = shares.find(s => s.id === shareId);
    if (!share) throw new Error('That share no longer exists');
    return share;
  };

  const browse = async (share, subPath) => {
    if (share.type === 'webdav') return webdavList(share, subPath || null);
    const smbProblem = share.type === 'smb' ? await connectSmb(share) : null;
    const target = resolveLocalTarget(share.path, subPath);
    try {
      return await localList(target);
    } catch (err) {
      if (smbProblem) throw new Error(smbProblem);
      throw friendlyFsError(err, target);
    }
  };

  context.registerRemoteHandler('nas:browse', async ({ shareId, subPath } = {}) => {
    return browse(requireShare(shareId), subPath);
  });

  // Every audio file below a folder (bounded), for "add folder to library/playlist".
  context.registerRemoteHandler('nas:list-recursive', async ({ shareId, subPath, limit } = {}) => {
    const share = requireShare(shareId);
    const max = Math.min(RECURSIVE_LIMIT, Number(limit) || RECURSIVE_LIMIT);
    const files = [];
    const stack = [subPath || null];
    const seen = new Set();
    while (stack.length && files.length < max) {
      const dir = stack.pop();
      const key = String(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      let items;
      try { items = await browse(share, dir); } catch (err) {
        if (dir === (subPath || null)) throw err;
        continue; // unreadable sub-folder: skip it
      }
      const dirs = [];
      for (const it of items) {
        if (it.type === 'file') files.push(it);
        else dirs.push(it.path);
      }
      for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]);
    }
    return files.slice(0, max);
  });

  context.registerRemoteHandler('nas:list-shares', () => shares.map(publicShare));

  // Add or update a share (same id = update)
  context.registerRemoteHandler('nas:add-share', (input) => {
    const existing = shares.find(s => s.id === input?.id) || null;
    const share = normalizeShare(input, existing);
    const idx = shares.findIndex(s => s.id === share.id);
    if (idx >= 0) shares[idx] = share; else shares.push(share);
    persist();
    return { ok: true, share: publicShare(share), shares: shares.map(publicShare) };
  });

  context.registerRemoteHandler('nas:remove-share', ({ shareId } = {}) => {
    shares = shares.filter(s => s.id !== shareId);
    persist();
    return { ok: true };
  });

  // Test connectivity. Accepts a saved share id or an unsaved draft from the dialog.
  context.registerRemoteHandler('nas:test-share', async ({ shareId, share: draft } = {}) => {
    try {
      const existing = shareId ? shares.find(s => s.id === shareId) || null : null;
      const share = draft ? normalizeShare(draft, existing || shares.find(s => s.id === draft.id) || null) : existing;
      if (!share) return { ok: false, message: 'That share no longer exists' };
      const items = await browse(share, null);
      const folders = items.filter(i => i.type === 'directory').length;
      const files = items.length - folders;
      return { ok: true, message: `Connected — ${folders} folder${folders === 1 ? '' : 's'}, ${files} audio file${files === 1 ? '' : 's'}` };
    } catch (err) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  });

  console.log(`[nas] NAS/Network Storage plugin activated (${shares.length} share(s))`);
}

export function deactivate() {
  shares = [];
}

// Exposed for tests.
export const __test = { normalizeShare, webdavList, resolveLocalTarget, uncShareRoot, localList };
