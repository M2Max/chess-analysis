# Deployment

Docker → container registry → TrueNAS Scale. For the local quick start see
the [README](../README.md).

## Image sources

- **GitHub Container Registry (default):** images are built automatically
  by GitHub Actions on every push to `main` (see
  [`.github/workflows/docker.yml`](./.github/workflows/docker.yml)) for
  `linux/amd64` (TrueNAS Scale, x86_64 servers) and `linux/arm64`
  (Raspberry Pi 4/5, ARMv8), assembled into a multi-arch manifest and
  published as `ghcr.io/<owner>/chess-analysis` with tags `latest`,
  `sha-<commit>` and the version tag.
  Pull: `docker login ghcr.io` (token with `packages: read`), then
  `docker compose up -d`.
  (32-bit Raspberry Pi 3 / Zero are not supported: the Bun runtime has no
  `arm/v7` builds.)
- **Self-hosted registry (e.g. Gitea on the LAN):** build locally and push:

```bash
export REGISTRY=<host:port>/<user>   # must be exported (bun run doesn't expand var prefixes)
bun run docker:build    # linux/amd64
bun run docker:tag
bun run docker:push
```

  Then deploy with `REGISTRY=<host:port>/<user> docker compose up -d`.

### Deploy on TrueNAS Scale

#### 0. (HTTP LAN registries only) Whitelist the registry as insecure (PERSISTENT - one-time)

A self-hosted registry on the LAN usually serves **HTTP, not HTTPS**
(GHCR is HTTPS and needs none of this). Docker refuses to pull from it
unless it's listed in `insecure-registries` in `/etc/docker/daemon.json`.
On TrueNAS Scale, **manual edits to that file are wiped on reboot /
upgrade** (TrueNAS regenerates it from its config DB) - so editing it by
hand works once, then disappears.

Make it persistent with an **Init/Shutdown Script** that re-applies it at
every boot. A ready-made idempotent script is provided at
[`scripts/truenas-insecure-registry.sh`](./scripts/truenas-insecure-registry.sh)
(it whitelists one registry host:port - set it in the script or via the
`REGISTRY` env var):

1. Copy the script onto TrueNAS, e.g. `/mnt/tank/scripts/truenas-insecure-registry.sh`, `chmod +x`.
2. **System Settings → Advanced → Init/Shutdown Scripts → Add**
   - Description: `Whitelist LAN registry as insecure`
   - Type: `Command`, When: `Post Init`
   - Command/Path: `/mnt/tank/scripts/truenas-insecure-registry.sh`
3. Save, run it once (or reboot). Verify:
   ```bash
   docker info | grep -A6 "Insecure Registries"   # should list your registry host:port
   ```

#### 1. Generate the self-signed certificate

The multi-threaded Stockfish needs `SharedArrayBuffer`, which browsers only
allow in a **secure context**. Over a LAN you reach the app by IP
(`https://192.168.x.y:35102`), and a bare IP is only "secure" over HTTPS
(`http://localhost` is the sole exception). So the app must serve HTTPS -
with a self-signed cert you generate on the host. **The cert must carry a
SAN for `localhost`** (the container healthcheck connects to
`https://localhost:3000`) and the LAN IP:

```bash
# in the app's folder on TrueNAS (next to docker-compose.yml)
# <your-LAN-IP> = the IP you open the app with (the TrueNAS box's LAN IP)
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -nodes -days 365 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=<your-LAN-IP>" \
  -addext "subjectAltName=DNS:localhost,IP:<your-LAN-IP>"
```

The compose file mounts `./certs` read-only and sets `HTTPS=true`,
`SSL_KEY=/app/certs/key.pem`, `SSL_CERT=/app/certs/cert.pem`. If the cert
is missing the server still boots but **falls back to plain HTTP** and logs
a warning - the app works, only the multi-threaded engine is unavailable.

#### 2. Install as Custom App

**Apps → Discover Apps → Custom App → Install via YAML**, paste
[`docker-compose.yml`](./docker-compose.yml) (create the `certs/` folder
from step 1 in the app's folder first). Then open
`https://<truenas-ip>:35102`. Your browser will warn about the self-signed
cert - Advanced → **Proceed** (or “Accept the risk and continue” on
Android). Once accepted, the page is a secure context and multi-threaded
Stockfish is active. Your personal settings (engine, threads, …) live in
the browser's localStorage; the players' games and analyses live in the
SQLite database on the `./data` volume (see **Data & backup**).

#### 3. Update

With the GHCR setup the image is rebuilt automatically on every push to
`main`; with a self-hosted registry re-run `docker:build/tag/push` locally.
Then in TrueNAS: Apps → chess-analysis → Update (or `docker pull` +
recreate the app). The cert and the `data/` volume are untouched -
retrieved games and analyses survive updates.

> **Healthcheck:** `node:alpine` ships BusyBox `wget`, which cannot skip
> certificate verification, so the compose healthcheck uses the image's
> `bun` to `fetch()` the site trusting the self-signed cert as its own CA.
> That's why the cert needs the `DNS:localhost` SAN.


## Data & backup (SQLite)

All game data lives in a single SQLite file (WAL mode) managed by
`server/db.ts`, at `DATABASE_PATH` (default `./data/review.db`; the Docker
image sets `/app/data/review.db` on a mounted volume):

- `players` · `games` (provider uuid-keyed, **shared across players** -
  one row per played game) · `player_games` (whose history a game belongs
  to) · `fetches` (retrieval audit, incl. each run's window)
- `analyses` + `analysis_moves` + `analysis_lines` (one best combo per
  game, rank-guarded)

The schema is **history-agnostic**: the 30-day window is a query bound
(`?from=&to=` on the list/stats endpoints), not a storage limit - extended
retrieval (wider windows, backfills) only adds `fetches` records and
`player_games` links. Multiple players are first-class: every reviewed
username gets its own history/labels while sharing game facts and
analyses.

**Backup:** stop the container (or just `cp` - WAL checkpoints on close),
copy the `./data/` folder. Restore = put the files back. `review.db`,
`review.db-wal` and `review.db-shm` belong together.

