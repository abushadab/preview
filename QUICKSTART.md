# Quick Start Guide

## 1. Setup Environment

```bash
# Copy environment configuration
cp .env.example .env

# Edit .env with your settings
nano .env
```

**Required changes:**
- `ACME_EMAIL`: Your email for SSL certificates
- `PREVIEW_DOMAIN`: Your wildcard domain (e.g., `preview.example.com`)
- `MINIO_ROOT_PASSWORD`: Strong password for MinIO

## 2. DNS Configuration

### For Cloudflare Proxy (Recommended):
1. In Cloudflare DNS, create:
   - **Type**: `A`
   - **Name**: `*.preview`
   - **Content**: `your-server-ip`
   - **Proxy**: 🟠 Proxied (orange cloud)
2. Set SSL/TLS mode to "Full (strict)"
3. See [SETUP-CLOUDFLARE.md](SETUP-CLOUDFLARE.md) for details

### For Standalone:
Create a wildcard A record pointing to your server:

```
*.preview.baytlabs.com.    IN    A    your-server-ip
```

## 3. Deploy

```bash
# Run deployment script
./scripts/deploy.sh
```

## 4. Test with Example

```bash
# Prepare example payload
node scripts/prepare-example.js

# Example usage:
cd examples/basic-next-app
curl -X POST http://api.preview.example.com/sandbox \
  -H "Content-Type: application/json" \
  -d @payloads/dev.json
```

## 5. Check Status

```bash
./scripts/status.sh
```

## 6. Access Your Sandbox

Visit: `https://<sandbox-id>.preview.example.com`

## What's Next?

- Read the full [README.md](README.md)
- Create your own projects
- Integrate with your CI/CD pipeline
- Add authentication and user management