import { useEffect, useRef, useState } from "react";
import type { Game } from "../api/games";
import type { AnalysisMeta } from "../api/reviewDb";
import { useI18n, type StrKey, type TFn } from "../i18n";
import { Spinner } from "./Spinner";

interface Props {
  username: string;
  /** each game carries its best analysis meta (server-decorated) */
  games: (Game & { analysis: AnalysisMeta | null })[];
  truncated: boolean;
  busy: boolean;
  /** when the list was fetched (null = fetching now) */
  fetchedAt: number | null;
  onSelect: (game: Game) => void;
  onRefresh: () => void;
  onBack: () => void;
}

/**
 * The API's `time_control` is "180" (fixed seconds), "3+2" (min+sec),
 * "casual" or "correspondence". The class comes from the API's `time_class`,
 * derived from the seconds only as a fallback.
 */
export function timeControlLabel(g: { timeControl: string; timeClass?: string }, t: TFn): string {
  const tc = g.timeControl;
  if (!tc || tc === "casual") return t("tcCasual");
  if (tc === "correspondence") return t("tcCorrespondence");
  const cls = g.timeClass
    ? (t(`tc${g.timeClass.charAt(0).toUpperCase()}${g.timeClass.slice(1)}` as StrKey) ??
      g.timeClass.charAt(0).toUpperCase() + g.timeClass.slice(1))
    : null;
  const m = tc.match(/^(\d+)(?:\+(\d+))?$/);
  let ctrl: string;
  if (m) {
    if (m[2] == null) {
      const secs = Number(m[1]);
      ctrl = secs % 60 === 0 ? `${secs / 60} ${t("tcMin")}` : `${secs} s`;
    } else {
      ctrl = `${m[1]}+${m[2]}`;
    }
  } else {
    ctrl = tc;
  }
  if (!cls) {
    const secs = m ? (m[2] == null ? Number(m[1]) : Number(m[1]) * 60) : 0;
    const derived = !secs
      ? null
      : secs <= 30
        ? t("tcBullet")
        : secs <= 180
          ? t("tcBlitz")
          : secs <= 1800
            ? t("tcRapid")
            : t("tcClassical");
    return `${derived} ${ctrl}`;
  }
  return `${cls} ${ctrl}`;
}

function resultBadge(game: Game, youWhite: boolean, t: TFn): { text: string; cls: string } {
  const win = youWhite ? "1-0" : "0-1";
  const loss = youWhite ? "0-1" : "1-0";
  if (game.result === win) return { text: t("won"), cls: "bg-accent-soft text-accent-soft-text" };
  if (game.result === loss) return { text: t("lost"), cls: "bg-danger-soft text-danger" };
  if (game.result === "1/2-1/2") return { text: t("draw"), cls: "bg-btn text-ink-soft" };
  return { text: "-", cls: "bg-btn text-ink-mute" };
}

/** Tab ids: everything, the three online time classes, and long games. */
export type GameTab = "all" | "bullet" | "blitz" | "rapid" | "long";

export const GAME_TABS: { id: GameTab; key: StrKey }[] = [
  { id: "all", key: "tabAll" },
  { id: "bullet", key: "tabBullet" },
  { id: "blitz", key: "tabBlitz" },
  { id: "rapid", key: "tabRapid" },
  { id: "long", key: "tabLong" },
];

/**
 * Normalise a game into a tab. "Long" = classical + correspondence; casual
 * games only appear in "All". Falls back to deriving the class from the time
 * control when the API `time_class` is missing.
 */
export function timeClassOf(g: { timeControl: string; timeClass?: string }): GameTab | "other" {
  const tc = (g.timeClass ?? "").toLowerCase();
  if (tc === "bullet") return "bullet";
  if (tc === "blitz") return "blitz";
  if (tc === "rapid") return "rapid";
  if (tc === "classical" || tc === "correspondence") return "long";
  if (tc) return "other";
  const m = g.timeControl.match(/^(\d+)(?:\+(\d+))?$/);
  if (!m) return "other";
  const secs = m[2] == null ? Number(m[1]) : Number(m[1]) * 60;
  if (secs <= 60) return "bullet";
  if (secs <= 300) return "blitz";
  if (secs <= 1800) return "rapid";
  return "long";
}

export interface TimeRange {
  /** inclusive bounds, unix seconds */
  from: number;
  to: number;
}

/**
 * Pure list filter: tab + inclusive time range + sort direction.
 * `sortAsc` false = newest first (the default).
 */
export function filterGames<T extends Game>(games: T[], tab: GameTab, range: TimeRange | null, sortAsc: boolean): T[] {
  const out = games.filter((g) => {
    if (tab !== "all" && timeClassOf(g) !== tab) return false;
    if (range && (g.utc < range.from || g.utc > range.to)) return false;
    return true;
  });
  out.sort((a, b) => (sortAsc ? a.utc - b.utc : b.utc - a.utc));
  return out;
}

const icon = (d: string) =>
  function Icon() {
    return (
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={d} />
      </svg>
    );
  };

const ArrowDownIcon = icon("M12 5v14 M6 13l6 6 6-6"); // newest first (default)
const ArrowUpIcon = icon("M12 19V5 M6 11l6-6 6 6"); // oldest first
const CalendarIcon = icon("M8 2v4 M16 2v4 M3 9h18 M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z");
const ResetIcon = icon("M6 6l12 12 M18 6L6 18");

export function GameList({ username, games, truncated, busy, fetchedAt, onSelect, onRefresh, onBack }: Props) {
  const { t, locale } = useI18n();
  // the public index can lag behind by hours: flag it when the newest game in
  // the list looks old, so a no-op refresh doesn't look broken
  const newestUtc = games.length > 0 ? games[0].utc : null;
  const indexStale = newestUtc != null && Date.now() - newestUtc * 1000 > 12 * 3600 * 1000;

  // ---- tabs / sort / time-range (apply to every tab) --------------------
  const [tab, setTab] = useState<GameTab>("all");
  const [sortAsc, setSortAsc] = useState(false); // default: newest first
  const [rangeIso, setRangeIso] = useState<{ from: string; to: string } | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangePopRef = useRef<HTMLDivElement>(null);

  // extremes = youngest / oldest retrieved game (local calendar dates)
  const iso = (ts: number) => {
    const d = new Date(ts * 1000); // utc is unix seconds
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const minIso = games.length ? iso(Math.min(...games.map((g) => g.utc))) : null;
  const maxIso = games.length ? iso(Math.max(...games.map((g) => g.utc))) : null;

  // (re)initialise the range whenever a new list is fetched
  useEffect(() => {
    setRangeIso(minIso && maxIso ? { from: minIso, to: maxIso } : null);
    setRangeOpen(false);
  }, [minIso, maxIso]);

  // close the popover on outside click
  useEffect(() => {
    if (!rangeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!rangePopRef.current?.contains(e.target as Node)) setRangeOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [rangeOpen]);

  const dayStart = (s: string) => new Date(`${s}T00:00:00`).getTime() / 1000;
  const dayEnd = (s: string) => new Date(`${s}T23:59:59.999`).getTime() / 1000;
  const range: TimeRange | null =
    rangeIso && minIso && maxIso && (rangeIso.from !== minIso || rangeIso.to !== maxIso)
      ? { from: dayStart(rangeIso.from), to: dayEnd(rangeIso.to) }
      : null;
  const rangeActive = range != null;
  const shown = filterGames(games, tab, range, sortAsc);
  const filtered = shown.length !== games.length;

  const btnCls =
    "inline-flex items-center justify-center rounded-md bg-btn p-1.5 text-ink-soft transition hover:bg-btn-hover";
  const inputCls =
    "mt-1 w-full rounded border border-line-strong bg-card-solid px-2 py-1 text-sm text-ink outline-none focus:border-accent";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          onClick={onBack}
          className="rounded-md px-2 py-1 text-sm text-ink-mute transition hover:bg-btn hover:text-ink-soft"
        >
          {t("backToSettings")}
        </button>
        <h2 className="text-sm text-ink-mute">
          {t("last30days")} ·{" "}
          <span className="font-medium text-ink-soft">
            {filtered
              ? t("gamesCount", { shown: shown.length, total: games.length })
              : t("gamesCountAll", { total: games.length })}
          </span>
        </h2>
        <span className="ml-auto flex items-center gap-3">
          {fetchedAt != null && (
            <span className="text-xs text-ink-faint">
              {t("fetchedAt", {
                time: new Date(fetchedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
              })}
            </span>
          )}
          <button
            onClick={onRefresh}
            disabled={busy}
            className="rounded-md bg-btn px-3 py-1 text-xs text-ink-soft transition hover:bg-btn-hover disabled:opacity-40"
            title={t("refreshTitle")}
          >
            {busy ? t("refreshing") : t("refresh")}
          </button>
        </span>
      </div>

      {/* tabs + sort / time-range controls (shared across all tabs) */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-md bg-card p-1 ring-1 ring-line">
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

        <span className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => setSortAsc((v) => !v)}
            className={btnCls}
            title={t(sortAsc ? "sortOldest" : "sortNewest")}
          >
            {sortAsc ? <ArrowUpIcon /> : <ArrowDownIcon />}
          </button>
          <div className="relative" ref={rangePopRef}>
            <button
              onClick={() => setRangeOpen((v) => !v)}
              className={`${btnCls} ${rangeActive ? "text-accent" : ""}`}
              title={t("rangeTitle")}
            >
              <CalendarIcon />
            </button>
            {rangeOpen && rangeIso && (
              <div className="absolute right-0 top-full z-20 mt-2 w-60 space-y-3 rounded-lg bg-card-solid p-3 shadow-xl ring-1 ring-line-strong">
                <label className="block text-xs text-ink-mute">
                  {t("from")}
                  <input
                    type="date"
                    min={minIso ?? undefined}
                    max={rangeIso.to}
                    value={rangeIso.from}
                    onChange={(e) => e.target.value && setRangeIso({ ...rangeIso, from: e.target.value })}
                    className={inputCls}
                  />
                </label>
                <label className="block text-xs text-ink-mute">
                  {t("to")}
                  <input
                    type="date"
                    min={rangeIso.from}
                    max={maxIso ?? undefined}
                    value={rangeIso.to}
                    onChange={(e) => e.target.value && setRangeIso({ ...rangeIso, to: e.target.value })}
                    className={inputCls}
                  />
                </label>
                <p className="text-[11px] text-ink-faint">{t("rangeNote")}</p>
              </div>
            )}
          </div>
          {rangeActive && (
            <button
              onClick={() => minIso && maxIso && setRangeIso({ from: minIso, to: maxIso })}
              className="inline-flex items-center gap-1 rounded-md bg-btn px-2 py-1.5 text-xs text-ink-soft transition hover:bg-btn-hover"
              title={t("resetTitle")}
            >
              <ResetIcon /> {t("reset")}
            </button>
          )}
        </span>
      </div>

      {truncated && (
        <div className="mb-3 rounded-md border border-line-strong bg-card px-3 py-2 text-xs text-ink-mute">
          {t("truncatedWarning")}
        </div>
      )}
      {indexStale && (
        <div className="mb-3 rounded-md border border-line-strong bg-card px-3 py-2 text-xs text-ink-mute">
          {t("staleWarning")}
        </div>
      )}

      {busy && (
        <div className="mb-3 flex items-center gap-2 rounded-md bg-card px-3 py-2 text-sm text-ink-mute ring-1 ring-line">
          <Spinner className="h-4 w-4" /> {t("fetchingGames")}
        </div>
      )}

      {fetchedAt != null && shown.length === 0 && (
        <div className="mb-3 rounded-md bg-card p-6 text-center text-sm text-ink-mute ring-1 ring-line">
          {games.length === 0 ? (
            <p>{t("noGames", { username })}</p>
          ) : (
            <p>{t("noGamesFiltered")}</p>
          )}
        </div>
      )}

      <ul className="space-y-1.5">
        {shown.map((game) => {
          const youWhite = game.white.username.toLowerCase() === username.toLowerCase();
          const badge = resultBadge(game, youWhite, t);
          const a = game.analysis;
          return (
            <li key={game.id}>
              <button
                onClick={() => onSelect(game)}
                className="flex w-full items-center gap-2.5 rounded-md bg-card px-3 py-2.5 text-left ring-1 ring-line transition hover:bg-btn"
              >
                <span className={`w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-xs font-semibold ${badge.cls}`}>
                  {badge.text}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 truncate text-sm text-ink-soft">
                    <span className="font-medium text-ink">{youWhite ? game.black.username : game.white.username}</span>
                    <span className="text-ink-faint">
                      {youWhite ? "⚪" : "⚫"} · {timeControlLabel(game, t)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 truncate text-xs text-ink-faint">
                    <span>
                      {new Date(game.utc * 1000).toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" })}
                    </span>
                    {a?.opening?.name && (
                      <span className="truncate text-amber-600" title={a.opening.name}>
                        {a.opening.name}
                      </span>
                    )}
                    {a && (
                      <span
                        className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent-soft-text"
                        title={t("cachedTitle", { engine: a.engine, mode: a.mode })}
                      >
                        {t("analyzed")} · {youWhite ? "W" : "B"} {youWhite ? a.whiteAcc : a.blackAcc}%
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
