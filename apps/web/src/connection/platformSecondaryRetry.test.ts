import type { HostBridge } from "@houston-app/contracts";
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

const waitFor = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion));

describe("platform registrations beside a stopped secondary backend", { concurrent: false }, () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    vi.unstubAllGlobals();
  });

  it.effect("schedules no retry for it, and still retries a failed primary discovery", () => {
    // The host lists a configured backend that is not running without an endpoint.
    let primaryOrigin = SERVER_ORIGIN;
    const notices = new Set<() => void>();
    const bridge = {
      getLocalEnvironmentEnabled: () => true,
      getClientPlatform: () => "win32",
      getLocalEnvironmentBootstraps: () => [
        {
          id: "primary",
          label: "Local",
          httpBaseUrl: primaryOrigin,
          wsBaseUrl: primaryOrigin.replace("http", "ws"),
          bootstrapToken: "desktop-bootstrap-token",
        },
        { id: "wsl", label: "WSL", httpBaseUrl: null, wsBaseUrl: null },
      ],
      getLocalEnvironmentBearerToken: async () => "desktop-bearer",
      onServerStatus: () => () => {},
      onLocalEnvironmentBootstrapsChanged: (listener: () => void) => {
        notices.add(listener);
        return () => notices.delete(listener);
      },
    };
    vi.stubGlobal("window", {
      location: new URL(`${WINDOW_ORIGIN}/`),
      hostBridge: bridge as unknown as HostBridge,
    });
    const discoveries: Array<string> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname !== "/.well-known/houston/environment") {
          return new Response(null, { status: 404 });
        }
        discoveries.push(url.origin);
        if (url.origin !== SERVER_ORIGIN) return new Response(null, { status: 503 });
        return Response.json({
          environmentId: "environment-local",
          label: "Local",
          platform: { os: "windows", arch: "x64" },
          serverVersion: "1.0.0",
          capabilities: { repositoryIdentity: false },
        });
      }),
    );

    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource.PlatformConnectionSource;
      const builds: Array<number> = [];
      yield* source.registrations.pipe(
        Stream.runForEach((registrations) => Effect.sync(() => builds.push(registrations.length))),
        Effect.forkScoped,
      );
      yield* waitFor(() => expect(builds).toEqual([1]));

      // The cached primary makes a retry synchronous, so it would land within the adjust.
      yield* TestClock.adjust("20 seconds");
      expect(builds).toEqual([1]);

      primaryOrigin = "http://127.0.0.1:3774";
      for (const notice of notices) notice();
      yield* waitFor(() => expect(discoveries.filter((o) => o === primaryOrigin)).toHaveLength(1));
      yield* TestClock.adjust("1 second");
      yield* waitFor(() => expect(discoveries.filter((o) => o === primaryOrigin)).toHaveLength(2));
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
