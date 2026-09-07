/**
 * The per-game "improvement block": everything the stats page needs to
 * answer WHERE and WHY points are lost, computed from data we already
 * persist (stored per-move analysis) + the raw PGN (clocks, termination).
 * No engine, no migration: pure chess.js replay, safe to run on every
 * stats load. Unit-tested in tests/improve.test.ts.
 */
import { Chess } from "chess.js";
import type { Category } from "../engine/classify";
import type { StatsGameRow } from "./statsRows";
import { expectedPoints } from "./winprob";
import { parseClocks, parseTermination, replayMeta, type Clocks, type TermKind } from "./pgnMeta";
import { classifyMotif, type Motif } from "./motifs";

/** Bad-move categories we bother to diagnose (user view). */
const NOTABLE: Set<string> = new Set(["mistake", "blunder", "missedwin"]);

export interface MotifHit {
  ply: number;
  san: string;
  motif: Motif;
  /** win-expectation lost by this move (user points 0..100) */
  drop: number;
  bestSan: string | null;
  /** seconds left before the move (null = no clock data) */
  remaining: number | null;
}

export interface ImproveBlock {
  term: TermKind;
  /** White expected points (0..100) AFTER each ply (WDL model, material-aware) */
  wp: number[];
  /** White expected points at the start position */
  wpStart: number;
  /** first ply whose resulting position qualifies as an endgame (null: none) */
  endPly: number | null;
  /** plies in the recognised opening book (0 when none) */
  bookPly: number;
  clocks: Clocks;
  /** diagnoses of the user's notable moves (mistake/blunder/missed win) */
  motifs: MotifHit[];
  /** the user's single biggest expectation drop (the "losing move") */
  drop: { ply: number; san: string; wp: number; bestSan: string | null } | null;
  /** the user's best expectation during the game and when */
  peak: { wp: number; ply: number };
  /** the user's worst expectation during the game and when */
  worst: { wp: number; ply: number };
}

/**
 * Build the block for one analyzed row. `username` disambiguates the
 * Termination tag. Returns null when the row has no analysis moves.
 */
export function buildImprove(row: StatsGameRow, username: string): ImproveBlock | null {
  if (row.moves.length === 0) return null;
  const youWhite = row.youWhite;
  const clocks = parseClocks(row.pgn);
  const term = parseTermination(row.pgn, username);
  const meta = replayMeta(row.moves.map((m) => m.san));
  if (meta.materialAfter.length !== row.moves.length) {
    // PGN and analysis rows disagree (should not happen): truncate to min
    row = { ...row, moves: row.moves.slice(0, meta.materialAfter.length) };
  }

  // --- wp curve (White expected points after each ply) ---
  const wp: number[] = [];
  // engine eval at the start position is not stored; 50 is the fair anchor
  const wpStart = 50;
  for (let i = 0; i < row.moves.length; i++) {
    const m = row.moves[i];
    let exp: number;
    const mate = m.scoreMate ?? 0;
    if (mate !== 0) {
      // mate stored from the side-to-move view; the side to move AFTER the
      // move is the opposite of the mover
      const stmMates = mate > 0;
      const whiteWins = (m.color === "w" ? !stmMates : stmMates);
      exp = whiteWins ? 100 : 0;
    } else {
      const cp = m.scoreCp ?? 0;
      const whiteCp = m.color === "w" ? -cp : cp; // score is mover's stm view
      exp = expectedPoints(whiteCp, meta.materialAfter[i] ?? 78) * 100;
    }
    wp.push(exp);
  }

  const youWp = (x: number): number => (youWhite ? x : 100 - x);

  // --- biggest user drop / peak / worst (evaluated at the end of each ply) ---
  let drop: ImproveBlock["drop"] = null;
  // peak / worst expectation over EVERY ply (the opponent's blunders shift
  // the user's chances too)
  let peak = { wp: youWp(wpStart), ply: 0 };
  let worst = { wp: youWp(wpStart), ply: 0 };
  for (let i = 0; i < wp.length; i++) {
    const you = youWp(wp[i]);
    if (you > peak.wp) peak = { wp: you, ply: i };
    if (you < worst.wp) worst = { wp: you, ply: i };
  }
  // the user's single biggest expectation drop (their own worst move)
  for (let i = 0; i < row.moves.length; i++) {
    const m = row.moves[i];
    if (m.color !== (youWhite ? "w" : "b")) continue;
    const before = i === 0 ? youWp(wpStart) : youWp(wp[i - 1]);
    const after = youWp(wp[i]);
    const d = before - after;
    if (d > 0 && (drop == null || d > drop.wp)) {
      drop = { ply: i, san: m.san, wp: d, bestSan: m.bestSan };
    }
  }

  // --- motif diagnosis on the user's notable moves ---
  const motifs: MotifHit[] = [];
  for (let i = 0; i < row.moves.length; i++) {
    const m = row.moves[i];
    if (m.color !== (youWhite ? "w" : "b")) continue;
    if (!NOTABLE.has(m.category)) continue;
    const fenBefore = meta.fens[i];
    if (!fenBefore) continue;
    let playedUci: string | null = null;
    try {
      const c = new Chess(fenBefore);
      const mv = c.move(m.san);
      if (mv) playedUci = mv.from + mv.to + (mv.promotion ?? "");
    } catch {
      playedUci = null;
    }
    if (!playedUci) continue;
    const before = i === 0 ? youWp(wpStart) : youWp(wp[i - 1]);
    const motif = classifyMotif({
      fenBefore,
      playedUci,
      bestUci: m.bestUci,
      bestMateIn: m.bestMate ?? null,
      remainingSec: clocks.remaining[i - 1] ?? null, // remaining BEFORE this move
      deltaCp: m.delta,
    });
    motifs.push({
      ply: i,
      san: m.san,
      motif,
      drop: Math.max(0, before - youWp(wp[i])),
      bestSan: m.bestSan,
      remaining: clocks.remaining[i - 1] ?? null,
    });
  }

  return {
    term,
    wp,
    wpStart,
    endPly: meta.endPly,
    bookPly: row.opening?.depth ?? 0,
    clocks,
    motifs,
    drop,
    peak,
    worst,
  };
}

// ---- category helpers re-exported for the aggregations --------------------

export type { Category };
