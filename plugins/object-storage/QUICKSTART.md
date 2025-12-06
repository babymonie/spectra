# Quick Start Guide - Object Storage Plugin

## 1. Install Dependencies

```bash
cd plugins/object-storage
npm install
```

## 2. Choose Your Setup

### Option A: Quick Test with Minio (Recommended for Testing)

1. **Run Minio with Docker:**
   ```bash
   docker run -p 9000:9000 -p 9001:9001 \
     --name minio \
     -e "MINIO_ROOT_USER=minioadmin" \
     -e "MINIO_ROOT_PASSWORD=minioadmin" \
     minio/minio server /data --console-address ":9001"
   ```

2. **Access Minio Console:**
   - Open http://localhost:9001
   - Login: `minioadmin` / `minioadmin`

3. **Create a Bucket:**
   - Click "Create Bucket"
   - Name: `music`
   - Click "Create Bucket"

4. **Upload Audio Files:**
   - Click on the `music` bucket
   - Click "Upload" and select your audio files

5. **Configure Plugin in Spectra:**
   - Settings → Plugins → Object Storage
   - Provider: `minio`
   - Endpoint: `http://localhost:9000`
   - Access Key ID: `minioadmin`
   - Secret Access Key: `minioadmin`
   - Bucket: `music`

### Option B: Use AWS S3

1. **Create S3 Bucket:**
   - Go to AWS Console → S3
   - Create bucket (e.g., `my-music-library`)

2. **Create IAM User:**
   - Go to IAM → Users → Add User
   - Enable programmatic access
   - Attach policy: `AmazonS3ReadOnlyAccess` (or custom)
   - Save Access Key ID and Secret

3. **Configure Plugin:**
   - Settings → Plugins → Object Storage
   - Provider: `s3`
   - Endpoint: *(leave empty)*
   - Region: `us-east-1` (or your region)
   - Access Key ID: *(from IAM)*
   - Secret Access Key: *(from IAM)*
   - Bucket: `my-music-library`

## 3. Use the Plugin

1. **Enable Plugin:**
   - Go to Settings → Plugins
   - Find "Object Storage"
   - Toggle "Enabled" if not already

2. **Open Object Storage View:**
   - Click "Object Storage" in the sidebar (cloud icon)

3. **Connect:**
   - Click "Connect" button
   - Wait for "Connected ✓" status

4. **Browse Files:**
   - Optionally enter a path prefix
   - Click "Browse" or "Refresh"
   - View all audio files in your bucket

5. **Play or Import:**
   - Click "Play" to stream a file
   - Click "Import" to add to your library
   - Click "Import All" for batch import

## Troubleshooting

### "Connection failed"
- Check credentials
- Verify endpoint URL is correct
- Ensure bucket exists

### "No files found"
- Verify audio files are uploaded
- Check path prefix
- Ensure files have supported extensions (.flac, .mp3, etc.)

### Files don't play
- Enable "Cache Files" in settings
- Check network connection
- Verify file format is supported

## Next Steps

- Configure auto-sync for automatic discovery
- Adjust cache size based on your needs
- Set up path prefixes to organize your library
- Explore other storage providers (GCS, DigitalOcean, etc.)

For detailed configuration, see README.md
