// Copies the Stockfish WASM builds from node_modules into public/.
// Runs automatically on `bun install` (postinstall).
//
// Per engine choice the user can pick in the settings view, two builds ship:
//
//   public/stockfish-lite/
//     stockfish.js / stockfish.wasm        lite SINGLE-threaded  (~7 MB)
//     stockfish-multi.js / .wasm           lite MULTI-threaded   (~7 MB)
//     stockfish.worker.js                  pthread worker (copy of stockfish-multi.js)
//   public/stockfish-full/
//     stockfish.js / stockfish.wasm        full SINGLE-threaded  (~113 MB)
//     stockfish-multi.js / .wasm           full MULTI-threaded   (~113 MB)
//     stockfish.worker.js                  pthread worker (copy of stockfish-multi.js)
//
// The multi-threaded builds only work in cross-origin-isolated documents
// (COOP + COEP headers — see vite.config.ts and server/index.ts); the app
// falls back to the single-threaded builds otherwise.
//
// NOTE: the npm package does not ship the pthread worker file the multi
// builds spawn (`new Worker("stockfish.worker.js")`). The builds are
// self-contained loaders (their onmessage bootstrap is inlined), so a copy
// of the multi loader itself serves as the worker script.
import { readdir, copyFile, mkdir } from "node:fs/promises";
import { join } from "path";

const binDir = join(import.meta.dir, "..", "node_modules", "stockfish", "bin");
const publicDir = join(import.meta.dir, "..", "public");

const BUILDS: Record<string, RegExp> = {
  "stockfish-lite": {
    single: /^stockfish-\d+(?:\.\d+)?-lite-single\.js$/,
    multi: /^stockfish-\d+(?:\.\d+)?-lite\.js$/,
  },
  "stockfish-full": {
    single: /^stockfish-\d+(?:\.\d+)?-single\.js$/,
    multi: /^stockfish-\d+(?:\.\d+)?\.js$/,
  },
};

const files = await readdir(binDir);

for (const [outDir, patterns] of Object.entries(BUILDS)) {
  const out = join(publicDir, outDir);
  await mkdir(out, { recursive: true });
  for (const variant of ["single", "multi"] as const) {
    const js = files.find((f) => patterns[variant].test(f));
    if (!js) throw new Error(`no ${variant} engine build for "${outDir}" in ${binDir}`);
    const wasm = js.replace(/\.js$/, ".wasm");
    const name = variant === "single" ? "stockfish" : "stockfish-multi";
    await copyFile(join(binDir, js), join(out, `${name}.js`));
    await copyFile(join(binDir, wasm), join(out, `${name}.wasm`));
    console.log(`stockfish: ${js} + ${wasm} -> ${outDir}/${name}.*`);
  }
  // pthread worker script = copy of the multi loader (self-contained)
  await copyFile(join(out, "stockfish-multi.js"), join(out, "stockfish.worker.js"));
}
