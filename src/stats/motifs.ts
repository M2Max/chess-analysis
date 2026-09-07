/**
 * Tactical CAUSE of a bad move - a deterministic, chess.js-only classifier
 * (no engine, no neural net). This is the data behind "38% of your lost
 * points: pieces left en prise" and mirrors what chess.com Insights shows
 * as Found/Missed forks, pins, mates and hanging pieces.
 *
 * Inputs come from data we already store per move: the position before the
 * move, the played move, the engine's best move, and whether the best line
 * was mate. Priority matters: mate > time pressure > concrete tactics.
 */
import { Chess, type Square } from "chess.js";

export type Motif =
  | "mateMissed"
  | "timePressure"
  | "missedCapture"
  | "hang" // your move leaves a piece capturable with net loss
  | "fork"
  | "pin"
  | "positional"; // none of the concrete causes matched

export const MOTIF_ORDER: Motif[] = [
  "mateMissed",
  "timePressure",
  "missedCapture",
  "hang",
  "fork",
  "pin",
  "positional",
];

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

const FILES = "abcdefgh";
const ALL_SQUARES: Square[] = [];
for (const f of FILES) for (let r = 1; r <= 8; r++) ALL_SQUARES.push((f + r) as Square);

function valueAt(chess: Chess, sq: Square): number {
  const p = chess.get(sq);
  return p ? (PIECE_VALUE[p.type] ?? 0) : 0;
}

export interface MotifInput {
  /** FEN before the move */
  fenBefore: string;
  /** played move (uci) */
  playedUci: string;
  /** engine best move (uci) or null */
  bestUci: string | null;
  /** mate distance of the best line when it is a mate (null otherwise) */
  bestMateIn: number | null;
  /** seconds remaining BEFORE the move (null/0 = unknown) */
  remainingSec?: number | null;
  /** centipawns lost vs best (mover view) - threshold input only */
  deltaCp: number;
}

/** Is `sq` (owned by `def`) capturable with net material gain for the attacker? */
function isHanging(chess: Chess, sq: Square, def: "w" | "b"): boolean {
  const p = chess.get(sq);
  if (!p || p.color !== def || p.type === "k") return false;
  const atk = chess.attackers(sq, def === "w" ? "b" : "w");
  if (atk.length === 0) return false;
  const value = PIECE_VALUE[p.type] ?? 0;
  let minAtk = 100;
  for (const a of atk) minAtk = Math.min(minAtk, valueAt(chess, a) || 100);
  if (minAtk < value) return true; // cheapest attacker wins the piece outright
  const def_ = chess.attackers(sq, def);
  return atk.length > def_.length; // outnumbered
}

/** Total value of enemy pieces attacked by `from` (>=2 targets or king+X = fork). */
function attackedTargets(chess: Chess, from: Square, by: "w" | "b") {
  let total = 0;
  let targets = 0;
  let attacksKing = false;
  for (const sq of ALL_SQUARES) {
    const p = chess.get(sq);
    if (!p || p.color === by) continue;
    if (chess.attackers(sq, by).includes(from)) {
      if (p.type === "k") attacksKing = true;
      else {
        total += PIECE_VALUE[p.type] ?? 0;
        targets += 1;
      }
    }
  }
  return { total, targets, attacksKing };
}

const fileOf = (sq: string) => sq.charCodeAt(0);
const rankOf = (sq: string) => sq.charCodeAt(1);

/** Does playing `uci` (by `by`) create a pin against the enemy king? */
function createsPinToKing(chess: Chess, uci: string, by: "w" | "b"): boolean {
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const piece = chess.get(from);
  if (!piece || piece.color !== by) return false;
  const rookLike = piece.type === "r" || piece.type === "q";
  const bishopLike = piece.type === "b" || piece.type === "q";
  const dx = Math.sign(fileOf(to) - fileOf(from));
  const dy = Math.sign(rankOf(to) - rankOf(from));
  const diag = dx !== 0 && dy !== 0;
  const straight = dx === 0 !== (dy === 0);
  if (!((diag && bishopLike) || (straight && rookLike))) return false;
  const dirs = diag
    ? [
        [dx, dy],
        [dx, -dy],
        [-dx, dy],
        [-dx, -dy],
      ]
    : [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
  const scan = (sx: number, sy: number): boolean => {
    let cx = fileOf(to) + sx;
    let cy = rankOf(to) + sy;
    let first: { color: "w" | "b"; type: string } | null = null;
    while (cx >= 97 && cx <= 104 && cy >= 49 && cy <= 56) {
      const sq = String.fromCharCode(cx, cy) as Square;
      const p = chess.get(sq);
      if (p) {
        first = { color: p.color, type: p.type };
        break;
      }
      cx += sx;
      cy += sy;
    }
    if (!first || first.color === by || first.type === "k") return false;
    cx += sx;
    cy += sy;
    while (cx >= 97 && cx <= 104 && cy >= 49 && cy <= 56) {
      const sq = String.fromCharCode(cx, cy) as Square;
      const p = chess.get(sq);
      if (p) return p.type === "k" && p.color !== by; // king right behind first
      cx += sx;
      cy += sy;
    }
    return false;
  };
  return dirs.some(([sx, sy]) => scan(sx, sy));
}

/**
 * Classify the main tactical cause of a mover's bad move.
 * Cheap enough for every mistake/blunder of hundreds of games.
 */
export function classifyMotif(input: MotifInput): Motif {
  const { fenBefore, playedUci, bestUci, bestMateIn, remainingSec, deltaCp } = input;
  const chess = new Chess(fenBefore);
  const mover: "w" | "b" = chess.turn();

  // 1) the engine had mate (<= 6) and you did not play it
  if (bestMateIn != null && Math.abs(bestMateIn) <= 6 && playedUci !== bestUci) return "mateMissed";

  // 2) plain time pressure
  if (remainingSec != null && remainingSec > 0 && remainingSec < 20) return "timePressure";

  if (!bestUci || playedUci === bestUci) return "positional";

  try {
    // 3) the best move is a material capture you skipped
    const c1 = new Chess(fenBefore);
    const best = c1.move(bestUci);
    if (best?.captured && deltaCp >= 150) return "missedCapture";

    // 4) your move CREATED a hanging piece of yours (it was safe before)
    const c2 = new Chess(fenBefore);
    const pm = c2.move(playedUci);
    if (pm) {
      for (const sq of ALL_SQUARES) {
        if (isHanging(c2, sq, mover) && !isHanging(chess, sq, mover)) return "hang";
      }
    }

    if (deltaCp >= 150) {
      // 5) the best move forks two valuable targets (knight/pawn/king/queen)
      const c3 = new Chess(fenBefore);
      const bm = c3.move(bestUci);
      if (bm && ["n", "p", "k", "q"].includes(bm.piece)) {
        const t = attackedTargets(c3, bm.to, mover);
        if (t.targets >= 2 || (t.attacksKing && t.targets >= 1)) return "fork";
      }
      // 6) the best move pins a piece to the enemy king
      if (createsPinToKing(new Chess(fenBefore), bestUci, mover)) return "pin";
    }
  } catch {
    return "positional";
  }

  return "positional";
}
