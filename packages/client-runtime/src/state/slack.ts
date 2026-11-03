import { WS_METHODS, type EnvironmentId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

type Registry = AtomRegistry.AtomRegistry;

/** Slack intake changes outside this client, so the open view polls its requests. */
const REQUESTS_REFRESH_MS = 10_000;

export function createSlackEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const info = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:slack:info",
    tag: WS_METHODS.houstonSlackGet,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const requests = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:slack:requests",
    tag: WS_METHODS.houstonSlackRequestsList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: REQUESTS_REFRESH_MS,
  });
  const importStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:slack:import-status",
    tag: WS_METHODS.houstonSlackImportV1Status,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const refresh = (registry: Registry, environmentId: EnvironmentId) =>
    Effect.sync(() => {
      registry.refresh(info({ environmentId, input: {} }));
      registry.refresh(requests({ environmentId, input: {} }));
    });
  return {
    info,
    requests,
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:connect",
      tag: WS_METHODS.houstonSlackConnect,
      scheduler,
      onSuccess: (target, registry) => refresh(registry, target.environmentId),
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:disconnect",
      tag: WS_METHODS.houstonSlackDisconnect,
      scheduler,
      onSuccess: (target, registry) => refresh(registry, target.environmentId),
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:configure",
      tag: WS_METHODS.houstonSlackConfigure,
      scheduler,
      onSuccess: (target, registry) => refresh(registry, target.environmentId),
    }),
    importStatus,
    importRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:import-run",
      tag: WS_METHODS.houstonSlackImportV1Run,
      scheduler,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(importStatus({ environmentId: target.environmentId, input: {} })),
        ).pipe(Effect.andThen(refresh(registry, target.environmentId))),
    }),
  };
}
