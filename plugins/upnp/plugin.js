/**
 * UPnP/DLNA plugin for Spectra.
 *
 * Discovers media servers via SSDP, browses ContentDirectory via SOAP,
 * and provides streaming URLs that FFmpeg can handle directly.
 *
 * No external npm dependencies required — uses Node's built-in dgram + http.
 */

import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

const MEDIA_SERVER_ST = [
  'urn:schemas-upnp-org:device:MediaServer:1',
  'urn:schemas-upnp-org:service:ContentDirectory:1',
];

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

/** Perform SOAP POST, return body string */
function soapPost(url, serviceType, action, bodyXml, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const soap = `<?xml version="1.0"?>
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
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SOAP timeout')); });
    req.write(body);
    req.end();
  });
}

/** Minimal XML tag value extractor (avoids xml2js dependency) */
function xmlTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function xmlTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

/** Parse DIDL-Lite items from ContentDirectory Browse response */
function parseDIDL(didl) {
  const items = [];
  const itemRe = /<item\s[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(didl)) !== null) {
    const block = m[1];
    const id = m[0].match(/id="([^"]+)"/)?.[1] || '';
    const title = xmlTag(block, 'dc:title') || xmlTag(block, 'title') || '';
    const artist = xmlTag(block, 'upnp:artist') || xmlTag(block, 'artist') || '';
    const album = xmlTag(block, 'upnp:album') || xmlTag(block, 'album') || '';
    const duration = block.match(/duration="([^"]+)"/)?.[1] || '';
    const resMatch = block.match(/<res[^>]*>([^<]+)<\/res>/i);
    const url = resMatch ? resMatch[1].trim() : '';
    const mime = block.match(/protocolInfo="[^:]+:[^:]+:([^:]+):[^"]*"/)?.[1] || '';
    if (url) items.push({ id, title, artist, album, duration, url, mime, type: 'track' });
  }

  const containerRe = /<container\s[^>]*>([\s\S]*?)<\/container>/gi;
  while ((m = containerRe.exec(didl)) !== null) {
    const block = m[1];
    const id = m[0].match(/id="([^"]+)"/)?.[1] || '';
    const title = xmlTag(block, 'dc:title') || xmlTag(block, 'title') || '';
    if (id) items.push({ id, title, type: 'container' });
  }

  return items;
}

class UPnPServer {
  constructor(location, usn) {
    this.location = location;
    this.usn = usn;
    this.friendlyName = '';
    this.contentDirectoryUrl = null;
    this.serviceType = 'urn:schemas-upnp-org:service:ContentDirectory:1';
  }

  async fetchDescription() {
    const xml = await httpGet(this.location);
    this.friendlyName = xmlTag(xml, 'friendlyName') || this.usn;

    // Find ContentDirectory service control URL
    const serviceBlocks = xmlTags(xml, 'service');
    for (const svc of serviceBlocks) {
      const st = xmlTag(svc, 'serviceType') || '';
      if (st.includes('ContentDirectory')) {
        const controlPath = xmlTag(svc, 'controlURL') || '';
        if (controlPath) {
          const base = new URL(this.location);
          this.contentDirectoryUrl = new URL(controlPath, base).href;
          this.serviceType = st.trim();
        }
        break;
      }
    }
    return this;
  }

  async browse(objectId = '0', browseFlag = 'BrowseDirectChildren', start = 0, count = 200) {
    if (!this.contentDirectoryUrl) throw new Error('No ContentDirectory URL');
    const body = `<u:Browse xmlns:u="${this.serviceType}">
  <ObjectID>${objectId}</ObjectID>
  <BrowseFlag>${browseFlag}</BrowseFlag>
  <Filter>*</Filter>
  <StartingIndex>${start}</StartingIndex>
  <RequestedCount>${count}</RequestedCount>
  <SortCriteria></SortCriteria>
</u:Browse>`;
    const resp = await soapPost(this.contentDirectoryUrl, this.serviceType, 'Browse', body);
    const result = xmlTag(resp, 'Result') || '';
    // Decode HTML entities in DIDL
    const didl = result
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    return parseDIDL(didl);
  }
}

class UPnPScanner {
  constructor(settings = {}) {
    this._mx = settings.ssdpMx ?? 3;
    this._servers = new Map(); // usn → UPnPServer
    this._scanning = false;
  }

  scan() {
    return new Promise((resolve) => {
      if (this._scanning) { resolve(this.getServers()); return; }
      this._scanning = true;
      const found = new Map();
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      const finish = () => {
        this._scanning = false;
        sock.close();
        resolve(Array.from(found.values()));
      };

      const timeout = setTimeout(finish, (this._mx + 1) * 1000);

      sock.on('error', () => { clearTimeout(timeout); finish(); });

      sock.on('message', (msg) => {
        const text = msg.toString('utf8');
        if (!/HTTP\/1\.[01]\s+200/i.test(text) && !/NOTIFY/i.test(text)) return;
        const location = text.match(/LOCATION:\s*(\S+)/i)?.[1];
        const usn = text.match(/USN:\s*(\S+)/i)?.[1] || location;
        const st = text.match(/\bST:\s*(\S+)/i)?.[1] || '';
        const nt = text.match(/\bNT:\s*(\S+)/i)?.[1] || '';
        const isMediaServer = [st, nt].some(v =>
          v.includes('MediaServer') || v.includes('ContentDirectory')
        );
        if (location && isMediaServer && !found.has(usn)) {
          found.set(usn, new UPnPServer(location, usn));
          this._servers.set(usn, found.get(usn));
        }
      });

      sock.bind(0, () => {
        for (const searchTarget of MEDIA_SERVER_ST) {
          const msg = Buffer.from(
            `M-SEARCH * HTTP/1.1\r\n` +
            `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
            `MAN: "ssdp:discover"\r\n` +
            `MX: ${this._mx}\r\n` +
            `ST: ${searchTarget}\r\n\r\n`
          );
          sock.send(msg, SSDP_PORT, SSDP_ADDR);
        }
      });
    });
  }

  getServers() { return Array.from(this._servers.values()); }
}

// ─── Plugin activation ────────────────────────────────────────────────────────

export function activate(context) {
  const scanner = new UPnPScanner(context.settings || {});

  context.registerRemoteHandler('upnp:scan', async () => {
    const servers = await scanner.scan();
    const descs = await Promise.allSettled(servers.map(s => s.fetchDescription()));
    return servers.map(s => ({
      usn: s.usn,
      location: s.location,
      friendlyName: s.friendlyName,
      hasContentDirectory: !!s.contentDirectoryUrl,
    }));
  });

  context.registerRemoteHandler('upnp:browse', async ({ usn, objectId = '0' }) => {
    const server = scanner.getServers().find(s => s.usn === usn);
    if (!server) throw new Error('Server not found. Run upnp:scan first.');
    if (!server.contentDirectoryUrl) await server.fetchDescription();
    return server.browse(objectId);
  });

  context.registerRemoteHandler('upnp:get-servers', () => {
    return scanner.getServers().map(s => ({
      usn: s.usn,
      location: s.location,
      friendlyName: s.friendlyName,
      hasContentDirectory: !!s.contentDirectoryUrl,
    }));
  });

  // Auto-scan on startup
  scanner.scan().then(async (servers) => {
    await Promise.allSettled(servers.map(s => s.fetchDescription()));
    if (servers.length) {
      console.log(`[upnp] Found ${servers.length} UPnP/DLNA server(s):`,
        servers.map(s => s.friendlyName || s.usn));
      context.broadcast('upnp:servers-found', {
        servers: servers.map(s => ({
          usn: s.usn,
          friendlyName: s.friendlyName,
          hasContentDirectory: !!s.contentDirectoryUrl,
        })),
      });
    }
  }).catch(() => {});

  // Periodic rescan
  const scanIntervalMs = Math.max(10000, context.settings?.scanIntervalMs ?? 30000);
  setInterval(() => {
    scanner.scan().then(async (servers) => {
      await Promise.allSettled(servers.map(s => s.fetchDescription()));
      context.broadcast('upnp:servers-updated', {
        servers: servers.map(s => ({
          usn: s.usn,
          friendlyName: s.friendlyName,
          hasContentDirectory: !!s.contentDirectoryUrl,
        })),
      });
    }).catch(() => {});
  }, scanIntervalMs);

  console.log('[upnp] UPnP/DLNA plugin activated');
}
