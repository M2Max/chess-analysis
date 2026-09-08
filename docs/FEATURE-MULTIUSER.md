# Feature — Multi-user management (SHIPPED)

> Status: implemented and live. Decisions taken: monogram avatars only for v1
> (photo-retrieval appendix kept below for a future pass); grid refresh
> fetches everything (ratings + per-player archives, sequential); removal is
> a full delete including analyses (shared games survive). Avatar photo
> retrieval (route A/B pipeline) remains documented below, NOT built.


## Goal

Track and analyse **multiple chess.com players**. A new "Players" grid becomes
the default screen; the game list, review and stats always operate on the
player chosen there. The settings page stops owning the username.

## What exists today

- `players` table (`id`, `username UNIQUE COLLATE NOCASE`, `created_at`) with
  `ON DELETE CASCADE` from `player_games` and `fetches`. Games are shared
  rows referenced via `player_games`; `analyses` (+moves/lines) cascade from
  `games`. → deletion semantics are mostly a single `DELETE` + orphan sweep.
- `GET /api/db/players` already exists (bare list, no enrichment).
- Migrations scaffold in place (`schema_migrations`, only v1 applied).
- The server already imports the chess.com client (`fetchProfile`,
  `fetchLast30DaysGames`) to do retrieval server-side.
- App flow: `settings.username` (localStorage) drives retrieval, stats
  auto-fetch, and the list screen. `SettingsView` owns the username input.

## Verified facts (chess.com surface)

- `GET https://api.chess.com/pub/player/{u}` → `title`, ratings for
  chess/blitz/rapid/classical("pdd")/puzzles, `last_online`, `player_id`.
  404 → unknown player. **This powers card data.**
- The official API exposes **no avatar**. Best public source: the profile
  page's `og:image` → `https://www.chess.com/share/user/{username}`
  (verified: 200, `image/png`, 1200×630 social share card; contains the
  player's photo). Plan: server-side proxy + DB cache; CSS-crop the photo
  region for the avatar, **fallback = generated monogram avatar** (deterministic
  hue from username). A first implementation step is a visual spike to confirm
  crop geometry; if the crop looks bad we ship monograms and keep the proxy
  for a future pass.
- "Time since last game" = `MAX(games.utc)` from our DB — instant, but only
  as fresh as the last games fetch. Opening the Players page therefore does:
  render instantly from DB, then refresh each player in the background
  (ratings always; games through the existing same-day rule so we don't hammer
  the API — first load of the day per player = one archive fetch, staggered).

## Data model (migration v2)

```sql
ALTER TABLE players ADD COLUMN title TEXT;                  -- GM/NM/...
ALTER TABLE players ADD COLUMN avatar_url TEXT;             -- cached og:image
ALTER TABLE players ADD COLUMN rating_chess INTEGER;
ALTER TABLE players ADD COLUMN rating_blitz INTEGER;
ALTER TABLE players ADD COLUMN rating_rapid INTEGER;
ALTER TABLE players ADD COLUMN rating_classical INTEGER;
ALTER TABLE players ADD COLUMN rating_puzzles INTEGER;
ALTER TABLE players ADD COLUMN ratings_updated_at INTEGER;  -- unix ms, TTL ~10 min
```

`last_game_utc` is NOT stored — derived with `MAX(utc)` join per request.

## API changes (server)

| route | behaviour |
|---|---|
| `POST /api/db/players` `{username}` | validate against chess.com (404 → `422 player-not-found`), upsert, prime ratings/avatar, return player |
| `DELETE /api/db/players/{u}` | delete player (cascades memberships/fetches), then sweep orphans: games with no remaining `player_games` rows; their analyses cascade automatically |
| `GET /api/db/players?refresh=1` | list + enrich: cached ratings if fresh (<10 min), else refetch from chess.com; always include `last_game_utc` (MAX from DB) and `games` count |
| `GET /api/db/players/{u}/avatar` | proxy `https://www.chess.com/share/user/{u}` (cache URL in DB; on upstream failure return 404 → client shows monogram) |

All existing per-player routes stay as-is (they key off the username).

## UI changes

### New `PlayersView` (default screen)
- Grid of cards (responsive 1/2/3 cols), sorted: most recent activity first.
- Card: avatar (photo or monogram), nickname (+title badge), rating row
  (⚡ blitz · 🚡 rapid · 🐘 classical, greyed if unrated; puzzles optional),
  "last seen" relative time (`2 h fa` / `3 giorni fa` — i18n), games count.
- Live dot while that player's background refresh runs; stale data shown
  meanwhile (cards render immediately from DB).
- **"Add player"** tile → modal: username input, Enter submits,
  `UnknownPlayerError` → inline "player not found" (reuses existing i18n),
  duplicate → info. On success card appears, no full reload.
- Card **⋯ menu** → "Rimuovi": confirmation modal naming the player and
  stating exactly what gets deleted (games + analyses for that user; shared
  games survive if another tracked player also has them). Destructive confirm
  button. On confirm → DELETE → card removed.
- Click card → existing `retrieve(username)` → list screen (unchanged list UI).

### Screen/state rework (`App.tsx`)
- `Screen = "users" | "list" | "review" | "stats"`, default `"users"`
  (demo param still jumps to review).
- `activeUser` state replaces `settings.username` as the driver of list /
  review / stats. Back from list → users; back from stats → users.
- Migration shim: on first load, if `settings.username` is set and the API has
  no such player yet → `POST /api/db/players` once (existing single-user
  installs keep working with zero clicks).

### `SettingsView`
- Remove username form + "Recupera partite" button (engine, theme, language
  stay). `username` dropped from `Settings` type; `loadSettings` ignores a
  stale stored value.

### i18n
~15 new it/en keys (playersTitle, addPlayer, addPlayerHint, removePlayer,
removeConfirmBody {name, games, analyses}, playerNotFound, lastSeen {rel},
noPlayersYet, unrated, retry, ...). No hard-coded strings (AGENTS.md rule).

## Testing

- `tests/server-db.test.ts` (or equivalent): v2 migration idempotent;
  POST validation (unknown → 422); DELETE cascade — own games disappear,
  games **shared** with another tracked player survive with their analyses;
  `last_game_utc` correctness.
- `tests/server-api.test.ts`: new routes incl. avatar proxy failure path.
- `tests/players.test.ts`: card sorting + relative-time formatting; settings
  migration shim (username seeded exactly once).
- Existing 214 tests must stay green; `tsc -b` clean.
- Live smoke (Playwright): add → card → open list → remove → gone from DB;
  screenshots of the new grid (then README screenshots refresh for it).

## Decisions to confirm before coding

1. **Avatar**: ship share-card-crop (hacky but real photo) with monogram
   fallback — or pure monogram for now, photo later?
2. **Background refresh cost**: first page load of the day fetches the 30-day
   archive for every tracked player (staggered, ~1 req each). OK, or
   ratings-only on the grid and games refreshed lazily when opening the list?
3. **Removal depth**: full delete (games + analyses) as specced — note
   re-analysing later costs engine time again. Confirm.

## Rough build order

1. db v2 migration + `listPlayersEnriched` + delete/orphan sweep (+ tests)
2. server routes POST/DELETE/refresh/avatar proxy (+ tests)
3. `PlayersView` + modals + App screen rework + settings migration shim
4. SettingsView cleanup, `Settings` type change
5. i18n it/en
6. live smoke + new README screenshot for the grid
