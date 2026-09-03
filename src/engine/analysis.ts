/**
 * Full-game analysis pipeline.
 *
 * Analyses all N+1 positions (start + after every move) sequentially on the
 * engine, reporting each position as soon as it completes so the UI fills in
 * evals incrementally. Each search runs with MultiPV=3, so a move's
 * classification (expected-loss model, see classify.ts) is known as soon as
 * the position after it has been evaluated - the move's own line may come
 * from the top-3, and the child's top-3 feeds the brilliancy check.
 */

import { Chess } from "chess.js";
import {
  classifyMove,
  multipvToMultiLines,
  ratingFor,
  sacrificeValues,
  type Category,
  type MoveClassification,
  type MultiLine,
  type Score,
} from "./classify";
import { uciToSan, type ParsedGame } from "./parse";
import type { Engine } from "./stockfish";

/**
 * Terminal positions produce no `info ... score` line (bestmove 0000).
 * Synthesize a result so the pipeline can classify the final move.
 */
export function terminalResult(fen: string, bestMove: string): PositionResult | null {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) {
    // side to move is mated → worst possible score from their view
    return { score: { mate: -1 }, bestUci: "0000", bestSan: null, pv: [], depth: 0, multi: [] };
  }
  if (chess.isStalemate() || chess.isDraw()) {
    return { score: { cp: 0 }, bestUci: bestMove || "0000", bestSan: null, pv: [], depth: 0, multi: [] };
  }
  return null;
}

export interface PositionResult {
  score: Score;
  bestUci: string;
  bestSan: string | null;
  pv: string[];
  depth: number;
  /** top-3 lines from this position's side-to-move view (mate-mapped cp) */
  multi: MultiLine[];
}

export interface AnalysisCallbacks {
  /** Position `index` (0-based; 0 = start) finished. */
  onPositionDone: (index: number, res: PositionResult) => void;
  /** Move `moveIndex` (0-based) classified. */
  onMoveClassified: (moveIndex: number, cls: MoveClassification) => void;
  onProgress: (done: number, total: number) => void;
  onDone: () => void;
}

export interface AnalyzeGameOptions {
  signal: AbortSignal;
  movetimeMs: number;
  /** both players' ratings (expected-loss scaling per mover) */
  ratings?: { w?: number; b?: number };
  /**
   * plies covered by the opening book (moves 0..openingDepth-1 are
   * classified "opening" instead of their loss-based category; the eval and
   * delta are still computed as usual)
   */
  openingDepth?: number;
  cb: AnalysisCallbacks;
}

export async function analyzeGame(
  engine: Engine,
  parsed: ParsedGame,
  opts: AnalyzeGameOptions,
): Promise<void> {
  const fens = [parsed.startFen, ...parsed.moves.map((m) => m.fenAfter)];
  const total = fens.length;
  const results: PositionResult[] = [];
  const movetime = opts.movetimeMs;
  let prevCategory: Category | null = null;

  for (let i = 0; i < total; i++) {
    if (opts.signal.aborted) return;

    const res = await engine.analyze(fens[i], { movetimeMs: movetime });
    if (opts.signal.aborted) return;

    const multi = multipvToMultiLines(res.multipv);
    const term = res.info ? null : terminalResult(fens[i], res.bestMove);
    if (!res.info && !term) {
      throw new Error(`Engine produced no evaluation at position ${i}`);
    }
    const pr: PositionResult = res.info
      ? {
          score: res.info.score,
          bestUci: res.bestMove,
          bestSan: uciToSan(fens[i], res.bestMove) ?? null,
          pv: res.info.pv,
          depth: res.info.depth,
          multi,
        }
      : {
          score: term!.score,
          bestUci: term!.bestUci,
          bestSan: null,
          pv: [],
          depth: 0,
          multi: [],
        };
    results.push(pr);
    opts.cb.onPositionDone(i, pr);

    // Classify the move that led to position i (played from position i-1).
    if (i > 0) {
      const prev = results[i - 1];
      const move = parsed.moves[i - 1];
      const cls = classifyMove({
        prevMulti: prev.multi,
        playedUci: move.uci,
        childBest: pr.score,
        childMulti: pr.multi,
        prevCategory,
        rating: ratingFor(opts.ratings, move.color),
        ...sacrificeValues(fens[i - 1], move.uci),
      });
      if (opts.openingDepth != null && i - 1 < opts.openingDepth) {
        cls.category = "opening"; // book move - delta/loss still reported
      }
      prevCategory = cls.category;
      opts.cb.onMoveClassified(i - 1, cls);
    }
    opts.cb.onProgress(i + 1, total);
  }
  opts.cb.onDone();
}
