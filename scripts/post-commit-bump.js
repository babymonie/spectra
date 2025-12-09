#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function lastCommitMessage() {
  try {
    return execSync('git log -1 --pretty=%B').toString().trim();
  } catch (e) {
    return '';
  }
}

// Avoid creating a bump commit for bump commits (prevents infinite loop)
const lastMsg = lastCommitMessage();
if (/^chore: bump version to /i.test(lastMsg)) {
  process.exit(0);
}

const pkgPath = path.join(__dirname, '..', 'package.json');
if (!fs.existsSync(pkgPath)) {
  console.error('package.json not found at', pkgPath);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = (pkg.version || '0.0.0').toString();
const parts = version.split('.').map(n => Number(n) || 0);
if (parts.length < 3) {
  while (parts.length < 3) parts.push(0);
}
parts[2] = parts[2] + 1; // bump patch
const newVersion = parts.join('.');
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

try {
  execSync('git add package.json');
  execSync(`git commit -m "chore: bump version to ${newVersion}"`);
  console.log('Bumped package.json to', newVersion);
} catch (e) {
  console.error('Failed to create bump commit:', e && e.message ? e.message : e);
  process.exit(1);
}
