/**
 * Statistics data model + pure aggregation (unit-tested, no React/DOM).
 *
 * Input: per-game summaries produced by the stats runner (one per played
 * game: result, ratings, time class, per-move categories/accuracies,
 * recognised opening). Output: the blocks the stats view renders.
 */
import {
  accuracyFromMoves,
  moveAccuracy,
  ratingFor,
  type AccMove,
  type Category,
} from "../engine/classify";
import type { Opening } from "../api/openings";
import { timeClassOf, type GameTab } from "../components/GameList";
import type { StatsGameRow } from "./statsRows";

/** One analysed game, from the reviewed user's perspective. */
export interface GameSummary {
  id: string;
  /** game start, unix seconds */
  utc: number;
  /** API time_class ("" when missing - derived from timeControl) */
  timeClass: string;
  /** API time_control (fallback for tab derivation) */
  timeControl: string;
  /** raw result ("1-0" | "0-1" | "1/2-1/2" | …) */
  result: string;
  youWhite: boolean;
  whiteRating: number | null;
  blackRating: number | null;
  oppName: string;
  /** total plies played */
  moves: number;
  /** per-move category counts (user's and opponent's moves together) */
  counts: Partial<Record<Category, number>>;
  /** per-move accuracy (integers 0..100) of the user's own moves */
  userAccs: number[];
  /** overall accuracy of the user in this game (null when unanalysed) */
  userAcc: number | null;
  /** recognised opening (null when the game never entered the book) */
  opening: Opening | null;
}

export function pickTab(games: GameSummary[], tab: GameTab): GameSummary[] {
  if (tab === "all") return games;
  return games.filter((g) => timeClassOf({ timeClass: g.timeClass, timeControl: g.timeControl }) === tab);
}

function outcome(result: string, youWhite: boolean): "win" | "draw" | "loss" {
  if (result === "1/2-1/2") return "draw";
  const youWon = youWhite ? result === "1-0" : result === "0-1";
  const oppWon = youWhite ? result === "0-1" : result === "1-0";
  return youWon ? "win" : oppWon ? "loss" : "draw";
}

export interface ResultCounts {
  total: number;
  wins: number;
  draws: number;
  losses: number;
  /** wins / total, 0..1 (null when no games) */
  winrate: number | null;
}

function count(games: GameSummary[]): ResultCounts {
  const c: ResultCounts = { total: games.length, wins: 0, draws: 0, losses: 0, winrate: null };
  for (const g of games) {
    const o = outcome(g.result, g.youWhite);
    if (o === "win") c.wins++;
    else if (o === "draw") c.draws++;
    else c.losses++;
  }
  c.winrate = c.total > 0 ? c.wins / c.total : null;
  return c;
}

/** Overall + per-side results for a set of games (win/white/black). */
export function resultsFor(games: GameSummary[]): {
  all: ResultCounts;
  white: ResultCounts;
  black: ResultCounts;
} {
  return {
    all: count(games),
    white: count(games.filter((g) => g.youWhite)),
    black: count(games.filter((g) => !g.youWhite)),
  };
}

export interface AccuracyBlock {
  /** average over all the user's analysed moves */
  avg: number | null;
  /** the user's accuracy in their white / black games */
  white: number | null;
  black: number | null;
  analyzedGames: number;
  totalMoves: number;
}

function averageOf(games: GameSummary[]): { value: number | null; moves: number } {
  let total = 0;
  let n = 0;
  for (const g of games) {
    for (const a of g.userAccs) {
      total += a;
      n++;
    }
  }
  return n === 0 ? { value: null, moves: 0 } : { value: Math.round(total / n), moves: n };
}

export function accuracyForGames(games: GameSummary[]): AccuracyBlock {
  const all = averageOf(games);
  const white = averageOf(games.filter((g) => g.youWhite));
  const black = averageOf(games.filter((g) => !g.youWhite));
  return {
    avg: all.value,
    white: white.value,
    black: black.value,
    analyzedGames: games.filter((g) => g.userAcc != null).length,
    totalMoves: all.moves,
  };
}

export interface OpeningRow {
  /** null = no book match (the component shows the localized fallback) */
  eco: string | null;
  name: string | null;
  count: number;
  wins: number;
  draws: number;
  losses: number;
  winrate: number | null;
  /** user's average accuracy in these games */
  acc: number | null;
}

/** Per-opening breakdown, sorted by frequency (no-book games last). */
export function openingStats(games: GameSummary[]): OpeningRow[] {
  const map = new Map<string, { row: OpeningRow; games: GameSummary[] }>();
  for (const g of games) {
    const key = g.opening ? `${g.opening.eco}|${g.opening.name}` : "__nobook__";
    let e = map.get(key);
    if (!e) {
      e = {
        row: {
          eco: g.opening?.eco ?? null,
          name: g.opening?.name ?? null,
          count: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          winrate: null,
          acc: null,
        },
        games: [],
      };
      map.set(key, e);
    }
    e.games.push(g);
  }
  const rows: OpeningRow[] = [];
  for (const e of map.values()) {
    const c = count(e.games);
    const acc = averageOf(e.games);
    rows.push({
      eco: e.row.eco,
      name: e.row.name,
      count: c.total,
      wins: c.wins,
      draws: c.draws,
      losses: c.losses,
      winrate: c.winrate,
      acc: acc.value,
    });
  }
  rows.sort((a, b) => b.count - a.count || (a.name ?? "").localeCompare(b.name ?? ""));
  return rows;
}

export interface EloPoint {
  /** unix seconds */
  t: number;
  rating: number;
}

type EloClass = "bullet" | "blitz" | "rapid" | "long";

/** The user's rating trajectory per time class (points = per game). */
export function eloSeries(games: GameSummary[]): Record<EloClass, EloPoint[]> {
  const out: Record<EloClass, EloPoint[]> = { bullet: [], blitz: [], rapid: [], long: [] };
  for (const g of games) {
    const tab = timeClassOf({ timeClass: g.timeClass, timeControl: g.timeControl });
    if (tab === "all" || tab === "other") continue;
    const rating = g.youWhite ? g.whiteRating : g.blackRating;
    if (rating == null) continue;
    out[tab].push({ t: g.utc, rating });
  }
  for (const k of Object.keys(out) as EloClass[]) out[k].sort((a, b) => a.t - b.t);
  return out;
}

export interface HistogramBucket {
  label: string;
  count: number;
}

export const ACCURACY_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "< 50", min: 0, max: 50 },
  { label: "50-70", min: 50, max: 70 },
  { label: "70-85", min: 70, max: 85 },
  { label: "85-95", min: 85, max: 95 },
  { label: "95-100", min: 95, max: 100.001 },
];

/** Distribution of the user's per-move accuracies. */
export function accuracyHistogram(games: GameSummary[]): HistogramBucket[] {
  const out = ACCURACY_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const g of games) {
    for (const a of g.userAccs) {
      const i = ACCURACY_BUCKETS.findIndex((b) => a >= b.min && a < b.max);
      if (i >= 0) out[i].count++;
    }
  }
  return out;
}

export interface MistakeRow {
  /** tab id, localized at render time */
  tab: GameTab;
  games: number;
  /** avg (inaccuracy + mistake) per game */
  avgWeak: number;
  /** avg blunders per game */
  avgBlunders: number;
}

/** How often the user (and the opponent) leak points, per time class. */
export function mistakesByClass(games: GameSummary[]): MistakeRow[] {
  const classes: GameTab[] = ["bullet", "blitz", "rapid", "long"];
  return classes
    .map((tab) => {
      const list = pickTab(games, tab);
      const n = list.length;
      let weak = 0;
      let blunders = 0;
      for (const g of list) {
        weak += (g.counts.inaccuracy ?? 0) + (g.counts.mistake ?? 0);
        blunders += g.counts.blunder ?? 0;
      }
      return {
        tab,
        games: n,
        avgWeak: n > 0 ? weak / n : 0,
        avgBlunders: n > 0 ? blunders / n : 0,
      };
    })
    .filter((r) => r.games > 0);
}

/** stable keys, localized at render time (gapStronger / gapEven / gapWeaker) */
export type GapKind = "stronger" | "even" | "weaker";

export interface GapRow {
  gap: GapKind;
  total: number;
  wins: number;
  winrate: number | null;
}

/** Win rate against stronger / even / weaker opponents (±100 rating). */
export function winrateByGap(games: GameSummary[]): GapRow[] {
  const rows: GapRow[] = [
    { gap: "stronger", total: 0, wins: 0, winrate: null },
    { gap: "even", total: 0, wins: 0, winrate: null },
    { gap: "weaker", total: 0, wins: 0, winrate: null },
  ];
  for (const g of games) {
    const mine = g.youWhite ? g.whiteRating : g.blackRating;
    const theirs = g.youWhite ? g.blackRating : g.whiteRating;
    if (mine == null || theirs == null) continue;
    const gap = mine - theirs;
    const row = gap <= -100 ? rows[0] : gap >= 100 ? rows[2] : rows[1];
    row.total++;
    if (outcome(g.result, g.youWhite) === "win") row.wins++;
  }
  for (const r of rows) r.winrate = r.total > 0 ? r.wins / r.total : null;
  return rows;
}

export interface HourRow {
  hour: number;
  wins: number;
  draws: number;
  losses: number;
}

/**
 * Map the server's stats rows (games joined with their stored analysis) to
 * the per-game summaries the charts consume. Games without an analysis are
 * omitted - the runner treats "not in the map" as "to analyse".
 *
 * Must produce exactly what the live runner computes for the same game
 * (same accuracy formula, same counts), so resumed data is indistinguishable
 * from freshly computed data.
 */
export function summariesFromRows(rows: StatsGameRow[]): Record<string, GameSummary> {
  const out: Record<string, GameSummary> = {};
  for (const r of rows) {
    if (!r.analyzed) continue;
    const ratings = { w: r.whiteRating ?? undefined, b: r.blackRating ?? undefined };
    const userColor: "w" | "b" = r.youWhite ? "w" : "b";
    const allMoves: AccMove[] = r.moves.map((m) => ({
      color: m.color,
      delta: m.delta,
      category: m.category as AccMove["category"],
    }));
    const counts: Partial<Record<Category, number>> = {};
    for (const m of allMoves) {
      const cat = m.category;
      if (cat != null) counts[cat] = (counts[cat] ?? 0) + 1;
    }
    const userRating = ratingFor(ratings, userColor);
    const userAccs = r.moves
      .filter((m) => m.color === userColor)
      .map((m) => (m.category === "opening" ? 100 : Math.round(moveAccuracy(m.delta ?? 0, userRating))));
    out[r.id] = {
      id: r.id,
      utc: r.utc,
      timeClass: r.timeClass,
      timeControl: r.timeControl,
      result: r.result,
      youWhite: r.youWhite,
      whiteRating: r.whiteRating,
      blackRating: r.blackRating,
      oppName: r.youWhite ? r.blackUsername : r.whiteUsername,
      moves: r.moves.length,
      counts,
      userAccs,
      userAcc: accuracyFromMoves(allMoves, ratings)[userColor].value,
      opening: r.opening,
    };
  }
  return out;
}

/** Results by local hour of the day (when does the user play best?). */
export function resultsByHour(games: GameSummary[]): HourRow[] {
  const out: HourRow[] = Array.from({ length: 24 }, (_, hour) => ({ hour, wins: 0, draws: 0, losses: 0 }));
  for (const g of games) {
    const h = new Date(g.utc * 1000).getHours();
    const o = outcome(g.result, g.youWhite);
    const row = out[h];
    if (o === "win") row.wins++;
    else if (o === "draw") row.draws++;
    else row.losses++;
  }
  return out;
}
