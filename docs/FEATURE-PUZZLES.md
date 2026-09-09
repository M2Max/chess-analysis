# Puzzles — SHIPPED

Generate **tactics puzzles from the player's own analysed games** and let them
solve them in a dedicated view. No external puzzle bank: every puzzle is a
moment the player actually had (or missed) at the board, which makes training
directly transferable — and free, since the analysis cache already contains
everything the selection pass needs.

Status: **SHIPPED** (`src/puzzles/*`, `PuzzleView.tsx`, server v3 + routes).
Generation is client-driven: extraction is a pure pass over the analysis
cache; validation runs one deeper WASM search per candidate. Deviation from
the first draft: the solution is always `prev.multi[0].uci` (the per-move
`bestUci` belongs to the NEXT position and can be incoherent - never use it).

---

## 1. How the well-known sites do it

**Chess.com**
- Main puzzle bank: curated positions from real games (all levels), rated by
  aggregate solver performance, organised by theme. The *Game Review* adds the
  personal angle: mistakes found during review are replayed as "puzzles from
  your games" — "you had this, find it".
- Takeaway: the personal-puzzle loop is *review moment → replay it as a
  position with you to move → find the move you missed*.

**Lichess** (open-source generators: `linrock/chess-puzzle-maker`,
`ornicar/lichess-puzzler`, current `lichess-org/puzzle-factory`)
- Pipeline (the reference model):
  1. **Scan games for big evaluation swings** (candidate positions).
  2. Keep only positions with **one clear best move** (the solution). If the
     engine's #2 move is nearly as good, the puzzle is ambiguous → drop
     ("cooked" puzzles are discarded).
  3. Verify the advantage **survives the opponent's best defence** (forced
     sequence, usually a few plies — checkers / captures must resolve).
  4. Classify by **theme** (mateInN, winMaterial, fork, pin, skewer,
     discovered attack, attraction, promotion, sacrifice…) and by class
     (mate-in-1..4, advantage-in-N).
  5. **Rate** the puzzle (engine depth/complexity first, then actual solver
     results feed a real rating).
  6. Human/queue validation before publishing.
- Excludes: trivial recaptures, "only legal move", positions already lost /
  already winning-everything, quiet positional moves.
- Takeaway: **uniqueness + forced-line soundness are what separate real
  puzzles from noise**. That validation step is the expensive part and it's
  what we must budget engine time for.

**Others** (Chessable, Spraggett/AT-DC "spicy" tools, various "puzzles from
my games" OSS): same recipe — eval-swing scan → engine verification →
personal queue. None do server-side magic we need; the algorithm is portable.

---

## 2. Our big architectural advantage

The app already stores, **per analysed game** (server SQLite,
`analysisCache.ts` v2), for every mainline ply:

- the move played (`san`, `uci`, `color`)
- `score` after the move, `delta` (cp lost vs best), `loss` (0..1),
  `category` (blunder/mistake/inaccuracy/book/great/brilliant/best…)
- `bestUci` / `bestSan` — **the move that was missed**
- `multi` — top-3 MultiPV lines (uci + score + pv) of the position *after*
  the move ⇒ the multi of move *i−1* is the full candidate set of the
  position *before* move *i*.

⇒ **Candidate selection costs zero engine time** — it's a pure pass over
cached data. The engine (WASM, client-side, already in the app) is used only
to *validate* the handful of candidates per game (≈5–15), ~1 s each.
Server never runs an engine; architecture (client WASM + dumb server + SQLite)
stays exactly as is.

Existing pieces we reuse directly:

| piece | use |
|---|---|
| `comboRank` / cache rank | puzzles only from analyses ≥ a rank (fast-mode pvs are too shallow to trust for uniqueness — see §4) |
| `classify` categories | prefilter candidates (blunder / missed-win already computed) |
| `motifs.ts` (`classifyMotif`) | theme tags (fork, pin, hanging, missedCapture, mateMissed…) |
| `winprob.ts` | difficulty weighting |
| WASM engine + `ANALYSIS_MODES` | validation searches |
| review deep-link `onOpenGame(game, ply)` | "Vedi nella partita" jump |
| i18n / theming / mobile patterns | everything speaks it |

---

## 3. Selection — picking the precise moment

For each **analysed** game of the player, for each ply *i* where **the player
to move** (color == player's color in this game):

Let `prev = cached[i-1]` (its `multi` describes the position **before** the
player's move), `mv = cached[i]` (the move actually played).

**Candidate iff (missed-win / blunder type):**

```
best = prev.multi[0]                      # the move the engine wanted
played = prev.multi.find(l => l.uci == mv.uci) ?? unknown
swing = best.score − played.score         # player's-view cp gain left on table

candidate if:
  best is mate  (mate-in-1..N missed)            → class "mateInN"
  or swing ≥ MATE_EQUIV (~600cp)                → big win missed
  or (swing ≥ 250 and mv.category == blunder)   → classic blunder moment
  and played score is NOT already winning-by-more (don't puzzle noise in
  positions that stay won)
  and played score is NOT already lost (−900 or worse before the move:
  "saving a lost position" is not a puzzle, it's grief)
```

Plus (toggle, **default on**): positions right after the *opponent's* blunder
where the player missed the winning reply — same construction, ply parity
flipped (the punishment position is still "player to move, one clear best
move"). This is what Lichess does most and it's the best training value.

**Exclusions (from the research + our data):**

- opening book (`category == "book"` or ply < first non-book)
- `bestUci == mv.uci` (they played it — optional replay mode off by default)
- fewer than 4 legal moves (trivial), or best move is the only "sensible"
  recapture (validated in §4 anyway)
- mate-in-1 that is a forced recapture-mate spam: dedup handles repeats
- positions where `prev.multi` is missing/short (truncated cache at rank
  lite/fast → require full analyses for generation, see §4 note)

The moment stored is always **the position before the player's move**, side
to move = the player. Puzzle presented from the player's POV (board
orientation = their colour).

---

## 4. Validation — the quality gate (engine, ~1s/candidate)

Run the WASM Stockfish on the candidate position (full engine only;
depth-targeted, `movetimeMs ≈ 1200` deep-mode budget, MultiPV ≥ 3):

1. **Soundness**: best line score ≥ threshold (win ≥ +180cp or mate) *after*
   the engine sees the opponent's best defence — that's what the deep score
   already is (value under optimal play). Mate puzzles: mate ≤ 5.
2. **Uniqueness**: `multi[1].score ≤ multi[0].score − 80cp` (or mate vs non-
   mate). If several moves win equally, the puzzle is cooked → drop.
   (User gets ONE solution; ambiguity = frustration.)
3. **Forced-line sanity**: replay `multi[0].pv` up to its static end; final
   eval must still meet the threshold (captures resolved, not a hallucinated
   sac with no follow-up at cached depth).
4. **Triviality filter**: reject if the solution is an automatic recapture of
   equal material with no other point (check via before/after material +
   "was the piece already attacked").

Only validated puzzles persist with `status = "ready"`; candidates persist
immediately as `pending`/`rejected` so a generation pass is **resumable and
never re-does work**.

**Rank note**: uniqueness needs ≥3 meaningful MultiPV lines at decent depth.
`lite` (10 MB) engine or `fast` mode lines are trustworthy for *selection*
(the delta/category already in the cache), but validation always uses the
full engine at the current mode's deep budget — bounded cost, ~5–15 positions
per game.

---

## 5. Difficulty & rating

v1 — **three tiers + estimated rating**, deterministic:

```
base = player blitz/rapid rating (from players table, live)
hardness = depth_needed_to_convert (validation depth where score crossed
           threshold)   # deeper forced lines → harder
         + mate bonus (mateLen − 1) × 25
         + quiet-move bonus +60 (solution is not a capture/check → harder to
           see)
         + sacrifice flag +80 (solution gives material)
est_rating = clamp(600, 2800, base + (hardness − 2) × 120)
tier = facile / medio / difficile by est_rating bands
```

v2 — **personal puzzle Elo**: every solve/fail updates a per-puzzle
performance rating (simple Elo, K=32) — mirrors how chess.com/lichess rate
puzzles from solvers; self-calibrating over time. Out of scope for v1.

Themes come from `classifyMotif` + mate length (`Matto in 2`, `Forca di
cavallo`, `Inchiodatura`, `Pezzo sospeso`…), shown as badges.

---

## 6. Persistence (migration v3) + API

```sql
CREATE TABLE puzzles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,            -- the player the puzzle is FROM
  game_id TEXT NOT NULL,             -- source game (FK games)
  ply INTEGER NOT NULL,              -- 0-based ply of the solution move
  fen TEXT NOT NULL,                 -- position BEFORE the solution move
  side TEXT NOT NULL CHECK (side IN ('w','b')),
  solution_uci TEXT NOT NULL,
  solution_san TEXT,
  mate_len INTEGER,                  -- null = material puzzle
  theme TEXT,                        -- 'fork' | 'pin' | 'mate' | ...
  tier TEXT,                         -- 'easy' | 'mid' | 'hard'
  rating_est INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|ready|rejected|seen|solved
  fail_reason TEXT,                  -- 'cooked' | 'trivial' | 'unsound' | ...
  attempts INTEGER DEFAULT 0,        -- unlimited retries; 0 until solved/seen
  solved_at INTEGER,                 -- null until solved (seen stays null)
  created_at INTEGER NOT NULL,
  UNIQUE(username, fen)              -- cross-game dedup, position identity
);
```

Server (dumb CRUD, no engine — engine work stays client-side):

- `GET  /api/db/puzzles?username=&status=&limit=` queue
- `POST /api/db/puzzles/batch` upsert (generation client writes candidates +
  validation results in bulk)
- `POST /api/db/puzzles/{id}/attempt` `{ solved: boolean, revealed?: boolean }`
  → bookkeeping: every wrong try bumps `attempts` (infinite retries); the
  hint-reveal path marks `seen` (not solved); a later correct move on a
  `seen` puzzle still marks it `solved`
- `DELETE /api/db/puzzles?username=` (regenerate-clean / player removal
  cascade — deleting a player wipes their puzzles)

---

## 7. Generation flow (client-driven, resumable)

"Puzzle" view, empty state → **"Genera"** button:

```
for each game of player with cached analysis (newest first, cap 30/pass):
  candidates = extract(cachedAnalysis)            # pure fn, instant
  POST /puzzles/batch (status=pending)             # persisted immediately
for each pending candidate (sequential, cancellable):
  validate(engine, fen)                            # ~1.2s each
  POST result (ready | rejected:reason)
first validated puzzle is shown AS SOON AS it passes; queue continues
validating in the background (progress pill: "Preparo i puzzle 12/38",
reuse the analyzingProgress pattern + cancel button)
```

No analysed games → CTA to analyse (link to game list). All games already
processed → "Nessun nuovo puzzle — genera di nuovo o allarga l'intervallo".

Settings (inside the view, persisted): difficulty band filter, include
punish-opponent's-blunders (on), include replay-of-great-moves (off), max
puzzles per generation (default 40).

---

## 8. Solve UI

- New screen `puzzles` in the nav (after Statistiche; browser-history block
  picks it up for free — same mechanism as other screens).
- Board (Staunton set, orientation = player's colour) + queue header
  (`Puzzle 7 di 23`), tier/theme badges (badges only *after* solving;
  pre-solve show difficulty tier only — theme spoils the idea e.g. "Forca
  di cavallo").
- **No eval bar** (spoiler). Eval chart hidden. Move strip replaced by
  attempt feedback.
- Drag a move (reuse board drag handler), **infinite retries**:
  - correct → green flash, line from the engine solution auto-plays (opponent
    forced replies from `pv`, animated) so the user sees *why*; +1 streak.
  - wrong → move retracts (single strict solution — uniqueness was
    validated), "Riprova" feedback; unlimited attempts, nothing is lost
    (streak resets only on reveal, see hint).
- **Hint button (light bulb, monochrome inline SVG like the other icons)** —
  three-state progression:
  1. idle 💡 → tap: the **origin square of the solution piece is
     highlighted** (soft amber cell ring, same highlight vocabulary as
     `BoardSymbol`) **and a 30 s countdown starts** on the button
     (`💡 30…29…`). Taps during the countdown do nothing.
  2. after 30 s the button turns into **"Mostra soluzione"** → tap: reveals
     the solution SAN (and marks the puzzle as *seen*, not *solved* — it
     counts as failed for streak purposes but stays retryable: the user can
     still keep trying to find it themselves before moving).
  - Hint state is per puzzle, resets on next/prev; revealed/solved locks it.
- After solve: solution SAN, theme badge, est. rating, and **"Vedi nella
  partita"** → deep-link review at that ply (existing `onOpenGame(game, ply)`
  from the stats autopsy flow), plus **Puzzle successivo**.
- Header strip: `12 risolti · 3 in fila` streak counters.
- Fully mobile-first (the board + one action row; desktop adds the info
  card). All strings via `translate()` (it throws otherwise, by design).

## 9. Tests

- `puzzleExtract.test.ts` — pure extractor: blunder → candidate, mate-miss →
  mateInN, book/noise/lost-position exclusions, parity for punish-mode,
  missing-prev-multi handling.
- `puzzleValidate.test.ts` — stub engine (same pattern as stats tests):
  sound/unsound/cooked/trivial verdicts; forced-line sanity.
- `server-db.test.ts` — v3 migration, batch upsert idempotency, UNIQUE(username,
  fen) dedup, attempt bookkeeping, player-delete cascade.
- `server-api.test.ts` — routes incl. 404/400 paths.
- Live Playwright smoke: generate on a real profile → solve → jump-to-game.

## 10. Milestones

1. **DB v3 + server CRUD + client api layer** (no engine) — half day
2. **Extractor** (pure, from cached analysis) + tests — half day
3. **Validator** (WASM, stub tests) + generation orchestrator + progress — 1 day
4. **PuzzleView UI** (solve flow, deep-link, streak) — 1 day
5. **Polish**: theme badges, filters, stats mini-row, README/docs, screenshots — half day

## 11. Confirmed decisions (user, 2026-09)

- Punish-mode (win back after the opponent's blunder): **ON** by default
- **Strict** single solution (validated unique first move)
- Generation scope: **all analysed games** of the player (cap 40/pass,
  newest first, resumable)
- Difficulty: **all tiers** by default (filter exists, default = all)
- **Hint button**: light bulb (monochrome), tap → highlight origin cell of
  the piece to move + 30 s timer; after 30 s, tap again → show solution
- **Infinite retries** (no attempt cap; reveal only via the hint progression)

## 12. Risks / open questions

- **fast-mode caches**: deltas are trustworthy, pv lines are short →
  validation always re-searches with the full engine; if the user has only
  ever analysed `lite`, generation quality drops — show a hint ("analizza in
  modalità completa per puzzle migliori").
- **Time-pressure noise**: bullet blunders are plentiful; punish-mode +
  swing threshold keep volume sane, tier filter keeps them useful.
- **Same tactical motif recurring** (user plays 20 blitz games vs same
  opening): UNIQUE(username, fen) dedups exact repeats; near-repeats are
  *good* (spaced repetition of their own patterns).
- **v2 candidates**: personal puzzle Elo from attempts; due-based repetition
  queue (SM-2 light); "puzzle battle" streak weeks; defensive puzzles
  (save the draw); export as PGN.
