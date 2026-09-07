/**
 * Statistics data model + pure aggregation (unit-tested, no React/DOM).
 *
 * Input: per-game summaries (one per played game: result, ratings, time
 * class, per-move categories/accuracies, recognised opening, and the
 * improvement block `imp` - WDL curve, clocks, termination, motifs).
 * Output: the blocks the stats view renders.
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
import { buildImprove, type ImproveBlock } from "./improve";
import type { Motif } from "./motifs";

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
  /** improvement analytics (WDL curve, clocks, termination, motifs) */
  imp: ImproveBlock | null;
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

function score(result: string, youWhite: boolean): number {
  const o = outcome(result, youWhite);
  return o === "win" ? 1 : o === "draw" ? 0.5 : 0;
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

// ---------------------------------------------------------------------------
// Accuracy
// ---------------------------------------------------------------------------

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

/** ply index of the k-th user move (0-based plies). */
function userPly(k: number, youWhite: boolean): number {
  return k * 2 + (youWhite ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Performance rating (USCF formula) + expected score (Glickman)
// ---------------------------------------------------------------------------

/**
 * USCF performance rating: avgOpp + 400*log10(S/(1-S)).
 * null when too few rated games or the score is degenerate.
 */
export function performanceRating(games: GameSummary[]): number | null {
  let pts = 0;
  let oppSum = 0;
  let n = 0;
  for (const g of games) {
    const oppR = g.youWhite ? g.blackRating : g.whiteRating;
    if (oppR == null) continue;
    pts += score(g.result, g.youWhite);
    oppSum += oppR;
    n++;
  }
  if (n < 5) return null;
  const s = Math.min(0.995, Math.max(0.005, pts / n));
  return Math.round(oppSum / n + 400 * Math.log10(s / (1 - s)));
}

/** Glickman/Elo expected score (0..1) for a rating difference. */
export function expectedScore(ratingDiff: number): number {
  return 1 / (1 + Math.pow(10, -ratingDiff / 400));
}

export interface GapBucket {
  /** bucket centre (mine - theirs) */
  mid: number;
  n: number;
  wins: number;
  draws: number;
  losses: number;
  /** actual score 0..1 (null when empty) */
  actual: number | null;
  /** Elo-expected score for `mid` */
  expected: number;
  /** performance in this bucket RELATIVE to the user's rating (+ = outperforming) */
  pr: number | null;
}

/** Score vs opponent strength, 150-wide buckets, expected overlay. */
export function gapCurve(games: GameSummary[]): GapBucket[] {
  const mids = [-450, -300, -150, 0, 150, 300, 450];
  const buckets: GapBucket[] = mids.map((mid) => ({
    mid,
    n: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    actual: null,
    expected: expectedScore(mid),
    pr: null,
  }));
  for (const g of games) {
    const mine = g.youWhite ? g.whiteRating : g.blackRating;
    const theirs = g.youWhite ? g.blackRating : g.whiteRating;
    if (mine == null || theirs == null) continue;
    const diff = mine - theirs;
    const idx = Math.max(0, Math.min(buckets.length - 1, Math.round((diff + 450) / 150)));
    const b = buckets[idx];
    b.n++;
    const o = outcome(g.result, g.youWhite);
    if (o === "win") b.wins++;
    else if (o === "draw") b.draws++;
    else b.losses++;
  }
  for (const b of buckets) {
    if (b.n === 0) continue;
    const pts = b.wins + b.draws * 0.5;
    b.actual = pts / b.n;
    const s = Math.min(0.995, Math.max(0.005, b.actual));
    // PR - ownRating = 400*log10(S/(1-S)) - mid   (avgOpp = own - mid)
    if (b.n >= 3) b.pr = Math.round(400 * Math.log10(s / (1 - s)) - b.mid);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Openings (with the post-book gap)
// ---------------------------------------------------------------------------

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
  /** performance rating in this opening (null when n < 5) */
  pr: number | null;
  /** avg win-expectation (wp) lost in the 3 user moves right after book exit */
  postBookDrop: number | null;
  /** games that left the book and got no analysis (excluded from postBook) */
  postBookN: number;
}

/** Per-opening breakdown, sorted by frequency (no-book games last). */
export function openingStats(games: GameSummary[]): OpeningRow[] {
  const map = new Map<string, { eco: string | null; name: string | null; games: GameSummary[] }>();
  for (const g of games) {
    const key = g.opening ? `${g.opening.eco}|${g.opening.name}` : "__nobook__";
    let e = map.get(key);
    if (!e) {
      e = { eco: g.opening?.eco ?? null, name: g.opening?.name ?? null, games: [] };
      map.set(key, e);
    }
    e.games.push(g);
  }
  const rows: OpeningRow[] = [];
  for (const e of map.values()) {
    const c = count(e.games);
    const acc = averageOf(e.games);
    let pbSum = 0;
    let pbN = 0;
    for (const g of e.games) {
      const d = postBookGap(g);
      if (d != null) {
        pbSum += d;
        pbN++;
      }
    }
    rows.push({
      eco: e.eco,
      name: e.name,
      count: c.total,
      wins: c.wins,
      draws: c.draws,
      losses: c.losses,
      winrate: c.winrate,
      acc: acc.value,
      pr: performanceRating(e.games),
      postBookDrop: pbN > 0 ? pbSum / pbN : null,
      postBookN: pbN,
    });
  }
  rows.sort((a, b) => b.count - a.count || (a.name ?? "").localeCompare(b.name ?? ""));
  return rows;
}

/**
 * Win-expectation (wp) the user loses in the first 3 of their own moves
 * AFTER leaving the opening book. null when not computable.
 */
export function postBookGap(g: GameSummary): number | null {
  const imp = g.imp;
  if (!imp || imp.wp.length === 0 || imp.bookPly <= 0) return null;
  let lost = 0;
  let n = 0;
  const youColor = g.youWhite ? "w" : "b";
  for (let k = 0; k < 3; k++) {
    const ply = userPly(k, g.youWhite) + imp.bookPly + (g.youWhite ? 0 : 1);
    if (ply >= imp.wp.length) break;
    // ply is one of the user's plies when parity matches the user's colour
    const plyColor = ply % 2 === 0 ? "w" : "b";
    if (plyColor !== youColor) continue;
    const before = ply === 0 ? imp.wpStart : imp.wp[ply - 1];
    const after = imp.wp[ply];
    const beforeYou = g.youWhite ? before : 100 - before;
    const afterYou = g.youWhite ? after : 100 - after;
    if (beforeYou - afterYou > 0) lost += beforeYou - afterYou;
    n++;
  }
  return n > 0 ? lost / 3 : null;
}

// ---------------------------------------------------------------------------
// Elo trajectory
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Conversion & resilience (WDL-based)
// ---------------------------------------------------------------------------

export interface ConversionStats {
  /** games that reached wp >= 85 (user view) */
  wonWon: number;
  reachedWon: number;
  /** games that dropped to wp <= 15 */
  savedLost: number;
  reachedLost: number;
  /** reached-won games that were LOST (the "thrown wins"), worst first */
  thrown: { id: string; oppName: string; peak: number; drop: number }[];
}

export function conversionStats(games: GameSummary[]): ConversionStats {
  const out: ConversionStats = { wonWon: 0, reachedWon: 0, savedLost: 0, reachedLost: 0, thrown: [] };
  for (const g of games) {
    const imp = g.imp;
    if (!imp) continue;
    const o = outcome(g.result, g.youWhite);
    if (imp.peak.wp >= 85) {
      out.reachedWon++;
      if (o === "win") out.wonWon++;
      else if (o === "loss") {
        out.thrown.push({
          id: g.id,
          oppName: g.oppName,
          peak: Math.round(imp.peak.wp),
          drop: Math.round(imp.peak.wp),
        });
      }
    }
    if (imp.worst.wp <= 15) {
      out.reachedLost++;
      if (o !== "loss") out.savedLost++;
    }
  }
  out.thrown.sort((a, b) => b.peak - a.peak);
  return out;
}

// ---------------------------------------------------------------------------
// Phase split (opening <= book exit / endgame by material / middlegame)
// ---------------------------------------------------------------------------

export interface PhaseRow {
  phase: "opening" | "middlegame" | "endgame";
  /** user moves */
  moves: number;
  /** avg per-move accuracy of the user in this phase */
  acc: number | null;
  /** wp lost per 30 user moves (total drop rate) */
  leakPer30: number;
  /** notable mistakes in this phase (count of user mistake/blunder moves) */
  bad: number;
}

/** Where do points leak: opening vs middlegame vs endgame. */
export function phaseStats(games: GameSummary[]): PhaseRow[] {
  const acc: Record<string, { sum: number; n: number; leak: number; bad: number; moves: number }> = {
    opening: { sum: 0, n: 0, leak: 0, bad: 0, moves: 0 },
    middlegame: { sum: 0, n: 0, leak: 0, bad: 0, moves: 0 },
    endgame: { sum: 0, n: 0, leak: 0, bad: 0, moves: 0 },
  };
  for (const g of games) {
    const imp = g.imp;
    if (!imp) continue;
    const badPlies = new Set(imp.motifs.map((m) => m.ply));
    const userColor = g.youWhite ? "w" : "b";
    for (let k = 0; k < g.userAccs.length; k++) {
      const ply = userPly(k, g.youWhite);
      if (ply >= imp.wp.length) break;
      const phase: PhaseRow["phase"] =
        ply < imp.bookPly
          ? "opening"
          : imp.endPly != null && ply >= imp.endPly
            ? "endgame"
            : "middlegame";
      const b = acc[phase];
      b.sum += g.userAccs[k];
      b.n++;
      b.moves++;
      if (badPlies.has(ply)) b.bad++;
      const before = ply === 0 ? imp.wpStart : imp.wp[ply - 1];
      const after = imp.wp[ply];
      const beforeYou = g.youWhite ? before : 100 - before;
      const afterYou = g.youWhite ? after : 100 - after;
      if (beforeYou > afterYou) b.leak += beforeYou - afterYou;
      void userColor;
    }
  }
  const rows: PhaseRow[] = (["opening", "middlegame", "endgame"] as const).map((p) => {
    const b = acc[p];
    return {
      phase: p,
      moves: b.moves,
      acc: b.n > 0 ? Math.round(b.sum / b.n) : null,
      leakPer30: b.moves > 0 ? (b.leak / b.moves) * 30 : 0,
      bad: b.bad,
    };
  });
  return rows.filter((r) => r.moves > 0);
}

// ---------------------------------------------------------------------------
// Clock intelligence
// ---------------------------------------------------------------------------

export interface ClockStats {
  /** user moves with clock data */
  moves: number;
  /** notable mistakes while < 20 s / 20-60 s / > 60 s (remaining BEFORE move) */
  badLt20: number;
  bad20To60: number;
  badGt60: number;
  /** share (0..1) of user moves played with < 15% of the initial clock */
  ttShare: number;
  /** fast (< 3 s) moves that dropped >= 10 wp (impulsivity) */
  impulsive: number;
  /** avg thinking seconds by phase */
  avgThink: { opening: number | null; middlegame: number | null; endgame: number | null };
}

export function clockStats(games: GameSummary[]): ClockStats {
  const out: ClockStats = {
    moves: 0,
    badLt20: 0,
    bad20To60: 0,
    badGt60: 0,
    ttShare: 0,
    impulsive: 0,
    avgThink: { opening: null, middlegame: null, endgame: null },
  };
  const think: Record<string, { sum: number; n: number }> = {
    opening: { sum: 0, n: 0 },
    middlegame: { sum: 0, n: 0 },
    endgame: { sum: 0, n: 0 },
  };
  let ttMoves = 0;
  for (const g of games) {
    const imp = g.imp;
    if (!imp || imp.clocks.remaining.length === 0 || imp.clocks.initial <= 0) continue;
    const badPlies = new Set(imp.motifs.map((m) => m.ply));
    for (let k = 0; k < g.userAccs.length; k++) {
      const ply = userPly(k, g.youWhite);
      if (ply >= imp.wp.length) break;
      const remaining = imp.clocks.remaining[ply - 1] ?? 0; // before this move
      const spent = imp.clocks.spent[ply - 1] ?? 0;
      if (remaining <= 0) continue;
      out.moves++;
      if (remaining < imp.clocks.initial * 0.15) ttMoves++;
      if (badPlies.has(ply)) {
        if (remaining < 20) out.badLt20++;
        else if (remaining < 60) out.bad20To60++;
        else out.badGt60++;
      }
      const drop = (() => {
        const before = ply === 0 ? imp.wpStart : imp.wp[ply - 1];
        const after = imp.wp[ply];
        const b = g.youWhite ? before : 100 - before;
        const a = g.youWhite ? after : 100 - after;
        return b - a;
      })();
      if (spent < 3 && drop >= 10) out.impulsive++;
      const phase: "opening" | "middlegame" | "endgame" =
        ply < imp.bookPly
          ? "opening"
          : imp.endPly != null && ply >= imp.endPly
            ? "endgame"
            : "middlegame";
      think[phase].sum += spent;
      think[phase].n++;
    }
  }
  out.ttShare = out.moves > 0 ? ttMoves / out.moves : 0;
  const avg = (p: string): number | null => (think[p].n > 0 ? think[p].sum / think[p].n : null);
  out.avgThink = { opening: avg("opening"), middlegame: avg("middlegame"), endgame: avg("endgame") };
  return out;
}

// ---------------------------------------------------------------------------
// Motif aggregation ("half-points lost by cause")
// ---------------------------------------------------------------------------

export interface MotifRow {
  motif: Motif;
  n: number;
  /** game-points lost to this cause over the set (wp/100 summed) */
  points: number;
  /** share of all diagnosed bad-move cost (0..1) */
  share: number;
}

export function motifStats(games: GameSummary[]): MotifRow[] {
  const map = new Map<Motif, { n: number; points: number }>();
  let total = 0;
  for (const g of games) {
    const imp = g.imp;
    if (!imp) continue;
    for (const m of imp.motifs) {
      const e = map.get(m.motif) ?? { n: 0, points: 0 };
      e.n++;
      e.points += m.drop / 100;
      total += m.drop / 100;
      map.set(m.motif, e);
    }
  }
  const rows: MotifRow[] = [...map.entries()].map(([motif, e]) => ({
    motif,
    n: e.n,
    points: e.points,
    share: total > 0 ? e.points / total : 0,
  }));
  rows.sort((a, b) => b.points - a.points);
  return rows;
}

// ---------------------------------------------------------------------------
// Improvement trend (accuracy leads the rating)
// ---------------------------------------------------------------------------

export interface TrendPoint {
  t: number;
  acc: number;
  roll: number;
}

export interface TrendResult {
  points: TrendPoint[];
  /** accuracy of the first / last rolling window */
  from: number | null;
  to: number | null;
  /** slope in accuracy points per 20 games (linear fit on the tail) */
  slope20: number | null;
  window: number;
}

/** Rolling mean accuracy over game chronology (window default 15). */
export function improvementTrend(games: GameSummary[], window = 15): TrendResult {
  const list = games
    .filter((g) => g.userAcc != null)
    .slice()
    .sort((a, b) => a.utc - b.utc);
  const points: TrendPoint[] = [];
  for (let i = 0; i < list.length; i++) {
    const w = list.slice(Math.max(0, i - window + 1), i + 1);
    const roll = Math.round(w.reduce((s, g) => s + (g.userAcc ?? 0), 0) / w.length);
    points.push({ t: list[i].utc, acc: list[i].userAcc as number, roll });
  }
  let slope20: number | null = null;
  const tail = points.slice(-30);
  if (tail.length >= 8) {
    const n = tail.length;
    const xs = tail.map((_, i) => i);
    const meanX = (n - 1) / 2;
    const meanY = tail.reduce((s, p) => s + p.roll, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - meanX) * (tail[i].roll - meanY);
      den += (xs[i] - meanX) ** 2;
    }
    if (den > 0) slope20 = (num / den) * 20;
  }
  return {
    points,
    from: points.length > 0 ? points[Math.min(window - 1, points.length - 1)].roll : null,
    to: points.length > 0 ? points[points.length - 1].roll : null,
    slope20,
    window,
  };
}

// ---------------------------------------------------------------------------
// Calendar fun (keepers)
// ---------------------------------------------------------------------------

export interface HourRow {
  hour: number;
  wins: number;
  draws: number;
  losses: number;
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

// ---------------------------------------------------------------------------
// Row -> summary mapping
// ---------------------------------------------------------------------------

/**
 * Map the server's stats rows (games joined with their stored analysis) to
 * the per-game summaries the charts consume. Games without an analysis are
 * omitted - the runner treats "not in the map" as "to analyse".
 *
 * Must produce exactly what the live runner computes for the same game
 * (same accuracy formula, same counts), so resumed data is indistinguishable
 * from freshly computed data.
 */
export function summariesFromRows(rows: StatsGameRow[], window = 15): Record<string, GameSummary> {
  const out: Record<string, GameSummary> = {};
  void window;
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
    let imp: ImproveBlock | null = null;
    try {
      imp = buildImprove(r, r.youWhite ? r.whiteUsername : r.blackUsername);
    } catch {
      imp = null; // a broken PGN must never take the stats page down
    }
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
      imp,
    };
  }
  return out;
}
