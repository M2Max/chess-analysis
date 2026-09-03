/**
 * Public game-history API client (the data source the app is built on; the
 * footer credits it).
 *
 * Endpoints (no auth, CORS open):
 *   GET /pub/player/{username}
 *   GET /pub/player/{username}/games/{YYYY}/{MM}   (slash form; {YYYY-MM} 404s)
 *
 * "Last 30 days" = current month + previous month, filtered client-side
 * (utc >= now - 30d). Each month caps at 200 games - the API's documented limit.
 *
 * Known transient failure: HTTP 200 with { "code": 0, "error": "Data provider
 * not found" } - retried with backoff.
 */

const BASE =
  (import.meta.env?.VITE_API_BASE as string | undefined) ??
  "https://api.chess.com/pub";

export const MONTHLY_GAME_LIMIT = 200;

export interface PlayerRef {
  name: string;
  username: string;
  rating?: number;
  title?: string;
}

export interface Game {
  id: string;
  url: string;
  /** game start, unix seconds */
  utc: number;
  endUtc?: number;
  white: PlayerRef;
  black: PlayerRef;
  result: string;
  variant: string;
  timeControl: string;
  /** API `time_class`: bullet/blitz/rapid/classical/correspondence/casual */
  timeClass: string;
  accuracy?: { white?: number; black?: number };
  pgn: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class UnknownPlayerError extends ApiError {
  constructor(username: string) {
    super(`Player "${username}" not found`);
    this.name = "UnknownUserError";
  }
}

type RawGame = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch + JSON with retry/backoff for transient failures
 * (network errors and the provider's "code 0" outages).
 */
async function fetchJson(url: string, attempts = 4): Promise<unknown> {
  let lastErr: unknown = new ApiError(`failed to fetch ${url}`);
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) {
        const e = new ApiError(`not found: ${url}`, 404);
        (e as unknown as { notFound: boolean }).notFound = true;
        throw e;
      }
      if (!res.ok) throw new ApiError(`API error ${res.status}`, res.status);
      const json = (await res.json()) as Record<string, unknown>;
      // the API signals transient outages as HTTP 200 + { code: 0, error: ... }
      if (json && typeof json === "object" && !Array.isArray(json) && json.code === 0) {
        throw new ApiError(String(json.error ?? "unknown API error"));
      }
      return json;
    } catch (e) {
      lastErr = e;
      const notFound = (e as { notFound?: boolean })?.notFound;
      const hardHttp = e instanceof ApiError && e.status != null && !notFound;
      if (notFound || hardHttp) throw e;
      if (i < attempts - 1) await sleep(500 * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new ApiError("API unreachable");
}

/**
 * Case-normalise for API *path* queries: the API rejects usernames that
 * aren't in its canonical lowercase form ("Invalid values. Try … {url: …}").
 * Display keeps the case the user typed; only the request path is lowercased.
 */
export function normalizeUsername(input: string): string {
  return input.trim().replace(/^@/, "").toLowerCase();
}

export async function fetchProfile(username: string): Promise<PlayerRef> {
  const u = normalizeUsername(username);
  if (!u) throw new ApiError("username required");
  try {
    const json = (await fetchJson(`${BASE}/player/${encodeURIComponent(u)}`)) as Record<
      string,
      unknown
    >;
    const last = json.last as { rating?: number } | undefined;
    return {
      name: typeof json.name === "string" ? json.name : u,
      username: u,
      rating: last?.rating,
      title: typeof json.title === "string" ? json.title : undefined,
    };
  } catch (e) {
    if (e instanceof ApiError && (e as { notFound?: boolean }).notFound) {
      throw new UnknownPlayerError(u);
    }
    throw e;
  }
}

function monthKey(d: Date): string {
  // API requires the slash form ("2026-08" now 404s, "2026/08" works).
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** [current, previous] month keys for the given date. */
export function monthKeysForDate(now: Date): [string, string] {
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return [monthKey(now), monthKey(prev)];
}

/** the API may return an array or a single object in `games`. */
export function normalizeGames(json: unknown): RawGame[] {
  const obj = json as Record<string, unknown> | undefined;
  const g = obj?.games;
  if (!g) return [];
  return Array.isArray(g) ? (g as RawGame[]) : [g as RawGame];
}

function mapPlayer(p: unknown): PlayerRef {
  const o = (p ?? {}) as Record<string, unknown>;
  return {
    name: typeof o.name === "string" ? o.name : typeof o.username === "string" ? (o.username as string) : "?",
    username: typeof o.username === "string" ? o.username : "?",
    rating: typeof o.rating === "number" ? o.rating : undefined,
  };
}

/** Result is no longer a top-level field - it lives in the PGN tags. */
function resultFromPgn(pgn: string): string {
  const m = pgn.match(/\[Result\s+"([^"]*)"\]/);
  return m ? m[1] : "*";
}

/**
 * Map a raw API game object. The current API uses `uuid`/`end_time`/`rules`/
 * `accuracies`; the legacy `id`/`utc`/`end_utc`/`variant`/`accuracy` fields
 * are still accepted as fallbacks (and used by the test fixtures).
 */
function mapGame(g: RawGame): Game {
  const pgn = typeof g.pgn === "string" ? g.pgn : "";
  const acc = (g.accuracies ?? g.accuracy) as { white?: number; black?: number } | undefined;
  return {
    id:
      typeof g.uuid === "string" && g.uuid
        ? g.uuid
        : g.id != null
          ? String(g.id)
          : "",
    url: typeof g.url === "string" ? g.url : "",
    utc: Number(g.end_time ?? g.utc ?? 0),
    endUtc:
      g.end_time != null
        ? Number(g.end_time)
        : g.end_utc != null
          ? Number(g.end_utc)
          : undefined,
    white: mapPlayer(g.white),
    black: mapPlayer(g.black),
    result:
      typeof g.result === "string" && g.result
        ? g.result
        : resultFromPgn(pgn),
    variant:
      typeof g.rules === "string" && g.rules
        ? g.rules
        : typeof g.variant === "string"
          ? g.variant
          : "chess",
    timeControl: typeof g.time_control === "string" ? g.time_control : "",
    timeClass: typeof g.time_class === "string" ? g.time_class : "",
    accuracy: acc && (acc.white != null || acc.black != null) ? acc : undefined,
    pgn,
  };
}

const DAY_MS = 86_400_000;

/**
 * Filter raw games to the last 30 days (by game start), standard chess only,
 * deduplicated, newest first. Pure - `now` is injectable for tests.
 */
export function filterLast30Days(
  raw: RawGame[],
  nowMs: number,
  windowMs = 30 * DAY_MS,
): Game[] {
  const cutoff = nowMs - windowMs;
  const seen = new Set<string>();
  const out: Game[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const id =
      typeof g.uuid === "string" && g.uuid ? g.uuid : g.id != null ? String(g.id) : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const utc = Number(g.end_time ?? g.utc);
    if (!Number.isFinite(utc) || utc * 1000 < cutoff) continue;
    const rules =
      typeof g.rules === "string" && g.rules
        ? g.rules
        : typeof g.variant === "string"
          ? g.variant
          : "chess";
    if (rules !== "chess") continue;
    out.push(mapGame(g));
  }
  out.sort((a, b) => b.utc - a.utc);
  return out;
}

export interface Last30DaysResult {
  games: Game[];
  /** true when a month hit the 200-game cap and older games may be missing */
  truncated: boolean;
}

export async function fetchLast30DaysGames(
  username: string,
  now: Date = new Date(),
): Promise<Last30DaysResult> {
  const u = normalizeUsername(username);
  if (!u) throw new ApiError("username required");
  const [curKey, prevKey] = monthKeysForDate(now);

  const [curJson, prevJson] = await Promise.all([
    (async () => {
      try {
        return await fetchJson(`${BASE}/player/${encodeURIComponent(u)}/games/${curKey}`);
      } catch (e) {
        // a 404 on the CURRENT month means the player does not exist - a
        // valid user without games this month gets 200 + { games: [] }
        if (e instanceof ApiError && (e as { notFound?: boolean }).notFound) {
          throw new UnknownPlayerError(u);
        }
        throw e;
      }
    })(),
    // previous month may legitimately 404 for brand-new accounts
    fetchJson(`${BASE}/player/${encodeURIComponent(u)}/games/${prevKey}`).catch(
      (e: unknown) => {
        if (e instanceof ApiError && (e as { notFound?: boolean }).notFound) return null;
        throw e;
      },
    ),
  ]);

  const curGames = normalizeGames(curJson);
  const prevGames = normalizeGames(prevJson);
  const games = filterLast30Days([...curGames, ...prevGames], now.getTime());
  const truncated =
    curGames.length >= MONTHLY_GAME_LIMIT || prevGames.length >= MONTHLY_GAME_LIMIT;
  return { games, truncated };
}
