import { describe, expect, test } from "bun:test";
import { expectedPoints, materialOf, nonPawnMaterialOf, wdl } from "../src/stats/winprob";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("winprob (Stockfish WDL model)", () => {
  test("material count", () => {
    expect(materialOf(START)).toBe(78);
    // kings + a single white pawn
    expect(materialOf("4k3/8/8/8/8/8/5P2/4K3 w - - 0 1")).toBe(1);
    // only kings
    expect(materialOf("4k3/8/8/8/8/8/8/4K3 w - - 0 1")).toBe(0);
  });

  test("non-pawn material + endgame rule", () => {
    expect(nonPawnMaterialOf(START)).toBe(62);
    // queens off, one minor each -> endgame marker (0)
    expect(nonPawnMaterialOf("4k3/8/8/8/8/8/4P3/2B1K2N w - - 0 1")).toBe(0);
    // queens on -> raw non-pawn value
    expect(nonPawnMaterialOf("4k3/8/8/8/8/8/4P2P/3QK3 w - - 0 1")).toBe(9);
  });

  test("balanced eval -> ~50%", () => {
    const w = wdl(0, 60);
    expect(w.exp).toBeGreaterThan(0.47);
    expect(w.exp).toBeLessThan(0.53);
  });

  test("monotone and symmetric", () => {
    const a = expectedPoints(50, 60);
    const b = expectedPoints(150, 60);
    const c = expectedPoints(300, 60);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    const w = wdl(120, 60);
    const l = wdl(-120, 60);
    expect(w.w).toBeCloseTo(l.l, 6);
    expect(w.l).toBeCloseTo(l.w, 6);
  });

  test("the same cp is MORE decisive with less material", () => {
    const mid = expectedPoints(150, 60);
    const end = expectedPoints(150, 24);
    expect(end).toBeGreaterThan(mid + 0.005);
  });

  test("large advantage approaches 1", () => {
    expect(expectedPoints(900, 40)).toBeGreaterThan(0.93);
    expect(expectedPoints(-900, 40)).toBeLessThan(0.07);
  });
});
