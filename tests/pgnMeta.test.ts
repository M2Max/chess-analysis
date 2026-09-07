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
    expect(c.remaining[0]).toBe(179); // fractional seconds are dropped
    // spent = before - after + increment (2)
    expect(c.spent[0]).toBe(3); // 180 - 179 + 2
    expect(c.spent[1]).toBe(3); // 179 - 178 + 2
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
