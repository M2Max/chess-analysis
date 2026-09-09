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
import { getDb, setDbPathForTests } from "../server/db";
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
/** usernames whose PROFILE endpoint was called (multi-user tests) */
const profileSeen: string[] = [];

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
    const stats = url.match(/^https:\/\/api\.chess\.com\/pub\/player\/([a-z0-9_]+)\/stats$/);
    if (stats) {
      return Response.json({
        chess_blitz: { last: { rating: 1234 } },
        chess_rapid: { last: { rating: 1100 } },
        chess_daily: { last: { rating: 1050 } },
        tactics: { last: { rating: 900 } },
      });
    }
    const profile = url.match(/^https:\/\/api\.chess\.com\/pub\/player\/([a-z0-9_]+)$/);
    if (profile) {
      const name = profile[1];
      if (name === "ghost") return Response.json({ error: "Not found" }, { status: 404 });
      profileSeen.push(name);
      return Response.json({
        player_id: 1,
        username: name,
        name: name,
        title: "NM",
        last_online: 1,
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

const callJson = async (path: string, init?: RequestInit) => {
  const res = await call(path, init);
  return res ? ((await res.json()) as unknown) : null;
};

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

describe("POST/DELETE /api/db/players (multi-user)", () => {
  const post = (body: unknown) =>
    call("/api/db/players", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("POST valid username → 201 and the player appears with profile data", async () => {
    const res = await post({ username: "Newguy" });
    expect(res!.status).toBe(201);
    const players = (await callJson("/api/db/players")) as {
      username: string;
      title: string | null;
      ratings: { blitz?: number };
    }[];
    const p = players.find((x) => x.username === "Newguy");
    expect(p).toBeDefined();
    expect(p!.title).toBe("NM");
    expect(p!.ratings.blitz).toBe(1234);
  });

  test("POST unknown account → 422 player-not-found", async () => {
    const res = await post({ username: "ghost" });
    expect(res!.status).toBe(422);
    expect(((await res!.json()) as { error: string }).error).toBe("player-not-found");
  });

  test("POST malformed username → 400 (no upstream call needed)", async () => {
    for (const bad of ["", "a", "no spaces allowed", "@", "x".repeat(30)]) {
      const res = await post({ username: bad });
      expect(res!.status).toBe(400);
    }
  });

  test("GET ?refresh=1 tops up only STALE profiles (TTL guard)", async () => {
    // force Newguy's profile cache stale behind the server's back
    getDb().run("UPDATE players SET ratings_updated_at = 0 WHERE username = ?", ["Newguy"]);
    profileSeen.length = 0;
    await call("/api/db/players?refresh=1");
    expect(profileSeen).toContain("newguy");

    // now fresh: a second refresh must NOT call the profile endpoint again
    profileSeen.length = 0;
    await call("/api/db/players?refresh=1");
    expect(profileSeen).not.toContain("newguy");
  });

  test("DELETE removes the player; second delete is a 404", async () => {
    let res = await call("/api/db/players/Newguy", { method: "DELETE" });
    expect(res!.status).toBe(200);
    const players = (await callJson("/api/db/players")) as { username: string }[];
    expect(players.some((p) => p.username === "Newguy")).toBe(false);

    res = await call("/api/db/players/Newguy", { method: "DELETE" });
    expect(res!.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// puzzles HTTP layer
// ---------------------------------------------------------------------------

describe("puzzles API", () => {
  const PUZ = {
    gameId: "puz-game-1",
    ply: 7,
    fen: "rnbqkb1r/pppp1ppp/4pn2/8/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
    side: "b",
    solutionUci: "d8h4",
    solutionSan: "Qh4#",
    mateLen: 1,
    theme: "mate",
    pv: ["d8h4"],
    punish: true,
    ratingEst: 900,
  };

  beforeAll(() => {
    const d = getDb();
    d.run("DELETE FROM games WHERE id = ?", ["puz-game-1"]);
    d.run(
      `INSERT INTO games (id, utc, result, pgn, white_username, white_name, black_username, black_name, updated_at)
       VALUES ('puz-game-1', 1750000000, '*', '', 'puzuser', 'PZ', 'oppx', 'OX', 1)`,
    );
  });

  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("batch: rejects bad username / payload", async () => {
    expect((await post("/api/db/puzzles/batch", { username: "x!", puzzles: [] })).status).toBe(400);
    expect((await post("/api/db/puzzles/batch", { username: "puzuser", puzzles: "nope" })).status).toBe(400);
    expect(
      (await post("/api/db/puzzles/batch", { username: "puzuser", puzzles: [{ ...PUZ, fen: 3 }] })).status,
    ).toBe(400);
  });

  test("batch insert + idempotent dedup + list + meta", async () => {
    const first = await callJson("/api/db/puzzles/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "puzuser", puzzles: [PUZ] }),
    });
    expect((first as { inserted: number }).inserted).toBe(1);
    const again = await callJson("/api/db/puzzles/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "puzuser", puzzles: [PUZ] }),
    });
    expect((again as { inserted: number }).inserted).toBe(0);

    const pending = (await callJson("/api/db/puzzles?username=puzuser&statuses=pending")) as {
      puzzles: { id: number; fen: string; punish: boolean; pv: string[] }[];
    };
    expect(pending.puzzles.length).toBe(1);
    expect(pending.puzzles[0].punish).toBe(true);
    expect(pending.puzzles[0].pv).toEqual(["d8h4"]);

    const meta = (await callJson("/api/db/puzzles/meta?username=puzuser")) as {
      counts: Record<string, number>;
      gameIds: string[];
    };
    expect(meta.counts.pending).toBe(1);
    expect(meta.gameIds).toContain("puz-game-1");
  });

  test("resolve verdict -> ready (with patch) then attempt bookkeeping", async () => {
    const list = (await callJson("/api/db/puzzles?username=puzuser&statuses=pending")) as {
      puzzles: { id: number }[];
    };
    const id = list.puzzles[0].id;

    const resolved = (await callJson("/api/db/puzzles/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ok: true, patch: { solutionSan: "Qh4#" } }),
    })) as { puzzle: { status: string; solutionSan: string } };
    expect(resolved.puzzle.status).toBe("ready");

    const wrong = (await callJson(`/api/db/puzzles/${id}/attempt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ solved: false }),
    })) as { puzzle: { status: string; attempts: number } };
    expect(wrong.puzzle.status).toBe("ready");
    expect(wrong.puzzle.attempts).toBe(1);

    const solved = (await callJson(`/api/db/puzzles/${id}/attempt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ solved: true }),
    })) as { puzzle: { status: string; attempts: number; solvedAt: number } };
    expect(solved.puzzle.status).toBe("solved");
    expect(solved.puzzle.solvedAt).toBeGreaterThan(0);
  });

  test("unknown ids → 404; bad bodies → 400", async () => {
    expect((await post("/api/db/puzzles/resolve", { id: 999999, ok: true })).status).toBe(404);
    expect((await post("/api/db/puzzles/999999/attempt", { solved: true })).status).toBe(404);
    expect((await post("/api/db/puzzles/1/attempt", { nope: 1 })).status).toBe(400);
    expect((await post("/api/db/puzzles/resolve", { id: "x", ok: true })).status).toBe(400);
  });

  test("GET puzzles requires username; statuses filter defaults", async () => {
    expect((await call("/api/db/puzzles")).status).toBe(400);
    const res = await call("/api/db/puzzles?username=puzuser");
    expect(res?.status).toBe(200);
  });
});
