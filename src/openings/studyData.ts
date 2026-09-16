/**
 * Opening-study dataset (docs/FEATURE-OPENINGS.md).
 *
 * Source: the Lichess openings TSVs (public domain, CC0) that
 * scripts/fetch-openings.ts already downloads. From those raw rows this pure
 * module builds the STUDY TREE:
 *
 *   main opening (name without ":")            e.g. "Sicilian Defense"
 *     ├─ its own main line                     study item 0
 *     └─ FIRST-TIER variants (frontier lines)  items 1..n
 *
 * A variant is kept only if it extends the main line AND no shorter kept
 * variant already covers its prefix ("frontier" selection). Deep sub-lines
 * are therefore HIDDEN and learnt as part of their first-tier variant - the
 * user learns "the French Defense, Winawer" as one sequence, not 40 nested
 * fragments. Frontiers per opening: median 2, max ~32 (Sicilian).
 *
 * Everything here is pure & unit-tested; the fetch script and the React view
 * both consume it.
 */
import { Chess } from "chess.js";

export interface StudyVariant {
  /** variant name WITHOUT the parent prefix ("Winawer Variation") */
  name: string;
  eco: string;
  /** full SAN sequence from the starting position (includes the main-line prefix) */
  moves: string[];
}

export interface StudyOpening {
  /** canonical key = exact top-level name (identity for progress tracking) */
  key: string;
  eco: string;
  /** main line SAN (study item 0); may be empty for 1-ply "openings" */
  moves: string[];
  variants: StudyVariant[];
}

/** one expected step of a line, resolved to squares for input checking */
export interface StudyStep {
  uci: string;
  from: string;
  to: string;
  san: string;
}

/** SAN tokens from a PGN movetext (strips results, comments, NAGs, clocks). */
export function sanMovesOf(pgn: string): string[] {
  return pgn
    .replace(/\{[^}]*\}/g, " ")
    .replace(/;\S*/g, " ")
    .split(/\s+/)
    .filter((tk) => /^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?$/.test(tk));
}

/** SAN equality ignoring check/mate glyphs. */
export function sanEq(a: string, b: string): boolean {
  return a.replace(/[+#]$/, "") === b.replace(/[+#]$/, "");
}

interface RawRow {
  eco: string;
  name: string;
  pgn: string;
}

/**
 * Build the study tree from raw TSV rows. Deterministic: openings sorted by
 * name, variants by line length then name. Entries whose line does not
 * replay legally are dropped.
 */
export function buildStudy(rows: RawRow[]): StudyOpening[] {
  // one (shortest) line per exact name - the dataset's own convention
  const best = new Map<string, { eco: string; moves: string[] }>();
  for (const r of rows) {
    if (!r.name || !r.pgn) continue;
    const moves = sanMovesOf(r.pgn);
    if (moves.length === 0) continue;
    const cur = best.get(r.name);
    if (!cur || moves.length < cur.moves.length) best.set(r.name, { eco: r.eco, moves });
  }

  const replays = (moves: string[]) => {
    try {
      const ch = new Chess();
      for (const san of moves) if (!ch.move(san)) return false;
      return true;
    } catch {
      return false;
    }
  };

  const mains = [...best.keys()].filter((n) => !n.includes(":")).sort((a, b) => a.localeCompare(b));
  const out: StudyOpening[] = [];
  for (const key of mains) {
    const entry = best.get(key)!;
    if (!replays(entry.moves)) continue;
    // children: names prefixed by "<main>: " whose line extends the main line
    const kids = [...best.entries()]
      .filter(([n]) => n.startsWith(`${key}: `))
      .map(([n, v]) => ({ name: n.slice(key.length + 2), eco: v.eco, moves: v.moves }))
      .filter(
        (k) =>
          k.moves.length > entry.moves.length &&
          entry.moves.every((mv, i) => sanEq(mv, k.moves[i])) &&
          replays(k.moves),
      )
      .sort((a, b) => a.moves.length - b.moves.length || a.name.localeCompare(b.name));

    // frontier: keep a line unless an already-kept shorter line is its prefix
    const variants: StudyVariant[] = [];
    for (const k of kids) {
      const covered = variants.some(
        (p) => k.moves.length > p.moves.length && p.moves.every((mv, i) => sanEq(mv, k.moves[i])),
      );
      if (!covered) variants.push(k);
    }
    out.push({ key, eco: entry.eco, moves: entry.moves, variants });
  }
  return out;
}

/** study items of an opening: index 0 = main line, then the variants */
export function studyItems(opening: StudyOpening): { name: string; eco: string; moves: string[] }[] {
  return [
    { name: "main", eco: opening.eco, moves: opening.moves },
    ...opening.variants.map((v) => ({ name: v.name, eco: v.eco, moves: v.moves })),
  ];
}

/** Replay a SAN line from the start position into concrete steps. */
export function stepsFromLine(moves: string[]): StudyStep[] {
  const ch = new Chess();
  const steps: StudyStep[] = [];
  for (const san of moves) {
    try {
      const m = ch.move(san);
      steps.push({ uci: m.from + m.to, from: m.from, to: m.to, san });
    } catch {
      break; // truncated line: the view treats a prefix as invalid anyway
    }
  }
  return steps;
}
