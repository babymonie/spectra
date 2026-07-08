const { spawnSync } = require('node:child_process');

const command = 'npx';
const result = spawnSync(command, ['electron-rebuild', '-f'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.warn('[postinstall] electron-rebuild skipped:', result.error.message);
  process.exit(0);
}

if (result.status !== 0) {
  console.warn(`[postinstall] electron-rebuild failed with exit ${result.status}; continuing`);
}

process.exit(0);