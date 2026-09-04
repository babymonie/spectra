import https from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: CURRENT_VERSION } = require('./package.json');

const REPO_OWNER = 'babymonie';
const REPO_NAME = 'spectra';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // re-check every 4 hours

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
        method: 'GET',
        timeout: 10_000,
        headers: {
          'User-Agent': `Spectra/${CURRENT_VERSION}`,
          'Accept': 'application/vnd.github+json',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const data = JSON.parse(body);
            if (!data.tag_name) { reject(new Error('no tag_name in response')); return; }
            resolve({
              version: data.tag_name.replace(/^v/i, ''),
              url: data.html_url || `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
              prerelease: !!data.prerelease,
            });
          } catch (e) { reject(e); }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function parseSemver(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [+m[1], +m[2], +m[3]];
}

/**
 * Returns 'major', 'minor', or null (up to date / older).
 * Minor bucket covers both minor and patch bumps — both show "minor update needed".
 */
function classifyUpdate(current, latest) {
  const c = parseSemver(current);
  const l = parseSemver(latest);
  if (!c || !l) return null;
  if (l[0] > c[0]) return 'major';
  if (l[0] === c[0] && (l[1] > c[1] || (l[1] === c[1] && l[2] > c[2]))) return 'minor';
  return null;
}

/**
 * Start background update checker.
 * @param {function} broadcast  - fn(channel, payload) to push to renderer
 */
export function startUpdateChecker(broadcast) {
  const check = async () => {
    try {
      const { version: latestVersion, url, prerelease } = await fetchLatestRelease();
      if (prerelease) return; // ignore pre-releases
      const updateType = classifyUpdate(CURRENT_VERSION, latestVersion);
      if (updateType) {
        console.log(`[update] ${updateType} update available: ${CURRENT_VERSION} → ${latestVersion}`);
        broadcast('update:available', {
          type: updateType,
          currentVersion: CURRENT_VERSION,
          latestVersion,
          url,
        });
      }
    } catch (e) {
      // Silently swallow — no network, rate limit, private repo, etc.
      if (process.env.NODE_ENV === 'development') {
        console.warn('[update] check failed:', e?.message ?? e);
      }
    }
  };

  // Initial check shortly after startup (don't block app load)
  setTimeout(check, 8_000);

  // Periodic re-check
  setInterval(check, CHECK_INTERVAL_MS);
}

export { CURRENT_VERSION };
