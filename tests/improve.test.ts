import { describe, expect, test } from "bun:test";
import { buildImprove } from "../src/stats/improve";
import type { StatsGameRow } from "../src/stats/statsRows";

const PGN = `[Event "t"]
[TimeControl "180+0"]
[Termination "Opponent won by checkmate"]
1. e4 {[%clk 0:02:59]} e5 {[%clk 0:02:58]} 2. Nf3 {[%clk 0:02:52]} Nc6 {[%clk 0:02:51]} 0-1`;

function row(over: Partial<StatsGameRow> = {}): StatsGameRow {
  return {
    id: "g1",
    utc: 1_750_000_000,
    result: "0-1",
    timeClass: "blitz",
    timeControl: "180+0",
    whiteUsername: "Mamox43",
    blackUsername: "Opponent",
    whiteRating: 1200,
    blackRating: 1210,
    youWhite: true,
    analyzed: true,
    opening: { eco: "C20", name: "King's Pawn Game", depth: 2 },
    whiteAcc: 55,
    blackAcc: 90,
    pgn: PGN,
    moves: [
      { ply: 0, color: "w", san: "e4", delta: 0, category: "opening", bestUci: null, bestSan: null, scoreCp: -20, scoreMate: null, bestMate: null },
      { ply: 1, color: "b", san: "e5", delta: 0, category: "opening", bestUci: null, bestSan: null, scoreCp: -10, scoreMate: null, bestMate: null },
      // the blunder: after it Black is +150 (side-to-move view)
      { ply: 2, color: "w", san: "Nf3", delta: 120, category: "blunder", bestUci: "d2d4", bestSan: "d4", scoreCp: 150, scoreMate: null, bestMate: null },
      { ply: 3, color: "b", san: "Nc6", delta: 0, category: "best", bestUci: null, bestSan: null, scoreCp: 140, scoreMate: null, bestMate: null },
    ],
    ...over,
  };
}

describe("improve block", () => {
  test("wp curve, biggest drop, motifs, clocks, termination", () => {
    const imp = buildImprove(row(), "Mamox43")!;
    expect(imp).not.toBeNull();
    expect(imp.wp.length).toBe(4);
    // after ply 1 White is better (score -10 stm-black => +10 white) -> peak
    // after the blunder (ply 2, +150 for Black) White's expectation collapses
    expect(imp.drop?.ply).toBe(2);
    expect(imp.drop?.san).toBe("Nf3");
    expect(imp.drop!.wp).toBeGreaterThan(20);
    expect(imp.worst.ply).toBe(2); // the collapse is the worst moment
    expect(imp.peak.wp).toBeGreaterThan(60); // black's reply swung it back
    // diagnosed: a concrete mistake, not time pressure (52s of the clock left)
    expect(imp.motifs.length).toBe(1);
    expect(imp.motifs[0].ply).toBe(2);
    expect(imp.motifs[0].remaining).toBe(178); // remaining BEFORE ply 2 (black's clock at ply 1)
    expect(imp.term).toBe("checkmate");
    expect(imp.bookPly).toBe(2);
    expect(imp.clocks.initial).toBe(180);
  });

  test("black perspective mirrors the curve", () => {
    const imp = buildImprove(
      row({ youWhite: false, whiteUsername: "Opponent", blackUsername: "Mamox43" }),
      "Mamox43",
    )!;
    // after white's blunder (ply 2 was white's move here) the BLACK peak is elsewhere
    expect(imp.wp.length).toBe(4);
    // user is black: the best moment is after the opponent's ply-2 blunder
    expect(imp.peak.wp).toBeGreaterThan(50.5);
    expect(imp.worst.wp).toBeLessThan(40);
  });

  test("no analysis moves -> null", () => {
    expect(buildImprove(row({ moves: [] }), "Mamox43")).toBeNull();
  });
});
