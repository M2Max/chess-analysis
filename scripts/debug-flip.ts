/**
 * Verify board orientation (played perspective) + flip button.
 * Run: bun run scripts/debug-flip.ts
 */
import { chromium } from "playwright-core";

const APP = "http://localhost:5173/";
const CHROME =
  process.env.HOME +
  "/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();

async function orientation(): Promise<"white" | "black" | null> {
  return page.evaluate(() => {
    const a8 = document.getElementById("chessboard-square-a8");
    const h8 = document.getElementById("chessboard-square-h8");
    if (!a8 || !h8) return null;
    // a-file on the left (a8 left of h8) → white at the bottom;
    // h-file on the left → black at the bottom
    const a = a8.getBoundingClientRect();
    const h = h8.getBoundingClientRect();
    return a.left < h.left ? "white" : "black";
  });
}

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("input", { timeout: 15000 });
await page.fill("input", "Mamox43");
await page.click("button[type=submit]");
await page.waitForSelector("ul li button", { timeout: 30000 });

const staleHint = await page.locator("text=game index can lag").count();
console.log("staleness hint shown:", staleHint === 1);

// find one game as white, one as black from the list rows
const rows = page.locator("ul li button");
const count = await rows.count();
let whiteRow = -1;
let blackRow = -1;
for (let i = 0; i < count && (whiteRow < 0 || blackRow < 0); i++) {
  const dot = rows.nth(i).locator("span[title]");
  const title = (await dot.first().getAttribute("title")) ?? "";
  if (title === "Played white" && whiteRow < 0) whiteRow = i;
  if (title === "Played black" && blackRow < 0) blackRow = i;
}
console.log("rows: white at", whiteRow, "| black at", blackRow);

// 1. game as BLACK → black at the bottom
await rows.nth(blackRow).click();
await page.waitForSelector("#chessboard-square-a8", { timeout: 15000 });
console.log("1. as black → orientation:", await orientation(), "(expect black)");

// 2. back → game as WHITE → white at the bottom
await page.locator('button:has-text("← Games")').first().click();
await page.waitForSelector("ul li button");
await rows.nth(whiteRow).click();
await page.waitForSelector("#chessboard-square-a8");
console.log("2. as white → orientation:", await orientation(), "(expect white)");

// 3. flip button inverts
await page.locator('button[title="Flip board (saved in settings)"]').click();
console.log("3. after flip → orientation:", await orientation(), "(expect black)");

// 4. flip persists across games (settings)
await page.locator('button:has-text("← Games")').first().click();
await page.waitForSelector("ul li button");
await rows.nth(blackRow).click();
await page.waitForSelector("#chessboard-square-a8");
console.log("4. next game (as black), flip saved → orientation:", await orientation(), "(expect white)");

// 5. unflip in settings
await page.locator('button[aria-label="Settings"]').click();
await page.waitForSelector("h2", { hasText: "Settings" });
const flipChecked = await page.locator('input[type="checkbox"]').first().isChecked();
console.log("5. settings checkbox checked:", flipChecked);

await browser.close();
