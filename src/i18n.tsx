/**
 * UI internationalisation. Italian is the default language, English is the
 * alternative (the header selector switches, persisted in settings).
 *
 * Every user-visible string lives in the STRINGS table below - components
 * never hardcode display text. `t(key, vars?)` interpolates {placeholders}.
 * Dates are formatted with the language's BCP-47 locale.
 */
import { createContext, useContext } from "react";

export type Lang = "it" | "en";
export type Theme = "dark" | "light";

export const LANGS: Record<Lang, { name: string; short: string; locale: string }> = {
  it: { name: "Italiano", short: "IT", locale: "it-IT" },
  en: { name: "English", short: "EN", locale: "en-GB" },
};

const STRINGS = {
  // ── app shell ────────────────────────────────────────────────────────────
  tagline: {
    it: "Analisi delle partite con Stockfish, interamente nel tuo browser",
    en: "Stockfish-powered game review, fully in your browser",
  },
  errorFeed: {
    it: "Il flusso delle partite è temporaneamente non disponibile (\"Data provider not found\"). È un'interruzione nota e transitoria: riprova tra un minuto oppure prova la partita demo.",
    en: "The game feed is temporarily unavailable (\"Data provider not found\"). This is a known transient outage: retry in a minute, or try the demo game.",
  },
  errorPlayerNotFound: {
    it: "Nessun giocatore trovato con quel nome. Controlla la scrittura: i nomi utente distinguono maiuscole e minuscole.",
    en: "No player found with that name. Check the spelling: usernames are case sensitive.",
  },
  footerApi: {
    it: "Le partite provengono dalle API pubbliche di chess.com.",
    en: "Game history comes from the chess.com public APIs.",
  },
  footerPieces: {
    it: "Pedine Staunty di lichess (CC0). Analisi: Stockfish WASM.",
    en: "Staunty pieces by lichess (CC0). Analysis: Stockfish WASM.",
  },
  titleStats: {
    it: "Statistiche (analisi completa degli ultimi 30 giorni)",
    en: "Statistics (full 30-day analysis)",
  },
  titleSettings: { it: "Impostazioni", en: "Settings" },
  titleTheme: {
    it: "Cambia tema (chiaro / scuro)",
    en: "Toggle colour theme (light / dark)",
  },
  titleLang: { it: "Lingua", en: "Language" },

  // ── settings ─────────────────────────────────────────────────────────────
  backToGames: { it: "← Partite", en: "← Games" },
  backToSettings: { it: "← Impostazioni", en: "← Settings" },
  settingsTitle: { it: "Impostazioni", en: "Settings" },
  settingsSubtitle: {
    it: "Le preferenze sono salvate in questo browser.",
    en: "Preferences are stored in this browser.",
  },
  usernameLabel: { it: "Nome utente", en: "Username" },
  usernamePlaceholder: { it: "il tuo nome utente", en: "your username" },
  engineLabel: { it: "Motore", en: "Engine" },
  engineLiteDesc: {
    it: "rete NNUE ridotta, avvio istantaneo (~7 MB)",
    en: "small NNUE net, instant startup (~7 MB)",
  },
  engineFullDesc: {
    it: "rete NNUE completa, la più forte (~113 MB, scaricata una volta)",
    en: "full NNUE net, the strongest (~113 MB, downloaded once)",
  },
  engineNote: {
    it: "Si applica alle nuove analisi. Entrambi i motori girano interamente nel browser.",
    en: "Applies to new analyses. Both engines run fully in your browser.",
  },
  analysisLabel: { it: "Analisi", en: "Analysis" },
  analysisFastLabel: { it: "Veloce", en: "Fast" },
  analysisDeepLabel: { it: "Profonda", en: "Deep" },
  analysisFastDesc: { it: "revisione rapida (predefinita)", en: "quick review (default)" },
  analysisDeepDesc: {
    it: "pensa 3× più a lungo per ogni posizione",
    en: "thinks 3× longer per position",
  },
  analysisNote: {
    it: "Si applica alle nuove analisi. Le stime Elo seguono il motore scelto sopra.",
    en: "Applies to new analyses. Elo estimates follow the selected engine above.",
  },
  threadsLabel: { it: "Thread", en: "Threads" },
  threadsAuto: { it: "Auto (usa tutti i core)", en: "Auto (use all cores)" },
  threadsMulti: {
    it: "Motore multi-thread attivo: analisi più veloci, qualità uguale o migliore.",
    en: "Multi-threaded engine active: faster reviews, equal or better quality.",
  },
  threadsSingle: {
    it: "Questo contesto browser non è cross-origin isolato: viene usato il motore single-thread.",
    en: "This browser context is not cross-origin isolated: the single-threaded engine is used.",
  },
  retrieve: { it: "Recupera partite", en: "Retrieve games" },
  fetching: { it: "Recupero…", en: "Fetching…" },
  tryDemo: { it: "Prova la partita demo", en: "Try demo game" },
  tryDemoTitle: {
    it: "Carica una partita integrata (la Partita all'Opera, Morphy 1858) senza contattare l'API",
    en: "Loads a built-in game (the Opera Game, Morphy 1858) without contacting the API",
  },
  statsNeedUsername: {
    it: "Le statistiche lavorano sulle partite degli ultimi 30 giorni: imposta prima un nome utente.",
    en: "Statistics work on your last 30 days of games: set a username first.",
  },
  goSettings: { it: "Vai alle impostazioni", en: "Go to settings" },
  loadingGames: { it: "Carico le partite…", en: "Loading your games…" },

  // ── game list ────────────────────────────────────────────────────────────
  last30days: { it: "Ultimi 30 giorni", en: "Last 30 days" },
  gamesCount: {
    it: "{shown} di {total} partite",
    en: "{shown} of {total} games",
  },
  gamesCountAll: { it: "{total} partite", en: "{total} games" },
  fetchedAt: { it: "recuperate alle {time}", en: "fetched at {time}" },
  refresh: { it: "↻ Aggiorna", en: "↻ Refresh" },
  refreshing: { it: "Aggiornamento…", en: "Refreshing…" },
  refreshTitle: {
    it: "Recupera di nuovo (la cache è valida fino a un nuovo nome utente o a un nuovo giorno)",
    en: "Re-fetch (the cache is valid until a new username or a new day)",
  },
  tabAll: { it: "Tutte", en: "All" },
  tabBullet: { it: "Bullet", en: "Bullet" },
  tabBlitz: { it: "Blitz", en: "Blitz" },
  tabRapid: { it: "Rapid", en: "Rapid" },
  tabLong: { it: "Lunghe", en: "Long" },
  sortNewest: {
    it: "Più recenti prima (clicca per le più vecchie)",
    en: "Newest first (click for oldest first)",
  },
  sortOldest: {
    it: "Più vecchie prima (clicca per le più recenti)",
    en: "Oldest first (click for newest first)",
  },
  rangeTitle: {
    it: "Filtra per intervallo di date (tra la partita più vecchia e quella più recente recuperata)",
    en: "Filter by time range (between the oldest and newest retrieved game)",
  },
  from: { it: "Da", en: "From" },
  to: { it: "A", en: "To" },
  rangeNote: {
    it: "Entrambi i giorni inclusi. I limiti sono la partita più vecchia / più recente recuperata.",
    en: "Both days included. Extremes are limited to the oldest / newest retrieved game.",
  },
  reset: { it: "Azzera", en: "Reset" },
  resetTitle: {
    it: "Azzera il filtro per intervallo (mostra tutte le partite recuperate in questa scheda)",
    en: "Reset the time-range filter (show all retrieved games in this tab)",
  },
  truncatedWarning: {
    it: "Questo account gioca molto: l'API limita le partite esposte per mese, quindi la lista può essere incompleta.",
    en: "This account plays a lot: the API caps the games exposed per month, so the list may be incomplete.",
  },
  staleWarning: {
    it: "L'indice delle partite può essere in ritardo di ore: le partite molto recenti possono comparire più avanti. Aggiorna per ricontrollare.",
    en: "The game index can lag by hours: very recent games may take a while to appear. Refresh to re-check.",
  },
  fetchingGames: { it: "Recupero delle partite…", en: "Fetching games…" },
  noGames: {
    it: "Nessuna partita per {username} negli ultimi 30 giorni.",
    en: "No games found for {username} in the last 30 days.",
  },
  noGamesFiltered: {
    it: "Nessuna partita corrisponde alla scheda o all'intervallo corrente: allarga l'intervallo o scegli un'altra scheda.",
    en: "No games match the current tab / time range: widen the range or pick another tab.",
  },
  playedWhite: { it: "Gioca le bianche", en: "Played white" },
  playedBlack: { it: "Gioca le nere", en: "Played black" },
  won: { it: "Vinta", en: "Won" },
  lost: { it: "Persa", en: "Lost" },
  draw: { it: "Pareggio", en: "Draw" },
  analyzed: { it: "analizzata", en: "analyzed" },
  cachedTitle: {
    it: "analisi in cache ({engine} · {mode}) - riapri per rivedere",
    en: "cached analysis ({engine} · {mode}) - re-open to review",
  },
  tcCasual: { it: "Casual", en: "Casual" },
  tcCorrespondence: { it: "Corrispondenza", en: "Correspondence" },
  tcBullet: { it: "Bullet", en: "Bullet" },
  tcBlitz: { it: "Blitz", en: "Blitz" },
  tcRapid: { it: "Rapid", en: "Rapid" },
  tcClassical: { it: "Classiche", en: "Classical" },
  tcMin: { it: "min", en: "min" },

  // ── review ───────────────────────────────────────────────────────────────
  reviewFailed: { it: "La revisione è fallita", en: "Review failed" },
  backToGamesFull: { it: "← Torna alle partite", en: "← Back to games" },
  noMovesYet: { it: "Nessuna mossa", en: "No moves yet" },
  moveStripAria: {
    it: "Striscia delle mosse, scorri per cambiare posizione",
    en: "Move strip, swipe to change position",
  },
  perGame: { it: "/ partita", en: "/ game" },
  preparing: { it: "Preparazione della revisione…", en: "Preparing review…" },
  startingEngine: { it: "Avvio di Stockfish…", en: "Starting Stockfish…" },
  cancel: { it: "annulla", en: "cancel" },
  navFirst: { it: "Prima posizione (Home)", en: "First position (Home)" },
  navBack: { it: "Indietro (←)", en: "Back (←)" },
  navForward: { it: "Avanti (→)", en: "Forward (→)" },
  navLast: { it: "Ultima posizione (End)", en: "Last position (End)" },
  navMainline: {
    it: "Torna alla partita giocata (linea principale)",
    en: "Return to the played game (mainline)",
  },
  flipTitle: { it: "Ruota la scacchiera (salvato nelle impostazioni)", en: "Flip board (saved in settings)" },
  arrowTitle: {
    it: "Mostra/nascondi la freccia della migliore mossa (salvato nelle impostazioni)",
    en: "Show/hide best-move arrow (saved in settings)",
  },
  backToGame: { it: "Torna alla partita", en: "Back to game" },
  analyzeCurrent: {
    it: "Analizza con l'impostazione corrente",
    en: "Analyze with current setting",
  },
  upgradableTitle: {
    it: "Mostra l'analisi in cache {engine} · {mode} - rilanciala con le impostazioni correnti ({curEngine} · {curMode})",
    en: "Showing the cached {engine} · {mode} analysis - run it again with your current settings ({curEngine} · {curMode})",
  },
  thinking: { it: "riflessione", en: "thinking" },
  analyzingProgress: {
    it: "Analisi {done}/{total}",
    en: "Analyzing {done}/{total}",
  },
  dragHint: {
    it: "Trascina una mossa legale per esplorare un ramo: viene valutata subito. Usa ←/→ per navigare e \"Torna alla partita\" per riavere la linea principale.",
    en: "Drag any legal move to explore a branch: it is evaluated immediately. Use ←/→ to navigate and \"Back to game\" to return to the played game.",
  },
  bestLines: { it: "Migliori linee", en: "Best lines" },
  bestLinesWaiting: { it: "in attesa della valutazione…", en: "waiting for evaluation…" },
  engineMove: {
    it: "Motore: {san}{depth}",
    en: "Engine: {san}{depth}",
  },
  wins: { it: "{name} vince", en: "{name} wins" },
  drawResult: { it: "Pareggio", en: "Draw" },
  inProgress: { it: "In corso", en: "In progress" },
  openingBookTitle: {
    it: "Libro delle aperture · ECO {eco} · prime {moves} mosse",
    en: "Opening book · ECO {eco} · first {moves} moves",
  },

  // ── statistics ───────────────────────────────────────────────────────────
  statsTitle: { it: "Statistiche", en: "Statistics" },
  statsSubtitle: {
    it: "{username} · ultimi 30 giorni · {total} partite",
    en: "{username} · last 30 days · {total} games",
  },
  statsIntroTitle: {
    it: "Analisi completa degli ultimi 30 giorni",
    en: "Full analysis of your last 30 days",
  },
  statsIntroBody: {
    it: "Ogni partita ({total}) viene riletta da Stockfish con la combinazione {combo}. Risultati, aperture, precisione, imprecisioni e trend Elo vengono poi suddivisi in grafici per capire su cosa lavorare.",
    en: "Every game ({total}) is played through Stockfish with the {combo} combo. Results, openings, accuracy, blunders and elo trends are then broken down into charts you can use to see what to work on.",
  },
  statsIntroDone: {
    it: "{done}/{total} delle partite correnti sono già analizzate{newPart}.",
    en: "{done}/{total} of the current games are already analysed{newPart}.",
  },
  statsIntroNew: {
    it: " - l'esecuzione aggiungerà le {n} nuove partite",
    en: " - the run will add the {n} new games",
  },
  statsEstimate: {
    it: "Tempo stimato: ≈ {min} min.",
    en: "Estimated time: ≈ {min} min.",
  },
  statsWarning: {
    it: "⚠️ Non chiudere il browser o questa scheda durante l'esecuzione: l'analisi avviene nel tuo browser. Su uno smartphone tieni lo schermo acceso (disattiva il blocco automatico); sul desktop tieni il PC acceso e non in sospensione. I progressi vengono salvati dopo ogni partita, quindi un arresto costa solo la partita in corso.",
    en: "⚠️ Don't close the browser or this tab while it runs: the analysis happens in your browser. On a phone keep the screen awake (disable auto-lock); on a desktop keep the PC on and not sleeping. Progress is saved after every game, so a crash only loses the game in progress.",
  },
  startFull: { it: "Avvia l'analisi completa", en: "Start full analysis" },
  updateAnalysis: {
    it: "Aggiorna l'analisi ({done}/{total})",
    en: "Update analysis ({done}/{total})",
  },
  analyzingGame: {
    it: "Analisi della partita {i}/{n}{resumed}: {label}",
    en: "Analyzing game {i}/{n}{resumed}: {label}",
  },
  resumed: { it: " ({n} riprese)", en: " ({n} resumed)" },
  moveProgress: {
    it: "mossa {done}/{total}",
    en: "move {done}/{total}",
  },
  minLeft: { it: "≈ {min} min rimanenti", en: "≈ {min} min left" },
  stopBtn: { it: "Ferma (progressi salvati)", en: "Stop (progress saved)" },
  stopTitle: {
    it: "Ferma adesso: i progressi sono salvati, si riprende più tardi",
    en: "Stop now: progress is saved, resume later",
  },
  doneBanner: {
    it: "✓ Analisi completa: {games} partite, {moves} mosse. Riavviala quando vuoi per aggiornare.",
    en: "✓ Full analysis complete: {games} games, {moves} moves. Re-run anytime to refresh.",
  },
  loadingStored: {
    it: "Carico le analisi salvate…",
    en: "Loading stored analyses…",
  },
  secResults: { it: "Risultati", en: "Results" },
  secOpenings: { it: "Aperture", en: "Openings" },
  secElo: {
    it: "Elo del mese (per categoria di tempo)",
    en: "Elo over the month (per time class)",
  },
  secResultsByClass: {
    it: "Risultati per categoria di tempo",
    en: "Results by time class",
  },
  secAccuracy: {
    it: "Distribuzione della tua precisione (per mossa)",
    en: "Your accuracy distribution (per move)",
  },
  secMistakes: {
    it: "Errori e gravi errori per partita",
    en: "Mistakes & blunders per game",
  },
  secWinrateGap: {
    it: "Percentuale di vittoria per forza dell'avversario",
    en: "Win rate by opponent strength",
  },
  secHour: {
    it: "Risultati per ora del giorno (locale)",
    en: "Results by hour of day (local)",
  },
  overall: { it: "Totale", en: "Overall" },
  playingWhite: { it: "Con le bianche", en: "Playing white" },
  playingBlack: { it: "Con le nere", en: "Playing black" },
  accuracy: { it: "Precisione", en: "Accuracy" },
  analyzedGames: {
    it: "{games} partite analizzate · {moves} mosse",
    en: "{games} analysed games · {moves} moves",
  },
  winsWord: { it: "vittorie", en: "wins" },
  drawsWord: { it: "pareggi", en: "draws" },
  lossesWord: { it: "sconfitte", en: "losses" },
  thOpening: { it: "Apertura", en: "Opening" },
  thGames: { it: "Partite", en: "Games" },
  weakMoves: {
    it: "Mosse deboli (imprecisione + errore)",
    en: "Weak moves (inaccuracy + mistake)",
  },
  blunders: { it: "Gravi errori", en: "Blunders" },
  noBookMatch: { it: "Nessuna corrispondenza nel libro", en: "No book match" },
  gapStronger: {
    it: "vs avversari +100 più forti",
    en: "vs +100 stronger opponents",
  },
  gapEven: { it: "vs avversari ±100 alla pari", en: "vs ±100 even opponents" },
  gapWeaker: {
    it: "vs avversari 100+ più deboli",
    en: "vs 100+ weaker opponents",
  },
  cores: { it: "{n} core", en: "{n} core" },
  coresAll: { it: "Tutti i core ({n})", en: "All cores ({n})" },
  coresHalf: { it: "Metà dei core ({n})", en: "Half cores ({n})" },
  coresOne: { it: "1 core", en: "1 core" },
  coresHint: {
    it: "Meno core = analisi più lenta, ma meno consumo di energia, calore e surriscaldamento del PC o telefono.",
    en: "Fewer cores = slower analysis, but less power draw, heat and device warmth.",
  },
} as const;

export type StrKey = keyof typeof STRINGS;
export type TFn = (key: StrKey, vars?: Record<string, string | number>) => string;

/**
 * Time-class tab id (all/bullet/blitz/rapid/long) -> display key. The four
 * online classes map to the tc* labels, "long" reuses the game-list tab label
 * (there is no tcLong entry).
 */
export function tabIdKey(id: string): StrKey {
  if (id === "all") return "tabAll";
  if (id === "long") return "tabLong";
  return `tc${id.charAt(0).toUpperCase()}${id.slice(1)}` as StrKey;
}

export function translate(lang: Lang, key: StrKey, vars?: Record<string, string | number>): string {
  let s: string = STRINGS[key][lang];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

// ---------------------------------------------------------------------------
// React context
// ---------------------------------------------------------------------------

export interface I18nValue {
  lang: Lang;
  locale: string;
  t: TFn;
}

const I18nCtx = createContext<I18nValue>({
  lang: "it",
  locale: LANGS.it.locale,
  t: (k) => STRINGS[k].it,
});

export function I18nProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  const value: I18nValue = {
    lang,
    locale: LANGS[lang].locale,
    t: (key, vars) => translate(lang, key, vars),
  };
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nCtx);
}
