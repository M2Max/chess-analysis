/**
 * Statistics view: a full 30-day analysis of every game in the list +
 * the improvement analytics (WDL curves, decisive-game autopsy, mistake
 * causes, phases, clock intelligence, performance rating, trend).
 *
 * Default state: an explanation card with a single button that starts the
 * run (fixed combo: lite engine, fast mode, all cores). The run is resumable
 * (every game's summary persists as it completes), so closing the tab
 * mid-run only costs the game in progress.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Game } from "../api/games";
import { GAME_TABS, type GameTab } from "./GameList";
import { CategorySymbol } from "./CategorySymbol";
import { Spinner } from "./Spinner";
import {
  EloChart,
  GapChart,
  HBar,
  HourBars,
  TrendChart,
  VBars,
  WpSpark,
  fmtPct,
} from "./StatCharts";
import { MotifDonut } from "./MotifDonut";
import { TipProvider } from "./chartTip";
import {
  accuracyForGames,
  clockStats,
  conversionStats,
  eloSeries,
  gapCurve,
  improvementTrend,
  motifStats,
  openingStats,
  performanceRating,
  phaseStats,
  pickTab,
  resultsByHour,
  resultsFor,
  summariesFromRows,
  type GameSummary,
} from "../stats/statsData";
import { fetchStats } from "../api/reviewDb";
import { runStats, statsThreads, type StatsProgress } from "../stats/statsRunner";
import type { Motif } from "../stats/motifs";
import type { TermKind } from "../stats/pgnMeta";
import { tabIdKey, useI18n, type StrKey } from "../i18n";

interface Props {
  games: Game[];
  username: string;
  onBack: () => void;
  /** open the review for a game, optionally starting at a given ply */
  onOpenGame: (game: Game, ply?: number) => void;
}

const card = "rounded-lg bg-card p-4 ring-1 ring-line";
const cardTitle = "mb-3 text-sm font-semibold text-ink-soft";

const TERM_KEY: Record<TermKind, StrKey> = {
  checkmate: "termCheckmate",
  resign: "termResign",
  timeoutYou: "termTimeoutYou",
  timeoutOpp: "termTimeoutOpp",
  agreed: "termAgreed",
  abandoned: "termAbandoned",
  other: "termOther",
};

const MOTIF_KEY: Record<Motif, StrKey> = {
  mateMissed: "motifMateMissed",
  timePressure: "motifTimePressure",
  missedCapture: "motifMissedCapture",
  hang: "motifHang",
  fork: "motifFork",
  pin: "motifPin",
  positional: "motifPositional",
};

export function StatsView({ games, username, onBack, onOpenGame }: Props) {
  const { t } = useI18n();
  // null = still loading the stored analyses from the server DB
  const [summaries, setSummaries] = useState<Record<string, GameSummary> | null>(null);
  const [progress, setProgress] = useState<StatsProgress | null>(null);
  const [tab, setTab] = useState<GameTab>("all");
  /** core budget for a run: all / half / single (less heat on phones) */
  const [coreSel, setCoreSel] = useState<"all" | "half" | "one">("all");
  /** autopsy filter set from the motif donut */
  const [motifFilter, setMotifFilter] = useState<Motif | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef<number>(Date.now());
  const summariesRef = useRef(summaries);
  summariesRef.current = summaries;

  const threads = statsThreads();
  const selThreads =
    coreSel === "all" ? threads : coreSel === "half" ? Math.max(1, Math.floor(threads / 2)) : 1;

  useEffect(() => {
    let cancelled = false;
    setSummaries(null);
    fetchStats(username)
      .then((rows) => {
        if (!cancelled) setSummaries(summariesFromRows(rows));
      })
      .catch(() => {
        // server offline: start from an empty set (the run will still work
        // and persist per game)
        if (!cancelled) setSummaries({});
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  const total = games.length;
  const running = progress?.state === "running";
  const finished = progress?.state === "done";

  // Only games of the CURRENT list count: after a refresh, games that fell
  // out of the 30-day window leave the calculus, new games make the run
  // "not done" again so the update button reappears.
  const currentIds = useMemo(() => new Set(games.map((g) => g.id)), [games]);
  const list = useMemo(
    () =>
      summaries
        ? Object.values(summaries)
            .filter((s) => currentIds.has(s.id))
            .sort((a, b) => b.utc - a.utc)
        : [],
    [summaries, currentIds],
  );
  const done = list.length;
  const allDone = total > 0 && done >= total;
  const newGames = total - done;
  const tabbed = useMemo(() => pickTab(list, tab), [list, tab]);
  // debug hook for browser scripts
  ;(window as unknown as { __statsState?: unknown }).__statsState = { progress, done, total, running };

  const start = useCallback(() => {
    if (abortRef.current || total === 0 || summariesRef.current == null) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    startedAtRef.current = Date.now();
    void runStats({
      games,
      username,
      t,
      signal: ctrl.signal,
      threads: selThreads,
      existing: summariesRef.current,
      onProgress: setProgress,
      // persistence happens per game inside the runner (PUT /api/db/...);
      // here we only keep the in-memory view fresh
      onGameSaved: (s) => {
        const next = { ...summariesRef.current, [s.id]: s };
        summariesRef.current = next;
        setSummaries(next);
      },
    }).finally(() => {
      abortRef.current = null;
    });
  }, [games, username, t, selThreads]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // abort on unmount (progress is already persisted per game)
  useEffect(() => () => abortRef.current?.abort(), []);

  const estMinutes = Math.max(1, Math.round((Math.max(1, newGames) * 25) / 60));

  if (summaries == null) {
    return (
      <div className="mx-auto mt-16 flex max-w-lg items-center justify-center gap-3 rounded-lg bg-card p-10 text-ink-mute ring-1 ring-line">
        <Spinner className="h-5 w-5" /> {t("loadingStored")}
      </div>
    );
  }

  const gameById = new Map(games.map((g) => [g.id, g]));

  return (
    <TipProvider>
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button
            onClick={onBack}
            className="rounded-md px-2 py-1 text-sm text-ink-mute transition hover:bg-btn hover:text-ink-soft"
          >
            {t("backToGames")}
          </button>
          <h1 className="text-base font-semibold text-ink">{t("statsTitle")}</h1>
          <span className="text-xs text-ink-faint">
            {t("statsSubtitle", { username, total })}
          </span>
        </div>

        {/* ---- intro / run control ---------------------------------------- */}
        {!running && !allDone && (
          <div className={`${card} mb-6 flex flex-col items-center px-6 py-10 text-center`}>
            <div className="mb-3 text-3xl">📊</div>
            <h2 className="mb-2 text-lg font-semibold text-ink">{t("statsIntroTitle")}</h2>
            <p className="mb-4 max-w-xl text-sm text-ink-mute">
              {t("statsIntroBody", { total, combo: `lite · fast · ${t("cores", { n: selThreads })}` })}
              {done > 0 && (
                <span className="text-accent">
                  {" "}
                  {t("statsIntroDone", { done, total, newPart: newGames > 0 ? t("statsIntroNew", { n: newGames }) : "" })}
                </span>
              )}
              <span className="text-ink-faint"> {t("statsEstimate", { min: estMinutes })}</span>
            </p>
            <div className="mb-5 max-w-xl rounded-md border border-warn-border bg-warn px-4 py-3 text-xs text-warn-text">
              {t("statsWarning")}
            </div>
            <div className="mb-4 flex flex-col items-center gap-1.5">
              <div className="flex flex-wrap justify-center gap-1 rounded-md bg-card-solid/50 p-1 ring-1 ring-line">
                {(
                  [
                    ["all", t("coresAll", { n: threads })],
                    ["half", t("coresHalf", { n: Math.max(1, Math.floor(threads / 2)) })],
                    ["one", t("coresOne")],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setCoreSel(id)}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                      coreSel === id
                        ? "bg-accent-soft text-accent-soft-text"
                        : "text-ink-mute hover:bg-btn hover:text-ink-soft"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="max-w-md text-center text-[11px] leading-snug text-ink-faint">
                {t("coresHint")}
              </span>
              <span className="max-w-md text-center text-[11px] leading-snug text-ink-faint">
                {t("statsEstimate", { min: estMinutes })}
              </span>
            </div>
            <button
              onClick={start}
              className="rounded-md bg-accent-strong px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-strong-hover"
            >
              {done > 0 ? t("updateAnalysis", { done, total }) : t("startFull")}
            </button>
          </div>
        )}

        {running && progress && (
          <div className={`${card} mb-6`}>
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Spinner className="h-4 w-4 text-accent" />
              <span className="text-sm font-medium text-ink">
                {t("analyzingGame", {
                  i: progress.gameIndex + 1,
                  n: progress.gameTotal,
                  resumed: progress.preDone > 0 ? t("resumed", { n: progress.preDone }) : "",
                  label: progress.label,
                })}
              </span>
              <span className="text-xs text-ink-faint">
                {t("moveProgress", { done: progress.moveDone, total: progress.moveTotal })}
              </span>
              {progress.etaMs != null && progress.etaMs > 0 && (
                <span className="text-xs text-ink-faint">
                  {t("minLeft", { min: Math.max(1, Math.round(progress.etaMs / 60000)) })}
                </span>
              )}
              <button
                onClick={stop}
                className="ml-auto rounded-md bg-btn px-3 py-1 text-xs text-ink-soft transition hover:bg-btn-hover"
                title={t("stopTitle")}
              >
                {t("stopBtn")}
              </button>
            </div>
            <div className="h-2 overflow-hidden rounded bg-card-solid/60">
              <div
                className="h-full rounded bg-accent transition-[width] duration-300"
                style={{
                  width: `${
                    ((progress.gameIndex + (progress.moveTotal > 0 ? progress.moveDone / progress.moveTotal : 0)) /
                      Math.max(1, progress.gameTotal)) *
                    100
                  }%`,
                }}
              />
            </div>
          </div>
        )}

        {finished && allDone && (
          <div className="mb-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-accent-soft-text">
            {t("doneBanner", { games: total, moves: list.reduce((s, g) => s + g.moves, 0) })}
          </div>
        )}

        {/* ---- sections (render live as games complete) -------------------- */}
        {list.length > 0 && (
          <div className="space-y-6">
            <HeadlineStrip games={tabbed} />

            {/* results per time class */}
            <section className={card}>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <h2 className={`${cardTitle} mb-0`}>{t("secResults")}</h2>
                <div className="flex rounded-md bg-card-solid/50 p-1 ring-1 ring-line">
                  {GAME_TABS.map((tb) => (
                    <button
                      key={tb.id}
                      onClick={() => setTab(tb.id)}
                      className={`rounded px-3 py-1 text-xs font-medium transition ${
                        tab === tb.id ? "bg-accent-soft text-accent-soft-text" : "text-ink-mute hover:text-ink-soft"
                      }`}
                    >
                      {t(tb.key)}
                    </button>
                  ))}
                </div>
              </div>
              <ResultsBlock games={tabbed} />
            </section>

            {/* mistakes by cause + autopsy (the heart of the page) */}
            <MotifsAndAutopsy
              list={list}
              gameById={gameById}
              motifFilter={motifFilter}
              setMotifFilter={setMotifFilter}
              onOpenGame={onOpenGame}
            />

            {/* where points leak + conversion */}
            <section className="grid gap-6 lg:grid-cols-2">
              <PhaseCard games={tabbed} />
              <ConversionCard list={list} onOpenGame={(id, ply) => {
                const g = gameById.get(id);
                if (g) onOpenGame(g, ply);
              }} />
            </section>

            {/* clock */}
            <ClockCard games={tabbed} />

            {/* openings (with performance + post-book gap) */}
            <section className={card}>
              <h2 className={cardTitle}>
                <span className="mr-1.5 inline-block align-[-0.1em] text-cat-opening">
                  <CategorySymbol category="opening" />
                </span>
                {t("secOpenings")}
              </h2>
              <OpeningTable games={list} />
            </section>

            {/* charts */}
            <section className="grid gap-6 lg:grid-cols-2">
              <div className={card}>
                <h2 className={cardTitle}>{t("secElo")}</h2>
                <EloChart series={eloSeries(list)} />
              </div>
              <div className={card}>
                <h2 className={cardTitle}>{t("secResultsByClass")}</h2>
                <div className="space-y-3">
                  {(["bullet", "blitz", "rapid", "long"] as GameTab[]).map((tc) => {
                    const r = resultsFor(pickTab(list, tc));
                    if (r.all.total === 0) return null;
                    return (
                      <HBar
                        key={tc}
                        label={t(tabIdKey(tc))}
                        total={r.all.total}
                        parts={[
                          { value: r.all.wins, cls: "bg-emerald-500", lines: () => [t(tabIdKey(tc)), `${t("winsWord")}: ${r.all.wins}`] },
                          { value: r.all.draws, cls: "bg-neutral-500", lines: () => [t(tabIdKey(tc)), `${t("drawsWord")}: ${r.all.draws}`] },
                          { value: r.all.losses, cls: "bg-red-500", lines: () => [t(tabIdKey(tc)), `${t("lossesWord")}: ${r.all.losses}`] },
                        ]}
                      />
                    );
                  })}
                </div>
                <div className="mt-3 flex gap-4 text-[11px] text-ink-mute">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> {t("winsWord")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-neutral-500" /> {t("drawsWord")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-red-500" /> {t("lossesWord")}
                  </span>
                </div>
              </div>
              <div className={card}>
                <h2 className={cardTitle}>{t("secGap")}</h2>
                <GapChart buckets={gapCurve(list)} />
              </div>
              <div className={card}>
                <h2 className={cardTitle}>
                  {t("secTrend")}{" "}
                  <span className="font-normal text-ink-faint" title={t("trendHint")}>
                    ⓘ
                  </span>
                </h2>
                <TrendChart points={improvementTrend(list).points} window={15} />
              </div>
              <div className={card}>
                <h2 className={cardTitle}>{t("secHour")}</h2>
                <HourBars data={resultsByHour(list)} />
              </div>
            </section>
          </div>
        )}

        {total === 0 && (
          <div className={`${card} p-10 text-center text-sm text-ink-mute`}>
            {t("noGamesFiltered")}
          </div>
        )}
      </div>
    </TipProvider>
  );
}

/* ========================================================================== */

/** Headline metrics: winrate, performance, latest rating, accuracy, trend. */
function HeadlineStrip({ games }: { games: GameSummary[] }) {
  const { t } = useI18n();
  const r = resultsFor(games);
  const pr = performanceRating(games);
  const acc = accuracyForGames(games);
  const series = eloSeries(games);
  const latest = (Object.keys(series) as (keyof typeof series)[])
    .map((k) => series[k][series[k].length - 1])
    .filter(Boolean)
    .sort((a, b) => b.t - a.t)[0];
  const trend = improvementTrend(games);
  const slope = trend.slope20;
  return (
    <section className={card}>
      <h2 className={cardTitle}>{t("secHeadline")}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Metric label={t("winrateWord")} value={fmtPct(r.all.winrate)} sub={`${r.all.wins}W ${r.all.draws}D ${r.all.losses}L`} />
        <Metric
          label={t("perfWord")}
          value={pr != null ? String(pr) : "-"}
          sub={t("perfHint")}
        />
        <Metric
          label={t("ratingWord")}
          value={latest ? String(latest.rating) : "-"}
          sub={latest ? t(tabIdKey("all")) : ""}
        />
        <Metric label={t("accuracy")} value={acc.avg != null ? `${acc.avg}%` : "-"} sub={t("gamesWord", { n: acc.analyzedGames })} />
        <Metric
          label={t("secTrend")}
          value={slope == null ? "-" : `${slope >= 0 ? "+" : ""}${slope.toFixed(1)}`}
          sub={slope == null ? "" : Math.abs(slope) < 1 ? t("trendSteady") : t("trendSlope", { delta: slope >= 0 ? `+${slope.toFixed(1)}` : slope.toFixed(1) })}
        />
      </div>
    </section>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md bg-card-solid/40 p-3" title={sub && sub.length > 30 ? sub : undefined}>
      <div className="text-xs uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-ink">{value}</div>
      {sub && sub.length <= 30 && <div className="mt-0.5 text-[10px] leading-tight text-ink-faint">{sub}</div>}
    </div>
  );
}

/** Motif donut + the decisive-games autopsy list (filtered by it). */
function MotifsAndAutopsy({
  list,
  gameById,
  motifFilter,
  setMotifFilter,
  onOpenGame,
}: {
  list: GameSummary[];
  gameById: Map<string, Game>;
  motifFilter: Motif | null;
  setMotifFilter: (m: Motif | null) => void;
  onOpenGame: (g: Game, ply?: number) => void;
}) {
  const { t } = useI18n();
  const rows = motifStats(list);
  const autopsy = useMemo(() => {
    const decisive = list.filter((g) => {
      if (!g.imp || g.result === "1/2-1/2") return false;
      if (!motifFilter) return g.imp.drop != null;
      return g.imp.motifs.some((m) => m.motif === motifFilter);
    });
    decisive.sort((a, b) => {
      const da = motifFilter
        ? Math.max(0, ...a.imp!.motifs.filter((m) => m.motif === motifFilter).map((m) => m.drop))
        : (a.imp?.drop?.wp ?? 0);
      const db = motifFilter
        ? Math.max(0, ...b.imp!.motifs.filter((m) => m.motif === motifFilter).map((m) => m.drop))
        : (b.imp?.drop?.wp ?? 0);
      return db - da;
    });
    return decisive.slice(0, 15);
  }, [list, motifFilter]);

  return (
    <section className={card}>
      <h2 className={cardTitle}>{t("secMotifs")}</h2>
      <p className="mb-3 text-xs text-ink-faint">{t("motifsHint")}</p>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-mute">{t("noMotifsYet")}</div>
      ) : (
        <MotifDonut rows={rows} selected={motifFilter} onSelect={setMotifFilter} />
      )}

      <h3 className="mb-1 mt-6 text-sm font-semibold text-ink-soft">{t("secAutopsy")}</h3>
      <p className="mb-2 text-xs text-ink-faint">{t("autopsyHint")}</p>
      <ul className="divide-y divide-line">
        {autopsy.map((g) => {
          const imp = g.imp!;
          const hit = motifFilter ? imp.motifs.filter((m) => m.motif === motifFilter) : [];
          const focus = hit[0] ?? imp.drop;
          const ply = focus && "ply" in focus ? focus.ply : null;
          const dropVal: number = focus
            ? "wp" in focus
              ? (focus as { wp: number }).wp
              : (focus as { drop: number }).drop
            : 0;
          const loss = outcomeOf(g);
          return (
            <li key={g.id}>
              <button
                className="flex w-full items-center gap-3 py-2 text-left transition hover:bg-btn"
                onClick={() => {
                  const game = gameById.get(g.id);
                  if (game) onOpenGame(game, ply ?? undefined);
                }}
              >
                <span className="w-32 min-w-0 shrink-0">
                  <span className={`block truncate text-sm font-medium ${loss === "loss" ? "text-danger" : "text-ink"}`}>
                    {loss === "loss" ? "−" : "+"} {g.oppName}
                  </span>
                  <span className="block truncate text-[10px] text-ink-faint">
                    {t(TERM_KEY[imp.term])}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <WpSpark wp={imp.wp} youWhite={g.youWhite} dropPly={imp.drop?.ply ?? null} />
                </span>
                <span className="w-40 shrink-0 text-right">
                  {focus ? (
                    <>
                      <span className="block text-xs font-medium tabular-nums text-ink">
                        {t("moveNumber", { n: Math.floor(focus.ply / 2) + 1 })} · {focus.san}{" "}
                        <span className="text-danger">−{Math.round(dropVal)}</span>
                      </span>
                      <span className="block truncate text-[10px] text-ink-faint">
                        {motifFilter
                          ? t(MOTIF_KEY[motifFilter])
                          : imp.drop?.bestSan
                            ? `${t("bestMoveWas")}: ${imp.drop.bestSan}`
                            : t("biggestDrop")}
                      </span>
                    </>
                  ) : (
                    <span className="text-[10px] text-ink-faint">{t("reviewFromHere")}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function outcomeOf(g: GameSummary): "win" | "draw" | "loss" {
  if (g.result === "1/2-1/2") return "draw";
  const youWon = g.youWhite ? g.result === "1-0" : g.result === "0-1";
  return youWon ? "win" : "loss";
}

/** Where points leak: opening / middlegame / endgame. */
function PhaseCard({ games }: { games: GameSummary[] }) {
  const { t } = useI18n();
  const rows = phaseStats(games);
  const max = Math.max(0.001, ...rows.map((r) => r.leakPer30));
  const name = (p: string) =>
    t(p === "opening" ? "phaseOpening" : p === "endgame" ? "phaseEndgame" : "phaseMiddlegame");
  return (
    <div className={card}>
      <h2 className={cardTitle}>
        {t("secPhases")}{" "}
        <span className="font-normal text-ink-faint" title={t("phaseHint")}>
          ⓘ
        </span>
      </h2>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-mute">-</div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.phase}>
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-ink-soft">{name(r.phase)}</span>
                <span className="text-ink-faint">
                  {t("accuracy")}: {r.acc ?? "-"} · {r.bad} ✗
                </span>
              </div>
              <div
                className="h-3 cursor-help rounded bg-card-solid/60"
                title={`${name(r.phase)} · ${r.leakPer30.toFixed(1)} ${t("leakPer30")}`}
              >
                <div
                  className="h-full rounded bg-orange-500/70"
                  style={{ width: `${(r.leakPer30 / max) * 100}%` }}
                />
              </div>
            </div>
          ))}
          <div className="text-[10px] text-ink-faint">{t("leakPer30")} →</div>
        </div>
      )}
    </div>
  );
}

/** Conversion (won from won) + resilience (saved from lost) + thrown wins. */
function ConversionCard({ list, onOpenGame }: { list: GameSummary[]; onOpenGame: (id: string, ply?: number) => void }) {
  const { t } = useI18n();
  const c = conversionStats(list);
  const wonWonPct = c.reachedWon > 0 ? Math.round((c.wonWon / c.reachedWon) * 100) : null;
  const savedPct = c.reachedLost > 0 ? Math.round((c.savedLost / c.reachedLost) * 100) : null;
  return (
    <div className={card}>
      <h2 className={cardTitle}>
        {t("secConversion")}{" "}
        <span className="font-normal text-ink-faint" title={t("conversionHint")}>
          ⓘ
        </span>
      </h2>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md bg-card-solid/40 p-3 text-center" title={t("wonWon")}>
          <div className="text-2xl font-semibold tabular-nums text-ink">
            {wonWonPct != null ? `${wonWonPct}%` : "-"}
          </div>
          <div className="mt-1 text-[11px] text-ink-mute">
            {t("wonWon")} ({c.wonWon}/{c.reachedWon})
          </div>
        </div>
        <div className="rounded-md bg-card-solid/40 p-3 text-center" title={t("savedLost")}>
          <div className="text-2xl font-semibold tabular-nums text-ink">
            {savedPct != null ? `${savedPct}%` : "-"}
          </div>
          <div className="mt-1 text-[11px] text-ink-mute">
            {t("savedLost")} ({c.savedLost}/{c.reachedLost})
          </div>
        </div>
      </div>
      {c.thrown.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-faint">
            {t("thrownWins")}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {c.thrown.slice(0, 8).map((g) => (
              <button
                key={g.id}
                onClick={() => onOpenGame(g.id)}
                className="rounded-full bg-red-500/15 px-2.5 py-1 text-[11px] text-red-400 ring-1 ring-red-500/30 transition hover:bg-red-500/25"
                title={`${t("thrownWins")} · ${t("reviewFromHere")}`}
              >
                vs {g.oppName} · {g.peak}%
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Clock intelligence: mistakes by remaining time, TT share, impulsivity. */
function ClockCard({ games }: { games: GameSummary[] }) {
  const { t } = useI18n();
  const c = clockStats(games);
  if (c.moves === 0) return null;
  return (
    <section className={card}>
      <h2 className={cardTitle}>
        {t("secClock")}{" "}
        <span className="font-normal text-ink-faint" title={t("clockHint")}>
          ⓘ
        </span>
      </h2>
      <div className="grid gap-6 md:grid-cols-3">
        <div>
          <div className="mb-2 text-xs text-ink-mute">{t("badWithTime")}</div>
          <VBars
            rows={[
              { label: t("lt20s"), value: c.badLt20 },
              { label: t("from20to60s"), value: c.bad20To60 },
              { label: t("gt60s"), value: c.badGt60 },
            ]}
            colorFor={(_, i) => ["bg-red-500/80", "bg-orange-400/80", "bg-sky-500/70"][i]}
          />
        </div>
        <div className="space-y-3">
          <div className="rounded-md bg-card-solid/40 p-3">
            <div className="text-xl font-semibold tabular-nums text-ink">
              {Math.round(c.ttShare * 100)}%
            </div>
            <div className="text-[11px] text-ink-mute">{t("timeTroubleShare")}</div>
          </div>
          <div className="rounded-md bg-card-solid/40 p-3" title={t("impulsiveHint")}>
            <div className="text-xl font-semibold tabular-nums text-ink">{c.impulsive}</div>
            <div className="text-[11px] text-ink-mute">
              {t("impulsive")} · {t("impulsiveHint")}
            </div>
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs text-ink-mute">{t("avgThink")}</div>
          <VBars
            rows={[
              { label: t("phaseOpening"), value: c.avgThink.opening ?? 0, sub: "s" },
              { label: t("phaseMiddlegame"), value: c.avgThink.middlegame ?? 0, sub: "s" },
              { label: t("phaseEndgame"), value: c.avgThink.endgame ?? 0, sub: "s" },
            ]}
            colorFor={() => "bg-emerald-500/70"}
            format={(v) => `${v.toFixed(1)}s`}
          />
        </div>
      </div>
    </section>
  );
}

/** The three winrate blocks (overall / white / black) + accuracies. */
function ResultsBlock({ games }: { games: GameSummary[] }) {
  const { t } = useI18n();
  const r = resultsFor(games);
  const acc = accuracyForGames(games);
  const blockCls = "rounded-md bg-card-solid/40 p-3";
  const lblCls = "text-xs uppercase tracking-wide text-ink-faint";
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className={blockCls}>
        <div className={lblCls}>{t("overall")}</div>
        <ResultFigures c={r.all} />
      </div>
      <div className={blockCls}>
        <div className={lblCls}>{t("playingWhite")}</div>
        <ResultFigures c={r.white} />
      </div>
      <div className={blockCls}>
        <div className={lblCls}>{t("playingBlack")}</div>
        <ResultFigures c={r.black} />
      </div>
      <div className="sm:col-span-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md bg-card-solid/40 px-3 py-2 text-sm">
          <span className={lblCls}>{t("accuracy")}</span>
          <span>
            avg <b className="tabular-nums text-ink">{acc.avg != null ? `${acc.avg}%` : "-"}</b>
          </span>
          <span>
            W <b className="tabular-nums text-ink">{acc.white != null ? `${acc.white}%` : "-"}</b>
          </span>
          <span>
            B <b className="tabular-nums text-ink">{acc.black != null ? `${acc.black}%` : "-"}</b>
          </span>
          <span className="ml-auto text-xs text-ink-faint">
            {t("analyzedGames", { games: acc.analyzedGames, moves: acc.totalMoves })}
          </span>
        </div>
      </div>
    </div>
  );
}

function ResultFigures({ c }: { c: { total: number; wins: number; draws: number; losses: number; winrate: number | null } }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums text-ink">
        {c.total > 0 ? <>{fmtPct(c.winrate)}</> : "-"}
      </div>
      <div className="mt-1 flex gap-3 text-xs tabular-nums">
        <span className="text-accent-soft-text">{c.wins}W</span>
        <span className="text-ink-mute">{c.draws}D</span>
        <span className="text-danger">{c.losses}L</span>
        <span className="text-ink-faint">{c.total}</span>
      </div>
    </div>
  );
}

/** Opening frequency / results / performance / post-book gap table. */
function OpeningTable({ games }: { games: GameSummary[] }) {
  const { t } = useI18n();
  const rows = openingStats(games);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
            <th className="pb-2 pr-3 font-medium">{t("thOpening")}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t("thGames")}</th>
            <th className="pb-2 pr-3 text-right font-medium">W</th>
            <th className="pb-2 pr-3 text-right font-medium">D</th>
            <th className="pb-2 pr-3 text-right font-medium">L</th>
            <th className="pb-2 pr-3 text-right font-medium">%</th>
            <th className="pb-2 pr-3 text-right font-medium">{t("thPerf")}</th>
            <th className="pb-2 text-right font-medium" title={t("postBookHint")}>
              {t("thPostBook")} ↘
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              <td
                className="max-w-[260px] truncate py-1.5 pr-3 text-ink-soft"
                title={r.name ? `${r.name} (${r.eco})` : t("noBookMatch")}
              >
                {i < 5 && r.name && (
                  <span className="mr-1.5 inline-block align-[-0.1em] text-cat-opening">
                    <CategorySymbol category="opening" />
                  </span>
                )}
                {r.name ?? <span className="italic text-ink-faint">{t("noBookMatch")}</span>}{" "}
                {r.eco ? <span className="text-xs text-ink-faint">{r.eco}</span> : null}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-ink-soft">{r.count}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-accent-soft-text">{r.wins}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-ink-mute">{r.draws}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-danger">{r.losses}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-ink-soft">{fmtPct(r.winrate)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-ink-soft">{r.pr ?? "-"}</td>
              <td
                className="py-1.5 text-right tabular-nums"
                title={r.postBookDrop != null ? `${r.postBookDrop.toFixed(1)} · ${t("postBookHint")}` : undefined}
              >
                {r.postBookDrop != null ? (
                  <span className={r.postBookDrop >= 8 ? "text-danger" : r.postBookDrop >= 4 ? "text-orange-400" : "text-ink-faint"}>
                    −{r.postBookDrop.toFixed(1)}
                  </span>
                ) : (
                  <span className="text-ink-faint">-</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
