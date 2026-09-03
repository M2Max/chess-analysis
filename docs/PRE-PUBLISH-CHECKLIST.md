# Pre-Publish Checklist - Final Report

Date: 2026-09-03 · Repo: `chesscom-review` (app: **chess-analysis**)
GitHub: `M2Max/chess-analysis` (private until you flip it public) ·
Gitea: LAN remote `origin` (full history, stays private)

## Status per checklist item

### 1. Audit and remove unused dependencies — DONE
All 14 declared dependencies verified in use (grep over src/server/scripts/
tests). `stockfish` looks unused at runtime but is a **build-time** dep:
`scripts/fetch-engine.ts` copies the WASM builds from
`node_modules/stockfish/bin` into `public/`. `bun audit`: **0
vulnerabilities**. Nothing removed.

### 2. .env.example, README.md, LICENSE, .gitignore — DONE
- `.env.example` (new): every env var documented, all optional
  (`PORT`, `HTTPS`, `SSL_KEY`, `SSL_CERT`, `DATABASE_PATH`,
  `VITE_API_BASE`, `REVIEW_SERVER_NO_LISTEN`, compose `REGISTRY`/`TAG`)
- `README.md`: exists; added a **License** section (see below)
- `LICENSE` (new): **MIT**
- `.gitignore`: exists, covers `.env`, `*.local`, `data/`, `node_modules/`,
  `dist/`, engine/openings build artifacts

### 3. All paths relative or configurable — DONE
- `DATABASE_PATH`: env or repo-relative `data/review.db` (Docker default
  `/app/data/review.db` on the mounted volume)
- `SSL_KEY`/`SSL_CERT`: env, documented container defaults
- `DIST`: derived from `import.meta.dir` (never absolute)
- `VITE_API_BASE`: optional client override
- No LAN IPs or user-specific paths in code (audited; `192.168.1.5` /
  `maxito` occurrences in the published tree: **0**)

### 4. Non-root Dockerfile user + healthchecks — DONE (verified)
- Entrypoint chowns `/app/data` when started as root, then drops to the
  unprivileged `node` user via `su-exec` (package added to image)
- Verified in a running container: `ps aux` shows `node bun server/index.ts`,
  DB files created on a root-owned host mount
- Healthcheck in `docker-compose.yml` (bun fetch trusting the self-signed
  cert as its own CA); observed **healthy** in the clean deploy test

### 5. Tests — DONE
188/188 passing (unit: classification, PGN, UCI lines, API mapping/filtering
with mocked fetch, review reducer, settings persistence, i18n, time labels,
stats aggregation; integration: server HTTP layer with stubbed upstream,
SQLite suite against a throwaway DB; browser e2e scripts available).
`tsc -b` clean.

### 6. Dependabot + branch protection — PARTIAL
- **Dependabot**: `.github/dependabot.yml` added (npm ecosystem / `bun.lock`,
  weekly, `dependencies` label). First PRs appear next Monday.
- **Branch protection**: **blocked on the Free plan while the repo is
  private** (both classic protection and rulesets returned 403 "Upgrade to
  Pro or make this repository public"). Once you make the repo public:
  Settings → Branches → Add rule on `main`:
  - Require status check to pass before merging: `build` (the docker job)
  - Do not allow force pushes / deletions
  (Optionally "Require pull request reviews" - meaningless for a solo repo.)
  Or I can create the ruleset via API after you flip public.

### 7. Full build/deploy in a clean environment — DONE (bug found & fixed)
- `docker build --no-cache` (linux/amd64): image verified (230 MB dist,
  both Stockfish builds, openings.json, bun + su-exec)
- Fresh compose deploy from the repo's actual `docker-compose.yml`:
  fresh `data/` dir, generated self-signed cert (SAN localhost),
  `REGISTRY=docker.io` override → container **healthy**, HTTPS 200,
  API responding, process as `node`, SQLite created on the volume
- **Bug caught and fixed:** `image: ${REGISTRY:-ghcr.io/m2max/chess-analysis}`
  produced `<registry>:latest` (repo name lost) on any REGISTRY override.
  Now `image: ${REGISTRY:-ghcr.io/m2max}/chess-analysis:${TAG:-latest}` -
  REGISTRY = host+namespace only (matches README/.env.example docs).

### 8. Final report — this file
Plus the earlier `SECURITY-AUDIT.md` (secret scan, hardening, audit).

## License: MIT (applied)

**Recommendation: MIT** - applied in `LICENSE`, copyright holder `M2Max`
(edit to your legal name if you prefer). Rationale:

- Your code is a client-side web app; permissive licensing maximizes reuse
  and is the JS-ecosystem default.
- **The one nuance: the Stockfish engine is GPL-3.0** (npm package license
  verified). It is safe to keep MIT because the engine ships as a *separate
  program* - a standalone WASM binary in `public/`, driven over the UCI
  protocol inside a Web Worker, re-fetched from npm at build time. Separate
  programs communicating at arm's length don't create a combined/derivative
  work under the standard GPL reading. The README's License section
  documents this + all third-party licenses (CC0 pieces/openings, BSD-2
  chess.js, MIT toolchain).
- If you ever want **zero** ambiguity (or want copyleft for your code),
  swap `LICENSE` to **GPL-3.0** - one file change; nothing else in the repo
  conflicts. **AGPL** only makes sense if you plan to offer this as a hosted
  service - it doesn't for a client-side app.

## Manual steps left for you (publish day)

1. `gh auth` as M2Max → repo Settings → **Danger Zone → Change visibility
   → Public** (or make it public and keep the Gitea copy private - they are
   independent).
2. After public: enable the branch protection rule (item 6 steps) - or ask
   me and I'll create it via API.
3. TrueNAS pull needs a **fine-grained PAT** (repo `chess-analysis`,
   Packages: Read-only) for `docker login ghcr.io` - OAuth tokens can't pull
   from GHCR.
4. Optional: rename copyright holder in `LICENSE` to your real name.
5. Optional: first version tag `v1.0.0` - Actions will publish
   `ghcr.io/m2max/chess-analysis:v1.0.0` alongside `latest`.

## Known residuals (accepted, documented)

- Data API has no auth (single-user LAN app; keep firewalled + HTTPS)
- No rate limiting (LAN exposure only)
- Vite dev server binds to the LAN (dev workflow, never in the image)
- 32-bit Raspberry Pi (RPi 3/Zero) not supported - Bun has no arm/v7 builds
- Dependabot PRs will need the `build` check green; with no branch
  protection yet, merges are unrestricted until step 2 above
