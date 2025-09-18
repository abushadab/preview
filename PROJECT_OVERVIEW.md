# Preview Sandbox Platform — Project Overview

## Purpose
A secure, on‑demand sandbox platform that provisions ephemeral app containers reachable via wildcard subdomains (e.g., https://<id>.hellyo.io). It emphasizes security‑first defaults (non‑root, read‑only rootfs, capability dropping) while providing a reliable developer experience.

## Architecture
- Traefik: reverse proxy and wildcard routing (*.hellyo.io → Traefik → API/sandboxes)
- API (Node/Express): entrypoint, orchestration, health checking, logging, debug endpoints
- Redis (BullMQ): job queue for sandbox builds
- MinIO (S3‑compatible): storage for uploaded snapshots and artifacts
- Docker Engine (dockerode): container lifecycle management

## Request → Response Flow
1. Client POSTs files (base64) to API `/sandbox` with optional `healthPath`.
2. StorageService validates, tars, and uploads snapshot to MinIO (`sandbox/<id>/snapshot.tar`).
3. Job enqueued (dev or prod) → SandboxManager processes.
4. SandboxManager builds and runs a dev container with hardened HostConfig:
   - ReadonlyRootfs: true
   - User: `node` (non‑root)
   - Tmpfs mounts: `/tmp` (noexec), `/home/node/.local` (cache/tmp), `/work` (exec)
   - CapDrop: `ALL`, `SecurityOpt: no-new-privileges:true`
5. Start → Copy → Signal‑ready (dev):
   - Container starts first to materialize tmpfs mounts.
   - Files are copied into `/work` via exec‑untar (stream tar to `tar -x -C /work`).
   - `/work/.ready` is touched to release the wait loop and start the app (`npm i && npm start`).
6. Health checker probes readiness (30 attempts):
   - Prefers host port; falls back to Traefik with `Host: <id>.<domain>` header.
   - On success, emits: “Health check passed at /”.
7. Container is reachable at `https://<id>.<PREVIEW_DOMAIN>` via Traefik.
8. Cleanup: TTL + scheduled dockerode prune jobs.

## Security Posture (Dev)
- Non‑root user (`node`), read‑only root filesystem, no privileged caps
- Writable tmpfs mounts only where needed:
  - `/tmp`: `rw,noexec,nosuid,size=100m`
  - `/home/node/.local`: `rw,noexec,nosuid,size=200m,uid=1000,gid=1000` (cache/tmp)
  - `/work`: `rw,exec,nosuid,size=500m,uid=1000,gid=1000` (app files)
- No bind mounts; delivery via tar streaming (exec‑untar)

## Upload & Storage Protections
- Upload limits: 10MB per file, 50MB total, max 100 files; executable extensions blocked (exe, dll, so, dylib, bin)
- Path traversal prevention: blocks absolute paths and `..` segments
- Decompression bomb protection on snapshot tar:
  - Pre‑scan: max 100MB extracted, 1000 files, 50× compression ratio guard
  - Safe extract filter: no absolute paths, no `..`, no symlinks

## Health & Routing
- Health paths order: `/`, `/<healthPath or /health>`, `/api/health`
- Probes via host port when present or through Traefik with `Host: <id>.<domain>` header
- Success log: “Health check passed at /” (websocket + server log)

## Debug Endpoints (Read‑only)
- `GET /sandbox/:id/inspect` → filtered container info (ReadonlyRootfs, Tmpfs, user, status)
- `GET /sandbox/:id/logs/tail?lines=50` → recent container logs
- `GET /storage/:id/exists` → checks `sandbox/<id>/snapshot.tar` in MinIO (size, etag, lastModified)

## Key Environment Variables
- `PREVIEW_DOMAIN` — wildcard domain (e.g., `hellyo.io`)
- `REDIS_URL` — Redis connection string
- `S3_ENDPOINT`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_BUCKET`
- `DOCKER_NETWORK` — Docker network for Traefik/API
- `DEV_TTL_MINUTES`, `PROD_TTL_MINUTES` — TTLs for sandboxes

## Quick Acceptance Test (Happy Path)
1. Post a tiny app:
   - package.json: `{ "scripts": { "start": "node server.js" }, "dependencies": { "express": "^4.18.2" } }`
   - server.js: Express or pure `http` server responding “OK ONE‑SHOT” at `/`
   - `healthPath: "/"`
2. Watch logs: `GET /sandbox/:id/logs/tail?lines=100` → Look for “Health check passed at /”.
3. Verify routing: `curl -i https://<id>.<PREVIEW_DOMAIN>/` → `HTTP/200` with body.
4. Inspect + storage proof: `GET /sandbox/:id/inspect`, `GET /storage/:id/exists`.

## Troubleshooting
- 404 “page not found” → usually Traefik/Host header mismatch; curl Traefik locally with `-H 'Host: <id>.<domain>'`
- Health timeouts → confirm app listens on 3000 and healthPath matches; for Next.js, ensure dev mode or add a build step
- Copy failures under ReadonlyRootfs → ensure Start → Copy (exec‑untar) → Signal‑ready flow

## Cleanup & Operations
- Scheduled dockerode prune of containers/images/networks (no docker CLI)
- TTL deletion and Redis key removal per sandbox
- Structured logging throughout for probes, extraction, and cleanup

## Current Status
- Happy path (200 OK) achieved with security intact
- Exec‑untar delivery resolves ReadonlyRootfs constraint
- End‑to‑end flow verified: request → store → queue → start → copy → health → serve → cleanup

