/**
 * cueParser.js — Parse .cue sheets into virtual track descriptors.
 *
 * Supports: FILE / TRACK / INDEX / TITLE / PERFORMER / REM GENRE / REM DATE
 * Output tracks carry { title, performer, album, genre, year, startSec, endSec, filePath, trackNumber }
 * endSec is null for the last track (play to EOF).
 */

import fs from 'node:fs';
import path from 'node:path';

/** Parse MM:SS:FF timestamp → seconds (CD frames = 1/75 sec) */
function parseTimestamp(s) {
  const parts = String(s || '').split(':');
  if (parts.length < 2) return 0;
  const mm = parseInt(parts[0], 10) || 0;
  const ss = parseInt(parts[1], 10) || 0;
  const ff = parseInt(parts[2] || '0', 10) || 0;
  return mm * 60 + ss + ff / 75;
}

export function parseCueSheet(cueContent, cueDir) {
  const lines = cueContent.split(/\r?\n/);
  const tracks = [];
  let currentFile = null;
  let currentTrack = null;
  let albumTitle = '';
  let albumPerformer = '';
  let genre = '';
  let year = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const fileMatch = line.match(/^FILE\s+"?([^"]+)"?\s+\w+/i);
    if (fileMatch) {
      const rel = fileMatch[1];
      currentFile = path.isAbsolute(rel) ? rel : path.join(cueDir, rel);
      continue;
    }

    if (/^PERFORMER\s+/i.test(line) && !currentTrack) {
      albumPerformer = line.replace(/^PERFORMER\s+/i, '').replace(/^"|"$/g, '');
      continue;
    }
    if (/^TITLE\s+/i.test(line) && !currentTrack) {
      albumTitle = line.replace(/^TITLE\s+/i, '').replace(/^"|"$/g, '');
      continue;
    }
    if (/^REM\s+GENRE\s+/i.test(line)) {
      genre = line.replace(/^REM\s+GENRE\s+/i, '').replace(/^"|"$/g, '');
      continue;
    }
    if (/^REM\s+DATE\s+/i.test(line)) {
      year = line.replace(/^REM\s+DATE\s+/i, '').replace(/^"|"$/g, '').slice(0, 4);
      continue;
    }

    const trackMatch = line.match(/^TRACK\s+(\d+)\s+AUDIO/i);
    if (trackMatch) {
      if (currentTrack) tracks.push(currentTrack);
      currentTrack = {
        trackNumber: parseInt(trackMatch[1], 10),
        title: '',
        performer: albumPerformer,
        album: albumTitle,
        genre,
        year,
        filePath: currentFile,
        startSec: 0,
        endSec: null,
      };
      continue;
    }

    if (!currentTrack) continue;

    if (/^TITLE\s+/i.test(line)) {
      currentTrack.title = line.replace(/^TITLE\s+/i, '').replace(/^"|"$/g, '');
      continue;
    }
    if (/^PERFORMER\s+/i.test(line)) {
      currentTrack.performer = line.replace(/^PERFORMER\s+/i, '').replace(/^"|"$/g, '');
      continue;
    }
    const indexMatch = line.match(/^INDEX\s+(\d+)\s+(\d+:\d+:\d+)/i);
    if (indexMatch && indexMatch[1] === '01') {
      currentTrack.startSec = parseTimestamp(indexMatch[2]);
    }
  }

  if (currentTrack) tracks.push(currentTrack);

  // Set endSec for each track = startSec of next (same file), null for last
  for (let i = 0; i < tracks.length - 1; i++) {
    if (tracks[i].filePath === tracks[i + 1].filePath) {
      tracks[i].endSec = tracks[i + 1].startSec;
    }
  }

  return tracks;
}

/** Load a .cue file from disk and return parsed tracks */
export function loadCueFile(cuePath) {
  const content = fs.readFileSync(cuePath, 'utf8');
  return parseCueSheet(content, path.dirname(cuePath));
}

/**
 * Encode a virtual cue track reference into a path string.
 * Format: <audioFile>\x00cue\x00<startSec>\x00<endSec|->
 */
export function encodeCueTrackPath(audioFile, startSec, endSec) {
  return `${audioFile}\x00cue\x00${startSec}\x00${endSec ?? '-'}`;
}

/** Decode a cue track path. Returns null if not a cue path. */
export function decodeCueTrackPath(p) {
  if (!p || !p.includes('\x00cue\x00')) return null;
  const parts = p.split('\x00cue\x00');
  if (parts.length < 2) return null;
  const [audioFile, rest] = [parts[0], parts[1]];
  const [startStr, endStr] = rest.split('\x00');
  const startSec = parseFloat(startStr);
  const endSec = endStr && endStr !== '-' ? parseFloat(endStr) : null;
  return { audioFile, startSec, endSec: Number.isFinite(endSec) ? endSec : null };
}
