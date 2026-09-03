import type { AnalysisMode, EngineKind } from "./engine/config";
import type { Lang, Theme } from "./i18n";

/**
 * User preferences, persisted in the browser's localStorage.
 * Key is versioned so future shape changes can migrate cleanly; v1 lived
 * under the old app name and is read once as a fallback.
 */
export interface Settings {
  /** the reviewed player's username (case preserved for display). */
  username: string;
  /** which Stockfish build to use for analysis. */
  engine: EngineKind;
  /** UCI Threads; 0 = auto (hardware concurrency). Multi only in isolated docs. */
  threads: number;
  /** invert the board perspective (games open in the reviewed player's side) */
  flip: boolean;
  /** draw the engine's best-move arrow on the board */
  showArrow: boolean;
  /** per-position time budget: fast (default) or deep (3× the time) */
  analysis: AnalysisMode;
  /** UI language; italian is the default */
  lang: Lang;
  /** colour theme; dark is the default (the original look) */
  theme: Theme;
}

const STORAGE_KEY = "chess-analysis.settings.v2";
const LEGACY_KEY = "chesscom-review.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  username: "",
  engine: "lite",
  threads: 0,
  flip: false,
  showArrow: true,
  analysis: "fast",
  lang: "it",
  theme: "dark",
};

/** localStorage may be unavailable (private mode, tests, non-browser). */
function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function parse(raw: string): Settings {
  const parsed = JSON.parse(raw) as Partial<Settings>;
  return {
    username: typeof parsed.username === "string" ? parsed.username : "",
    engine: parsed.engine === "full" ? "full" : "lite",
    threads:
      typeof parsed.threads === "number" &&
      Number.isInteger(parsed.threads) &&
      parsed.threads >= 0 &&
      parsed.threads <= 8
        ? parsed.threads
        : 0,
    flip: parsed.flip === true,
    showArrow: parsed.showArrow !== false,
    analysis: parsed.analysis === "deep" ? "deep" : "fast",
    lang: parsed.lang === "en" ? "en" : "it",
    theme: parsed.theme === "light" ? "light" : "dark",
  };
}

export function loadSettings(): Settings {
  try {
    const store = storage();
    if (!store) return { ...DEFAULT_SETTINGS };
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = store.getItem(LEGACY_KEY);
      if (!legacy) return { ...DEFAULT_SETTINGS };
      const migrated = parse(legacy);
      store.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    const store = storage();
    if (!store) return;
    store.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // private mode / storage full - preferences just won't persist
  }
}
