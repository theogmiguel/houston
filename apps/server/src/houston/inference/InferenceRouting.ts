import type { ServerSettings, ThreadId } from "@houston-app/contracts";
import type {
  InferenceApiProtocol,
  InferenceServerConfig,
  InferenceServerId,
} from "@houston-app/contracts/houston/inference";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Settings from "../../serverSettings.ts";
import * as HoustonSecrets from "../secrets/HoustonSecrets.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

const MAX_RESPONSE_AFFINITIES = 4_096;

// Connection-phase failures: the request never left this machine, so another server may take it.
const PRE_DISPATCH_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** True only when the cause chain shows the connection itself failed, before any request bytes. */
export function isPreDispatchFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string" && PRE_DISPATCH_CODES.has(code)) return true;
    const next = current as { readonly cause?: unknown; readonly reason?: unknown };
    current = next.reason ?? next.cause;
  }
  return false;
}

export class InferenceRoutingError extends Schema.TaggedError<InferenceRoutingError>()(
  "InferenceRoutingError",
  {
    reason: Schema.Literals(["not_registered", "affinity_unavailable", "secret_unreadable"]),
    message: Schema.String,
  },
) {}

export interface RouteTarget {
  readonly serverId: InferenceServerId;
  readonly base: string;
  readonly apiKey: string;
  /** Per the registry; a target that is not ready is skipped when another follows it. */
  readonly ready: boolean;
  /** The credential's server, when this target is another one. */
  readonly fallbackFrom: InferenceServerId | null;
}

export interface RouteRequest {
  /** The server the credential is for. */
  readonly primary: InferenceServerId;
  /** The primary's settings when the credential was issued, used instead of its current ones. */
  readonly pinned: InferenceServerConfig;
  readonly threadId?: ThreadId | undefined;
  readonly protocol: InferenceApiProtocol;
  readonly model: string;
  readonly previousResponseId?: string | undefined;
  /** Estimated prompt plus reserved output, for the fallback's context window. */
  readonly contextTokens: number;
}

export class InferenceRouting extends Context.Service<
  InferenceRouting,
  {
    /** Servers to try in order; later ones only take requests that never reached earlier ones. */
    readonly plan: (
      request: RouteRequest,
    ) => Effect.Effect<ReadonlyArray<RouteTarget>, InferenceRoutingError>;
    readonly rememberResponse: (
      responseId: string,
      serverId: InferenceServerId,
    ) => Effect.Effect<void>;
  }
>()("@houston-app/cli/houston/inference/InferenceRouting") {}

/** Insertion-ordered, so re-inserting refreshes an entry and the first key is the oldest. */
const bounded = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V, limit: number) => {
  const next = new Map(map);
  next.delete(key);
  next.set(key, value);
  while (next.size > limit) next.delete(next.keys().next().value!);
  return next;
};

const parseEndpoint = (baseUrl: string) => {
  const endpoint = InferenceServerRegistry.parseBaseUrl(baseUrl);
  return "error" in endpoint ? undefined : endpoint.base;
};

const make = Effect.gen(function* () {
  const settingsService = yield* Settings.ServerSettingsService;
  const registry = yield* InferenceServerRegistry.InferenceServerRegistry;
  const secrets = yield* HoustonSecrets.HoustonSecrets;
  const responses = yield* Ref.make(new Map<string, InferenceServerId>());

  const readApiKey = Effect.fnUntraced(function* (serverId: InferenceServerId) {
    const read = yield* secrets
      .get(InferenceServerRegistry.inferenceApiKeySecretName(serverId))
      .pipe(
        Effect.mapError(
          () =>
            new InferenceRoutingError({
              reason: "secret_unreadable",
              message: "Could not read the server's API key.",
            }),
        ),
      );
    return Option.match(read, {
      onNone: () => "",
      onSome: (value) => Redacted.value(value).trim(),
    });
  });

  const plan = Effect.fn("InferenceRouting.plan")(function* (request: RouteRequest) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.map((current) => current.inferenceServers),
      Effect.orElseSucceed((): ServerSettings["inferenceServers"] => ({})),
    );
    const snapshots = yield* registry.current;
    const snapshotOf = (id: InferenceServerId) =>
      snapshots.find((candidate) => candidate.id === id);
    const ready = (id: InferenceServerId) => snapshotOf(id)?.status === "ready";

    const live = settings[request.primary];
    // The registry probes the current settings, which say nothing about a moved or disabled pin.
    const pinnedProbed =
      live?.enabled === true && InferenceServerRegistry.routesAlike(request.pinned, live);
    const target = Effect.fnUntraced(function* (serverId: InferenceServerId) {
      const isPrimary = serverId === request.primary;
      const config = isPrimary ? request.pinned : settings[serverId];
      const endpoint =
        config !== undefined && (isPrimary || config.enabled)
          ? parseEndpoint(config.baseUrl)
          : undefined;
      if (config === undefined || endpoint === undefined) return Option.none<RouteTarget>();
      const apiKey = yield* readApiKey(serverId);
      return Option.some<RouteTarget>({
        serverId,
        base: endpoint,
        apiKey,
        ready: isPrimary && !pinnedProbed ? true : ready(serverId),
        fallbackFrom: isPrimary ? null : request.primary,
      });
    });

    const primary = yield* target(request.primary);
    if (Option.isNone(primary)) {
      return yield* new InferenceRoutingError({
        reason: "not_registered",
        message: "This inference server is off or not registered.",
      });
    }
    const fallbackId = request.pinned.fallbackServerId;
    const allowed = (id: InferenceServerId | undefined) =>
      id === request.primary || (id !== undefined && id === fallbackId);

    if (request.previousResponseId !== undefined) {
      const issuer = (yield* Ref.get(responses)).get(request.previousResponseId);
      // An id this gateway did not see stays on the credential's server, never a fallback.
      if (!allowed(issuer)) return [primary.value];
      const pinned = yield* target(issuer!);
      if (Option.isNone(pinned) || !pinned.value.ready) {
        return yield* new InferenceRoutingError({
          reason: "affinity_unavailable",
          message: `The previous response lives on inference server "${issuer}", which is not available; it cannot continue on another server.`,
        });
      }
      return [pinned.value];
    }

    const fallbackModel =
      fallbackId === undefined
        ? undefined
        : snapshotOf(fallbackId)?.models.find((model) => model.id === request.model);
    const fallback =
      fallbackId !== undefined &&
      fallbackId !== request.primary &&
      ready(fallbackId) &&
      fallbackModel !== undefined &&
      snapshotOf(fallbackId)?.apiProtocols?.includes(request.protocol) === true &&
      (fallbackModel.servedContextWindow === undefined ||
        fallbackModel.servedContextWindow >= request.contextTokens)
        ? Option.getOrUndefined(yield* target(fallbackId))
        : undefined;
    // A ready primary always goes first: the fallback only covers it being down.
    return fallback === undefined ? [primary.value] : [primary.value, fallback];
  });

  const rememberResponse = Effect.fn("InferenceRouting.rememberResponse")(function* (
    responseId: string,
    serverId: InferenceServerId,
  ) {
    yield* Ref.update(responses, (all) =>
      bounded(all, responseId, serverId, MAX_RESPONSE_AFFINITIES),
    );
  });

  return InferenceRouting.of({ plan, rememberResponse });
});

export const layer = Layer.effect(InferenceRouting, make);
