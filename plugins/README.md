# Spectra Plugins

## Available Plugins

### Discord Rich Presence
Shows what you're currently listening to on Discord.

**Setup:**
1. Create a Discord application at https://discord.com/developers/applications
2. Copy the Application ID and replace `CLIENT_ID` in `discord-presence/plugin.js`
3. Upload assets (spectra_logo, playing, paused icons) to your Discord app
4. Install dependencies: `cd plugins/discord-presence && npm install`
5. Ensure Remote Control is enabled in Spectra settings (required for album cover display)

**Settings:**
- `showAlbum`: Display album name (default: true)
- `showArtist`: Display artist name (default: true)
- `showTimeElapsed`: Show elapsed time (default: true)
- `showAlbumCover`: Display album cover art (default: true)
- `largeImageText`: Text for large image tooltip

**Note:** Album covers are served via the local remote server on port 3000. Make sure Remote Control is enabled in settings for album covers to display properly.

### Object Storage
Import and play audio files from remote object storage services.

**Supported Services:**
- AWS S3
- Google Cloud Storage (GCS)
- Minio (self-hosted)
- DigitalOcean Spaces
- Backblaze B2
- Wasabi
- Any S3-compatible storage

**Setup:**
1. Install dependencies: `cd plugins/object-storage && npm install`
2. Configure your storage provider in Settings → Plugins → Object Storage
3. Enter your credentials (Access Key ID and Secret Access Key)
4. Specify your bucket name and optional path prefix
5. Click "Connect" in the Object Storage view

**Settings:**
- `provider`: Storage provider type (minio, s3, gcs)
- `endpoint`: Custom endpoint URL for S3-compatible services
- `region`: AWS region or storage region
- `accessKeyId`: Your access key ID
- `secretAccessKey`: Your secret access key
- `bucket`: Bucket name containing audio files
- `pathPrefix`: Optional prefix to limit scope (e.g., "albums/")
- `autoSync`: Automatically discover new files
- `syncInterval`: How often to sync (in seconds)
- `cacheFiles`: Cache files locally for better playback
- `maxCacheSize`: Maximum cache size in MB

**Features:**
- Browse files in your cloud storage bucket
- Stream audio directly or cache locally
- Import individual files or entire collections
- Automatic metadata extraction
- Smart cache management with auto-cleanup
- Support for all major audio formats

See `object-storage/README.md` for detailed setup instructions for each provider.

### Last.fm Scrobbler
Scrobbles your tracks to Last.fm and updates "Now Playing" status.

**Setup:**
1. Get API credentials from https://www.last.fm/api/account/create
2. Replace `API_KEY` and `API_SECRET` in `lastfm-scrobbler/plugin.js`
3. Install dependencies: `cd plugins/lastfm-scrobbler && npm install`
4. Authenticate using the plugin settings in Spectra

**Settings:**
- `username`: Your Last.fm username
- `sessionKey`: Session key (obtained after authentication)
- `scrobbleThreshold`: Percentage of track to play before scrobbling (default: 50%)

## Plugin Structure

Each plugin should have:
- `manifest.json` - Plugin metadata and settings
- `plugin.js` - Main plugin code with `activate()` and `deactivate()` exports
- `package.json` - NPM dependencies (if needed)

## Events

Plugins receive a `context` object with these events:
- `track-started` - Fired when a track starts playing
- `track-paused` - Fired when playback is paused
- `track-resumed` - Fired when playback resumes
- `track-stopped` - Fired when playback stops

## Installing Plugins

1. Copy plugin folder to `plugins/` directory
2. Run `npm install` inside the plugin folder if it has dependencies
3. Restart Spectra
4. Enable the plugin in Settings
