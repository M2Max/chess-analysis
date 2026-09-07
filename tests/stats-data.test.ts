import { describe, expect, test } from "bun:test";
import {
  accuracyForGames,
  clockStats,
  conversionStats,
  eloSeries,
  expectedScore,
  gapCurve,
  improvementTrend,
  motifStats,
  openingStats,
  performanceRating,
  phaseStats,
  pickTab,
  resultsByHour,
  resultsFor,
  summariesFromRows,
  type GameSummary,
} from "../src/stats/statsData";
import type { ImproveBlock } from "../src/stats/improve";
import type { Motif } from "../src/stats/motifs";
import type { StatsGameRow } from "../src/stats/statsRows";

function game(p: Partial<GameSummary>): GameSummary {
  return {
    id: p.id ?? "g",
    utc: p.utc ?? 1000,
    timeClass: p.timeClass ?? "blitz",
    timeControl: p.timeControl ?? "3+2",
    result: p.result ?? "1-0",
    youWhite: p.youWhite ?? true,
    whiteRating: p.whiteRating ?? null,
    blackRating: p.blackRating ?? null,
    oppName: p.oppName ?? "Opp",
    moves: p.moves ?? 40,
    counts: p.counts ?? {},
    userAccs: p.userAccs ?? [],
    userAcc: p.userAcc ?? null,
    opening: p.opening ?? null,
    imp: p.imp ?? null,
  };
}

/** Minimal improve block for aggregation tests. */
function imp(p: Partial<ImproveBlock>): ImproveBlock {
  return {
    term: "resign",
    wp: p.wp ?? [50, 50],
    wpStart: 50,
    endPly: p.endPly ?? null,
    bookPly: p.bookPly ?? 0,
    clocks: p.clocks ?? { initial: 0, spent: [], remaining: [], increment: 0 },
    motifs: p.motifs ?? [],
    drop: p.drop ?? null,
    peak: p.peak ?? { wp: 50, ply: 0 },
    worst: p.worst ?? { wp: 50, ply: 0 },
  };
}

const motif = (ply: number, m: Motif, drop: number) => ({
  ply,
  san: "Qd5",
  motif: m,
  drop,
  bestSan: "Qe7",
  remaining: null,
});

describe("resultsFor / pickTab", () => {
  const games = [
    game({ id: "1", youWhite: true, result: "1-0", timeClass: "blitz" }), // W (white)
    game({ id: "2", youWhite: false, result: "0-1", timeClass: "blitz" }), // W (black)
    game({ id: "3", youWhite: true, result: "1/2-1/2", timeClass: "bullet" }), // D
    game({ id: "4", youWhite: false, result: "1-0", timeClass: "bullet" }), // L
    game({ id: "5", youWhite: true, result: "0-1", timeClass: "rapid" }), // L
  ];

  test("overall + per-side", () => {
    const r = resultsFor(games);
    expect(r.all).toMatchObject({ total: 5, wins: 2, draws: 1, losses: 2 });
    expect(r.all.winrate).toBeCloseTo(0.4);
    expect(r.white).toMatchObject({ total: 3, wins: 1, draws: 1, losses: 1 });
    expect(r.black).toMatchObject({ total: 2, wins: 1, draws: 0, losses: 1 });
    expect(r.black.winrate).toBeCloseTo(0.5);
  });

  test("empty", () => {
    const r = resultsFor([]);
    expect(r.all.winrate).toBeNull();
    expect(r.all.total).toBe(0);
  });

  test("pickTab filters by class (incl. derived from time control)", () => {
    expect(pickTab(games, "all").length).toBe(5);
    expect(pickTab(games, "bullet").map((g) => g.id)).toEqual(["3", "4"]);
    expect(pickTab(games, "blitz").length).toBe(2);
    expect(pickTab(games, "rapid").length).toBe(1);
    expect(pickTab(games, "long")).toEqual([]);
    // missing timeClass → derived from timeControl
    const derived = [game({ id: "x", timeClass: "", timeControl: "600" })];
    expect(pickTab(derived, "rapid").length).toBe(1);
  });
});

describe("accuracyForGames", () => {
  test("averages per-move accuracies, split by the user's colour", () => {
    const games = [
      game({ id: "1", youWhite: true, userAccs: [80, 100], userAcc: 90 }),
      game({ id: "2", youWhite: false, userAccs: [60], userAcc: 60 }),
      game({ id: "3", youWhite: true, userAccs: [], userAcc: null }), // unanalysed
    ];
    const a = accuracyForGames(games);
    expect(a.avg).toBe(Math.round((80 + 100 + 60) / 3)); // 80
    expect(a.white).toBe(90);
    expect(a.black).toBe(60);
    expect(a.analyzedGames).toBe(2);
    expect(a.totalMoves).toBe(3);
  });

  test("no analysed moves → nulls", () => {
    const a = accuracyForGames([game({})]);
    expect(a.avg).toBeNull();
    expect(a.analyzedGames).toBe(0);
  });
});

describe("openingStats", () => {
  test("groups by opening, sorts by frequency, no-book last", () => {
    const sic = { eco: "B90", name: "Sicilian: Najdorf", depth: 7 };
    const games = [
      game({ id: "1", opening: sic, result: "1-0", youWhite: true, userAccs: [90] }),
      game({ id: "2", opening: sic, result: "0-1", youWhite: true, userAccs: [70] }),
      game({ id: "3", opening: sic, result: "1/2-1/2", youWhite: false, userAccs: [] }),
      game({ id: "4", opening: null, result: "1-0", youWhite: false }),
    ];
    const rows = openingStats(games);
    expect(rows[0].name).toBe("Sicilian: Najdorf");
    expect(rows[0]).toMatchObject({ count: 3, wins: 1, draws: 1, losses: 1 });
    expect(rows[0].winrate).toBeCloseTo(1 / 3);
    expect(rows[0].acc).toBe(80);
    // g4 lost as black → the no-book row is 1 loss (null eco/name, localized at render)
    expect(rows[1]).toMatchObject({ eco: null, name: null, count: 1, losses: 1, wins: 0 });
  });
});

describe("eloSeries", () => {
  test("per class, sorted by time, skips missing ratings", () => {
    const games = [
      game({ id: "1", utc: 3000, timeClass: "blitz", youWhite: true, whiteRating: 1200, blackRating: 1100 }),
      game({ id: "2", utc: 1000, timeClass: "blitz", youWhite: false, whiteRating: 1000, blackRating: 1150 }),
      game({ id: "3", utc: 2000, timeClass: "bullet", youWhite: true, whiteRating: 1180, blackRating: 900 }),
      game({ id: "4", utc: 2500, timeClass: "rapid", youWhite: true, whiteRating: null, blackRating: 900 }),
    ];
    const s = eloSeries(games);
    expect(s.blitz).toEqual([
      { t: 1000, rating: 1150 }, // black game → black rating
      { t: 3000, rating: 1200 },
    ]);
    expect(s.bullet).toEqual([{ t: 2000, rating: 1180 }]);
    expect(s.rapid).toEqual([]); // no rating
    expect(s.long).toEqual([]);
  });
});

describe("performanceRating / expectedScore", () => {
  test("equal-score set returns ~average opponent", () => {
    const games = [
      game({ id: "1", youWhite: true, whiteRating: 1200, blackRating: 1200, result: "1-0" }),
      game({ id: "2", youWhite: true, whiteRating: 1200, blackRating: 1200, result: "0-1" }),
      game({ id: "3", youWhite: true, whiteRating: 1200, blackRating: 1200, result: "1/2-1/2" }),
      game({ id: "4", youWhite: true, whiteRating: 1200, blackRating: 1200, result: "1-0" }),
      game({ id: "5", youWhite: true, whiteRating: 1200, blackRating: 1200, result: "0-1" }),
    ];
    expect(performanceRating(games)).toBeCloseTo(1200, -1);
  });
  test("too few games → null", () => {
    expect(performanceRating([game({}), game({ id: "2" })])).toBeNull();
  });
  test("expected score anchors", () => {
    expect(expectedScore(0)).toBeCloseTo(0.5);
    expect(expectedScore(200)).toBeCloseTo(0.759, 2);
    expect(expectedScore(-200)).toBeCloseTo(0.241, 2);
  });
});

describe("gapCurve", () => {
  test("buckets, actual vs expected, pr delta", () => {
    const games = [
      game({ id: "1", youWhite: true, whiteRating: 1200, blackRating: 1200, result: "1-0" }), // mid 0
      game({ id: "2", youWhite: true, whiteRating: 1200, blackRating: 1210, result: "1-0" }), // mid 0
      game({ id: "3", youWhite: true, whiteRating: 1200, blackRating: 1190, result: "1-0" }), // mid 0
      game({ id: "4", youWhite: true, whiteRating: 1600, blackRating: 1200, result: "1-0" }), // mid +450
    ];
    const rows = gapCurve(games);
    const even = rows.find((r) => r.mid === 0)!;
    expect(even).toMatchObject({ n: 3, wins: 3, actual: 1 });
    expect(even.pr).not.toBeNull();
    expect(even.pr!).toBeGreaterThan(300); // 100% vs equal → big positive perf
    const strong = rows.find((r) => r.mid === 450)!;
    expect(strong.n).toBe(1);
  });
});

describe("conversionStats", () => {
  test("won-from-won, saved-from-lost, thrown wins", () => {
    const games = [
      game({ id: "1", result: "1-0", imp: imp({ peak: { wp: 92, ply: 20 }, worst: { wp: 50, ply: 0 } }) }),
      game({ id: "2", result: "0-1", oppName: "Bad", imp: imp({ peak: { wp: 90, ply: 10 }, worst: { wp: 5, ply: 40 } }) }),
      game({ id: "3", result: "1/2-1/2", imp: imp({ peak: { wp: 50, ply: 0 }, worst: { wp: 10, ply: 30 } }) }),
      game({ id: "4", result: "0-1", imp: imp({ peak: { wp: 40, ply: 5 }, worst: { wp: 60, ply: 1 } }) }), // black worst flipped
    ];
    const c = conversionStats(games);
    expect(c.reachedWon).toBe(2);
    expect(c.wonWon).toBe(1);
    expect(c.thrown.map((g) => g.id)).toEqual(["2"]);
    expect(c.savedLost).toBe(1); // g3 reached 10 and drew
    expect(c.reachedLost).toBe(2); // g2 (5) + g3 (10)
  });
});

describe("phaseStats", () => {
  test("splits user moves by book/endgame ply", () => {
    // white: plies 0,1,2,3,4,5 - bookPly 2 → opening plies 0-1, endPly 4 → endgame 4-5
    const g = game({
      id: "1",
      youWhite: true,
      userAccs: [90, 80, 70, 60, 50, 40],
      imp: imp({
        bookPly: 2,
        endPly: 4,
        wp: [60, 50, 45, 40, 38, 30],
        motifs: [motif(2, "hang", 12)],
      }),
    });
    const rows = phaseStats([g]);
    const byPhase = Object.fromEntries(rows.map((r) => [r.phase, r]));
    // white owns plies 0,2,4 of this 6-ply game: opening / middlegame / endgame
    expect(byPhase.opening.acc).toBe(90); // ply 0 (< bookPly 2)
    expect(byPhase.middlegame?.acc).toBe(80); // ply 2 (userAccs[1])
    expect(byPhase.endgame?.acc).toBe(70); // ply 4 (>= endPly 4, userAccs[2])
    expect(byPhase.middlegame?.bad).toBe(1); // motif at ply 2
    expect(byPhase.endgame!.leakPer30).toBeGreaterThan(0);
  });
});

describe("clockStats", () => {
  test("buckets mistakes by remaining time", () => {
    const clocks = {
      initial: 180,
      increment: 0,
      spent: [5, 5, 5, 5, 5, 5],
      remaining: [175, 170, 165, 15, 10, 150], // remaining after each ply
    };
    // user = white: plies 0,2,4 - ply 0 has no "remaining before" and is skipped 
    const g = game({
      id: "1",
      youWhite: true,
      userAccs: [50, 50, 50],
      imp: imp({
        clocks,
        wp: [40, 50, 30, 50, 20, 50],
        motifs: [motif(2, "hang", 20), motif(4, "timePressure", 12)],
      }),
    });
    const c = clockStats([g]);
    expect(c.moves).toBe(2);
    // ply 2 played with 170 s left, ply 4 with 15 s
    expect(c.badLt20).toBe(1);
    expect(c.badGt60).toBe(1);
    expect(c.bad20To60).toBe(0);
  });
});

describe("motifStats", () => {
  test("cost per cause, sorted desc, shares sum to 1", () => {
    const games = [
      game({ id: "1", imp: imp({ motifs: [motif(2, "hang", 40), motif(8, "fork", 10)] }) }),
      game({ id: "2", imp: imp({ motifs: [motif(4, "hang", 50)] }) }),
    ];
    const rows = motifStats(games);
    expect(rows[0].motif).toBe("hang");
    expect(rows[0].n).toBe(2);
    expect(rows[0].points).toBeCloseTo(0.9); // (40+50)/100
    expect(rows[0].share).toBeCloseTo(0.9, 2);
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1);
  });
});

describe("improvementTrend", () => {
  test("rolling window + slope direction", () => {
    const games = Array.from({ length: 40 }, (_, i) =>
      game({ id: `g${i}`, utc: 1000 + i * 100, userAcc: 60 + Math.floor(i / 4), imp: imp({}) }),
    );
    const tr = improvementTrend(games, 10);
    expect(tr.points.length).toBe(40);
    expect(tr.from).toBe(61); // rolling window at index 9
    expect(tr.to).toBe(68);
    expect(tr.slope20).not.toBeNull();
    expect(tr.slope20!).toBeGreaterThan(2);
  });
});

describe("summariesFromRows (server rows → GameSummary)", () => {
  const row = (over: Partial<StatsGameRow> = {}): StatsGameRow => {
    const youWhite = over.youWhite ?? true;
    return {
      id: over.id ?? "r1",
      utc: over.utc ?? 1_750_000_000,
      result: over.result ?? "1-0",
      timeClass: over.timeClass ?? "blitz",
      timeControl: over.timeControl ?? "3+2",
      whiteUsername: over.whiteUsername ?? (youWhite ? "Me" : "opp"),
      blackUsername: over.blackUsername ?? (youWhite ? "opp" : "Me"),
      whiteRating: over.whiteRating ?? 1200,
      blackRating: over.blackRating ?? 1150,
      youWhite,
      analyzed: over.analyzed ?? true,
      opening: over.opening ?? { eco: "C20", name: "King's Pawn Game", depth: 2 },
      whiteAcc: over.whiteAcc ?? null,
      blackAcc: over.blackAcc ?? null,
      pgn: over.pgn ?? "",
      moves: over.moves ?? [
        { ply: 0, color: "w", san: "e4", delta: 0, category: "opening", bestUci: null, bestSan: null, scoreCp: 30, scoreMate: null, bestMate: null },
        { ply: 1, color: "b", san: "e5", delta: 0, category: "best", bestUci: null, bestSan: null, scoreCp: -20, scoreMate: null, bestMate: null },
        { ply: 2, color: "w", san: "Nf3", delta: 120, category: "mistake", bestUci: null, bestSan: "d4", scoreCp: -140, scoreMate: null, bestMate: null },
      ],
    };
  };

  test("maps analysed rows to summaries (user's perspective)", () => {
    const out = summariesFromRows([row()]);
    const s = out["r1"]!;
    expect(s.youWhite).toBe(true);
    expect(s.oppName).toBe("opp");
    expect(s.moves).toBe(3);
    expect(s.counts).toEqual({ opening: 1, best: 1, mistake: 1 });
    // opening move = 100, mistake (delta 120 vs 1200) < 100
    expect(s.userAccs[0]).toBe(100);
    expect(s.userAccs[1]).toBeLessThan(100);
    expect(s.userAcc).not.toBeNull();
    expect(s.opening?.eco).toBe("C20");
  });

  test("black's perspective flips opp + side", () => {
    const out = summariesFromRows([
      row({ id: "r2", youWhite: false, whiteUsername: "opp", blackUsername: "Me" }),
    ]);
    const s = out["r2"]!;
    expect(s.youWhite).toBe(false);
    expect(s.oppName).toBe("opp");
    // only the opponent's ply-1 move is the user's
    expect(s.userAccs).toHaveLength(1);
  });

  test("unanalysed rows are skipped (runner treats absence = to analyse)", () => {
    expect(summariesFromRows([row({ id: "r3", analyzed: false, moves: [] })])).toEqual({});
  });

  test("null ratings degrade gracefully", () => {
    const out = summariesFromRows([row({ id: "r4", whiteRating: null, blackRating: null })]);
    expect(out["r4"]).toBeDefined();
    expect(out["r4"]!.userAcc).not.toBeNull();
  });
});

describe("resultsByHour", () => {
  test("distributes results over 24 local hours", () => {
    const t = new Date();
    t.setHours(7, 30, 0, 0);
    const t2 = new Date();
    t2.setHours(22, 0, 0, 0);
    const games = [
      game({ id: "1", utc: Math.floor(t.getTime() / 1000), result: "1-0", youWhite: true }),
      game({ id: "2", utc: Math.floor(t2.getTime() / 1000), result: "0-1", youWhite: true }),
      game({ id: "3", utc: Math.floor(t2.getTime() / 1000), result: "1/2-1/2", youWhite: false }),
    ];
    const h = resultsByHour(games);
    expect(h.length).toBe(24);
    expect(h[7]).toMatchObject({ wins: 1, draws: 0, losses: 0 });
    // g2 lost (white), g3 drew (black)
    expect(h[22]).toMatchObject({ wins: 0, draws: 1, losses: 1 });
    const total = h.reduce((s, r) => s + r.wins + r.draws + r.losses, 0);
    expect(total).toBe(3);
  });
});
