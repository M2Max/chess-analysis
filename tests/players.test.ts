/**
 * Pure helpers behind the Players grid: monogram, avatar hue, coarse
 * relative time, card ordering.
 */
import { describe, expect, test } from "bun:test";
import {
  hueOf,
  monogram,
  relativeSince,
  sortPlayers,
} from "../src/components/PlayersView";
import type { PlayerCard } from "../src/api/reviewDb";

describe("monogram", () => {
  test("first two alphanumeric characters, uppercased", () => {
    expect(monogram("Mamox43")).toBe("MA");
    expect(monogram("magnum357")).toBe("MA");
    expect(monogram("a")).toBe("A");
    expect(monogram("Mr. Bean")).toBe("MB");
  });
  test("nothing letter-like → '?'", () => {
    expect(monogram("!! ??")).toBe("?");
    expect(monogram("")).toBe("?");
  });
  test("unicode letters count as letters", () => {
    expect(monogram("élo")).toBe("ÉL");
  });
});

describe("hueOf", () => {
  test("stable and inside 0-359", () => {
    expect(hueOf("Mamox43")).toBe(hueOf("Mamox43"));
    for (const name of ["a", "bb", "Mamox43", "GothamChess", "😅"]) {
      const h = hueOf(name);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
  test("different names usually differ", () => {
    expect(hueOf("aaa")).not.toBe(hueOf("bbb"));
  });
});

describe("relativeSince", () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0);
  const ago = (sec: number) => (now - sec * 1000) / 1000;

  test("unit selection", () => {
    expect(relativeSince(ago(30), now, "en-GB")).toMatch(/now|second/i);
    expect(relativeSince(ago(5 * 60), now, "en-GB")).toMatch(/hour|min/); // ~5 min
    expect(relativeSince(ago(3 * 3600), now, "en-GB")).toContain("hour");
    expect(relativeSince(ago(26 * 3600), now, "en-GB")).toContain("day");
    expect(relativeSince(ago(9 * 86_400), now, "en-GB")).toContain("week");
    expect(relativeSince(ago(70 * 86_400), now, "en-GB")).toContain("month");
  });

  test("locale is respected (italian)", () => {
    const s = relativeSince(ago(3 * 3600), now, "it-IT");
    expect(s).toMatch(/ora|ore/);
  });
});

describe("sortPlayers", () => {
  const card = (username: string, lastGameUtc: number | null): PlayerCard => ({
    username,
    games: 0,
    analyzed: 0,
    lastFetchAt: null,
    lastGameUtc,
    title: null,
    ratings: {},
    ratingsUpdatedAt: null,
  });

  test("most recent first, never-played last, ties alphabetical", () => {
    const sorted = sortPlayers([
      card("zoe", 100),
      card("never1", null),
      card("amy", 300),
      card("bob", 200),
      card("amy2", 300),
    ]);
    expect(sorted.map((p) => p.username)).toEqual(["amy", "amy2", "bob", "zoe", "never1"]);
  });

  test("does not mutate the input", () => {
    const input = [card("b", 2), card("a", 1)];
    sortPlayers(input);
    expect(input.map((p) => p.username)).toEqual(["b", "a"]);
  });
});
