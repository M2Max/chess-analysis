/**
 * Multi-move extension (extendSolution) with a stubbed analyzer: the line is
 * extended only while every next position stays FORCED, max 3 user moves.
 */
import { describe, expect, test } from "bun:test";
import type { AnalysisResult, ScoreInfo } from "../src/engine/stockfish";
import { extendSolution } from "../src/puzzles/generate";

const FEN_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const line = (over: Partial<ScoreInfo>): ScoreInfo => ({
  depth: 18,
  seldepth: 20,
  score: { cp: 0 },
  pv: [],
  ...over,
});
const res = (lines: ScoreInfo[]): AnalysisResult => ({
  bestMove: lines[0]?.pv[0] ?? "0000",
  info: lines[0] ?? null,
  multipv: lines,
});

describe("extendSolution", () => {
  test("extends while forced, stops when the bar drops -> [e2e4 g1f3]", async () => {
    let n = 0;
    const analyze = async (): Promise<AnalysisResult> => {
      n += 1;
      if (n === 1)
        return res([
          line({ score: { cp: 500 }, pv: ["e2e4", "e7e5"] }),
          line({ score: { cp: 300 }, pv: ["d2d4", "d7d5"] }),
        ]);
      if (n === 2)
        return res([
          line({ score: { cp: 450 }, pv: ["g1f3", "d7d6"] }),
          line({ score: { cp: 200 }, pv: ["d2d4"] }),
        ]);
      return res([line({ score: { cp: 100 }, pv: ["f1c4"] })]);
    };
    const r = await extendSolution(analyze, FEN_START, await analyze());
    expect(r.userUcis).toEqual(["e2e4", "g1f3"]);
    expect(r.pv).toEqual(["e2e4", "e7e5", "g1f3", "d7d6"]);
  });

  test("mate-in-1 shape (no reply in the line) -> single user move", async () => {
    const FEN_MATE = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1"; // Ra8#
    const analyze = async (): Promise<AnalysisResult> => res([line({ score: { mate: 1 }, pv: ["a1a8"] })]);
    const r = await extendSolution(analyze, FEN_MATE, await analyze());
    expect(r.userUcis).toEqual(["a1a8"]);
    expect(r.pv).toEqual(["a1a8"]);
  });

  test("first move illegal in the fen -> empty (caller keeps single-move)", async () => {
    const analyze = async (): Promise<AnalysisResult> =>
      res([line({ score: { cp: 900 }, pv: ["z1z8"] }), line({ score: { cp: 100 }, pv: [] })]);
    const r = await extendSolution(analyze, FEN_START, await analyze());
    expect(r.userUcis).toEqual([]);
  });

  test("caps at 3 user moves even if always forced", async () => {
    // endless forced line from the start (scripted replies keep it legal)
    const seq = [
      ["e2e4", "e7e5"],
      ["g1f3", "b8c6"],
      ["f1c4", "g8f6"],
      ["d2d3", "d7d6"],
    ];
    let n = 0;
    const analyze = async (): Promise<AnalysisResult> => {
      const pair = seq[Math.min(n, seq.length - 1)];
      n += 1;
      return res([
        line({ score: { cp: 600 }, pv: [pair[0], pair[1] ?? "e7e5", "d2d3"] }),
        line({ score: { cp: 400 }, pv: ["d2d4"] }),
      ]);
    };
    const r = await extendSolution(analyze, FEN_START, await analyze());
    expect(r.userUcis.length).toBe(3);
    expect(r.userUcis).toEqual(["e2e4", "g1f3", "f1c4"]);
  });
});
