# AGENTS.md - chess-analysis

Guidance for AI agents (and humans) working on this codebase. Read this
before changing anything. Commands in `## Commands` are the fast path.

## What this is

Game-review webapp: track chess.com players on a multi-user grid (ratings,
last-played, monogram avatars); for any tracked player Stockfish 18 (WASM)
analyses their last-30-days games **entirely in the browser** (move
categories, accuracy, eval, top-3 lines, branching), plus a resumable stats
run. The server is deliberately thin: SQLite + game retrieval + static
serving - it never computes. `settings.username` is gone - the tracked
players live in the DB (`players` table), the Players grid is the home
screen and `retrieve(username)` is the entry point.

Stack: **Bun** (runtime, tests, scripts) · Vite + React 19 + TS (strict) +
Tailwind 4 · react-chessboard + chess.js · Stockfish WASM (nmrugg npm pkg,
build-time) · bun:sqlite (WAL) · GitHub Actions → GHCR (amd64+arm64).

## Repo map

- `src/api/` games fetch (server-side), SQLite client, openings, analysis cache shapes
- `src/engine/` UCI worker mgmt (`engine.ts`), analysis loop, classification (`classify.ts`), PGN/UCI parsing
- `src/state/review.ts` review tree reducer (nodes + `line` + `cursor`)
- `src/components/` UI · `src/stats/` runner + pure aggregation
- `src/i18n.tsx` ALL display strings (`STRINGS` as const, `{ it, en }`)
- `server/` Bun HTTP server (`index.ts`) + SQLite layer (`db.ts`)
- `docs/` architecture, deployment, security audit · `scripts/` fetch-*, debug/e2e (playwright-core)

## Commands

```sh
bun run dev          # vite (LAN host) :5173   - dev server, hot reload
bun server/index.ts  # data API :3000          - required alongside vite in dev
bun test             # 235 tests, no browser/WASM needed
npx tsc -b           # typecheck (part of `bun run build`)
```

Definition of done before any commit: `npx tsc -b` clean + `bun test` green.
For UI changes also smoke with playwright-core (headless Chrome for Testing,
path pattern in `scripts/e2e-db.ts`) - it caught real bugs (stats blank page,
stale vite graph after renames). `?demo` route = Opera Game, offline, ideal
test fixture.

## Standards

- **i18n**: never hardcode UI text; add keys to `STRINGS` in `src/i18n.tsx`
  (`{ it, en }`, Italian is the default language). Dynamic keys ONLY via
  `tabIdKey()` - a missing key throws inside `translate()` and blanks the
  whole page (learned the hard way: `tcLong`). `document.documentElement.lang`
  stays in sync (App.tsx).
- **Theming**: CSS variable tokens in `src/index.css`; `:root` = dark
  (default), `[data-theme="light"]` overrides; Tailwind maps them
  (`bg-card`, `text-ink`, `border-warn-border`...). Components use ONLY
  semantic utilities, never raw palette colors for themeable surfaces
  (`text-amber-200` was unreadable in light mode - use tokens).
- **Naming**: the app is **chess-analysis** everywhere. No chess.com
  branding in code/UI except the footer API credit (`footerApi` key). No
  em dashes (U+2014) in any app text - use `-`. Pieces are Lichess Staunty
  SVGs (`src/assets/pieces`, embedded raw via `pieces.tsx`).
- **Infra privacy**: never write LAN IPs / registry usernames into the tree.
  Placeholders only: `<host:port>`, `192.168.x.y`, `<your-LAN-IP>`,
  `<GITHUB_USER>`. The real values live in the private Gitea repo and env
  vars.
- **Code style**: strict TS; pure functions where testable (classification,
  filtering, aggregation) and unit-tested; React function components; no
  chart lib (hand-rolled SVG/div charts); minimal dependencies.
- **Commits**: Conventional Commits, terse, imperative subject, body only
  for the "why".

## Architecture decisions

- **All analysis client-side**; server never runs the engine. Server =
  `/api/db` data API + static. Multi-thread WASM needs COOP/COEP headers
  (sent by both servers) for `SharedArrayBuffer`; HTTPS on LAN IP needed for
  secure context when accessed by IP.
- **SQLite owns durable data** (`server/db.ts`, WAL): players, games
  (provider-uuid, shared across players), fetch audit, one **best analysis
  per game** with a server-side rank guard
  `lite+fast < full+fast < lite+deep < full+deep`. localStorage only holds
  settings (v2 key, v1 auto-migrated).
- **Never silently re-analyze**: opening a game cached with a weaker combo
  shows "Analyze with current setting"; stronger result replaces.
- **Same-day retrieval rule**: server refetches a player's games only when
  the stored fetch is not from today (or `refresh=1`).
- **Review state is a tree** (`src/state/review.ts`): `line` + `cursor`;
  branching appends nodes with `parent`; "Back to game" restores mainline at
  the same depth.
- **Classification**: expected-loss model `tanh(0.002·Δcp·rating_factor)`
  (see `classify.ts` docstring for thresholds + overrides brilliant/great/
  missed-win). **Accuracy**: `100 - 90·(1-e^(-Δ/105))`, rating-scaled,
  half-penalty for repeated blunders; calibrated against a reference review
  (~78/86.7 vs our 76.7/88.2). Do not "simplify" these formulas.
- **Openings**: build-time position-based prefix index from Lichess CC0
  dataset; game classified by walking forward while in-book; book moves =
  category `opening` (count 100 in accuracy). Missing index degrades
  silently.
- **Stats run is resumable**: each completed game persists immediately;
  entry point always offers core budget (all / half / single - single is
  slower but less heat/power, matters on phones).

## Security posture

- SQL: `?`-parameterized statements only (audited; interpolations are
  limited to static `WHERE` fragments + `IN (?,?,…)` marks). Keep it that
  way.
- JSON body cap 10 MB (413) on write endpoints; static serving has a path
  containment guard.
- Container runs as unprivileged `node` via `su-exec` after an entrypoint
  chown of `/app/data` (root-owned host volumes work). Do not add
  `USER node` to the Dockerfile - it breaks chown.
- API has no auth **by design** (single-user LAN app behind firewall +
  self-signed HTTPS; SAN must include `DNS:localhost`).

## Docker / CI decisions

- Images: `ghcr.io/m2max/chess-analysis`, built by
  `.github/workflows/docker.yml` on push to `main`. **Native per-arch
  runners** (`ubuntu-latest`, `ubuntu-24.04-arm`); manifest merged with
  `buildx imagetools` only after both platforms succeed.
- **No QEMU** (Bun binaries crash under emulation) and **no arm/v7** (Bun
  ships no 32-bit ARM). Don't retry either.
- compose: `image: ${REGISTRY:-ghcr.io/m2max}/chess-analysis:${TAG:-latest}`
  - REGISTRY is host+namespace only (a var that swallowed the repo name
  produced `<registry>:latest` bugs).

## Git remotes (asymmetric - be careful)

- `origin` = **Gitea (LAN)**: full history, real infra details. Push main
  normally.
- `github` = **M2Max/chess-analysis (public)**: clean history only. NEVER
  push local `main` (it contains LAN details in old commits). Flow:
  `git fetch github && git checkout -B gh-sync github/main && git cherry-pick <new-commit> && git push github gh-sync:main`.
  Branch protection: `build` check required; ruleset blocks deletion/force
  push. GHCR pull needs a packages-scoped PAT (OAuth tokens are refused).

## Gotchas

- Renaming a module → restart the vite dev server (stale module graph 404s).
- The Bun server does NOT hot-reload; restart it after touching `server/`.
- `translate()` throws on unknown keys - see i18n standard above.
- `useCallback` deps arrays evaluate immediately: declare consts above.
- `h-full` (height:100%) on a flex item in an auto-height flex row computes
  to 0 - use `self-stretch` (EvalBar was invisible for this reason).
- macOS lacks `timeout`; `gh api` file sha is `.sha` (top level).
- Tests stub `localStorage` and `global fetch` (see `tests/` patterns);
  engine tests use a fake UCI worker, never real WASM.
- Screenshots for README: `playwright-core` against `?demo` (no personal
  data in published images); `scripts/shots.mjs` regenerates all four.
- `DELETE /api/db/players/{u}` is destructive by design: cascades to games
  no other tracked player references (+ their analyses). Games are SHARED
  rows - test with two players and a common game before touching.
- Profile enrichment (`GET players?refresh=1`) has a 10-min TTL per player;
  forcing staleness in tests: `UPDATE players SET ratings_updated_at = 0`.
