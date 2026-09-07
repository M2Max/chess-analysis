/**
 * Wire shape of the stats rows served by the server (see
 * `StatsGameRow` in server/db.ts - kept in sync; the client cannot import
 * the server module because it pulls in bun:sqlite).
 */
export interface StatsGameRow {
  id: string;
  utc: number;
  result: string;
  timeClass: string;
  timeControl: string;
  whiteUsername: string;
  blackUsername: string;
  whiteRating: number | null;
  blackRating: number | null;
  youWhite: boolean;
  /** the game has ANY analysis (any combo) - the stats run skips those */
  analyzed: boolean;
  opening: { eco: string; name: string; depth: number } | null;
  whiteAcc: number | null;
  blackAcc: number | null;
  /** raw PGN (clocks / termination for the improvement analytics) */
  pgn: string;
  /** per-move rows of the stored analysis (mover view), when analyzed */
  moves: {
    ply: number;
    color: "w" | "b";
    san: string;
    delta: number;
    category: string;
    bestUci: string | null;
    bestSan: string | null;
    /** exactly one of scoreCp/scoreMate is set (side-to-move view) */
    scoreCp: number | null;
    scoreMate: number | null;
    /** mate distance of the engine's best line (line 1) at this position */
    bestMate: number | null;
  }[];
}
