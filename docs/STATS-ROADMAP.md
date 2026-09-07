# Stats roadmap — from numbers to improvement

Research + proposal for turning the stats page from "what happened" into
"what to fix". Sources at the end; every metric below is argued, and its
feasibility against **our** data/pipeline is stated.

## 1. What we have today

Blocks (all computed client-side over per-game summaries):

1. Results W/D/L + accuracies, tabbed by time class, split by colour
2. Per-opening table (games, score)
3. Elo trajectory per time class
4. Per-move accuracy histogram
5. Weak moves & blunders per game
6. Win rate vs opponent-strength gap
7. Results by hour of day

Raw data already stored per analysed game (`analyses` + `analysis_moves`
+ `analysis_lines`): every move's category, delta-cp, loss, the played
side's score, top-3 engine lines (mate-mapped), both accuracies, engine
combo, recognised opening + depth. The `Game` carries the **full PGN**,
which includes `{[%clk …]}` clock comments per move and a `[Termination
"…"]` tag (both verified present). So most of what follows needs **no new
engine work** — it is pure aggregation / chess.js replay over data we
already persist.

## 2. The core problem with the current page

Everything is *distributional* (how many, how often). None of it answers
the only question that matters: **"where exactly am I losing points, and
what do I drill?"** Coaching literature and the tools people actually pay
for (chess.com Insights/Game Review, ChessMonitor) converge on four
answer-shapes: **cause** (which kind of mistake), **where** (phase /
opening / clock situation), **conversion** (what you fail to finish), and
**trend** (am I improving independent of rating). We implement all four.

## 3. Key research findings

- **Centipawns are not outcomes.** Stockfish itself ships a documented
  Win/Draw/Loss model: `win_rate(x, mom) = 1/(1+exp(−(x−p_a(mom))/p_b(mom)))`
  with cubic polynomials `p_a/p_b` of *material* (mom) — official repo
  `official-stockfish/WDL_model`. SF ≥ 16.2 displays WDL
  (`UCI_ShowWDL`), and our Stockfish 18 WASM accepts it. A +1.4 eval means
  something different in a complex middlegame than in a queenless
  endgame; converting eval → **win probability** makes every curve and
  every "cost" comparable across phases. (Also: "Centipawns Suck",
  Zwischenzug; ACPL criticisms on HN/chess.com.)
- **Blunders are clock-driven.** Lichess data-blogs (jk_182, "How does the
  Clock impact the Rate of Mistakes?") and a 25M-position community study
  show blunder rate spikes at low remaining time while inaccuracy/mistake
  rates stay roughly flat; time-trouble mistakes cluster after the
  time-control milestone. Our PGNs carry per-move clocks → we can show the
  user *their own* version of these curves.
- **Cause classification is what chess.com Insights monetizes**: Tactics
  tab = Found vs Missed forks/pins/mates + pieces left hanging, with
  drill-down to the positions. All of it is detectable **without a neural
  net**: chess.js attack/defend queries at the mistake node, plus the
  mate scores and best moves we already store per move.
- **Per-phase analysis is the standard coaching cut** (opening ≤ book
  exit / middlegame / endgame by material). Game Review shows per-phase
  accuracy; the expected-score category definitions are exactly ours
  (inaccuracy/mistake/blunder thresholds).
- **Performance rating** (USCF/documented): `PR = avgOpp + 400·log10(S/(1−S))`
  turns any subset (vs a given opening, at bullet, after 8pm) into
  "rating-equivalent" — far more intuitive than win% tables, and directly
  comparable to the player's actual rating (over/under-performance).
- **Improvement ≠ rating.** Rating is a lagging, noisy signal; accuracy
  trend at fixed time class leads it (multiple coaching sources;
  "How to Measure Chess Improvement Without Your Rating"). We already
  compute accuracy per game → rolling trend is free.
- Papers (MDPI 2025 comparative outcome models; Springer "Blunder
  prediction in chess"; ACM "Learning Models of Individual Behavior in
  Chess") confirm the general approach: **feature-based per-player
  profiling from engine features**, not black boxes. They also warn
  single-game predictions are noisy → all our metrics are set-level.

## 4. Proposals

Priority = (expected improvement value) / (effort). "Stored" = can be
computed from data we already persist (no engine re-run); "run-time" =
computed inside `analyseOne` during stats runs.

### P0 — the loss-autopsy core

**A. Win-probability layer** *(foundation; stored + optional engine)*
Use the Stockfish WDL model (published polynomial coefficients, or parse
`w/d/l` from `UCI_ShowWDL` info lines — one-line change in `engine.ts`)
to map every stored score → win probability for the user. Everything
below consumes `wp(0..100)`. Rationale: makes drops comparable across
phases ("you lost 31% win chance at move 24" beats "−1.8 cp"), powers
the classic win-bar and every conversion metric.

**B. "How you lost" autopsy cards** *(stored)*
Per decisive game: wp curve, the single largest wp drop (the "losing
move") with context — phase, clock at that moment, termination tag,
mistake category, and the best move you missed. Aggregated over the set:
**"half-points lost by cause"**: opening-after-book / tactics / time
trouble / endgame conversion. Rationale: this is the #1 coaching
artifact; it replaces 8 charts with one actionable list, each item
clicking straight into the review at that move.

**C. Termination breakdown** *(stored, trivial)*
Parse `[Termination]`/result: checkmate · resign · timeout (you flagged /
they flagged) · agreed draw · abandoned. Split won/lost. Rationale: free,
and instantly actionable ("5 losses on time, 4 of them with eval ≥ 0").

**D. Conversion & resilience** *(stored)*
Conversion rate = games reaching wp ≥ 85 → % won; "wins thrown" count and
average wp-drop inside them; resilience = games at wp ≤ 15 → % saved.
Rationale: separates "I lose equal/bad positions" (psychology/time) from
"I don't finish won ones" (technique) — different training entirely.

**E. Phase split** *(stored; endgame boundary = material rule)*
Opening = plies ≤ book exit (we store the recognised depth); endgame
starts at first position with non-pawn material ≤ 13 (≈ two rooks) or
queens off with ≤ 2 minors (documented community heuristic); rest is
middlegame. Per phase: mean accuracy, blunders/30 moves, avg wp-drop.
Rationale: the standard coaching cut; shows *where* points leak.

### P1 — clock intelligence *(run-time parse of `[%clk]`, then stored)*

**F. Clock panel**
- Time-spent histogram per game + "moves < 3 s in complex positions"
  (impulsivity: fast move AND |Δwp| large)
- **Your blunder-rate vs remaining time** (the jk_182 chart, on your own
  games): share of blunders with < 30 s / < 15 % of initial clock
- Time-trouble share per time class; losses after reaching a winning
  position then flagging
Rationale: at 1200 the top causes are one-move blunders and the clock; we
already have the exact data both published studies wished they had.

### P1 — tactical cause tagging (chess.com Insights parity) *(run-time
chess.js at mistake nodes only — we already store `bestUci` per move)*

**G. Motif classifier**, one primary cause per mistake/blunder:
- *mate missed*: node's stored MultiPV line had `mate ≤ 3` (we store mate
  scores — near-free) · *mate allowed*: best move prevented mate
- *hanging*: the played move leaves a piece capturable with net gain
  (chess.js attackers/defenders) or fails to take a free piece the best
  move takes
- *fork / pin missed*: best move creates an attack on ≥ 2 valuable targets
  (knight/pawn/king fork; skewer along line pieces) — chess.js
  `attackers()` arithmetic, no engine
- *time pressure* override: < 20 s remaining (from clk) reclassifies
Rationale: converts "47 blunders" into "38% of your lost points: pieces
left en prise → board-vision/puzzle training; 19%: missed forks". This is
literally the chess.com Insights Tactics tab (Found vs Missed
forks/pins/mates/hanging pieces) — reproducible deterministically.

### P1 — opening post-mortem *(stored)*

**I. Post-book gap**: for each game, the first 3 moves *after* book exit:
mean Δwp, blunder rate — per opening and per colour. Ranking = "your prep
falls apart here" (Sicarian: 0.61 wp lost in moves 9-11).
**J. Repertoire exposure**: per opening you face, score + wp — plus
"vs opponents below you" (feeds K).

### P2 — rating science *(stored)*

**K. Performance rating everywhere**: `PR = avgOpp + 400·log10(S/(1−S))`
per subset (time class, opening, hour band, opponent band) shown as
"your rating in this slice" — replaces the raw win-rate-vs-gap chart with
**expected-score curve (Glickman E) + your deviation**: "vs weaker you
underperform by 8% → you choke; vs equal you overperform".
**L. Improvement trend**: 14-day rolling mean accuracy ± std per time
class with slope badge — improvement signal before rating moves.
**M. Consistency**: current/longest streaks; σ of last-20 rating deltas
(stability), best/worst day-of-week (extends hour panel).

### P2 — the synthesis card

**N. "Top improvement actions"**: rank {time trouble, hanging pieces,
missed mates, post-book gap in X, won→lost conversion, endgame} by
**half-points/month lost**, show top 3 with a one-line prescription and a
link to the supporting charts/positions. Every other block feeds it.
Rationale: the page currently asks the user to be the analyst. Invert it:
lead with the diagnosis, let them drill down. This single card is what
makes the rest "useful" instead of "interesting".

## 5. Proposed page layout (story order)

1. **Headline row**: rating + performance + improvement-trend badge (L)
2. **Top improvement actions** (N)
3. **How you lost** autopsy list (B) + termination strip (C)
4. **Where points leak**: phase table (E) + conversion/resilience (D)
5. **Clock** (F)
6. **Tactics causes** (G) — motif donut + worst-position links
7. **Openings**: table + post-book gap (I, J)
8. **Rating science** (K, M)
9. Existing keepers: calendar/hour, Elo trajectory, accuracy histogram

## 6. Implementation notes

- New aggregations = pure functions in `statsData.ts`, unit-tested with
  fixture summaries (existing pattern). No UI coupling.
- `analyseOne` extends `GameSummary` (v2): wp-curve aggregates, phase
  boundaries, clock stats, motif counts, termination. Persisted inside the
  existing `putAnalysis` payload (bump `v: 2` → new optional fields;
  older rows degrade gracefully — feature hidden until re-run).
- Motif pass + clock parse: chess.js replay, ~1-2 ms per mistake → whole
  176-game set well under a second; **no extra engine searches, no change
  to analysis cost**.
- WDL: start with the published SF18 coefficients (pure function,
  unit-testable); optionally switch to engine-emitted `w/d/l` later.
- i18n: everything through `STRINGS` (it/en); charts stay hand-rolled
  SVG/divs per project standard.

## 7. Non-goals (and why)

- *Opponent scouting / 3-in-a-row prep*: needs an opponent-history DB —
  different product.
- *Opening recommendation vs a mega-database*: dataset too heavy for the
  container; post-book-gap already gives the actionable half.
- *Style clustering / "you play like Tal"*: entertainment, zero training
  value (papers on player-similarity are retrieval demos).
- *Neural mistake classifiers*: papers show tabular features at our data
  scale do the job; keep it deterministic and explainable.

## 8. Sources

- official-stockfish/WDL_model (GitHub) — WDL logistic model, p_a/p_b
  polynomials, UCI_ShowWDL
- chess.com Help Center — "What is Insights on Chess.com?" (Tactics
  Found/Missed motifs, hanging pieces, calendar)
- lichess.org blog jk_182 — "How does the Clock impact the Rate of
  Mistakes?" (methodology + findings)
- r/chess — "Blunder rate versus time spent on move (25 million
  positions)"
- Zwischenzug "Centipawns Suck"; HN/chess.com ACPL critiques
- USCF/perf-rating formula: PR = avgOpp + 400·log10(S/(1−S)); Glickman
  expected score
- MDPI Electronics 15(1):2025 — ML chess outcome classification;
  Springer Appl Intell — "Blunder prediction in chess"; ACM GEOB/chess
  individual-behavior models (feature-based profiling support)
- chessmonitor.com, chessinsights.com (competitor feature scan)
