/**
 * UPnP/DLNA plugin for Spectra.
 *
 * Discovers media servers via SSDP, browses/searches ContentDirectory via SOAP,
 * and provides streaming URLs that FFmpeg can handle directly.
 *
 * No external npm dependencies required — uses Node's built-in dgram + http.
 */

import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

const MEDIA_SERVER_ST = [
  'urn:schemas-upnp-org:device:MediaServer:1',
  'urn:schemas-upnp-org:service:ContentDirectory:1',
];

// A server that misses this many consecutive scans is dropped from the list.
const MAX_MISSED_SCANS = 4;
const BROWSE_PAGE_SIZE = 200;
const BROWSE_MAX_ITEMS = 5000;

/** Perform HTTP GET, return body string */
function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
  });
}

/** Perform SOAP POST, return { status, body } */
function soapPost(url, serviceType, action, bodyXml, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const soap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>${bodyXml}</s:Body>
</s:Envelope>`;
    const body = Buffer.from(soap, 'utf8');
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': body.length,
        'SOAPAction': `"${serviceType}#${action}"`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SOAP timeout')); });
    req.write(body);
    req.end();
  });
}

function decodeXmlEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" becomes "&lt;" and not "<"
}

function encodeXmlEntities(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Minimal XML tag value extractor (avoids xml2js dependency). Namespace prefixes are optional. */
function xmlTag(xml, tag) {
  const t = escapeRe(tag);
  const re = new RegExp(`<(?:[\\w.-]+:)?${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${t}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function xmlTags(xml, tag) {
  const t = escapeRe(tag);
  const re = new RegExp(`<(?:[\\w.-]+:)?${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${t}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

function attr(tagText, name) {
  const m = tagText.match(new RegExp(`\\b${escapeRe(name)}\\s*=\\s*"([^"]*)"`, 'i'))
    || tagText.match(new RegExp(`\\b${escapeRe(name)}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? decodeXmlEntities(m[1]) : '';
}

/** "H:MM:SS.fff" -> seconds */
function parseDuration(text) {
  if (!text) return 0;
  const parts = String(text).trim().split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return 0;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Math.max(0, sec);
}

const LOSSLESS_HINTS = ['flac', 'wav', 'x-wav', 'l16', 'l24', 'aiff', 'x-aiff', 'dsd', 'dsf', 'dff', 'alac', 'ape'];

/** Choose the best <res> of an item: audio only, original/lossless first, then highest quality. */
function pickResource(block) {
  const resRe = /<res\b([^>]*)>([^<]*)<\/res>/gi;
  let best = null;
  let m;
  while ((m = resRe.exec(block)) !== null) {
    const attrs = m[1];
    const url = decodeXmlEntities(m[2].trim());
    if (!/^https?:\/\//i.test(url)) continue;
    const protocolInfo = attr(attrs, 'protocolInfo');
    const [, , mime = '', extra = ''] = protocolInfo.split(':');
    const lowerMime = mime.toLowerCase();
    if (lowerMime.startsWith('image/') || lowerMime.startsWith('video/') || lowerMime.startsWith('text/')) continue;
    let score = 0;
    if (lowerMime.startsWith('audio/')) score += 100;
    if (LOSSLESS_HINTS.some(h => lowerMime.includes(h))) score += 50;
    // DLNA.ORG_CI=1 marks a transcoded stream; prefer the original.
    if (/DLNA\.ORG_CI=1/i.test(extra)) score -= 40;
    const sampleRate = Number(attr(attrs, 'sampleFrequency')) || 0;
    const bits = Number(attr(attrs, 'bitsPerSample')) || 0;
    const bitrate = Number(attr(attrs, 'bitrate')) || 0;
    score += Math.min(30, sampleRate / 10000) + Math.min(10, bits / 4) + Math.min(10, bitrate / 100000);
    const candidate = {
      url, mime, score,
      duration: parseDuration(attr(attrs, 'duration')),
      size: Number(attr(attrs, 'size')) || 0,
      sampleRate, bitDepth: bits,
      channels: Number(attr(attrs, 'nrAudioChannels')) || 0,
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

/** Parse DIDL-Lite items from a ContentDirectory Browse/Search result */
function parseDIDL(didl, baseUrl) {
  const items = [];
  const entryRe = /<(item|container)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = entryRe.exec(didl)) !== null) {
    const kind = m[1].toLowerCase();
    const attrs = m[2];
    const block = m[3];
    const id = attr(attrs, 'id');
    const title = decodeXmlEntities(xmlTag(block, 'title') || '');
    const upnpClass = decodeXmlEntities(xmlTag(block, 'class') || '');

    if (kind === 'container') {
      if (!id) continue;
      items.push({
        id, title, type: 'container',
        childCount: Number(attr(attrs, 'childCount')) || null,
      });
      continue;
    }

    // Skip photos/videos; keep audio and anything unclassified that has an audio resource.
    if (/object\.item\.(imageItem|videoItem)/i.test(upnpClass)) continue;
    const res = pickResource(block);
    if (!res) continue;

    let albumArt = decodeXmlEntities(xmlTag(block, 'albumArtURI') || '');
    if (albumArt) {
      try { albumArt = new URL(albumArt, baseUrl).href; } catch { albumArt = ''; }
    }
    items.push({
      id,
      type: 'track',
      title,
      artist: decodeXmlEntities(xmlTag(block, 'artist') || xmlTag(block, 'creator') || ''),
      album: decodeXmlEntities(xmlTag(block, 'album') || ''),
      genre: decodeXmlEntities(xmlTag(block, 'genre') || ''),
      trackNumber: Number(xmlTag(block, 'originalTrackNumber')) || null,
      duration: res.duration,
      url: res.url,
      mime: res.mime,
      size: res.size,
      sampleRate: res.sampleRate || null,
      bitDepth: res.bitDepth || null,
      channels: res.channels || null,
      albumArt: albumArt || null,
    });
  }
  return items;
}

function soapFault(body) {
  if (!/<(?:[\w.-]+:)?Fault\b/i.test(body)) return null;
  const desc = xmlTag(body, 'errorDescription') || xmlTag(body, 'faultstring') || 'UPnP error';
  const code = xmlTag(body, 'errorCode');
  return code ? `${decodeXmlEntities(desc)} (${code})` : decodeXmlEntities(desc);
}

class UPnPServer {
  constructor(location, usn) {
    this.location = location;
    this.usn = usn;
    this.friendlyName = '';
    this.contentDirectoryUrl = null;
    this.serviceType = 'urn:schemas-upnp-org:service:ContentDirectory:1';
    this.missedScans = 0;
    this.manual = false;
    this._descPromise = null;
  }

  /** Fetch (once) the device description; safe to call concurrently. */
  fetchDescription(force = false) {
    if (this._descPromise && !force) return this._descPromise;
    this._descPromise = (async () => {
      const xml = await httpGet(this.location);
      this.friendlyName = decodeXmlEntities(xmlTag(xml, 'friendlyName') || '') || this.usn;
      const udn = xmlTag(xml, 'UDN');
      if (udn && (!this.usn || this.usn === this.location)) this.usn = decodeXmlEntities(udn);

      // Control URLs are relative to URLBase when present, else to the description URL.
      const urlBase = decodeXmlEntities(xmlTag(xml, 'URLBase') || '') || this.location;
      for (const svc of xmlTags(xml, 'service')) {
        const st = decodeXmlEntities(xmlTag(svc, 'serviceType') || '');
        if (!st.includes('ContentDirectory')) continue;
        const controlPath = decodeXmlEntities(xmlTag(svc, 'controlURL') || '');
        if (controlPath) {
          this.contentDirectoryUrl = new URL(controlPath, urlBase).href;
          this.serviceType = st.trim();
        }
        break;
      }
      return this;
    })();
    // Allow a retry after a failure instead of caching the rejection forever.
    this._descPromise.catch(() => { this._descPromise = null; });
    return this._descPromise;
  }

  async _action(action, argsXml, resultTag = 'Result') {
    if (!this.contentDirectoryUrl) await this.fetchDescription();
    if (!this.contentDirectoryUrl) throw new Error('This server does not expose a ContentDirectory');
    const body = `<u:${action} xmlns:u="${this.serviceType}">${argsXml}</u:${action}>`;
    const resp = await soapPost(this.contentDirectoryUrl, this.serviceType, action, body);
    const fault = soapFault(resp.body);
    if (fault) throw new Error(fault);
    if (resp.status >= 400) throw new Error(`UPnP ${action} failed: HTTP ${resp.status}`);
    return {
      // The DIDL document is XML-escaped inside <Result>: unescape exactly once.
      didl: decodeXmlEntities(xmlTag(resp.body, resultTag) || ''),
      numberReturned: Number(xmlTag(resp.body, 'NumberReturned')) || 0,
      totalMatches: Number(xmlTag(resp.body, 'TotalMatches')) || 0,
    };
  }

  /** Page through an action until the server has returned everything. */
  async _collect(action, buildArgs) {
    const all = [];
    let start = 0;
    for (;;) {
      const page = await this._action(action, buildArgs(start, BROWSE_PAGE_SIZE));
      const parsed = parseDIDL(page.didl, this.contentDirectoryUrl || this.location);
      all.push(...parsed);
      const returned = page.numberReturned || parsed.length;
      start += returned;
      if (!returned) break;
      if (page.totalMatches && start >= page.totalMatches) break;
      if (!page.totalMatches && returned < BROWSE_PAGE_SIZE) break;
      if (all.length >= BROWSE_MAX_ITEMS) break;
    }
    return all;
  }

  browse(objectId = '0') {
    return this._collect('Browse', (start, count) => `
  <ObjectID>${encodeXmlEntities(objectId)}</ObjectID>
  <BrowseFlag>BrowseDirectChildren</BrowseFlag>
  <Filter>*</Filter>
  <StartingIndex>${start}</StartingIndex>
  <RequestedCount>${count}</RequestedCount>
  <SortCriteria></SortCriteria>`);
  }

  /** Server-side search for audio items by title / artist / album. */
  search(query, containerId = '0') {
    const q = String(query || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const criteria =
      `upnp:class derivedfrom "object.item.audioItem" and ` +
      `(dc:title contains "${q}" or upnp:artist contains "${q}" or upnp:album contains "${q}")`;
    return this._collect('Search', (start, count) => `
  <ContainerID>${encodeXmlEntities(containerId)}</ContainerID>
  <SearchCriteria>${encodeXmlEntities(criteria)}</SearchCriteria>
  <Filter>*</Filter>
  <StartingIndex>${start}</StartingIndex>
  <RequestedCount>${count}</RequestedCount>
  <SortCriteria></SortCriteria>`);
  }

  /** Every audio track below a container (depth-first, bounded). */
  async listRecursive(objectId = '0', limit = 3000) {
    const tracks = [];
    const stack = [objectId];
    const seen = new Set();
    while (stack.length && tracks.length < limit) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const items = await this.browse(id);
      const containers = [];
      for (const it of items) {
        if (it.type === 'track') tracks.push(it);
        else containers.push(it.id);
      }
      // Keep the server's order when popping from the stack.
      for (let i = containers.length - 1; i >= 0; i--) stack.push(containers[i]);
    }
    return tracks.slice(0, limit);
  }

  toJSON() {
    return {
      usn: this.usn,
      location: this.location,
      friendlyName: this.friendlyName || this.usn,
      hasContentDirectory: !!this.contentDirectoryUrl,
      manual: this.manual,
    };
  }
}

/** IPv4 addresses of every active, non-loopback interface. */
function localIPv4Addresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (isV4 && !a.internal) out.push(a.address);
    }
  }
  return out;
}

class UPnPScanner {
  constructor(settings = {}) {
    this._mx = Math.min(5, Math.max(1, Number(settings.ssdpMx) || 3));
    this._servers = new Map(); // location → UPnPServer
    this._scanPromise = null;
  }

  /**
   * One M-SEARCH round. A socket is opened per network interface: with a
   * single default-route socket, Windows machines that also have a VPN /
   * Hyper-V / WSL adapter send the multicast out of the wrong interface and
   * never see the LAN's media servers.
   */
  scan() {
    if (this._scanPromise) return this._scanPromise;
    this._scanPromise = new Promise((resolve) => {
      const seenThisScan = new Set();
      const sockets = [];
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        for (const sock of sockets) { try { sock.close(); } catch {} }
        for (const [location, server] of this._servers) {
          if (seenThisScan.has(location)) server.missedScans = 0;
          else if (!server.manual && ++server.missedScans >= MAX_MISSED_SCANS) this._servers.delete(location);
        }
        this._scanPromise = null;
        resolve(this.getServers());
      };

      const onMessage = (msg) => {
        const text = msg.toString('utf8');
        if (!/^HTTP\/1\.[01]\s+200/i.test(text) && !/^NOTIFY/i.test(text)) return;
        const location = text.match(/^LOCATION:\s*(\S+)/im)?.[1];
        if (!location) return;
        const st = text.match(/^ST:\s*(\S+)/im)?.[1] || '';
        const nt = text.match(/^NT:\s*(\S+)/im)?.[1] || '';
        if (![st, nt].some(v => v.includes('MediaServer') || v.includes('ContentDirectory'))) return;
        const rawUsn = text.match(/^USN:\s*(\S+)/im)?.[1] || location;
        // "uuid:abc::urn:…:ContentDirectory:1" → "uuid:abc" (one entry per device)
        const usn = rawUsn.split('::')[0] || rawUsn;
        seenThisScan.add(location);
        if (!this._servers.has(location)) this._servers.set(location, new UPnPServer(location, usn));
      };

      const bindAddresses = localIPv4Addresses();
      if (!bindAddresses.length) bindAddresses.push('0.0.0.0');

      for (const address of bindAddresses) {
        let sock;
        try {
          sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        } catch (err) {
          console.warn('[upnp] could not create SSDP socket:', err?.message ?? err);
          continue;
        }
        sockets.push(sock);
        sock.on('error', (err) => {
          console.warn(`[upnp] SSDP socket error on ${address}:`, err?.message ?? err);
          try { sock.close(); } catch {}
        });
        sock.on('message', onMessage);
        sock.bind(0, address, () => {
          try { sock.setMulticastTTL(4); } catch {}
          if (address !== '0.0.0.0') { try { sock.setMulticastInterface(address); } catch {} }
          for (const searchTarget of MEDIA_SERVER_ST) {
            const msg = Buffer.from(
              `M-SEARCH * HTTP/1.1\r\n` +
              `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
              `MAN: "ssdp:discover"\r\n` +
              `MX: ${this._mx}\r\n` +
              `ST: ${searchTarget}\r\n\r\n`
            );
            // UDP is lossy: send each search twice.
            for (const delay of [0, 400]) {
              setTimeout(() => {
                if (finished) return;
                try {
                  sock.send(msg, SSDP_PORT, SSDP_ADDR, (err) => {
                    if (err) console.warn(`[upnp] SSDP send error on ${address}:`, err?.message ?? err);
                  });
                } catch {}
              }, delay);
            }
          }
        });
      }

      setTimeout(finish, (this._mx + 1) * 1000);
    });
    return this._scanPromise;
  }

  /** Register a server by its device-description URL (for networks that block multicast). */
  async addManual(location) {
    const url = new URL(String(location).trim()); // throws on garbage
    if (!/^https?:$/.test(url.protocol)) throw new Error('Server URL must be http(s)');
    let server = this._servers.get(url.href);
    if (!server) server = new UPnPServer(url.href, url.href);
    server.manual = true;
    await server.fetchDescription(true);
    if (!server.contentDirectoryUrl) throw new Error('That device does not expose a ContentDirectory service');
    this._servers.set(url.href, server);
    return server;
  }

  remove(usnOrLocation) {
    for (const [location, server] of this._servers) {
      if (location === usnOrLocation || server.usn === usnOrLocation) this._servers.delete(location);
    }
  }

  find(usnOrLocation) {
    return this._servers.get(usnOrLocation)
      || this.getServers().find(s => s.usn === usnOrLocation)
      || null;
  }

  getServers() { return Array.from(this._servers.values()); }
}

// ─── Plugin activation ────────────────────────────────────────────────────────

let rescanTimer = null;

export function activate(context) {
  const settings = context.settings || {};
  const scanner = new UPnPScanner(settings);

  const persistManual = () => {
    try {
      const manualServers = scanner.getServers().filter(s => s.manual).map(s => s.location);
      const next = { ...(context.settings || {}), manualServers };
      context.settings = next;
      if (typeof context.saveSettings === 'function') context.saveSettings(next);
    } catch (err) {
      console.warn('[upnp] failed to persist manual servers', err);
    }
  };

  const describeAll = async (servers) => {
    await Promise.allSettled(servers.map(s => s.fetchDescription()));
    return servers.map(s => s.toJSON());
  };

  const requireServer = (usn) => {
    const server = scanner.find(usn);
    if (!server) throw new Error('Server not found. Scan again.');
    return server;
  };

  context.registerRemoteHandler('upnp:scan', async () => describeAll(await scanner.scan()));

  context.registerRemoteHandler('upnp:get-servers', () => scanner.getServers().map(s => s.toJSON()));

  context.registerRemoteHandler('upnp:browse', async ({ usn, objectId = '0' } = {}) => {
    return requireServer(usn).browse(objectId || '0');
  });

  context.registerRemoteHandler('upnp:search', async ({ usn, query, objectId = '0' } = {}) => {
    if (!query || !String(query).trim()) return [];
    return requireServer(usn).search(String(query).trim(), objectId || '0');
  });

  context.registerRemoteHandler('upnp:list-recursive', async ({ usn, objectId = '0', limit } = {}) => {
    return requireServer(usn).listRecursive(objectId || '0', Math.min(5000, Number(limit) || 3000));
  });

  context.registerRemoteHandler('upnp:add-server', async ({ location } = {}) => {
    const server = await scanner.addManual(location);
    persistManual();
    return server.toJSON();
  });

  context.registerRemoteHandler('upnp:remove-server', ({ usn } = {}) => {
    scanner.remove(usn);
    persistManual();
    return { ok: true };
  });

  const announce = (channel) => (servers) => describeAll(servers).then((list) => {
    context.broadcast(channel, { servers: list });
    return list;
  });

  // Restore manually added servers, then auto-scan.
  (async () => {
    for (const location of Array.isArray(settings.manualServers) ? settings.manualServers : []) {
      try { await scanner.addManual(location); } catch (err) {
        console.warn('[upnp] saved server unreachable:', location, err?.message ?? err);
      }
    }
    try {
      const list = await scanner.scan().then(announce('upnp:servers-found'));
      console.log(`[upnp] Scan complete. Found ${list.length} server(s):`, list.map(s => s.friendlyName));
    } catch (err) {
      console.error('[upnp] Auto-scan failed:', err);
    }
  })();

  const scanIntervalMs = Math.max(10000, Number(settings.scanIntervalMs) || 30000);
  if (rescanTimer) clearInterval(rescanTimer);
  rescanTimer = setInterval(() => {
    scanner.scan().then(announce('upnp:servers-updated')).catch(() => {});
  }, scanIntervalMs);
  if (typeof rescanTimer.unref === 'function') rescanTimer.unref();

  console.log('[upnp] UPnP/DLNA plugin activated');
}

export function deactivate() {
  if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
}

// Exposed for tests.
export const __test = { parseDIDL, decodeXmlEntities, parseDuration, pickResource, xmlTag };
