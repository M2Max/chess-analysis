# chess-analysis ♞

[![docker build](https://github.com/M2Max/chess-analysis/actions/workflows/docker.yml/badge.svg)](https://github.com/M2Max/chess-analysis/actions/workflows/docker.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-059669)](./LICENSE)
[![runtime: Bun](https://img.shields.io/badge/runtime-Bun-b2bcaf)](https://bun.sh)
[![engine: Stockfish 18 WASM](https://img.shields.io/badge/engine-Stockfish%2018%20WASM-10b981)](https://stockfishchess.org)
[![platforms: linux amd64 / arm64](https://img.shields.io/badge/platforms-linux%20amd64%20%7C%20arm64-64748b)](./docs/DEPLOYMENT.md)

**Game review, entirely in your browser.** Enter a username, and Stockfish 18
(WASM) analyses every one of their last-30-days games on your device:
per-move classification (`!!` `!` `?` `??` and friends), eval bar, top-3
engine lines, accuracy, and branching - drag any legal move off the mainline
and it's evaluated immediately, with "Back to game" to return. No server
computation, no API keys.

| Games | Review |
|---|---|
| <img src="images/list-dark.png" width="480"> | <img src="images/review-dark.png" width="480"> |
| **Stats** | **Light mode** |
| <img src="images/stats-dark.png" width="480"> | <img src="images/review-light.png" width="480"> |

## Features

- 🧠 In-browser Stockfish 18 WASM analysis - Lite (~7 MB, instant) or Full
  (~113 MB, strongest) net, single- or multi-threaded (auto-detected)
- 🎯 Review-style move categories: `!!` brilliant · `!` great · `★` best ·
  `👍` excellent · `✓` good · `!?` inaccuracy · `?` mistake · `??` blunder ·
  `✕` missed win
- 📊 Per-player accuracy (expected-loss model, rating-scaled) and the
  engine's top-3 lines for every position
- 🔀 Branching: explore any off-mainline line, evaluated on the fly
- 📈 Stats view: resumable 30-day full-analysis run, win rates by time class
  and colour, per-opening breakdown, elo trajectory, accuracy histogram,
  blunders per game, results by hour
- 📖 Opening recognition (Lichess CC0 dataset, 3,810 openings) with book
  moves marked on the board and in the move list
- 🗄️ Server-side SQLite (bun:sqlite): games and analyses shared across all
  your devices; re-opening an analysed game is instant
- 🌗 Dark + light themes · 🌐 Italiano (default) / English · 📱 mobile layout
  with a swipeable move strip

## Quick start

```sh
bun install          # postinstall fetches the Stockfish builds + opening index
bun run dev          # frontend  -> http://localhost:5173
bun server/index.ts  # data API + SQLite -> http://localhost:3000
bun test             # 188 tests
```

`?demo` loads the Opera Game (Morphy 1858) fully offline.

## Deploy

Multi-arch images (`linux/amd64` + `linux/arm64`) are built automatically by
[GitHub Actions](./.github/workflows/docker.yml) on every push to `main` and
published to `ghcr.io/m2max/chess-analysis` (tags: `latest`, `sha-<commit>`,
version).

```sh
docker login ghcr.io   # token with packages: read
docker compose up -d   # or: REGISTRY=<host:port>/<user> for a LAN registry
```

Full guide (TrueNAS Scale custom app, self-signed HTTPS, insecure-registry
script, data backup): **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**

## Docs

| | |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Engine, classification, accuracy, openings, state, analysis store, settings, testing |
| [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) | Registries, TrueNAS Scale, certificates, SQLite backup |
| [docs/SECURITY-AUDIT.md](./docs/SECURITY-AUDIT.md) | Secret scan, hardening, residual risks |
| [docs/PRE-PUBLISH-CHECKLIST.md](./docs/PRE-PUBLISH-CHECKLIST.md) | Final publish report |

## License

App code: **MIT** ([LICENSE](./LICENSE)). Third-party components keep their
own licenses: the **Stockfish** engine (WASM, driven over UCI in a worker) is
**GPL-3.0**, the Staunty pieces and opening names (Lichess) are **CC0**,
chess.js is **BSD-2-Clause**, everything else MIT. Game history comes from
the public chess.com APIs (credited in the app footer).
