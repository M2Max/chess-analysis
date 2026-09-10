import { useCallback, useEffect, useRef, useState } from "react";
import {
  UnknownPlayerError,
  type Game,
} from "./api/games";
import { DEMO_GAME } from "./api/demo";
import { fetchList, type PlayerList } from "./api/reviewDb";
import { GameList } from "./components/GameList";
import { PlayersView } from "./components/PlayersView";
import { ReviewView } from "./components/ReviewView";
import { SettingsView } from "./components/SettingsView";
import { StatsView } from "./components/StatsView";
import { PuzzleView } from "./components/PuzzleView";
import { getEngine } from "./engine/engine";
import { LANGS, I18nProvider, useI18n, type Lang, type TFn } from "./i18n";
import { clearLegacyUsername, legacyUsername, loadSettings, saveSettings, type Settings } from "./settings";

interface ListData extends PlayerList {
  username: string;
}

type Screen = "users" | "list" | "review" | "stats" | "puzzles" | "settings";

function friendlyError(e: unknown, t: TFn): string {
  if (e instanceof UnknownPlayerError) return t("errorPlayerNotFound");
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found: https:\/\/api\.chess\.com\/pub\/player/i.test(msg)) {
    return t("errorPlayerNotFound");
  }
  if (/data provider/i.test(msg)) {
    return t("errorFeed");
  }
  return msg;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  // colour theme on <html> so index.css variables switch (dark is default)
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  // keep the html lang attribute in sync with the selected language
  useEffect(() => {
    document.documentElement.lang = settings.lang;
  }, [settings.lang]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  return (
    <I18nProvider lang={settings.lang}>
      <AppInner settings={settings} updateSettings={updateSettings} />
    </I18nProvider>
  );
}

function AppInner({
  settings,
  updateSettings,
}: {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
}) {
  const { t, lang } = useI18n();
  const [screen, setScreen] = useState<Screen>(() =>
    new URLSearchParams(window.location.search).has("demo") ? "review" : "users",
  );
  /** the fetched list lives at App level so it survives screen changes */
  const [list, setList] = useState<ListData | null>(null);
  const [reviewGame, setReviewGame] = useState<Game | null>(() =>
    new URLSearchParams(window.location.search).has("demo") ? DEMO_GAME : null,
  );
  /** when opened from the stats autopsy: ply to park the cursor on */
  const [reviewPly, setReviewPly] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  /** single-player installs: seeded once into the Players grid, then cleared */
  const [legacy, setLegacy] = useState(() => legacyUsername());

  useEffect(() => {
    // reset on (re)mount: StrictMode runs cleanup in dev, which would
    // otherwise leave the flag false and drop every state update
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // close the language popover on outside click
  useEffect(() => {
    if (!langOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!langRef.current?.contains(e.target as Node)) setLangOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [langOpen]);

  // the review/stats views save analyses behind our back - re-read the list
  // (a fast local DB query, the same-day fetch is never re-run) so the row
  // labels pick up fresh accuracies
  const refreshListMeta = useCallback(() => {
    const u = list?.username;
    if (!u) return;
    void fetchList(u)
      .then((d) => {
        if (mounted.current) setList({ ...d, username: u });
      })
      .catch(() => {
        /* non-fatal: labels refresh on next visit */
      });
  }, [list?.username]);

  // warm the selected engine early (WASM fetch + worker boot)
  useEffect(() => {
    void getEngine(settings.engine, settings.threads).ensureReady().catch(() => {
      /* the review screen surfaces engine errors */
    });
  }, [settings.engine, settings.threads]);

  const openGame = useCallback((game: Game, ply?: number) => {
    setReviewPly(ply ?? null);
    setReviewGame(game);
    setScreen("review");
  }, []);

  /**
   * Fetch the last-30-days list from the server (which applies the same-day
   * rule itself and only calls the API when stale) and show the list screen
   * (or `opts.screen` when the caller wants to stay on e.g. the stats view).
   * `useCache: false` forces a fresh retrieval.
   */
  const retrieve = useCallback(
    async (username: string, opts: { useCache?: boolean; screen?: Screen } = {}) => {
      const u = username.trim();
      if (!u || busy) return;
      const target: Screen = opts.screen ?? "list";

      if (opts.useCache !== false && list?.username === u && list.fetchedAt != null) {
        setScreen(target);
        return;
      }

      setList({ username: u, fetchedAt: null, truncated: false, fromUtc: null, toUtc: null, games: [] });
      setScreen(target);
      setBusy(true);
      setError(null);
      try {
        const data = await fetchList(u, opts.useCache === false);
        if (!mounted.current) return;
        setList({ ...data, username: u });
      } catch (e) {
        if (!mounted.current) return;
        setList(null);
        setScreen("users");
        setError(friendlyError(e, t));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [busy, list, t],
  );

  const refreshList = useCallback(() => {
    if (list) void retrieve(list.username, { useCache: false });
  }, [list, retrieve]);

  // --- browser history -----------------------------------------------------
  // The "location" is derived from state: screen + active player + reviewed
  // game. Programmatic navigation changes the key -> the effect pushes a
  // history entry; the back button fires popstate and we restore state to
  // match the popped key (expectKey makes the push effect skip that round
  // trip so back never pushes forward again).
  const lastKeyRef = useRef<string | null>(null);
  const expectKeyRef = useRef("");
  const locKey =
    screen === "review"
      ? `review||${reviewGame?.id ?? ""}`
      : screen === "list"
        ? `list|${list?.username ?? ""}|`
        : screen === "stats"
          ? `stats|${list?.username ?? ""}|`
          : screen === "puzzles"
            ? `puzzles|${list?.username ?? ""}|`
            : screen === "settings"
              ? "settings||"
              : "users||";

  useEffect(() => {
    if (lastKeyRef.current == null) {
      // first paint owns the current entry (reload / deep link)
      lastKeyRef.current = locKey;
      window.history.replaceState({ k: locKey }, "");
      return;
    }
    if (locKey === lastKeyRef.current) return;
    lastKeyRef.current = locKey;
    if (locKey === expectKeyRef.current) {
      expectKeyRef.current = ""; // arrived here via the back/forward button
      return;
    }
    window.history.pushState({ k: locKey }, "");
  }, [locKey]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const k: string = (e.state as { k?: string } | null)?.k ?? "users||";
      expectKeyRef.current = k;
      const [scr, uname, gid] = k.split("|");
      if (scr === "review" && gid) {
        const g =
          gid === DEMO_GAME.id ? DEMO_GAME : list?.games.find((x) => x.id === gid);
        if (g) {
          setReviewGame(g);
          setReviewPly(null);
          setScreen("review");
        } else {
          // the game is not in the current list anymore: closest anchor
          setScreen("users");
        }
      } else if (scr === "list" && uname) {
        if (list?.username === uname) setScreen("list");
        else void retrieve(uname); // sets list+screen; key matches, no push
      } else if (scr === "stats" && uname && list?.username === uname) {
        setScreen("stats");
      } else if (scr === "puzzles") {
        setScreen("puzzles");
      } else if (scr === "settings") {
        setScreen("settings");
      } else {
        setScreen("users");
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [list, retrieve]);


  const toSettings = useCallback(() => {
    setScreen("settings");
    setError(null);
  }, []);

  const iconBtn =
    "rounded-md p-2 transition hover:bg-btn text-ink-mute hover:text-ink-soft";

  return (
    <div className="flex min-h-screen flex-col bg-app px-4 py-6 text-ink lg:px-8">
      <header className="mx-auto mb-6 flex w-full max-w-6xl items-center gap-3">
        <img
          src="/logo.png"
          alt=""
          className="h-9 w-9 rounded-md object-cover"
          width={36}
          height={36}
        />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-wide text-ink">chess-analysis</h1>
          <p className="truncate text-xs text-ink-faint">{t("tagline")}</p>
        </div>

        {/* actions, right-aligned (theme · language · statistics · settings) */}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => updateSettings({ theme: settings.theme === "dark" ? "light" : "dark" })}
            title={t("titleTheme")}
            aria-label={t("titleTheme")}
            className={iconBtn}
          >
            {settings.theme === "dark" ? (
              // sun
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            ) : (
              // moon
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>

          <div className="relative" ref={langRef}>
            <button
              onClick={() => setLangOpen((v) => !v)}
              title={t("titleLang")}
              aria-label={t("titleLang")}
              className={`rounded-md px-2.5 py-2 text-xs font-semibold transition hover:bg-btn ${
                langOpen ? "bg-btn text-ink" : "text-ink-mute hover:text-ink-soft"
              }`}
            >
              {LANGS[lang].short}
            </button>
            {langOpen && (
              <div className="absolute right-0 top-full z-30 mt-2 w-32 overflow-hidden rounded-lg bg-card-solid p-1 shadow-xl ring-1 ring-line-strong">
                {(Object.keys(LANGS) as Lang[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => {
                      updateSettings({ lang: l });
                      setLangOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-sm transition ${
                      l === lang ? "bg-accent-soft text-accent-soft-text" : "text-ink-soft hover:bg-btn"
                    }`}
                  >
                    {LANGS[l].name}
                    <span className="text-xs text-ink-faint">{LANGS[l].short}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* player-context buttons: visible from the game list onwards,
              hidden on home and settings (chrome-only there) */}
          <button
            onClick={() => setScreen("stats")}
            title={t("titleStats")}
            aria-label={t("titleStats")}
            className={`${iconBtn} ${screen === "stats" ? "text-accent" : ""} ${
              screen === "users" || screen === "settings" ? "hidden" : ""
            }`}
          >
            {/* stylized bar chart */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="3.5" y="13" width="4.5" height="8" rx="1" />
              <rect x="9.75" y="8" width="4.5" height="13" rx="1" />
              <rect x="16" y="3" width="4.5" height="18" rx="1" />
            </svg>
          </button>
          <button
            onClick={() => setScreen("puzzles")}
            title={t("titlePuzzles")}
            aria-label={t("titlePuzzles")}
            className={`${iconBtn} ${screen === "puzzles" ? "text-accent" : ""} ${
              screen === "users" || screen === "settings" ? "hidden" : ""
            }`}
          >
            {/* puzzle piece, monochrome */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 2a3 3 0 0 0-3 3v.5H7.5A1.5 1.5 0 0 0 6 7v1.5H5.5A1.5 1.5 0 0 0 4 10v2.5h1.5v2A2.5 2.5 0 0 0 8 17h2v2.5c0 .83.67 1.5 1.5 1.5h5c.83 0 1.5-.67 1.5-1.5V17h2a2.5 2.5 0 0 0 2.5-2.5v-2H22V10a1.5 1.5 0 0 0-1.5-1.5H20V7a1.5 1.5 0 0 0-1.5-1.5H15V5a3 3 0 0 0-3-3z" />
            </svg>
          </button>
          <button
            onClick={toSettings}
            title={t("titleSettings")}
            aria-label={t("titleSettings")}
            className={`${iconBtn} ${screen === "settings" ? "text-accent" : ""}`}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1">
        {screen === "users" && (
          <>
            {error && (
              <div className="mb-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-500 ring-1 ring-red-500/30">
                {error}
              </div>
            )}
            <PlayersView
              legacyUsername={legacy}
              onOpen={(u) => void retrieve(u)}
              onLegacySeeded={() => {
                clearLegacyUsername();
                setLegacy("");
              }}
            />
          </>
        )}

        {screen === "settings" && (
          <SettingsView
            settings={settings}
            onBack={() => setScreen("users")}
            onChange={updateSettings}
            onDemo={() => openGame(DEMO_GAME)}
          />
        )}

        {screen === "list" && list && (
          <GameList
            username={list.username}
            games={list.games}
            truncated={list.truncated}
            busy={busy}
            fetchedAt={list.fetchedAt}
            onSelect={openGame}
            onRefresh={refreshList}
            onBack={() => setScreen("users")}
          />
        )}

        {screen === "stats" &&
          (list && list.fetchedAt != null ? (
            <StatsView
              games={list.games}
              username={list.username}
              onBack={() => setScreen("list")}
              onOpenGame={openGame}
            />
          ) : (
            <div className="mx-auto mt-16 max-w-lg text-center">
              <div className="rounded-lg bg-card p-8 ring-1 ring-line">
                <p className="mb-4 text-sm text-ink-mute">{t("statsNeedUsername")}</p>
                <button
                  onClick={() => setScreen("users")}
                  className="rounded-md bg-accent-strong px-4 py-2 text-sm font-medium text-on-accent transition hover:bg-accent-strong-hover"
                >
                  {t("goPlayers")}
                </button>
              </div>
            </div>
          ))}

        {screen === "puzzles" && (
          <PuzzleView
            username={list?.username ?? ""}
            games={list?.games ?? []}
            engineKind={settings.engine}
            threads={settings.threads}
            onOpenGame={openGame}
            onGoPlayers={() => setScreen("users")}
            onExit={() => setScreen(list ? "list" : "users")}
          />
        )}

        {screen === "review" && reviewGame && (
          <ReviewView
            key={`${reviewGame.id}:${reviewPly ?? "n"}`}
            game={reviewGame}
            initialPly={reviewPly ?? undefined}
            engineKind={settings.engine}
            threads={settings.threads}
            analysisMode={settings.analysis}
            username={list?.username ?? ""}
            flip={settings.flip}
            onFlip={() => updateSettings({ flip: !settings.flip })}
            showArrow={settings.showArrow}
            onToggleArrow={() => updateSettings({ showArrow: !settings.showArrow })}
            onBack={list ? () => setScreen("list") : toSettings}
            onAnalysisSaved={refreshListMeta}
          />
        )}
      </main>

      <footer className="mx-auto mt-10 w-full max-w-6xl border-t border-line pt-4 text-center text-[11px] leading-relaxed text-ink-faint">
        <p>{t("footerApi")}</p>
        <p>{t("footerPieces")}</p>
      </footer>
    </div>
  );
}
