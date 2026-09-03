/**
 * Move classification, expected-loss based.
 *
 * A move's quality is measured by the expected points it loses versus the
 * engine's best move:
 *
 *   delta_cp       = |best_eval − played_eval|          (mover's perspective)
 *   rating_factor  = clamp(rating / 2200, 0.4, 1.5)
 *   expected_loss  = tanh(0.002 · delta_cp · rating_factor)
 *
 * Forced mates are mapped onto a bounded cp scale before deltas are taken:
 * mate-in-1 = 2000cp, mate-in-2 = 1500cp, mate-in-3+ = 1000cp.
 *
 * Core categories (expected points lost):
 *   Best 0 · Excellent ≤0.02 · Good ≤0.05 · Inaccuracy ≤0.10
 *   Mistake ≤0.20 · Blunder >0.20
 *
 * Overrides (checked in this order, first hit wins):
 *   Brilliant - a sacrifice (captured a piece worth less than the moved
 *               piece), near-best (loss ≤ 0.10), not already winning
 *               (best eval < 400cp), and hard to refute: the opponent's
 *               top-3 replies (from their MultiPV search) all sit ≤ 0 for
 *               them and at most two are within 50cp of their best reply.
 *   Great     - the best move, with the 2nd-best more than 80cp worse.
 *   Missed Win- the opponent's previous move was a mistake/blunder and this
 *               move fails to capitalize (not best, loss ≥ 0.15).
 *
 * UCI scores are from the side-to-move's perspective, so for a move played
 * by M from position P to P′:
 *   bestCp  = cp(P best line)                (M's view)
 *   playedCp = cp(P multipv-k of played move) if in top-3, else −cp(P′ best)
 */

import { Chess } from "chess.js";

/** Engine score in UCI terms. mate = plies to mate, from side-to-move's view. */
export interface Score {
  cp?: number;
  mate?: number;
}

export type Category =
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "brilliant"
  | "great"
  | "missedwin"
  /** a book move: the position is in the opening database */
  | "opening";

/** Rating assumed when neither player's rating is available. */
export const DEFAULT_RATING = 1500;

/** Flip a side-to-move score to the opposite side's perspective. */
export function flipScore(s: Score): Score {
  return s.mate != null ? { mate: -s.mate } : { cp: -(s.cp ?? 0) };
}

/**
 * Convert a UCI move line to SAN from `fen`, max `maxMoves` moves.
 * Stops early on an illegal move or game end. Pure helper for display.
 */
export function uciLineToSan(fen: string, pvUci: string[], maxMoves = 4): string[] {
  const out: string[] = [];
  try {
    const c = new Chess(fen);
    for (const uci of pvUci) {
      if (out.length >= maxMoves) break;
      const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
      if (!mv) break;
      out.push(mv.san);
      if (c.isGameOver()) break;
    }
  } catch {
    // illegal move in line - return what we have so far
  }
  return out;
}

/** One engine line of a position, from that position's side-to-move view. */
export interface MultiLine {
  uci: string;
  /** mate-mapped centipawns */
  cp: number;
  /** raw engine score of this line (mate info kept for display) */
  score: Score;
  /** full principal variation in UCI */
  pv: string[];
}

/** Map a UCI score to the bounded cp scale used for classification. */
export function scoreToClassifyCp(score: Score | null | undefined): number {
  if (!score) return 0;
  if (score.mate != null) {
    const n = Math.abs(score.mate);
    const v = n <= 1 ? 2000 : n === 2 ? 1500 : 1000;
    return score.mate > 0 ? v : -v;
  }
  return score.cp ?? 0;
}

/** Expected-points-lost model (used for move categories). */
export function expectedLoss(deltaCp: number, rating: number): number {
  const factor = Math.min(1.5, Math.max(0.4, rating / 2200));
  return Math.tanh(0.002 * deltaCp * factor);
}

/**
 * Per-move accuracy (0..100) from the centipawns lost versus the engine's
 * best move (mover's view) - i.e. "how far from the engine" you were:
 *
 *   acc(Δ) = 100 − 90 · (1 − e^(−Δ/k)),   k = 105 · clamp(rating/1200, 0.85, 1.15)
 *
 * acc(0) = 100, floor 10. Mild rating scaling: the same swing is penalised
 * slightly more for lower-rated players (the reference categories get
 * stricter as rating drops).
 *
 * Calibrated against a real ~1200-level game (Mamox43 1190 vs YSLdot 1186,
 * 60 moves): the reference review scored 78.1 / 86.7, this curve 76.7 / 88.2.
 * Earlier attempts (raw 100−loss, then category-anchored bands) both ran
 * ~10 points above the reference on the same game.
 */
export function moveAccuracy(deltaCp: number, rating = 1200): number {
  const k = 105 * Math.min(1.15, Math.max(0.85, rating / 1200));
  return 100 - 90 * (1 - Math.exp(-Math.max(0, deltaCp) / k));
}

/**
 * Per-player accuracy from a list of moves (see moveAccuracy). Book moves
 * (category "opening") count as perfect - they can't be mistakes.
 * "Multiple blunders" smoothing: each extra blunder counts at half the
 * penalty of the previous one (2nd × 0.5, 3rd × 0.25, …).
 */
export interface AccMove {
  color: "w" | "b";
  delta: number | null;
  category: Category | null;
}

export interface AccResult {
  value: number | null;
  moves: number;
}

export function accuracyFromMoves(
  moves: AccMove[],
  ratings: { w?: number; b?: number } | null | undefined,
): { w: AccResult; b: AccResult } {
  const out: { w: AccResult; b: AccResult } = {
    w: { value: null, moves: 0 },
    b: { value: null, moves: 0 },
  };
  for (const color of ["w", "b"] as const) {
    let total = 0;
    let n = 0;
    let blunders = 0;
    for (const m of moves) {
      if (m.color !== color || m.delta == null) continue;
      if (m.category === "opening") {
        total += 100;
        n++;
        continue;
      }
      const acc = moveAccuracy(m.delta, ratingFor(ratings, color));
      total += m.category === "blunder" ? 100 - (100 - acc) * Math.pow(0.5, blunders++) : acc;
      n++;
    }
    out[color] = n === 0 ? { value: null, moves: 0 } : { value: Math.round(total / n), moves: n };
  }
  return out;
}

/** Core category from expected points lost (0..1). */
export function coreCategory(loss: number): Category {
  if (loss <= 0) return "best";
  if (loss <= 0.02) return "excellent";
  if (loss <= 0.05) return "good";
  if (loss <= 0.1) return "inaccuracy";
  if (loss <= 0.2) return "mistake";
  return "blunder";
}

/**
 * Hard-to-refute check for the brilliancy condition. `childMulti`/`childBest`
 * are from the opponent's (side-to-move-in-child) perspective.
 */
export function isHardToRefute(childMulti: MultiLine[], childBest: Score | null | undefined): boolean {
  // mover has a forced mate (side to move in the child is mated)
  if ((childBest?.mate ?? 0) < 0) return true;
  if (childMulti.length === 0) return false;
  const r1 = childMulti[0].cp; // opponent's best reply, opponent's view
  if (r1 > 0) return false; // best reply already gives the opponent an edge
  // narrow defense: at most two of the top-3 replies within 50cp of the best
  return childMulti.filter((r) => r.cp >= r1 - 50).length <= 2;
}

export interface MoveClassifyInput {
  /** top-3 lines of the position BEFORE the move, mover's perspective */
  prevMulti: MultiLine[];
  playedUci: string;
  /** best (multipv 1) score of the position AFTER the move (opponent's view) */
  childBest: Score;
  /** top-3 lines of the child position, opponent's perspective */
  childMulti: MultiLine[];
  /** classification of the opponent's move that led into the previous position */
  prevCategory: Category | null;
  /** the mover's rating (expected-loss scaling) */
  rating: number;
  /** piece values: moved piece vs captured piece (0 when nothing captured) */
  movedValue: number;
  capturedValue: number;
}

export interface MoveClassification {
  category: Category;
  /** expected points lost, 0..1 */
  loss: number;
  /** centipawns lost vs best (rounded) */
  delta: number;
}

export function classifyMove(input: MoveClassifyInput): MoveClassification {
  const bestCp = input.prevMulti[0]?.cp ?? 0;
  const idx = input.prevMulti.findIndex((l) => l.uci === input.playedUci);
  const isBest = idx === 0;
  const playedCp = idx >= 0 ? input.prevMulti[idx].cp : -scoreToClassifyCp(input.childBest);
  const delta = Math.max(0, Math.abs(bestCp - playedCp));
  const loss = expectedLoss(delta, input.rating);
  let category = coreCategory(loss);

  const isSacrifice = input.capturedValue > 0 && input.movedValue > input.capturedValue;
  if (
    isSacrifice &&
    loss <= 0.1 &&
    bestCp < 400 &&
    isHardToRefute(input.childMulti, input.childBest)
  ) {
    category = "brilliant";
  } else if (isBest) {
    const second = input.prevMulti[1]?.cp;
    if (second != null && bestCp - second > 80) category = "great";
  } else if (
    (input.prevCategory === "mistake" || input.prevCategory === "blunder") &&
    loss >= 0.15
  ) {
    category = "missedwin";
  }

  return { category, loss, delta: Math.round(delta) };
}

/**
 * Mover's rating for expected-loss scaling: own rating, else the
 * opponent's, else the default.
 */
export function ratingFor(
  ratings: { w?: number; b?: number } | null | undefined,
  side: "w" | "b",
): number {
  const own = ratings?.[side];
  if (typeof own === "number") return own;
  const opp = ratings?.[side === "w" ? "b" : "w"];
  if (typeof opp === "number") return opp;
  return DEFAULT_RATING;
}

const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/**
 * Piece values of a UCI move in a FEN position. Returns zeros when the move
 * is illegal in the position (caller then simply gets "no sacrifice").
 */
export function sacrificeValues(
  fen: string,
  uci: string,
): { movedValue: number; capturedValue: number } {
  let movedValue = 0;
  let capturedValue = 0;
  try {
    const chess = new Chess(fen);
    const mv = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    if (mv) {
      movedValue = PIECE_VALUES[mv.piece] ?? 0;
      capturedValue = mv.captured ? PIECE_VALUES[mv.captured] ?? 0 : 0;
    }
  } catch {
    // invalid position or move - no sacrifice detected
  }
  return { movedValue, capturedValue };
}

/**
 * Top-3 engine lines of a search result as MultiLines (side-to-move view,
 * mate-mapped). Structural input so this module stays free of a stockfish.ts
 * import (stockfish already imports Score from here).
 */
export function multipvToMultiLines(
  lines: ReadonlyArray<{ score: Score; pv: string[] }>,
): MultiLine[] {
  return lines
    .map((l) => ({ uci: l.pv[0] ?? "", cp: scoreToClassifyCp(l.score), score: l.score, pv: l.pv }))
    .filter((l) => l.uci.length > 0);
}

/** True when the category renders a visible symbol (incl. the SVG thumbs-up). */
export function hasSymbol(cat: Category | null | undefined): boolean {
  return cat === "excellent" || cat === "opening" || symbol(cat) !== "";
}

export function symbol(cat: Category | null | undefined): string {
  switch (cat) {
    case "brilliant":
      return "!!";
    case "great":
      return "!";
    case "best":
      // ★ star - mono glyph, green
      return "★";
    case "excellent":
      // rendered as a mono SVG by <CategorySymbol/> (the 👍 emoji has no
      // reliable monochrome text presentation in browsers); no text glyph
      return "";
    case "good":
      // ✓ tick - light green
      return "\u2713";
    case "opening":
      // rendered as a mono SVG (book) by <CategorySymbol/> - no mono
      // book glyph exists in Unicode text
      return "";
    case "inaccuracy":
      return "!?";
    case "mistake":
      return "?";
    case "blunder":
      return "??";
    case "missedwin":
      // red X
      return "\u2715";
    default:
      return "";
  }
}

/**
 * Semantic text-colour class for a move category. The actual colours live
 * in index.css as theme variables (cat-* classes), so the same class reads
 * correctly on both the dark and the light theme.
 */
export function categoryColorClass(cat: Category | null | undefined): string {
  switch (cat) {
    case "brilliant":
      return "cat-brilliant"; // strong deep blue, deeper than great's sky
    case "best":
    case "excellent":
      return "cat-best";
    case "great":
      return "cat-great";
    case "good":
      return "cat-good"; // lighter green than best/excellent
    case "opening":
      return "cat-opening"; // shade of brown, book moves
    case "inaccuracy":
      return "cat-inaccuracy";
    case "mistake":
      return "cat-mistake";
    case "blunder":
    case "missedwin":
      return "cat-blunder";
    default:
      return "";
  }
}

/** Opaque, lighter version of the category color - board badge circle background. */
export function categoryBgClass(cat: Category | null | undefined): string {
  switch (cat) {
    case "brilliant":
      return "bg-blue-200";
    case "best":
    case "excellent":
    case "good":
      return "bg-emerald-200";
    case "great":
      return "bg-sky-200";
    case "inaccuracy":
      return "bg-yellow-200";
    case "mistake":
      return "bg-orange-200";
    case "blunder":
    case "missedwin":
      return "bg-red-200";
    case "opening":
      // light tan / brown
      return "bg-amber-200";
    default:
      return "";
  }
}

/** Darker version of the category color - badge symbol on the light background. */
export function categoryDarkClass(cat: Category | null | undefined): string {
  switch (cat) {
    case "brilliant":
      return "text-blue-800";
    case "best":
    case "excellent":
    case "good":
      return "text-emerald-800";
    case "great":
      return "text-sky-800";
    case "inaccuracy":
      return "text-yellow-800";
    case "mistake":
      return "text-orange-800";
    case "blunder":
    case "missedwin":
      return "text-red-800";
    case "opening":
      // dark brown on the tan badge background
      return "text-amber-900";
    default:
      return "text-white";
  }
}

/**
 * Format a score for display, always from White's perspective.
 * `sideToMove` is the side to move in the position the score refers to.
 */
export function formatEval(score: Score | null | undefined, sideToMove: "w" | "b"): string {
  if (!score) return "-";
  let mate: number | undefined;
  let cp = 0;
  if (score.mate != null) {
    mate = sideToMove === "w" ? score.mate : -score.mate;
  } else {
    cp = (score.cp ?? 0) * (sideToMove === "w" ? 1 : -1);
  }
  if (mate != null) {
    const moves = Math.max(1, Math.ceil(Math.abs(mate) / 2));
    return mate > 0 ? `M${moves}` : `−M${moves}`;
  }
  const pawns = cp / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(1)}`;
}

/** White's win percentage 0..100 for the eval bar. */
export function evalWhitePct(score: Score | null | undefined, sideToMove: "w" | "b"): number {
  if (!score) return 50;
  if (score.mate != null) {
    const whiteMates = sideToMove === "w" ? score.mate : -score.mate;
    return whiteMates > 0 ? 100 : 0;
  }
  const cp = (score.cp ?? 0) * (sideToMove === "w" ? 1 : -1);
  return 50 + 50 * (2 / (1 + Math.exp(-cp / 350)) - 1);
}
