# Openings Study — memorize and understand openings

Goal: help the user MEMORISE opening repertoires by actively playing the
correct moves of each variation on the board (same interaction language as
the Puzzles section).

## Data (static, no engine)

`scripts/fetch-openings.ts` (postinstall) already downloads the Lichess
openings TSVs (CC0). It now emits a second artifact:

- **`public/opening-study.json`** (`{ v: 1, openings: StudyOpening[] }`, ~59 KB)
  built by the pure module `src/openings/studyData.ts`:
  - **Main openings** = dataset names without `:` → 134 cards (Sicilian
    Defense, Queen's Gambit Declined, …).
  - **Variants** = names prefixed `"<main>: "`, reduced to the FIRST TIER
    ("frontier" selection: a line is kept only if no shorter kept line is
    its prefix). Deep sub-lines are HIDDEN — they are learnt as part of
    their first-tier variant. Result: 608 variants total, median 2 per
    opening, max 32 (Sicilian / Caro-Kann).
  - Deterministic order: openings alphabetical, variants by line length
    then name. Illegal lines dropped. Unit-tested (`tests/openings-study.test.ts`).

Each opening's study list = **item 0 the main line**, items 1..n the variants.
Every item stores its FULL SAN sequence from the starting position (the drill
always replays the complete variation, prefix included).

## Persistence (migration v5)

`opening_progress(username, opening, variant_index, completed_at)` — one row
per COMPLETED variation (`variant_index 0` = main line). Idempotent upsert;
`deletePlayer` cascades. The dataset itself never touches the DB.

API (`server/index.ts`):

- `GET  /api/db/openings-progress?username=` → `{ progress: [...] }`
- `POST /api/db/openings-progress {username, opening, variantIndex}` → complete one
- `POST /api/db/openings-progress/reset {username, opening}` → forget one opening

Client helpers in `src/api/reviewDb.ts`.

## UI (`src/components/OpeningsView.tsx`)

Nav: book-stack icon (top menu, from the game list onwards — same rules as
stats/puzzles). History-aware like everything else: locKey
`openings|<user>|<openingKey>` so back goes drill → list → games.

**List phase** — searchable card grid; each card: name, ECO chip, progress
bar + `done/total` (e.g. 3/12), variant count. Completed openings get a
green bar. Started-but-not-finished trainings are pulled into an **"In
corso / Ongoing"** section between the search bar and the full list ("Tutte
le aperture"), most recently played first (by `completed_at`).

**Board side** — the drill board defaults to White's side; a double-arrow
button (same `FlipIcon` as the review page) below the board flips it. The
choice persists across openings for the session.

**Drill phase** — board (Staunton pieces, white orientation) with the
variation description ABOVE it (opening name + ECO + variation label +
`Mossa {n}/{total}` chip). The user plays BOTH colours, move by move:

- correct move → advances; wrong move → lands, red modal, snaps back to the
  current step (same feedback language as puzzles);
- **Hint** (bulb, puzzle-style): amber ring on the origin square + 30s
  countdown → then the expected SAN is shown next to the bulb;
- **Show**: replays the WHOLE variation once at 1 move/second, then resets
  the board and greys itself out for that variation — the user must try;
- completing the line marks it done server-side (optimistic card progress)
  and reveals **"Prossima variante →"**; after the last one a completion
  message. Variation chips (★ = main, ✓ = done) allow jumping around.

## Decisions (user, 2026-09)

- Memorisation first; "understanding" aids come later.
- Variants are hidden in the list on purpose — learnt with their main opening.
- Show plays exactly ONCE per variation, then forces a try.
- No penalty for wrong moves here (this is study, not puzzles).
