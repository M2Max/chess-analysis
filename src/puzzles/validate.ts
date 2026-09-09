/**
 * Puzzle validation - the quality gate (docs/FEATURE-PUZZLES.md §4).
 * Pure decision (`validateVerdict`, stub-testable) around one deeper engine
 * search performed by the caller: soundness vs best defence, UNIQUE best
 * first move (cooked puzzles are discarded), mate length and pv legality.
 */
import { Chess } from "chess.js";
import type { AnalysisResult } from "../engine/stockfish";
import { isMateScore, PUZZLE_T, scoreCp } from "./model";

export type RejectReason = "cooked" | "unsound" | "stale";

export type Verdict =
  | {
      ok: true;
      solutionUci: string;
      solutionSan: string | null;
      mateLen: number | null;
      theme: "mate" | "win";
      /** depth the engine reached on the solution line */
      depth: number;
    }
  | { ok: false; reason: RejectReason };

/**
 * Judge one validation search. `res` must be a deeper search on `fen` with
 * MultiPV >= 2 (the uniqueness check needs the runner-up). The solution is
 * accepted ONLY if it is still the engine's unique best first move.
 */
export function validateVerdict(res: AnalysisResult, fen: string, solutionUci: string): Verdict {
  const lines = res.multipv?.length ? res.multipv : res.info ? [res.info] : [];
  const best = lines[0];
  if (!best || best.pv.length === 0) return { ok: false, reason: "stale" };

  // the deeper search must agree on the exact first move
  if (best.pv[0] !== solutionUci) return { ok: false, reason: "cooked" };

  const bestMate = isMateScore(best.score);
  if (!bestMate && scoreCp(best.score) < PUZZLE_T.soundCp) return { ok: false, reason: "unsound" };
  if (bestMate && Math.abs(best.score.mate!) > PUZZLE_T.mateMaxLen) return { ok: false, reason: "unsound" };

  // uniqueness: no equally-good alternative first move
  const second = lines[1];
  if (second && second.pv.length > 0) {
    if (bestMate) {
      const secondMate = isMateScore(second.score);
      if (secondMate && Math.abs(second.score.mate!) - Math.abs(best.score.mate!) <= 1) {
        return { ok: false, reason: "cooked" };
      }
    } else if (scoreCp(best.score) - scoreCp(second.score) < PUZZLE_T.cookMarginCp) {
      return { ok: false, reason: "cooked" };
    }
  }

  // pv legality sanity (a stale line must never reach the solve animation)
  try {
    const ch = new Chess(fen);
    for (const u of best.pv.slice(0, 9)) {
      if (ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4, 5) || undefined }) == null) {
        return { ok: false, reason: "stale" };
      }
      if (ch.isGameOver()) break;
    }
  } catch {
    return { ok: false, reason: "stale" };
  }

  let solutionSan: string | null = null;
  try {
    const ch = new Chess(fen);
    solutionSan =
      ch.move({
        from: solutionUci.slice(0, 2),
        to: solutionUci.slice(2, 4),
        promotion: solutionUci.slice(4, 5) || undefined,
      })?.san ?? null;
  } catch {
    solutionSan = null;
  }

  return {
    ok: true,
    solutionUci,
    solutionSan,
    mateLen: bestMate ? Math.abs(best.score.mate!) : null,
    theme: bestMate ? "mate" : "win",
    depth: best.depth,
  };
}
