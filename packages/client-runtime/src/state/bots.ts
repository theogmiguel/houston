import { WS_METHODS } from "@houston-app/contracts";
import type { HoustonBot, HoustonBotStreamEvent } from "@houston-app/contracts/houston/bots";
import { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** An environment's bots as the server last reported them. */
export interface BotsSnapshot {
  readonly state: "loading" | "off" | "on";
  /** Bot runs still stopping after Labs ▸ Bots was turned off. */
  readonly stopping: number;
  readonly bots: ReadonlyArray<HoustonBot>;
}

export const EMPTY_BOTS_SNAPSHOT: BotsSnapshot = { state: "loading", stopping: 0, bots: [] };

/** The fold every subscription applies; an upsert older than the bot held is dropped. */
export function applyBotStreamEvent(
  current: BotsSnapshot,
  event: HoustonBotStreamEvent,
): BotsSnapshot {
  if ("off" in event) return { state: "off", stopping: event.stopping, bots: [] };
  if ("snapshot" in event) return { state: "on", stopping: 0, bots: event.snapshot.bots };
  if ("deleted" in event) {
    const { botId } = event.deleted;
    return { ...current, bots: current.bots.filter((bot) => bot.id !== botId) };
  }
  const { upserted } = event;
  const held = current.bots.find((bot) => bot.id === upserted.id);
  if (held === undefined) return { ...current, bots: [...current.bots, upserted] };
  if (held.rowRevision > upserted.rowRevision) return current;
  return {
    ...current,
    bots: current.bots.map((bot) => (bot.id === upserted.id ? upserted : bot)),
  };
}

export function createBotEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    /** Every bot of the environment, live. */
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:bots:list",
      tag: WS_METHODS.houstonBotsSubscribe,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(Stream.scan(() => EMPTY_BOTS_SNAPSHOT, applyBotStreamEvent)),
    }),
    revisions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:bots:revisions",
      tag: WS_METHODS.houstonBotsRevisions,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:save",
      tag: WS_METHODS.houstonBotsSave,
      scheduler,
      concurrency,
    }),
    restoreRevision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:restore-revision",
      tag: WS_METHODS.houstonBotsRestoreRevision,
      scheduler,
      concurrency,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:set-enabled",
      tag: WS_METHODS.houstonBotsSetEnabled,
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:delete",
      tag: WS_METHODS.houstonBotsDelete,
      scheduler,
      concurrency,
    }),
  };
}
