import { describe, expect, test } from "bun:test";
import { filterGames, timeClassOf, timeControlLabel } from "../src/components/GameList";
import { translate, type StrKey } from "../src/i18n";
import type { Game } from "../src/api/games";

const t = (k: StrKey, v?: Record<string, string | number>) => translate("en", k, v);

const game = (utc: number, timeClass = "", timeControl = "3+2"): Game =>
  ({
    id: `g${utc}`,
    url: "",
    utc,
    white: { name: "W", username: "w" },
    black: { name: "B", username: "b" },
    result: "1-0",
    variant: "chess",
    timeControl,
    timeClass,
    pgn: "",
  }) as Game;

describe("timeClassOf", () => {
  test("maps the API time_class to tabs", () => {
    expect(timeClassOf({ timeControl: "1+0", timeClass: "bullet" })).toBe("bullet");
    expect(timeClassOf({ timeControl: "3+2", timeClass: "blitz" })).toBe("blitz");
    expect(timeClassOf({ timeControl: "10+0", timeClass: "rapid" })).toBe("rapid");
    expect(timeClassOf({ timeControl: "60+0", timeClass: "classical" })).toBe("long");
    expect(timeClassOf({ timeControl: "correspondence", timeClass: "correspondence" })).toBe("long");
    expect(timeClassOf({ timeControl: "casual", timeClass: "casual" })).toBe("other");
  });

  test("derives from the time control when time_class is missing", () => {
    expect(timeClassOf({ timeControl: "30", timeClass: "" })).toBe("bullet");
    expect(timeClassOf({ timeControl: "180", timeClass: "" })).toBe("blitz");
    expect(timeClassOf({ timeControl: "900", timeClass: "" })).toBe("rapid");
    expect(timeClassOf({ timeControl: "3600", timeClass: "" })).toBe("long");
    expect(timeClassOf({ timeControl: "5+3", timeClass: "" })).toBe("blitz"); // 5 min base
    expect(timeClassOf({ timeControl: "casual", timeClass: "" })).toBe("other");
  });
});

describe("filterGames", () => {
  const games = [
    game(1000, "blitz"),   // oldest
    game(2000, "bullet"),
    game(3000, "rapid"),
    game(4000, "blitz"),   // newest
  ];

  test("tab filtering", () => {
    expect(filterGames(games, "all", null, false).length).toBe(4);
    expect(filterGames(games, "blitz", null, false).map((g) => g.id)).toEqual(["g4000", "g1000"]);
    expect(filterGames(games, "bullet", null, false).map((g) => g.id)).toEqual(["g2000"]);
    expect(filterGames(games, "long", null, false)).toEqual([]);
  });

  test("sort: default newest first, toggled oldest first", () => {
    expect(filterGames(games, "all", null, false).map((g) => g.id)).toEqual([
      "g4000", "g3000", "g2000", "g1000",
    ]);
    expect(filterGames(games, "all", null, true).map((g) => g.id)).toEqual([
      "g1000", "g2000", "g3000", "g4000",
    ]);
  });

  test("time range is inclusive on both ends", () => {
    // 1990-01-01 00:00 UTC = 631152000; use exact game timestamps as bounds
    expect(filterGames(games, "all", { from: 1500, to: 3500 }, false).map((g) => g.id)).toEqual([
      "g3000", "g2000",
    ]);
    // bounds exactly on a game include it
    expect(filterGames(games, "all", { from: 1000, to: 4000 }, true).length).toBe(4);
    expect(filterGames(games, "all", { from: 1001, to: 4000 }, true).length).toBe(3);
    expect(filterGames(games, "all", { from: 1000, to: 3999 }, true).length).toBe(3);
  });

  test("tab + range + sort combine", () => {
    const r = filterGames(games, "blitz", { from: 1500, to: 5000 }, true);
    expect(r.map((g) => g.id)).toEqual(["g4000"]); // g1000 excluded by range
  });
});

describe("timeControlLabel", () => {
  test("uses the API time_class with a readable control", () => {
    expect(timeControlLabel({ timeControl: "180", timeClass: "blitz" }, t)).toBe("Blitz 3 min");
    expect(timeControlLabel({ timeControl: "600", timeClass: "classical" }, t)).toBe(
      "Classical 10 min",
    );
    expect(timeControlLabel({ timeControl: "60", timeClass: "blitz" }, t)).toBe("Blitz 1 min");
    expect(timeControlLabel({ timeControl: "3+2", timeClass: "blitz" }, t)).toBe("Blitz 3+2");
    expect(timeControlLabel({ timeControl: "180+2", timeClass: "blitz" }, t)).toBe("Blitz 180+2");
  });

  test("casual and correspondence", () => {
    expect(timeControlLabel({ timeControl: "casual" }, t)).toBe("Casual");
    expect(timeControlLabel({ timeControl: "" }, t)).toBe("Casual");
    expect(timeControlLabel({ timeControl: "correspondence" }, t)).toBe("Correspondence");
  });

  test("derives the class from seconds when time_class is missing", () => {
    expect(timeControlLabel({ timeControl: "30" }, t)).toBe("Bullet 30 s");
    expect(timeControlLabel({ timeControl: "180" }, t)).toBe("Blitz 3 min");
    expect(timeControlLabel({ timeControl: "900" }, t)).toBe("Rapid 15 min");
    expect(timeControlLabel({ timeControl: "3600" }, t)).toBe("Classical 60 min");
    expect(timeControlLabel({ timeControl: "3+2" }, t)).toBe("Blitz 3+2");
  });
});
