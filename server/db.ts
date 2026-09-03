/**
 * SQLite persistence (bun:sqlite) - the app's data home.
 *
 * One database file (WAL mode) holds, for every reviewed player:
 *  - their games (provider uuid-keyed, shared across players),
 *  - which games belong to their history (`player_games` - history-agnostic:
 *    the 30-day window is just one fetch record among potentially many),
 *  - one analysis per game = the strongest combo (rank-guarded upsert),
 *  - retrieval audit (`fetches`).
 *
 * The 30-day window is a QUERY concept (from/to bounds), not a storage
 * concept - extended retrieval (wider windows, backfills) only adds fetch
 * records and links; nothing in the schema assumes 30 days.
 *
 * The file path comes from DATABASE_PATH (default: <repo>/data/review.db;
 * the Docker image sets /app/data/review.db on a mounted volume).
 */
import { Database } from "bun:sqlite";
import type { SQLQueryBindings, Statement } from "bun:sqlite";

// bun-types' generic binding inference rejects single/dynamic param lists;
// these helpers bind explicitly (same calls, sane types).
const allOf = <T>(stmt: Statement, params: SQLQueryBindings[]): T[] =>
  (stmt.all as unknown as (...p: SQLQueryBindings[]) => T[])(...params);
const getOf = <T>(stmt: Statement, params: SQLQueryBindings[]): T | null =>
  (stmt.get as unknown as (...p: SQLQueryBindings[]) => T | null)(...params);
const runOf = (stmt: Statement, params: SQLQueryBindings[]): void => {
  (stmt.run as unknown as (...p: SQLQueryBindings[]) => void)(...params);
};
import { mkdirSync } from "node:fs";
import { dirname, join } from "path";
import type { Game } from "../src/api/games";
import type { CachedAnalysis } from "../src/api/analysisCache";

// ---------------------------------------------------------------------------
// open + migrate
// ---------------------------------------------------------------------------

const MIGRATIONS: string[] = [
  // v1 - initial schema
  `
  CREATE TABLE players (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE games (
    id TEXT PRIMARY KEY,                  -- provider uuid
    utc INTEGER NOT NULL,                 -- game start, unix seconds
    end_utc INTEGER,
    result TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT 'chess',
    time_class TEXT NOT NULL DEFAULT '',
    time_control TEXT NOT NULL DEFAULT '',
    pgn TEXT NOT NULL DEFAULT '',
    white_username TEXT NOT NULL,
    white_name TEXT NOT NULL,
    white_rating INTEGER,
    black_username TEXT NOT NULL,
    black_name TEXT NOT NULL,
    black_rating INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_games_utc ON games(utc);

  -- player <-> games membership: a player's HISTORY (not a window)
  CREATE TABLE player_games (
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, game_id)
  );

  -- retrieval audit; each run records the window it covered
  CREATE TABLE fetches (
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    from_utc INTEGER,
    to_utc INTEGER,
    fetched_at INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    games INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_fetches_player ON fetches(player_id, fetched_at);

  -- ONE analysis per game = the strongest combo (see saveAnalysisForGame)
  CREATE TABLE analyses (
    game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    mode TEXT NOT NULL,
    combo_rank INTEGER NOT NULL,
    analyzed_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',    -- 'ok' | 'no-pgn'
    white_acc INTEGER,
    black_acc INTEGER,
    opening_eco TEXT,
    opening_name TEXT,
    opening_depth INTEGER
  );

  CREATE TABLE analysis_moves (
    game_id TEXT NOT NULL REFERENCES analyses(game_id) ON DELETE CASCADE,
    ply INTEGER NOT NULL,                 -- 0-based move index
    san TEXT NOT NULL,
    uci TEXT NOT NULL,
    color TEXT NOT NULL,
    delta INTEGER NOT NULL DEFAULT 0,
    loss REAL NOT NULL DEFAULT 0,
    category TEXT NOT NULL,
    best_uci TEXT,
    best_san TEXT,
    score_cp INTEGER,                     -- (score_cp, score_mate): exactly one set
    score_mate INTEGER,
    PRIMARY KEY (game_id, ply)
  );

  -- top-3 MultiPV lines per move; pv = JSON array of UCI (not relational)
  CREATE TABLE analysis_lines (
    game_id TEXT NOT NULL REFERENCES analyses(game_id) ON DELETE CASCADE,
    ply INTEGER NOT NULL,
    line_no INTEGER NOT NULL,             -- 1..3
    uci TEXT NOT NULL,
    score_cp INTEGER,
    score_mate INTEGER,
    pv_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (game_id, ply, line_no)
  );
  `,
];

let db: Database | null = null;

function dbPath(): string {
  return process.env.DATABASE_PATH ?? join(import.meta.dir, "..", "data", "review.db");
}

export function getDb(): Database {
  if (db) return db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.run("PRAGMA journal_mode=WAL");
  database.run("PRAGMA foreign_keys=ON");
  database.run("CREATE TABLE IF NOT EXISTS schema_migrations (v INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    (database.query("SELECT v FROM schema_migrations").all() as { v: number }[]).map((r) => r.v),
  );
  MIGRATIONS.forEach((sql, i) => {
    const v = i + 1;
    if (applied.has(v)) return;
    database.transaction(() => {
      database.exec(sql);
      database.run("INSERT INTO schema_migrations (v, applied_at) VALUES (?, ?)", [v, Date.now()]);
    })();
  });
  db = database;
  return database;
}

/** Test hook: point the module at a temp file (call before first getDb()). */
export function setDbPathForTests(p: string): void {
  process.env.DATABASE_PATH = p;
}

// ---------------------------------------------------------------------------
// players / list
// ---------------------------------------------------------------------------

export function upsertPlayer(username: string): number {
  const d = getDb();
  runOf(
    d.prepare(`INSERT INTO players (username, created_at) VALUES (?, ?) ON CONFLICT(username) DO NOTHING`),
    [username.trim(), Date.now()],
  );
  const row = getOf<{ id: number }>(d.query("SELECT id FROM players WHERE username = ?"), [username.trim()]);
  return row!.id;
}

/**
 * Store one retrieval run: upsert the games, link them to the player's
 * history, record the fetch (window + truncation).
 */
export function upsertList(
  playerId: number,
  games: Game[],
  opts: { fetchedAt: number; truncated: boolean; fromUtc?: number; toUtc?: number },
): void {
  const d = getDb();
  d.transaction(() => {
    const insGame = d.prepare(
      `INSERT INTO games (id, utc, end_utc, result, variant, time_class, time_control, pgn,
                          white_username, white_name, white_rating,
                          black_username, black_name, black_rating, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         utc=excluded.utc, end_utc=excluded.end_utc, result=excluded.result,
         variant=excluded.variant, time_class=excluded.time_class,
         time_control=excluded.time_control, pgn=excluded.pgn,
         white_username=excluded.white_username, white_name=excluded.white_name,
         white_rating=excluded.white_rating,
         black_username=excluded.black_username, black_name=excluded.black_name,
         black_rating=excluded.black_rating, updated_at=excluded.updated_at`,
    );
    const insLink = d.prepare(
      `INSERT INTO player_games (player_id, game_id, first_seen_at, last_seen_at)
       VALUES (?,?,?,?)
       ON CONFLICT(player_id, game_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
    );
    for (const g of games) {
      insGame.run(
        g.id, g.utc, g.endUtc ?? null, g.result, g.variant, g.timeClass, g.timeControl, g.pgn,
        g.white.username, g.white.name, g.white.rating ?? null,
        g.black.username, g.black.name, g.black.rating ?? null,
        opts.fetchedAt,
      );
      insLink.run(playerId, g.id, opts.fetchedAt, opts.fetchedAt);
    }
    runOf(
      d.prepare("INSERT INTO fetches (player_id, from_utc, to_utc, fetched_at, truncated, games) VALUES (?,?,?,?,?,?)"),
      [playerId, opts.fromUtc ?? null, opts.toUtc ?? null, opts.fetchedAt, opts.truncated ? 1 : 0, games.length],
    );
  })();
}

interface GameRow {
  id: string; utc: number; end_utc: number | null; result: string; variant: string;
  time_class: string; time_control: string; pgn: string;
  white_username: string; white_name: string; white_rating: number | null;
  black_username: string; black_name: string; black_rating: number | null;
}

function rowToGame(r: GameRow): Game {
  return {
    id: r.id,
    url: "",
    utc: r.utc,
    endUtc: r.end_utc ?? undefined,
    white: { username: r.white_username, name: r.white_name, rating: r.white_rating ?? undefined },
    black: { username: r.black_username, name: r.black_name, rating: r.black_rating ?? undefined },
    result: r.result,
    variant: r.variant,
    timeControl: r.time_control,
    timeClass: r.time_class,
    pgn: r.pgn,
  };
}

export interface AnalysisMeta {
  engine: string;
  mode: string;
  whiteAcc: number | null;
  blackAcc: number | null;
  opening: { eco: string; name: string; depth: number } | null;
}

export interface PlayerList {
  /** latest fetch time (unix ms) - null when the player was never fetched */
  fetchedAt: number | null;
  truncated: boolean;
  /** latest fetch's window (null = unbounded) */
  fromUtc: number | null;
  toUtc: number | null;
  games: (Game & { analysis: AnalysisMeta | null })[];
}

/**
 * The player's games for a window (default: all history), newest first,
 * each decorated with its best analysis meta (for the list rows).
 */
export function getGamesForPlayer(
  username: string,
  opts: { fromUtc?: number; toUtc?: number } = {},
): PlayerList | null {
  const d = getDb();
  const player = getOf<{ id: number }>(d.query("SELECT id FROM players WHERE username = ?"), [username.trim()]);
  if (!player) return null;
  const last = getOf<{ fetched_at: number; from_utc: number | null; to_utc: number | null; truncated: number }>(
    d.query("SELECT fetched_at, from_utc, to_utc, truncated FROM fetches WHERE player_id = ? ORDER BY fetched_at DESC LIMIT 1"),
    [player.id],
  );

  const where = ["pg.player_id = ?"];
  const params: (number | string)[] = [player.id];
  if (opts.fromUtc != null) { where.push("g.utc >= ?"); params.push(opts.fromUtc); }
  if (opts.toUtc != null) { where.push("g.utc <= ?"); params.push(opts.toUtc); }
  const q = d.query(
    `SELECT g.* FROM games g JOIN player_games pg ON pg.game_id = g.id
     WHERE ${where.join(" AND ")} ORDER BY g.utc DESC`,
  );
  const rows = allOf<GameRow>(q, params);

  const games = rows.map(rowToGame);
  const metas = getAnalysesMeta(games.map((g) => g.id));
  return {
    fetchedAt: last?.fetched_at ?? null,
    truncated: !!last?.truncated,
    fromUtc: last?.from_utc ?? null,
    toUtc: last?.to_utc ?? null,
    games: games.map((g) => ({ ...g, analysis: metas.get(g.id) ?? null })),
  };
}

export function getAnalysesMeta(gameIds: string[]): Map<string, AnalysisMeta> {
  const out = new Map<string, AnalysisMeta>();
  if (gameIds.length === 0) return out;
  const d = getDb();
  const marks = gameIds.map(() => "?").join(",");
  interface MetaRow {
    game_id: string; engine: string; mode: string; white_acc: number | null; black_acc: number | null;
    opening_eco: string | null; opening_name: string | null; opening_depth: number | null;
  }
  const rows = allOf<MetaRow>(
    d.query(
      `SELECT game_id, engine, mode, white_acc, black_acc, opening_eco, opening_name, opening_depth
       FROM analyses WHERE game_id IN (${marks})`,
    ),
    gameIds,
  );
  for (const r of rows) {
    out.set(r.game_id, {
      engine: r.engine,
      mode: r.mode,
      whiteAcc: r.white_acc,
      blackAcc: r.black_acc,
      opening: r.opening_eco
        ? { eco: r.opening_eco, name: r.opening_name ?? "", depth: r.opening_depth ?? 0 }
        : null,
    });
  }
  return out;
}

/** Latest fetch is "today" (same rule as the old client-side same-day cache). */
export function listIsFresh(username: string, now: Date = new Date()): boolean {
  const l = getGamesForPlayer(username);
  return l?.fetchedAt != null && new Date(l.fetchedAt).toDateString() === now.toDateString();
}

// ---------------------------------------------------------------------------
// analyses (one per game - the strongest combo)
// ---------------------------------------------------------------------------

const COMBO_RANKS: Record<string, number> = {
  "lite:fast": 0,
  "full:fast": 1,
  "lite:deep": 2,
  "full:deep": 3,
};

export function comboRankOf(engine: string, mode: string): number {
  return COMBO_RANKS[`${engine}:${mode}`] ?? 0;
}

/**
 * Store a game's analysis. A stored entry is replaced only when the new
 * one ranks >= it (lite+fast < full+fast < lite+deep < full+deep).
 * Returns false when the existing analysis is stronger (kept) or the game
 * is unknown.
 */
export function saveAnalysisForGame(gameId: string, entry: CachedAnalysis): boolean {
  const d = getDb();
  const known = getOf<{ id: string }>(d.query("SELECT id FROM games WHERE id = ?"), [gameId]);
  if (!known) return false;
  const existing = getOf<{ combo_rank: number }>(d.query("SELECT combo_rank FROM analyses WHERE game_id = ?"), [gameId]);
  const rank = comboRankOf(entry.engine, entry.mode);
  if (existing && existing.combo_rank > rank) return false;

  d.transaction(() => {
    runOf(
      d.prepare(
        `INSERT INTO analyses (game_id, engine, mode, combo_rank, analyzed_at, status,
                               white_acc, black_acc, opening_eco, opening_name, opening_depth)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(game_id) DO UPDATE SET
           engine=excluded.engine, mode=excluded.mode, combo_rank=excluded.combo_rank,
           analyzed_at=excluded.analyzed_at, status=excluded.status,
           white_acc=excluded.white_acc, black_acc=excluded.black_acc,
           opening_eco=excluded.opening_eco, opening_name=excluded.opening_name,
           opening_depth=excluded.opening_depth`,
      ),
      [
        gameId, entry.engine, entry.mode, rank, entry.savedAt, "ok",
        entry.whiteAcc, entry.blackAcc,
        entry.opening?.eco ?? null, entry.opening?.name ?? null, entry.opening?.depth ?? null,
      ],
    );
    runOf(d.prepare("DELETE FROM analysis_moves WHERE game_id = ?"), [gameId]);
    runOf(d.prepare("DELETE FROM analysis_lines WHERE game_id = ?"), [gameId]);
    const insM = d.prepare(
      `INSERT INTO analysis_moves (game_id, ply, san, uci, color, delta, loss, category,
                                   best_uci, best_san, score_cp, score_mate)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insL = d.prepare(
      "INSERT INTO analysis_lines (game_id, ply, line_no, uci, score_cp, score_mate, pv_json) VALUES (?,?,?,?,?,?,?)",
    );
    entry.moves.forEach((m, ply) => {
      const score = m.score;
      insM.run(
        gameId, ply, m.san, m.uci, m.color, m.delta, m.loss, m.category,
        m.bestUci, m.bestSan,
        score?.mate != null ? null : (score?.cp ?? null),
        score?.mate ?? null,
      );
      m.multi.forEach((l, i) => {
        insL.run(
          gameId, ply, i + 1, l.uci,
          l.score.mate != null ? null : (l.score.cp ?? null),
          l.score.mate ?? null,
          JSON.stringify(l.pv),
        );
      });
    });
  })();
  return true;
}

/** Rebuild the exact CachedAnalysis shape the client expects (null when absent). */
export function getAnalysis(gameId: string): CachedAnalysis | null {
  const d = getDb();
  interface AnalysisHead {
    engine: string; mode: string; analyzed_at: number; status: string;
    white_acc: number | null; black_acc: number | null;
    opening_eco: string | null; opening_name: string | null; opening_depth: number | null;
  }
  const a = getOf<AnalysisHead>(
    d.query(
      `SELECT engine, mode, analyzed_at, status, white_acc, black_acc,
              opening_eco, opening_name, opening_depth
       FROM analyses WHERE game_id = ?`,
    ),
    [gameId],
  );
  if (!a) return null;
  interface MoveRow {
    ply: number; san: string; uci: string; color: string; delta: number; loss: number;
    category: string; best_uci: string | null; best_san: string | null;
    score_cp: number | null; score_mate: number | null;
  }
  const moves = allOf<MoveRow>(d.query("SELECT * FROM analysis_moves WHERE game_id = ? ORDER BY ply"), [gameId]);
  const lines = allOf<{ ply: number; line_no: number; uci: string; score_cp: number | null; score_mate: number | null; pv_json: string }>(
    d.query("SELECT * FROM analysis_lines WHERE game_id = ? ORDER BY ply, line_no"),
    [gameId],
  );
  const linesByPly = new Map<number, typeof lines>();
  for (const l of lines) {
    const arr = linesByPly.get(l.ply) ?? [];
    arr.push(l);
    linesByPly.set(l.ply, arr);
  }
  const score = (cp: number | null, mate: number | null) =>
    mate != null ? { mate } : cp != null ? { cp } : null;
  return {
    v: 2,
    engine: a.engine as CachedAnalysis["engine"],
    mode: a.mode as CachedAnalysis["mode"],
    savedAt: a.analyzed_at,
    whiteAcc: a.white_acc,
    blackAcc: a.black_acc,
    opening: a.opening_eco
      ? { eco: a.opening_eco, name: a.opening_name ?? "", depth: a.opening_depth ?? 0 }
      : null,
    moves: moves.map((m) => ({
      san: m.san,
      uci: m.uci,
      color: m.color as "w" | "b",
      delta: m.delta,
      loss: m.loss,
      category: m.category as CachedAnalysis["moves"][number]["category"],
      bestUci: m.best_uci,
      bestSan: m.best_san,
      score: score(m.score_cp, m.score_mate),
      multi: (linesByPly.get(m.ply) ?? []).map((l) => ({
        uci: l.uci,
        score: score(l.score_cp, l.score_mate) ?? { cp: 0 },
        pv: JSON.parse(l.pv_json) as string[],
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// stats (derived - no separate store)
// ---------------------------------------------------------------------------

export interface StatsGameRow {
  id: string;
  utc: number;
  result: string;
  timeClass: string;
  timeControl: string;
  whiteUsername: string;
  blackUsername: string;
  whiteRating: number | null;
  blackRating: number | null;
  youWhite: boolean;
  /** the game has ANY analysis (any combo) - the stats run skips those */
  analyzed: boolean;
  opening: { eco: string; name: string; depth: number } | null;
  whiteAcc: number | null;
  blackAcc: number | null;
  /** per-move rows of the stored analysis (mover view), when analyzed */
  moves: { ply: number; color: "w" | "b"; delta: number; category: string }[];
}

/**
 * Per-game rows for the stats view: the player's games in a window (default
 * all history) joined with their best analysis. All chart aggregation stays
 * client-side (pure, unit-tested) - this is raw material.
 */
export function getStatsForPlayer(
  username: string,
  opts: { fromUtc?: number; toUtc?: number } = {},
): StatsGameRow[] | null {
  const d = getDb();
  const player = getOf<{ id: number }>(d.query("SELECT id FROM players WHERE username = ?"), [username.trim()]);
  if (!player) return null;
  const where = ["pg.player_id = ?"];
  const params: (number | string)[] = [player.id];
  if (opts.fromUtc != null) { where.push("g.utc >= ?"); params.push(opts.fromUtc); }
  if (opts.toUtc != null) { where.push("g.utc <= ?"); params.push(opts.toUtc); }
  interface StatsGameHead {
    id: string; utc: number; result: string; time_class: string; time_control: string;
    white_username: string; black_username: string; white_rating: number | null; black_rating: number | null;
  }
  const games = allOf<StatsGameHead>(
    d.query(
      `SELECT g.id, g.utc, g.result, g.time_class, g.time_control,
              g.white_username, g.black_username, g.white_rating, g.black_rating
       FROM games g JOIN player_games pg ON pg.game_id = g.id
       WHERE ${where.join(" AND ")} ORDER BY g.utc DESC`,
    ),
    params,
  );
  const ids = games.map((g) => g.id);
  const metas = getAnalysesMeta(ids);
  const movesByGame = new Map<string, StatsGameRow["moves"]>();
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(",");
    const rows = allOf<{ game_id: string; ply: number; color: string; delta: number; category: string }>(
      d.query(
        `SELECT game_id, ply, color, delta, category FROM analysis_moves
         WHERE game_id IN (${marks}) ORDER BY game_id, ply`,
      ),
      ids,
    );
    for (const r of rows) {
      const arr = movesByGame.get(r.game_id) ?? [];
      arr.push({ ply: r.ply, color: r.color as "w" | "b", delta: r.delta, category: r.category });
      movesByGame.set(r.game_id, arr);
    }
  }
  const u = username.trim().toLowerCase();
  return games.map((g) => {
    const meta = metas.get(g.id) ?? null;
    return {
      id: g.id,
      utc: g.utc,
      result: g.result,
      timeClass: g.time_class,
      timeControl: g.time_control,
      whiteUsername: g.white_username,
      blackUsername: g.black_username,
      whiteRating: g.white_rating,
      blackRating: g.black_rating,
      youWhite: g.white_username.toLowerCase() === u,
      analyzed: meta != null,
      opening: meta?.opening ?? null,
      whiteAcc: meta?.whiteAcc ?? null,
      blackAcc: meta?.blackAcc ?? null,
      moves: movesByGame.get(g.id) ?? [],
    };
  });
}

// ---------------------------------------------------------------------------
// players overview
// ---------------------------------------------------------------------------

export interface PlayerInfo {
  username: string;
  games: number;
  analyzed: number;
  lastFetchAt: number | null;
}

export function listPlayers(): PlayerInfo[] {
  const d = getDb();
  const rows = d
    .query(
      `SELECT p.username,
              COUNT(pg.game_id) AS games,
              COUNT(a.game_id) AS analyzed,
              (SELECT MAX(fetched_at) FROM fetches WHERE player_id = p.id) AS last_fetch_at
       FROM players p
       LEFT JOIN player_games pg ON pg.player_id = p.id
       LEFT JOIN analyses a ON a.game_id = pg.game_id
       GROUP BY p.id ORDER BY p.username`,
    )
    .all() as { username: string; games: number; analyzed: number; last_fetch_at: number | null }[];
  return rows.map((r) => ({
    username: r.username,
    games: r.games,
    analyzed: r.analyzed,
    lastFetchAt: r.last_fetch_at,
  }));
}
