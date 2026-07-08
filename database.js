import initSqlJs from 'sql.js';
import path from 'path';
import { createRequire } from 'node:module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { app } = require('electron');
const userDataPath = app.getPath('userData');
console.log('User Data Path:', userDataPath);
const dbPath = path.join(userDataPath, 'spectra.db');

let db = null;

// Initialize sql.js database
const initDb = async () => {
  const SQL = await initSqlJs();
  try {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } catch (err) {
    console.debug?.('[database] creating new sqlite database', err?.message);
    db = new SQL.Database();
  }
};

// Save database to disk
const saveDb = () => {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(dbPath, data);
};

// Helper to run SQL and save
const run = (sql, params = []) => {
  if (!db) throw new Error('Database not initialized');
  db.run(sql, params);
  saveDb();
};

// Helper to get one row
const get = (sql, params = []) => {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const result = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return result;
};

// Helper to get all rows
const all = (sql, params = []) => {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
};

const TRACK_UPDATEABLE_COLUMNS = new Set([
  'path',
  'title',
  'artist',
  'album',
  'album_artist',
  'duration',
  'format',
  'cover_path',
  'lyrics',
  'bitrate',
  'sample_rate',
  'bit_depth',
  'channels',
  'lossless',
  'quality_score',
  'codec',
]);

const normalizeValue = (value) => (typeof value === 'string' ? value.trim() : value);
const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const toKey = (value) => normalizeText(value).toLowerCase();
const UNKNOWN_ARTIST_RE = /^(unknown|unknown artist|<unknown>|n\/?a|none|null|-|—)$/i;
const isMeaningfulArtistName = (value) => {
  const name = normalizeText(value);
  return !!name && !UNKNOWN_ARTIST_RE.test(name);
};
const splitArtistNames = (value) => {
  const raw = normalizeText(value);
  if (!isMeaningfulArtistName(raw)) return [];
  return raw
    .replace(/\s+(feat\.?|ft\.?|featuring|with)\s+/gi, ';')
    .split(/\s*(?:,|;|\/|\||&|\band\b)\s*/i)
    .map(normalizeText)
    .filter(isMeaningfulArtistName);
};
const canonicalArtistName = (value) => {
  const cleaned = normalizeText(value);
  return isMeaningfulArtistName(cleaned) ? cleaned : 'Unknown Artist';
};
const getTrackArtistNames = (row) => {
  const artists = splitArtistNames(row?.artist);
  if (artists.length) return artists;
  return splitArtistNames(row?.album_artist);
};
const getAlbumArtistName = (row) => {
  if (isMeaningfulArtistName(row?.album_artist)) return canonicalArtistName(row.album_artist);
  const artists = splitArtistNames(row?.artist);
  return artists[0] || 'Unknown Artist';
};

export const updateTrackFields = (id, updates = {}) => {
  if (!db) return { changes: 0 };
  if (!id) return { changes: 0 };
  const entries = Object.entries(updates).filter(([key, value]) => TRACK_UPDATEABLE_COLUMNS.has(key) && value !== undefined);
  if (entries.length === 0) return { changes: 0 };

  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const params = entries.map(([, value]) => normalizeValue(value));
  params.push(id);

  run(`UPDATE tracks SET ${assignments} WHERE id = ?`, params);
  return { changes: 1 };
};

// Initialize schema
const initSchema = () => {
  if (!db) return;
  
  db.run(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      title TEXT,
      artist TEXT,
      album TEXT,
      album_artist TEXT,
      duration REAL,
      format TEXT,
      cover_path TEXT,
      lyrics TEXT,
      bitrate INTEGER,
      sample_rate INTEGER,
      bit_depth INTEGER,
      channels INTEGER,
      lossless INTEGER,
      quality_score REAL,
      codec TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: Add columns if they don't exist (for existing DBs)
  try {
    db.run('ALTER TABLE tracks ADD COLUMN cover_path TEXT');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN album_artist TEXT');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN lyrics TEXT');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN bitrate INTEGER');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN sample_rate INTEGER');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN bit_depth INTEGER');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN channels INTEGER');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN lossless INTEGER');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN quality_score REAL');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }
  try {
    db.run('ALTER TABLE tracks ADD COLUMN codec TEXT');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }

  // Ensure playlists.updated_at exists for older DBs
  try {
    db.run('ALTER TABLE playlists ADD COLUMN updated_at DATETIME');
  } catch (err) {
    if (err) {
      // Column likely already exists
    }
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id INTEGER,
      track_id INTEGER,
      track_order INTEGER,
      FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE,
      PRIMARY KEY (playlist_id, track_id)
    )
  `);
  
  saveDb();
};

// Initialize database asynchronously
await initDb();
initSchema();

export const addTrack = (track) => {
  if (!db) return null;
  const sql = `
    INSERT INTO tracks (
      path, title, artist, album, album_artist, duration, format, cover_path,
      bitrate, sample_rate, bit_depth, channels, lossless, quality_score, codec
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    track.path,
    track.title,
    track.artist,
    track.album,
    track.album_artist,
    track.duration,
    track.format,
    track.cover_path,
    track.bitrate ?? null,
    track.sample_rate ?? null,
    track.bit_depth ?? null,
    track.channels ?? null,
    track.lossless ?? null,
    track.quality_score ?? null,
    track.codec ?? null,
  ];

  try {
    const stmt = db.prepare(sql);
    stmt.run(params);
    stmt.free();
    saveDb();
    return get('SELECT * FROM tracks WHERE path = ? LIMIT 1', [track.path]);
  } catch (err) {
    const message = String(err?.message || err);
    if (message.includes('UNIQUE constraint failed: tracks.path')) {
      const existing = get('SELECT * FROM tracks WHERE path = ? LIMIT 1', [track.path]);
      if (existing?.id) {
        updateTrackFields(existing.id, track);
        return get('SELECT * FROM tracks WHERE id = ? LIMIT 1', [existing.id]);
      }
      return existing;
    }
    throw err;
  }
};

export const getAllTracks = () => {
  return all('SELECT * FROM tracks ORDER BY title ASC');
};

export const getTrackByPath = (filePath) => {
  return get('SELECT * FROM tracks WHERE path = ?', [filePath]);
};

export const getTrackById = (id) => {
  return get('SELECT * FROM tracks WHERE id = ?', [id]);
};

const toLower = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export const findTracksByTitleArtist = (title, artist) => {
  if (!db) return [];
  if (!title || !artist) return [];
  return all(
    `SELECT * FROM tracks WHERE LOWER(title) = ? AND LOWER(artist) = ?`,
    [toLower(title), toLower(artist)]
  );
};

export const updateTrackLyrics = (id, lyrics) => {
  run('UPDATE tracks SET lyrics = ? WHERE id = ?', [lyrics, id]);
  return { changes: 1 };
};

export const createPlaylist = (name) => {
  run('INSERT INTO playlists (name) VALUES (?)', [name]);
  return { lastInsertRowid: db.exec('SELECT last_insert_rowid() as id')[0].values[0][0] };
};

export const getAllPlaylists = () => {
  // Include per-playlist track count in a single query so the UI doesn't have
  // to fan out one getPlaylistTracks call per playlist to render counts.
  return all(`
    SELECT p.*, COALESCE(c.cnt, 0) AS track_count
    FROM playlists p
    LEFT JOIN (
      SELECT playlist_id, COUNT(*) AS cnt FROM playlist_tracks GROUP BY playlist_id
    ) c ON c.playlist_id = p.id
    ORDER BY p.name ASC
  `);
};

export const addTrackToPlaylist = (playlistId, trackId) => {
  // Get current max order
  const maxOrderRow = get('SELECT MAX(track_order) as maxOrder FROM playlist_tracks WHERE playlist_id = ?', [playlistId]);
  const maxOrder = maxOrderRow?.maxOrder || 0;
  
  try {
    run('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, track_order) VALUES (?, ?, ?)', [playlistId, trackId, maxOrder + 1]);
    run('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [playlistId]);
  } catch (err) {
    if (err) {
      // ignore
    }
  }
  return { changes: 1 };
};

export const renamePlaylist = (playlistId, newName) => {
  run('UPDATE playlists SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newName, playlistId]);
  return { changes: 1 };
};

export const deletePlaylist = (playlistId) => {
  run('DELETE FROM playlists WHERE id = ?', [playlistId]);
  return { changes: 1 };
};

export const removeTrackFromPlaylist = (playlistId, trackId) => {
  run('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?', [playlistId, trackId]);
  try {
    run('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [playlistId]);
  } catch (err) {
    if (err) {
      // ignore
    }
  }
  return { changes: 1 };
};

export const reorderPlaylist = (playlistId, orderedTrackIds = []) => {
  // Treat orderedTrackIds as the *complete* desired track set, not just a
  // reordering of existing rows. This lets the playlist editor use one call
  // for both removals and ordering, and keeps the operation atomic from the
  // UI's perspective.
  if (!db) return { ok: false };
  const ids = [];
  const seen = new Set();
  for (const rawId of orderedTrackIds) {
    if (rawId == null) continue;
    const id = Number(rawId);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const existing = all('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?', [playlistId]);
  const keepSet = new Set(ids);
  for (const row of existing) {
    if (!keepSet.has(Number(row.track_id))) {
      run('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?', [playlistId, row.track_id]);
    }
  }
  let i = 1;
  for (const tid of ids) {
    // Upsert: update if present, otherwise insert (covers the case where the
    // editor added brand new tracks).
    run(
      'INSERT INTO playlist_tracks (playlist_id, track_id, track_order) VALUES (?, ?, ?) ON CONFLICT(playlist_id, track_id) DO UPDATE SET track_order = excluded.track_order',
      [playlistId, tid, i]
    );
    i++;
  }
  run('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [playlistId]);
  return { ok: true };
};

export const getPlaylistTracks = (playlistId) => {
  return all(`
    SELECT t.* 
    FROM tracks t
    JOIN playlist_tracks pt ON t.id = pt.track_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.track_order ASC
  `, [playlistId]);
};

export const removeTrack = (id) => {
  run('DELETE FROM tracks WHERE id = ?', [id]);
  return { changes: 1 };
};

export const deleteAlbum = (albumName, artistName) => {
  // Delete all tracks matching the album (and optionally album_artist)
  // Use case-insensitive comparison
  let sql = 'DELETE FROM tracks WHERE LOWER(TRIM(album)) = LOWER(TRIM(?))';
  const params = [albumName || ''];
  
  if (artistName) {
    sql += ' AND (LOWER(TRIM(album_artist)) = LOWER(TRIM(?)) OR LOWER(TRIM(artist)) = LOWER(TRIM(?)))';
    params.push(artistName, artistName);
  }
  
  // First count how many will be deleted
  let countSql = sql.replace('DELETE FROM', 'SELECT COUNT(*) as count FROM');
  const countResult = get(countSql, params);
  const count = countResult?.count || 0;
  
  // Now delete
  run(sql, params);
  
  return { deleted: count };
};

export const updateTrack = (id, updates = {}) => {
  return updateTrackFields(id, updates);
};
export const updateTrackPath = (id, filePath) => {
  run('UPDATE tracks SET path = ? WHERE id = ?', [filePath, id]);
  return { changes: 1 };
};

export const updateTrackWithAlbumArtist = (id, { title, artist, album, albumArtist }) => {
  run('UPDATE tracks SET title = ?, artist = ?, album = ?, album_artist = ? WHERE id = ?', [title, artist, album, albumArtist, id]);
  return { changes: 1 };
};

export const getAlbumArtist = (album, artistFallback) => {
  if (!album || typeof album !== 'string') return null;
  
  // Early return if no tracks exist yet
  try {
    const count = get('SELECT COUNT(*) as cnt FROM tracks');
    if (!count || count.cnt === 0) return null;
  } catch (err) {
    console.error('[database] getAlbumArtist: table check failed', err);
    return null;
  }
  
  try {
    // Prefer an explicit album_artist if present
    const explicit = get('SELECT album_artist FROM tracks WHERE album = ? AND album_artist IS NOT NULL AND album_artist != ? LIMIT 1', [album, '']);
    if (explicit?.album_artist) return explicit.album_artist;
    
    // Most common artist for this album
    const row = get(`
      SELECT artist, COUNT(*) as cnt
      FROM tracks
      WHERE album = ? AND artist IS NOT NULL
      GROUP BY artist
      ORDER BY cnt DESC
      LIMIT 1
    `, [album]);
    if (row?.artist) return row.artist;
    
    if (artistFallback) {
      const r2 = get('SELECT artist FROM tracks WHERE album = ? AND artist = ? LIMIT 1', [album, artistFallback]);
      return r2?.artist || null;
    }
    return null;
  } catch (err) {
    console.error('[database] getAlbumArtist error for album:', album, err);
    return null;
  }
};
export const getAlbumTracks = (albumName, artistName = null) => {
  if (!db) return [];
  if (!albumName) return [];

  const rows = all(
    `
    SELECT *
    FROM tracks
    WHERE LOWER(TRIM(album)) = LOWER(TRIM(?))
    ORDER BY
      CASE WHEN title IS NULL OR title = '' THEN 1 ELSE 0 END,
      title ASC,
      path ASC
  `,
    [albumName]
  );

  if (!artistName || !normalizeText(artistName)) {
    return rows;
  }

  const targetKey = toKey(canonicalArtistName(artistName));
  return rows.filter((t) => {
    const albumArtist = getAlbumArtistName(t);
    if (toKey(albumArtist) === targetKey) return true;
    return getTrackArtistNames(t).some((name) => toKey(name) === targetKey);
  });
};

export const getAlbums = () => {
  const rows = all(`
    SELECT album, artist, album_artist, cover_path
    FROM tracks
    WHERE album IS NOT NULL AND TRIM(album) != ''
  `);

  const groups = new Map();
  for (const row of rows) {
    const albumName = normalizeText(row?.album);
    if (!albumName) continue;
    const albumArtist = getAlbumArtistName(row);
    const albumKey = `${toKey(albumArtist)}::${toKey(albumName)}`;
    if (!groups.has(albumKey)) {
      groups.set(albumKey, {
        name: albumName,
        artist: albumArtist,
        track_count: 0,
        cover_path: '',
      });
    }
    const g = groups.get(albumKey);
    g.track_count += 1;
    if (!g.cover_path && normalizeText(row?.cover_path)) g.cover_path = row.cover_path;
    if (g.artist === 'Unknown Artist' && isMeaningfulArtistName(albumArtist)) g.artist = albumArtist;
  }

  const out = Array.from(groups.values()).map((g) => ({
    name: g.name,
    cover_path: g.cover_path || '',
    track_count: g.track_count || 0,
    artist: g.artist || 'Unknown Artist',
  }));

  out.sort((a, b) =>
    String(a.artist || '').localeCompare(String(b.artist || ''), undefined, { sensitivity: 'base' }) ||
    String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
  );
  return out;
};

export const getArtists = () => {
  const rows = all(`
    SELECT artist, album_artist, album, cover_path
    FROM tracks
    WHERE (artist IS NOT NULL AND TRIM(artist) != '')
       OR (album_artist IS NOT NULL AND TRIM(album_artist) != '')
  `);

  const groups = new Map();
  for (const row of rows) {
    const names = getTrackArtistNames(row);
    for (const name of names) {
      const key = toKey(name);
      if (!key) continue;
      if (!groups.has(key)) {
        groups.set(key, {
          name,
          trackIds: 0,
          albumKeys: new Set(),
          cover_path: '',
        });
      }
      const g = groups.get(key);
      g.trackIds += 1;
      const albumKey = toKey(row?.album);
      if (albumKey) g.albumKeys.add(albumKey);
      if (!g.cover_path && normalizeText(row?.cover_path)) g.cover_path = row.cover_path;
    }
  }

  const out = [];
  for (const g of groups.values()) {
    out.push({
      name: g.name,
      track_count: g.trackIds || 0,
      album_count: g.albumKeys.size,
      cover_path: g.cover_path || '',
    });
  }
  out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  return out;
};

export const getAlbumCover = (album, artist) => {
  if (!album || album === 'Unknown Album') return null;
  // Try to find a track with the same album (and artist if possible) that has a cover
  let res = get('SELECT cover_path FROM tracks WHERE album = ? AND cover_path IS NOT NULL LIMIT 1', [album]);
  
  if (!res && artist && artist !== 'Unknown Artist') {
    res = get('SELECT cover_path FROM tracks WHERE album = ? AND artist = ? AND cover_path IS NOT NULL LIMIT 1', [album, artist]);
  }
  
  return res ? res.cover_path : null;
};

const api = {
  addTrack,
  getAllTracks,
  getTrackByPath,
  findTracksByTitleArtist,
  createPlaylist,
  getAllPlaylists,
  addTrackToPlaylist,
  getPlaylistTracks,
  renamePlaylist,
  deletePlaylist,
  removeTrackFromPlaylist,
  reorderPlaylist,
  removeTrack,
  deleteAlbum,
  updateTrack,
  updateTrackPath,
  updateTrackWithAlbumArtist,
  getAlbumCover,
  getAlbumArtist,
  getAlbums,
  getArtists,
  getTrackById,
  updateTrackLyrics,
  updateTrackFields,
  getAlbumTracks,
}

export default api;
