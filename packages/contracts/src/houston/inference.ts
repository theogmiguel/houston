import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { SecretLiteral } from "../settingsSecretValue.ts";

const INFERENCE_SERVER_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** A user-registered model server (Ollama, LM Studio, llama.cpp, vLLM, SGLang) this environment can reach. */
export const InferenceServerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(INFERENCE_SERVER_ID_PATTERN),
).pipe(Schema.brand("InferenceServerId"));
export type InferenceServerId = typeof InferenceServerId.Type;

export const InferenceServerStatus = Schema.Literals(["checking", "ready", "unreachable", "error"]);
export type InferenceServerStatus = typeof InferenceServerStatus.Type;

/** Whether a model reads images, as its engine reports it. */
export const InferenceModelImageSupport = Schema.Struct({
  supported: Schema.Boolean,
  source: Schema.Literals(["reported"]),
});
export type InferenceModelImageSupport = typeof InferenceModelImageSupport.Type;

export const InferenceModelCapabilities = Schema.Struct({
  image: Schema.optional(InferenceModelImageSupport),
});
export type InferenceModelCapabilities = typeof InferenceModelCapabilities.Type;

export const InferenceServerModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The limit the server enforces for requests. */
  servedContextWindow: Schema.optional(NonNegativeInt),
  /** What the weights were trained for; informational only. */
  trainedContextWindow: Schema.optional(NonNegativeInt),
  maxOutputTokens: Schema.optional(NonNegativeInt),
  reasoningEfforts: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  capabilities: Schema.optional(InferenceModelCapabilities),
});
export type InferenceServerModel = typeof InferenceServerModel.Type;

export const InferenceServerLoad = Schema.Struct({
  running: NonNegativeInt,
  waiting: NonNegativeInt,
});
export type InferenceServerLoad = typeof InferenceServerLoad.Type;

/** The server's retained prompt states; omitted when it does not report a budget. */
export const InferenceServerPromptCache = Schema.Struct({
  budgetBytes: NonNegativeInt,
  retainedBytes: Schema.optional(NonNegativeInt),
  states: Schema.optional(NonNegativeInt),
  /** Prompt tokens restored from cache over the latest probe interval that saw requests. */
  recentCachedShare: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
  /** `saturated-falling`: full, and the cached share dropped since the interval before. */
  status: Schema.Literals(["none", "ok", "saturated-falling"]),
});
export type InferenceServerPromptCache = typeof InferenceServerPromptCache.Type;

/** Who asked: a user's turn, a scheduled task, or the environment's own background writing. */
export const InferenceRequestPurpose = Schema.Literals(["interactive", "scheduled", "background"]);
export type InferenceRequestPurpose = typeof InferenceRequestPurpose.Type;

/** Bounded request diagnosis; upstream messages and private request/response data are never stored. */
export const InferenceFailureCause = Schema.Literals([
  "unknown",
  "transport",
  "cancelled",
  "upstream-http",
  "context-overflow",
  "unsupported-field",
  "tool-format",
  "empty-completed",
  "watchdog-loop",
  "watchdog-reasoning-limit",
  "watchdog-idle",
]);
export type InferenceFailureCause = typeof InferenceFailureCause.Type;

/** Requests the gateway is holding or running against this server; other clients are not counted. */
export const InferenceGatewayQueue = Schema.Struct({
  capacity: NonNegativeInt,
  active: Schema.Array(
    Schema.Struct({ threadId: Schema.optional(ThreadId), purpose: InferenceRequestPurpose }),
  ),
  waiting: Schema.Array(
    Schema.Struct({
      threadId: Schema.optional(ThreadId),
      purpose: InferenceRequestPurpose,
      position: NonNegativeInt,
    }),
  ),
});
export type InferenceGatewayQueue = typeof InferenceGatewayQueue.Type;

/** Why the gateway stopped a reply: it repeated itself, only reasoned, or went quiet. */
export const InferenceStopReason = Schema.Literals(["loop", "reasoning-limit", "idle"]);
export type InferenceStopReason = typeof InferenceStopReason.Type;

/** The latest reply the gateway stopped in a thread. */
export const InferenceThreadStop = Schema.Struct({
  serverId: InferenceServerId,
  model: TrimmedNonEmptyString,
  reason: InferenceStopReason,
  at: IsoDateTime,
});
export type InferenceThreadStop = typeof InferenceThreadStop.Type;

const Distribution = Schema.Struct({
  n: NonNegativeInt,
  p50: Schema.NullOr(Schema.Number),
  p95: Schema.NullOr(Schema.Number),
});

export const InferenceUsageWindow = Schema.Literals(["24h", "7d"]);
export type InferenceUsageWindow = typeof InferenceUsageWindow.Type;

/** Measured by the gateway; requests that bypass it are not included. Missing measurements leave n. */
export const InferenceUsageRow = Schema.Struct({
  serverId: InferenceServerId,
  model: TrimmedNonEmptyString,
  purpose: InferenceRequestPurpose,
  requests: NonNegativeInt,
  failed: NonNegativeInt,
  promptTokens: NonNegativeInt,
  cachedPromptTokens: NonNegativeInt,
  /** Prompt tokens of the requests whose server reported cache usage; the cached-share denominator. */
  promptTokensWithCacheData: Schema.optional(NonNegativeInt),
  completionTokens: NonNegativeInt,
  /** The window's most recent failed or rejected request. */
  lastFailure: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["failed", "rejected"]),
      at: IsoDateTime,
      cause: Schema.optional(InferenceFailureCause),
      httpStatus: Schema.optional(NonNegativeInt),
      advice: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  queueWaitMs: Distribution,
  ttftMs: Distribution,
  decodeTokensPerSecond: Distribution,
});
export type InferenceUsageRow = typeof InferenceUsageRow.Type;

export const InferenceUsageSummary = Schema.Struct({
  window: InferenceUsageWindow,
  generatedAt: IsoDateTime,
  rows: Schema.Array(InferenceUsageRow),
});
export type InferenceUsageSummary = typeof InferenceUsageSummary.Type;

/** The latest gateway request a thread made, for its prompt budget. */
export const InferenceThreadLastRequest = Schema.Struct({
  serverId: InferenceServerId,
  model: TrimmedNonEmptyString,
  completedAt: IsoDateTime,
  promptTokens: Schema.NullOr(NonNegativeInt),
  cachedPromptTokens: Schema.NullOr(NonNegativeInt),
  completionTokens: Schema.NullOr(NonNegativeInt),
  queueWaitMs: Schema.NullOr(NonNegativeInt),
  ttftMs: Schema.NullOr(NonNegativeInt),
  decodeTokensPerSecond: Schema.NullOr(Schema.Number),
  /** Set when the request went to a fallback because this server could not take it. */
  fallbackFrom: Schema.optional(InferenceServerId),
  /** Compared with the thread's previous request; absent when there is none or unmeasured. */
  staticPrefixChanged: Schema.optional(Schema.Boolean),
  serverChanged: Schema.optional(Schema.Boolean),
});
export type InferenceThreadLastRequest = typeof InferenceThreadLastRequest.Type;

/** Request protocols a server serves under its base URL. */
export const InferenceApiProtocol = Schema.Literals([
  "chat-completions",
  "completions",
  "responses",
  "messages",
]);
export type InferenceApiProtocol = typeof InferenceApiProtocol.Type;

/** What Settings stores for one server. The API key lives in the server's secret store, never here. */
export const InferenceServerConfig = Schema.Struct({
  displayName: Schema.optional(TrimmedNonEmptyString),
  /** OpenAI-compatible root such as http://localhost:8080/v1; credentials belong in the API key. */
  baseUrl: TrimmedNonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  maxConcurrentRequests: Schema.optional(PositiveInt),
  /**
   * Serves this server's requests while it is down or unreachable, if it serves the same model
   * and protocol; never for overflow.
   */
  fallbackServerId: Schema.optional(InferenceServerId),
  /** The gateway stops a reply that loops, only reasons, or goes silent; on unless turned off. */
  watchdog: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
});
export type InferenceServerConfig = typeof InferenceServerConfig.Type;

/** The newest gateway request a server failed or refused, for its row in Settings. */
export const InferenceServerRecentFailure = Schema.Struct({
  at: IsoDateTime,
  status: Schema.Literals(["failed", "rejected"]),
  cause: Schema.optional(InferenceFailureCause),
  advice: Schema.optional(TrimmedNonEmptyString),
  httpStatus: Schema.optional(NonNegativeInt),
});
export type InferenceServerRecentFailure = typeof InferenceServerRecentFailure.Type;

export const InferenceServerSnapshot = Schema.Struct({
  id: InferenceServerId,
  displayName: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  status: InferenceServerStatus,
  checkedAt: Schema.NullOr(IsoDateTime),
  message: Schema.optional(TrimmedNonEmptyString),
  engine: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(InferenceServerModel),
  load: Schema.optional(InferenceServerLoad),
  maxConcurrentRequests: Schema.optional(NonNegativeInt),
  /** The saved server that serves this one's requests while it is down. */
  fallbackServerId: Schema.optional(InferenceServerId),
  apiProtocols: Schema.optional(Schema.Array(InferenceApiProtocol)),
  /** Whether a saved API key is stored for this server; the key itself never leaves the server. */
  hasApiKey: Schema.optionalKey(Schema.Boolean),
  gatewayQueue: Schema.optional(InferenceGatewayQueue),
  promptCache: Schema.optional(InferenceServerPromptCache),
  recentFailure: Schema.optional(InferenceServerRecentFailure),
});
export type InferenceServerSnapshot = typeof InferenceServerSnapshot.Type;

export const InferenceServersResult = Schema.Struct({
  servers: Schema.Array(InferenceServerSnapshot),
});
export type InferenceServersResult = typeof InferenceServersResult.Type;

/** A model server found on demand; nothing is saved until the user picks it. */
export const InferenceDiscoveredServer = Schema.Struct({
  baseUrl: TrimmedNonEmptyString,
  /** `needs-key`: it answered but wants an API key before listing models. */
  status: Schema.Literals(["ready", "needs-key"]),
  engine: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(InferenceServerModel),
  apiProtocols: Schema.optional(Schema.Array(InferenceApiProtocol)),
  /** The registered server already at this address. */
  registeredServerId: Schema.optional(InferenceServerId),
});
export type InferenceDiscoveredServer = typeof InferenceDiscoveredServer.Type;

export const InferenceDiscoveryInput = Schema.Struct({
  /** Search only this host. */
  host: Schema.optional(TrimmedNonEmptyString),
  /** An address the user typed, checked as well. */
  baseUrl: Schema.optional(TrimmedNonEmptyString),
});
export type InferenceDiscoveryInput = typeof InferenceDiscoveryInput.Type;

export const InferenceDiscoveryResult = Schema.Struct({
  servers: Schema.Array(InferenceDiscoveredServer),
  /** Whether the environment's own listening ports were searched, not just well-known ones. */
  searchedListeningPorts: Schema.Boolean,
});
export type InferenceDiscoveryResult = typeof InferenceDiscoveryResult.Type;

export const InferenceServerSaveInput = Schema.Struct({
  id: InferenceServerId,
  displayName: Schema.optional(TrimmedNonEmptyString),
  baseUrl: TrimmedNonEmptyString,
  /** Omitted keeps the saved key; an empty string clears it. */
  apiKey: Schema.optional(SecretLiteral),
  enabled: Schema.optional(Schema.Boolean),
  maxConcurrentRequests: Schema.optional(PositiveInt),
  /** Omitted keeps the saved fallback; null clears it. */
  fallbackServerId: Schema.optionalKey(Schema.NullOr(InferenceServerId)),
  watchdog: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
});
export type InferenceServerSaveInput = typeof InferenceServerSaveInput.Type;

export const InferenceServerRemoveInput = Schema.Struct({
  id: InferenceServerId,
});
export type InferenceServerRemoveInput = typeof InferenceServerRemoveInput.Type;

export const InferenceServerRefreshInput = Schema.Struct({
  id: Schema.optional(InferenceServerId),
});
export type InferenceServerRefreshInput = typeof InferenceServerRefreshInput.Type;

export const InferenceUsageInput = Schema.Struct({
  window: InferenceUsageWindow,
});
export type InferenceUsageInput = typeof InferenceUsageInput.Type;

export const InferenceThreadRequestInput = Schema.Struct({
  threadId: ThreadId,
});
export type InferenceThreadRequestInput = typeof InferenceThreadRequestInput.Type;

export const InferenceThreadStopInput = Schema.Struct({
  threadId: ThreadId,
});
export type InferenceThreadStopInput = typeof InferenceThreadStopInput.Type;

export const HoustonInferenceErrorKind = Schema.Literals([
  "invalid",
  "settings",
  "secret_store_unavailable",
]);

/** A refusal. It never carries the API key. */
export class HoustonInferenceError extends Schema.TaggedError<HoustonInferenceError>()(
  "HoustonInferenceError",
  {
    kind: HoustonInferenceErrorKind,
    message: Schema.String,
    operation: Schema.String,
  },
) {}
