import type {
  InferenceServerConfig,
  InferenceServerId,
  InferenceServerSnapshot,
} from "@houston-app/contracts/houston/inference";

export type InferenceServers = Readonly<Record<string, InferenceServerConfig>>;

export function inferenceServerDisplayName(
  id: string,
  config: Pick<InferenceServerConfig, "displayName"> | undefined,
): string {
  return config?.displayName?.trim() || id;
}

export interface InferenceServerOutage {
  readonly id: InferenceServerId;
  readonly name: string;
  readonly baseUrl: string;
  readonly message: string;
}

/**
 * The server a selected agent is linked to, while it is down. Its gateway models drop out of the
 * agent's list until it answers again; checking and turned-off servers are not an outage.
 */
export function inferenceServerOutage(input: {
  readonly serverId: string | undefined;
  readonly servers: InferenceServers;
  readonly snapshots: ReadonlyArray<InferenceServerSnapshot>;
}): InferenceServerOutage | null {
  if (input.serverId === undefined) return null;
  const config = input.servers[input.serverId];
  const snapshot = input.snapshots.find((candidate) => candidate.id === input.serverId);
  if (!config?.enabled || snapshot === undefined) return null;
  if (snapshot.status !== "unreachable" && snapshot.status !== "error") return null;
  return {
    id: input.serverId as InferenceServerId,
    name: inferenceServerDisplayName(input.serverId, config),
    baseUrl: config.baseUrl,
    message: snapshot.message ?? "It did not answer its last check.",
  };
}

export interface InferenceModelNotServed {
  readonly id: InferenceServerId;
  readonly name: string;
  readonly model: string;
  /** What the server serves now, to switch to. */
  readonly served: ReadonlyArray<string>;
}

/**
 * A model a linked agent was set to run that its server, checked and ready, no longer lists. A
 * server being checked or down says nothing about its models, so that is not reported here.
 * Gateway entries are `houston-<server>/<model>`; an agent that lists the model ids themselves is
 * also checked.
 */
export function inferenceModelNotServed(input: {
  readonly serverId: string | undefined;
  readonly driver: string | undefined;
  readonly modelSlug: string;
  readonly servers: InferenceServers;
  readonly snapshots: ReadonlyArray<InferenceServerSnapshot>;
}): InferenceModelNotServed | null {
  if (input.serverId === undefined) return null;
  const config = input.servers[input.serverId];
  const snapshot = input.snapshots.find((candidate) => candidate.id === input.serverId);
  if (!config?.enabled || snapshot?.status !== "ready" || snapshot.models.length === 0) return null;
  const prefix = `houston-${input.serverId}/`;
  const model = input.modelSlug.startsWith(prefix)
    ? input.modelSlug.slice(prefix.length)
    : input.driver === "codex"
      ? input.modelSlug
      : null;
  if (model === null || snapshot.models.some((served) => served.id === model)) return null;
  return {
    id: input.serverId as InferenceServerId,
    name: inferenceServerDisplayName(input.serverId, config),
    model,
    served: snapshot.models.map((served) => served.id),
  };
}
