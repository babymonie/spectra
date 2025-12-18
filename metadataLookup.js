// metadataLookup.js
// Local + online metadata extraction with deduplicated album artwork

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as mm from 'music-metadata';
import fetch from 'node-fetch';
import { app } from 'electron';

const userDataPath = app.getPath('userData');
const coversRoot = path.join(userDataPath, 'covers');

async function ensureDir(dir) {
	await fsp.mkdir(dir, { recursive: true });
}

function hashBuffer(buf) {
	return crypto.createHash('sha1').update(buf).digest('hex');
}

// Map album key -> cover path to avoid duplicate files this run
const inMemoryAlbumCoverCache = new Map();

// Best-effort: check if a cover file for this album already exists on disk
async function findExistingAlbumCoverOnDisk(albumKey) {
	const safe = albumKey.replaceAll(/[^a-z0-9]+/gi, '_').toLowerCase();
	const prefix = safe.slice(0, 50) || 'album';
	const dir = coversRoot;
	const files = await fsp.readdir(dir).catch(() => []);
	for (const file of files) {
		if (file.startsWith(`${prefix}_`)) {
			return path.join(dir, file);
		}
	}
	return null;
}

async function saveCoverForAlbum(picture, album, albumArtist) {
	if (!picture?.data) return null;

	await ensureDir(coversRoot);

	const albumKey = `${album || ''}::${albumArtist || ''}`.trim() || null;
	if (!albumKey) return null;

	const cached = inMemoryAlbumCoverCache.get(albumKey);
	if (cached) {
		return cached;
	}

	const existing = await findExistingAlbumCoverOnDisk(albumKey).catch(() => null);
	if (existing) {
		inMemoryAlbumCoverCache.set(albumKey, existing);
		return existing;
	}

	const buf = Buffer.isBuffer(picture.data)
		? picture.data
		: Buffer.from(picture.data);
	const hash = hashBuffer(buf).slice(0, 12);
	const ext = picture.format?.startsWith('image/')
		? `.${picture.format.split('/')[1]}`
		: '.jpg';

	const safe = (albumKey || 'album').replaceAll(/[^a-z0-9]+/gi, '_').toLowerCase();
	const fileName = `${safe.slice(0, 50)}_${hash}${ext}`;
	const filePath = path.join(coversRoot, fileName);

	try {
		await fsp.writeFile(filePath, buf);
		inMemoryAlbumCoverCache.set(albumKey, filePath);
		return filePath;
	} catch (err) {
		console.error('Failed to write cover file', filePath, err);
		return null;
	}
}

async function findLocalCover(filePath) {
	try {
		const dir = path.dirname(filePath);
		const candidates = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png', 'album.jpg', 'album.png'];
		
		for (const cand of candidates) {
			const candPath = path.join(dir, cand);
			try {
				await fs.access(candPath);
				// Found one!
				// We'll just return the path directly if we want to use it directly, 
				// OR we can copy it to our cache. Let's copy to cache for consistency.
				const buf = await fs.readFile(candPath);
				// We don't know album/artist here easily without parsing, but we can return the buffer
				return { data: buf, format: 'image/' + path.extname(cand).replace('.', '') };
			} catch {
				// Not found
			}
		}
	} catch (err) {
		console.error('Local cover lookup failed', err);
	}
	return null;
}

async function lookupOnlineCover(artist, album) {
	if (!artist || !album) return null;
	
	// Try iTunes Search API - it's generally more reliable for pop music covers
	try {
		const query = `${artist} ${album}`;
		const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=album&limit=1`;
		
		const res = await fetch(url, { timeout: 5000 }).catch(() => null);
		if (!res?.ok) throw new Error('iTunes lookup failed');
		
		const data = await res.json();
		if (data.resultCount > 0 && data.results[0].artworkUrl100) {
			// Get the high res version (600x600 usually available by replacing 100x100)
			const artworkUrl = data.results[0].artworkUrl100.replace('100x100', '600x600');
			
			const imgRes = await fetch(artworkUrl, { timeout: 5000 }).catch(() => null);
			if (imgRes?.ok) {
				const buf = Buffer.from(await imgRes.arrayBuffer());
				const picture = { data: buf, format: 'image/jpeg' };
				return await saveCoverForAlbum(picture, album, artist);
			}
		}
	} catch {
		// Fallthrough
	}

	// Fallback to Cover Art Archive if iTunes fails
	try {
		const url = `https://coverartarchive.org/release-group/?query=artist:${encodeURIComponent(
			artist
		)}+release:${encodeURIComponent(album)}`;

		const res = await fetch(url, { timeout: 5000 }).catch(() => null);
		if (!res?.ok) return null;

		const text = await res.text();
		// Keep it super light: just search for an image URL; real integration
		// with Cover Art Archive / MusicBrainz can be added later.
		const m = text.match(/https?:[^"']+\.(jpg|jpeg|png)/i);
		if (!m) return null;

		const imgUrl = m[0];
		const imgRes = await fetch(imgUrl, { timeout: 5000 }).catch(() => null);
		if (!imgRes?.ok) return null;
		const buf = Buffer.from(await imgRes.arrayBuffer());

		const picture = { data: buf, format: 'image/jpeg' };
		return await saveCoverForAlbum(picture, album, artist);
	} catch (err) {
		console.error('Online cover lookup failed', { artist, album }, err);
		return null;
	}
}

async function lookupTrackMetadata(artist, title) {
	try {
		const query = `${artist} ${title}`;
		const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=1`;
		
		const res = await fetch(url, { timeout: 5000 }).catch(() => null);
		if (!res?.ok) return null;
		
		const data = await res.json();
		if (data.resultCount > 0) {
			const track = data.results[0];
			return {
				album: track.collectionName,
				coverUrl: track.artworkUrl100?.replace('100x100', '600x600')
			};
		}
	} catch {
		// Ignore
	}
	return null;
}

export async function extractMetadata(filePath) {
	let title = null;
	let artist = null;
	let album = null;
	let albumArtist = null;
	let duration = null;
	let format = path.extname(filePath || '').replace(/^\./, '').toLowerCase() || null;
	let coverPath = null;
	let bitrate = null;
	let sampleRate = null;
	let bitDepth = null;
	let channels = null;
	let lossless = null;
	let codec = null;

	try {
		const metadata = await mm.parseFile(filePath, { duration: true });
		const common = metadata.common || {};
		const fmt = metadata.format || {};

		title = common.title || path.basename(filePath);
		artist = (common.artist || null) ?? null;
		album = (common.album || null) ?? null;
		albumArtist = (common.albumartist || common['album artist'] || artist || null) ?? null;
		duration = typeof metadata.format.duration === 'number'
			? metadata.format.duration
			: null;
		bitrate = typeof fmt.bitrate === 'number' ? Math.round(fmt.bitrate) : null;
		sampleRate = typeof fmt.sampleRate === 'number' ? Math.round(fmt.sampleRate) : null;
		bitDepth = typeof fmt.bitsPerSample === 'number' ? Math.round(fmt.bitsPerSample) : null;
		channels = typeof fmt.numberOfChannels === 'number' ? Math.round(fmt.numberOfChannels) : null;
		lossless = typeof fmt.lossless === 'boolean' ? (fmt.lossless ? 1 : 0) : null;
		codec = fmt.codec || fmt.container || format || null;

		// 1. Try embedded picture
		if (Array.isArray(common.picture) && common.picture.length > 0) {
			coverPath = await saveCoverForAlbum(common.picture[0], album, albumArtist || artist);
		}

		// 2. Try local file (cover.jpg, etc)
		if (!coverPath) {
			const localPic = await findLocalCover(filePath);
			if (localPic) {
				coverPath = await saveCoverForAlbum(localPic, album, albumArtist || artist);
			}
		}

		// 3. If album is missing, try to find it online (and cover too)
		if (!album && artist && title) {
			const onlineData = await lookupTrackMetadata(artist, title);
			if (onlineData) {
				album = onlineData.album;
				// If we found a cover URL and don't have one yet, we can use it
				if (!coverPath && onlineData.coverUrl) {
					try {
						const imgRes = await fetch(onlineData.coverUrl, { timeout: 5000 }).catch(() => null);
						if (imgRes?.ok) {
							const buf = Buffer.from(await imgRes.arrayBuffer());
							const picture = { data: buf, format: 'image/jpeg' };
							coverPath = await saveCoverForAlbum(picture, album, albumArtist || artist);
						}
					} catch {
						// Ignore cover download failure
					}
				}
			}
		}

		// 4. Try online lookup
		if (!coverPath) {
			coverPath = await lookupOnlineCover(albumArtist || artist, album);
		}
	} catch (err) {
		console.error('Metadata extraction failed for', filePath, err);
		if (!title) {
			title = path.basename(filePath);
		}
	}

	return {
		title,
		artist,
		album,
		albumArtist,
		duration,
		format,
		coverPath,
		bitrate,
		sampleRate,
		bitDepth,
		channels,
		lossless,
		codec,
	};
}

// metadataLookup.js

export async function extractMetadataFromBuffer(buf, sourceName = 'remote') {
    let title = null;
    let artist = null;
    let album = null;
    let albumArtist = null;
    let duration = null;
    let format = null;
    let coverPath = null;
    let bitrate = null;
    let sampleRate = null;
    let bitDepth = null;
    let channels = null;
    let lossless = null;
    let codec = null;

    try {
        // FIX: Extract extension to provide a hint for .dff and other DSD formats
        const ext = path.extname(sourceName.split('?')[0] || '').toLowerCase();
        let mimeType = null;

        if (ext === '.dff') mimeType = 'audio/x-dff';
        else if (ext === '.dsf') mimeType = 'audio/x-dsf';
        else if (ext === '.flac') mimeType = 'audio/flac';
        else if (ext === '.wav') mimeType = 'audio/wav';
		else if (ext === '.mp3') mimeType = 'audio/mpeg';
		else if (ext === '.m4a' || ext === '.mp4') mimeType = 'audio/mp4';
		else if (ext === '.ogg' || ext === '.oga') mimeType = 'audio/ogg';
		

        // Provide the mimeType hint as the second argument
        const metadata = await mm.parseBuffer(buf, mimeType, { duration: true });
        const common = metadata.common || {};
        const fmt = metadata.format || {};

        title = common.title || sourceName;
        artist = (common.artist || null) ?? null;
        album = (common.album || null) ?? null;
        albumArtist = (common.albumartist || common['album artist'] || artist || null) ?? null;
        duration = typeof metadata.format.duration === 'number' ? metadata.format.duration : null;
        bitrate = typeof fmt.bitrate === 'number' ? Math.round(fmt.bitrate) : null;
        sampleRate = typeof fmt.sampleRate === 'number' ? Math.round(fmt.sampleRate) : null;
        bitDepth = typeof fmt.bitsPerSample === 'number' ? Math.round(fmt.bitsPerSample) : null;
        channels = typeof fmt.numberOfChannels === 'number' ? Math.round(fmt.numberOfChannels) : null;
        lossless = typeof fmt.lossless === 'boolean' ? (fmt.lossless ? 1 : 0) : null;
        codec = fmt.codec || fmt.container || format || null;

        if (Array.isArray(common.picture) && common.picture.length > 0) {
            coverPath = await saveCoverForAlbum(common.picture[0], album, albumArtist || artist);
        }

        // Online recovery if metadata is sparse
        if (!album && artist && title) {
            const onlineData = await lookupTrackMetadata(artist, title);
            if (onlineData) {
                album = onlineData.album || album;
                if (!coverPath && onlineData.coverUrl) {
                    try {
                        const imgRes = await fetch(onlineData.coverUrl, { timeout: 5000 }).catch(() => null);
                        if (imgRes?.ok) {
                            const pictureBuf = Buffer.from(await imgRes.arrayBuffer());
                            const picture = { data: pictureBuf, format: 'image/jpeg' };
                            coverPath = await saveCoverForAlbum(picture, album, albumArtist || artist);
                        }
                    } catch { /* Ignore cover failure */ }
                }
            }
        }

        if (!coverPath && (album || artist)) {
            coverPath = await lookupOnlineCover(albumArtist || artist, album);
        }

        format = (metadata.format && metadata.format.container) || format;
    } catch (err) {
        console.error('extractMetadataFromBuffer failed for', sourceName, err);
        title = title || sourceName;
    }

    return {
        title, artist, album, albumArtist, duration, format,
        coverPath, bitrate, sampleRate, bitDepth, channels, lossless, codec,
    };
}

// Extract embedded lyrics from audio files (ID3 USLT, Vorbis COMMENTS, etc.)
export async function extractLyrics(filePath) {
	try {
		let metadata;
		// If filePath is a remote URL (presigned S3 / object storage), fetch into buffer
		if (typeof filePath === 'string' && (filePath.startsWith('http://') || filePath.startsWith('https://'))) {
			try {
				const res = await fetch(filePath, { timeout: 15000 }).catch(() => null);
				if (!res || !res.ok) throw new Error('Failed to fetch remote file for metadata');
				const arrayBuf = await res.arrayBuffer();
				const buf = Buffer.from(arrayBuf);
				metadata = await mm.parseBuffer(buf, null, { native: true });
			} catch (e) {
				// Fallback: let parseFile try (will likely fail) so we can surface the error
				metadata = await mm.parseFile(filePath, { native: true }).catch(err => { throw err; });
			}
		} else {
			metadata = await mm.parseFile(filePath, { native: true });
		}
		const common = metadata.common || {};

		// music-metadata may expose lyrics in common.lyrics as an array
		if (common.lyrics) {
			if (Array.isArray(common.lyrics)) {
				const txt = common.lyrics.map(line => {
					if (typeof line === 'string') return line;
					if (line && typeof line === 'object') return line.text || line.lyrics || '';
					return String(line);
				}).filter(l => l && l.trim()).join('\n');
				if (txt.trim()) return txt;
			} else if (typeof common.lyrics === 'string' && common.lyrics.trim()) {
				return common.lyrics;
			}
		}

		// Look into native tags for common frames (USLT for ID3) or other lyrics keys
		const native = metadata.native || {};
		for (const ns of Object.keys(native)) {
			const arr = native[ns] || [];
			for (const entry of arr) {
				// ID3v2: USLT contains lyrics
				if (entry.id && String(entry.id).toUpperCase() === 'USLT') {
					const v = entry.value;
					if (v && (v.text || v.lyrics || v)) {
						const text = v.text || v.lyrics || (typeof v === 'string' ? v : null);
						if (text && String(text).trim()) return String(text);
					}
				}
				// Vorbis/FLAC: look for LYRICS or UNSYNCEDLYRICS
				const val = entry.value || entry;
				if (val && typeof val === 'string' && /lyrics?/i.test(entry.id || '')) {
					if (val.trim()) return String(val);
				}
				// Some containers put lyrics as arrays/objects
				if (val && typeof val === 'object' && (val.text || val.lyrics)) {
					const t = val.text || val.lyrics;
					if (t && String(t).trim()) return String(t);
				}
			}
		}
	} catch (err) {
		console.error('extractLyrics failed for', filePath, err);
	}
	return null;
}

const api = {
	extractMetadata,
	extractMetadataFromBuffer,
};

export default api;
