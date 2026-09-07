/**
 * Extras we can extract from the raw PGN without any engine: per-move
 * clocks ({[%clk …]} comments, always present on chess.com games), the
 * [Termination] tag, and a lightweight chess.js replay producing the
 * material / FEN of every position (for WDL + phase + motif detection).
 */
import { Chess } from "chess.js";
import { materialOf, nonPawnMaterialOf } from "./winprob";

// ---- clocks ---------------------------------------------------------------

export interface Clocks {
  /** initial clock in seconds (from the time_control tag, best effort) */
  initial: number;
  /** seconds spent ON the move, per ply (0 when unknown) */
  spent: number[];
  /** seconds remaining AFTER the move, per ply (0 when unknown) */
  remaining: number[];
  /** increment per move in seconds (0 when none) */
  increment: number;
}


/** Parse every {[%clk …]} comment in move order (h:mm:ss.d -> seconds). */
export function parseClks(pgn: string): number[] {
  const out: number[] = [];
  for (const m of pgn.matchAll(/%clk\s+(\d+):(\d{2})(?::(\d{2}))?(?:\.(\d+))?/g)) {
    const [, h, mm, ss, frac] = m;
    const seconds = ss != null ? Number(h) * 3600 + Number(mm) * 60 + Number(ss) : Number(h) * 60 + Number(mm) + (frac ? Number(`0.${frac}`) : 0);
    out.push(seconds);
  }
  return out;
}

/** Increment (seconds) from the time_control tag ("180+2", "300+0", "600"). */
export function parseIncrement(pgn: string): number {
  const tc = pgn.match(/^\[TimeControl "(.*?)"\]/m)?.[1] ?? "";
  const inc = tc.match(/\+(\d+)/);
  return inc ? Number(inc[1]) : 0;
}

/** Initial clock in seconds from the time_control tag. */
export function parseInitial(pgn: string): number {
  const tc = pgn.match(/^\[TimeControl "(.*?)"\]/m)?.[1] ?? "";
  const base = tc.match(/^(\d+)/);
  return base ? Number(base[1]) : 0;
}

/** Full clock picture: spent + remaining per ply (empty when no clk data). */
export function parseClocks(pgn: string): Clocks {
  const rem = parseClks(pgn);
  const increment = parseIncrement(pgn);
  const initial = parseInitial(pgn);
  const spent: number[] = [];
  for (let i = 0; i < rem.length; i++) {
    const before = i === 0 ? initial : rem[i - 1];
    // clk is recorded after the increment is added -> give it back
    const s = before - rem[i] + increment;
    spent.push(s > 0 && s < before + increment + 1 ? s : 0);
  }
  return { initial, spent, remaining: rem, increment };
}

// ---- termination -----------------------------------------------------------

export type TermKind =
  | "checkmate"
  | "resign"
  | "timeoutYou" // you flagged
  | "timeoutOpp" // they flagged
  | "agreed"
  | "abandoned"
  | "other";

/** Classify the [Termination] tag (with the username of the reviewed player). */
export function parseTermination(pgn: string, username: string): TermKind {
  const raw = (pgn.match(/^\[Termination "(.*?)"\]/m)?.[1] ?? "").toLowerCase();
  if (!raw) return "other";
  if (raw.includes("checkmate")) return "checkmate";
  if (raw.includes("agreement") || raw.includes("agreed")) return "agreed";
  if (raw.includes("abandon")) return "abandoned";
  if (raw.includes("resign")) return "resign";
  if (raw.includes("time") || raw.includes("timeout")) {
    // "Mamox43 won on time" (opponent flagged) vs "Mamox43 lost on time"
    const u = username.toLowerCase();
    const youWon = raw.includes(`${u} won`);
    const youLost = raw.includes(`${u} lost`);
    if (youLost) return "timeoutYou";
    if (youWon) return "timeoutOpp";
    // "X lost on time" -> X flagged; "X won on time" -> X's opponent flagged
    const subject = raw.split(/\s+/)[0];
    if (/\blost\b/.test(raw)) return subject === u ? "timeoutYou" : "timeoutOpp";
    return subject === u ? "timeoutOpp" : "timeoutYou";
  }
  return "other";
}

// ---- replay ------------------------------------------------------------------

export interface ReplayMeta {
  /** FEN BEFORE each ply (index = ply) */
  fens: string[];
  /** material (P+3N+3B+5R+9Q, both sides) AFTER each ply */
  materialAfter: number[];
  /** first ply whose resulting position qualifies as an endgame (null: none) */
  endPly: number | null;
}

/**
 * Replay a PGN (san moves) collecting per-position FENs and material.
 * Assumes the caller parsed the game successfully before (same moves).
 */
export function replayMeta(pgnMoves: string[]): ReplayMeta {
  const chess = new Chess();
  const fens: string[] = [];
  const materialAfter: number[] = [];
  let endPly: number | null = null;
  for (let i = 0; i < pgnMoves.length; i++) {
    fens.push(chess.fen());
    let ok = false;
    try {
      chess.move(pgnMoves[i]);
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok) break;
    const fen = chess.fen();
    materialAfter.push(materialOf(fen));
    if (endPly == null && (nonPawnMaterialOf(fen) === 0 || materialOf(fen) <= 24)) {
      endPly = i;
    }
  }
  return { fens, materialAfter, endPly };
}
