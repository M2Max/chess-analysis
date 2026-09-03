/**
 * Client for the server's SQLite data API (/api/db - see server/db.ts).
 *
 * The server owns the game retrieval (same-day freshness rule) and the
 * per-player history. Windows (from/to, unix seconds) are query parameters:
 * today the app asks for the last 30 days; the schema and API already accept
 * any window for extended retrieval later.
 */
import type { Game } from "./games";
import type { StatsGameRow } from "../stats/statsRows";

export interface AnalysisMeta {
  engine: string;
  mode: string;
  whiteAcc: number | null;
  blackAcc: number | null;
  opening: { eco: string; name: string; depth: number } | null;
}

export interface PlayerList {
  fetchedAt: number | null;
  truncated: boolean;
  fromUtc: number | null;
  toUtc: number | null;
  games: (Game & { analysis: AnalysisMeta | null })[];
  /** true when the requested window is wider than the server can fetch yet */
  partial?: boolean;
}

const MS_30D = 30 * 24 * 3600 * 1000;

/**
 * The player's last-30-days games. The server serves today's retrieval from
 * its database and only calls the public API when the latest fetch is not from
 * today (or `refresh` is set). Throws ApiError on API failures.
 */
export async function fetchList(
  username: string,
  refresh = false,
  windowMs = MS_30D,
): Promise<PlayerList> {
  const from = Date.now() - windowMs;
  const res = await fetch(
    `/api/db/players/${encodeURIComponent(username.trim())}/games?from=${from}${refresh ? "&refresh=1" : ""}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return (await res.json()) as PlayerList;
}

/** Per-game rows for the stats view (games joined with their best analysis). */
export async function fetchStats(username: string): Promise<StatsGameRow[]> {
  const res = await fetch(`/api/db/players/${encodeURIComponent(username.trim())}/stats?from=${Date.now() - MS_30D}`);
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()) as StatsGameRow[];
}

export interface PlayerInfo {
  username: string;
  games: number;
  analyzed: number;
  lastFetchAt: number | null;
}

export async function listPlayers(): Promise<PlayerInfo[]> {
  const res = await fetch("/api/db/players");
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()) as PlayerInfo[];
}
