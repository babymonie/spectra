import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

// Exercise the real server while substituting Electron's user-data directory.
async function loadServer() {
  let source = await fs.readFile(path.join(root, 'remoteServer.js'), 'utf8');
  source = source.replace("const require = createRequire(import.meta.url);", '')
    .replace("const { app } = require('electron');", 'const app = { getPath: () => process.cwd() };');
  for (const name of ['express', 'socket.io']) {
    source = source.replace(`from '${name}'`, `from '${pathToFileURL(require.resolve(name)).href}'`);
  }
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
}

test('remote server awaits readiness, handles port conflicts, stops and restarts', async () => {
  const RemoteServer = await loadServer();
  const server = new RemoteServer(path.join(root, 'renderer'), async () => 'ok');
  const conflict = new RemoteServer(path.join(root, 'renderer'), async () => 'ok');
  try {
    await Promise.all([server.start(0, '127.0.0.1'), server.start(0, '127.0.0.1')]);
    assert.equal(server.isRunning, true);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('/socket.io/socket.io.js'));
    assert.ok(html.includes('src="web-client.js"'));
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/socket.io/?EIO=4&transport=websocket`);
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Remote command timed out')), 3000);
        socket.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('Remote socket failed'));
        });
        socket.addEventListener('message', ({ data }) => {
          const packet = String(data);
          if (packet.startsWith('0')) socket.send('40');
          else if (packet.startsWith('40')) {
            socket.send('42' + JSON.stringify(['invoke', { id: 'test', channel: 'audio:pause', args: [] }]));
          } else if (packet.startsWith('42')) {
            clearTimeout(timer);
            resolve(JSON.parse(packet.slice(2)));
          }
        });
      });
      assert.deepEqual(result, ['response', { id: 'test', result: 'ok' }]);
    } finally {
      socket.close();
    }
    await assert.rejects(conflict.start(server.port, '127.0.0.1'), { code: 'EADDRINUSE' });
    assert.equal(conflict.isRunning, false);
    await Promise.all([server.stop(), server.stop()]);
    assert.equal(server.isRunning, false);
    await server.start(0, '127.0.0.1');
    assert.equal(server.isRunning, true);
  } finally {
    await server.stop();
    await conflict.stop();
  }
});

test('plugin URL construction preserves special characters and round trips paths', async () => {
  const source = await fs.readFile(path.join(root, 'main.js'), 'utf8');
  assert.ok(source.includes('const pluginUrl = pathToFileURL(pluginMainPath);'));
  for (const file of ['/Applications/Spectra #1/plugins/a%20b.js', 'C:\\Music #1\\plugins\\a%20b.js']) {
    const resolved = path.resolve(file);
    assert.equal(fileURLToPath(pathToFileURL(resolved)), resolved);
  }
});

test('version bump runs as ESM from another working directory and avoids recursion', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'spectra-version-'));
  const git = (...args) => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' });
  try {
    await fs.mkdir(path.join(fixture, 'scripts'));
    await fs.copyFile(path.join(root, 'scripts/post-commit-bump.js'), path.join(fixture, 'scripts/post-commit-bump.js'));
    await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.25' }));
    git('init');
    git('config', 'user.name', 'Regression Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'core.hooksPath', '.disabled-hooks');
    git('add', '.');
    git('commit', '-m', 'Initial fixture');
    const run = () => execFileSync(process.execPath, [path.join(fixture, 'scripts/post-commit-bump.js')], { cwd: os.tmpdir(), stdio: 'pipe' });
    run();
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture, 'package.json'))).version, '1.0.26');
    const commit = git('rev-parse', 'HEAD').toString();
    run();
    assert.equal(git('rev-parse', 'HEAD').toString(), commit);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
