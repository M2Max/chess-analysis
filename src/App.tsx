import { useCallback, useEffect, useRef, useState } from "react";
import {
  UnknownPlayerError,
  type Game,
} from "./api/games";
import { DEMO_GAME } from "./api/demo";
import { fetchList, type PlayerList } from "./api/reviewDb";
import { GameList } from "./components/GameList";
import { ReviewView } from "./components/ReviewView";
import { SettingsView } from "./components/SettingsView";
import { Spinner } from "./components/Spinner";
import { StatsView } from "./components/StatsView";
import { getEngine } from "./engine/engine";
import { LANGS, I18nProvider, useI18n, type Lang, type TFn } from "./i18n";
import { loadSettings, saveSettings, type Settings } from "./settings";

interface ListData extends PlayerList {
  username: string;
}

type Screen = "settings" | "list" | "review" | "stats";

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
    new URLSearchParams(window.location.search).has("demo") ? "review" : "settings",
  );
  /** the fetched list lives at App level so it survives screen changes */
  const [list, setList] = useState<ListData | null>(null);
  const [reviewGame, setReviewGame] = useState<Game | null>(() =>
    new URLSearchParams(window.location.search).has("demo") ? DEMO_GAME : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

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

  const openGame = useCallback((game: Game) => {
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
        setScreen("settings");
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

  /** Settings "← Games": use the in-memory list, or fetch it. */
  const backToGames = useCallback(() => {
    if (list && list.fetchedAt != null) {
      setScreen("list");
      return;
    }
    if (settings.username.trim()) {
      void retrieve(settings.username, { useCache: true });
    }
  }, [list, settings.username, retrieve]);

  // the stats view needs the game list - fetch it (cached) when entering,
  // staying on the stats screen. Guarded so a failed fetch can't loop.
  const statsFetchTried = useRef(false);
  const prevScreenRef = useRef(screen);
  useEffect(() => {
    if (prevScreenRef.current !== "stats" && screen === "stats") statsFetchTried.current = false;
    prevScreenRef.current = screen;
    if (
      screen === "stats" &&
      !list &&
      !statsFetchTried.current &&
      settings.username.trim()
    ) {
      statsFetchTried.current = true;
      void retrieve(settings.username, { useCache: true, screen: "stats" });
    }
  }, [screen, list, settings.username, retrieve]);

  const toSettings = useCallback(() => {
    setScreen("settings");
    setError(null);
  }, []);

  const canGoToGames =
    (list != null && list.fetchedAt != null) || settings.username.trim() !== "";

  const iconBtn =
    "rounded-md p-2 transition hover:bg-btn text-ink-mute hover:text-ink-soft";

  return (
    <div className="flex min-h-screen flex-col bg-app px-4 py-6 text-ink lg:px-8">
      <header className="mx-auto mb-6 flex w-full max-w-6xl items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-600 text-lg text-white">
          ♞
        </div>
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

          <button
            onClick={() => setScreen("stats")}
            title={t("titleStats")}
            aria-label={t("titleStats")}
            className={`${iconBtn} ${screen === "stats" ? "text-accent" : ""}`}
          >
            {/* stylized bar chart */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="3.5" y="13" width="4.5" height="8" rx="1" />
              <rect x="9.75" y="8" width="4.5" height="13" rx="1" />
              <rect x="16" y="3" width="4.5" height="18" rx="1" />
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
        {screen === "settings" && (
          <SettingsView
            settings={settings}
            busy={busy}
            error={error}
            canGoToGames={canGoToGames}
            onBack={backToGames}
            onChange={updateSettings}
            onRetrieve={(u) => void retrieve(u)}
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
            onBack={toSettings}
          />
        )}

        {screen === "stats" &&
          (list && list.fetchedAt != null ? (
            <StatsView
              games={list.games}
              username={list.username}
              onBack={() => setScreen("list")}
            />
          ) : settings.username.trim() ? (
            <div className="mx-auto mt-16 flex max-w-lg items-center justify-center gap-3 rounded-lg bg-card p-10 text-ink-mute ring-1 ring-line">
              <Spinner className="h-5 w-5" /> {t("loadingGames")}
            </div>
          ) : (
            <div className="mx-auto mt-16 max-w-lg text-center">
              <div className="rounded-lg bg-card p-8 ring-1 ring-line">
                <p className="mb-4 text-sm text-ink-mute">{t("statsNeedUsername")}</p>
                <button
                  onClick={toSettings}
                  className="rounded-md bg-accent-strong px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-strong-hover"
                >
                  {t("goSettings")}
                </button>
              </div>
            </div>
          ))}

        {screen === "review" && reviewGame && (
          <ReviewView
            key={reviewGame.id}
            game={reviewGame}
            engineKind={settings.engine}
            threads={settings.threads}
            analysisMode={settings.analysis}
            username={settings.username}
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
