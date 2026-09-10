// Fresh README screenshots (regenerate: node scripts/shots.mjs while the dev
// servers run - :3000 API + :5173 vite). Not part of CI - run manually after
// visible UI changes. Desktop 1280x800, mobile 390x844 @2x.
import { chromium } from "playwright-core";

const EXE =
  "/Users/mmamone/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });

/** index (in the visible list) of a nice analysed middlegame game */
async function analysedRowIndex(page) {
  return page.evaluate(async () => {
    const res = await fetch("/api/db/players/Mamox43/games?from=0");
    const j = await res.json();
    const games = Array.isArray(j) ? j : j.games;
    const i = games.findIndex((g) => g.analysis);
    return i;
  });
}

async function openReviewedGame(page, idx, pliesRight = 12) {
  await page.locator("ul li button").nth(idx).click();
  // desktop: the scrollable move list; mobile: the swipe strip (lg:hidden)
  const wide = (await page.viewportSize())?.width ?? 0;
  await page.waitForSelector(wide >= 1024 ? ".max-h-\\[420px\\]" : '[aria-label*="Striscia"]', {
    timeout: 120000,
  });
  await sleep(1500);
  await page.keyboard.press("Home");
  for (let i = 0; i < pliesRight; i++) await page.keyboard.press("ArrowRight");
  await sleep(900);
}

// ============================== DESKTOP ==============================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));

  // 1. players grid (home)
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Giocatori");
  await sleep(1200);
  await page.screenshot({ path: "images/players-dark.png" });
  console.log("players-dark done");

  // 2. games list
  await page.locator("div.group", { hasText: "Mamox43" }).first().locator("button").first().click();
  await page.waitForSelector("ul li button", { timeout: 90000 });
  await sleep(900);
  const idx = await analysedRowIndex(page);
  console.log("first analysed row:", idx);
  await page.screenshot({ path: "images/list-dark.png" });
  console.log("list-dark done");

  // 3. review (dark) - cached game, middlegame with eval bar + lines
  await openReviewedGame(page, idx);
  await page.screenshot({ path: "images/review-dark.png" });
  console.log("review-dark done");

  // 4. review (light)
  await page.click('button[aria-label*="Cambia tema"]');
  await sleep(700);
  await page.screenshot({ path: "images/review-light.png" });
  await page.click('button[aria-label*="Cambia tema"]'); // back to dark
  await sleep(500);

  // 5. stats
  await page.click('button[aria-label*="Statistiche"]');
  await page.waitForSelector("text=Quadro generale", { timeout: 60000 });
  await sleep(1500);
  await page.evaluate(() =>
    [...document.querySelectorAll("h2")]
      .find((h) => h.textContent?.includes("Quadro generale"))
      ?.scrollIntoView(),
  );
  await sleep(500);
  await page.screenshot({ path: "images/stats-dark.png" });
  console.log("stats-dark done");

  // 6. puzzles: hub, then one puzzle being solved
  await page.click('button[aria-label="Puzzle"]');
  await sleep(1500);
  await page.click("text=Gioca puzzle");
  await page.waitForSelector("#chessboard-square-a8", { timeout: 30000 });
  await sleep(1200);
  await page.screenshot({ path: "images/puzzles-dark.png" });
  console.log("puzzles-dark done");
  await page.close();
}

// ============================== MOBILE ==============================
{
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));

  // players grid
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Giocatori");
  await sleep(1000);

  // 7. review (compact header, swipe strip, thinking times)
  await page.locator("div.group", { hasText: "Mamox43" }).first().locator("button").first().click();
  await page.waitForSelector("ul li button", { timeout: 90000 });
  const idx = await analysedRowIndex(page);
  await openReviewedGame(page, idx, 10);
  await page.screenshot({ path: "images/mobile-review-dark.png" });
  console.log("mobile-review-dark done");

  // 8. puzzle being solved
  await page.goBack(); // back to list
  await sleep(800);
  await page.click('button[aria-label="Puzzle"]');
  await sleep(1500);
  await page.click("text=Gioca puzzle");
  await page.waitForSelector("#chessboard-square-a8", { timeout: 30000 });
  await sleep(1000);
  await page.screenshot({ path: "images/mobile-puzzles-dark.png" });
  console.log("mobile-puzzles-dark done");
  await page.close();
}

await browser.close();
console.log("ALL SHOTS DONE");
