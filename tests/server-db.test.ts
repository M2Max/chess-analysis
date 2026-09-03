/**
 * Server SQLite layer tests (bun:sqlite - no WASM, no network).
 *
 * Uses a throwaway database in the OS temp dir; the module reads
 * DATABASE_PATH lazily, so it is set before the first getDb().
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAnalysis,
  getGamesForPlayer,
  getStatsForPlayer,
  listIsFresh,
  listPlayers,
  saveAnalysisForGame,
  setDbPathForTests,
  upsertList,
  upsertPlayer,
} from "../server/db";
import type { Game } from "../src/api/games";
import type { CachedAnalysis } from "../src/api/analysisCache";

const DB_FILE = join(tmpdir(), `chess-analysis-test-${process.pid}-${Date.now()}.db`);
beforeAll(() => setDbPathForTests(DB_FILE));

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let n = 0;
function game(over: Partial<Game> = {}): Game {
  n += 1;
  return {
    id: `game-${n}`,
    url: "",
    utc: 1_750_000_000 + n * 3_600,
    result: "1-0",
    variant: "chess",
    timeControl: "3+2",
    timeClass: "blitz",
    white: { username: "Mamox43", name: "M. Amone", rating: 1190 },
    black: { username: `opp${n}`, name: "Opp", rating: 1200 },
    pgn: "1. e4 e5 2. Nf3",
    ...over,
  };
}

function entry(
  engine: "lite" | "full",
  mode: "fast" | "deep",
  opts: Partial<CachedAnalysis> = {},
): CachedAnalysis {
  return {
    v: 2,
    engine,
    mode,
    savedAt: Date.now(),
    whiteAcc: 88,
    blackAcc: 76,
    opening: { eco: "C20", name: "King's Pawn Game", depth: 2 },
    moves: [
      {
        san: "e4",
        uci: "e2e4",
        color: "w",
        delta: 0,
        loss: 0,
        category: "best",
        bestUci: "e2e4",
        bestSan: "e4",
        score: { cp: 30 },
        multi: [{ uci: "e2e4", score: { cp: 30 }, pv: ["e2e4", "e7e5"] }],
      },
      {
        san: "e5",
        uci: "e7e5",
        color: "b",
        delta: 12,
        loss: 0.02,
        category: "good",
        bestUci: null,
        bestSan: null,
        score: { mate: -8 },
        multi: [],
      },
    ],
    ...opts,
  };
}

describe("server/db - migrations & players", () => {
  it("opens, migrates idempotently and lists players", () => {
    const id1 = upsertPlayer("Mamox43");
    const id2 = upsertPlayer("mamox43"); // case-insensitive same player
    expect(id1).toBe(id2);
    upsertPlayer("SomeoneElse");
    const players = listPlayers();
    expect(players.map((p) => p.username)).toContain("Mamox43");
    expect(players).toHaveLength(2);
    // second open (same process) - migrations must not re-run
    const d2 = require("../server/db").getDb();
    expect(d2).toBeDefined();
  });
});

describe("server/db - list fetches & history", () => {
  it("stores games, links them to the player and serves the window", () => {
    const g1 = game({ utc: 1_750_100_000 });
    const g2 = game({ utc: 1_750_200_000, timeClass: "bullet", timeControl: "1+0" });
    const playerId = upsertPlayer("Alice");
    upsertList(playerId, [g1, g2], { fetchedAt: Date.now(), truncated: false, fromUtc: 1, toUtc: 2 });

    const all = getGamesForPlayer("Alice");
    expect(all?.games).toHaveLength(2);
    expect(all?.truncated).toBe(false);
    // newest first
    expect(all?.games[0].id).toBe(g2.id);
    // round-tripped fields
    expect(all?.games[0].white.rating).toBe(1190);
    expect(all?.games[0].timeControl).toBe("1+0");

    // window filter (history-agnostic: 30 days is just a bound)
    const windowed = getGamesForPlayer("Alice", { fromUtc: g2.utc });
    expect(windowed?.games.map((g) => g.id)).toEqual([g2.id]);

    // re-fetching the same run must not duplicate
    upsertList(playerId, [g1, g2], { fetchedAt: Date.now(), truncated: false });
    expect(getGamesForPlayer("Alice")?.games).toHaveLength(2);

    // a different player sees none of these
    expect(getGamesForPlayer("NoOne")).toBeNull();
  });

  it("listIsFresh follows the same-day rule", () => {
    expect(listIsFresh("Alice")).toBe(true); // fetched "now"
    expect(listIsFresh("NoOne")).toBe(false);
  });
});

describe("server/db - analysis store (one best combo per game)", () => {
  it("round-trips the exact CachedAnalysis shape", () => {
    const g = game();
    const playerId = upsertPlayer("Bob");
    upsertList(playerId, [g], { fetchedAt: Date.now(), truncated: false });

    const e = entry("lite", "fast");
    expect(saveAnalysisForGame(g.id, e)).toBe(true);
    const got = getAnalysis(g.id);
    expect(got).not.toBeNull();
    expect(got?.engine).toBe("lite");
    expect(got?.mode).toBe("fast");
    expect(got?.whiteAcc).toBe(88);
    expect(got?.opening).toEqual({ eco: "C20", name: "King's Pawn Game", depth: 2 });
    expect(got?.moves).toHaveLength(2);
    expect(got?.moves[0].multi).toHaveLength(1);
    expect(got?.moves[0].multi[0].pv).toEqual(["e2e4", "e7e5"]);
    expect(got?.moves[0].score).toEqual({ cp: 30 });
    expect(got?.moves[1].score).toEqual({ mate: -8 });
    expect(got?.moves[1].multi).toEqual([]);
  });

  it("keeps the strongest combo (rank guard)", () => {
    const g = game();
    const playerId = upsertPlayer("Bob");
    upsertList(playerId, [g], { fetchedAt: Date.now(), truncated: false });

    expect(saveAnalysisForGame(g.id, entry("lite", "fast"))).toBe(true);
    // weaker must not clobber
    expect(saveAnalysisForGame(g.id, entry("lite", "fast"))).toBe(true); // equal → replaces
    expect(saveAnalysisForGame(g.id, entry("full", "deep"))).toBe(true);
    expect(saveAnalysisForGame(g.id, entry("lite", "fast"))).toBe(false);
    expect(getAnalysis(g.id)?.engine).toBe("full");
    expect(getAnalysis(g.id)?.mode).toBe("deep");

    // unknown game → rejected
    expect(saveAnalysisForGame("no-such-game", entry("lite", "fast"))).toBe(false);
  });

  it("replaces moves/lines on re-analysis (no stale rows)", () => {
    const g = game();
    const playerId = upsertPlayer("Bob");
    upsertList(playerId, [g], { fetchedAt: Date.now(), truncated: false });
    saveAnalysisForGame(g.id, entry("full", "deep"));
    const shorter = entry("full", "deep", {
      moves: [
        {
          san: "d4",
          uci: "d2d4",
          color: "w",
          delta: 0,
          loss: 0,
          category: "best",
          bestUci: "d2d4",
          bestSan: "d4",
          score: null,
          multi: [],
        },
      ],
    });
    saveAnalysisForGame(g.id, shorter);
    expect(getAnalysis(g.id)?.moves).toHaveLength(1);
    expect(getAnalysis(g.id)?.moves[0].san).toBe("d4");
  });
});

describe("server/db - stats rows", () => {
  it("joins games with analyses and flags analysed games", () => {
    const g1 = game({
      utc: 1_750_300_000,
      white: { username: "Carol", name: "C.", rating: 1190 },
    });
    const g2 = game({ utc: 1_750_400_000, white: { username: "other", name: "O", rating: 1100 } });
    const playerId = upsertPlayer("Carol");
    upsertList(playerId, [g1, g2], { fetchedAt: Date.now(), truncated: false });
    saveAnalysisForGame(g1.id, entry("lite", "fast"));

    const rows = getStatsForPlayer("Carol");
    expect(rows).toHaveLength(2);
    const r1 = rows!.find((r) => r.id === g1.id)!;
    const r2 = rows!.find((r) => r.id === g2.id)!;
    expect(r1.analyzed).toBe(true);
    expect(r1.youWhite).toBe(true);
    expect(r1.moves).toHaveLength(2);
    expect(r1.opening?.eco).toBe("C20");
    expect(r1.whiteAcc).toBe(88);
    expect(r2.analyzed).toBe(false);
    expect(r2.youWhite).toBe(false); // played black vs "other"
    expect(r2.moves).toEqual([]);

    // window filter works for stats too
    const recent = getStatsForPlayer("Carol", { fromUtc: g2.utc });
    expect(recent).toHaveLength(1);
    expect(recent![0].id).toBe(g2.id);

    expect(getStatsForPlayer("NoOne")).toBeNull();
  });

  it("list rows carry the analysis meta for the UI", () => {
    const g1 = game({ utc: 1_750_500_000 });
    const playerId = upsertPlayer("Carol");
    upsertList(playerId, [g1], { fetchedAt: Date.now(), truncated: false });
    saveAnalysisForGame(g1.id, entry("full", "fast"));
    const list = getGamesForPlayer("Carol", { fromUtc: g1.utc });
    expect(list?.games[0].analysis).toEqual({
      engine: "full",
      mode: "fast",
      whiteAcc: 88,
      blackAcc: 76,
      opening: { eco: "C20", name: "King's Pawn Game", depth: 2 },
    });
  });
});
