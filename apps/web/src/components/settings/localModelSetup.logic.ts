import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerProvider,
  type ServerSettings,
} from "@houston-app/contracts";
import {
  InferenceServerId,
  type InferenceApiProtocol,
  type InferenceDiscoveredServer,
  type InferenceServerConfig,
} from "@houston-app/contracts/houston/inference";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { inferenceServerIdFromName } from "./InferenceSettings.logic";

const decodeInstanceId = Schema.decodeOption(ProviderInstanceId);

/** Agents that reach a model server through Houston's gateway, best first, and the API each needs. */
const LOCAL_MODEL_AGENTS = [
  { driver: ProviderDriverKind.make("pi"), label: "Pi", protocol: "chat-completions" },
  { driver: ProviderDriverKind.make("opencode"), label: "OpenCode", protocol: "chat-completions" },
] as const satisfies ReadonlyArray<{
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly protocol: InferenceApiProtocol;
}>;

const PROTOCOL_LABELS: Partial<Record<InferenceApiProtocol, string>> = {
  "chat-completions": "OpenAI Chat Completions",
  responses: "OpenAI Responses",
};

export interface LocalModelAgentChoice {
  readonly driver: ProviderDriverKind;
  readonly label: string;
  /** Why it cannot use this server; absent when it can. */
  readonly unavailableReason?: string;
  /** Not set up on this machine yet, so whether it is installed shows once it is. */
  readonly unchecked: boolean;
  readonly recommended: boolean;
}

/**
 * Every agent in preference order. An agent with no instance yet has not been checked, so it is
 * offered rather than reported missing. The first installed one that speaks the server's API is
 * recommended.
 */
export function localModelAgentChoices(
  server: Pick<InferenceDiscoveredServer, "apiProtocols">,
  providers: ReadonlyArray<Pick<ServerProvider, "driver" | "installed" | "enabled">>,
  machineLabel: string,
): ReadonlyArray<LocalModelAgentChoice> {
  const choices = LOCAL_MODEL_AGENTS.map((agent) => {
    const checked = providers.filter(
      (provider) => provider.driver === agent.driver && provider.enabled,
    );
    const installed = checked.some((provider) => provider.installed);
    const unchecked = checked.length === 0;
    const unavailableReason =
      !installed && !unchecked
        ? `${agent.label} is not installed on ${machineLabel}.`
        : server.apiProtocols?.includes(agent.protocol) !== true
          ? `The server did not confirm the ${PROTOCOL_LABELS[agent.protocol]} API ${agent.label} needs.`
          : undefined;
    return {
      driver: agent.driver,
      label: agent.label,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      unchecked,
      installed,
    };
  });
  const usable = choices.filter((choice) => choice.unavailableReason === undefined);
  const recommended = usable.find((choice) => choice.installed) ?? usable[0];
  return choices.map(({ installed: _installed, ...choice }) => ({
    ...choice,
    recommended: choice.driver === recommended?.driver,
  }));
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function urlParts(baseUrl: string): { readonly host: string; readonly port: string } {
  try {
    const url = new URL(baseUrl);
    return { host: url.hostname, port: url.port || (url.protocol === "https:" ? "443" : "80") };
  } catch {
    return { host: baseUrl, port: "" };
  }
}

function firstFreeId<T>(
  candidates: ReadonlyArray<string>,
  taken: ReadonlySet<string>,
  decode: (raw: string) => T | null,
): T | null {
  for (const raw of candidates) {
    const id = decode(raw);
    if (id !== null && !taken.has(String(id))) return id;
  }
  for (let suffix = 2; suffix < 100; suffix++) {
    const id = decode(`${candidates[0]}-${suffix}`);
    if (id !== null && !taken.has(String(id))) return id;
  }
  return null;
}

const sameAddress = (left: string, right: string) =>
  left.trim().replace(/\/+$/, "") === right.trim().replace(/\/+$/, "");

export interface LocalModelSetupPlan {
  readonly serverId: InferenceServerId;
  readonly serverName: string;
  /** The entry to save; null when the registered one already fits. */
  readonly serverConfig: InferenceServerConfig | null;
  readonly instanceId: ProviderInstanceId;
  /** The instance to create or turn on; null when a linked one is ready to reuse. */
  readonly instanceMutation: ProviderInstanceMutation | null;
}

/**
 * What connecting writes. A server already registered at the address, and an instance of the
 * agent already linked to it, are reused rather than duplicated, so running it twice changes
 * nothing.
 */
export function planLocalModelSetup(input: {
  readonly settings: Pick<ServerSettings, "inferenceServers" | "providerInstances">;
  readonly server: Pick<InferenceDiscoveredServer, "baseUrl" | "registeredServerId">;
  readonly driver: ProviderDriverKind;
  readonly agentLabel: string;
  readonly machineLabel: string;
}): LocalModelSetupPlan | null {
  const { settings, server } = input;
  // A search run before an earlier attempt saved the server still names it by address.
  const registeredId =
    server.registeredServerId ??
    (Object.entries(settings.inferenceServers).find(([, config]) =>
      sameAddress(config.baseUrl, server.baseUrl),
    )?.[0] as InferenceServerId | undefined);
  const registered =
    registeredId === undefined ? undefined : settings.inferenceServers[registeredId];
  const { host, port } = urlParts(server.baseUrl);
  const name = LOOPBACK.has(host.toLowerCase()) ? input.machineLabel : host;

  let serverId: InferenceServerId;
  let serverConfig: InferenceServerConfig | null;
  let serverName: string;
  if (registeredId !== undefined && registered !== undefined) {
    serverId = registeredId;
    serverName = registered.displayName ?? serverId;
    serverConfig = registered.enabled ? null : { ...registered, enabled: true };
  } else {
    const id = firstFreeId(
      [name, `${name}-${port}`],
      new Set(Object.keys(settings.inferenceServers)),
      inferenceServerIdFromName,
    );
    if (id === null) return null;
    serverId = id;
    serverName = id === inferenceServerIdFromName(name) ? name : `${name} :${port}`;
    serverConfig = {
      displayName: serverName,
      baseUrl: server.baseUrl,
      enabled: true,
    };
  }

  const linked = Object.entries(settings.providerInstances).find(
    ([, instance]) => instance.driver === input.driver && instance.inferenceServerId === serverId,
  );
  if (linked !== undefined) {
    const [rawId, instance] = linked;
    const instanceId = ProviderInstanceId.make(rawId);
    return {
      serverId,
      serverName,
      serverConfig,
      instanceId,
      instanceMutation:
        instance.enabled === false || instance.inference !== "local"
          ? {
              operation: "upsert",
              instanceId,
              instance: { ...instance, inference: "local", enabled: true },
            }
          : null,
    };
  }
  const instanceId = firstFreeId(
    [`${input.driver}-${serverId}`],
    new Set(Object.keys(settings.providerInstances)),
    (raw) => Option.getOrNull(decodeInstanceId(raw)),
  );
  if (instanceId === null) return null;
  const instance: ProviderInstanceConfig = {
    driver: input.driver,
    displayName: `${input.agentLabel} · ${serverName}`,
    inference: "local",
    inferenceServerId: serverId,
    enabled: true,
  };
  return {
    serverId,
    serverName,
    serverConfig,
    instanceId,
    instanceMutation: { operation: "create", instanceId, instance },
  };
}

/**
 * The slug a linked agent lists for a server's model. Houston's gateway entry `houston-<server>/`
 * comes first: the agent's own config may list the same model under another prefix that bypasses
 * the gateway.
 */
export function linkedModelSlug(
  models: ReadonlyArray<Pick<ServerProvider["models"][number], "slug">>,
  serverId: InferenceServerId,
  modelId: string,
): string | undefined {
  return (
    models.find((model) => model.slug === `houston-${serverId}/${modelId}`)?.slug ??
    models.find((model) => model.slug === modelId)?.slug ??
    // Another server's gateway entry would send threads to the wrong machine.
    models.find((model) => !model.slug.startsWith("houston-") && model.slug.endsWith(`/${modelId}`))
      ?.slug
  );
}

/**
 * Where a registered server may have moved: other servers on its host that no other entry owns,
 * those serving a model it served first. One that wants a key still qualifies; its saved key goes
 * along when it moves.
 */
export function repairCandidates(
  servers: ReadonlyArray<InferenceDiscoveredServer>,
  id: InferenceServerId,
  baseUrl: string,
  knownModelIds: ReadonlySet<string>,
): ReadonlyArray<{ readonly server: InferenceDiscoveredServer; readonly sameModel: boolean }> {
  return servers
    .filter(
      (server) =>
        !sameAddress(server.baseUrl, baseUrl) &&
        (server.registeredServerId === undefined || server.registeredServerId === id),
    )
    .map((server) => ({
      server,
      sameModel: server.models.some((model) => knownModelIds.has(model.id)),
    }))
    .toSorted((left, right) => Number(right.sameModel) - Number(left.sameModel));
}

/** Models a server served, from its last good check and the selections that name it. */
export function knownServerModelIds(
  id: InferenceServerId,
  snapshotModels: ReadonlyArray<{ readonly id: string }>,
  selections: ReadonlyArray<{ readonly model: string } | null | undefined>,
): ReadonlySet<string> {
  const prefix = `houston-${id}/`;
  return new Set([
    ...snapshotModels.map((model) => model.id),
    ...selections.flatMap((selection) =>
      selection?.model.startsWith(prefix) ? [selection.model.slice(prefix.length)] : [],
    ),
  ]);
}
