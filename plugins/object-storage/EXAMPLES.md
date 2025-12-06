# Object Storage Plugin - Example Configurations

## Minio (Local Development)

```json
{
  "provider": "minio",
  "endpoint": "http://localhost:9000",
  "region": "us-east-1",
  "accessKeyId": "minioadmin",
  "secretAccessKey": "minioadmin",
  "bucket": "music",
  "pathPrefix": "",
  "autoSync": true,
  "syncInterval": 300,
  "cacheFiles": true,
  "maxCacheSize": 2048
}
```

## AWS S3

```json
{
  "provider": "s3",
  "endpoint": "",
  "region": "us-east-1",
  "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
  "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "bucket": "my-music-bucket",
  "pathPrefix": "audio/",
  "autoSync": false,
  "syncInterval": 600,
  "cacheFiles": true,
  "maxCacheSize": 5120
}
```

## Google Cloud Storage

```json
{
  "provider": "gcs",
  "endpoint": "https://storage.googleapis.com",
  "region": "auto",
  "accessKeyId": "GOOG1EXAMPLE",
  "secretAccessKey": "example-secret-key",
  "bucket": "my-music-bucket",
  "pathPrefix": "albums/",
  "autoSync": false,
  "syncInterval": 300,
  "cacheFiles": true,
  "maxCacheSize": 4096
}
```

## DigitalOcean Spaces

```json
{
  "provider": "s3",
  "endpoint": "https://nyc3.digitaloceanspaces.com",
  "region": "us-east-1",
  "accessKeyId": "DO00EXAMPLE",
  "secretAccessKey": "example-secret-key",
  "bucket": "my-space-name",
  "pathPrefix": "music/",
  "autoSync": true,
  "syncInterval": 300,
  "cacheFiles": true,
  "maxCacheSize": 3072
}
```

## Backblaze B2

```json
{
  "provider": "s3",
  "endpoint": "https://s3.us-west-000.backblazeb2.com",
  "region": "us-west-000",
  "accessKeyId": "000examplekeyid0000000",
  "secretAccessKey": "K000exampleapplicationkey000000",
  "bucket": "my-b2-bucket",
  "pathPrefix": "",
  "autoSync": false,
  "syncInterval": 600,
  "cacheFiles": true,
  "maxCacheSize": 2048
}
```

## Wasabi

```json
{
  "provider": "s3",
  "endpoint": "https://s3.us-east-1.wasabisys.com",
  "region": "us-east-1",
  "accessKeyId": "EXAMPLE-ACCESS-KEY",
  "secretAccessKey": "example-secret-key",
  "bucket": "my-wasabi-bucket",
  "pathPrefix": "audio/flac/",
  "autoSync": true,
  "syncInterval": 300,
  "cacheFiles": true,
  "maxCacheSize": 4096
}
```

## Configuration Tips

### Path Prefix
- Use `""` (empty) to access entire bucket
- Use `music/` to limit to music folder
- Use `albums/rock/` for specific subfolder
- Always use forward slashes `/` regardless of OS

### Cache Settings
- `cacheFiles: true` - Better playback, uses disk space
- `cacheFiles: false` - Stream directly, no local storage
- `maxCacheSize` - Set based on available disk space (in MB)

### Auto Sync
- `autoSync: true` - Good for frequently updated buckets
- `autoSync: false` - Manual refresh, saves API calls
- `syncInterval` - In seconds (300 = 5 minutes)

### Performance
- Use smaller `pathPrefix` for faster browsing
- Increase `maxCacheSize` if you have space
- Disable `autoSync` if library is static
- Use region closest to your location
