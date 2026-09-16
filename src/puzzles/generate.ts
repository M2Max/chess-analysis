/**
 * Puzzle generation orchestrator (docs/FEATURE-PUZZLES.md §7): client-driven,
 * resumable. Extraction is a pure pass over the cached analyses (zero engine
 * cost); candidates persist immediately as 'pending', then a deeper WASM
 * search validates them one by one ('ready' | 'rejected'). Cancellable via
 * shouldStop(); re-running never redoes work (server dedups + statuses).
 */
import { fetchAnalysis } from "../api/analysisCache";
import type { Game } from "../api/games";
import {
  fetchPuzzles,
  fetchPuzzlesMeta,
  resolvePuzzleApi,
  savePuzzleBatch,
  type NewPuzzleInput,
} from "../api/reviewDb";
import { Chess } from "chess.js";
import { parsePgn } from "../engine/parse";
import type { AnalysisResult } from "../engine/stockfish";
import { extractCandidates, PUZZLE_T } from "./model";
import { forcedNext, validateVerdict } from "./validate";

/** injectable deeper search (engine.analyze in the app, a stub in tests) */
export type AnalyzeFn = (fen: string) => Promise<AnalysisResult>;

export interface GenerateProgress {
  phase: "extract" | "validate";
  done: number;
  total: number;
}

export interface GenerateOptions {
  username: string;
  /** player's games (with pgn); newest first is nicest */
  games: Game[];
  /** public ratings drive the difficulty estimate (null = unknown) */
  baseRating: number | null;
  analyze: AnalyzeFn;
  includePunish?: boolean;
  /** hard cap on games scanned per pass */
  maxGames?: number;
  onProgress?: (p: GenerateProgress) => void;
  shouldStop?: () => boolean;
}

export interface GenerateResult {
  scanned: number;
  candidates: number;
  validated: number;
  ready: number;
  rejected: number;
  stopped: boolean;
}

function playerColorOf(game: Game, username: string): "w" | "b" | null {
  const u = username.trim().toLowerCase();
  if (game.white.username.toLowerCase() === u) return "w";
  if (game.black.username.toLowerCase() === u) return "b";
  return null;
}

const uciMove = (u: string) => ({
  from: u.slice(0, 2),
  to: u.slice(2, 4),
  promotion: u.length > 4 ? u.slice(4, 5) : undefined,
});

/**
 * Multi-move extension: while every next position stays FORCED (unique best,
 * still mating or winning), demand up to PUZZLE_T.maxSolutionMoves correct
 * user moves in a row - "show me you know where the advantage comes from".
 * `firstResult` is the validation search on `fen` (reused, no extra cost for
 * move 1). Returns the user-move sequence + the full line [u, r, u, ...].
 */
export async function extendSolution(
  analyze: AnalyzeFn,
  fen: string,
  firstResult: AnalysisResult,
): Promise<{ userUcis: string[]; pv: string[] }> {
  const step0 = forcedNext(firstResult);
  if (!step0) return { userUcis: [], pv: [] };
  const ch = new Chess(fen);
  const userUcis = [step0.userUci];
  const pv = [step0.userUci];
  try {
    ch.move(uciMove(step0.userUci));
  } catch {
    return { userUcis: [], pv: [] }; // not legal here: keep single-move as validated
  }
  if (step0.replyUci) {
    try {
      ch.move(uciMove(step0.replyUci));
      pv.push(step0.replyUci);
    } catch {
      return { userUcis, pv }; // line ends right after our move (mate): fine
    }
  } else {
    return { userUcis, pv };
  }
  while (userUcis.length < PUZZLE_T.maxSolutionMoves) {
    if (ch.isGameOver() || ch.isDraw()) break;
    let r: AnalysisResult;
    try {
      r = await analyze(ch.fen());
    } catch {
      break; // engine hiccup: stop extending, what we have is still sound
    }
    const step = forcedNext(r);
    if (!step) break; // not forced anymore (or no longer winning): single-move from here
    try {
      ch.move(uciMove(step.userUci));
    } catch {
      break;
    }
    userUcis.push(step.userUci);
    pv.push(step.userUci);
    if (!step.replyUci) break; // mates / line ends on our move
    try {
      ch.move(uciMove(step.replyUci));
      pv.push(step.replyUci);
    } catch {
      break;
    }
  }
  return { userUcis, pv };
}

export async function generatePuzzles(opts: GenerateOptions): Promise<GenerateResult> {
  const stop = () => opts.shouldStop?.() === true;
  const res: GenerateResult = {
    scanned: 0,
    candidates: 0,
    validated: 0,
    ready: 0,
    rejected: 0,
    stopped: false,
  };

  // ---- phase 1: extraction (pure, instant per game) ----------------------
  const meta = await fetchPuzzlesMeta(opts.username);
  const known = new Set(meta.gameIds);
  const todo = opts.games.filter((g) => !known.has(g.id)).slice(0, opts.maxGames ?? 500);
  opts.onProgress?.({ phase: "extract", done: 0, total: todo.length });
  for (const game of todo) {
    if (stop()) {
      res.stopped = true;
      break;
    }
    try {
      const cached = await fetchAnalysis(game.id);
      if (cached) {
        const color = playerColorOf(game, opts.username);
        let parsed = null;
        try {
          parsed = parsePgn(game.pgn);
        } catch {
          parsed = null;
        }
        if (color && parsed) {
          const cands = extractCandidates({
            gameId: game.id,
            parsed,
            cached,
            playerColor: color,
            baseRating: opts.baseRating,
            includePunish: opts.includePunish,
          });
          if (cands.length > 0) {
            const rows: NewPuzzleInput[] = cands.map((c) => ({
              gameId: c.gameId,
              ply: c.ply,
              fen: c.fen,
              side: c.side,
              solutionUci: c.solutionUci,
              solutionSan: c.solutionSan,
              mateLen: c.mateLen,
              theme: c.theme,
              pv: c.pv,
              punish: c.punish,
              ratingEst: c.ratingEst,
            }));
            res.candidates += await savePuzzleBatch(opts.username, rows);
          }
        }
      }
    } catch {
      // one broken game must never abort the whole pass
    }
    res.scanned += 1;
    opts.onProgress?.({ phase: "extract", done: res.scanned, total: todo.length });
  }

  // ---- phase 2: validation (one deeper search per candidate) -------------
  if (!res.stopped) {
    const pending = await fetchPuzzles(opts.username, ["pending"]);
    opts.onProgress?.({ phase: "validate", done: 0, total: pending.length });
    for (const p of pending) {
      if (stop()) {
        res.stopped = true;
        break;
      }
      try {
        const analysis = await opts.analyze(p.fen);
        const verdict = validateVerdict(analysis, p.fen, p.solutionUci);
        if (verdict.ok) {
          // extend to 2-3 user moves when the whole line stays forced
          const ext = await extendSolution(opts.analyze, p.fen, analysis).catch(() => ({
            userUcis: [] as string[],
            pv: [] as string[],
          }));
          await resolvePuzzleApi(p.id, true, null, {
            solutionSan: verdict.solutionSan,
            mateLen: verdict.mateLen,
            theme: verdict.theme,
            solutionUcis: ext.userUcis.length > 1 ? ext.userUcis : null,
            pv: ext.pv.length >= 2 ? ext.pv : undefined,
          });
          res.ready += 1;
        } else {
          await resolvePuzzleApi(p.id, false, verdict.reason);
          res.rejected += 1;
        }
      } catch {
        // engine hiccup: leave it pending, the next pass retries
      }
      res.validated += 1;
      opts.onProgress?.({ phase: "validate", done: res.validated, total: pending.length });
    }
  }

  return res;
}
