/**
 * Win/Draw/Loss model - a faithful port of Stockfish's official WDL model
 * (src/uci.cpp win_rate_params/win_rate_model, coefficients as of SF 17/18;
 * see github.com/official-stockfish/WDL_model).
 *
 * SF >= 17 displays NORMALIZED pawn units: displayed cp x = 100 * v / a,
 * where v is the internal value and a = p_a(material). So the internal
 * value behind a DISPLAYED centipawn score is v = x * a / 100, and
 *   win_rate(v) = 1 / (1 + exp((a - v) / b))
 * with the cubic polynomials below, evaluated at m = clamp(material,17,78)/58.
 *
 * material = P + 3N + 3B + 5R + 9Q summed over BOTH sides (starts at 78).
 */

export interface Wdl {
  /** White win probability 0..1 */
  w: number;
  /** draw probability 0..1 */
  d: number;
  /** Black win probability 0..1 */
  l: number;
  /** White expected game points 0..1 (win + draw/2) */
  exp: number;
}

const AS = [-142.72052667, 372.35176398, -340.71073572, 415.23490212];
const BS = [5.93832785, 15.61267078, -30.57816876, 69.63866711];

/** 1/(1+exp((a-v)/b)) - Stockfish's win-rate logistic for internal value v. */
function winRate(v: number, a: number, b: number): number {
  return 1 / (1 + Math.exp((a - v) / b));
}

/**
 * WDL for a position with the given DISPLAYED evaluation (centipawns,
 * White's view) and material count (P + 3N + 3B + 5R + 9Q, both sides).
 * Mate scores never reach this function: callers map them to ±1/0/0.
 */
export function wdl(cpWhiteView: number, material: number): Wdl {
  const m = Math.min(78, Math.max(17, material)) / 58.0;
  const a = ((AS[0] * m + AS[1]) * m + AS[2]) * m + AS[3];
  const b = ((BS[0] * m + BS[1]) * m + BS[2]) * m + BS[3];
  const v = (cpWhiteView * a) / 100; // displayed cp -> internal units
  const w = winRate(v, a, b);
  const l = winRate(-v, a, b);
  const d = Math.max(0, 1 - w - l);
  return { w, d, l, exp: w + d / 2 };
}

/**
 * Expected game points (0..1) for White at the given displayed evaluation -
 * the smooth "what should happen here" curve, material-aware.
 * Mate shortcut: |mate| present is a decided game (1 or 0).
 */
export function expectedPoints(cpWhiteView: number, material: number): number {
  return wdl(cpWhiteView, material).exp;
}

/**
 * Material count (P + 3N + 3B + 5R + 9Q) from a FEN placement row set.
 */
export function materialOf(fen: string): number {
  let mat = 0;
  for (const ch of fen.split(" ")[0] ?? "") {
    switch (ch) {
      case "P":
      case "p":
        mat += 1;
        break;
      case "N":
      case "n":
      case "B":
      case "b":
        mat += 3;
        break;
      case "R":
      case "r":
        mat += 5;
        break;
      case "Q":
      case "q":
        mat += 9;
        break;
      default:
        break;
    }
  }
  return mat;
}

/** Non-pawn material (3N + 3B + 5R + 9Q, both sides) - phase detection. */
export function nonPawnMaterialOf(fen: string): number {
  let mat = 0;
  let queens = 0;
  for (const ch of fen.split(" ")[0] ?? "") {
    switch (ch) {
      case "N":
      case "n":
      case "B":
      case "b":
        mat += 3;
        break;
      case "R":
      case "r":
        mat += 5;
        break;
      case "Q":
      case "q":
        mat += 9;
        queens += 1;
        break;
      default:
        break;
    }
  }
  // queens off: count minors instead of raw material for the second rule
  if (queens === 0) {
    let minors = 0;
    for (const ch of fen.split(" ")[0] ?? "") {
      if (ch === "N" || ch === "n" || ch === "B" || ch === "b") minors += 1;
    }
    if (minors <= 2) return 0; // endgame by the "queens off, <=2 minors" rule
  }
  return mat;
}
