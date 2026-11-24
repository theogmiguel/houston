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

interface LinkedModelInput {
  readonly serverId: string | undefined;
  readonly driver: string | undefined;
  readonly modelSlug: string;
  readonly servers: InferenceServers;
  readonly snapshots: ReadonlyArray<InferenceServerSnapshot>;
}

/** The selected model on a linked server that is enabled, checked and ready. */
function linkedServerModel(input: LinkedModelInput) {
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
  if (model === null) return null;
  return {
    id: input.serverId as InferenceServerId,
    name: inferenceServerDisplayName(input.serverId, config),
    model,
    snapshot,
    served: snapshot.models.find((served) => served.id === model),
  };
}

/**
 * A model a linked agent was set to run that its server, checked and ready, no longer lists. A
 * server being checked or down says nothing about its models, so that is not reported here.
 * Gateway entries are `houston-<server>/<model>`; an agent that lists the model ids themselves is
 * also checked.
 */
export function inferenceModelNotServed(input: LinkedModelInput): InferenceModelNotServed | null {
  const linked = linkedServerModel(input);
  if (linked === null || linked.served !== undefined) return null;
  return {
    id: linked.id,
    name: linked.name,
    model: linked.model,
    served: linked.snapshot.models.map((served) => served.id),
  };
}

export interface InferenceModelImageGap {
  readonly id: InferenceServerId;
  readonly name: string;
  readonly model: string;
  /** `text-only`: its engine or Houston's check says so; `unchecked`: nobody knows yet. */
  readonly reason: "text-only" | "unchecked";
}

/** Why an image attached for the selected linked model would not reach it; null when it would. */
export function inferenceModelImageGap(input: LinkedModelInput): InferenceModelImageGap | null {
  const linked = linkedServerModel(input);
  if (linked?.served === undefined) return null;
  const image = linked.served.capabilities?.image;
  if (image?.supported === true) return null;
  return {
    id: linked.id,
    name: linked.name,
    model: linked.model,
    reason: image === undefined ? "unchecked" : "text-only",
  };
}
