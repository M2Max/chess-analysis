import { Chess } from "chess.js";

export interface ParsedMove {
  san: string;
  uci: string;
  color: "w" | "b";
  fenBefore: string;
  fenAfter: string;
}

export interface ParsedGame {
  startFen: string;
  moves: ParsedMove[];
}

export const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export class PgnParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgnParseError";
  }
}

/** Parse standard chess PGN into per-move data incl. FENs before/after each move. */
export function parsePgn(pgn: string): ParsedGame {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch (e) {
    throw new PgnParseError(
      `Could not parse PGN: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const hist = chess.history({ verbose: true });
  if (hist.length === 0) throw new PgnParseError("Game has no moves");
  const moves: ParsedMove[] = hist.map((m, i) => ({
    san: m.san,
    uci: m.from + m.to + (m.promotion ?? ""),
    color: (i % 2 === 0 ? "w" : "b") as "w" | "b",
    fenBefore: m.before,
    fenAfter: m.after,
  }));
  return { startFen: START_FEN, moves };
}

/** SAN for a UCI move in a position; undefined when the move is illegal. */
export function uciToSan(fen: string, uci: string): string | undefined {
  if (uci.length < 4) return undefined;
  try {
    const c = new Chess(fen);
    const m = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return m ? m.san : undefined;
  } catch {
    return undefined;
  }
}
