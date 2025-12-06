import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import fs from 'fs';

const userDataPath = app.getPath('userData');
console.log('User Data Path:', userDataPath);
const dbPath = path.join(userDataPath, 'spectra.db');

// Ensure the database file exists
const db = new Database(dbPath);

// Initialize schema
const initSchema = () => {
  db.exec(`
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: Add cover_path if it doesn't exist (for existing DBs)
  try {
    db.prepare('ALTER TABLE tracks ADD COLUMN cover_path TEXT').run();
  } catch (e) {
    // Column likely already exists
  }
  try {
    db.prepare('ALTER TABLE tracks ADD COLUMN album_artist TEXT').run();
  } catch (e) {
    // Column likely already exists
  }
  try {
    db.prepare('ALTER TABLE tracks ADD COLUMN lyrics TEXT').run();
  } catch (e) {
    // Column likely already exists
  }

  // Ensure playlists.updated_at exists for older DBs
  try {
    db.prepare('ALTER TABLE playlists ADD COLUMN updated_at DATETIME').run();
  } catch (e) {
    // ignore if already exists
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id INTEGER,
      track_id INTEGER,
      track_order INTEGER,
      FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE,
      PRIMARY KEY (playlist_id, track_id)
    );
  `);
};

initSchema();

export const addTrack = (track) => {
  const stmt = db.prepare(`
    INSERT INTO tracks (path, title, artist, album, album_artist, duration, format, cover_path)
    VALUES (@path, @title, @artist, @album, @album_artist, @duration, @format, @cover_path)
    ON CONFLICT(path) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      album = excluded.album,
      album_artist = excluded.album_artist,
      duration = excluded.duration,
      format = excluded.format,
      cover_path = excluded.cover_path
  `);
  return stmt.run(track);
};

export const getAllTracks = () => {
  return db.prepare('SELECT * FROM tracks ORDER BY title ASC').all();
};

export const getTrackByPath = (path) => {
  return db.prepare('SELECT * FROM tracks WHERE path = ?').get(path);
};

export const getTrackById = (id) => {
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
};

export const updateTrackLyrics = (id, lyrics) => {
  return db.prepare(`
    UPDATE tracks
    SET lyrics = @lyrics
    WHERE id = @id
  `).run({ id, lyrics });
};

export const createPlaylist = (name) => {
  return db.prepare('INSERT INTO playlists (name) VALUES (?)').run(name);
};

export const getAllPlaylists = () => {
  return db.prepare('SELECT * FROM playlists ORDER BY name ASC').all();
};

export const addTrackToPlaylist = (playlistId, trackId) => {
  // Get current max order
  const maxOrder = db.prepare('SELECT MAX(track_order) as maxOrder FROM playlist_tracks WHERE playlist_id = ?').get(playlistId).maxOrder || 0;
  const res = db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, track_order) VALUES (?, ?, ?)').run(playlistId, trackId, maxOrder + 1);
  try {
    db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);
  } catch (e) {
    // ignore
  }
  return res;
};

export const renamePlaylist = (playlistId, newName) => {
  const res = db.prepare('UPDATE playlists SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newName, playlistId);
  return res;
};

export const deletePlaylist = (playlistId) => {
  // Delete playlist and its tracks via FK cascade
  const res = db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
  return res;
};

export const removeTrackFromPlaylist = (playlistId, trackId) => {
  const res = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(playlistId, trackId);
  try {
    db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);
  } catch (e) {}
  return res;
};

export const reorderPlaylist = (playlistId, orderedTrackIds = []) => {
  const trx = db.transaction((ids) => {
    let i = 1;
    for (const tid of ids) {
      db.prepare('UPDATE playlist_tracks SET track_order = ? WHERE playlist_id = ? AND track_id = ?').run(i++, playlistId, tid);
    }
    db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);
  });
  trx(orderedTrackIds);
  return { ok: true };
};

export const getPlaylistTracks = (playlistId) => {
  return db.prepare(`
    SELECT t.* 
    FROM tracks t
    JOIN playlist_tracks pt ON t.id = pt.track_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.track_order ASC
  `).all(playlistId);
};

export const removeTrack = (id) => {
  return db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
};

export const updateTrack = (id, { title, artist, album }) => {
  return db.prepare(`
    UPDATE tracks 
    SET title = @title, artist = @artist, album = @album
    WHERE id = @id
  `).run({ id, title, artist, album });
};

export const updateTrackPath = (id, path) => {
  return db.prepare(`
    UPDATE tracks 
    SET path = @path
    WHERE id = @id
  `).run({ id, path });
};

export const updateTrackWithAlbumArtist = (id, { title, artist, album, albumArtist }) => {
  return db.prepare(`
    UPDATE tracks
    SET title = @title, artist = @artist, album = @album, album_artist = @albumArtist
    WHERE id = @id
  `).run({ id, title, artist, album, albumArtist });
};

export const getAlbumArtist = (album, artistFallback) => {
  if (!album || typeof album !== 'string') return null;
  
  // Early return if no tracks exist yet
  try {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM tracks').get();
    if (!count || count.cnt === 0) return null;
  } catch (err) {
    console.error('[database] getAlbumArtist: table check failed', err);
    return null;
  }
  
  try {
    // Prefer an explicit album_artist if present
    const explicit = db.prepare('SELECT album_artist FROM tracks WHERE album = ? AND album_artist IS NOT NULL AND album_artist != ? LIMIT 1').get(album, '');
    if (explicit?.album_artist) return explicit.album_artist;
    
    // Most common artist for this album
    const row = db.prepare(`
      SELECT artist, COUNT(*) as cnt
      FROM tracks
      WHERE album = ? AND artist IS NOT NULL
      GROUP BY artist
      ORDER BY cnt DESC
      LIMIT 1
    `).get(album);
    if (row?.artist) return row.artist;
    
    if (artistFallback) {
      const r2 = db.prepare('SELECT artist FROM tracks WHERE album = ? AND artist = ? LIMIT 1').get(album, artistFallback);
      return r2?.artist || null;
    }
    return null;
  } catch (err) {
    console.error('[database] getAlbumArtist error for album:', album, err);
    return null;
  }
};

export const getAlbums = () => {
  return db.prepare(`
    SELECT
      album AS name,
      COALESCE(cover_path, '') AS cover_path,
      COUNT(*) AS track_count,
      COALESCE(
        (
          SELECT album_artist FROM tracks t3 WHERE t3.album = tracks.album AND t3.album_artist IS NOT NULL AND t3.album_artist != '' LIMIT 1
        ),
        (
          SELECT artist FROM (
            SELECT artist, COUNT(*) as cnt
            FROM tracks t2
            WHERE t2.album = tracks.album AND t2.artist IS NOT NULL AND t2.artist != ''
            GROUP BY artist
            ORDER BY cnt DESC
            LIMIT 1
          )
        )
      ) AS artist
    FROM tracks
    WHERE album IS NOT NULL AND album != ''
    GROUP BY album
    ORDER BY artist ASC, album ASC
  `).all();
};

export const getAlbumCover = (album, artist) => {
  if (!album || album === 'Unknown Album') return null;
  // Try to find a track with the same album (and artist if possible) that has a cover
  let stmt = db.prepare('SELECT cover_path FROM tracks WHERE album = ? AND cover_path IS NOT NULL LIMIT 1');
  let res = stmt.get(album);
  
  if (!res && artist && artist !== 'Unknown Artist') {
    // Fallback: try matching both if just album failed (though usually album is unique enough or we want to be specific)
    // Actually, if album name is common like "Greatest Hits", we definitely need artist.
    stmt = db.prepare('SELECT cover_path FROM tracks WHERE album = ? AND artist = ? AND cover_path IS NOT NULL LIMIT 1');
    res = stmt.get(album, artist);
  }
  
  return res ? res.cover_path : null;
};

const api = {
  addTrack,
  getAllTracks,
  getTrackByPath,
  createPlaylist,
  getAllPlaylists,
  addTrackToPlaylist,
  getPlaylistTracks,
  renamePlaylist,
  deletePlaylist,
  removeTrackFromPlaylist,
  reorderPlaylist,
  removeTrack,
  updateTrack,
  updateTrackPath,
  updateTrackWithAlbumArtist,
  getAlbumCover,
  getAlbumArtist,
  getAlbums,
  getTrackById,
  updateTrackLyrics
};

export default api;
