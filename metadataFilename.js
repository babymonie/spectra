import path from 'node:path';

const AUDIO_EXT_RE = /\.(aac|aiff?|ape|caf|dff|dsf|flac|m4a|mp3|oga|ogg|opus|wav|wv)$/i;
const PLACEHOLDER_RE = /^(unknown|unknown artist|unknown album|unknown title|<unknown>|n\/?a|none|null|-|--)$/i;
const GENERIC_ALBUM_DIR_RE = /^(audio|downloads?|library|music|new folder|unknown|unknown album)$/i;

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function cleanMetadataText(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value)
    .replace(/\s+/g, ' ')
    .replace(/[_]+/g, ' ')
    .trim();
  return cleaned || null;
}

export function isPlaceholderMetadataValue(value) {
  const cleaned = cleanMetadataText(value);
  if (!cleaned) return true;
  return PLACEHOLDER_RE.test(cleaned);
}

function stripTrackPrefix(value) {
  return value
    .replace(/^\s*\d{1,3}\s*[-.)_ ]+\s*/, '')
    .replace(/^\s*disc\s*\d+\s*[-.)_ ]+\s*/i, '')
    .trim();
}

function sourceParts(sourceName = '') {
  const withoutQuery = String(sourceName || '').split(/[?#]/, 1)[0];
  const decoded = decodePathPart(withoutQuery);
  const normalized = decoded.replaceAll('\\', '/');
  const base = cleanMetadataText(path.posix.basename(normalized).replace(AUDIO_EXT_RE, ''));
  const parent = cleanMetadataText(path.posix.basename(path.posix.dirname(normalized)));
  return { base, parent };
}

export function isWeakTitleForPath(title, sourceName = '') {
  if (isPlaceholderMetadataValue(title)) return true;
  const { base } = sourceParts(sourceName);
  const cleanedTitle = cleanMetadataText(title);
  if (!base || !cleanedTitle) return false;
  const normalizedTitle = cleanedTitle.toLowerCase();
  const normalizedBase = base.toLowerCase();
  return normalizedTitle === normalizedBase || normalizedTitle === `${normalizedBase}${path.extname(sourceName).toLowerCase()}`;
}

export function inferMetadataFromPath(sourceName = '') {
  const { base, parent } = sourceParts(sourceName);
  const rawTitle = stripTrackPrefix(base || '');
  let artist = null;
  let title = cleanMetadataText(rawTitle);

  const separatorMatch = rawTitle.match(/^(.+?)\s+-\s+(.+)$/);
  if (separatorMatch) {
    artist = cleanMetadataText(separatorMatch[1]);
    title = cleanMetadataText(separatorMatch[2]);
  }

  const parentMatchesArtist = parent && artist && parent.toLowerCase() === artist.toLowerCase();
  const album = parent && !GENERIC_ALBUM_DIR_RE.test(parent) && parent !== '.' && !parentMatchesArtist
    ? parent
    : null;

  return {
    title: isPlaceholderMetadataValue(title) ? null : title,
    artist: isPlaceholderMetadataValue(artist) ? null : artist,
    album: isPlaceholderMetadataValue(album) ? null : album,
    albumArtist: isPlaceholderMetadataValue(artist) ? null : artist,
  };
}
