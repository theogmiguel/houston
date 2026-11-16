import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopEnvironmentBootstrap,
} from "@houston-app/contracts";
import * as Option from "effect/Option";

import type * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";

export interface LocalEnvironmentBootstrapSource {
  readonly id: string;
  readonly label: string;
  readonly runningDistro: string | null;
  readonly config: Option.Option<DesktopBackendManager.DesktopBackendStartConfig>;
  readonly snapshot: DesktopBackendManager.DesktopBackendSnapshot;
  readonly currentBootstrapToken: string;
}

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/**
 * The bootstraps the renderer may use. An instance that is not ready has no
 * origin worth naming: a crash must not leave its dead address behind for a
 * quick composer opened during the restart.
 */
export function localEnvironmentBootstrapEntries(
  sources: ReadonlyArray<LocalEnvironmentBootstrapSource>,
): DesktopEnvironmentBootstrap[] {
  const bootstraps: DesktopEnvironmentBootstrap[] = [];
  for (const source of sources) {
    const isPrimary = source.id === PRIMARY_LOCAL_ENVIRONMENT_ID;
    const emptyEntry = (): DesktopEnvironmentBootstrap => ({
      id: source.id,
      label: source.label,
      runningDistro: source.runningDistro,
      httpBaseUrl: null,
      wsBaseUrl: null,
    });

    if (Option.isNone(source.config)) {
      if (isPrimary) continue;
      bootstraps.push(emptyEntry());
      continue;
    }

    const config = source.config.value;
    if (Option.isSome(config.preflightFailure)) {
      const fatalPreflight = config.preflightFailure.value.fatal;
      const stoppedPreflight = !source.snapshot.desiredRunning || !source.snapshot.restartScheduled;
      if (isPrimary || fatalPreflight || stoppedPreflight) continue;
      bootstraps.push(emptyEntry());
      continue;
    }

    if (!source.snapshot.ready) {
      if (isPrimary) continue;
      bootstraps.push(emptyEntry());
      continue;
    }

    bootstraps.push({
      id: source.id,
      label: source.label,
      runningDistro: source.runningDistro,
      httpBaseUrl: config.httpBaseUrl.href,
      wsBaseUrl: toWebSocketBaseUrl(config.httpBaseUrl),
      // Use the current window's derived token; the launch config's token may be stale.
      ...(config.bootstrap.desktopBootstrapSecret
        ? { bootstrapToken: source.currentBootstrapToken }
        : config.bootstrap.desktopBootstrapToken
          ? { bootstrapToken: config.bootstrap.desktopBootstrapToken }
          : {}),
    });
  }
  return bootstraps;
}
