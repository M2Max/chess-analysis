# Security Audit Report

- **Date:** 2026-09-03
- **Repo:** chesscom-review (app name: chess-analysis)
- **Method:** manual code review (server + client + Docker), `bun audit`
  (dependency vulnerability DB), secret patterns scan over the working tree
  and the **entire git history** (all 24 commits, every blob).

## Task 1 — Secret scanning & removal

**Result: no secrets found. Nothing to remove, no history rewrite needed.**

Scanned (working tree + full history):

| Pattern | Result |
|---|---|
| GitHub tokens (`ghp_/gho_/ghu_/ghs_/ghr_`), AWS (`AKIA…`), Google (`AIza…`), Slack (`xox…`), OpenAI (`sk-…`), Gitea tokens (`gt_…`) | 0 matches |
| Private key blocks (`BEGIN RSA/EC/OPENSSH/DSA PRIVATE KEY`) | 0 matches |
| Credentials in URLs (`user:pass@host`), `password=`, `api_key=`, `Authorization: Bearer/Basic …` | 0 matches |
| Files ever committed (checked for added-then-deleted configs, `.env`, key material) | only legitimate source/docs/config files |

Hygiene already in place (kept): `.gitignore` covers `.env`, `*.local`,
`data/` (the SQLite DB with game data), `node_modules/`, `dist/`. No
LAN addresses or self-hosted registry details remain in the tree (they were
replaced with placeholders before publishing to GitHub; the private LAN
copy of the repo keeps the concrete values in its history).

## Task 2 — Security hardening

### Fixed

1. **Container ran as root** (Dockerfile had no user directive).
   Now: the entrypoint chowns `/app/data` when started as root (covers
   host-mounted volumes owned by root), then drops to the unprivileged
   `node` user (uid 1000) via `su-exec` (added to the image). Verified:
   `ps aux` inside the running container shows `node bun server/index.ts`,
   and the DB files are created on a root-owned host mount.

2. **Unbounded JSON request bodies** on `PUT /api/db/games/{id}/analysis`
   and `POST /api/db/import` — a hostile LAN client could exhaust memory
   with a huge payload. Now capped at 10 MB (real analysis payloads are
   well under 1 MB); oversized bodies get HTTP 413.

3. **Static file serving: path-containment guard** (defense in depth).
   `join(DIST, pathname)` can resolve `..` segments; a resolved path
   escaping `dist/` now returns 404 instead of being served. (Percent-encoded
   `..%2f` probes were verified to hit only the SPA fallback, not files.)

### Reviewed and safe

- **SQL injection:** every query in `server/db.ts` uses prepared statements
  with `?` placeholders; dynamic fragments are only static condition strings
  and `?`-marks generated from array lengths. No user input in SQL text.
- **CORS:** no CORS headers set → browsers enforce same-origin by default.
- **Upstream fetch (SSRF surface):** usernames reach the chess.com URL only
  through `encodeURIComponent`; worst case is a nonsense upstream request.
- **No `eval`, no `child_process`, no shell strings** in server code.
- **TLS:** optional self-signed HTTPS; missing cert logs a warning and
  falls back to HTTP (documented; multi-threaded engine needs HTTPS by IP).
- **Dependencies:** `bun audit` → **no vulnerabilities found**
  (react 19, chess.js, react-chessboard, stockfish WASM, dev tooling).

### Residual risks / recommendations (no code change)

- **No API authentication** — deliberate for a single-user LAN app. Keep it
  behind the router/firewall and use the HTTPS deployment (TrueNAS). If the
  app ever goes beyond the LAN, add a shared token (env-configured) to the
  data API and send it from the client.
- **No rate limiting** on the data API (LAN-only exposure; low risk).
- **Vite dev server binds to the LAN** (`host: true`) — dev workflow only,
  never included in the Docker image. Don't run `bun run dev` on untrusted
  networks.
- **Self-signed certificate** must carry `SAN=DNS:localhost,IP:<lan-ip>`
  (healthcheck + Secure Contexts); regenerate on expiry (currently 365 d).

## Task 3 — Docker Compose → GitHub Container Registry

`docker-compose.yml` now references the image through overridable
environment variables:

```yaml
image: ${REGISTRY:-ghcr.io/<GITHUB_USER>}/chess-analysis:${TAG:-latest}
```

- **GHCR (default):** `ghcr.io/m2max/chess-analysis` (built by GitHub
  Actions, see Task 4). Pull auth: `docker login ghcr.io` with a
  fine-grained PAT scoped `packages: read` for that repo (or the
  account's classic token with `read:packages`).
- **Self-hosted LAN registry (override):** `REGISTRY=<host:port>/<user>
  docker compose up -d` for Gitea-style LAN deployments (an HTTP-only
  registry also needs the `insecure-registries` entry - see
  `scripts/truenas-insecure-registry.sh`).

## Task 4 — Multi-platform CI/CD (GitHub Actions)

**Status: implemented** in [`.github/workflows/docker.yml`](../.github/workflows/docker.yml)
(account confirmed: `M2Max`). Pipeline:

- Triggers: push to `main`, git tags, manual `workflow_dispatch`
- `docker/setup-buildx` + `docker/setup-qemu-action` (cross-compile)
- Platforms: `linux/amd64`, `linux/arm64` (RPi 4/5, ARMv8 servers),
  `linux/arm/v7` (32-bit Raspberry Pi 3/Zero)
- Tags: `latest` + commit SHA + tag name when publishing a release
- Push to `ghcr.io` with the built-in `GITHUB_TOKEN` (no secret needed for
  the same repo; package must exist or the workflow creates it)
- Idempotent: rebuilds are cache-friendly; failures abort before push
  (buildx pushes only on success)

Note: the Stockfish assets are architecture-independent WASM, so all three
platforms share the same app layers; only the Bun/Node base images differ.
