/**
 * Verify: fetch list → settings → back → cached list (instant, no refetch),
 * reload → back → localStorage cache, refresh button.
 * Run: bun run scripts/debug-back.ts
 */
import { chromium } from "playwright-core";

const APP = "http://localhost:5173/";
const CHROME =
  process.env.HOME +
  "/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
let refetches = 0;
page.on("request", (r) => {
  if (r.url().includes("api.chess.com")) refetches++;
});

// 1. fresh fetch
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("input", { timeout: 15000 });
await page.fill("input", "Mamox43");
await page.click("button[type=submit]");
await page.waitForSelector("ul li button", { timeout: 30000 });
const rows1 = await page.locator("ul li button").count();
console.log("1. list fetched:", rows1, "rows | api calls:", refetches);

// 2. gear → settings → back button visible → click → list returns
await page.locator('button[aria-label="Settings"]').click();
await page.waitForSelector("h2", { hasText: "Settings" });
const backVisible = (await page.getByRole("button", { name: "← Games" }).count()) === 1;
const before = refetches;
await page.getByRole("button", { name: "← Games" }).click();
await page.waitForSelector("ul li button");
const rows2 = await page.locator("ul li button").count();
console.log("2. back button:", backVisible, "| instant (no refetch):", refetches === before, "| rows:", rows2);

// 3. reload (in-memory list gone) → settings → back → localStorage cache
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("input", { timeout: 15000 });
const backAfterReload = await page.getByRole("button", { name: "← Games" }).count();
const before2 = refetches;
await page.getByRole("button", { name: "← Games" }).click();
await page.waitForSelector("ul li button", { timeout: 10000 });
const rows3 = await page.locator("ul li button").count();
const cachedLabel = await page.locator("text=fetched").count();
console.log("3. after reload: back btn:", backAfterReload === 1, "| from localStorage (no refetch):", refetches === before2, "| rows:", rows3, "| 'fetched' label:", cachedLabel === 1);

// 4. refresh button → refetches
const before3 = refetches;
await page.getByRole("button", { name: /Refresh/ }).click();
await page.waitForTimeout(3000);
console.log("4. refresh triggered refetch:", refetches > before3);

await browser.close();
