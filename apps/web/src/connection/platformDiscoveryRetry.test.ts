import { describe, expect, it } from "@effect/vitest";
import { PlatformConnectionSource } from "@houston-app/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vite-plus/test";

import { layer, platformRegistrations } from "./platform.ts";

const SERVER_ORIGIN = "http://127.0.0.1:3773";
const RETRY_DELAYS = ["1 second", "2 seconds", "4 seconds", "8 seconds", "16 seconds"] as const;

const waitFor = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion));

describe("platform registrations in a browser whose first discovery fails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("retries the discovery within seconds, then leaves it to the safety poll", () => {
    // A browser has no host to announce its server, so only a retry follows a failed read.
    vi.stubGlobal("window", { location: new URL(`${SERVER_ORIGIN}/`) });
    const discoveries: Array<string> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new Request(input, init).url;
        if (new URL(url).pathname === "/.well-known/houston/environment") discoveries.push(url);
        return new Response(null, { status: 503 });
      }),
    );

    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource.PlatformConnectionSource;
      yield* source.registrations.pipe(Stream.runDrain, Effect.forkScoped);
      yield* waitFor(() => expect(discoveries).toHaveLength(1));

      for (const [index, delay] of RETRY_DELAYS.entries()) {
        yield* TestClock.adjust(delay);
        yield* waitFor(() => expect(discoveries).toHaveLength(index + 2));
      }
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});

describe("platform registration retries", () => {
  // A synchronous build finishes within `TestClock.adjust`, so the counts below are exact.
  const run = (outcomes: ReadonlyArray<boolean>) => {
    let builds = 0;
    const build = Effect.sync(() => {
      const settled = outcomes[builds] ?? false;
      builds += 1;
      return { registrations: builds, settled };
    });
    return {
      builds: () => builds,
      start: platformRegistrations(build, () => () => {}).pipe(Stream.runDrain, Effect.forkScoped),
    };
  };

  it.effect("stops after five retries while no build settles", () =>
    Effect.gen(function* () {
      const registrations = run([]);
      yield* registrations.start;
      yield* waitFor(() => expect(registrations.builds()).toBe(1));
      for (const [index, delay] of RETRY_DELAYS.entries()) {
        yield* TestClock.adjust(delay);
        yield* waitFor(() => expect(registrations.builds()).toBe(index + 2));
      }
      yield* TestClock.adjust("10 minutes");
      expect(registrations.builds()).toBe(6);
    }).pipe(Effect.scoped),
  );

  it.effect("makes no retry once a build settles", () =>
    Effect.gen(function* () {
      const registrations = run([false, true]);
      yield* registrations.start;
      yield* waitFor(() => expect(registrations.builds()).toBe(1));
      yield* TestClock.adjust("1 second");
      yield* waitFor(() => expect(registrations.builds()).toBe(2));
      yield* TestClock.adjust("10 minutes");
      expect(registrations.builds()).toBe(2);
    }).pipe(Effect.scoped),
  );
});
