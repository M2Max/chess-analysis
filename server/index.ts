import { serve } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "path";
import {
  ApiError,
  fetchLast30DaysGames,
  UnknownPlayerError,
} from "../src/api/games";
import type { CachedAnalysis } from "../src/api/analysisCache";
import {
  getAnalysis,
  getGamesForPlayer,
  getStatsForPlayer,
  listIsFresh,
  listPlayers,
  saveAnalysisForGame,
  upsertList,
  upsertPlayer,
} from "./db";

const PORT = Number(process.env.PORT ?? 3000);
const DIST = join(import.meta.dir, "..", "dist");

// Cross-origin isolation: required for SharedArrayBuffer (multi-threaded
// Stockfish). Same headers as the Vite dev server (vite.config.ts).
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// --- HTTPS (optional) -----------------------------------------------------
// Multi-threaded Stockfish needs SharedArrayBuffer → cross-origin isolation,
// which browsers only grant "secure" contexts: https:// (or the special-case
// http://localhost). LAN access by IP (https://192.168.x.y:35102) therefore
// needs HTTPS - self-signed cert generated on the host (see README):
//
//   openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem \
//     -out certs/cert.pem -days 365 -nodes -subj "/CN=<your-LAN-IP>" \
//     -addext "subjectAltName=DNS:localhost,IP:<your-LAN-IP>"
//
// Enabled when HTTPS=true and both files exist; otherwise plain HTTP
// (local dev). The COOP/COEP headers below are sent either way.
function loadTls(): { key: string; cert: string } | undefined {
  if (process.env.HTTPS !== "true") return undefined;
  const keyPath = process.env.SSL_KEY ?? "/app/certs/key.pem";
  const certPath = process.env.SSL_CERT ?? "/app/certs/cert.pem";
  // Bun wants the PEM *contents* (not the path) - read them here so a
  // missing file falls back to plain HTTP instead of crashing the server.
  if (existsSync(keyPath) && existsSync(certPath)) {
    try {
      return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
    } catch (e) {
      console.warn(`HTTPS=true but cert unreadable (${(e as Error).message}) - falling back to plain HTTP`);
    }
  } else {
    console.warn(
      `HTTPS=true but ${keyPath} / ${certPath} not found - falling back to plain HTTP ` +
        "(multi-threaded engine disabled when reached by IP address)",
    );
  }
  return undefined;
}
const tls = loadTls();

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...ISOLATION_HEADERS, ...headers },
  });

// --- request-body guard ---------------------------------------------------
// The API is unauthenticated (LAN app); cap body size so a hostile client
// cannot exhaust server memory with a huge JSON payload. Analysis payloads
// are well under 1 MB in practice (300-move game + MultiPV lines).
const MAX_BODY_BYTES = 10 * 1024 * 1024;
async function readJsonBody(
  req: Request,
): Promise<{ value: unknown } | { error: string }> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { error: "payload too large" };
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { error: "unreadable body" };
  }
  if (text.length > MAX_BODY_BYTES) return { error: "payload too large" };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "invalid JSON body" };
  }
}

/**
 * /api/db - the SQLite-backed data API (see server/db.ts).
 * Returns null when the route doesn't match.
 */
// exported for the HTTP-layer tests (tests/server-api.test.ts)
export async function handleDbApi(req: Request, url: URL): Promise<Response | null> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // ['db', ...]
  const seg = (i: number) => decodeURIComponent(parts[i] ?? "");
  const num = (v: string | null) => (v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  // window params arrive in unix MILLISECONDS (client Date.now() domain);
  // games.utc is stored in unix SECONDS - convert at the boundary
  const sec = (v: number | undefined) => (v != null ? Math.floor(v / 1000) : undefined);

  // GET /api/db/players
  if (parts[1] === "players" && parts.length === 2 && req.method === "GET") {
    return json(listPlayers());
  }

  // GET /api/db/players/{u}/games[?refresh=1&from=&to=]
  if (parts[1] === "players" && parts[3] === "games" && parts.length === 4 && req.method === "GET") {
    const u = seg(2);
    if (!u) return json({ error: "missing username" }, 400);
    const from = num(url.searchParams.get("from"));
    const to = num(url.searchParams.get("to"));
    const refresh = url.searchParams.get("refresh") === "1";
    let list = getGamesForPlayer(u, { fromUtc: sec(from), toUtc: sec(to) });
    const now = Date.now();
    const wantRefresh =
      refresh ||
      list?.fetchedAt == null ||
      // latest fetch is not today (same rule as the old client-side cache)…
      !listIsFresh(u) ||
      // …or the requested window starts before the latest fetch's window
      (sec(from) != null && list?.fromUtc != null && sec(from)! < list.fromUtc);
    if (wantRefresh) {
      try {
        const { games, truncated } = await fetchLast30DaysGames(u);
        const playerId = upsertPlayer(u);
        upsertList(playerId, games, {
          fetchedAt: Date.now(),
          truncated,
          // audit window in the seconds domain like games.utc
          fromUtc: Math.floor((now - 30 * 24 * 3600 * 1000) / 1000),
          toUtc: Math.floor(now / 1000),
        });
        list = getGamesForPlayer(u, { fromUtc: sec(from), toUtc: sec(to) });
      } catch (e) {
        if (e instanceof UnknownPlayerError) return json({ error: e.message }, 404);
        if (e instanceof ApiError) return json({ error: e.message }, 502);
        throw e;
      }
    }
    if (!list) return json({ error: `player "${u}" has no stored games` }, 404);
    // the 30-day fetch can't satisfy older windows yet (future retrieval
    // extension) - flag partial results instead of pretending. Compared to
    // the STORED fetch window (not a recomputed one: the server clock is a
    // moment ahead of the client's, which would always trip the flag).
    const partial = sec(from) != null && list.fromUtc != null && sec(from)! < list.fromUtc;
    return json({ ...list, partial });
  }

  // GET /api/db/players/{u}/stats[?from=&to=]
  if (parts[1] === "players" && parts[3] === "stats" && parts.length === 4 && req.method === "GET") {
    const u = seg(2);
    const rows = getStatsForPlayer(u, {
      fromUtc: sec(num(url.searchParams.get("from"))),
      toUtc: sec(num(url.searchParams.get("to"))),
    });
    if (rows == null) return json({ error: `player "${u}" has no stored games` }, 404);
    return json(rows);
  }

  // GET /api/db/games/{id}/analysis
  if (parts[1] === "games" && parts[3] === "analysis" && parts.length === 4) {
    const id = seg(2);
    if (req.method === "GET") {
      const a = getAnalysis(id);
      return a ? json(a) : json({ error: "no analysis for this game" }, 404);
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      if ("error" in body) return json({ error: body.error }, body.error === "payload too large" ? 413 : 400);
      const entry = body.value as CachedAnalysis;
      if (!entry || entry.v !== 2 || !Array.isArray(entry.moves) || !entry.engine || !entry.mode) {
        return json({ error: "invalid analysis payload" }, 400);
      }
      const stored = saveAnalysisForGame(id, entry);
      return stored ? json({ stored: true }) : json({ stored: false, reason: "kept the stronger existing analysis" });
    }
  }

  // POST /api/db/import - one-shot migration of a browser's local cache
  if (parts[1] === "import" && parts.length === 2 && req.method === "POST") {
    const parsed = await readJsonBody(req);
    if ("error" in parsed) return json({ error: parsed.error }, parsed.error === "payload too large" ? 413 : 400);
    const body = parsed.value as { player?: string; analyses?: Record<string, CachedAnalysis> };
    if (!body?.player || typeof body.analyses !== "object" || body.analyses == null) {
      return json({ error: "expected { player, analyses }" }, 400);
    }
    upsertPlayer(body.player);
    let stored = 0;
    for (const [gameId, entry] of Object.entries(body.analyses)) {
      if (entry?.v === 2 && Array.isArray(entry.moves)) {
        if (saveAnalysisForGame(gameId, entry)) stored++;
      }
    }
    return json({ stored });
  }

  return null;
}

if (process.env.REVIEW_SERVER_NO_LISTEN !== "1") {
serve({
  port: PORT,
  // Bun 1.3 renamed the option to `tls`; older versions use `https`.
  // Unknown keys are ignored, so pass both for compatibility.
  ...(tls ? { tls, https: tls } : {}),
  async fetch(req) {
    const url = new URL(req.url);

    // SQLite data API (multi-player, history-agnostic - see server/db.ts)
    if (url.pathname.startsWith("/api/db")) {
      const res = await handleDbApi(req, url);
      if (res) return res;
    }

    // Static files from dist/, SPA fallback to index.html.
    // Path containment guard: `join` resolves any `..` segments, so a
    // resolved path that escapes DIST is rejected instead of served.
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = join(DIST, rel);
    if (full !== DIST && !full.startsWith(DIST + "/")) {
      return new Response("not found", { status: 404, headers: ISOLATION_HEADERS });
    }
    if (existsSync(full) && statSync(full).isFile()) {
      return new Response(Bun.file(full), { headers: ISOLATION_HEADERS });
    }
    const index = join(DIST, "index.html");
    if (!existsSync(index)) {
      return new Response("run `bun run build` first", { status: 503, headers: ISOLATION_HEADERS });
    }
    return new Response(Bun.file(index), { headers: ISOLATION_HEADERS });
  },
});

console.log(`serving ${DIST} on ${tls ? "https" : "http"}://localhost:${PORT}`);
}
