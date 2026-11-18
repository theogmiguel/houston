/**
 * Standalone issue trackers as Settings manages them: one credential per tracker kind in the
 * secret store, and the per-project binding that puts a tracker's scope beside the project's
 * git-host issues. Disconnecting clears the bindings that pointed at the tracker.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  IssueTrackerConnectionError,
  IssueTrackerKind,
  type IssueTrackerBindProjectInput,
  type IssueTrackerConnectInput,
  type IssueTrackerConnection,
  type IssueTrackerConnectionList,
  type IssueTrackerPropertiesInput,
  type IssueTrackerPropertyList,
} from "@houston-app/contracts";
import type { StandaloneIssueTrackerApi } from "@houston-app/source-control-core/server/IssueTracker";

import * as HoustonSecrets from "../houston/secrets/HoustonSecrets.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as IssueService from "./IssueService.ts";
import { issueTrackerSecretName } from "./IssueTrackerHostLive.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

/** The contract's own bound, checked again where the value reaches the secret store. */
const MAX_TOKEN_CHARS = 4_096;
/** The most meanings a binding may map; the descriptor lists a handful at most. */
const MAX_BINDING_PROPERTIES = 32;

export class IssueTrackerConnections extends Context.Service<
  IssueTrackerConnections,
  {
    /** Every standalone tracker, each probed against its stored credential, and the bindings. */
    readonly list: Effect.Effect<IssueTrackerConnectionList, IssueTrackerConnectionError>;
    /**
     * Vets the credential with the tracker and stores it only when the tracker accepts it. A null
     * token removes the stored one and unbinds every project that pointed at the tracker.
     */
    readonly connect: (
      input: IssueTrackerConnectInput,
    ) => Effect.Effect<IssueTrackerConnection, IssueTrackerConnectionError>;
    /** Binds a project to one of a tracker's scopes, or unbinds it with a null binding. */
    readonly bindProject: (
      input: IssueTrackerBindProjectInput,
    ) => Effect.Effect<void, IssueTrackerConnectionError>;
    /** The properties a tracker's scope offers, for the binding's pickers. */
    readonly properties: (
      input: IssueTrackerPropertiesInput,
    ) => Effect.Effect<IssueTrackerPropertyList, IssueTrackerConnectionError>;
  }
>()("@houston-app/cli/issue/IssueTrackerConnections") {}

const make = Effect.gen(function* () {
  const registry = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  const secrets = yield* HoustonSecrets.HoustonSecrets;
  const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository;

  const requireTracker = (
    tracker: IssueTrackerKind,
  ): Effect.Effect<StandaloneIssueTrackerApi, IssueTrackerConnectionError> => {
    const found = registry.standalone.find((api) => api.kind === tracker);
    return found === undefined
      ? Effect.fail(
          new IssueTrackerConnectionError({
            tracker,
            reason: "unknown-tracker",
            detail: "This server has no such issue tracker.",
          }),
        )
      : Effect.succeed(found);
  };

  /** The kind an error about no tracker in particular is filed under. */
  const anyTracker = registry.standalone[0]?.kind ?? IssueTrackerKind.make("none");

  const secretFailure = (tracker: IssueTrackerKind, detail: string) => (cause: unknown) =>
    new IssueTrackerConnectionError({ tracker, reason: "failed", detail, cause });

  const disconnected = (api: StandaloneIssueTrackerApi): IssueTrackerConnection => ({
    ...api.standalone,
    connected: false,
    account: null,
    detail: null,
    scopes: [],
  });

  /** The tracker's view of a stored credential; a refusal is status, not a failure. */
  const status = (api: StandaloneIssueTrackerApi, token: string) =>
    api.probeCredential(token).pipe(
      Effect.map((probe): IssueTrackerConnection => ({
        ...api.standalone,
        connected: true,
        account: probe.account,
        detail: null,
        scopes: probe.scopes,
      })),
      Effect.catch((error) =>
        Effect.succeed<IssueTrackerConnection>({
          ...api.standalone,
          connected: true,
          account: null,
          detail: IssueService.trackerDetail(error),
          scopes: [],
        }),
      ),
    );

  const current = (api: StandaloneIssueTrackerApi) =>
    secrets.get(issueTrackerSecretName(api.kind)).pipe(
      Effect.mapError(secretFailure(api.kind, "The stored credential could not be read.")),
      Effect.flatMap((stored) =>
        Option.isNone(stored)
          ? Effect.succeed(disconnected(api))
          : status(api, Redacted.value(stored.value)),
      ),
    );

  const list: IssueTrackerConnections["Service"]["list"] = Effect.all({
    trackers: Effect.forEach(registry.standalone, current, { concurrency: 4 }),
    bindings: bindings.list.pipe(
      Effect.map((bound) => Object.fromEntries(bound)),
      // No single tracker is at fault; the first registered one carries the report.
      Effect.mapError(secretFailure(anyTracker, "The project bindings could not be read.")),
    ),
  });

  const disconnect = Effect.fn("IssueTrackerConnections.disconnect")(function* (
    api: StandaloneIssueTrackerApi,
  ) {
    yield* secrets
      .remove(issueTrackerSecretName(api.kind))
      .pipe(Effect.mapError(secretFailure(api.kind, "The credential could not be removed.")));
    // Bindings to a tracker nobody is signed into would only produce errors in every listing.
    yield* bindings
      .removeTracker(api.kind)
      .pipe(Effect.mapError(secretFailure(api.kind, "The project bindings could not be cleared.")));
    return disconnected(api);
  });

  const connect: IssueTrackerConnections["Service"]["connect"] = Effect.fn(
    "IssueTrackerConnections.connect",
  )(function* (input) {
    const api = yield* requireTracker(input.tracker);
    if (input.token === null) return yield* disconnect(api);
    if (input.token.length > MAX_TOKEN_CHARS) {
      return yield* new IssueTrackerConnectionError({
        tracker: input.tracker,
        reason: "rejected",
        detail: `The ${api.standalone.credential.label} is ${input.token.length} characters; it must be at most ${MAX_TOKEN_CHARS}.`,
      });
    }
    const probe = yield* api.probeCredential(input.token).pipe(
      Effect.mapError(
        (error) =>
          new IssueTrackerConnectionError({
            tracker: input.tracker,
            reason: error.reason === "unauthenticated" ? "rejected" : "failed",
            detail: IssueService.trackerDetail(error),
            cause: error,
          }),
      ),
    );
    yield* secrets
      .set(issueTrackerSecretName(api.kind), Redacted.make(input.token))
      .pipe(Effect.mapError(secretFailure(api.kind, "The credential could not be stored.")));
    return {
      ...api.standalone,
      connected: true,
      account: probe.account,
      detail: null,
      scopes: probe.scopes,
    };
  });

  const bindProject: IssueTrackerConnections["Service"]["bindProject"] = Effect.fn(
    "IssueTrackerConnections.bindProject",
  )(function* (input) {
    // Unbinding names no tracker; the first registered one carries any report.
    const tracker =
      input.binding === null ? anyTracker : (yield* requireTracker(input.binding.tracker)).kind;
    if (
      input.binding !== null &&
      Object.keys(input.binding.properties ?? {}).length > MAX_BINDING_PROPERTIES
    ) {
      return yield* new IssueTrackerConnectionError({
        tracker,
        reason: "rejected",
        detail: `The binding maps more than ${MAX_BINDING_PROPERTIES} properties.`,
      });
    }
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* bindings
      .set({ projectId: input.projectId, binding: input.binding, updatedAt })
      .pipe(Effect.mapError(secretFailure(tracker, "The project binding could not be saved.")));
  });

  const properties: IssueTrackerConnections["Service"]["properties"] = Effect.fn(
    "IssueTrackerConnections.properties",
  )(function* (input) {
    const api = yield* requireTracker(input.tracker);
    if (api.listProperties === undefined) {
      return yield* new IssueTrackerConnectionError({
        tracker: input.tracker,
        reason: "failed",
        detail: `${api.standalone.displayName} offers no properties to map.`,
      });
    }
    const listed = yield* api.listProperties(input.scope).pipe(
      Effect.mapError(
        (error) =>
          new IssueTrackerConnectionError({
            tracker: input.tracker,
            reason: error.reason === "unauthenticated" ? "rejected" : "failed",
            detail: IssueService.trackerDetail(error),
            cause: error,
          }),
      ),
    );
    return { properties: listed };
  });

  return IssueTrackerConnections.of({ list, connect, bindProject, properties });
});

export const layer = Layer.effect(IssueTrackerConnections, make);
