/**
 * E2E: the SQLite data path (server DB ↔ client) against a live dev server.
 *
 * Requires, in this order:
 *   rm -rf data/            # fresh database
 *   bun server/index.ts     # terminal 1 (data API on :3000)
 *   bun run dev             # terminal 2 (vite on :5173)
 *
 *   bun run scripts/e2e-db.ts
 *
 * Flow (two browser profiles = two "devices"):
 *  A1. fresh profile: retrieve Mamox43 (server hits the public API), list renders
 *  A2. open the first game → full analysis runs (default lite·fast) → done
 *  A3. back to the list → the row now carries the analyzed label
 *  A4. reload the page → re-open the same game → instant hydration (no
 *      engine run) within a couple of seconds
 *  A5. stats view: loads stored analyses, shows 1 of N done + the Update button
 *  B1. second profile: same username → list served from the DB (no
 *      upstream call) and the analyzed label is already there (shared store)
 */
import { chromium } from "playwright-core";

const CHROME =
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/` +
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const BASE = "http://localhost:5173";
const USERNAME = "Mamox43";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok — ${msg}`);
}

async function waitFor(
  page: import("playwright-core").Page,
  fn: () => unknown,
  what: string,
  timeoutMs = 90_000,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`TIMEOUT waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  // ── profile A ────────────────────────────────────────────────────────────
  const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
  const a = await ctxA.newPage();
  const errors: string[] = [];
  a.on("pageerror", (e) => errors.push(e.message));

  console.log("A1: fresh profile - retrieve (server -> public API)");
  await a.goto(BASE);
  await a.fill('input[placeholder="il tuo nome utente"]', USERNAME);
  await a.click('button:has-text("Retrieve games")');
  await waitFor(a, () => document.body.textContent?.includes("vs "), "game list rows", 60_000);
  const rowCount = await a.locator("ul li").count();
  assert(rowCount > 50, `list rendered with ${rowCount} games`);
  assert(!(await a.locator("text=analyzed").count()), "no analyzed labels on a fresh DB");

  // grab the first game's id (the review view exposes it in __reviewState)
  await a.locator("ul li button").first().click();
  await waitFor(a, () => (window as any).__reviewState?.meta != null, "review INIT", 30_000);
  const gameId: string = await a.evaluate(() => (window as any).__reviewState.meta.gameId);
  console.log(`  opened game ${gameId}`);

  console.log("A2: full analysis runs (default lite·fast)");
  await waitFor(
    a,
    () => (window as any).__reviewState?.status === "ready" || (window as any).__reviewState?.status === "error",
    "analysis finished",
    240_000,
  );
  const st = await a.evaluate(() => (window as any).__reviewState);
  assert(st.status === "ready", `analysis finished (status=${st.status}, moves=${st.mainline.length - 1})`);

  console.log("A3: back to the list — row carries the analyzed label");
  await a.click('button:has-text("← Games")');
  await waitFor(a, () => document.querySelector('span[title*="cached analysis"]'), "analyzed label in list", 15_000);
  const label = await a.locator('span[title*="cached analysis"]').first().textContent();
  assert(/W \d+% \/ B \d+% · lite·fast/.test(label ?? ""), `label shows accuracies + combo: "${label?.trim()}"`);

  console.log("A4: reload — re-open the same game hydrates instantly (no engine)");
  await a.reload();
  // after reload we're on the settings screen with the saved username
  await a.click('button:has-text("← Games")');
  await waitFor(a, () => document.body.textContent?.includes("vs "), "list again", 30_000);
  const t0 = Date.now();
  // the list is stable within the same fetch (newest-first) → first row = same game
  await a.locator("ul li button").first().click();
  {
    const tEnd = Date.now() + 15_000;
    let ok = false;
    while (Date.now() < tEnd) {
      ok = await a.evaluate((id) => {
        const s = (window as any).__reviewState;
        return s?.meta?.gameId === id && s.status === "ready";
      }, gameId);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!ok) throw new Error("TIMEOUT waiting for: hydrated review");
  }
  const hydratedMs = Date.now() - t0;
  assert(hydratedMs < 8_000, `re-open hydrated in ${hydratedMs}ms (engine run would take ~40s)`);

  console.log("A5: stats view — stored analyses load, 1 of N done");
  await a.click('button[title^="Statistics"]');
  // done>0 only once the stored analyses have round-tripped through the server
  await waitFor(a, () => (window as any).__statsState != null && (window as any).__statsState.done === 1, "stats loaded (1 stored analysis)", 30_000);
  const stats = await a.evaluate(() => (window as any).__statsState);
  assert(stats.done === 1, `stats shows done=${stats.done} total=${stats.total}`);
  assert((await a.locator('button:has-text("Update analysis")').count()) === 1, "Update analysis button visible");

  // ── profile B (a different "device") ─────────────────────────────────────
  console.log("B1: second profile — shared DB: list + analyzed label without re-analysis");
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
  const b = await ctxB.newPage();
  b.on("pageerror", (e) => errors.push(`B: ${e.message}`));
  await b.goto(BASE);
  await b.fill('input[placeholder="il tuo nome utente"]', USERNAME);
  const tB = Date.now();
  await b.click('button:has-text("Retrieve games")');
  await waitFor(b, () => document.body.textContent?.includes("vs "), "list (profile B)", 30_000);
  const msB = Date.now() - tB;
  assert(msB < 5_000, `profile B list served from DB in ${msB}ms (no upstream round-trip)`);
  const labelB = await b.locator('span[title*="cached analysis"]').first().textContent().catch(() => null);
  assert(labelB != null && /lite·fast/.test(labelB), "profile B sees the analyzed label (shared store)");

  // server-side: exactly one player, one analysis
  const players = await a.evaluate(async () => (await (await fetch("/api/db/players")).json()) as unknown);
  console.log("  /api/db/players:", JSON.stringify(players));
  assert((players as { username: string; analyzed: number }[]).length === 1, "one player in the DB");

  assert(errors.length === 0, `no page errors (${errors.slice(0, 3).join(" | ")})`);

  await browser.close();
  console.log("\nE2E DB: ALL PASS");
}

main().catch((e) => {
  console.error("\nE2E DB FAILED:", e.message);
  process.exit(1);
});
