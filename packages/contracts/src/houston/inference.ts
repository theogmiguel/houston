import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
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
});
export type InferenceServerConfig = typeof InferenceServerConfig.Type;

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
  apiProtocols: Schema.optional(Schema.Array(InferenceApiProtocol)),
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
