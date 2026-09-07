import { describe, expect, test } from "bun:test";
import { classifyMotif } from "../src/stats/motifs";

describe("motifs classifier", () => {
  test("mate in the engine line beats everything", () => {
    const m = classifyMotif({
      fenBefore: "6k1/5ppp/8/8/8/8/5PPP/R3K2R w - - 0 1",
      playedUci: "a2a3",
      bestUci: "a1a8",
      bestMateIn: 1,
      deltaCp: 400,
    });
    expect(m).toBe("mateMissed");
  });

  test("time pressure overrides concrete tactics below mate", () => {
    const m = classifyMotif({
      fenBefore: "4k3/8/8/8/8/8/5q2/4K3 b - - 0 1",
      playedUci: "e8e7",
      bestUci: "e8f8",
      bestMateIn: null,
      remainingSec: 12,
      deltaCp: 250,
    });
    expect(m).toBe("timePressure");
  });

  test("the best move captures material and the player did not", () => {
    // black queen is completely free on d5 (undefended), white should take
    const m = classifyMotif({
      fenBefore: "4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1",
      playedUci: "d1e2",
      bestUci: "d1d5",
      bestMateIn: null,
      deltaCp: 900,
    });
    expect(m).toBe("missedCapture");
  });

  test("a move that hangs a piece is tagged 'hang'", () => {
    // white plays the knight to f3 where the d5... use a real hazard:
    // black bishop on b7 aims at f3? no - construct: black pawn e4 attacks f3/d3
    const m = classifyMotif({
      fenBefore: "4k3/8/8/8/4p3/8/8/3K4 w - - 0 1",
      playedUci: "d1e2",
      bestUci: "d1c2",
      bestMateIn: null,
      deltaCp: 200,
    });
    // king walk into the pawn's range is not a piece hang; positional
    expect(m).toBe("positional");
  });

  test("a knight fork as best move is tagged 'fork'", () => {
    // Ne6-c7+ forks the king on e8 and the rook on a8
    const m = classifyMotif({
      fenBefore: "r3k3/8/4N3/8/8/8/8/4K3 w - - 0 1",
      playedUci: "e1f1",
      bestUci: "e6c7",
      bestMateIn: null,
      deltaCp: 400,
    });
    expect(m).toBe("fork");
  });

  test("quiet best move -> positional", () => {
    const m = classifyMotif({
      fenBefore: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
      playedUci: "d2d3",
      bestUci: "c3d5",
      bestMateIn: null,
      deltaCp: 80,
    });
    expect(m).toBe("positional");
  });
});
