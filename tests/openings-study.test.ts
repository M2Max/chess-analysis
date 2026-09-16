import { describe, expect, test } from "bun:test";
import { buildStudy, sanEq, sanMovesOf, stepsFromLine, studyItems } from "../src/openings/studyData";

const row = (eco: string, name: string, pgn: string) => ({ eco, name, pgn });

describe("sanMovesOf", () => {
  test("strips move numbers, results, comments and NAGs", () => {
    expect(
      sanMovesOf("1. e4 c5 2. Nf3 {a comment} d6 $5 3. d4 cxd4 4. Nxd4 1/2-1/2"),
    ).toEqual(["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4"]);
  });
  test("keeps promotions and check glyphs", () => {
    expect(sanMovesOf("1. e4 d5 2. exd5 c6 3. dxc8=Q+")).toEqual(["e4", "d5", "exd5", "c6", "dxc8=Q+"]);
  });
});

describe("sanEq", () => {
  test("ignores +/#", () => {
    expect(sanEq("Bb5+", "Bb5")).toBe(true);
    expect(sanEq("Qh7#", "Qh7")).toBe(true);
    expect(sanEq("Bb5", "Ba4")).toBe(false);
  });
});

describe("buildStudy", () => {
  const rows = [
    row("B20", "Sicilian Defense", "1. e4 c5"),
    // two direct variants (different move-2)
    row("B21", "Sicilian Defense: Smith-Morra Gambit", "1. e4 c5 2. d4"),
    row("B30", "Sicilian Defense: Closed Variation", "1. e4 c5 2. Nc3"),
    // deep sub-line of the Smith-Morra -> must be HIDDEN (covered by parent)
    row("B21", "Sicilian Defense: Smith-Morra Gambit, Accepted", "1. e4 c5 2. d4 cxd4"),
    row("B21", "Sicilian Defense: Smith-Morra Gambit, Accepted, 3.c3", "1. e4 c5 2. d4 cxd4 3. c3"),
    // a non-extending child (does not start with the main line) -> dropped
    row("B20", "Sicilian Defense: Bogus Line", "1. d4 c5"),
    // an unrelated top-level opening
    row("C50", "Italian Game", "1. e4 e5 2. Nf3 Nc6 3. Bc4"),
    // duplicate name, longer line -> shortest wins
    row("B20", "Sicilian Defense", "1. e4 c5 2. Qh5"),
  ];

  test("only top-level names become main openings", () => {
    const study = buildStudy(rows);
    expect(study.map((o) => o.key)).toEqual(["Italian Game", "Sicilian Defense"]);
  });

  test("first-tier variants only - deep sub-lines are hidden", () => {
    const sic = buildStudy(rows).find((o) => o.key === "Sicilian Defense")!;
    // same line length -> alphabetical: Closed before Smith-Morra
    expect(sic.variants.map((v) => v.name)).toEqual(["Closed Variation", "Smith-Morra Gambit"]);
    // main line: the SHORTEST entry for the exact name
    expect(sic.moves).toEqual(["e4", "c5"]);
  });

  test("non-extending children are dropped", () => {
    const sic = buildStudy(rows).find((o) => o.key === "Sicilian Defense")!;
    expect(sic.variants.some((v) => v.name.includes("Bogus"))).toBe(false);
  });

  test("openings without children have zero variants", () => {
    const italian = buildStudy(rows).find((o) => o.key === "Italian Game")!;
    expect(italian.variants).toHaveLength(0);
  });

  test("illegal lines never make it into the study", () => {
    const study = buildStudy([
      row("A00", "Broken Opening", "1. e4 g5 2. Qh5 Nf6"), // Qh5 then Nf6 is legal... use real illegal:
      row("A00", "Legal Opening", "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7+"),
    ]);
    // "Broken Opening" line IS legal chess; make a truly illegal one:
    const bad = buildStudy([row("A00", "Illegal Opening", "1. e4 e5 2. Ke2 Qh4 3. Kf1 Bc5 4. Ra2")]);
    expect(study.length).toBeGreaterThanOrEqual(1);
    expect(bad).toHaveLength(0);
  });

  test("studyItems = main line first, then variants", () => {
    const sic = buildStudy(rows).find((o) => o.key === "Sicilian Defense")!;
    const items = studyItems(sic);
    expect(items).toHaveLength(3);
    expect(items[0]!.name).toBe("main");
    expect(items[1]!.name).toBe("Closed Variation");
  });
});

describe("stepsFromLine", () => {
  test("resolves SAN to squares", () => {
    const steps = stepsFromLine(["e4", "c5", "Nf3"]);
    expect(steps.map((s) => s.uci)).toEqual(["e2e4", "c7c5", "g1f3"]);
    expect(steps[0]).toMatchObject({ from: "e2", to: "e4", san: "e4" });
  });
  test("stops at the first illegal SAN", () => {
    const steps = stepsFromLine(["e4", "Bb5"]);
    expect(steps).toHaveLength(1);
  });
});
