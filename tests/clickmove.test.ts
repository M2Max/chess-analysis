import { describe, expect, test } from "bun:test";
import { Chess } from "chess.js";
import { clickMoveStyles, isLightSquare, legalTargets, pieceAt, promoFor } from "../src/components/clickMove";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("isLightSquare", () => {
  test("corners", () => {
    expect(isLightSquare("a1")).toBe(false);
    expect(isLightSquare("h1")).toBe(true);
    expect(isLightSquare("a8")).toBe(true);
    expect(isLightSquare("h8")).toBe(false);
    expect(isLightSquare("e4")).toBe(true);
  });
});

describe("legalTargets", () => {
  test("startpos pawn e2 -> e3/e4, no captures", () => {
    const t = legalTargets(START, "e2");
    expect([...t.keys()].sort()).toEqual(["e3", "e4"]);
    expect([...t.values()].every((c) => c === false)).toBe(true);
  });
  test("marks captures (incl. en passant)", () => {
    const ep = legalTargets("4k3/8/8/4p3/5P2/8/8/4K3 w - e6 0 1", "f4");
    expect(ep.get("e6")).toBe(true);
    expect(ep.get("f5")).toBe(false);
    const gtc = legalTargets("4k3/8/8/4p3/8/8/8/4K1R1 w - - 0 1", "g1");
    expect(gtc.get("e5")).toBe(true);
  });
  test("bad square / bad fen -> empty", () => {
    expect(legalTargets(START, "e5").size).toBe(0);
    expect(legalTargets("not a fen", "e2").size).toBe(0);
  });
});

describe("pieceAt / promoFor", () => {
  test("piece lookup", () => {
    const ch = new Chess(START);
    expect(pieceAt(ch, "e2")).toEqual({ type: "p", color: "w" });
    expect(pieceAt(ch, "e5")).toBeNull();
  });
  test("auto-queen only for pawns reaching the back rank", () => {
    const promo = new Chess("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
    expect(promoFor(promo, "a7", "a8")).toBe("q");
    expect(promoFor(new Chess(START), "g1", "f3")).toBeUndefined();
    expect(promoFor(new Chess(START), "e2", "e3")).toBeUndefined();
  });
});

describe("clickMoveStyles", () => {
  test("no selection -> no styles", () => {
    expect(clickMoveStyles(START, null)).toEqual({});
  });
  test("selection tints origin, dots on empty targets, ring on captures", () => {
    const s = clickMoveStyles(START, "e2");
    expect(s.e2?.backgroundColor).toBeTruthy();
    expect(s.e3?.backgroundImage).toContain("radial-gradient(circle, rgba");
    // capture variant draws a ring (transparent centre)
    const cap = clickMoveStyles("4k3/8/8/4p3/8/8/8/4K1R1 w - - 0 1", "g1");
    expect(cap.e5?.backgroundImage).toContain("transparent 56%");
  });
});
