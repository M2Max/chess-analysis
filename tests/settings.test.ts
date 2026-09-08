import { describe, expect, test, beforeAll } from "bun:test";
import {
  DEFAULT_SETTINGS,
  clearLegacyUsername,
  legacyUsername,
  loadSettings,
  saveSettings,
  type Settings,
} from "../src/settings";

const KEY = "chess-analysis.settings.v2";
const LEGACY_KEY = "chesscom-review.settings.v1";

// bun test has no localStorage - stub one for the duration of the suite
const backing = new Map<string, string>();
beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    },
  });
});

const reset = () => backing.clear();

describe("settings persistence (localStorage)", () => {
  test("defaults when nothing stored", () => {
    reset();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  test("save → load round-trip", () => {
    reset();
    const s: Settings = {
      engine: "full",
      threads: 4,
      flip: true,
      showArrow: false,
      analysis: "deep",
      lang: "it",
      theme: "light",
    };
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  test("analysis mode round trip + default", () => {
    reset();
    saveSettings({ ...DEFAULT_SETTINGS, analysis: "fast" });
    expect(loadSettings().analysis).toBe("fast");
    // partial object: missing analysis falls back to the default
    localStorage.setItem(KEY, JSON.stringify({ engine: "full" }));
    expect(loadSettings().analysis).toBe("fast");
  });

  test("corrupt JSON falls back to defaults", () => {
    reset();
    localStorage.setItem(KEY, "{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  test("unknown engine value falls back to lite", () => {
    reset();
    localStorage.setItem(KEY, JSON.stringify({ engine: "quantum" }));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  test("partial object fills missing fields (showArrow defaults to true)", () => {
    reset();
    localStorage.setItem(KEY, JSON.stringify({ threads: 2 }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, threads: 2 });
  });

  test("legacy v1 key migrates to the current key", () => {
    reset();
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ username: "OldUser", engine: "full", analysis: "deep" }),
    );
    const s = loadSettings();
    expect(s.engine).toBe("full");
    expect(s.analysis).toBe("deep");
    // the migrated value is persisted under the new key
    expect(backing.get(KEY)).toBeTruthy();
  });
});

describe("legacy username (single-player → multi-user migration)", () => {
  test("read from current storage, ignored once cleared", () => {
    reset();
    localStorage.setItem(KEY, JSON.stringify({ username: "Mamox43", engine: "lite" }));
    expect(legacyUsername()).toBe("Mamox43");
    clearLegacyUsername();
    expect(legacyUsername()).toBe("");
    // the rest of the settings survive the clear
    expect(loadSettings().engine).toBe("lite");
  });

  test("falls back to the legacy v1 key", () => {
    reset();
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ username: " OldUser " }));
    expect(legacyUsername()).toBe("OldUser");
  });

  test("nothing stored → empty", () => {
    reset();
    expect(legacyUsername()).toBe("");
  });
});
