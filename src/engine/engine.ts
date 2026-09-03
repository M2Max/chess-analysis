import { ENGINE_CONFIG, type EngineKind } from "./config";
import { Engine } from "./stockfish";

/**
 * One engine instance per (variant, threads). Switching disposes the others
 * (an in-flight analysis is rejected - the caller's abort/error handling
 * takes over).
 *
 * Multi-threaded builds only work in cross-origin-isolated documents
 * (SharedArrayBuffer). Without the COOP/COEP headers the app silently falls
 * back to the single-threaded build.
 */
const instances = new Map<string, Engine>();

export interface ResolvedEngine {
  kind: EngineKind;
  threads: number;
  variant: "single" | "multi";
}

/** Pure resolution logic - exported for tests. */
export function resolveEngine(
  kind: EngineKind,
  threadsSetting: number,
  env: { hardwareConcurrency?: number; crossOriginIsolated?: boolean } = {},
): ResolvedEngine {
  const hw = Math.max(1, env.hardwareConcurrency ?? 4);
  const requested = Math.min(threadsSetting <= 0 ? hw : threadsSetting, ENGINE_CONFIG.maxThreads);
  const isolated = env.crossOriginIsolated ?? false;
  const variant: ResolvedEngine["variant"] = isolated && requested > 1 ? "multi" : "single";
  return { kind, threads: variant === "multi" ? requested : 1, variant };
}

export function getEngine(kind: EngineKind, threadsSetting: number): Engine {
  const sel = resolveEngine(kind, threadsSetting, {
    hardwareConcurrency:
      typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined,
    crossOriginIsolated:
      typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : false,
  });
  const key = `${sel.kind}:${sel.variant}:${sel.threads}`;
  if (instances.has(key)) return instances.get(key)!;
  for (const [k, engine] of instances) {
    if (k !== key) {
      engine.dispose();
      instances.delete(k);
    }
  }
  const engine = new Engine(ENGINE_CONFIG.workerUrls[kind][sel.variant], {
    threads: sel.threads,
    variant: sel.variant,
    multiPv: ENGINE_CONFIG.multiPv,
  });
  instances.set(key, engine);
  return engine;
}
