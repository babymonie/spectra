#!/usr/bin/env node
// playFlac.js
// Simple Node ESM script to play a FLAC (or other audio) file using audioEngine.js

import audioEngine from './audioEngine.js';

function printUsage() {
  console.log('Usage: node playFlac.js <file.flac> [--deviceId=<id>] [--mode=exclusive|shared]');
  console.log('Example: node playFlac.js "C:\\Music\\track.flac" --mode=exclusive');
}

function parseArgs(argv) {
  const args = { deviceId: undefined, mode: undefined, bitPerfect: false };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--deviceId=')) args.deviceId = a.split('=')[1];
    else if (a.startsWith('--mode=')) args.mode = a.split('=')[1];
    else if (a === '--bitPerfect') args.bitPerfect = true;
    else rest.push(a);
  }
  return { file: rest[0], deviceId: args.deviceId, mode: args.mode, bitPerfect: args.bitPerfect };
}

async function main() {
  const { file, deviceId, mode, bitPerfect } = parseArgs(process.argv);
  if (!file) {
    printUsage();
    process.exit(2);
  }

  console.log('[playFlac] Starting playback for', file);
  if (deviceId) console.log('[playFlac] deviceId=', deviceId);
  if (mode) console.log('[playFlac] mode=', mode);

  let stopped = false;

  const stopAndExit = (code = 0) => {
    if (stopped) return;
    stopped = true;
    try { audioEngine.stop(); } catch (_) {}
    process.exit(code);
  };

  process.on('SIGINT', () => {
    console.log('\n[playFlac] Caught SIGINT, stopping...');
    stopAndExit(0);
  });

  try {
    await new Promise((resolve, reject) => {
      audioEngine.playFile(
        file,
        () => {
          console.log('[playFlac] Playback finished');
          resolve();
        },
        (err) => {
          console.error('[playFlac] Playback error:', err && err.message ? err.message : err);
          reject(err);
        },
        { deviceId: deviceId, mode: mode, bitPerfect: bitPerfect }
      );
    });
  } catch (err) {
    console.error('[playFlac] Error during playback:', err && err.message ? err.message : err);
    stopAndExit(1);
  }

  stopAndExit(0);
}

main();
