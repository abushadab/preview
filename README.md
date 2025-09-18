# Next.js Sandbox Preview Platform

A platform for creating isolated Next.js sandbox environments with automatic provisioning, TTL cleanup, and shareable preview URLs.

## Architecture

- **API Server**: Node.js/Express with BullMQ for job queues
- **Orchestration**: Docker for container isolation, Traefik for routing
- **Storage**: MinIO for S3-compatible storage (snapshots, build artifacts, dependency cache)
- **Queue**: Redis for BullMQ job processing
- **Web**: Next.js applications running in isolated containers

## Features

- **Development Sandboxes**: Live `next dev` environments with hot reload
- **Production Previews**: Built `next start` containers with static assets
- **Isolated Environments**: Each sandbox runs in its own Docker container
- **Wildcard Subdomains**: Each sandbox gets `https://<id>.preview.example.com`
- **Automatic TTL**: Sandboxes are automatically cleaned up after expiration
- **Resource Limits**: CPU, memory, and PIDs limits per sandbox
- **Real-time Logs**: WebSocket streaming of container logs
- **Dependency Caching**: pnpm store caching for faster builds

## Quick Start

### Prerequisites

- Node.js 18+
- Docker with rootless mode
- Linux host (tested on Ubuntu 20.04+)

### Configuration

1. Copy and configure `.env`:

   ```bash
   cp .env.example .env
   # Edit with your domain and settings
   ```

2. **For Cloudflare Proxy** (recommended):
   - See [SETUP-CLOUDFLARE.md](SETUP-CLOUDFLARE.md) for detailed setup
   - Create A record: `*.preview.baytlabs.com` → your-server-ip (proxied)
   - Configure Cloudflare SSL/TLS as "Full (strict)"

3. **For standalone deployment**:
   - Create A record: `*.preview.example.com` → your-server-ip (DNS only)

### Deployment

1. Build and start the platform:
   ```bash
   docker compose up -d
   ```

2. Check services:
   ```bash
   docker compose ps
   ```

3. View logs:
   ```bash
   docker compose logs -f api
   ```

## API Usage

### Create a Development Sandbox

```bash
curl -X POST http://api.preview.example.com/sandbox \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "dev",
    "ttlMinutes": 45,
    "files": [
      {
        "path": "package.json",
        "content": "eyJuYW1lIjoidGVzdC1hcHAi..."
      }
    ]
  }'
```

### Create a Production Sandbox

```bash
curl -X POST http://api.preview.example.com/sandbox \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "prod",
    "ttlMinutes": 240,
    "files": [
      {
        "path": "package.json",
        "content": "eyJuYW1lIjoidGVzdC1hcHAi..."
      }
    ]
  }'
```

### Check Sandbox Status

```bash
curl http://api.preview.example.com/sandbox/{sandbox_id}
```

### Stop a Sandbox

```bash
curl -X DELETE http://api.preview.example.com/sandbox/{sandbox_id}
```

### Stream Logs

Connect to WebSocket:
```
ws://api.preview.example.com/sandbox/{sandbox_id}/logs? sandboxId={sandbox_id}
```

## File Format

Files should be provided as base64-encoded strings:

```json
{
  "files": [
    {
      "path": "app/page.tsx",
      "content": "ZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gSG9tZSgpIHsKICByZXR1cm4gPGgxPkhlbGxvPC9oMT47Cn0="
    }
  ]
}
```

## Example

See `examples/basic-next-app/` for a complete example that can be uploaded.

## Security

- **Rootless Docker**: All containers run without root privileges
- **Network Isolation**: Sandboxes run in isolated Docker networks
- **Resource Limits**: CPU, memory, and PIDs enforced per container
- **TTL Cleanup**: Automatic sandbox cleanup to prevent resource leaks
- **Read-only Volumes**: Host Docker socket mounted read-only

## Monitoring

- **Traefik Dashboard**: Available at `http://localhost:8080` (if exposed)
- **Redis**: Monitor queue/backlog sizes
- **MinIO Console**: Available at `http://minio-console.preview.example.com`

## Development

### Local Development

```bash
cd api
npm install
npm run dev
```

### Testing

Test with the example application:

```bash
# Convert example to base64 files
node scripts/prepare-example.js

# Send to API
curl -X POST http://localhost:3001/sandbox \
  -H "Content-Type: application/json" \
  -d @examples/basic-next-app/payload.json
```

## Troubleshooting

### Common Issues

1. **SSL Certificate Issues**: Ensure wildcard domain is properly configured
2. **Docker Permission Issues**: Verify user is in docker group and rootless is enabled
3. **Queue Backlog**: Check Redis connection and worker status
4. **Memory Limits**: Adjust DEFAULT_MEM and DEFAULT_CPU in .env

### Logs

- API: `docker compose logs -f api`
- Traefik: `docker compose logs -f traefik`
- Redis: `docker compose logs -f redis`
- MinIO: `docker compose logs -f minio`

## Scaling

Default limits (adjust in .env):
- Concurrent builds: 3
- Dev sandboxes: 15-20 concurrent
- Prod sandboxes: 40-50 concurrent
- Memory per dev: 768MB
- Memory per prod: 256MB

## License

MIT