import { describe, expect, test, beforeAll } from "bun:test";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "../src/settings";

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
      username: "Mamox43",
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
    localStorage.setItem(KEY, JSON.stringify({ username: "x" }));
    expect(loadSettings().analysis).toBe("fast");
  });

  test("case is preserved (usernames are case sensitive)", () => {
    reset();
    saveSettings({
      ...DEFAULT_SETTINGS,
      username: "MiXeD",
      engine: "lite",
      threads: 0,
      flip: false,
      showArrow: true,
      analysis: "fast",
    });
    expect(loadSettings().username).toBe("MiXeD");
  });

  test("corrupt JSON falls back to defaults", () => {
    reset();
    localStorage.setItem(KEY, "{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  test("unknown engine value falls back to lite", () => {
    reset();
    localStorage.setItem(KEY, JSON.stringify({ username: "x", engine: "quantum" }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, username: "x" });
  });

  test("partial object fills missing fields (showArrow defaults to true)", () => {
    reset();
    localStorage.setItem(KEY, JSON.stringify({ username: "a" }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, username: "a" });
  });

  test("legacy v1 key migrates to the current key", () => {
    reset();
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ username: "OldUser", engine: "full", analysis: "deep" }),
    );
    const s = loadSettings();
    expect(s.username).toBe("OldUser");
    expect(s.engine).toBe("full");
    expect(s.analysis).toBe("deep");
    // the migrated value is persisted under the new key
    expect(backing.get(KEY)).toBeTruthy();
  });
});
