import type { DesktopLocalServerStatus, HostBridge } from "@houston-app/contracts";
import { describe, expect, it } from "@effect/vitest";
import { PlatformConnectionSource } from "@houston-app/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vite-plus/test";

import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";
import { layer } from "./platform.ts";

const WINDOW_ORIGIN = "http://tauri.localhost";
const SERVER_ORIGIN = "http://127.0.0.1:3773";

function installStartingHost() {
  let ready = false;
  const listeners = new Set<(status: DesktopLocalServerStatus) => void>();
  const notices = new Set<() => void>();
  const bridge = {
    getLocalEnvironmentEnabled: () => true,
    getClientPlatform: () => "win32",
    getLocalEnvironmentBootstraps: vi.fn(() =>
      ready
        ? [
            {
              id: "primary",
              label: "Local",
              httpBaseUrl: SERVER_ORIGIN,
              wsBaseUrl: "ws://127.0.0.1:3773",
              bootstrapToken: "desktop-bootstrap-token",
            },
          ]
        : [],
    ),
    getLocalEnvironmentBearerToken: async () => {
      if (!ready) throw "the v2 server is not running yet";
      return "desktop-bearer";
    },
    onServerStatus: (listener: (status: DesktopLocalServerStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onLocalEnvironmentBootstrapsChanged: (listener: () => void) => {
      notices.add(listener);
      return () => notices.delete(listener);
    },
  };
  vi.stubGlobal("window", {
    location: new URL(`${WINDOW_ORIGIN}/`),
    hostBridge: bridge as unknown as HostBridge,
  });
  return {
    topologyReads: () => bridge.getLocalEnvironmentBootstraps.mock.calls.length,
    notice: () => {
      for (const listener of notices) listener();
    },
    listenerCount: () => listeners.size,
    becomeReady: () => {
      ready = true;
      for (const listener of listeners) listener({ state: "ready" });
    },
  };
}

const waitFor = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion));

describe("platform registrations on a desktop cold start", { concurrent: false }, () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    vi.unstubAllGlobals();
  });

  it.effect("discovers the server on the host's ready event, without waiting for the poll", () => {
    const host = installStartingHost();
    const requests: Array<string> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init).url);
        return new Response(null, { status: 503 });
      }),
    );

    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource.PlatformConnectionSource;
      // The test clock never advances, so only the first poll and the ready event can build.
      yield* source.registrations.pipe(Stream.runDrain, Effect.forkScoped);
      yield* waitFor(() => expect(host.listenerCount()).toBe(1));

      host.becomeReady();
      yield* waitFor(() =>
        expect(requests.some((url) => url.startsWith(SERVER_ORIGIN))).toBe(true),
      );
      expect(requests.map((url) => new URL(url).origin)).not.toContain(WINDOW_ORIGIN);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("reads the host topology on its notices, not on a three-second tick", () => {
    const host = installStartingHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource.PlatformConnectionSource;
      yield* source.registrations.pipe(Stream.runDrain, Effect.forkScoped);
      yield* waitFor(() => expect(host.topologyReads()).toBeGreaterThan(0));
      const afterStart = host.topologyReads();

      yield* TestClock.adjust("60 seconds");
      expect(host.topologyReads()).toBe(afterStart);

      host.notice();
      yield* waitFor(() => expect(host.topologyReads()).toBeGreaterThan(afterStart));
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
