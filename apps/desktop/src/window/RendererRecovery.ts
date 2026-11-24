import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

// The first reload stays as quick as a single crash has always been recovered.
const RENDERER_RECOVERY_INITIAL_DELAY_MS = 500;
// Bounds a crash loop to two reloads a minute while a retry is never far off.
const RENDERER_RECOVERY_MAX_DELAY_MS = 30_000;
// A reloaded renderer that lasts this long is healthy again, so the backoff restarts.
const RENDERER_RECOVERY_STABLE_MS = 60_000;

const RECOVERABLE_REASONS = new Set(["crashed", "oom", "killed", "abnormal-exit"]);

export interface RendererRecoveryOptions {
  readonly isWindowGone: () => boolean;
  readonly isQuitting: Effect.Effect<boolean>;
  readonly reload: () => void;
}

export interface RendererRecoveryDecision {
  readonly recovering: boolean;
  readonly reloadInMs?: number;
}

export interface RendererRecovery {
  readonly renderProcessGone: (reason: string) => Effect.Effect<RendererRecoveryDecision>;
  // For a closed window: cancels a pending reload and recovers nothing after it.
  readonly stop: Effect.Effect<void>;
}

function rendererRecoveryDelayMs(consecutiveCrashes: number): number {
  return Math.min(
    RENDERER_RECOVERY_INITIAL_DELAY_MS * 2 ** consecutiveCrashes,
    RENDERER_RECOVERY_MAX_DELAY_MS,
  );
}

export function makeRendererRecovery(options: RendererRecoveryOptions): RendererRecovery {
  let consecutiveCrashes = 0;
  let lastReloadAt: number | undefined;
  let pendingReload: Fiber.Fiber<void, never> | undefined;
  let stopped = false;

  const windowGone = () => stopped || options.isWindowGone();

  const reloadAfter = Effect.fn("RendererRecovery.reloadAfter")(function* (delayMs: number) {
    yield* Effect.sleep(delayMs);
    // A quit or update install that fails clears the flag, so keep re-checking instead of giving up.
    while (!windowGone() && (yield* options.isQuitting)) yield* Effect.sleep(delayMs);
    pendingReload = undefined;
    if (windowGone()) return;
    lastReloadAt = yield* Clock.currentTimeMillis;
    options.reload();
  });

  return {
    renderProcessGone: Effect.fn("RendererRecovery.renderProcessGone")(function* (
      reason: string,
    ): Effect.fn.Return<RendererRecoveryDecision> {
      if (!RECOVERABLE_REASONS.has(reason) || windowGone()) {
        return { recovering: false };
      }
      if (pendingReload !== undefined) return { recovering: true };
      const now = yield* Clock.currentTimeMillis;
      if (lastReloadAt !== undefined && now - lastReloadAt >= RENDERER_RECOVERY_STABLE_MS) {
        consecutiveCrashes = 0;
      }
      const reloadInMs = rendererRecoveryDelayMs(consecutiveCrashes);
      consecutiveCrashes += 1;
      // Detached: the reload outlives the short fiber that reported the crash.
      pendingReload = yield* Effect.forkDetach(reloadAfter(reloadInMs));
      return { recovering: true, reloadInMs };
    }),
    stop: Effect.suspend(() => {
      stopped = true;
      const fiber = pendingReload;
      pendingReload = undefined;
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    }),
  };
}
