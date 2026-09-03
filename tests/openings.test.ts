import { describe, expect, test } from "bun:test";
import { Chess } from "chess.js";
import { detectOpening, setOpeningIndexForTests, type OpeningIndex } from "../src/api/openings";

// Build a tiny fixture index the same way scripts/fetch-openings.ts does:
// every prefix position of every line, keyed by "<placement> <stm>", keeping
// the shortest line per position.
function buildIndex(lines: string[]): OpeningIndex {
  const idx: OpeningIndex = {};
  for (const pgn of lines) {
    const sans = pgn.replace(/\d+\.(\.\.)?/g, " ").trim().split(/\s+/);
    const chess = new Chess();
    sans.forEach((san, i) => {
      chess.move(san);
      const key = chess.fen().split(" ").slice(0, 2).join(" ");
      const d = i + 1;
      const prev = idx[key];
      if (!prev || d < prev[2]) idx[key] = ["C50", `Line ${pgn}`, d];
    });
  }
  return idx;
}

// the last line is a transposition entry (same dataset convention: common
// transpositions get their own line)
const IDX = buildIndex([
  "1. e4 e5 2. Nf3",
  "1. e4 e5 2. Nf3 Nc6",
  "1. e4 e5 2. Nf3 Nc6 3. Bb5",
  "1. e4 Nc6 2. Nf3 e5",
]);

describe("detectOpening", () => {
  test("matches a full book line", () => {
    const o = detectOpening(["e4", "e5", "Nf3", "Nc6"], IDX);
    expect(o).not.toBeNull();
    expect(o!.depth).toBe(4);
  });

  test("stops at the first move that leaves the book", () => {
    const o = detectOpening(["e4", "e5", "Nf3", "Nc6", "d4"], IDX);
    // 3...? the position after 4 plies is in the book, 4.d4 leaves it
    expect(o!.depth).toBe(4);
    expect(o!.name).toBe("Line 1. e4 e5 2. Nf3 Nc6");
  });

  test("transposition: same position reached in a different order", () => {
    const o = detectOpening(["e4", "Nc6", "Nf3", "e5"], IDX);
    expect(o).not.toBeNull();
    expect(o!.depth).toBe(4); // game's own ply count, not the book's shortest line
  });

  test("game that never enters the book", () => {
    expect(detectOpening(["c4"], IDX)).toBeNull();
    expect(detectOpening(["d4", "d5", "c4"], IDX)).toBeNull();
  });

  test("empty / missing input", () => {
    expect(detectOpening([], IDX)).toBeNull();
    expect(detectOpening(["e4", "e5"], null)).toBeNull();
  });

  test("illegal SAN stops the walk (the in-book prefix still counts)", () => {
    // Nc6 is illegal for White after 1.e4 e5 - the walk stops, but the
    // 2-ply book prefix is still returned
    expect(detectOpening(["e4", "e5", "Nc6"], IDX)!.depth).toBe(2);
    const o = detectOpening(["e4", "e5", "Nf3", "xxxx"], IDX);
    expect(o!.depth).toBe(3); // the bad move just stops the walk
  });
});

describe("opening index fetch (offline fallback)", () => {
  test("setOpeningIndexForTests pins the index", async () => {
    setOpeningIndexForTests(IDX);
    const idx = await (await import("../src/api/openings")).openingIndex();
    expect(idx).toBe(IDX);
    setOpeningIndexForTests(null);
  });
});
