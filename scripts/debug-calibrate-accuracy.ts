/**
 * Calibrate the accuracy model against a real chess.com game.
 *
 * Opens the review of Mamox43's game vs YSLdot, waits for the full
 * client-side analysis, then dumps every mainline move with its delta (cp
 * lost vs the engine's best move), loss and category, plus the app's
 * displayed accuracies. Also fetches the chess.com API `accuracies` for the
 * same game as ground truth. Output: /tmp/acc-calibration.json
 *
 *   bun run scripts/debug-calibrate-accuracy.ts
 */
import { chromium } from "playwright-core";

const CHROME =
  process.env.HOME +
  "/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const USERNAME = "Mamox43";
const OPPONENT = "YSLdot";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.addInitScript((u) => {
  localStorage.setItem(
    "chess-analysis.settings.v2",
    JSON.stringify({ username: u, engine: "lite", threads: 0, flip: false, showArrow: false, analysis: "fast" }),
  );
}, USERNAME);
await page.goto("http://localhost:5173", { waitUntil: "networkidle" });

// the app opens on the settings screen — retrieve the list
await page.locator("button:has-text('Retrieve games')").click();

// wait for the game list, then open the YSLdot game
await page.waitForFunction(
  (opp) => Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes(`vs ${opp}`)),
  OPPONENT,
  { timeout: 90_000 },
);
await page.locator(`button:has-text("vs ${OPPONENT}")`).first().click();

// wait for the full analysis to finish
await page.waitForFunction(
  () => {
    const s = (window as any).__reviewState;
    return s && s.status === "ready";
  },
  undefined,
  { timeout: 600_000, polling: 2000 },
);

const state = await page.evaluate(() => {
  const s = (window as any).__reviewState;
  const mainline = s.mainline as number[];
  const nodes = s.nodes as any[];
  return {
    meta: s.meta,
    moves: mainline.slice(1).map((idx, i) => {
      const n = nodes[idx];
      return {
        n: i + 1,
        san: n.move?.san,
        color: n.move?.color,
        delta: n.delta,
        loss: n.loss,
        category: n.category,
      };
    }),
    accuracies: (document.body.textContent ?? "").match(/\d+%/g)?.slice(0, 2) ?? [],
  };
});

// chess.com ground truth for the same game
const api = await (async () => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const months = [
    `${y}/${String(m).padStart(2, "0")}`,
    `${y}/${String(m - 1).padStart(2, "0")}`,
  ];
  for (const mk of months) {
    try {
      const r = await fetch(`https://api.chess.com/pub/player/${USERNAME}/games/${mk}`);
      if (!r.ok) continue;
      const j = await r.json();
      const candidates = (j.games ?? []).filter(
        (x: any) => x.white?.username === OPPONENT || x.black?.username === OPPONENT,
      );
      if (!candidates.length) continue;
      // newest first (the API array is not chronological) — matches the app's list
      const g = candidates.sort((a: any, b: any) => (b.end_time ?? 0) - (a.end_time ?? 0))[0];
      return {
        id: g.uuid,
        white: { name: g.white?.username, rating: g.white?.rating },
        black: { name: g.black?.username, rating: g.black?.rating },
        accuracies: g.accuracies,
        result: g.pgn?.match(/\[Result "([^"]+)"\]/)?.[1],
      };
    } catch {
      // try next month
    }
  }
  return null;
})();

const out = { app: state, reference: api };
await import("fs").then((fs) => fs.writeFileSync("/tmp/acc-calibration.json", JSON.stringify(out, null, 1)));
console.log(JSON.stringify(out, null, 1));
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
await browser.close();
