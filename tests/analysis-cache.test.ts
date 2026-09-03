import { describe, expect, test } from "bun:test";
import { comboRank } from "../src/api/analysisCache";

// The storage side (one best-combo entry per game, rank guard, round-trip)
// lives in the server SQLite layer - see tests/server-db.test.ts.

describe("comboRank", () => {
  test("lite+fast < full+fast < lite+deep < full+deep", () => {
    const r = (e: "lite" | "full", m: "fast" | "deep") => comboRank(e, m);
    expect(r("lite", "fast")).toBeLessThan(r("full", "fast"));
    expect(r("full", "fast")).toBeLessThan(r("lite", "deep"));
    expect(r("lite", "deep")).toBeLessThan(r("full", "deep"));
  });
});
