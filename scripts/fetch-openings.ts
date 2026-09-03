// Downloads the Lichess opening names dataset (public domain, CC0) and builds
// the position → opening index the app ships as public/openings.json.
// Runs automatically on `bun install` (postinstall).
//
// Dataset: https://github.com/lichess-org/chess-openings
//   a.tsv .. e.tsv  (one per ECO volume) — columns: eco, name, pgn
//
// The README's suggested classification is "play moves backwards until a
// named position is found". For a full game with its complete move history
// the equivalent is: walk the game's positions forward from move 1 while they
// are in the book — the last in-book position names the opening, and every
// move up to it is a book ("opening") move. Transpositions work because the
// index is keyed by position, not by move sequence.
//
// Index format (public/openings.json, ~900 KB):
//   { "<placement> <sideToMove>": [eco, name, shortestLineDepth], ... }
// The key is the FEN minus castling / en-passant / counters — the fields that
// vary between two occurrences of "the same opening position". Both sides of
// the comparison (book and game) are produced with the same chess.js code, so
// the reduced key always matches.
//
// On conflict (one position, several lines) the shortest line wins, per the
// dataset convention that each name has a unique shortest line.
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "path";
import { Chess } from "chess.js";

const BASE = "https://raw.githubusercontent.com/lichess-org/chess-openings/master/";
const root = join(import.meta.dir, "..");
const publicDir = join(root, "public");
const outPath = join(publicDir, "openings.json");

const files = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"];

// fetch (or reuse a local copy so offline rebuilds work). The build must
// not fail without network: stale TSVs (or a stale index) are fine — the
// app degrades silently when the index is missing.
const tmpDir = join(root, "node_modules", ".cache", "openings");
await mkdir(tmpDir, { recursive: true });
let fetchedOk = true;
for (const f of files) {
  const p = join(tmpDir, f);
  let fresh = false;
  try {
    fresh = Date.now() - (await readFile(p)).mtimeMs < 24 * 3600 * 1000;
  } catch {
    /* missing → try to download */
  }
  if (fresh) continue;
  try {
    const res = await fetch(BASE + f);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(p, await res.text());
  } catch (e) {
    fetchedOk = false;
    console.warn(`openings: could not refresh ${f} (${(e as Error).message})`);
  }
}
// verify all TSVs are present (download failures may leave old copies)
let allPresent = true;
for (const f of files) {
  try {
    await readFile(join(tmpDir, f));
  } catch {
    allPresent = false;
    break;
  }
}
if (!allPresent) {
  try {
    await readFile(outPath);
    console.warn(
      `openings: dataset incomplete and no previous index — keeping ${outPath} missing; opening recognition will be off until the network is back (bun run fetch:openings)`,
    );
    process.exit(0);
  } catch {
    throw new Error(
      "openings: no network and no cached index — run with network or commit public/openings.json",
    );
  }
}
if (!fetchedOk) console.warn("openings: using a partially stale local copy of the dataset");

// build the index
const index = new Map<string, [string, string, number]>();
let entries = 0;
let bad = 0;
for (const f of files) {
  const lines = (await readFile(join(tmpDir, f), "utf8")).split("\n").slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) {
      bad++;
      continue;
    }
    const [eco, name, pgn] = parts;
    const sans = pgn.replace(/\d+\.(\.\.)?/g, " ").trim().split(/\s+/);
    const chess = new Chess();
    try {
      for (let i = 0; i < sans.length; i++) {
        chess.move(sans[i]);
        const key = chess.fen().split(" ").slice(0, 2).join(" ");
        const d = i + 1;
        const prev = index.get(key);
        if (!prev || d < prev[2]) index.set(key, [eco, name, d]);
      }
      entries++;
    } catch {
      bad++; // illegal move in a data line — skip the entry
    }
  }
}

const json = JSON.stringify(Object.fromEntries(index));
await writeFile(outPath, json);
const kb = (json.length / 1024).toFixed(0);
console.log(
  `openings: ${entries} entries (${bad} skipped) → ${index.size} positions → public/openings.json (${kb} KB)`,
);
