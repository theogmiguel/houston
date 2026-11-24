import * as Effect from "effect/Effect";

import type * as DesktopBackendManager from "./DesktopBackendManager.ts";

/** Runs `notice` after each hook that can change this instance's bootstrap entry. */
export function noticeTopologyChanges(
  spec: DesktopBackendManager.BackendInstanceSpec,
  notice: Effect.Effect<void>,
): DesktopBackendManager.BackendInstanceSpec {
  const then = <A>(effect: Effect.Effect<A> | undefined, fallback: A) =>
    (effect ?? Effect.succeed(fallback)).pipe(Effect.tap(() => notice));
  return {
    ...spec,
    onStarting: () => then(spec.onStarting?.(), undefined),
    onReady: (httpBaseUrl, pid) => then(spec.onReady?.(httpBaseUrl, pid), undefined),
    onAttached: (attachment) => then(spec.onAttached?.(attachment), undefined),
    onShutdown: () => then(spec.onShutdown?.(), undefined),
    onStartupFailure: (failure) => then(spec.onStartupFailure?.(failure), undefined),
    ...(spec.onPreflightFailed === undefined
      ? {}
      : {
          onPreflightFailed: (failure: DesktopBackendManager.PreflightFailure) =>
            then(spec.onPreflightFailed!(failure), false),
        }),
  };
}
