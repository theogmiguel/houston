import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type PeerLinkSummary, WS_METHODS } from "@houston-app/contracts";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createPeerLinkEnvironmentAtoms, PEER_LINK_LIST_REFRESH_INTERVAL_MS } from "./peerLinks.ts";

const ENVIRONMENT_ID = EnvironmentId.make("desktop");

const HOMELAB_LINK: PeerLinkSummary = {
  environmentId: EnvironmentId.make("homelab"),
  label: "Homelab",
  urls: ["http://homelab.example.ts.net:3773"],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe("2026-11-18T01:55:14.129Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-18T01:55:14.129Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
};

const makeHarness = Effect.fn("TestPeerLinks.makeHarness")(function* () {
  // The server's stored links; a CLI or another client can change them at any time.
  const stored: { links: ReadonlyArray<PeerLinkSummary> } = { links: [] };
  let listCalls = 0;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [WS_METHODS.peerLinksList]: () =>
            Effect.sync(() => {
              listCalls += 1;
              return { links: stored.links };
            }),
        },
      } as unknown as RpcSession),
    ),
    state: yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run: (_environmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_environmentId, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const atoms = createPeerLinkEnvironmentAtoms(runtime);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const list = atoms.list({ environmentId: ENVIRONMENT_ID, input: {} });
  return { registry, list, stored, listCalls: () => listCalls };
});

const labels = (
  result: AsyncResult.AsyncResult<{ readonly links: ReadonlyArray<PeerLinkSummary> }, unknown>,
) => AsyncResult.getOrElse(result, () => ({ links: [] })).links.map((link) => link.label);

describe("peer link list", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.effect("shows a link made outside this client to a reader that never unmounts", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      // The composer reads the list for as long as a thread is open, so the atom stays mounted.
      const unmount = h.registry.mount(h.list);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
      expect(labels(h.registry.get(h.list))).toEqual([]);

      // `houston environment link` writes the link without telling any client.
      h.stored.links = [HOMELAB_LINK];
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(PEER_LINK_LIST_REFRESH_INTERVAL_MS));

      expect(labels(h.registry.get(h.list))).toEqual(["Homelab"]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not ask again before the interval", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const unmount = h.registry.mount(h.list);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
      const afterFirstAnswer = h.listCalls();

      yield* Effect.promise(() =>
        vi.advanceTimersByTimeAsync(PEER_LINK_LIST_REFRESH_INTERVAL_MS - 1),
      );

      expect(h.listCalls()).toBe(afterFirstAnswer);
    }).pipe(Effect.scoped),
  );
});
