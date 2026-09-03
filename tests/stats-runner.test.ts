import { describe, expect, test } from "bun:test";
import { toCachedAnalysis } from "../src/stats/statsRunner";
import type { ParsedGame } from "../src/engine/parse";
import type { PositionResult } from "../engine/analysis";

const pos = (i: number): PositionResult => ({
  score: { cp: 10 + i },
  bestUci: "e2e4",
  bestSan: "e4",
  pv: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1", "c8g4"],
  depth: 12,
  multi: [{ uci: "e2e4", cp: 10 + i, score: { cp: 10 + i }, pv: ["e2e4", "e7e5"] }],
});

const game = (n: number): ParsedGame => ({
  startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  moves: Array.from({ length: n }, (_, i) => ({
    san: `m${i}`,
    uci: "e2e4",
    color: (i % 2 === 0 ? "w" : "b") as "w" | "b",
    fenBefore: "fen",
    fenAfter: "fen",
  })),
});

describe("toCachedAnalysis (stats run → per-game cache entry)", () => {
  test("complete analysis → a storable CachedAnalysis", () => {
    const n = 4;
    const entry = toCachedAnalysis({
      engine: "lite",
      mode: "fast",
      opening: { eco: "C41", name: "Philidor Defense", depth: 4 },
      moves: game(n).moves,
      classified: Array.from({ length: n }, (_, i) => ({ delta: i * 5, loss: 0.01, category: i < 4 ? "opening" : "good" })),
      positions: [null, ...Array.from({ length: n }, (_, i) => pos(i))],
      ratings: { w: 1200, b: 1150 },
      savedAt: 42,
    })!;
    expect(entry.v).toBe(2);
    expect(entry.engine).toBe("lite");
    expect(entry.mode).toBe("fast");
    expect(entry.opening?.name).toBe("Philidor Defense");
    expect(entry.moves).toHaveLength(n);
    expect(entry.moves[0]).toMatchObject({ san: "m0", uci: "e2e4", color: "w", delta: 0, category: "opening", bestSan: "e4" });
    // multi lines keep their pv truncated to 16
    expect(entry.moves[0].multi[0].pv.length).toBeLessThanOrEqual(16);
    expect(entry.whiteAcc != null && entry.blackAcc != null).toBe(true);
    expect(entry.savedAt).toBe(42);
  });

  test("incomplete analysis (interrupted) → null", () => {
    const n = 4;
    const entry = toCachedAnalysis({
      engine: "lite",
      mode: "fast",
      opening: null,
      moves: game(n).moves,
      classified: [{ delta: 0, loss: 0, category: "opening" }, { delta: 1, loss: 0, category: "opening" }], // only 2 of 4
      positions: [null, pos(0), pos(1)],
    });
    expect(entry).toBeNull();
  });

  test("missing child position → null", () => {
    const n = 2;
    const entry = toCachedAnalysis({
      engine: "lite",
      mode: "fast",
      opening: null,
      moves: game(n).moves,
      classified: [{ delta: 0, loss: 0, category: "opening" }, { delta: 0, loss: 0, category: "opening" }],
      positions: [null, pos(0)], // position 2 missing
    });
    expect(entry).toBeNull();
  });
});

// The storage side (one best-combo entry per game, rank guard, round-trip)
// lives in the server SQLite layer - see tests/server-db.test.ts. The
// runner's putAnalysis is a fire-and-forget HTTP call; offline it degrades
// to "not stored" without breaking the run.
