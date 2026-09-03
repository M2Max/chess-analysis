import { describe, expect, test } from "bun:test";
import { Chess } from "chess.js";
import { parsePgn, uciToSan, PgnParseError, START_FEN } from "../src/engine/parse";

const OPERA_GAME = [
  "[White \"Paul Morphy\"]",
  "[Black \"Dukes\"]",
  "[Result \"1-0\"]",
  "",
  "1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7",
  "8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7",
  "14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0",
].join("\n");

describe("parsePgn", () => {
  test("parses a full game with FENs", () => {
    const p = parsePgn(OPERA_GAME);
    expect(p.startFen).toBe(START_FEN);
    expect(p.moves).toHaveLength(33);
    expect(p.moves[0]).toMatchObject({ san: "e4", uci: "e2e4", color: "w" });
    expect(p.moves[1].color).toBe("b");
    const last = p.moves[32];
    expect(last.san).toBe("Rd8#");
    expect(last.uci).toBe("d1d8");
    expect(last.color).toBe("w");
  });

  test("fenBefore/fenAfter chain is consistent", () => {
    const p = parsePgn(OPERA_GAME);
    expect(p.moves[0].fenBefore).toBe(START_FEN);
    for (let i = 1; i < p.moves.length; i++) {
      expect(p.moves[i].fenBefore).toBe(p.moves[i - 1].fenAfter);
    }
  });

  test("works without headers", () => {
    const p = parsePgn("1. e4 e5 2. Nf3 Nc6");
    expect(p.moves).toHaveLength(4);
  });

  test("promotion uci includes the piece", () => {
    // FEN setup: white pawn on b7, promotion next
    const pgn = '[FEN "7k/1P6/8/8/8/8/8/K7 w - - 0 1"]\n1. b8=Q 1-0';
    const p = parsePgn(pgn);
    expect(p.moves.length).toBe(1);
    expect(p.moves[0].uci).toBe("b7b8q");
    expect(p.moves[0].san).toMatch(/^b8=Q/);
  });

  test("throws PgnParseError on illegal moves", () => {
    expect(() => parsePgn("1. e4 e5 2. e4")).toThrow(PgnParseError);
  });

  test("throws PgnParseError on empty games", () => {
    expect(() => parsePgn("1-0")).toThrow(PgnParseError);
    expect(() => parsePgn("1-0")).toThrow(/no moves/i);
  });
});

describe("uciToSan", () => {
  test("legal move → SAN", () => {
    expect(uciToSan(START_FEN, "e2e4")).toBe("e4");
    expect(uciToSan(START_FEN, "g1f3")).toBe("Nf3");
  });

  test("illegal move → undefined", () => {
    expect(uciToSan(START_FEN, "e7e5")).toBeUndefined(); // black move, white to play
    expect(uciToSan(START_FEN, "e2e5")).toBeUndefined();
    expect(uciToSan(START_FEN, "e2")).toBeUndefined(); // malformed
  });

  test("promotion", () => {
    const fen = "8/P7/8/8/8/8/8/k1K5 w - - 0 1";
    // promotes with checkmate: queen covers the a-file and Kc1 covers b1
    expect(uciToSan(fen, "a7a8q")).toBe("a8=Q#");
  });
});
