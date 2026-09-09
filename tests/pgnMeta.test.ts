import { describe, expect, test } from "bun:test";
import { parseClocks, parseInitial, parseIncrement, parseTermination, replayMeta } from "../src/stats/pgnMeta";

const PGN = `[Event "Live Chess"]
[TimeControl "180+2"]
[Termination "Mamox43 won by checkmate"]
1. e4 {[%clk 0:02:59.7]} e5 {[%clk 0:02:58.6]} 2. Nf3 {[%clk 0:02:57.9]} Nc6 {[%clk 0:02:57.0]} *`;

describe("pgnMeta clocks", () => {
  test("parses clk comments and time control", () => {
    expect(parseIncrement(PGN)).toBe(2);
    expect(parseInitial(PGN)).toBe(180);
    const c = parseClocks(PGN);
    expect(c.remaining.length).toBe(4);
    expect(c.remaining[0]).toBeCloseTo(179.7, 1); // fractional seconds kept
    // each clk is the clock of the player who just moved (after increment),
    // so spent = that player's previous clk - this one
    expect(c.spent[0]).toBe(2); // 180 + 2 - 179.7 = 2.3
    expect(c.spent[1]).toBe(3); // 180 + 2 - 178.6 = 3.4
    expect(c.spent[2]).toBe(2); // 179.7 - 177.9 = 1.8 (White, 2 plies back)
    expect(c.spent[3]).toBe(2); // 178.6 - 177.0 = 1.6 (Black)
  });

  test("chess.com export: fractional clocks, increment missing from header", () => {
    // real 3+2 export: TimeControl "180" (no +2!) and 0:02:59.6 clks.
    // Deltas from the same player's previous move are still exact.
    const pgn = `[TimeControl "180"]
1. e4 {[%clk 0:02:59.6]} e5 {[%clk 0:02:58.6]} 2. Nf3 {[%clk 0:02:59.1]} Nc6 {[%clk 0:02:57.1]} *`;
    const c = parseClocks(pgn);
    expect(c.increment).toBe(0); // header lost it
    expect(c.spent[0]).toBe(0); // 180 - 179.6 = 0.4 (off by the unknown +2)
    expect(c.spent[2]).toBe(1); // 179.6 - 179.1 = 0.5 -> 1s, still visible
    expect(c.spent[3]).toBe(2); // 178.6 - 177.1 = 1.5 -> 2s
  });

  test("no clocks -> empty arrays, no crash", () => {
    const c = parseClocks("1. e4 e5 *");
    expect(c.remaining).toEqual([]);
    expect(c.spent).toEqual([]);
    expect(parseIncrement("")).toBe(0);
  });
});

describe("pgnMeta termination", () => {
  const term = (s: string, pgnExtra = "") =>
    parseTermination(`[Termination "${s}"]\n${pgnExtra}`, "Mamox43");

  test("classifies chess.com phrasing", () => {
    expect(term("Mamox43 won by checkmate")).toBe("checkmate");
    expect(term("Mamox43 won by resignation")).toBe("resign");
    expect(term("OwariNoToki lost on time")).toBe("timeoutOpp"); // opponent flagged
    expect(term("Mamox43 lost on time")).toBe("timeoutYou");
    expect(term("Game drawn by agreement")).toBe("agreed");
    expect(term("Mamox43 won on abandonment")).toBe("abandoned");
    expect(term("")).toBe("other");
  });
});

describe("pgnMeta replay", () => {
  test("collects fens and material per ply", () => {
    const m = replayMeta(["e4", "e5", "Nf3", "Nc6"]);
    expect(m.fens.length).toBe(4);
    expect(m.materialAfter.length).toBe(4);
    expect(m.materialAfter[0]).toBe(78);
    expect(m.endPly).toBeNull();
  });

  test("no endgame right after a queen trade", () => {
    const m = replayMeta(["e4", "d5", "exd5", "Qxd5"]);
    // queens are off but 8 minors + 7 pawns remain: not an endgame
    expect(m.endPly).toBeNull();
    expect(m.materialAfter[3]).toBeLessThan(m.materialAfter[0]);
  });
});
