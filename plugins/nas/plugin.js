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

const AUDIO_EXTS = new Set([
  '.flac', '.wav', '.mp3', '.aac', '.ogg', '.m4a', '.alac',
  '.wma', '.dsf', '.dff', '.ape', '.aiff', '.aif', '.opus',
  '.mka', '.wv', '.tak', '.tta',
]);

function isAudioFile(name) {
  return AUDIO_EXTS.has(path.extname(name).toLowerCase());
}

// ─── WebDAV client ────────────────────────────────────────────────────────────

function webdavRequest(url, method, headers = {}, body = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      timeout: timeoutMs,
      headers: {
        'Accept': 'text/xml,application/xml',
        'Content-Type': 'application/xml; charset=utf-8',
        ...headers,
      },
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('WebDAV timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function xmlTag(xml, tag) {
  const re = new RegExp(`<(?:[^:]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function xmlTags(xml, tag) {
  const re = new RegExp(`<(?:[^:]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:]+:)?${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function webdavList(baseUrl, remotePath = '/', credentials = null) {
  const url = new URL(remotePath, baseUrl).href;
  const headers = {};
  if (credentials) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  }
  const propfindBody = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontenttype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;

  const resp = await webdavRequest(url, 'PROPFIND', { ...headers, 'Depth': '1' }, propfindBody);
  if (resp.status >= 400) throw new Error(`WebDAV PROPFIND failed: HTTP ${resp.status}`);

  const responseBlocks = xmlTags(resp.body, 'response');
  const items = [];

  for (const block of responseBlocks) {
    const hrefRaw = xmlTag(block, 'href') || '';
    const href = decodeXmlEntities(hrefRaw);
    if (!href) continue;

    const isCollection = block.includes('collection');
    const displayName = decodeXmlEntities(xmlTag(block, 'displayname') || '') ||
      decodeURIComponent(href.replace(/\/$/, '').split('/').pop());

    if (!displayName || displayName === '/') continue;

    const itemUrl = new URL(href, baseUrl).href;

    if (isCollection) {
      items.push({ name: displayName, path: itemUrl, type: 'directory' });
    } else if (isAudioFile(displayName)) {
      const size = parseInt(xmlTag(block, 'getcontentlength') || '0', 10);
      items.push({ name: displayName, path: itemUrl, type: 'file', size });
    }
  }

  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ─── Local/UNC path browser ────────────────────────────────────────────────────

function localList(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    const fullPath = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      items.push({ name: e.name, path: fullPath, type: 'directory' });
    } else if (e.isFile() && isAudioFile(e.name)) {
      let size = 0;
      try { size = fs.statSync(fullPath).size; } catch {}
      items.push({ name: e.name, path: fullPath, type: 'file', size });
    }
  }
  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ─── Plugin activation ────────────────────────────────────────────────────────

export function activate(context) {
  let shares = Array.isArray(context.settings?.shares) ? [...context.settings.shares] : [];

  // Browse a share or sub-path
  context.registerRemoteHandler('nas:browse', async ({ shareId, subPath }) => {
    const share = shares.find(s => s.id === shareId);
    if (!share) throw new Error(`NAS share "${shareId}" not found`);

    if (share.type === 'webdav') {
      const base = share.url.replace(/\/$/, '');
      const remotePath = subPath || '/';
      return webdavList(base, remotePath, share.credentials || null);
    }

    if (share.type === 'local' || share.type === 'smb' || share.type === 'nfs') {
      // SMB: use UNC path like \\server\share (Windows) or mounted path
      const root = share.path || '';
      const fullPath = subPath ? path.join(root, subPath) : root;
      return localList(fullPath);
    }

    throw new Error(`Unknown NAS share type: ${share.type}`);
  });

  // List configured shares
  context.registerRemoteHandler('nas:list-shares', () => {
    return shares.map(s => ({ id: s.id, name: s.name, type: s.type }));
  });

  // Add a share
  context.registerRemoteHandler('nas:add-share', (share) => {
    if (!share?.id || !share?.name || !share?.type) {
      throw new Error('Share requires id, name, and type');
    }
    shares = shares.filter(s => s.id !== share.id);
    shares.push(share);
    context.settings.shares = shares;
    return { ok: true, shares: shares.map(s => ({ id: s.id, name: s.name, type: s.type })) };
  });

  // Remove a share
  context.registerRemoteHandler('nas:remove-share', ({ shareId }) => {
    shares = shares.filter(s => s.id !== shareId);
    context.settings.shares = shares;
    return { ok: true };
  });

  // Test connectivity to a share
  context.registerRemoteHandler('nas:test-share', async ({ shareId }) => {
    const share = shares.find(s => s.id === shareId);
    if (!share) throw new Error(`Share "${shareId}" not found`);

    try {
      if (share.type === 'webdav') {
        await webdavList(share.url, '/', share.credentials || null);
        return { ok: true, message: 'WebDAV connection successful' };
      }
      if (share.type === 'local' || share.type === 'smb' || share.type === 'nfs') {
        const stat = fs.statSync(share.path);
        return { ok: stat.isDirectory(), message: stat.isDirectory() ? 'Path accessible' : 'Path is not a directory' };
      }
      return { ok: false, message: 'Unknown share type' };
    } catch (err) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  });

  console.log('[nas] NAS/Network Storage plugin activated');
}
