# chess-analysis

Game review, fully in your browser. Enter a username, pick one of their
last-30-days games, and get a Stockfish analysis
of every move - best / great / good / inaccuracy / mistake / blunder (with
`!`, `!?`, `?`, `??` symbols) - with an eval bar, move list, and branching:
drag any legal move to explore an off-mainline line, evaluated immediately,
with "Back to game" to return to the played game.

**Stack:** Bun (server/scripts/tests) · Vite + React 19 + TS + Tailwind 4 ·
react-chessboard · chess.js · Stockfish 18 WASM (nmrugg) · public chess API (credited in the footer).

## Run

```sh
bun install          # postinstall fetches the Stockfish builds and builds the opening index into public/
bun run dev          # dev server → http://localhost:5173 (terminal 1)
bun server/index.ts  # data API + SQLite DB → http://localhost:3000 (terminal 2, required in dev)
bun run build
bun start            # prod server → http://localhost:3000 (serves dist/ + the data API)
bun test             # 188 unit tests (no WASM worker needed)
```

`?demo` deep-link loads the built-in Opera Game (Morphy 1858) without
contacting the network.

## Settings (gear icon, top right)

Stored in the browser's `localStorage` (`chess-analysis.settings.v2`; the
old v1 key is migrated on first load):

- **Username** - prefilled on the next visit; case is preserved
  (usernames are case sensitive).
- **Engine** - which Stockfish build analyses your games:
  | build | wasm | notes |
  |---|---|---|
  | Lite (default) | ~7 MB | small NNUE net, instant startup |
  | Full | ~113 MB | full NNUE net, strongest; downloaded once |

  Applies to new analyses (the running game keeps its engine).
- **Threads** - Auto (all cores, capped at 8), 1, 2, 4 or 8.
- **Analysis** - per-position time budget, with an estimated playing
  strength that follows the selected engine (Stockfish 18 WASM, MultiPV 3):

  | mode | time/position (multi/single) | lite | full |
  |---|---|---|---|
  | Fast (default) | 200 / 450 ms | ~3200 Elo | ~3300 Elo |
  | Deep | 600 / 1350 ms (3×) | ~3350 Elo | ~3450 Elo |

  Estimates assume the ~70-Elo-per-doubling time-scaling rule, Stockfish's
  own measurement that MultiPV 3 costs ≈ 150 Elo of best-move quality, and
  the full NNUE net playing ≈ +100 over the reduced "lite" net at equal
  time. The settings labels update with the engine selection.
  Applies to new analyses.

Two preferences are toggled on the review page itself (persisted to the
same settings object): **flip board** (⇅ - games open with the side the
reviewed player played below) and **best-move arrow** (➤ - show/hide the
engine's suggested move on the board).

Top-bar buttons (right-aligned): **theme** (dark, default / light) and
**language** (Italiano, default / English - the top bar also carries the
statistics and settings buttons).

**Game-list retrieval:** the server performs the retrieval and
keeps each player's games in its SQLite database (`server/db.ts`). The
same-day rule applies server-side: a fresh retrieval happens only when the
player's latest stored fetch is not from today (or "↻ Refresh" forces one).
The settings screen's "← Games" button returns to the in-memory list
instantly; the list header shows when it was fetched.

### Multi-threading

Both single- and multi-threaded builds ship per engine choice
(`public/stockfish-{lite,full}/`). Multi-threaded Stockfish WASM needs
`SharedArrayBuffer`, which browsers only allow in cross-origin-isolated
documents - the dev server (Vite) and prod server (Bun) both send
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
require-corp`. When `crossOriginIsolated` is true the app uses the multi
build with the chosen threads; otherwise it silently falls back to the
single-threaded build.

Multi uses shorter per-position time budgets (200 ms vs 450 ms in Fast mode;
see **Analysis** above) - the same wall time spent on N cores - so reviews
are ~2.3× faster at equal or better quality (measured: 178-position game in
34 s multi vs 78 s single).

Note: the npm package does not ship the pthread worker file the multi builds
spawn (`new Worker("stockfish.worker.js")`); the builds are self-contained
loaders, so `scripts/fetch-engine.ts` copies the multi loader as
`stockfish.worker.js`.

## How it works

1. **API** (`src/api/games.ts`, run **server-side** by `server/index.ts`
   under `/api/db/`) - `GET /pub/player/{username}/games/{YYYY}/{MM}` for
   the current + previous month (only months the API exposes), filter to
   30 days, dedupe, sort by `end_time`. Retries the transient
   "Data provider not found" outage. The games array is NOT chronological -
   sorting is on us. Result comes from the PGN tags (no top-level field).
   **The index can lag by hours** - very recent games may not appear yet;
   the list UI shows a hint when the newest game looks old. The client calls
   `GET /api/db/players/{u}/games?from=…`, which serves today's retrieval
   from the database and only hits the public API when stale.

   The list itself (`src/components/GameList.tsx`) filters client-side:
   time-class tabs (All / Bullet / Blitz / Rapid / Long - Long = classical +
   correspondence), a sort toggle (newest-first ⇄ oldest-first), and a
   time-range picker clamped to the oldest/newest retrieved game (both days
   inclusive, one-click reset). All three are shared state and apply to
   every tab; `timeClassOf`/`filterGames` are pure and unit-tested.
2. **Engine** (`src/engine/`) - one Stockfish WASM worker per (build, threads)
   choice, plain UCI over `postMessage` (`setoption name Threads` at init).
   `Engine` serialises analyses FIFO and exposes live `info` lines.
   `resolveEngine()` picks multi vs single from `crossOriginIsolated`.
3. **Analysis** (`src/engine/analysis.ts`) - evaluates all N+1 positions
   sequentially with UCI `MultiPV 3`. Each move is classified by the
   expected-points-lost model in `classify.ts`:
   `loss = tanh(0.002 · Δcp · clamp(rating/2200, 0.4, 1.5))` → core
   category (best ≤0 · excellent ≤0.02 · good ≤0.05 · inaccuracy ≤0.10 ·
   mistake ≤0.20 · blunder >0.20), plus overrides - **brilliant** (a
   hard-to-refute near-best sacrifice), **great** (best move with the
   2nd-best >80cp worse) and **missed win** (opponent blundered, you didn't
   capitalize). The played move's own eval comes from the parent's MultiPV
   lines (no extra searches). Terminal positions (mate/stalemate) get a
   synthesized result so the final move is classified too.
4. **State** (`src/state/review.ts`) - a tree of analysed nodes; `line` +
   `cursor` point at the displayed position. Branches append nodes with a
   `parent`; "Back to game" restores the mainline at the same depth.
5. **Accuracy** - per-move "distance from the engine": each move scores
   `acc(Δ) = 100 − 90·(1 − e^(−Δ/105))` where Δ is the centipawn gap to the
   engine's best move (floor 10), mildly scaled by the mover's rating
   (lower-rated players are penalised a bit more for the same swing); the
   game accuracy is the average, and each extra blunder in the game counts
   at half the penalty of the previous one (the reference implementation's
   "multiple blunders" smoothing). The curve was calibrated against a real
   ~1200-level game (Mamox43 1190 vs YSLdot 1186: reference 78.1/86.7,
   app 76.7/88.2). Earlier models (raw `100 − loss`, category bands) both
   ran ~10 points above the reference on the same game.
6. **UI** (`src/components/`) - dark layout by default (a coherent light
   mode is one toggle away): board + eval bar
   left, **best lines** (top-3 evals + 4 moves each) + players/accuracies +
   move list right (on mobile the best-lines card moves below the players
   card). Symbols: ★ best · 👍 excellent (mono SVG - the emoji has no
   monochrome text presentation) · ✓ good (light green) · `!?` `?` `??` ·
   !! brilliant (deep blue) · ! great (sky blue) · ✕ missed win (red) ·
   open book (mono SVG, brown) for opening-book moves.
   The classification badge on the
   board shows the current move's symbol in the corner of the moved piece.
   History-nav buttons are desktop-only - on mobile you swipe the move
   strip.
7. **Opening recognition** (`src/api/openings.ts` +
   `scripts/fetch-openings.ts`) - the [Lichess opening names
   dataset](https://github.com/lichess-org/chess-openings) (CC0, 3,810
   entries) is turned at build time into a position → opening index
   (`public/openings.json`, ~900 KB): every prefix position of every line,
   keyed by `<placement> <sideToMove>`, shortest line per position. A game
   is classified by walking its positions forward from move 1 while they are
   in the book (the full-game form of the dataset's "play moves backwards
   until a named position is found"; transpositions work because the index
   is position-based). The last in-book position names the opening (shown in
   the review header and on the game-list row), and every move up to it gets
   the **opening** category - a monochrome book SVG in a shade of brown -
   counted as perfect (100) in the accuracy. If the index file is missing
   (offline build) the feature degrades silently.
8. **Analysis store** (`src/api/analysisCache.ts` → `PUT
   /api/db/games/{id}/analysis` → `server/db.ts`) - after a finished
   analysis the mainline results (per-move category/Δcp/loss, scores, best
   moves, top-3 MultiPV lines, both players's accuracy, engine + mode and
   the recognised opening) are stored in the server's SQLite database - one
   row set per game, **shared by every browser and player** (the analysis
   belongs to the game, not to a browser). The game list shows
   `Opening (ECO) · analyzed · W x% / B y% · engine·mode` on cached rows
   (the list endpoint decorates each game with its best-analysis meta). On
   re-open a cached game **hydrates instantly (no engine)**; the engine is
   only re-run for the current settings when you ask for it - opening a
   game cached with a weaker combo shows an
   **“Analyze with current setting”** button (no silent re-analysis), and
   the stronger result replaces the entry when it finishes. Quality ranking
   (only the best analysis of a game is kept - the rank guard is
   server-side):
   `lite+fast < full+fast < lite+deep < full+deep`.
9. **Statistics** (`src/stats/`, `src/components/StatsView.tsx`) - the chart
   button in the header opens the stats view: one button runs **every game
   of the last 30 days** through the standard pipeline with a fixed combo
   (lite engine · fast mode · all cores up to the engine cap). Every
   finished game is persisted to the server's analysis store **as it
   completes** (item 8, labelled `lite·fast`), so a run is resumable -
   closing the tab only loses the game in progress - and the list rows
   light up as the run progresses and re-opening those games is instant; a
   stronger combo you pick later upgrades them via the “Analyze with
   current setting” button. On entry the view loads the player's stored
   analyses (`GET /api/db/players/{u}/stats`); games that already carry an
   analysis are skipped. Stats are computed on the **intersection of the
   stored analyses and the current list**: games that fell out of the
   30-day window leave the calculus, and new games make the "Update
   analysis (N/M)" button reappear. Sections:
   results (overall / playing white / playing black + accuracies, tabbed by
   time class), per-opening breakdown, elo trajectory per time class, W/D/L
   by time class, per-move accuracy histogram, weak moves & blunders per
   game, win rate by opponent strength gap, results by hour of day.
   Aggregation is pure and unit-tested (`statsData.ts`); charts are
   hand-rolled SVG/divs (no library).

## Testing

`bun test` - pure-function suites (classification thresholds, PGN parsing,
UCI line parsing, API mapping/filtering with a mocked `fetch`, review
reducer, settings persistence, time-control labels, stats aggregation) plus
an `Engine` orchestration suite driven by a fake UCI worker and a
**server SQLite suite** (migrations, player/game history, the one-best
analysis-per-game rank guard, stats rows) against a throwaway database.
Browser smoke tests: `bun run scripts/debug-settings.ts` and
`scripts/debug-final-node.ts` (playwright-core against Chrome for Testing).

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

## Deployment (Docker → container registry → TrueNAS Scale)

### Image sources

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
