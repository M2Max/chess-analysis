import { describe, expect, test } from "bun:test";
import {
  accuracyForGames,
  accuracyHistogram,
  eloSeries,
  mistakesByClass,
  openingStats,
  pickTab,
  resultsByHour,
  resultsFor,
  summariesFromRows,
  winrateByGap,
  type GameSummary,
} from "../src/stats/statsData";
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
  };
}

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

describe("accuracyHistogram", () => {
  test("buckets per-move accuracies", () => {
    const games = [
      game({ userAccs: [40, 50, 70, 85, 95, 100, 94, 71] }),
    ];
    const h = accuracyHistogram(games);
    // 40→<50 · 50→50–70 · 70,71→70–85 · 85,94→85–95 · 95,100→95–100
    expect(h.map((b) => b.count)).toEqual([1, 1, 2, 2, 2]);
  });
});

describe("mistakesByClass", () => {
  test("averages weak moves and blunders per game", () => {
    const games = [
      game({
        id: "1",
        timeClass: "blitz",
        counts: { inaccuracy: 1, mistake: 1, blunder: 2 },
      }),
      game({ id: "2", timeClass: "blitz", counts: { blunder: 1 } }),
      game({ id: "3", timeClass: "bullet", counts: { inaccuracy: 4 } }),
    ];
    const rows = mistakesByClass(games);
    const blitz = rows.find((r) => r.tab === "blitz")!;
    expect(blitz.games).toBe(2);
    expect(blitz.avgWeak).toBe(1); // (2 + 0) / 2
    expect(blitz.avgBlunders).toBe(1.5);
    const bullet = rows.find((r) => r.tab === "bullet")!;
    expect(bullet.avgWeak).toBe(4);
    expect(rows.map((r) => r.tab)).not.toContain("rapid"); // no rapid games
  });
});

describe("winrateByGap", () => {
  test("buckets by opponent rating gap", () => {
    const games = [
      game({ id: "1", youWhite: true, whiteRating: 1200, blackRating: 1400, result: "1-0" }), // vs stronger, win
      game({ id: "2", youWhite: true, whiteRating: 1200, blackRating: 1250, result: "0-1" }), // even, loss
      game({ id: "3", youWhite: false, whiteRating: 1000, blackRating: 1200, result: "0-1" }), // vs weaker, win (black)
    ];
    const rows = winrateByGap(games);
    expect(rows[0]).toMatchObject({ gap: "stronger", total: 1, wins: 1 });
    expect(rows[1]).toMatchObject({ gap: "even", total: 1, wins: 0 });
    expect(rows[2]).toMatchObject({ gap: "weaker", total: 1, wins: 1 });
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
      moves: over.moves ?? [
        { ply: 0, color: "w", delta: 0, category: "opening" },
        { ply: 1, color: "b", delta: 0, category: "best" },
        { ply: 2, color: "w", delta: 120, category: "mistake" },
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
