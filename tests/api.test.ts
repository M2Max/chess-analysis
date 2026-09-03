import { describe, expect, test, afterAll } from "bun:test";
import {
  filterLast30Days,
  fetchLast30DaysGames,
  fetchProfile,
  monthKeysForDate,
  normalizeGames,
  normalizeUsername,
  UnknownPlayerError,
} from "../src/api/games";

const NOW = new Date(2026, 1, 15); // 2026-02-15 → months 2026/02 + 2026/01
const day = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m, d) / 1000);

/** Current API shape: uuid / end_time / rules / accuracies, result in PGN. */
function rawGame(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    uuid: "g1",
    url: "https://example.com/game/live/g1",
    end_time: day(2026, 1, 10),
    white: { username: "alice", rating: 1500 },
    black: { username: "bob", rating: 1400 },
    rules: "chess",
    time_class: "blitz",
    time_control: "180",
    pgn: '[Event "Live Chess"]\n[Result "1-0"]\n\n1. e4 e5',
    ...overrides,
  };
}

// ------------------------------------------------------------------ pure fns

describe("monthKeysForDate", () => {
  test("current + previous month", () => {
    expect(monthKeysForDate(NOW)).toEqual(["2026/02", "2026/01"]);
    expect(monthKeysForDate(new Date(2026, 0, 31))).toEqual(["2026/01", "2025/12"]);
    expect(monthKeysForDate(new Date(2025, 11, 1))).toEqual(["2025/12", "2025/11"]);
  });
});

describe("filterLast30Days", () => {
  test("keeps games inside the window, newest first", () => {
    const out = filterLast30Days(
      [
        rawGame({ uuid: "old", end_time: day(2026, 0, 10) }), // 36 days before Feb 15
        rawGame({ uuid: "jan", end_time: day(2026, 0, 20) }), // in window
        rawGame({ uuid: "feb", end_time: day(2026, 1, 10) }), // in window, newest
      ],
      NOW.getTime(),
    );
    expect(out.map((g) => g.id)).toEqual(["feb", "jan"]);
  });

  test("dedupes by id", () => {
    const out = filterLast30Days([rawGame({ uuid: "x" }), rawGame({ uuid: "x" })], NOW.getTime());
    expect(out).toHaveLength(1);
  });

  test("excludes non-standard variants", () => {
    const out = filterLast30Days(
      [rawGame({ uuid: "a", rules: "chess960" }), rawGame({ uuid: "b", rules: "chess" })],
      NOW.getTime(),
    );
    expect(out.map((g) => g.id)).toEqual(["b"]);
  });

  test("boundary: exactly 30 days ago is included", () => {
    const cutoff = NOW.getTime() - 30 * 86_400_000;
    const out = filterLast30Days([rawGame({ uuid: "edge", end_time: Math.floor(cutoff / 1000) })], NOW.getTime());
    expect(out).toHaveLength(1);
  });

  test("still accepts the legacy id/utc/variant shape", () => {
    const out = filterLast30Days(
      [
        { id: "leg1", utc: day(2026, 1, 10), variant: "chess", url: "u", pgn: "1. e4" },
        { id: "leg2", utc: day(2026, 1, 11), variant: "chess3check", url: "u", pgn: "1. e4" },
      ],
      NOW.getTime(),
    );
    expect(out.map((g) => g.id)).toEqual(["leg1"]);
    expect(out[0].result).toBe("*");
  });

  test("reads the result from the PGN when no top-level field exists", () => {
    const out = filterLast30Days(
      [rawGame({ uuid: "r", pgn: '[Result "0-1"]\n\n1. e4 e5' })],
      NOW.getTime(),
    );
    expect(out[0].result).toBe("0-1");
    expect(out[0].variant).toBe("chess");
  });
});

describe("normalizeGames", () => {
  test("array form", () => {
    expect(normalizeGames({ games: [1, 2] })).toEqual([1, 2]);
  });
  test("single-object form", () => {
    expect(normalizeGames({ games: { id: "1" } })).toEqual([{ id: "1" }]);
  });
  test("missing", () => {
    expect(normalizeGames({})).toEqual([]);
    expect(normalizeGames(null)).toEqual([]);
  });
});

describe("normalizeUsername", () => {
  test("trims, strips @ and lowercases (API path queries are case-sensitive)", () => {
    expect(normalizeUsername("  @Magnus  ")).toBe("magnus");
    expect(normalizeUsername("Mamox43")).toBe("mamox43");
    expect(normalizeUsername("magnus")).toBe("magnus");
  });
});

// ------------------------------------------------------------------ fetch

type FetchMock = (url: string) => Promise<Response>;

const realFetch = fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(fn: FetchMock) {
  globalThis.fetch = (async (input: RequestInfo | URL) => fn(String(input))) as typeof fetch;
}

describe("fetchProfile", () => {
  test("maps profile", async () => {
    mockFetch(async (url) => {
      expect(url).toBe("https://api.chess.com/pub/player/magnus");
      return Response.json({
        id: "1",
        name: "Magnus Carlsen",
        username: "magnus",
        title: "GM",
        last: { rating: 2800 },
      });
    });
    const p = await fetchProfile("@magnus ");
    expect(p).toEqual({ name: "Magnus Carlsen", username: "magnus", rating: 2800, title: "GM" });
  });

  test("404 → UnknownPlayerError", async () => {
    mockFetch(async () => Response.json({ error: "Not found" }, { status: 404 }));
    await expect(fetchProfile("nosuchplayer123456")).rejects.toBeInstanceOf(UnknownPlayerError);
  });
});

describe("fetchLast30DaysGames", () => {
  test("merges both months, filters to 30 days, dedupes", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/games/2026/02")) {
        return Response.json({
          games: [rawGame({ uuid: "feb" }), rawGame({ uuid: "dup", end_time: day(2026, 1, 2) })],
        });
      }
      if (url.endsWith("/games/2026/01")) {
        return Response.json({
          games: [rawGame({ uuid: "dup", end_time: day(2026, 1, 2) }), rawGame({ uuid: "jan", end_time: day(2026, 0, 20) })],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await fetchLast30DaysGames("alice", NOW);
    expect(res.truncated).toBe(false);
    expect(res.games.map((g) => g.id)).toEqual(["feb", "dup", "jan"]);
  });

  test("retries transient 'Data provider not found', then succeeds", async () => {
    let calls = 0;
    mockFetch(async (url) => {
      if (url.endsWith("/games/2026/02")) {
        calls++;
        if (calls === 1) {
          return Response.json({ code: 0, error: true, message: "Data provider not found" });
        }
        return Response.json({ games: [rawGame({ uuid: "ok" })] });
      }
      return Response.json({ games: [] });
    });
    const res = await fetchLast30DaysGames("alice", NOW);
    expect(calls).toBe(2);
    expect(res.games.map((g) => g.id)).toEqual(["ok"]);
  });

  test("previous-month 404 is tolerated", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/games/2026/01")) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json({ games: [rawGame({ uuid: "cur" })] });
    });
    const res = await fetchLast30DaysGames("alice", NOW);
    expect(res.games.map((g) => g.id)).toEqual(["cur"]);
  });

  test("current-month 404 → UnknownPlayerError (player does not exist)", async () => {
    mockFetch(async () => Response.json({ error: "Not found" }, { status: 404 }));
    await expect(fetchLast30DaysGames("nosuchplayer123456", NOW)).rejects.toBeInstanceOf(UnknownPlayerError);
  });

  test("flags truncation at the 200-game monthly cap", async () => {
    const many = Array.from({ length: 200 }, (_, i) => rawGame({ uuid: `g${i}`, end_time: day(2026, 1, 1) }));
    mockFetch(async (url) => {
      if (url.endsWith("/games/2026/02")) return Response.json({ games: many });
      return Response.json({ games: [] });
    });
    const res = await fetchLast30DaysGames("alice", NOW);
    expect(res.truncated).toBe(true);
    expect(res.games).toHaveLength(200);
  });
});
