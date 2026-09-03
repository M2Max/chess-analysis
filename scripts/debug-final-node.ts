/**
 * Debug: load a real game, wait for analysis to finish, then read the
 * ReviewView reducer state straight out of the React fiber tree and dump
 * the last few nodes. Run: bun run scripts/debug-final-node.ts
 */
import { chromium } from "playwright-core";

const APP = "http://localhost:5173/";
const USERNAME = "Mamox43";
const CHROME =
  process.env.HOME +
  "/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => console.log(`[console:${m.type()}]`, m.text().slice(0, 300)));
page.on("response", (r) => {
  if (r.status() >= 400) console.log("[http", r.status(), "]", r.url());
});
page.on("worker", (w) => {
  w.on("error", (e) => console.log("[worker error]", e.message));
  w.on("close", () => console.log("[worker close]"));
});

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("input", { timeout: 15000 });
await page.fill("input", USERNAME);
await page.click("button[type=submit]");

// wait for the game list
await page.waitForSelector("ul li button", { timeout: 30000 });
const rowCount = await page.locator("ul li button").count();
console.log("game list rows:", rowCount);

// open the most recent game
await page.locator("ul li button").first().click();

// sample state over time to see if analysis progresses
for (const waitMs of [3000, 7000, 7000, 7000]) {
  await page.waitForTimeout(waitMs);
  const snap = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/Analyzing \d+\/\d+/);
    const err = t.match(/Review failed[\s\S]{0,120}/);
    return { prog: m ? m[0] : null, failed: err ? err[0] : null, len: t.length };
  });
  console.log("+", waitMs, JSON.stringify(snap));
}

// wait for analysis to finish (spinner text gone)
await page.waitForFunction(
  () => !document.body.innerText.includes("Analyzing") && !document.body.innerText.includes("Preparing"),
  { timeout: 240000 },
);
console.log("analysis finished");

const dump = await page.evaluate(() => {
  const rootEl = document.getElementById("root")!;
  const fiberKey = Object.keys(rootEl).find((k) => k.startsWith("__reactContainer$"))!;
  // @ts-expect-error fiber internals
  const rootFiber = (rootEl as any)[fiberKey];
  // walk the fiber tree (child/sibling only — no cycles) for the ReviewView fiber
  let found: any = null;
  const stack: any[] = [rootFiber?.child];
  let visited = 0;
  while (stack.length && !found && visited < 200000) {
    const f = stack.pop();
    if (!f) continue;
    visited++;
    if (f.type?.name === "ReviewView" || f.type?.displayName === "ReviewView") found = f;
    if (f.child) stack.push(f.child);
    if (f.sibling) stack.push(f.sibling);
  }
  if (!found) return { error: "ReviewView fiber not found", visited };
  // hooks: first useReducer → memoizedState = state
  let hook = found.memoizedState;
  let state: any = null;
  let hops = 0;
  while (hook && hops < 20) {
    if (hook.memoizedState && hook.memoizedState.nodes && hook.memoizedState.line) {
      state = hook.memoizedState;
      break;
    }
    hook = hook.next;
    hops++;
  }
  if (!state) return { error: "reducer state not found in hooks" };
  const line = state.line;
  const cursor = state.cursor;
  const curNodeIdx = line[cursor];
  const pick = (n: any) =>
    n && {
      idx: n.idx,
      isMainline: n.isMainline,
      parent: n.parent,
      fen: n.fen,
      score: n.score,
      bestUci: n.bestUci,
      depth: n.achievedDepth,
      category: n.category,
      delta: n.delta,
      move: n.move?.san,
    };
  return {
    status: state.status,
    gen: state.gen,
    mainlineLen: state.mainline.length,
    nodesLen: state.nodes.length,
    line,
    cursor,
    curNodeIdx,
    curNode: pick(state.nodes[curNodeIdx]),
    last5: state.nodes.slice(-5).map(pick),
    chipText: document.body.innerText.slice(
      document.body.innerText.indexOf("⏭") + 2,
      document.body.innerText.indexOf("⏭") + 25,
    ),
  };
});

console.log(JSON.stringify(dump, null, 2));
await browser.close();
