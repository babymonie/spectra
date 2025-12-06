# Object Storage Plugin for Spectra

Import and play audio files from remote object storage services including AWS S3, Google Cloud Storage, Minio, and any S3-compatible storage.

## Features

- 📦 **Multiple Providers**: AWS S3, Google Cloud Storage, Minio, DigitalOcean Spaces, Wasabi, Backblaze B2, and more
- 🎵 **Direct Playback**: Stream audio files directly from cloud storage or cache locally
- 📥 **Batch Import**: Import entire buckets or specific prefixes to your library
- 💾 **Smart Caching**: Configurable local cache with automatic cleanup
- 🔄 **Auto Sync**: Automatically discover new files in your bucket
- 🔐 **Secure**: Uses presigned URLs for secure, temporary access

## Installation

1. Navigate to the plugin directory:
   ```bash
   cd plugins/object-storage
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Restart Spectra and enable the plugin in Settings → Plugins

## Configuration

### Settings

Configure the plugin in Spectra Settings → Plugins → Object Storage:

| Setting | Description | Default |
|---------|-------------|---------|
| `provider` | Storage provider (minio, s3, gcs) | `minio` |
| `endpoint` | Custom endpoint URL for S3-compatible services | `http://localhost:9000` |
| `region` | AWS region (for AWS S3, GCS) | `us-east-1` |
| `accessKeyId` | Access key ID / Access Key | *(required)* |
| `secretAccessKey` | Secret access key / Secret Key | *(required)* |
| `bucket` | Bucket name containing audio files | `music` |
| `pathPrefix` | Optional prefix to limit scope (e.g., `albums/`) | `""` |
| `autoSync` | Automatically check for new files | `false` |
| `syncInterval` | Auto-sync interval in seconds | `300` |
| `cacheFiles` | Cache files locally for faster playback | `true` |
| `maxCacheSize` | Maximum cache size in MB | `1024` |

### Provider-Specific Setup

#### Minio (Self-Hosted)

1. Install and run Minio:
   ```bash
   # Using Docker
   docker run -p 9000:9000 -p 9001:9001 \
     -e MINIO_ROOT_USER=minioadmin \
     -e MINIO_ROOT_PASSWORD=minioadmin \
     minio/minio server /data --console-address ":9001"
   ```

2. Access Minio Console at `http://localhost:9001`

3. Create a bucket (e.g., `music`)

4. Upload your audio files

5. Configure plugin:
   - Provider: `minio`
   - Endpoint: `http://localhost:9000`
   - Access Key ID: `minioadmin`
   - Secret Access Key: `minioadmin`
   - Bucket: `music`

#### AWS S3

1. Create an S3 bucket in AWS Console

2. Create an IAM user with S3 permissions:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "s3:GetObject",
           "s3:ListBucket"
         ],
         "Resource": [
           "arn:aws:s3:::YOUR-BUCKET-NAME",
           "arn:aws:s3:::YOUR-BUCKET-NAME/*"
         ]
       }
     ]
   }
   ```

3. Get Access Key ID and Secret Access Key

4. Configure plugin:
   - Provider: `s3`
   - Endpoint: *(leave empty for AWS S3)*
   - Region: `us-east-1` (or your region)
   - Access Key ID: `YOUR_ACCESS_KEY`
   - Secret Access Key: `YOUR_SECRET_KEY`
   - Bucket: `your-bucket-name`

#### Google Cloud Storage

1. Create a GCS bucket

2. Create a service account with Storage Object Viewer role

3. Create HMAC keys for the service account

4. Configure plugin:
   - Provider: `gcs`
   - Endpoint: `https://storage.googleapis.com`
   - Region: `auto`
   - Access Key ID: `YOUR_HMAC_ACCESS_ID`
   - Secret Access Key: `YOUR_HMAC_SECRET`
   - Bucket: `your-bucket-name`

#### DigitalOcean Spaces

1. Create a Space in DigitalOcean

2. Generate Spaces access keys

3. Configure plugin:
   - Provider: `s3`
   - Endpoint: `https://nyc3.digitaloceanspaces.com` (use your region)
   - Region: `us-east-1`
   - Access Key ID: `YOUR_SPACES_KEY`
   - Secret Access Key: `YOUR_SPACES_SECRET`
   - Bucket: `your-space-name`

#### Backblaze B2

1. Create a B2 bucket

2. Generate application key

3. Configure plugin:
   - Provider: `s3`
   - Endpoint: `https://s3.us-west-000.backblazeb2.com` (use your endpoint)
   - Region: `us-west-000`
   - Access Key ID: `YOUR_KEY_ID`
   - Secret Access Key: `YOUR_APPLICATION_KEY`
   - Bucket: `your-bucket-name`

## Usage

### Browse Files

1. Go to Object Storage view in Spectra sidebar
2. Click "Connect" to establish connection
3. Enter a path prefix (optional) and click "Browse"
4. View all audio files in your bucket

### Play Files

- Click "Play" next to any file to stream it directly
- If caching is enabled, file is downloaded first for better performance

### Import to Library

- Click "Import" next to a file to add it to your Spectra library
- Click "Import All" to batch import all visible files
- Metadata is automatically extracted during import

### Cache Management

- View cache info: Settings → Plugins → Object Storage
- Cache path: `%AppData%\Spectra\object-storage-cache` (Windows)
- Files are automatically cleaned up when cache exceeds max size
- Oldest files (by last access time) are removed first

## Supported Audio Formats

- FLAC (.flac)
- WAV (.wav)
- MP3 (.mp3)
- AAC (.aac, .m4a)
- OGG Vorbis (.ogg)
- ALAC (.alac)
- WMA (.wma)
- DSD (.dsf, .dff)
- APE (.ape)
- AIFF (.aiff)

## Performance Tips

1. **Enable Caching**: For better playback performance, enable `cacheFiles`
2. **Use Path Prefix**: Limit scope to specific folders to speed up browsing
3. **Adjust Cache Size**: Set `maxCacheSize` based on your available disk space
4. **Regional Proximity**: Use storage regions close to your location
5. **Auto-Sync**: Disable if you manually manage imports to reduce API calls

## Troubleshooting

### Connection Failed

- Verify credentials are correct
- Check endpoint URL format (include `http://` or `https://`)
- Ensure bucket exists and you have access
- For Minio, verify `forcePathStyle` is supported

### Files Not Appearing

- Check `pathPrefix` setting
- Verify audio files are in supported formats
- Ensure bucket permissions allow ListBucket operation

### Playback Issues

- Enable caching for more reliable playback
- Check network connectivity
- Verify presigned URLs aren't expired (default: 1 hour)

### Cache Problems

- Check available disk space
- Verify write permissions to cache directory
- Manually clear cache: Settings → Plugins → Object Storage → Clear Cache

## API Reference

The plugin exposes an API for programmatic access:

```javascript
// Access via plugin context
const storage = ObjectStorageAPI;

// List files
const files = await storage.listFiles('albums/rock/');

// Get playable URL
const url = await storage.getFileUrl('albums/rock/song.flac');

// Download to cache
const localPath = await storage.downloadFile('albums/rock/song.flac');

// Get cache info
const cacheInfo = await storage.getCacheInfo();

// Clear cache
await storage.clearCache();

// Test connection
const result = await storage.testConnection();
```

## Security Notes

- Credentials are stored in plugin config file (encrypted recommended)
- Presigned URLs expire after 1 hour by default
- Use IAM roles with minimum required permissions
- Enable HTTPS for all endpoints in production
- Consider using temporary credentials for enhanced security

## License

MIT

## Support

For issues, feature requests, or contributions, please file an issue in the Spectra repository.
