/**
 * HTTP-layer tests for /api/db (tests/server-api.test.ts).
 *
 * The DB-layer tests (tests/server-db.test.ts) prove the queries; this suite
 * proves the BOUNDARY: the client sends windows in unix MILLISECONDS while
 * games.utc is stored in SECONDS, the same-day freshness rule, the partial
 * flag for windows wider than the 30-day fetch, and username case
 * normalisation end-to-end. The public API is stubbed at the global fetch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDbPathForTests } from "../server/db";
import type { CachedAnalysis } from "../src/api/analysisCache";

// prevent server/index.ts from opening port 3000 when imported (bun test
// does not set a discoverable env flag, so the guard is explicit) - must be
// set before the dynamic import below
process.env.REVIEW_SERVER_NO_LISTEN = "1";

let handleDbApi: (req: Request, url: URL) => Promise<Response | null>;
beforeAll(async () => {
  ({ handleDbApi } = await import("../server/index"));
});

const realFetch = globalThis.fetch;
let chessCalls = 0;

afterAll(() => {
  globalThis.fetch = realFetch;
});

function rawGame(uuid: string, end_time: number): Record<string, unknown> {
  return {
    uuid,
    url: `https://example.com/game/live/${uuid}`,
    end_time,
    white: { username: "Player1", rating: 1500 },
    black: { username: "bob", rating: 1400 },
    rules: "chess",
    time_class: "blitz",
    time_control: "180",
    pgn: '[Event "Live Chess"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6',
  };
}

beforeAll(() => {
  setDbPathForTests(join(tmpdir(), `chess-analysis-api-${process.pid}-${Date.now()}.db`));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://api.chess.com/pub/player/player1/games/")) {
      chessCalls++;
      const now = Math.floor(Date.now() / 1000);
      return Response.json({
        games: [
          rawGame("a", now - 86_400),
          rawGame("b", now - 3 * 86_400),
          rawGame("old", now - 40 * 86_400), // outside 30 days → filtered client-side
        ],
      });
    }
    if (url.startsWith("https://api.chess.com/pub/player/ghost/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
});

const call = (path: string, init?: RequestInit) =>
  handleDbApi!(new Request(`http://srv${path}`, init), new URL(`http://srv${path}`));

const ENTRY: CachedAnalysis = {
  v: 2,
  engine: "lite",
  mode: "fast",
  savedAt: Date.now(),
  whiteAcc: 90,
  blackAcc: 80,
  opening: null,
  moves: [
    {
      san: "e4", uci: "e2e4", color: "w", delta: 0, loss: 0, category: "best",
      bestUci: "e2e4", bestSan: "e4", score: { cp: 30 },
      multi: [{ uci: "e2e4", score: { cp: 30 }, pv: ["e2e4"] }],
    },
    {
      san: "e5", uci: "e7e5", color: "b", delta: 10, loss: 0.02, category: "good",
      bestUci: null, bestSan: null, score: null, multi: [],
    },
  ],
};

describe("GET /api/db/players/{u}/games", () => {
  test("first call fetches the public API (lowercased path); ms window → seconds storage", async () => {
    const from = Date.now() - 30 * 86_400_000;
    const res = await call(`/api/db/players/Player1/games?from=${from}`)!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { games: { id: string }[]; partial: boolean; fetchedAt: number | null };
    // mixed-case request → API path lowercased (stub only matches lowercase);
    // both in-window games come back, the 40-day one never entered the DB
    expect(body.games.map((g) => g.id).sort()).toEqual(["a", "b"]);
    expect(body.partial).toBe(false);
    expect(body.fetchedAt).not.toBeNull();
  });

  test("same-day repeat is served from the DB (no upstream round-trip)", async () => {
    const before = chessCalls;
    const from = Date.now() - 30 * 86_400_000;
    const res = (await call(`/api/db/players/player1/games?from=${from}`))!; // case differs, same player
    expect(res.status).toBe(200);
    expect(chessCalls).toBe(before);
    expect(((await res.json()) as { games: unknown[] }).games).toHaveLength(2);
  });

  test("refresh=1 forces an upstream re-fetch", async () => {
    const before = chessCalls;
    const from = Date.now() - 30 * 86_400_000;
    const res = (await call(`/api/db/players/player1/games?from=${from}&refresh=1`))!;
    expect(chessCalls).toBeGreaterThan(before); // two month endpoints
    expect(res.status).toBe(200);
  });

  test("a window older than the stored fetch window is flagged partial", async () => {
    const from = Date.now() - 45 * 86_400_000;
    const res = (await call(`/api/db/players/player1/games?from=${from}`))!;
    const body = (await res.json()) as { partial: boolean; games: unknown[] };
    expect(body.partial).toBe(true);
    expect(body.games).toHaveLength(2); // the 30-day fetch can't cover 45 days yet
  });

  test("unknown player → 404", async () => {
    const res = (await call("/api/db/players/ghost/games"))!;
    expect(res.status).toBe(404);
  });
});

describe("GET /api/db/players/{u}/stats", () => {
  test("ms window boundary + unanalysed games come back unanalysed", async () => {
    // runs BEFORE the analysis PUTs below: neither game is analysed yet
    const from = Date.now() - 30 * 86_400_000;
    const res = (await call(`/api/db/players/player1/stats?from=${from}`))!;
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; analyzed: boolean; moves: unknown[]; youWhite: boolean }[];
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.id === "a")!;
    expect(a.analyzed).toBe(false);
    expect(a.moves).toEqual([]);
    expect(a.youWhite).toBe(true); // white.username = "Player1" (case-insensitive match)
    expect(rows.find((r) => r.id === "b")!.analyzed).toBe(false);
  });
});

describe("analyses round-trip over HTTP", () => {
  test("PUT stores, GET returns the exact shape, the rank guard refuses weaker", async () => {
    const put = (await call("/api/db/games/a/analysis", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ENTRY),
    }))!;
    expect(((await put.json()) as { stored: boolean }).stored).toBe(true);

    const get = (await call("/api/db/games/a/analysis"))!;
    const got = (await get.json()) as CachedAnalysis;
    expect(got.engine).toBe("lite");
    expect(got.moves).toHaveLength(2);
    expect(got.moves[0].multi[0].pv).toEqual(["e2e4"]);

    // game b: lite+fast → full+deep (replaced) → lite+fast (refused)
    const putB = (await call("/api/db/games/b/analysis", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ENTRY),
    }))!;
    expect(((await putB.json()) as { stored: boolean }).stored).toBe(true);

    const putStrong = (await call("/api/db/games/b/analysis", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ENTRY, engine: "full", mode: "deep" }),
    }))!;
    expect(((await putStrong.json()) as { stored: boolean }).stored).toBe(true);

    const putWeak = (await call("/api/db/games/b/analysis", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ENTRY),
    }))!;
    expect(((await putWeak.json()) as { stored: boolean; reason: string }).stored).toBe(false);

    const stillStrong = (await (await call("/api/db/games/b/analysis"))!.json()) as CachedAnalysis;
    expect(stillStrong.engine).toBe("full");
    expect(stillStrong.mode).toBe("deep");
  });

  test("stats rows then join games with their analyses", async () => {
    const from = Date.now() - 30 * 86_400_000;
    const res = (await call(`/api/db/players/player1/stats?from=${from}`))!;
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; analyzed: boolean; moves: unknown[] }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "a")!.analyzed).toBe(true);
    expect(rows.find((r) => r.id === "a")!.moves).toHaveLength(2);
    expect(rows.find((r) => r.id === "b")!.analyzed).toBe(true);
  });
});
