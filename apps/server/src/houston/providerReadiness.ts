// Houston: one readiness state per provider instance, derived on publish from the snapshot
// and from the turns a provider refused. The ledger of turn-derived states is in memory.
import {
  defaultInstanceIdForDriver,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2StoredEvent,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";

export type TurnReadiness =
  | { readonly state: "signedOut"; readonly message: string }
  | { readonly state: "rejected"; readonly code: string; readonly message: string }
  | { readonly state: "outOfUsage"; readonly resetsAt: string | null; readonly message: string }
  | { readonly state: "none" };

interface FamilyCodes {
  readonly signedOut: ReadonlySet<string>;
  readonly rejected: (failure: OrchestrationV2ProviderFailure) => boolean;
  /** Antigravity emits no `usage_limit` class, so it never reports outOfUsage. */
  readonly usageLimit: boolean;
}

const CODEX_REFUSALS: ReadonlySet<string> = new Set([
  "subscription_sharing_v2_user_not_eligible",
  "subscription_sharing_user_not_eligible",
  "subscription_sharing_v2_client_not_enabled",
  "subscription_sharing_v2_invalid_user",
  "subscription_sharing_invalid_user",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
]);

const ACP_SIGNED_OUT: ReadonlySet<string> = new Set(["-32000"]);

// Account-level codes only; any other failure is about the request. OpenCode failures carry
// no HTTP status and the ACP family no account refusal, so those states are refused by name.
const FAMILY_CODES: Readonly<Record<string, FamilyCodes>> = {
  claudeAgent: {
    // The adapter stamps `authentication_failed` on its own sign-out message.
    signedOut: new Set(["authentication_failed", "api_error_401"]),
    rejected: (failure) => failure.code === "api_error_402" || failure.code === "api_error_403",
    usageLimit: true,
  },
  codex: {
    signedOut: new Set(["unauthorized"]),
    rejected: (failure) => failure.code !== null && CODEX_REFUSALS.has(failure.code),
    usageLimit: true,
  },
  opencode: {
    signedOut: new Set(),
    // A 402 empty balance; quota windows arrive as `usage_limit`.
    rejected: (failure) => failure.code === "provider.quota" && failure.class === "provider_error",
    usageLimit: true,
  },
  acpRegistry: { signedOut: ACP_SIGNED_OUT, rejected: () => false, usageLimit: true },
  antigravity: { signedOut: ACP_SIGNED_OUT, rejected: () => false, usageLimit: false },
};

export function classifyTurnFailure(
  driver: ProviderDriverKind,
  failure: OrchestrationV2ProviderFailure,
): TurnReadiness {
  const family = FAMILY_CODES[driver];
  if (family === undefined) return { state: "none" };
  if (failure.class === "usage_limit") {
    return family.usageLimit
      ? { state: "outOfUsage", resetsAt: failure.resetAt ?? null, message: failure.message }
      : { state: "none" };
  }
  if (failure.code !== null && family.signedOut.has(failure.code)) {
    return { state: "signedOut", message: failure.message };
  }
  if (failure.code !== null && family.rejected(failure)) {
    return { state: "rejected", code: failure.code, message: failure.message };
  }
  return { state: "none" };
}

export type ReadinessLedgerEntry = Exclude<TurnReadiness, { readonly state: "none" }> & {
  readonly at: string;
};

const MAX_MESSAGE_LENGTH = 4_096;

const causeMessage = (candidate: string | undefined, fallback: string): string => {
  const trimmed = candidate?.trim() ?? "";
  return (trimmed.length > 0 ? trimmed : fallback).slice(0, MAX_MESSAGE_LENGTH).trim();
};

function entryReadiness(entry: ReadinessLedgerEntry, name: string): ProviderReadiness {
  switch (entry.state) {
    case "signedOut":
      return {
        state: "signedOut",
        source: "turn",
        message: causeMessage(entry.message, `${name} is signed out`),
      };
    case "rejected":
      return {
        state: "rejected",
        code: entry.code,
        message: causeMessage(entry.message, `${name} refused this account`),
        at: entry.at,
      };
    case "outOfUsage":
      return {
        state: "outOfUsage",
        resetsAt: entry.resetsAt,
        message:
          entry.resetsAt === null
            ? `${name} did not say when its limit resets`
            : causeMessage(entry.message, `${name} is out of usage`),
        at: entry.at,
      };
  }
}

/** First match wins: unavailable, disabled, not installed, signed out, ledger, health error. */
export function withReadiness(
  snapshot: ServerProvider,
  entry: ReadinessLedgerEntry | undefined,
): ServerProvider {
  const name = snapshot.displayName ?? snapshot.driver;
  const notFound = `${name} was not found`;
  const readiness: ProviderReadiness =
    snapshot.availability === "unavailable"
      ? {
          state: "notInstalled",
          reason: "missing",
          message: causeMessage(snapshot.unavailableReason ?? snapshot.message, notFound),
        }
      : !snapshot.enabled
        ? {
            state: "turnedOff",
            message: causeMessage(snapshot.message, `${name} is turned off in Settings`),
          }
        : !snapshot.installed
          ? {
              state: "notInstalled",
              reason: "missing",
              message: causeMessage(snapshot.message, notFound),
            }
          : snapshot.auth.status === "unauthenticated"
            ? {
                state: "signedOut",
                source: "probe",
                message: causeMessage(snapshot.message, `${name} is signed out`),
              }
            : entry !== undefined
              ? entryReadiness(entry, name)
              : snapshot.status === "error"
                ? {
                    state: "notInstalled",
                    reason: "unusable",
                    message: causeMessage(snapshot.message, `${name} failed its health check`),
                  }
                : { state: "ready" };
  return { ...snapshot, readiness };
}

export interface TurnReport {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly status: "completed" | "interrupted" | "cancelled" | "failed";
  readonly failure: OrchestrationV2ProviderFailure | null;
  readonly occurredAt: DateTime.Utc;
}

export interface ReadinessLedgerShape {
  /** The newest report per instance wins; older ones are ignored. */
  readonly report: (input: TurnReport) => Effect.Effect<void>;
  /** A refresh clears turn-derived states, except outOfUsage with a reset still ahead. */
  readonly clear: (instances: "all" | ReadonlyArray<ProviderInstanceId>) => Effect.Effect<void>;
  /** Forgets every instance not listed, so an id added again starts with no entry. */
  readonly retain: (instances: ReadonlyArray<ProviderInstanceId>) => Effect.Effect<void>;
  /** Current entries; an outOfUsage entry whose reset has passed is absent. */
  readonly entries: Effect.Effect<ReadonlyMap<ProviderInstanceId, ReadinessLedgerEntry>>;
  readonly changes: Stream.Stream<void>;
}

export class ReadinessLedger extends Context.Service<ReadinessLedger, ReadinessLedgerShape>()(
  "houston/houston/providerReadiness/ReadinessLedger",
) {}

interface Slot {
  readonly entry: ReadinessLedgerEntry | undefined;
  /** Time of the newest report applied, so a late older report cannot win. */
  readonly reportedAtMs: number;
}

const sameEntry = (a: ReadinessLedgerEntry | undefined, b: ReadinessLedgerEntry | undefined) =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

const resetMs = (entry: ReadinessLedgerEntry | undefined): number | undefined => {
  if (entry?.state !== "outOfUsage" || entry.resetsAt === null) return undefined;
  const ms = Date.parse(entry.resetsAt);
  return Number.isFinite(ms) ? ms : undefined;
};

export const layerReadinessLedger = Layer.effect(
  ReadinessLedger,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const slots = yield* Ref.make<ReadonlyMap<ProviderInstanceId, Slot>>(new Map());
    const expiries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, Fiber.Fiber<void>>>(new Map());
    const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
    const publish = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

    const expire = (instanceId: ProviderInstanceId, entry: ReadinessLedgerEntry) =>
      Ref.modify(slots, (current) => {
        const slot = current.get(instanceId);
        if (slot?.entry !== entry) return [false, current] as const;
        return [true, new Map(current).set(instanceId, { ...slot, entry: undefined })] as const;
      }).pipe(Effect.flatMap((expired) => (expired ? publish : Effect.void)));

    const scheduleExpiry = Effect.fn("ReadinessLedger.scheduleExpiry")(function* (
      instanceId: ProviderInstanceId,
      entry: ReadinessLedgerEntry,
    ) {
      const resetAt = resetMs(entry);
      if (resetAt === undefined) return;
      const delay = Math.max(0, resetAt - (yield* nowMs));
      const fiber = yield* Effect.sleep(Duration.millis(delay)).pipe(
        Effect.andThen(expire(instanceId, entry)),
        Effect.forkIn(scope),
      );
      const previous = yield* Ref.modify(expiries, (current) => [
        current.get(instanceId),
        new Map(current).set(instanceId, fiber),
      ]);
      if (previous !== undefined) yield* Fiber.interrupt(previous);
    });

    const report = Effect.fn("ReadinessLedger.report")(function* (input: TurnReport) {
      if (input.status === "interrupted" || input.status === "cancelled") return;
      let entry: ReadinessLedgerEntry | undefined;
      if (input.status === "failed") {
        if (input.failure === null) return;
        const classified = classifyTurnFailure(input.driver, input.failure);
        if (classified.state === "none") return;
        entry = { ...classified, at: DateTime.formatIso(input.occurredAt) };
      }
      const reportedAtMs = DateTime.toEpochMillis(input.occurredAt);
      const changed = yield* Ref.modify(slots, (current) => {
        const previous = current.get(input.instanceId);
        if (previous !== undefined && reportedAtMs < previous.reportedAtMs) {
          return [false, current] as const;
        }
        const next = new Map(current).set(input.instanceId, { entry, reportedAtMs });
        return [!sameEntry(previous?.entry, entry), next] as const;
      });
      if (!changed) return;
      if (entry !== undefined) yield* scheduleExpiry(input.instanceId, entry);
      yield* publish;
    });

    const clear = Effect.fn("ReadinessLedger.clear")(function* (
      instances: "all" | ReadonlyArray<ProviderInstanceId>,
    ) {
      const now = yield* nowMs;
      const covered = instances === "all" ? undefined : new Set(instances);
      const changed = yield* Ref.modify(slots, (current) => {
        let cleared = false;
        const next = new Map(current);
        for (const [instanceId, slot] of current) {
          if (slot.entry === undefined || (covered !== undefined && !covered.has(instanceId))) {
            continue;
          }
          const reset = resetMs(slot.entry);
          if (reset !== undefined && reset > now) continue;
          next.set(instanceId, { ...slot, entry: undefined });
          cleared = true;
        }
        return [cleared, cleared ? next : current] as const;
      });
      if (changed) yield* publish;
    });

    const retain = Effect.fn("ReadinessLedger.retain")(function* (
      instances: ReadonlyArray<ProviderInstanceId>,
    ) {
      const kept = new Set(instances);
      const without = <V>(current: ReadonlyMap<ProviderInstanceId, V>) => {
        const removed = [...current.keys()].filter((instanceId) => !kept.has(instanceId));
        if (removed.length === 0) return [[] as ReadonlyArray<V>, current] as const;
        const next = new Map(current);
        for (const instanceId of removed) next.delete(instanceId);
        return [removed.map((instanceId) => current.get(instanceId)!), next] as const;
      };
      yield* Ref.update(slots, (current) => without(current)[1]);
      const stale = yield* Ref.modify(expiries, without);
      yield* Effect.forEach(stale, Fiber.interrupt, { discard: true });
    });

    const entries = Effect.gen(function* () {
      const now = yield* nowMs;
      const result = new Map<ProviderInstanceId, ReadinessLedgerEntry>();
      for (const [instanceId, slot] of yield* Ref.get(slots)) {
        if (slot.entry === undefined) continue;
        const reset = resetMs(slot.entry);
        if (reset !== undefined && reset <= now) continue;
        result.set(instanceId, slot.entry);
      }
      return result as ReadonlyMap<ProviderInstanceId, ReadinessLedgerEntry>;
    });

    return ReadinessLedger.of({
      report,
      clear,
      retain,
      entries,
      get changes() {
        return Stream.fromPubSub(changes);
      },
    });
  }),
);

/**
 * Reports a terminal turn the ingestor stored. A completion usually stores nothing, so one
 * is reported unless a write guard (stale run, non-owner) could have refused it.
 */
export const reportTurnTerminal = Effect.fn("reportTurnTerminal")(function* (
  ledger: Option.Option<ReadinessLedgerShape>,
  input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly event: ProviderAdapter.ProviderAdapterV2Event;
    readonly writeIfRunCurrent?: unknown;
    readonly writeIfProviderThreadOwner?: unknown;
  },
  storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>,
) {
  if (Option.isNone(ledger) || input.event.type !== "turn.terminal") return;
  const { event } = input;
  const guarded =
    input.writeIfRunCurrent !== undefined || input.writeIfProviderThreadOwner !== undefined;
  // Stamped before the write, so a late older completion loses to a newer failure.
  const stored = storedEvents.at(-1);
  if (stored === undefined && (event.status === "failed" || guarded)) return;
  yield* ledger.value.report({
    instanceId: input.providerInstanceId,
    driver: event.driver,
    status: event.status,
    failure: event.status === "failed" ? event.failure : null,
    occurredAt: stored === undefined ? yield* DateTime.now : stored.event.occurredAt,
  });
});

type RegistryService = ProviderRegistry.ProviderRegistry["Service"];

interface PublishedState {
  readonly state: ProviderReadiness["state"];
  readonly code: string | undefined;
}

const publishedState = (readiness: ProviderReadiness): PublishedState => ({
  state: readiness.state,
  code: readiness.state === "rejected" ? readiness.code : undefined,
});

/** Every list carries readiness; a ledger change republishes, a refresh clears its instances. */
export const decorateProviderRegistry = Effect.fn("decorateProviderRegistry")(function* (
  raw: RegistryService,
) {
  const ledger = yield* ReadinessLedger;
  const published = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
    PubSub.shutdown,
  );
  const decorate = (providers: ReadonlyArray<ServerProvider>) =>
    ledger.entries.pipe(
      Effect.map((entries) =>
        providers.map((provider) => withReadiness(provider, entries.get(provider.instanceId))),
      ),
    );

  const lastPublished = new Map<ProviderInstanceId, PublishedState>();
  const record = Effect.fn("decorateProviderRegistry.record")(function* (
    providers: ReadonlyArray<ServerProvider>,
    log: boolean,
  ) {
    for (const provider of providers) {
      if (provider.readiness === undefined) continue;
      const next = publishedState(provider.readiness);
      const previous = lastPublished.get(provider.instanceId);
      lastPublished.set(provider.instanceId, next);
      if (!log || previous === undefined) continue;
      if (previous.state === next.state && previous.code === next.code) continue;
      yield* Effect.logInfo("houston.provider-readiness.changed", {
        instanceId: provider.instanceId,
        driver: provider.driver,
        from: previous.state,
        to: next.state,
        ...(next.code === undefined ? {} : { code: next.code }),
      });
    }
  });

  // One observer at a time keeps the log and the published order consistent.
  const observing = yield* Semaphore.make(1);
  const observe = (providers: ReadonlyArray<ServerProvider>) =>
    observing.withPermits(1)(
      decorate(providers).pipe(
        Effect.tap((decorated) => record(decorated, true)),
        Effect.flatMap((decorated) => PubSub.publish(published, decorated)),
      ),
    );
  yield* record(yield* decorate(yield* raw.getProviders), false);

  // Starting immediately subscribes before this returns, so no change is missed.
  const scope = yield* Effect.scope;
  const follow = <A>(stream: Stream.Stream<A>, onItem: (item: A) => Effect.Effect<unknown>) =>
    Stream.runForEach(stream, onItem).pipe(Effect.forkIn(scope, { startImmediately: true }));
  yield* follow(raw.streamChanges, (providers) => {
    const listed = providers.map((provider) => provider.instanceId);
    for (const instanceId of lastPublished.keys()) {
      if (!listed.includes(instanceId)) lastPublished.delete(instanceId);
    }
    return ledger.retain(listed).pipe(Effect.andThen(observe(providers)));
  });
  yield* follow(ledger.changes, () => raw.getProviders.pipe(Effect.flatMap(observe)));

  const clearing =
    (
      instances: (
        providers: ReadonlyArray<ServerProvider>,
      ) => "all" | ReadonlyArray<ProviderInstanceId>,
    ) =>
    (providers: ReadonlyArray<ServerProvider>) =>
      ledger.clear(instances(providers)).pipe(Effect.andThen(decorate(providers)));

  return {
    getProviders: raw.getProviders.pipe(Effect.flatMap(decorate)),
    refresh: (provider) =>
      raw
        .refresh(provider)
        .pipe(
          Effect.flatMap(
            clearing(() =>
              provider === undefined ? "all" : [defaultInstanceIdForDriver(provider)],
            ),
          ),
        ),
    refreshInstance: (instanceId) =>
      raw.refreshInstance(instanceId).pipe(Effect.flatMap(clearing(() => [instanceId]))),
    reloadSecretsAndRefresh: (instanceId) =>
      raw.reloadSecretsAndRefresh(instanceId).pipe(
        Effect.flatMap(clearing(() => (instanceId === undefined ? "all" : [instanceId]))),
      ),
    refreshAfterUpdate: (provider, selectedInstanceId) =>
      raw
        .refreshAfterUpdate(provider, selectedInstanceId)
        .pipe(Effect.flatMap(clearing((providers) => providers.map((entry) => entry.instanceId)))),
    refreshWorkspaceSnapshot: (input) =>
      raw
        .refreshWorkspaceSnapshot(input)
        .pipe(Effect.flatMap(input.fresh === true ? clearing(() => [input.instanceId]) : decorate)),
    getProviderMaintenanceCapabilitiesForInstance:
      raw.getProviderMaintenanceCapabilitiesForInstance,
    setProviderMaintenanceActionState: (input) =>
      raw.setProviderMaintenanceActionState(input).pipe(Effect.flatMap(decorate)),
    get streamChanges() {
      return Stream.fromPubSub(published);
    },
  } satisfies RegistryService;
});
