import { describe, expect, test } from "bun:test";
import {
  accuracyFor,
  buildMainline,
  initialReviewState,
  resultLabel,
  reviewReducer,
  type ReviewState,
} from "../src/state/review";
import type { ParsedGame } from "../src/engine/parse";
import { translate } from "../src/i18n";

/** Minimal fake parsed game: start + 2 moves (e4, e5). */
const fakeParsed: ParsedGame = {
  startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  moves: [
    {
      san: "e4",
      uci: "e2e4",
      color: "w",
      fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    },
    {
      san: "e5",
      uci: "e7e5",
      color: "b",
      fenBefore: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      fenAfter: "rnbqkbnr/pppp1ppp/8/8/4p3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    },
  ],
};

function initState(): ReviewState {
  const { nodes, mainline } = buildMainline(fakeParsed);
  return reviewReducer(initialReviewState, {
    type: "INIT",
    gen: 1,
    meta: {
      white: { name: "W", username: "w" },
      black: { name: "B", username: "b" },
      result: "1-0",
      dateLabel: "now",
      timeControl: "",
      gameId: "g1",
    },
    nodes,
    mainline,
  });
}

const posDone = (index: number, score: { cp?: number; mate?: number }) => ({
  type: "POSITION_DONE",
  gen: 1,
  index,
  score,
  bestUci: "e2e4",
  bestSan: "e4",
  pv: ["e2e4"],
  depth: 15,
  multi: [],
});

const branchStart = (parentIdx: number) => ({
  type: "BRANCH_START" as const,
  parentIdx,
  move: { san: "d4", uci: "d2d4", color: "w" as const },
  fen: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
});

/** Advance analysis so that e4 is played and the cursor sits after it (line [0,1], cursor 1). */
function afterE4(): ReviewState {
  let s = initState();
  s = reviewReducer(s, posDone(0, { cp: 0 })); // start position evaluated
  s = reviewReducer(s, posDone(1, { cp: -20 })); // e4 revealed, cursor follows
  return s;
}

describe("reviewReducer", () => {
  test("INIT sets up mainline view at the start position", () => {
    const s = initState();
    expect(s.status).toBe("analyzing");
    expect(s.mainline).toEqual([0, 1, 2]);
    expect(s.line).toEqual([0]);
    expect(s.cursor).toBe(0);
    expect(s.progress).toEqual({ done: 0, total: 3 });
  });

  test("POSITION_DONE reveals moves on the mainline and follows the tip", () => {
    let s = initState();
    s = reviewReducer(s, posDone(0, { cp: 0 }));
    expect(s.line).toEqual([0]); // no move revealed yet
    expect(s.nodes[0].score).toEqual({ cp: 0 });
    s = reviewReducer(s, posDone(1, { cp: -20 }));
    expect(s.line).toEqual([0, 1]);
    expect(s.cursor).toBe(1); // was at the tip → follows
    s = reviewReducer(s, posDone(2, { cp: -40 }));
    expect(s.line).toEqual([0, 1, 2]);
    expect(s.cursor).toBe(2);
    expect(s.nodes[1].score).toEqual({ cp: -20 });
  });

  test("POSITION_DONE does not follow when the cursor is parked earlier", () => {
    let s = afterE4(); // line [0,1], cursor 1
    s = reviewReducer(s, { type: "SET_CURSOR", cursor: 0 });
    s = reviewReducer(s, posDone(2, { cp: -40 }));
    expect(s.line).toEqual([0, 1, 2]);
    expect(s.cursor).toBe(0); // stays where the user parked it
  });

  test("stale gen is ignored", () => {
    const s = initState();
    const after = reviewReducer(s, { ...posDone(0, { cp: 0 }), gen: 99 });
    expect(after).toBe(s);
  });

  test("BRANCH_START appends a node and extends the line at the cursor", () => {
    const s0 = afterE4(); // line [0,1], cursor 1 (white to move after e4)
    const before = s0.nodes.length;
    const s = reviewReducer(s0, branchStart(1));
    expect(s.nodes.length).toBe(before + 1);
    const idx = s.nodes.length - 1;
    const branch = s.nodes[idx];
    expect(branch.isMainline).toBe(false);
    expect(branch.parent).toBe(1);
    expect(branch.thinking).toBe(true);
    expect(s.line).toEqual([0, 1, idx]);
    expect(s.cursor).toBe(2);
  });

  test("BRANCH_START reuses an existing identical branch", () => {
    let s = afterE4();
    s = reviewReducer(s, branchStart(1));
    const idx = s.nodes.length - 1;
    s = reviewReducer(s, { type: "SET_CURSOR", cursor: 1 });
    s = reviewReducer(s, branchStart(1)); // same move again from same parent
    expect(s.nodes.length).toBe(idx + 1); // no new node
    expect(s.line).toEqual([0, 1, idx]);
    expect(s.cursor).toBe(2);
  });

  test("BRANCH_DONE classifies the branch move from parent + child evals", () => {
    let s = afterE4();
    const nodes = s.nodes.slice();
    nodes[1] = {
      ...nodes[1],
      bestUci: "g2g4",
      multi: [
        { uci: "g2g4", cp: 20 },
        { uci: "a2a3", cp: -70 },
      ], // mover's view: best +20
    };
    s = { ...s, nodes };
    s = reviewReducer(s, branchStart(1));
    const idx = s.nodes.length - 1;
    s = reviewReducer(s, {
      type: "BRANCH_DONE",
      gen: 1,
      nodeIdx: idx,
      score: { cp: 170 }, // child best, opponent's view → played lands at -170
      bestUci: "d7d5",
      bestSan: "d5",
      pv: ["d7d5"],
      depth: 18,
      multi: [],
    });
    const branch = s.nodes[idx];
    expect(branch.thinking).toBe(false);
    // delta = |20 - (-170)| = 190 → loss = tanh(0.002·190·1500/2200) ≈ 0.2534
    expect(branch.loss).toBeCloseTo(0.2534, 3);
    expect(branch.category).toBe("blunder");
  });

  test("BRANCH_DONE marks the move best when it matches the engine choice", () => {
    let s = afterE4();
    const nodes = s.nodes.slice();
    nodes[1] = {
      ...nodes[1],
      bestUci: "d2d4",
      multi: [
        { uci: "d2d4", cp: 0 },
        { uci: "e2e3", cp: -50 },
      ],
    };
    s = { ...s, nodes };
    s = reviewReducer(s, branchStart(1));
    const idx = s.nodes.length - 1;
    s = reviewReducer(s, {
      type: "BRANCH_DONE",
      gen: 1,
      nodeIdx: idx,
      score: { cp: 20 }, // no swing
      bestUci: "d2d4",
      bestSan: "d4",
      pv: ["d2d4"],
      depth: 18,
      multi: [],
    });
    expect(s.nodes[idx].loss).toBe(0);
    expect(s.nodes[idx].category).toBe("best"); // gap 50 ≤ 80 → not "great"
  });

  test("BRANCH_DONE flags a great branch move (gap > 80cp)", () => {
    let s = afterE4();
    const nodes = s.nodes.slice();
    nodes[1] = {
      ...nodes[1],
      bestUci: "d2d4",
      multi: [
        { uci: "d2d4", cp: 0 },
        { uci: "e2e3", cp: -100 },
      ],
    };
    s = { ...s, nodes };
    s = reviewReducer(s, branchStart(1));
    const idx = s.nodes.length - 1;
    s = reviewReducer(s, {
      type: "BRANCH_DONE",
      gen: 1,
      nodeIdx: idx,
      score: { cp: 0 },
      bestUci: "d2d4",
      bestSan: "d4",
      pv: ["d2d4"],
      depth: 18,
      multi: [],
    });
    expect(s.nodes[idx].category).toBe("great");
  });

  test("GO_MAINLINE returns to the played game at the same depth", () => {
    let s = afterE4();
    s = reviewReducer(s, branchStart(1)); // branch at depth 2, cursor 2
    expect(s.line.at(-1)).not.toBe(2);
    s = reviewReducer(s, { type: "GO_MAINLINE" });
    expect(s.line).toEqual([0, 1, 2]);
    expect(s.cursor).toBe(2);
  });

  test("SET_CURSOR clamps to the line", () => {
    const s = initState(); // line [0]
    expect(reviewReducer(s, { type: "SET_CURSOR", cursor: 99 }).cursor).toBe(0);
    expect(reviewReducer(s, { type: "SET_CURSOR", cursor: -5 }).cursor).toBe(0);
  });
});

describe("HYDRATE (cached analysis restore)", () => {
  const cachedMoves = [
    {
      san: "e4",
      uci: "e2e4",
      color: "w" as const,
      delta: 25,
      loss: 0.05,
      category: "good" as const,
      bestUci: "e2e4",
      bestSan: "e4",
      score: { cp: -20 },
      multi: [
        { uci: "e2e4", score: { cp: -20 }, pv: ["e2e4", "e7e5"] },
        { uci: "d2d4", score: { cp: -30 }, pv: ["d2d4"] },
      ],
    },
  ];

  test("fills mainline nodes with cached data", () => {
    let s = initState();
    s = reviewReducer(s, { type: "HYDRATE", gen: 1, moves: cachedMoves });
    const node = s.nodes[s.mainline[1]];
    expect(node.category).toBe("good");
    expect(node.delta).toBe(25);
    expect(node.loss).toBe(0.05);
    expect(node.bestSan).toBe("e4");
    expect(node.score).toEqual({ cp: -20 });
    // multi lines rebuilt with mate-mapped cp
    expect(node.multi).toEqual([
      { uci: "e2e4", cp: -20, score: { cp: -20 }, pv: ["e2e4", "e7e5"] },
      { uci: "d2d4", cp: -30, score: { cp: -30 }, pv: ["d2d4"] },
    ]);
    // full mainline revealed, cursor parked on the last position
    expect(s.line).toEqual(s.mainline);
    expect(s.cursor).toBe(s.mainline.length - 1);
  });

  test("accuracyFor works on hydrated state", () => {
    let s = initState();
    s = reviewReducer(s, { type: "HYDRATE", gen: 1, moves: cachedMoves });
    // moveAccuracy(25, 1500) = 83.17 → 83
    expect(accuracyFor(s, "w")).toEqual({ value: 83, moves: 1 });
  });

  test("stale generation is ignored", () => {
    let s = initState();
    s = reviewReducer(s, { type: "HYDRATE", gen: 99, moves: cachedMoves });
    expect(s.nodes[s.mainline[1]].category).toBeNull();
  });
});

describe("accuracyFor", () => {
  test("null when the side has no classified moves", () => {
    const s = initState();
    expect(accuracyFor(s, "w")).toEqual({ value: null, moves: 0 });
  });

  test("best move (delta 0) → 100", () => {
    let s = afterE4();
    s = reviewReducer(s, { type: "MOVE_CLASSIFIED", gen: 1, moveIndex: 0, loss: 0, delta: 0, category: "best" });
    expect(accuracyFor(s, "w")).toEqual({ value: 100, moves: 1 });
  });

  test("distance from the engine: 25cp → 83 (rating 1500 default)", () => {
    let s = afterE4();
    s = reviewReducer(s, { type: "MOVE_CLASSIFIED", gen: 1, moveIndex: 0, loss: 0.03, delta: 25, category: "good" });
    // moveAccuracy(25, 1500) = 83.17
    expect(accuracyFor(s, "w")).toEqual({ value: 83, moves: 1 });
  });

  test("huge blunders floor near 10", () => {
    let s = afterE4();
    s = reviewReducer(s, { type: "MOVE_CLASSIFIED", gen: 1, moveIndex: 0, loss: 0.75, delta: 400, category: "blunder" });
    // moveAccuracy(400, 1500) = 13.28 → 13
    expect(accuracyFor(s, "w")).toEqual({ value: 13, moves: 1 });
  });

  test("near-best moves keep a high score (5cp → 96)", () => {
    let s = afterE4();
    s = reviewReducer(s, { type: "MOVE_CLASSIFIED", gen: 1, moveIndex: 0, loss: 0.01, delta: 5, category: "excellent" });
    // moveAccuracy(5, 1500) = 96.35 → 96
    expect(accuracyFor(s, "w")).toEqual({ value: 96, moves: 1 });
  });

  test("multiple blunders: each extra blunder counts at half the penalty", () => {
    // 4-move fake game so white has two moves (e4, Nf3)
    const p4: ParsedGame = {
      startFen: fakeParsed.startFen,
      moves: [
        ...fakeParsed.moves,
        {
          san: "Nf3",
          uci: "g1f3",
          color: "w",
          fenBefore: fakeParsed.moves[1].fenAfter,
          fenAfter: fakeParsed.moves[1].fenAfter,
        },
        {
          san: "Nc6",
          uci: "b8c6",
          color: "b",
          fenBefore: fakeParsed.moves[1].fenAfter,
          fenAfter: fakeParsed.moves[1].fenAfter,
        },
      ],
    };
    const { nodes, mainline } = buildMainline(p4);
    let s = reviewReducer(initialReviewState, {
      type: "INIT",
      gen: 1,
      meta: {
        white: { name: "W", username: "w" },
        black: { name: "B", username: "b" },
        result: "1-0",
        dateLabel: "now",
        timeControl: "",
        gameId: "g4",
      },
      nodes,
      mainline,
    });
    // white's moves are mainline indexes 1 (e4) and 3 (Nf3)
    s = reviewReducer(s, { type: "MOVE_CLASSIFIED", gen: 1, moveIndex: 0, loss: 0.5, delta: 300, category: "blunder" });
    s = reviewReducer(s, { type: "MOVE_CLASSIFIED", gen: 1, moveIndex: 2, loss: 0.5, delta: 300, category: "blunder" });
    // 1st blunder 17.5, 2nd: 100 − 82.5·0.5 = 58.75 → avg 38.13 → 38
    expect(accuracyFor(s, "w")).toEqual({ value: 38, moves: 2 });
  });

  test("other player's moves are ignored", () => {
    let s = afterE4();
    s = reviewReducer(s, { type: "MOVE_CLASSIFIED", gen: 1, moveIndex: 1, loss: 0.03, delta: 25, category: "good" });
    // that is black's move (e5)
    expect(accuracyFor(s, "w").value).toBeNull();
    expect(accuracyFor(s, "b")).toEqual({ value: 83, moves: 1 });
  });
});

describe("resultLabel", () => {
  const t = (k: Parameters<typeof translate>[1], v?: Parameters<typeof translate>[2]) => translate("en", k, v);
  test("maps results to labels", () => {
    expect(resultLabel("1-0", "W", "B", t)).toBe("W wins");
    expect(resultLabel("0-1", "W", "B", t)).toBe("B wins");
    expect(resultLabel("1/2-1/2", "W", "B", t)).toBe("Draw");
    expect(resultLabel("0-0", "W", "B", t)).toBe("In progress");
  });
});
