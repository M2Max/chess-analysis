/**
 * Per-game analysis cache - stored in the server's SQLite database (see
 * server/db.ts), one entry per game = the strongest combo ever produced:
 *
 *   lite+fast < full+fast < lite+deep < full+deep
 *
 * After a full analysis the mainline results (per-move category/delta/loss,
 * score, best move and the top-3 MultiPV lines) are stored under the game id
 * so that:
 *  - the game list shows both players' accuracy + which engine combo
 *    produced them (the list endpoint decorates each game with this meta);
 *  - re-opening an already-analysed game hydrates instantly and skips the
 *    engine entirely when the cached combo is at least as strong as the one
 *    currently selected.
 *
 * The rank guard lives server-side (saveAnalysisForGame): a stored analysis
 * is only replaced by an equal or stronger combo.
 */
import type { EngineKind, AnalysisMode } from "../engine/config";
import { scoreToClassifyCp, type Category, type Score } from "../engine/classify";
import type { Opening } from "./openings";

export interface CachedLine {
  /** first move of the line (UCI) */
  uci: string;
  /** raw engine score of the line (side-to-move view) */
  score: Score;
  /** the line in UCI (truncated when cached) */
  pv: string[];
}

export interface CachedMove {
  san: string;
  uci: string;
  color: "w" | "b";
  /** centipawns lost vs the best move (mover's view) */
  delta: number;
  /** expected points lost (0..1) */
  loss: number;
  category: Category;
  bestUci: string | null;
  bestSan: string | null;
  /** score of the position AFTER the move (side-to-move of the opponent) */
  score: Score | null;
  /** top-3 lines of the position after the move */
  multi: CachedLine[];
}

export interface CachedAnalysis {
  v: 2;
  engine: EngineKind;
  mode: AnalysisMode;
  savedAt: number;
  whiteAcc: number | null;
  blackAcc: number | null;
  /** recognised opening (null when the game never entered the book) */
  opening: Opening | null;
  moves: CachedMove[];
}

/**
 * Hydrate a cached move's MultiPV lines into the review state's line shape
 * (adds the classify-ready `cp` view of the score).
 */
export function cachedMultiToLines(multi: CachedLine[]) {
  return multi.map((l) => ({
    uci: l.uci,
    cp: scoreToClassifyCp(l.score),
    score: l.score,
    pv: l.pv,
  }));
}

/** lite+fast < full+fast < lite+deep < full+deep (client-side mirror of the server guard) */
export function comboRank(engine: EngineKind, mode: AnalysisMode): number {
  switch (`${engine}:${mode}`) {
    case "lite:fast":
      return 0;
    case "full:fast":
      return 1;
    case "lite:deep":
      return 2;
    case "full:deep":
      return 3;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// HTTP client (server SQLite)
// ---------------------------------------------------------------------------

/** The stored analysis of a game, or null when none exists. */
export async function fetchAnalysis(gameId: string): Promise<CachedAnalysis | null> {
  try {
    const res = await fetch(`/api/db/games/${encodeURIComponent(gameId)}/analysis`);
    if (!res.ok) return null; // 404 = never analysed
    return (await res.json()) as CachedAnalysis;
  } catch {
    return null; // server offline (dev without bun server) → treat as uncached
  }
}

/**
 * Store a game's analysis. The server keeps it only when it ranks at least
 * as high as the stored one; `false` = kept the existing (stronger) entry.
 * Never throws - persistence must not break the review.
 */
export async function putAnalysis(gameId: string, entry: CachedAnalysis): Promise<boolean> {
  try {
    const res = await fetch(`/api/db/games/${encodeURIComponent(gameId)}/analysis`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { stored: boolean }).stored;
  } catch {
    return false;
  }
}
