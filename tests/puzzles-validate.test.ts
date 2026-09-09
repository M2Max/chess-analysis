/**
 * Puzzle validation verdicts (pure decision over an injected search).
 */
import { describe, expect, test } from "bun:test";
import { parsePgn } from "../src/engine/parse";
import type { AnalysisResult, ScoreInfo } from "../src/engine/stockfish";
import { validateVerdict } from "../src/puzzles/validate";

const PGN = `[TimeControl "600+0"]
1. f3 e6 2. g4 d5 3. a4 *`;
const parsed = parsePgn(PGN);
// position after 2.g4 (black to move; Qh4# available)
const FEN_MATE = parsed.moves[3].fenBefore;
const FEN_START = parsed.startFen;

function res(lines: ScoreInfo[]): AnalysisResult {
  return { bestMove: lines[0]?.pv[0] ?? "0000", info: lines[0] ?? null, multipv: lines };
}

const line = (over: Partial<ScoreInfo>): ScoreInfo => ({
  depth: 20,
  seldepth: 22,
  score: { cp: 0 },
  pv: [],
  ...over,
});

describe("validateVerdict", () => {
  test("unique mate-in-1 -> ok (theme mate, SAN resolved)", () => {
    const v = validateVerdict(
      res([
        line({ score: { mate: 1 }, pv: ["d8h4"] }),
        line({ score: { cp: -50 }, pv: ["d7d5"] }),
      ]),
      FEN_MATE,
      "d8h4",
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.theme).toBe("mate");
      expect(v.mateLen).toBe(1);
      expect(v.solutionSan).toBe("Qh4#");
    }
  });

  test("quiet unique win -> ok (theme win)", () => {
    const v = validateVerdict(
      res([
        line({ score: { cp: 420 }, pv: ["e2e4"] }),
        line({ score: { cp: 200 }, pv: ["d2d4"] }),
      ]),
      FEN_START,
      "e2e4",
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.theme).toBe("win");
      expect(v.mateLen).toBeNull();
      expect(v.solutionSan).toBe("e4");
    }
  });

  test("deeper search disagrees on the first move -> cooked", () => {
    const v = validateVerdict(res([line({ score: { cp: 500 }, pv: ["e2e4"] })]), FEN_START, "d2d4");
    expect(v).toEqual({ ok: false, reason: "cooked" });
  });

  test("second line within the margin -> cooked", () => {
    const v = validateVerdict(
      res([
        line({ score: { cp: 400 }, pv: ["e2e4"] }),
        line({ score: { cp: 350 }, pv: ["d2d4"] }),
      ]),
      FEN_START,
      "e2e4",
    );
    expect(v).toEqual({ ok: false, reason: "cooked" });
  });

  test("two equally short mates -> cooked", () => {
    const v = validateVerdict(
      res([
        line({ score: { mate: 1 }, pv: ["d8h4"] }),
        line({ score: { mate: 1 }, pv: ["d8h4"] }),
      ]),
      FEN_MATE,
      "d8h4",
    );
    expect(v).toEqual({ ok: false, reason: "cooked" });
  });

  test("below the soundness threshold -> unsound", () => {
    const v = validateVerdict(res([line({ score: { cp: 90 }, pv: ["e2e4"] })]), FEN_START, "e2e4");
    expect(v).toEqual({ ok: false, reason: "unsound" });
  });

  test("mate longer than the cap -> unsound", () => {
    const v = validateVerdict(res([line({ score: { mate: 9 }, pv: ["e2e4"] })]), FEN_START, "e2e4");
    expect(v).toEqual({ ok: false, reason: "unsound" });
  });

  test("no info at all -> stale", () => {
    expect(validateVerdict({ bestMove: "0000", info: null, multipv: [] }, FEN_START, "e2e4")).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  test("illegal pv for this fen -> stale (never reaches the animation)", () => {
    const v = validateVerdict(
      res([
        line({ score: { mate: 1 }, pv: ["d8h4"] }),
        line({ score: { mate: 5 }, pv: ["d8a5"] }), // no mate for black here anyway
      ]),
      FEN_START, // d8h4 is NOT legal in the start position
      "d8h4",
    );
    expect(v).toEqual({ ok: false, reason: "stale" });
  });
});
