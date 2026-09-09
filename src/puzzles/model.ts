/**
 * Puzzle candidate extraction - PURE (no fetch, no engine): scans a cached
 * analysis + the parsed PGN and returns the moments worth training, i.e.
 * positions where THE PLAYER (to move) had one clear move far better than
 * what was actually played (missed wins / missed mates, including the
 * punishment of an opponent's blunder). See docs/FEATURE-PUZZLES.md.
 */
import { Chess } from "chess.js";
import type { CachedAnalysis } from "../api/analysisCache";
import type { Score } from "../engine/classify";
import type { ParsedGame } from "../engine/parse";

export interface PuzzleCandidate {
  gameId: string;
  /** 0-based ply of the player's move (the solution move) */
  ply: number;
  /** position BEFORE the solution move */
  fen: string;
  /** side to move in `fen` (= the player's colour) */
  side: "w" | "b";
  solutionUci: string;
  solutionSan: string | null;
  mateLen: number | null;
  theme: "mate" | "win";
  /** engine line (UCI), starts with the solution */
  pv: string[];
  /** true when the position arose from the opponent's blunder */
  punish: boolean;
  swingCp: number;
  ratingEst: number | null;
}

export const PUZZLE_T = {
  /** the solution must promise at least this (or mate) - filters noise */
  bestMustCp: 150,
  /** minimum eval swing best-vs-played to call it "missed" */
  minSwingCp: 250,
  /** validation: value under best defence needed to stay sound */
  soundCp: 180,
  /** validation: 2nd-best must stay this far behind (else cooked) */
  cookMarginCp: 80,
  /** long mates are usually not forced at our search depth */
  mateMaxLen: 5,
  /** keep generation cost bounded per game */
  maxPerGame: 8,
};

const MATE_CP = 100000;

/** Numeric view of a Score (side-to-move): mate dominates, cp linear. */
export function scoreCp(s: Score | null | undefined): number {
  if (!s) return 0;
  if (s.mate != null) {
    const len = Math.abs(s.mate);
    return s.mate > 0 ? MATE_CP - len * 1000 : -MATE_CP + len * 1000;
  }
  return s.cp ?? 0;
}

export function isMateScore(s: Score | null | undefined): boolean {
  return s?.mate != null && s.mate > 0;
}

export function tierFor(ratingEst: number | null): "easy" | "mid" | "hard" {
  if (ratingEst == null) return "mid";
  if (ratingEst < 1200) return "easy";
  if (ratingEst < 1800) return "mid";
  return "hard";
}

const PIECE_VAL: Record<string, number> = { p: 100, n: 300, b: 320, r: 500, q: 900, k: 0 };

/** Apply a UCI move on a copy; null when illegal (promotion -> queen). */
export function tryUci(chess: Chess, uci: string): { san: string } | null {
  try {
    const mv = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4, 5) || undefined,
    });
    return mv ? { san: mv.san } : null;
  } catch {
    return null;
  }
}

/**
 * Trivial recapture: the opponent just captured on square X and the
 * solution is an equal-value recapture on X (no mate, quiet). Such "puzzles"
 * teach nothing - the lichess generator drops them too.
 */
export function isTrivialRecapture(
  fen: string,
  solutionUci: string,
  prevMoveSan: string,
  prevMoveUci: string,
): boolean {
  if (!prevMoveSan.includes("x")) return false;
  if (prevMoveUci.slice(2, 4) !== solutionUci.slice(2, 4)) return false;
  const chess = new Chess(fen);
  const mover = chess.get(solutionUci.slice(0, 2) as never);
  const target = chess.get(solutionUci.slice(2, 4) as never);
  if (!mover || !target) return false;
  return PIECE_VAL[mover.type] === PIECE_VAL[target.type];
}

export interface ExtractOptions {
  gameId: string;
  parsed: ParsedGame;
  cached: CachedAnalysis;
  /** colour the puzzles are generated FOR */
  playerColor: "w" | "b";
  /** player's public rating (drives the difficulty estimate), null = unknown */
  baseRating: number | null;
  /** keep positions born from the opponent's blunder (default true) */
  includePunish?: boolean;
}

export function extractCandidates(opts: ExtractOptions): PuzzleCandidate[] {
  const includePunish = opts.includePunish !== false;
  const { gameId, parsed, cached, playerColor, baseRating } = opts;
  const moves = cached.moves;
  const parsedMoves = parsed.moves;
  const n = Math.min(moves.length, parsedMoves.length);
  const out: PuzzleCandidate[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < n && out.length < PUZZLE_T.maxPerGame; i++) {
    const mv = moves[i];
    if (mv.color !== playerColor) continue;
    if (mv.category === "opening") continue; // book move: not a training moment
    const prev = moves[i - 1];
    // the top-3 lines of the PREVIOUS move describe THIS position
    if (!prev?.multi?.length) continue;

    // CAREFUL: a cached move's `bestUci` belongs to the position AFTER that
    // move (= before the next one). The candidate lines for THIS position
    // live in prev.multi, and prev.multi[0].uci is that position's best
    // move - that pairing is guaranteed coherent; mv.bestUci may come from
    // a different search and can even be illegal here, so we never trust it.
    const best = prev.multi[0];
    const solutionUci = best.uci;
    if (!solutionUci || solutionUci === mv.uci) continue; // found it / no data

    const bestCp = scoreCp(best.score);
    const bestMate = isMateScore(best.score);
    const playedLine = prev.multi.find((l) => l.uci === mv.uci);
    // cached[i].score is the position AFTER the move (opponent's view)
    const playedCp = playedLine ? scoreCp(playedLine.score) : mv.score ? -scoreCp(mv.score) : 0;
    const swing = bestCp - playedCp;

    if (!bestMate && bestCp < PUZZLE_T.bestMustCp) continue;
    if (!bestMate && swing < PUZZLE_T.minSwingCp) continue;

    const fen = parsedMoves[i].fenBefore;
    const chess = new Chess(fen);
    if (chess.turn() !== playerColor) continue; // defensive: data drift
    const sol = tryUci(chess, solutionUci);
    if (!sol) continue; // engine line not legal here (stale cache) -> skip

    const prevParsed = parsedMoves[i - 1];
    if (
      prevParsed &&
      isTrivialRecapture(fen, solutionUci, moves[i - 1].san, prevParsed.uci)
    ) {
      continue;
    }

    const punish = prev.category === "blunder" && prev.color !== playerColor;
    if (punish && !includePunish) continue;

    // rough difficulty: swing size (mate swings clamped - they are huge by
    // construction) + mate length + "quiet move" bonus
    const quiet = !sol.san.includes("x") && !sol.san.includes("+") && !sol.san.includes("#");
    const swingEff = Math.min(swing, 1500);
    const ratingEst =
      baseRating != null
        ? Math.max(
            600,
            Math.min(
              2800,
              Math.round(
                baseRating +
                  swingEff / 10 +
                  (bestMate ? (Math.min(Math.abs(best.score.mate!), PUZZLE_T.mateMaxLen) - 1) * 90 + 90 : 0) +
                  (quiet ? 70 : 0),
              ),
            ),
          )
        : null;

    const key = `${fen}|${solutionUci}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      gameId,
      ply: i,
      fen,
      side: playerColor,
      solutionUci,
      solutionSan: sol.san,
      mateLen: bestMate ? Math.abs(best.score.mate!) : null,
      theme: bestMate ? "mate" : "win",
      pv: best.pv?.length ? best.pv.slice(0, 9) : [solutionUci],
      punish,
      swingCp: swing,
      ratingEst,
    });
  }
  return out;
}
