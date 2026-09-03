# Architecture & internals

How chess-analysis works, what the settings do, and how the test suite is
organised. For the user-facing quick start see the [README](../README.md).

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
un test` - pure-function suites (classification thresholds, PGN parsing,
UCI line parsing, API mapping/filtering with a mocked `fetch`, review
reducer, settings persistence, time-control labels, stats aggregation) plus
an `Engine` orchestration suite driven by a fake UCI worker and a
**server SQLite suite** (migrations, player/game history, the one-best
analysis-per-game rank guard, stats rows) against a throwaway database.
Browser smoke tests: `bun run scripts/debug-settings.ts` and
`scripts/debug-final-node.ts` (playwright-core against Chrome for Testing).

