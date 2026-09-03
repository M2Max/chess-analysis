import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RATING,
  accuracyFromMoves,
  categoryBgClass,
  categoryColorClass,
  categoryDarkClass,
  classifyMove,
  coreCategory,
  expectedLoss,
  formatEval,
  isHardToRefute,
  flipScore,
  hasSymbol,
  moveAccuracy,
  multipvToMultiLines,
  ratingFor,
  sacrificeValues,
  scoreToClassifyCp,
  symbol,
  uciLineToSan,
  type MoveClassifyInput,
  type MultiLine,
} from "../src/engine/classify";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("scoreToClassifyCp", () => {
  test("cp scores pass through", () => {
    expect(scoreToClassifyCp({ cp: 35 })).toBe(35);
    expect(scoreToClassifyCp({ cp: -120 })).toBe(-120);
    expect(scoreToClassifyCp(null)).toBe(0);
  });

  test("mates map to the bounded scale (M1=2000, M2=1500, M3+=1000)", () => {
    expect(scoreToClassifyCp({ mate: 1 })).toBe(2000);
    expect(scoreToClassifyCp({ mate: 2 })).toBe(1500);
    expect(scoreToClassifyCp({ mate: 3 })).toBe(1000);
    expect(scoreToClassifyCp({ mate: 12 })).toBe(1000);
    expect(scoreToClassifyCp({ mate: -1 })).toBe(-2000);
    expect(scoreToClassifyCp({ mate: -2 })).toBe(-1500);
  });
});

describe("expectedLoss", () => {
  test("zero delta → zero loss", () => {
    expect(expectedLoss(0, 1500)).toBe(0);
  });

  test("tanh model at rating 2200 (factor 1)", () => {
    expect(expectedLoss(50, 2200)).toBeCloseTo(Math.tanh(0.1), 10);
    expect(expectedLoss(100, 2200)).toBeCloseTo(Math.tanh(0.2), 10);
  });

  test("rating factor is clamped to [0.4, 1.5]", () => {
    // 880/2200 = 0.4 (floor)
    expect(expectedLoss(100, 0)).toBe(expectedLoss(100, 880));
    // 3300/2200 = 1.5 (ceiling)
    expect(expectedLoss(100, 99999)).toBe(expectedLoss(100, 3300));
  });

  test("higher rating → higher loss for the same delta", () => {
    expect(expectedLoss(50, 2800)).toBeGreaterThan(expectedLoss(50, 1200));
  });
});

describe("coreCategory", () => {
  test("expected-loss thresholds", () => {
    expect(coreCategory(0)).toBe("best");
    expect(coreCategory(0.01)).toBe("excellent");
    expect(coreCategory(0.02)).toBe("excellent");
    expect(coreCategory(0.03)).toBe("good");
    expect(coreCategory(0.05)).toBe("good");
    expect(coreCategory(0.08)).toBe("inaccuracy");
    expect(coreCategory(0.1)).toBe("inaccuracy");
    expect(coreCategory(0.15)).toBe("mistake");
    expect(coreCategory(0.2)).toBe("mistake");
    expect(coreCategory(0.21)).toBe("blunder");
    expect(coreCategory(0.9)).toBe("blunder");
  });
});

describe("isHardToRefute", () => {
  const replies = (r1: number, r2: number, r3: number): MultiLine[] => [
    { uci: "a1a2", cp: r1 },
    { uci: "b1b2", cp: r2 },
    { uci: "c1c2", cp: r3 },
  ];

  test("forced mate for the mover is unrefutable", () => {
    expect(isHardToRefute([], { mate: -1 })).toBe(true);
  });

  test("no lines → refutable", () => {
    expect(isHardToRefute([], { cp: 0 })).toBe(false);
  });

  test("opponent's best reply is positive → refutable", () => {
    expect(isHardToRefute(replies(30, 20, 10), { cp: 0 })).toBe(false);
  });

  test("narrow defense (≤2 replies within 50cp of best) → hard to refute", () => {
    expect(isHardToRefute(replies(-30, -80, -90), { cp: 0 })).toBe(true);
  });

  test("wide defense (3 replies within 50cp of best) → refutable", () => {
    expect(isHardToRefute(replies(-10, -40, -50), { cp: 0 })).toBe(false);
  });
});

/** Default input: best move played in a balanced position, no sacrifice. */
function cm(o: Partial<MoveClassifyInput> = {}): MoveClassifyInput {
  return {
    prevMulti: [{ uci: "e2e4", cp: 0 }],
    playedUci: "e2e4",
    childBest: { cp: 0 },
    childMulti: [
      { uci: "b8c6", cp: -30 },
      { uci: "g8f6", cp: -80 },
      { uci: "d7d5", cp: -90 },
    ],
    prevCategory: null,
    rating: 1500,
    movedValue: 1,
    capturedValue: 0,
    ...o,
  };
}

describe("classifyMove", () => {
  test("played the best move with no gap → best", () => {
    expect(classifyMove(cm()).category).toBe("best");
    expect(classifyMove(cm()).loss).toBe(0);
  });

  test("best move with 2nd-best >80cp worse → great", () => {
    expect(
      classifyMove(cm({ prevMulti: [{ uci: "e2e4", cp: 50 }, { uci: "d2d4", cp: -40 }] })).category,
    ).toBe("great");
    // gap exactly 80 → not great
    expect(
      classifyMove(cm({ prevMulti: [{ uci: "e2e4", cp: 50 }, { uci: "d2d4", cp: -30 }] })).category,
    ).toBe("best");
  });

  test("played 2nd-best → loss from the eval gap", () => {
    const cls = classifyMove(
      cm({
        prevMulti: [
          { uci: "e2e4", cp: 0 },
          { uci: "d2d4", cp: -60 },
        ],
        playedUci: "d2d4",
      }),
    );
    expect(cls.delta).toBe(60);
    expect(cls.loss).toBeCloseTo(expectedLoss(60, 1500), 10);
    expect(cls.category).toBe("inaccuracy");
  });

  test("move outside top-3 → child eval (negated to mover's view) is used", () => {
    // childBest is the opponent's view: -120 for them = +120 for the mover,
    // so the move swung the eval 120cp away from the best line.
    const cls = classifyMove(cm({ playedUci: "f2f3", childBest: { cp: -120 } }));
    expect(cls.delta).toBe(120);
    expect(cls.category).toBe("mistake");
  });

  test("sacrifice, near-best, not winning, hard to refute → brilliant", () => {
    const cls = classifyMove(
      cm({ movedValue: 9, capturedValue: 3 }), // queen takes a knight
    );
    expect(cls.category).toBe("brilliant");
  });

  test("sacrifice that is refutable (opponent gains an edge) → not brilliant", () => {
    const cls = classifyMove(
      cm({
        movedValue: 9,
        capturedValue: 3,
        childMulti: [
          { uci: "b8c6", cp: 40 },
          { uci: "g8f6", cp: 10 },
          { uci: "d7d5", cp: -50 },
        ],
      }),
    );
    expect(cls.category).toBe("best"); // loss 0 → core
  });

  test("sacrifice while already winning (best ≥ 400cp) → not brilliant", () => {
    const cls = classifyMove(
      cm({ movedValue: 9, capturedValue: 3, prevMulti: [{ uci: "e2e4", cp: 500 }] }),
    );
    expect(cls.category).toBe("best");
  });

  test("sacrifice with loss > 0.10 → not brilliant", () => {
    const cls = classifyMove(
      cm({
        movedValue: 9,
        capturedValue: 3,
        prevMulti: [
          { uci: "e2e4", cp: 0 },
          { uci: "d2d4", cp: -150 },
        ],
        playedUci: "d2d4",
      }),
    );
    expect(cls.loss).toBeGreaterThan(0.1);
    expect(cls.category).toBe("blunder"); // loss ≈ 0.202 at rating 1500
  });

  test("wide defense (3 good replies) → not brilliant", () => {
    const cls = classifyMove(
      cm({
        movedValue: 9,
        capturedValue: 3,
        childMulti: [
          { uci: "b8c6", cp: -10 },
          { uci: "g8f6", cp: -40 },
          { uci: "d7d5", cp: -50 },
        ],
      }),
    );
    expect(cls.category).toBe("best");
  });

  test("opponent blundered last and this move misses it → missedwin", () => {
    const cls = classifyMove(
      cm({
        prevCategory: "blunder",
        prevMulti: [
          { uci: "e2e4", cp: 0 },
          { uci: "d2d4", cp: -180 },
        ],
        playedUci: "d2d4",
      }),
    );
    expect(cls.loss).toBeGreaterThanOrEqual(0.15);
    expect(cls.category).toBe("missedwin");
  });

  test("missed win requires loss ≥ 0.15", () => {
    const cls = classifyMove(
      cm({
        prevCategory: "mistake",
        prevMulti: [
          { uci: "e2e4", cp: 0 },
          { uci: "d2d4", cp: -100 },
        ],
        playedUci: "d2d4",
      }),
    );
    expect(cls.loss).toBeLessThan(0.15);
    expect(cls.category).toBe("mistake"); // core category for loss ≈ 0.136
  });

  test("missed win requires a prior mistake/blunder", () => {
    const cls = classifyMove(
      cm({
        prevCategory: "inaccuracy",
        prevMulti: [
          { uci: "e2e4", cp: 0 },
          { uci: "d2d4", cp: -180 },
        ],
        playedUci: "d2d4",
      }),
    );
    expect(cls.category).toBe("blunder"); // core category for loss ≈ 0.24
  });

  test("mate mapping via the child fallback", () => {
    // engine saw M3+ (1000cp) as best; the played move (not in top-3) lands
    // in a position where the opponent is mated (M1 = 2000cp for the mover).
    const cls = classifyMove(
      cm({
        prevMulti: [{ uci: "e2e4", cp: 1000 }],
        playedUci: "f2f3",
        childBest: { mate: -1 },
      }),
    );
    expect(cls.delta).toBe(1000);
    expect(cls.loss).toBeGreaterThan(0.5);
    expect(cls.category).toBe("blunder");
  });
});

describe("sacrificeValues", () => {
  test("queen takes pawn → 9 vs 1", () => {
    const fen = "k7/7p/8/5Q2/8/8/8/3K4 w - - 0 1";
    expect(sacrificeValues(fen, "f5h7")).toEqual({ movedValue: 9, capturedValue: 1 });
  });

  test("pawn takes knight → 1 vs 3 (not a sacrifice)", () => {
    const fen = "k7/8/8/8/8/5n2/4P3/K7 w - - 0 1";
    expect(sacrificeValues(fen, "e2f3")).toEqual({ movedValue: 1, capturedValue: 3 });
  });

  test("quiet move → no capture", () => {
    expect(sacrificeValues(START_FEN, "e2e4")).toEqual({ movedValue: 1, capturedValue: 0 });
  });

  test("promotion → pawn value, no capture", () => {
    const fen = "7k/1P6/8/8/8/8/8/K7 w - - 0 1";
    expect(sacrificeValues(fen, "b7b8q")).toEqual({ movedValue: 1, capturedValue: 0 });
  });

  test("illegal move → zeros", () => {
    expect(sacrificeValues(START_FEN, "a1h8")).toEqual({ movedValue: 0, capturedValue: 0 });
  });
});

describe("ratingFor", () => {
  test("mover's own rating", () => {
    expect(ratingFor({ w: 1800, b: 1400 }, "w")).toBe(1800);
    expect(ratingFor({ w: 1800, b: 1400 }, "b")).toBe(1400);
  });

  test("falls back to the opponent's rating, then the default", () => {
    expect(ratingFor({ w: undefined, b: 1400 }, "w")).toBe(1400);
    expect(ratingFor({ w: 1800, b: undefined }, "b")).toBe(1800);
    expect(ratingFor({}, "w")).toBe(DEFAULT_RATING);
    expect(ratingFor(null, "b")).toBe(DEFAULT_RATING);
  });
});

describe("multipvToMultiLines", () => {
  test("maps lines to mate-mapped cp and drops empty pv", () => {
    const lines = [
      { score: { mate: 1 }, pv: ["e1e2"] },
      { score: { cp: -30 }, pv: ["d2d4"] },
      { score: { cp: -50 }, pv: [] },
    ];
    expect(multipvToMultiLines(lines)).toEqual([
      { uci: "e1e2", cp: 2000, score: { mate: 1 }, pv: ["e1e2"] },
      { uci: "d2d4", cp: -30, score: { cp: -30 }, pv: ["d2d4"] },
    ]);
  });
});

describe("flipScore", () => {
  test("negates cp and mate", () => {
    expect(flipScore({ cp: 35 })).toEqual({ cp: -35 });
    expect(flipScore({ mate: 2 })).toEqual({ mate: -2 });
  });
});

describe("uciLineToSan", () => {
  test("converts a UCI line to SAN, capped at maxMoves", () => {
    // start position: e4 e5 Nf3 Nc6 Bb5
    expect(uciLineToSan(START_FEN, ["e2e4", "e7e5", "g1f3", "b8c6", "c8b5"], 4)).toEqual([
      "e4",
      "e5",
      "Nf3",
      "Nc6",
    ]);
  });

  test("handles promotions and stops at game end", () => {
    // Qxf7# on the Fool's-Mate-ish position
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4";
    expect(uciLineToSan(fen, ["f3f7", "e8e7"], 4)).toEqual(["Qxf7#"]);
  });

  test("promotion move", () => {
    const fen = "7k/1P6/8/8/8/8/8/K7 w - - 0 1";
    expect(uciLineToSan(fen, ["b7b8q"], 4)).toEqual(["b8=Q+"]);
  });

  test("illegal move stops the line", () => {
    expect(uciLineToSan(START_FEN, ["e2e5"], 4)).toEqual([]);
  });
});

describe("moveAccuracy (distance from the engine, reference-calibrated)", () => {
  test("best move scores 100, huge swings floor near 10", () => {
    expect(moveAccuracy(0)).toBe(100);
    expect(moveAccuracy(1000)).toBeCloseTo(10, 0);
  });

  test("is monotonic in the cp distance", () => {
    expect(moveAccuracy(10)).toBeGreaterThan(moveAccuracy(50));
    expect(moveAccuracy(50)).toBeGreaterThan(moveAccuracy(100));
    expect(moveAccuracy(100)).toBeGreaterThan(moveAccuracy(300));
  });

  test("clamps negative deltas to the best-move score", () => {
    expect(moveAccuracy(-50)).toBe(100);
  });

  test("rating scaling: same swing penalised more at lower ratings", () => {
    expect(moveAccuracy(50, 900)).toBeLessThan(moveAccuracy(50, 1300));
    expect(moveAccuracy(50, 1300)).toBeLessThan(moveAccuracy(50, 1500));
    // clamped: beyond 1200·0.85 / 1200·1.15 the factor stops moving
    expect(moveAccuracy(50, 300)).toBeCloseTo(moveAccuracy(50, 1020), 5);
    expect(moveAccuracy(50, 1500)).toBeCloseTo(moveAccuracy(50, 2400), 5);
  });

  test("calibration spot values (rating 1500, k = 120.75)", () => {
    expect(moveAccuracy(25, 1500)).toBeCloseTo(83.17, 1);
    expect(moveAccuracy(100, 1500)).toBeCloseTo(49.32, 1);
    expect(moveAccuracy(400, 1500)).toBeCloseTo(13.28, 1);
  });
});

describe("symbol", () => {
  test("review-style markers", () => {
    expect(symbol("brilliant")).toBe("!!");
    expect(symbol("great")).toBe("!");
    expect(symbol("best")).toBe("★"); // green star
    expect(symbol("excellent")).toBe(""); // mono SVG thumbs up (CategorySymbol)
    expect(symbol("good")).toBe("\u2713"); // light green tick
    expect(symbol("inaccuracy")).toBe("!?");
    expect(symbol("mistake")).toBe("?");
    expect(symbol("blunder")).toBe("??");
    expect(symbol("missedwin")).toBe("\u2715"); // red X
    expect(symbol("opening")).toBe(""); // mono SVG book (CategorySymbol)
    expect(symbol(null)).toBe("");
  });

  test("hasSymbol", () => {
    expect(hasSymbol("excellent")).toBe(true); // SVG thumbs up
    expect(hasSymbol("opening")).toBe(true); // SVG book
    expect(hasSymbol("best")).toBe(true);
    expect(hasSymbol("missedwin")).toBe(true);
    expect(hasSymbol("inaccuracy")).toBe(true);
    expect(hasSymbol(null)).toBe(false);
  });
});

describe("accuracyFromMoves (book moves count 100)", () => {
  test("opening moves are perfect, others use the delta model", () => {
    const r = accuracyFromMoves(
      [
        { color: "w", delta: 0, category: "opening" },
        { color: "w", delta: 0, category: "opening" },
        { color: "w", delta: 100, category: "mistake" }, // far from engine
      ],
      { w: 1200, b: 1200 },
    );
    expect(r.w.moves).toBe(3);
    // (100 + 100 + ~55) / 3 ≈ 85 - book moves lift the average
    expect(r.w.value).toBeGreaterThan(80);
    expect(r.w.value).toBeLessThan(90);
  });

  test("blunder decay still applies to non-book moves", () => {
    const r = accuracyFromMoves(
      [
        { color: "b", delta: 300, category: "blunder" },
        { color: "b", delta: 300, category: "blunder" },
      ],
      null,
    );
    // two 300cp blunders @ default rating: ~21 + ~35 (half penalty) ≈ 28
    expect(r.b.value).toBeLessThan(40);
  });

  test("no moves → null", () => {
    const r = accuracyFromMoves([], null);
    expect(r.w.value).toBeNull();
    expect(r.b.value).toBeNull();
  });
});

describe("category colors", () => {
  test("categoryColorClass (semantic cat-* classes, colours in index.css per theme)", () => {
    expect(categoryColorClass("brilliant")).toBe("cat-brilliant"); // deep blue, deeper than great's sky
    expect(categoryColorClass("best")).toBe("cat-best");
    expect(categoryColorClass("excellent")).toBe("cat-best");
    expect(categoryColorClass("good")).toBe("cat-good"); // lighter green
    expect(categoryColorClass("great")).toBe("cat-great");
    expect(categoryColorClass("inaccuracy")).toBe("cat-inaccuracy");
    expect(categoryColorClass("mistake")).toBe("cat-mistake");
    expect(categoryColorClass("blunder")).toBe("cat-blunder");
    expect(categoryColorClass("missedwin")).toBe("cat-blunder");
    expect(categoryColorClass("opening")).toBe("cat-opening"); // shade of brown
    expect(categoryColorClass(null)).toBe("");
  });

  test("categoryBgClass (opaque light badge circles)", () => {
    expect(categoryBgClass("brilliant")).toBe("bg-blue-200");
    expect(categoryBgClass("best")).toBe("bg-emerald-200");
    expect(categoryBgClass("excellent")).toBe("bg-emerald-200");
    expect(categoryBgClass("good")).toBe("bg-emerald-200");
    expect(categoryBgClass("great")).toBe("bg-sky-200");
    expect(categoryBgClass("inaccuracy")).toBe("bg-yellow-200");
    expect(categoryBgClass("mistake")).toBe("bg-orange-200");
    expect(categoryBgClass("blunder")).toBe("bg-red-200");
    expect(categoryBgClass("missedwin")).toBe("bg-red-200");
    expect(categoryBgClass("opening")).toBe("bg-amber-200"); // light tan
    expect(categoryBgClass(null)).toBe("");
  });

  test("categoryDarkClass (badge symbol on the light circle)", () => {
    expect(categoryDarkClass("brilliant")).toBe("text-blue-800");
    expect(categoryDarkClass("best")).toBe("text-emerald-800");
    expect(categoryDarkClass("good")).toBe("text-emerald-800");
    expect(categoryDarkClass("missedwin")).toBe("text-red-800");
    expect(categoryDarkClass("opening")).toBe("text-amber-900"); // dark brown
    expect(categoryDarkClass(null)).toBe("text-white");
  });
});

describe("formatEval", () => {
  test("white/black perspective", () => {
    expect(formatEval({ cp: 50 }, "w")).toBe("+0.5");
    expect(formatEval({ cp: 50 }, "b")).toBe("-0.5");
    expect(formatEval({ mate: 2 }, "w")).toBe("M1");
    expect(formatEval({ mate: -2 }, "b")).toBe("M1");
    expect(formatEval({ mate: 4 }, "w")).toBe("M2");
    expect(formatEval(null, "w")).toBe("-");
  });
});
