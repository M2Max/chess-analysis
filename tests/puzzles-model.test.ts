/**
 * Puzzle candidate extraction (pure) - docs/FEATURE-PUZZLES.md §3.
 * Uses a real parsePgn fixture (fool's-mate material) + hand-built cached
 * analyses aligned to it.
 */
import { describe, expect, test } from "bun:test";
import { parsePgn } from "../src/engine/parse";
import type { CachedAnalysis, CachedMove } from "../src/api/analysisCache";
import {
  extractCandidates,
  isTrivialRecapture,
  scoreCp,
  tierFor,
} from "../src/puzzles/model";

// 1. f3 e6 2. g4 d5 3. a4 *  (after 2.g4?? Qh4# was there; d5?? missed it)
const PGN = `[TimeControl "600+0"]
1. f3 e6 2. g4 d5 3. a4 *`;

const parsed = parsePgn(PGN);

function m(partial: Partial<CachedMove> & Pick<CachedMove, "san" | "uci" | "color">): CachedMove {
  return {
    delta: 0,
    loss: 0,
    category: "good",
    bestUci: null,
    bestSan: null,
    score: null,
    multi: [],
    ...partial,
  };
}

function cached(moves: CachedMove[]): CachedAnalysis {
  return {
    v: 2,
    engine: "full",
    mode: "deep",
    savedAt: 0,
    whiteAcc: 60,
    blackAcc: 60,
    opening: null,
    moves,
  };
}

describe("extractCandidates", () => {
  test("missed mate after the opponent's blunder -> punish mate candidate", () => {
    const res = extractCandidates({
      gameId: "g1",
      parsed,
      cached: cached([
        m({ san: "f3", uci: "f2f3", color: "w", category: "opening" }),
        m({ san: "e6", uci: "e7e6", color: "b", category: "opening" }),
        m({
          san: "g4",
          uci: "g2g4",
          color: "w",
          category: "blunder", // the opponent hung mate in one
          multi: [
            { uci: "d8h4", score: { mate: 1 }, pv: ["d8h4"] },
            { uci: "d7d5", score: { cp: -50 }, pv: ["d7d5"] },
          ],
        }),
        m({
          san: "d5",
          uci: "d7d5",
          color: "b",
          category: "blunder",
          bestUci: "d8h4",
          bestSan: "Qh4#",
          score: { cp: 50 }, // after d5 (white's view)
        }),
        m({ san: "a4", uci: "a2a4", color: "w" }),
      ]),
      playerColor: "b",
      baseRating: 1000,
    });
    expect(res.length).toBe(1);
    const p = res[0];
    expect(p.ply).toBe(3);
    expect(p.solutionUci).toBe("d8h4");
    expect(p.solutionSan).toBe("Qh4#");
    expect(p.theme).toBe("mate");
    expect(p.mateLen).toBe(1);
    expect(p.punish).toBe(true);
    expect(p.side).toBe("b");
    expect(p.pv).toEqual(["d8h4"]);
    expect(p.ratingEst).toBeGreaterThanOrEqual(600);
    expect(p.ratingEst).toBeLessThanOrEqual(2800);
  });

  test("includePunish=false drops blunder-punishment candidates", () => {
    const base = [
      m({ san: "f3", uci: "f2f3", color: "w", category: "opening" }),
      m({ san: "e6", uci: "e7e6", color: "b", category: "opening" }),
      m({
        san: "g4",
        uci: "g2g4",
        color: "w",
        category: "blunder",
        multi: [
          { uci: "d8h4", score: { mate: 1 }, pv: ["d8h4"] },
          { uci: "d7d5", score: { cp: -50 }, pv: ["d7d5"] },
        ],
      }),
      m({ san: "d5", uci: "d7d5", color: "b", category: "blunder", bestUci: "d8h4" }),
      m({ san: "a4", uci: "a2a4", color: "w" }),
    ];
    const res = extractCandidates({
      gameId: "g1",
      parsed,
      cached: cached(base),
      playerColor: "b",
      baseRating: null,
      includePunish: false,
    });
    expect(res.length).toBe(0);
  });

  test("own missed win (quiet position) -> win candidate, punish=false", () => {
    const res = extractCandidates({
      gameId: "g2",
      parsed,
      cached: cached([
        m({ san: "f3", uci: "f2f3", color: "w", category: "opening" }),
        m({
          san: "e6",
          uci: "e7e6",
          color: "b",
          category: "good",
          multi: [
            { uci: "d2d4", score: { cp: 200 }, pv: ["d2d4", "d7d5"] },
            { uci: "g2g4", score: { cp: -800 }, pv: ["g2g4"] },
          ],
        }),
        m({
          san: "g4",
          uci: "g2g4",
          color: "w",
          category: "blunder",
          bestUci: "d2d4",
          bestSan: "d4",
          score: { cp: -100 }, // after g4 (black's view: white is worse)
        }),
        m({ san: "d5", uci: "d7d5", color: "b" }),
        m({ san: "a4", uci: "a2a4", color: "w" }),
      ]),
      playerColor: "w",
      baseRating: 1200,
    });
    expect(res.length).toBe(1);
    expect(res[0].ply).toBe(2);
    expect(res[0].solutionUci).toBe("d2d4");
    expect(res[0].theme).toBe("win");
    expect(res[0].punish).toBe(false);
    expect(res[0].swingCp).toBe(1000);
    expect(res[0].ratingEst).toBeGreaterThan(1200);
  });

  test("book moves, already-found moves and small swings are skipped", () => {
    const res = extractCandidates({
      gameId: "g3",
      parsed,
      cached: cached([
        m({
          san: "f3",
          uci: "f2f3",
          color: "w",
          category: "opening",
          // before e6: tiny swing -> not a training moment
          multi: [
            { uci: "d7d5", score: { cp: 300 }, pv: ["d7d5"] },
            { uci: "e7e6", score: { cp: 100 }, pv: ["e7e6"] },
          ],
        }),
        m({ san: "e6", uci: "e7e6", color: "b", category: "good", bestUci: "d7d5" }),
        m({
          san: "g4",
          uci: "g2g4",
          color: "w",
          category: "blunder",
          multi: [
            { uci: "d8h4", score: { mate: 1 }, pv: ["d8h4"] },
            { uci: "d7d5", score: { cp: -50 }, pv: ["d7d5"] },
          ],
        }),
        // d5 misses mate-in-one but is flagged as a book move -> excluded
        m({ san: "d5", uci: "d7d5", color: "b", category: "opening", bestUci: "d8h4" }),
        m({ san: "a4", uci: "a2a4", color: "w" }),
      ]),
      playerColor: "b",
      baseRating: 1000,
    });
    expect(res.length).toBe(0);
  });

  test("solution not legal in the position -> skipped (stale cache safety)", () => {
    const res = extractCandidates({
      gameId: "g4",
      parsed,
      cached: cached([
        m({ san: "f3", uci: "f2f3", color: "w", category: "opening" }),
        m({
          san: "e6",
          uci: "e7e6",
          color: "b",
          category: "good",
          multi: [
            { uci: "c3c4", score: { cp: 900 }, pv: ["c3c4"] }, // illegal here
            { uci: "g2g4", score: { cp: -200 }, pv: ["g2g4"] },
          ],
        }),
        m({ san: "g4", uci: "g2g4", color: "w", category: "blunder", bestUci: "c3c4" }),
        m({ san: "d5", uci: "d7d5", color: "b" }),
        m({ san: "a4", uci: "a2a4", color: "w" }),
      ]),
      playerColor: "w",
      baseRating: null,
    });
    expect(res.length).toBe(0);
  });
});

describe("isTrivialRecapture", () => {
  // black pawn on c6 can recapture on d5; white just played exd5
  const FEN = "rnbqkbnr/pp1p1ppp/2p5/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
  test("equal-value immediate recapture of a fresh capture is trivial", () => {
    expect(isTrivialRecapture(FEN, "c6d5", "exd5", "e4d5")).toBe(true);
  });
  test("non-capture previous move is not trivial", () => {
    expect(isTrivialRecapture(FEN, "c6d5", "Nf3", "g1f3")).toBe(false);
  });
  test("recapturing with a different value is not trivial", () => {
    // queen takes the pawn while a pawn also could - not the classic case
    expect(isTrivialRecapture(FEN, "d8d5", "exd5", "e4d5")).toBe(false);
  });
});

describe("helpers", () => {
  test("scoreCp: mate dominates, cp linear", () => {
    expect(scoreCp({ cp: 25 })).toBe(25);
    expect(scoreCp(null)).toBe(0);
    expect(scoreCp({ mate: 1 })).toBeGreaterThanOrEqual(99000);
    expect(scoreCp({ mate: -2 })).toBeLessThanOrEqual(-98000);
  });
  test("tierFor bands", () => {
    expect(tierFor(1000)).toBe("easy");
    expect(tierFor(1500)).toBe("mid");
    expect(tierFor(2100)).toBe("hard");
    expect(tierFor(null)).toBe("mid");
  });
});
