# Preview Sandbox Platform – Operations Runbook v1.3.0

**Provenance**: Prepared by GLM4.5; approved by platform owner on 2025-01-17

---

## Environment & Bootstrapping

### Minimal `.env` Schema

```bash
# Domain Configuration
PREVIEW_DOMAIN=hellyo.io

# API Security
API_TOKEN=****
API_TOKEN_FILE=/run/secrets/api_token

# Redis Configuration
REDIS_URL=redis://redis:6379

# Resource Limits
MAX_FILE_SIZE=2097152     # 2MB
MAX_TOTAL_SIZE=8388608    # 8MB
MAX_FILES=100

# Container Image Tag
IMAGE_TAG=1.3.0          # Pin for reproducible deploys, safer rollbacks
```

### Service Bootstrap

```bash
# Start all services
cd preview
docker compose up -d

# Verify Traefik exposes only :80
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep traefik
# Expected: preview-traefik-1  0.0.0.0:80->80/tcp

# Verify no direct API port exposure
docker ps --format '{{.Ports}}' | grep -E '3001|:3001' || echo "✅ No host port 3001 exposure"
```

---

## 10-Minute Truth Test (CLI)

### Health & Routing Validation

```bash
# 1. Verify Traefik routing with Host header
code=$(curl -s -o /tmp/h.json -w '%{http_code}' -H "Host: api.${PREVIEW_DOMAIN}" http://127.0.0.1/health)
jq -e '.status=="ok" and (.response_id|length>0)' /tmp/h.json >/dev/null && [ "$code" = "200" ] && echo "✅ Health OK" || echo "❌ Health failed"
# Expected: HTTP 200 with status "ok" and non-empty response_id

# 2. Verify admin routes 401 without token
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: api.${PREVIEW_DOMAIN}" http://127.0.0.1/debug/queue)
echo "Status: $code"
# Expected: 401

# 3. Verify admin routes work with proper token
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: api.${PREVIEW_DOMAIN}" -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1/debug/queue)
echo "Status: $code"
# Expected: 200 (authorized + endpoint exists)
# If debug route is disabled in some environments, accept 404/200

# 4. Verify API connectivity to Redis service
docker exec preview-api-1 node -e "require('net').connect(6379,'redis').on('connect',()=>{console.log('✅ Redis TCP OK');process.exit(0)}).on('error',()=>process.exit(1))"
# Expected: Redis TCP OK
```

### Content & Size Validation

```bash
# 5. Test 413 - Request entity too large (12MB payload)
python3 - <<'PY' | curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Host: api.${PREVIEW_DOMAIN}' \
  -H 'Content-Type: application/json' \
  --data-binary @- http://127.0.0.1/sandbox
import sys, json, base64
blob = b"A" * (12*1024*1024)  # 12MB
payload = {"healthPath":"/","files":[{"path":"oversized.txt","content":base64.b64encode(blob).decode()}]}
sys.stdout.write(json.dumps(payload))
PY
# Expected: 413

# 6. Test 415 - Unsupported content type
code=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Host: api.${PREVIEW_DOMAIN}' \
  -H 'Content-Type: application/octet-stream' \
  -d '{"test":"data"}' \
  http://127.0.0.1/sandbox)
echo "Status: $code"
# Expected: 415
```

### Readiness Endpoint Validation

```bash
# 7. Test /ready endpoint with auth (requires fallback probe)
curl -s -H "Host: api.${PREVIEW_DOMAIN}" \
     -H "Authorization: Bearer $API_TOKEN" \
     http://127.0.0.1/sandbox/demo-id/ready | jq -e '.ready && .method'
# Expected: {"ready":true,"status":200,"method":"curl|wget|node","response_time":<ms>}
```

---

## Micro Go-Live Checklist

```bash
# Verify no :3001 host port exposure (security)
docker ps --format '{{.Ports}}' | grep -E '3001|:3001' && echo "❌ Port 3001 exposed" || echo "✅ No port 3001 exposure"

# Verify Traefik labels present (routing)
docker inspect preview-api-1 --format='{{index .Config.Labels}}' | grep -q "traefik.http.routers.api-admin" && echo "✅ Traefik labels present" || echo "❌ Missing Traefik labels"

# Verify docker network constraint (isolation)
docker inspect -f '{{json .NetworkSettings.Networks}}' preview-traefik-1 | jq -e 'has("preview_sbx-network")' && echo "✅ Network constraint set" || echo "❌ Network constraint missing"

# Verify IP allowlist middleware (access control)
docker inspect preview-api-1 --format='{{index .Config.Labels}}' | grep -q "127.0.0.1/32,172.18.0.0/16" && echo "✅ IP allowlist correct" || echo "❌ IP allowlist incorrect"

# Verify docker.sock read-only mount (security)
docker inspect preview-traefik-1 --format='{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}{{.Type}}{{end}}{{end}}' | grep -q "bind" && echo "✅ docker.sock mounted" || echo "❌ docker.sock not mounted"
docker inspect preview-traefik-1 --format='{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}{{if eq .RW false}}ro{{end}}{{end}}{{end}}' | grep -q "ro" && echo "✅ docker.sock read-only" || echo "❌ docker.sock not read-only"
```

**Go-Live Decision**: All checks must pass ✅ before production deployment.

---

## Operational Procedures

### Backups & Restores

#### MinIO Backup/Restore

```bash
# MinIO Backup (ephemeral mc container)
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
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
echo "Backup completed: backups/s3-backup-$BACKUP_DATE.tar.gz"

# MinIO Restore
backup_file="backups/s3-backup-20240101_120000.tar.gz"
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
echo "Restore completed from $backup_file"
```

#### Redis Data Integrity Checks

```bash
# Redis RDB verification
docker run --rm -v "$(pwd)/backups":/data \
  redis/redis-check-rdb /data/redis-dump-20240101.rdb

# Redis AOF verification
docker run --rm -v "$(pwd)/backups":/data \
  redis/redis-check-aof /data/redis-appendonly-20240101.aof
```

#### At-Rest Encryption

```bash
# Age encryption setup
age-keygen -o ops.agekey
# Extract public key for safekeeping
age-keygen -y ops.agekey > ops.agekey.pub

# Encrypt backups
find backups -name "*.tar.gz" -exec sh -c '
  PUB=$(cat ops.agekey.pub)
  age -r "$PUB" -o "{}.age" "{}"
  rm "{}"  # Optional: remove original after encryption
' \;

# Decrypt backup
age -d -i ops.agekey backup.tar.gz.age -o backup.tar.gz
```

### RTO/RPO Targets

**Recovery Objectives**:
- **RTO**: 15 minutes (time to restore service)
- **RPO**: 5 minutes (data loss tolerance)

```bash
# RTO Validation Script
start_time=$(date +%s)
docker compose down
docker compose up -d
sleep 30

# Wait for health endpoint
while ! curl -s -H "Host: api.${PREVIEW_DOMAIN}" http://127.0.0.1/health > /dev/null; do
  sleep 5
  echo "Waiting for health endpoint..."
done

end_time=$(date +%s)
rto=$((end_time - start_time))
echo "RTO achieved: ${rto}s (target: 900s)"

# RPO Validation - check backup frequency
if find backups -name "*.tar.gz" -mmin -5 | grep -q .; then
  echo "✅ RPO met (recent backup within 5 minutes)"
else
  echo "⚠️  RPO may be exceeded (no backup within 5 minutes)"
fi
```

### Disaster Recovery

```bash
# Full disaster recovery workflow (cross-links to backup/restore above)
cd preview

# 1. Stop all services
docker compose down

# 2. Validate configuration files
echo "Validating configuration..."
docker compose config > /dev/null && echo "✅ Config valid" || { echo "❌ Config invalid"; exit 1; }

# 3. Restore from most recent backup (use backup/restore procedure above)
latest_backup=$(ls -t backups/s3-backup-*.tar.gz | head -1)
if [ -n "$latest_backup" ]; then
  echo "Restoring from $latest_backup"
  docker run --rm --name mc-disaster-restore \
    --network preview_sbx-network \
    -v "$(pwd)/backups":/backups \
    --env-file preview/.env \
    minio/mc sh -lc '
      set -e
      tar -xzf /backups/$(basename "'"$latest_backup"'") -C /tmp
      mc alias set minio http://preview-minio-1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
      mc mb --ignore-existing minio/"$S3_BUCKET"
      mc cp --recursive /tmp/"$S3_BUCKET"-backup-*/ minio/"$S3_BUCKET"/
    '
  echo "✅ Data restored"
else
  echo "⚠️  No backup found - starting fresh"
fi

# 4. Start services
docker compose up -d

# 5. Verify health
echo "Verifying service health..."
for i in {1..30}; do
  if curl -s -H "Host: api.${PREVIEW_DOMAIN}" http://127.0.0.1/health > /dev/null; then
    echo "✅ Disaster recovery completed successfully"
    exit 0
  fi
  sleep 2
  echo "Attempt $i: Waiting for services..."
done

echo "❌ Disaster recovery failed"
exit 1
```

### Rollback from Failed Canary

```bash
# Canary rollback checklist
# 1. Verify backup exists before canary deployment
latest_backup=$(ls -t backups/s3-backup-*.tar.gz | head -1)
[ -n "$latest_backup" ] || { echo "❌ No backup for rollback"; exit 1; }

# 2. Tag current version
docker compose ps --format json | jq -r '.[].Service' | while read svc; do
  if [ "$svc" = "api" ]; then
    docker tag preview-api:latest preview-api:canary-failed-$(date +%Y%m%d_%H%M%S)
  fi
done

# 3. Restore previous image tag
export IMAGE_TAG=1.2.0  # Previous version
docker compose down api
docker compose up -d api

# 4. Verify health
curl -s -H "Host: api.${PREVIEW_DOMAIN}" http://127.0.0.1/health | jq -e '.status=="ok"'

# 5. Optional: restore MinIO if data migration occurred
# (Use MinIO restore procedure above)
```

---

## Security Posture

### Authentication & Authorization

**Admin Endpoint Coverage**:
- All `/debug/*` routes require Bearer token via `Authorization: Bearer $API_TOKEN`
- `/sandbox/*` routes require Bearer token except for `/health`
- Token validation is pre-middleware on protected routes

```bash
# Test auth coverage
# Without token - should 401
curl -s -H "Host: api.${PREVIEW_DOMAIN}" -o /dev/null -w '%{http_code}' http://127.0.0.1/debug/queue
# Expected: 401

# With token - should work
curl -s -H "Host: api.${PREVIEW_DOMAIN}" -H "Authorization: Bearer $API_TOKEN" -o /dev/null -w '%{http_code}' http://127.0.0.1/debug/queue
# Expected: 200 (or 404 if debug route disabled)

# Verify no auth tokens in logs (security)
docker logs --tail=100 preview-api-1 | grep -c "Authorization" | grep -q '^0$' && echo "✅ No auth tokens in logs" || echo "⚠️  Auth tokens found in logs"
```

### Network & Resource Controls

- **IP Allowlist**: `127.0.0.1/32,172.18.0.0/16` (localhost + Docker private subnet)
- **Body Limits**: Express `limit: '10mb'`, application logic enforces `MAX_FILE_SIZE=2MB`
- **Rate Limiting**: 100 requests per minute, 50 burst capacity
- **Network Isolation**: `preview_sbx-network` for internal communication

```bash
# Verify IP allowlist protection
# From outside subnet (should be blocked)
curl -s -H "Host: api.${PREVIEW_DOMAIN}" -H "X-Forwarded-For: 192.168.1.100" -o /dev/null -w '%{http_code}' http://127.0.0.1/debug/queue
# Expected: 403 (Traefik middleware rejection)
```

### Secret Management

**Preferred Approach**:
```yaml
# Use Docker secrets for sensitive data
services:
  api:
    environment:
      - API_TOKEN_FILE=/run/secrets/api_token
    secrets:
      - api_token
secrets:
  api_token:
    external: true
```

**File Permissions**:
```bash
# Docker sets restrictive perms automatically
# Note: chmod 600 /run/secrets/api_token generally not needed
chmod 600 preview/.env
```

### Docker Socket Security

**Risk Note**: Docker socket mount (`/var/run/docker.sock:ro`) provides container management capabilities. Consider socket proxy for additional isolation:

```yaml
# Socket proxy alternative (reduced privilege)
socket-proxy:
  image: tecnativa/docker-socket-proxy
  environment:
    CONTAINERS: 1
    INFO: 1
    VERSION: 1
    EXEC: 0
    PRIVILEGE: 0
    networks:
      - preview_sbx-network
```

---

## Observability

### Request ID Propagation

```bash
# Test X-Request-ID flow
request_id=$(uuidgen)
curl -s -H "Host: api.${PREVIEW_DOMAIN}" -H "X-Request-ID: $request_id" http://127.0.0.1/health | jq -r '.request_id // empty'
# Expected: Echoes $request_id if header provided
```

### Recommended Metrics

```javascript
// Auth metrics
auth_failures_counter = new Counter({
  name: 'auth_failures_total',
  help: 'Failed authentication attempts',
  labelNames: ['endpoint']
});

// Content validation errors
content_errors_counter = new Counter({
  name: 'content_validation_errors_total',
  help: 'Content type validation failures',
  labelNames: ['status_code'] // 413, 415
});

// Readiness probe metrics
readiness_probes_counter = new Counter({
  name: 'readiness_probes_total',
  help: 'Readiness endpoint calls',
  labelNames: ['method', 'success'] // curl, wget, node; true/false
});
```

### Optional `/metrics` Endpoint Pattern

```javascript
// Auth-required metrics endpoint
app.get('/metrics', requireAuth, async (req, res) => {
  const metrics = await registry.metrics();
  res.set('Content-Type', registry.contentType);
  res.end(metrics);
});
```

**Access**:
```bash
curl -s -H "Host: api.${PREVIEW_DOMAIN}" \
     -H "Authorization: Bearer $API_TOKEN" \
     http://127.0.0.1/metrics
```

---

## Error Code Reference

| Scenario | HTTP Code | Description |
|----------|-----------|-------------|
| Auth missing/invalid | 401 | Bearer token not provided or incorrect |
| IP not allowlisted | 403 | Source IP outside allowed ranges |
| Request body > 10MB | 413 | Entity too large (Traefik middleware) |
| File > 2MB | 413 | Application size limit exceeded |
| Non-JSON content type | 415 | Content-Type not `application/json` |
| Health check | 200 | Service healthy with response_id |
| Debug route success | 200 | Authorized and endpoint exists |
| Debug route not found | 404 | Endpoint disabled or does not exist |

---

## Make Targets Cheat-Sheet

| Target | Purpose | Oneliner |
|--------|---------|----------|
| `prereq` | Service health validation | Docker + Redis + MinIO health checks |
| `auth-test` | Authentication enforcement | Unauthorized 401 → Authorized 404 validation |
| `health-obs-test` | Health endpoint observability | `response_id`, `git_sha`, `image_tag` validation |
| `test-size-guard` | Content size limits | 2MB success, 12MB 413 rejection |
| `all-tests` | Full test suite | All above targets sequenced |

```bash
# Prerequisites check
make prereq

# Authentication test
make auth-test

# Health observability test
make health-obs-test

# Size guard test
make test-size-guard

# Run all tests
make all-tests
```

---

## CI "Truth Test" Sketch

### Assertions & Validation

```yaml
# .github/workflows/truth-test.yml
name: CI Truth Test
on: [push, pull_request]

jobs:
  truth-test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - run: |
        cd preview
        docker compose up -d
        sleep 30

        # Assert health endpoint observability
        response=$(curl -s -H "Host: api.${PREVIEW_DOMAIN}" http://localhost/health)
        echo "$response" | jq -e '.response_id' || { echo "❌ Missing response_id"; exit 1; }

        # Assert authentication enforcement
        code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: api.${PREVIEW_DOMAIN}" http://localhost/debug/queue)
        [ "$code" = "401" ] || { echo "❌ Expected 401 for unauth, got $code"; exit 1; }

        code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: api.${PREVIEW_DOMAIN}" -H "Authorization: Bearer $API_TOKEN" http://localhost/debug/queue)
        [ "$code" = "404" ] && echo "ℹ️  Debug route disabled (404)" || [ "$code" = "200" ] && echo "✅ Debug route active (200)" || { echo "❌ Expected 404/200 for auth, got $code"; exit 1; }

        # Assert content size limits
        python3 -c 'import json, base64; print(json.dumps({"files": [{"content": "A"*11000000, "path": "big"}]}))' | \
          curl -s -o /dev/null -w '%{http_code}' -H 'Host: api.${PREVIEW_DOMAIN}' -H 'Content-Type: application/json' --data-binary @- http://localhost/sandbox | \
          grep -q '413'

        # Assert content type validation
        code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: api.${PREVIEW_DOMAIN}' -H 'Content-Type: application/octet-stream' -d '{}' http://localhost/sandbox)
        [ "$code" = "415" ] || { echo "❌ Expected 415 for wrong content type, got $code"; exit 1; }

        # Assert no port 3001 exposure
        docker ps --format '{{.Ports}}' | grep -q '3001' && { echo "❌ Port 3001 exposed"; exit 1; }

        # Assert PREVIEW_DOMAIN respect
        curl -s -H "Host: api.${PREVIEW_DOMAIN}" http://localhost/health | jq -e '.status' || { echo "❌ PREVIEW_DOMAIN not respected"; exit 1; }

        echo "✅ All truth test assertions passed"
```

---

## Traefik v3 Reference Block

### Complete Traefik Labels

```yaml
services:
  api:
    labels:
      # Traefik network constraint
      - "traefik.docker.network=preview_sbx-network"

      # Single service definition (avoid autolinking conflicts)
      - "traefik.http.services.api.loadbalancer.server.port=3001"

      # Request body limiting (10MB)
      - "traefik.http.middlewares.limit.buffering.maxRequestBodyBytes=10485760"

      # IP allowlist middleware (lowercase labels)
      - "traefik.http.middlewares.admin-allowlist.ipallowlist.sourcerange=127.0.0.1/32,172.18.0.0/16"

      # Rate limiting middleware (100 req/min, 50 burst)
      - "traefik.http.middlewares.rate-limit.ratelimit.average=100"
      - "traefik.http.middlewares.rate-limit.ratelimit.burst=50"
      - "traefik.http.middlewares.rate-limit.ratelimit.period=1m"

      # Public router (health endpoint only)
      - "traefik.http.routers.api-public.rule=Host(`api.${PREVIEW_DOMAIN}`) && PathPrefix(`/health`)"
      - "traefik.http.routers.api-public.middlewares=limit"
      - "traefik.http.routers.api-public.service=api"

      # Admin router (all endpoints, protected)
      - "traefik.http.routers.api-admin.rule=Host(`api.${PREVIEW_DOMAIN}`)"
      - "traefik.http.routers.api-admin.middlewares=admin-allowlist,rate-limit,limit"
      - "traefik.http.routers.api-admin.service=api"
```

**Note**: Traefik v3 labels use lowercase keys (`ipallowlist`, `ratelimit`, `buffering`) even though some dynamic config uses camelCase.

---

## Glossary

| Term | Definition |
|------|------------|
| **Router** | Traefik component that routes incoming requests based on matching rules (Host, Path, Headers) |
| **Service** | Traefik component that defines how to forward requests to backend containers |
| **Middleware** | Traefik component that processes requests before routing (rate limiting, auth, headers) |
| **Load Balancer** | Service component that distributes traffic across multiple backend instances |
| **IP Allowlist** | Network access control restricting source IP addresses to specific ranges |
| **Rate Limiting** | Traffic control mechanism limiting requests per time period (100/min, burst 50) |
| **RTO** | Recovery Time Objective - maximum acceptable time to restore service after failure |
| **RPO** | Recovery Point Objective - maximum acceptable data loss measured in time |
| **Buffering** | Middleware that controls request/response body sizes (10MB limit) |
| **Service DNS** | Docker internal DNS resolution (e.g., `redis` resolves to Redis container IP) |
| **Fallback Probe** | Multi-method health check using sequential tool attempts (curl→wget→node) |
| **Bearer Token** | Authentication scheme where `Authorization: Bearer <token>` grants access |