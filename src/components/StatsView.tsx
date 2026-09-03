/**
 * Statistics view: a full 30-day analysis of every game in the list.
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
import { EloChart, HBar, HourBars, MetricBars, fmtPct } from "./StatCharts";
import {
  accuracyForGames,
  accuracyHistogram,
  eloSeries,
  mistakesByClass,
  openingStats,
  pickTab,
  resultsByHour,
  resultsFor,
  winrateByGap,
  type GameSummary,
} from "../stats/statsData";
import { fetchStats } from "../api/reviewDb";
import { summariesFromRows } from "../stats/statsData";
import { runStats, statsThreads, type StatsProgress } from "../stats/statsRunner";
import { tabIdKey, useI18n, type StrKey } from "../i18n";

interface Props {
  games: Game[];
  username: string;
  onBack: () => void;
}

const card = "rounded-lg bg-card p-4 ring-1 ring-line";
const cardTitle = "mb-3 text-sm font-semibold text-ink-soft";

export function StatsView({ games, username, onBack }: Props) {
  const { t } = useI18n();
  // null = still loading the stored analyses from the server DB
  const [summaries, setSummaries] = useState<Record<string, GameSummary> | null>(null);
  const [progress, setProgress] = useState<StatsProgress | null>(null);
  const [tab, setTab] = useState<GameTab>("all");
  /** core budget for a run: all / half / single (less heat on phones) */
  const [coreSel, setCoreSel] = useState<"all" | "half" | "one">("all");
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

  const gapKey: Record<string, StrKey> = {
    stronger: "gapStronger",
    even: "gapEven",
    weaker: "gapWeaker",
  };

  return (
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

      {/* ---- intro / run control ------------------------------------------ */}
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

      {/* ---- sections (render live as games complete) ---------------------- */}
      {list.length > 0 && (
        <div className="space-y-6">
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

          {/* openings */}
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
                        { value: r.all.wins, cls: "bg-emerald-500", title: `W ${r.all.wins}` },
                        { value: r.all.draws, cls: "bg-neutral-500", title: `D ${r.all.draws}` },
                        { value: r.all.losses, cls: "bg-red-500", title: `L ${r.all.losses}` },
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
              <h2 className={cardTitle}>{t("secAccuracy")}</h2>
              <div className="space-y-2">
                {accuracyHistogram(list).map((b) => (
                  <HBar key={b.label} label={b.label} total={b.count} parts={[{ value: b.count, cls: "bg-sky-500/80" }]} />
                ))}
              </div>
            </div>
            <div className={card}>
              <h2 className={cardTitle}>{t("secMistakes")}</h2>
              <MetricBars
                rows={mistakesByClass(list).map((r) => ({
                  label: t(tabIdKey(r.tab)),
                  games: r.games,
                  a: r.avgWeak,
                  b: r.avgBlunders,
                }))}
                metricA={{ label: t("weakMoves"), cls: "bg-orange-400" }}
                metricB={{ label: t("blunders"), cls: "bg-red-500" }}
              />
            </div>
            <div className={card}>
              <h2 className={cardTitle}>{t("secWinrateGap")}</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                {winrateByGap(list).map((r) => (
                  <div key={r.gap} className="rounded-md bg-card-solid/40 p-3 text-center">
                    <div className="text-2xl font-semibold tabular-nums text-ink">
                      {fmtPct(r.winrate)}
                    </div>
                    <div className="mt-1 text-xs text-ink-mute">{t(gapKey[r.gap])}</div>
                    <div className="text-[11px] text-ink-faint">
                      {r.wins}W / {r.total}
                    </div>
                  </div>
                ))}
              </div>
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

/** Opening frequency / results table (book moves marked with the book icon). */
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
            <th className="pb-2 text-right font-medium">Acc</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              <td
                className="max-w-[280px] truncate py-1.5 pr-3 text-ink-soft"
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
              <td className="py-1.5 text-right tabular-nums text-ink-soft">
                {r.acc != null ? `${r.acc}%` : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
