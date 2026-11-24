import type { ProviderInstanceId, ServerSettings } from "@houston-app/contracts";
import type {
  InferenceApiProtocol,
  InferenceServerId,
  InferenceServerSnapshot,
} from "@houston-app/contracts/houston/inference";
import * as InferenceGateway from "@houston-app/provider-core/server/inferenceGateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../../serverSettings.ts";
import * as InferenceGatewayCredentials from "./InferenceGatewayCredentials.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

const PROTOCOL_NAMES: Record<InferenceApiProtocol, string> = {
  "chat-completions": "OpenAI Chat Completions",
  completions: "OpenAI Completions",
  responses: "OpenAI Responses",
  messages: "Anthropic Messages",
};

/** Undefined when nothing is linked; otherwise whether the gateway can carry the protocol. */
function resolveManagedServer(
  settings: ServerSettings,
  snapshots: ReadonlyArray<InferenceServerSnapshot>,
  serverId: InferenceServerId | undefined,
  protocol: InferenceApiProtocol,
): InferenceGateway.ManagedServerResolution | undefined {
  if (serverId === undefined) return undefined;
  const snapshot = snapshots.find((candidate) => candidate.id === serverId);
  const name = snapshot?.displayName ?? serverId;
  // Only turning the server off makes the instance cloud again; a removed one still waits.
  const unmanaged = (reason: string) => ({ managed: false, reason, local: true }) as const;
  const config = settings.inferenceServers[serverId];
  if (config === undefined) return unmanaged(`Inference server ${name} is no longer registered.`);
  if (!config.enabled) {
    return { managed: false, reason: `Inference server ${name} is disabled.` } as const;
  }
  if (snapshot?.status !== "ready") return unmanaged(`Inference server ${name} is not ready.`);
  if (snapshot.apiProtocols?.includes(protocol) !== true) {
    return unmanaged(
      `Inference server ${name} does not serve the ${PROTOCOL_NAMES[protocol]} API ${
        protocol === "messages" ? "Claude needs" : "this provider needs"
      }.`,
    );
  }
  if (snapshot.models.length === 0) return unmanaged(`Inference server ${name} lists no models.`);
  return {
    managed: true,
    server: {
      serverId,
      displayName: snapshot.displayName,
      models: snapshot.models.map((model) => ({
        id: model.id,
        ...(model.servedContextWindow === undefined
          ? {}
          : { contextWindow: model.servedContextWindow }),
        ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
        ...(model.reasoningEfforts === undefined
          ? {}
          : { reasoningEfforts: model.reasoningEfforts }),
        ...(model.capabilities?.image === undefined
          ? {}
          : { images: model.capabilities.image.supported }),
      })),
    },
  };
}

const make = Effect.gen(function* () {
  const settingsService = yield* Settings.ServerSettingsService;
  const registry = yield* InferenceServerRegistry.InferenceServerRegistry;
  const credentials = yield* InferenceGatewayCredentials.InferenceGatewayCredentials;

  // Traced by the named callers below.
  const resolveWithSettings = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
    protocol: InferenceApiProtocol,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    if (settings._tag === "None") return undefined;
    const resolution = resolveManagedServer(
      settings.value,
      yield* registry.current,
      settings.value.providerInstances[instanceId]?.inferenceServerId,
      protocol,
    );
    return resolution === undefined ? undefined : { resolution, settings: settings.value };
  });
  const resolve = Effect.fn("InferenceGatewayAccess.resolve")(function* (
    instanceId: ProviderInstanceId,
    protocol: InferenceApiProtocol,
  ) {
    return (yield* resolveWithSettings(instanceId, protocol))?.resolution;
  });
  const managedServer = (instanceId: ProviderInstanceId, protocol: InferenceApiProtocol) =>
    resolve(instanceId, protocol).pipe(
      Effect.map((resolution) => (resolution?.managed === true ? resolution.server : undefined)),
    );
  // Traced by the two named callers below.
  const credentialFor = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
    protocol: InferenceApiProtocol,
    holder: ProviderInstanceId | undefined,
  ) {
    const resolved = yield* resolveWithSettings(instanceId, protocol);
    if (resolved?.resolution.managed !== true) return undefined;
    const { server } = resolved.resolution;
    const id = server.serverId as InferenceServerId;
    const config = resolved.settings.inferenceServers[id];
    if (config === undefined) return undefined;
    const credential = yield* credentials.issueBackground({
      serverId: id,
      pinned: config,
      ...(holder === undefined ? {} : { providerInstanceId: holder }),
    });
    return { server, credential };
  });

  return InferenceGateway.InferenceGatewayAccess.of({
    resolve,
    managedServer,
    backgroundCredential: Effect.fn("InferenceGatewayAccess.backgroundCredential")(
      function* (instanceId, protocol) {
        return yield* credentialFor(instanceId, protocol, undefined);
      },
    ),
    instanceCredential: Effect.fn("InferenceGatewayAccess.instanceCredential")(
      function* (instanceId, protocol) {
        return yield* credentialFor(instanceId, protocol, instanceId);
      },
    ),
    attributeSessions: credentials.attributeSessions,
  });
});

const HARNESS_PROTOCOLS: ReadonlyArray<InferenceApiProtocol> = [
  "chat-completions",
  "responses",
  "messages",
];

export const layer = Layer.effect(InferenceGateway.InferenceGatewayAccess, make);

/**
 * Harnesses list a managed server's models only after discovery runs with its gateway, so a linked
 * instance re-discovers when what its server offers through the gateway changes.
 */
export const layerRefreshLinkedInstances = Layer.effectDiscard(
  Effect.gen(function* () {
    const settingsService = yield* Settings.ServerSettingsService;
    const registry = yield* InferenceServerRegistry.InferenceServerRegistry;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    let previous = new Map<string, string>();
    yield* registry.streamChanges.pipe(
      Stream.mapEffect((snapshots) =>
        settingsService.getSettings.pipe(
          Effect.map((settings) => {
            const offers = new Map(
              snapshots.map((snapshot) => [
                snapshot.id as string,
                JSON.stringify(
                  HARNESS_PROTOCOLS.map((protocol) =>
                    resolveManagedServer(settings, snapshots, snapshot.id, protocol),
                  ),
                ),
              ]),
            );
            const changed = new Set(
              [...offers.keys(), ...previous.keys()].filter(
                (id) => (offers.get(id) ?? "null") !== (previous.get(id) ?? "null"),
              ),
            );
            previous = offers;
            return Object.entries(settings.providerInstances).flatMap(([instanceId, config]) =>
              config.inferenceServerId !== undefined && changed.has(config.inferenceServerId)
                ? [instanceId as ProviderInstanceId]
                : [],
            );
          }),
          Effect.orElseSucceed((): ReadonlyArray<ProviderInstanceId> => []),
        ),
      ),
      Stream.runForEach((linked) =>
        Effect.forEach(
          linked,
          (instanceId) =>
            instances.getInstance(instanceId).pipe(
              Effect.flatMap((instance) =>
                instance === undefined ? Effect.void : instance.snapshot.refresh,
              ),
              Effect.ignoreCause({ log: true }),
            ),
          { discard: true },
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
