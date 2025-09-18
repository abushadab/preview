# Preview Sandbox Platform — Test Plan

This document provides a concise, repeatable test plan to validate the preview sandbox platform end‑to‑end — security, routing, health, storage, cleanup, and guard rails.

## Prerequisites
- Stack running (Traefik, API, Redis, MinIO)
- Environment variables configured:
  - `PREVIEW_DOMAIN` (e.g., `hellyo.io`)
  - `REDIS_URL`, `S3_ENDPOINT`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_BUCKET`
  - `DOCKER_NETWORK` (Traefik/API network)
- API base: `http://localhost:3001`

## Debug Endpoints (read‑only)
- `GET /sandbox/:id/inspect` — filtered container info (ReadonlyRootfs, Tmpfs, user, status)
- `GET /sandbox/:id/logs/tail?lines=50` — recent container logs
- `GET /storage/:id/exists` — snapshot existence + metadata

## New Diagnostic Endpoints
- `GET /debug/queue` — quick snapshot of queue health
  - Details: Redis URL + ping time, waiting/active/delayed/failed/completed counts for build & dev queues, and whether each worker is attached and running
- `GET /debug/docker` — confirm Docker daemon connectivity and list sandbox containers
  - Details: ping latency, Docker version/info summary, and all containers labeled sandbox=true with id/name/state/status
- `GET /debug/docker?dryRun=1` — end-to-end container sanity test without leaving artifacts
  - Flow: pulls node:20-bullseye if needed, creates a sandbox-like container (ReadonlyRootfs, tmpfs /work), writes & reads a marker file inside /work, then removes the container
  - Returns dry-run metadata (container name, exit code, stdout/stderr of the probe)

### Usage Examples
- Queue snapshot: `curl -sS -H 'Host: api.<domain>' http://localhost/debug/queue | jq .`
- Docker health: `curl -sS -H 'Host: api.<domain>' http://localhost/debug/docker | jq .`
- Dry-run check: `curl -sS -H 'Host: api.<domain>' 'http://localhost/debug/docker?dryRun=1' | jq .`

These diagnostics help distinguish queue/worker issues from Docker access problems and provide actionable telemetry for ops

## 1) Happy‑Path Validation (minimal app)
- Minimal app payload:
  - package.json: `{ "name": "os-one-shot", "version":"1.0.0", "scripts": { "start": "node server.js" } }`
  - Option A (no deps): `server.js` with Node http server: `http.createServer((_,res)=>res.end('OK ONE-SHOT')).listen(3000)`
  - Option B (Express): add `dependencies: { "express": "^4.18.2" }` and serve at `/`
- Steps:
  1. POST `/sandbox` with `healthPath: "/"` and the minimal app files (base64).
  2. Tail logs `GET /sandbox/:id/logs/tail?lines=100` until you see: `Health check passed at /`.
  3. Verify routing: `curl -i https://<id>.<PREVIEW_DOMAIN>/` → expect `HTTP/200` with body (e.g., `OK ONE-SHOT`).
  4. Inspect proof: `GET /sandbox/:id/inspect` → `ReadonlyRootfs: true`, `user: node`, `Tmpfs` with `uid=1000,gid=1000` for `/home/node/.local` and `/work`.
  5. Storage proof: `GET /storage/:id/exists` → size, etag, lastModified for `sandbox/<id>/snapshot.tar`.

## 2) Size Guard Tests
- Oversized upload (>50MB total): POST `/sandbox` with content >50MB → expect 400 JSON (total size limit).
- Pre‑scan fail (decompression protection): POST a crafted tar exceeding pre‑scan caps → expect 400 JSON with security scan error.

## 3) Failure Case (missing package.json)
- POST `/sandbox` with only `server.js` → expect a clear error and no lingering container.
- Optional: confirm via `GET /sandbox/:id/inspect` returns 404 after cleanup.

## 4) Concurrency Test
- Create 5 minimal‑app sandboxes quickly.
- Expect all pass health. Watch for resource spikes; verify no container name conflicts.

## 5) Cleanup Verification
- TTL expiry: wait for `DEV_TTL_MINUTES` expiration; confirm containers removed and Redis keys deleted.
- Scheduled prune: check API logs for dockerode prune summaries (containers/images/networks), no docker CLI usage.

## 6) Next.js Quick Check (optional)
- Post a Next.js dev sample (or add build then `next start`).
- Use `healthPath: "/"`. Confirm either:
  - Dev server responds 200 at `/`, or
  - For `next start`, ensure a build step is included before start.

## Routing Tips
- If curl to wildcard URL fails, try Traefik locally: `curl -i -H "Host: <id>.<PREVIEW_DOMAIN>" http://localhost/`
- Confirm health paths order: `/`, `<healthPath or /health>`, `/api/health`.

## Troubleshooting
- Health timeouts: confirm app is listening on 3000; check logs for start failures.
- Copy failures under ReadonlyRootfs: ensure Start → Copy (exec‑untar) → Signal‑ready flow is active and logs show `Successfully copied files to /work`.
- 404 at Traefik: validate router rules and Host header; ensure container is `running`.

## Acceptance Criteria (recap)
- Health pass log present: `Health check passed at /`.
- Wildcard URL returns `HTTP/200` with body.
- Inspect JSON shows security posture (ReadonlyRootfs, non‑root, tmpfs ownership).
- Storage existence confirmed with metadata.
- Size guards return 400 for oversize and pre‑scan failures.
- Cleanup/TTL functioning correctly.

