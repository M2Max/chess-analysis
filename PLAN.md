# chesscom-review — Implementation Plan

Chess.com game review: fetch a user's last 30 days of games, analyze each move
client-side with Stockfish (WASM), show a chess.com-style review UI with
branching + live evaluation of off-mainline moves.

## 1. Requirements (recap)

1. **Retrieve** — enter chess.com username → list of all games in the last 30
   days via chess.com official open API.
2. **Analyze** — click a game → loading state → client-side Stockfish analysis
   of the whole game; every move classified like chess.com:
   best / great / good / inaccuracy `!?` / mistake `?` / blunder `??` / brilliant `!!`.
3. **Review UI** — chessboard left, moves + eval column right (chess.com style).
   Branchable: a move different from the game history starts immediate
   evaluation of that move; "back to game" returns to the mainline.

## 2. Stack (decided)

| Layer      | Choice                                             | Notes |
|------------|----------------------------------------------------|-------|
| Runtime    | **Bun 1.3.6** (server, scripts, tests)             | node ≥24 via `.nvmrc` (node 26 not in nvm yet); node only for tooling compat |
| Frontend   | Vite 8 + React 19 + TypeScript + Tailwind 4        | already scaffolded, build green |
| Board      | `react-chessboard` 5 (chessground under the hood)  | drag & drop, orientation, highlights |
| Chess logic| `chess.js` 1.x                                     | PGN parse, FEN, legal moves, SAN |
| Engine     | `stockfish` 18 (nmrugg/stockfish.js) **WASM in Web Worker** | UCI protocol; lite + full, single- AND multi-threaded builds in `public/stockfish-{lite,full}/` (fetched by postinstall, not committed); user picks build + threads in the settings view; multi needs COOP/COEP (served by dev + prod), auto-fallback to single |
| Backend    | minimal `Bun.serve` (`server/index.ts`)            | prod: static `dist/` + SPA fallback + optional `/api/chesscom` proxy |

**Engine builds** (`STOCKFISH_BUILD`, see `scripts/fetch-engine.ts`):
- `lite-single` (default, ~7MB wasm, small NNUE) — fast load, good strength
- `full-single` (~113MB wasm, full NNUE) — stronger, heavy first download
- `lite` / `full` — multi-threaded (SharedArrayBuffer); needs COOP/COEP headers
  in browser → phase 6 only.

## 3. Verified facts about the chess.com API (checked 2026-08-26)

- `GET https://api.chess.com/pub/player/{username}` — profile; 404 if unknown user.
- `GET https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}` — up to
  **200 games/month**, only **current + previous month** available. Each game
  object already contains the full **`pgn`** → no per-game fetch needed.
  **The dash form `{YYYY-MM}` now 404s** — only the slash form works
  (server 301-redirects unknown-case usernames to lowercase).
  **Game array is NOT in chronological order** — client must sort by `end_time`.
  Usernames: preserve the user's casing (server lowercases internally via 301).
- **CORS is open**: `access-control-allow-origin: *` → frontend calls the API
  directly; the Bun proxy is an optional fallback (rate-limit buffering, tests).
- Rate limits: 300 req/min per IP → 2 requests per search, no problem.
- **Known quirk 1**: with exactly 1 game, `games` is a single object, not array.
- **Known quirk 2**: `{"code":0,"message":"Data provider not found
  for key ..."}` on `/games/{month}` — transient data-provider outage (observed
  2026-08-26, self-healed same day); needs retry + graceful error UI.
- **Game object shape (verified 2026-08-26)**: `uuid` (id), `url`,
  `end_time` (epoch seconds), `time_class` (bullet/blitz/rapid/classical/…),
  `rules` ("chess"), `time_control` ("180" = seconds, "3+2" = min+sec),
  `accuracies` {white, black}, `pgn`, `white`/`black` {username, rating, uuid,
  result}. **No top-level `id`/`utc`/`result`/`variant`** — the result lives in
  the PGN `[Result]` tag. (Legacy field names still accepted as fallbacks.)
- **Limitation**: >200 games in a month → the 30-day window can be incomplete
  for very active users. Document in UI (e.g. "showing latest 200").

**Last-30-days strategy**: fetch `YYYY/MM` of current month AND previous month,
filter `utc_timestamp >= now − 30d`, dedupe, sort desc.

## 4. Repo layout

```
chesscom-review/
├── server/index.ts            # Bun prod server (static + optional proxy)   [done]
├── scripts/fetch-engine.ts    # postinstall: copy chosen SF build to public/ [done]
├── public/stockfish-lite/     # lite build (generated, gitignored)
├── public/stockfish-full/     # full build (generated, gitignored)
├── src/
│   ├── api/
│   │   └── chesscom.ts        # profile check, games fetch, 30d filter, retry
│   ├── engine/
│   │   ├── stockfish.ts       # Web Worker UCI wrapper (queue, abort, events)
│   │   ├── analysis.ts        # full-game pipeline (positions → evals → cats)
│   │   └── classify.ts        # delta(cp) → best/great/.../blunder           [unit tested]
│   ├── state/
│   │   └── review.ts          # useReducer: mainline + branch tree, current path
│   ├── components/
│   │   ├── SettingsView.tsx   # username + engine choice + Retrieve (localStorage)
│   │   ├── GameList.tsx       # game cards (date, opponent, result, rating)
│   │   ├── ReviewView.tsx     # board left / moves right layout
│   │   ├── BoardPanel.tsx     # react-chessboard + nav buttons + PV arrow
│   │   ├── MoveList.tsx       # numbered moves, colors, category symbols
│   │   ├── EvalBar.tsx        # white-advantage bar (cp → %)
│   │   └── LoadingOverlay.tsx # progress + cancel while analyzing
│   └── App.tsx                # screen router: search → list → review
├── tests/                     # bun test (fixtures in tests/fixtures/)
├── PLAN.md  README.md  package.json  vite.config.ts  tsconfig*.json
```

## 5. Data model

```ts
type Category = "best" | "great" | "good" | "inaccuracy" | "mistake" |
                "blunder" | "brilliant";

interface PlayerRef { name: string; username: string; rating?: number }
interface ParsedGame {
  id: string; url: string; utc: number;
  white: PlayerRef; black: PlayerRef;
  result: string;                       // "1-0" | "0-1" | "1/2-1/2" | "*"
  pgn: string;
  moves: { san: string; fenBefore: string; fenAfter: string }[];
}

interface Node {                         // one position in the analysis tree
  idx: number;                           // id in nodes[]
  parent: number | null;                 // tree link
  depthFromStart: number;                // plies from start
  isMainline: boolean;
  move?: { san: string; uci: string };   // move that led here (undefined for start)
  fen: string;                           // position at this node
  evalCp?: number;                       // engine eval of `fen`, from side-to-move view
  evalMate?: number;                     // if engine saw a mate
  best?: { uci: string; san: string };   // engine best move at `fen`
  category?: Category;                   // category of `move` (the move INTO this node)
  achievedDepth?: number;
}
```

State: `nodes: Node[]`, `mainline: number[]` (chain of idx), `path: number[]`
(current view path, may diverge from mainline). "Back to game" = truncate
`path` at the divergence point. Branches stay in `nodes` for re-entry.

## 6. Engine integration (UCI over Web Worker)

- Worker: `new Worker("/stockfish/stockfish.js")` — plain file in `public/`,
  no bundler involvement (avoids wasm bundling issues in dev + build).
- Handshake: `uci` → `uciok`; `isready` → `readyok`.
- Per position:
  ```
  position fen {fen}
  setoption name MultiPV value 1        # 2 in phase 6 for brilliant detection
  go depth {D}                          # D ≈ 20 (tune by measured speed)
  ```
  Parse `info depth … score cp <n> | mate <n>` (keep deepest with `pv`),
  then `bestmove <uci>`.
- Branch moves: `go movetime 800` (fast feedback), refine in background.
- Protocol: single worker, **sequential queue** with `stop`/`bestmove` to
  interrupt stale work (e.g. user navigates, new analysis starts).
- Progress: `done/total` positions → progress bar in LoadingOverlay.
- Caching (phase 6): FEN → {evalCp, best, depth} in localStorage LRU (~5MB).

**Mate handling**: normalize mates to centipawns before deltas:
`score = mate ? (MATE_LIMIT − plyToMate) * 100 : cp` (MATE_LIMIT ~ 100).

## 7. Full-game analysis algorithm

Game of N plies → positions P₀ … P_N (N+1 positions; P₀ = start).

1. Parse PGN with chess.js → `moves[]` with `fenBefore/fenAfter` (guard:
   reject non-classic PGN, empty move lists, PGN parse errors with a message).
2. Analyze **every** position Pᵢ (i = 0 … N) → `E[i]` (eval from side-to-move
   perspective at Pᵢ) + best move `B[i]`.
3. For each move m (1-based, played from P_{m−1} to P_m), mover's view:
   - `bestAfter  = E[m−1]` (engine's best line at the position before the move)
   - `playedAfter = −E[m]` (engine eval of resulting position, negated)
   - `delta = bestAfter − playedAfter` (centipawns)
4. Classify (single source of truth in `classify.ts`, thresholds tunable;
   chess.com's exact cutoffs are private — these follow lichess conventions):

   | delta (cp)  | category     | symbol |
   |-------------|--------------|--------|
   | ≤ 0, move == B | best       | —      |
   | (0, 30]     | great        | !      |
   | (30, 100]   | good         | —      |
   | (100, 200]  | inaccuracy   | !?     |
   | (200, 400]  | mistake      | ?      |
   | > 400       | blunder      | ??     |
   | move == B and B ≥ 100cp better than 2nd best (MultiPV 2, phase 6) | brilliant | !! |

5. Result = mainline `nodes[]` with `evalCp`/`category` per node; render.

Cost: N+1 analyses ≈ 10–40 s for a typical game at lite-single/depth 20.
Progress bar + cancel makes that acceptable. (Phase 6: multi-thread cuts it ~3–4×.)

## 8. Branching / live analysis

- Board interactive at the current node (side to move = side of `fen`).
- Move == next mainline move → advance path along mainline.
- Different legal move → **create branch node** (parent = current):
  1. apply move (chess.js) → new node in `nodes`, push to `path`;
  2. immediately `go movetime 800` on the resulting position → stream `info`
     lines (eval bar + best line update live), final `bestmove` fills
     `evalCp`, `best`, and the branch move's `category` (delta vs parent best).
  3. show engine's best-reply PV as an arrow overlay on the board.
- "Back to game" button appears as soon as `path` diverges from mainline →
  resets path to mainline prefix (branch nodes kept).
- Move list renders the current path; divergent moves get a distinct style
  (chess.com shows branches in a different color + "new line" marker).
- Navigation: click any move (mainline or branch), ←/→ arrows, first/last,
  drag pieces on board.

## 9. UI layout (chess.com review style, dark theme)

```
┌───────────────────────────────┬────────────────────────────────┐
│ [eval bar]                    │ Hikaru (2801)   ●  1-0  ●      │
│                               │ Magnus (2840)                 │
│        CHESS BOARD            │ ┌────────────────────────────┐ │
│        (left, square)         │ │ 1. e4 e5 2. Nf3 !? 3. Nc3 ? │ │
│                               │ │    4. Bb5 ?? 5. O-O        │ │
│ [⟵] [▶] [⟶]  [⟲ back to game]│ │    …  (auto-scroll, colors, │ │
│                               │ │    category symbols)       │ │
│ best-move PV arrow overlay    │ └────────────────────────────┘ │
│                               │ [accuracy summary / eval chips]│
└───────────────────────────────┴────────────────────────────────┘
```

Screens: `Search` (form) → `GameList` (cards: date, opponent+rating, result,
variant) → `Loading` (overlay w/ progress + cancel) → `Review`.

## 10. Phases

- **Phase 0 — Scaffold** ✅ (this commit): bun + vite + react + ts + tailwind,
  bun server, engine fetch script, git. Build + server smoke tested.
- **Phase 1 — Retrieve**:
  - `api/chesscom.ts`: profile check → 2-month fetch → 30d filter/dedupe/sort;
    handle single-object quirk; retry with backoff for "Data provider not
    found"; friendly errors (unknown user, no games, rate limit, API down).
  - `SearchForm` + `GameList` UI.
  - Tests (bun test): 30d boundary filter, quirk normalization, retry logic
    (mock fetch).
- **Phase 2 — Engine core**:
  - `engine/stockfish.ts`: worker wrapper (handshake, queue, position/go,
    info parsing incl. mate, abort, events: `onInfo`, `onBest`).
  - Smoke test: start position → eval ≈ 0, best ∈ top moves; blunder position
    → large negative for the blundered side.
- **Phase 3 — Full analysis**:
  - `engine/analysis.ts` (pipeline + progress + cancel), `classify.ts`.
  - `LoadingOverlay` with % progress.
  - Tests: classify thresholds; fixture game with a known blunder → flagged.
- **Phase 4 — Review UI**:
  - `ReviewView`/`BoardPanel`/`MoveList`/`EvalBar`; move click/arrows/drag nav;
    PV best-move arrow; auto-scroll; player header; result badge.
- **Phase 5 — Branching**:
  - tree state in `state/review.ts`; branch creation + immediate movetime eval;
    live eval streaming; "back to game"; branch styling in move list.
- **Phase 6 — Hardening & polish**:
  - multi-threaded engine (COOP/COEP headers in `server/index.ts` + vite dev
    headers, `type:"module"` worker, `Threads = hardwareConcurrency`);
  - brilliant `!!` via MultiPV 2; FEN eval cache (localStorage);
  - accuracy summary per player (chess.com-style %); responsive layout;
  - README + final pass.

## 11. Testing

- `bun test` unit: `classify.ts` (all thresholds + mates), 30d filter
  (fixtures w/ boundary dates + single-object quirk), PGN parse edge cases
  (resign/draw/timeout/50-move, reject bad PGN).
- Engine smoke (node/bun, headless): load worker, eval start + known position.
- Integration: analyze a short fixture game fully, assert blunder flagged.
- Manual: full flow against real chess.com accounts (hikaru, small accounts).

## 12. Risks / open questions

| Risk | Mitigation |
|------|-----------|
| chess.com `/games/{month}` data provider currently flaky (verified live) | retry/backoff, clear error UI; API shape stable & documented |
| >200 games/month truncates 30d window | UI notice; acceptable limitation |
| lite NNUE weaker than full for sharp positions | `STOCKFISH_BUILD=full-single` switch; document |
| single-threaded analysis 10–40 s/game | progress + cancel; multi-thread phase 6 |
| chess.com exact category thresholds private | lichess-convention thresholds in one tunable file |
| 113MB full wasm first download | default to lite (7MB); full is opt-in |

## 13. Commands

```sh
bun install                 # deps + fetches stockfish (postinstall)
STOCKFISH_BUILD=full-single bun run fetch:engine   # optional stronger engine
bun run dev                 # vite dev server :5173 (frontend-only; chess.com CORS open)
bun run build && bun start  # prod: bun serves dist/ on :3000
bun test
```
