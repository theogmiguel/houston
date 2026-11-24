import type { RunId, ThreadId } from "@houston-app/contracts";
import {
  type InferenceApiProtocol,
  type InferenceRequestPurpose,
  InferenceServerId,
} from "@houston-app/contracts/houston/inference";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as HoustonSecrets from "../secrets/HoustonSecrets.ts";
import * as InferenceAdmission from "./InferenceAdmission.ts";
import * as InferenceDiagnostics from "./InferenceDiagnostics.ts";
import * as InferenceGatewayCredentials from "./InferenceGatewayCredentials.ts";
import * as InferenceRouting from "./InferenceRouting.ts";
import * as InferenceStops from "./InferenceStops.ts";
import {
  FIRST_CONTENT_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  makeInferenceWatchdog,
  type WatchdogReason,
} from "./InferenceWatchdog.ts";
import { recoverField } from "./InferenceRetry.ts";
import { isPreDispatchFailure } from "./InferenceRouting.ts";
import * as InferenceRequests from "./InferenceRequests.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";
import { makeUsageMeter } from "./inferenceUsage.ts";
import { flattenNamespaceTools, makeResponseRestorer } from "./responsesNamespaceTools.ts";

const INFERENCE_ROUTE_PREFIX = "/inference";

const GENERATION_PATHS: Readonly<Record<string, InferenceApiProtocol>> = {
  "chat/completions": "chat-completions",
  completions: "completions",
  responses: "responses",
  messages: "messages",
};

/** Prompts with inline images can be large; anything past this is refused before buffering more. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

// Only what the protocols need crosses; cookies, client credentials and proxy headers never do.
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
];
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
]);

const errorResponse = (status: number, type: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: { type, message } },
    { status, headers: { "cache-control": "no-store" } },
  );

const presentedToken = (request: HttpServerRequest.HttpServerRequest): string => {
  const authorization = request.headers.authorization;
  if (authorization !== undefined && /^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, "").trim();
  }
  return request.headers["x-api-key"]?.trim() ?? "";
};

const readBounded = (request: HttpServerRequest.HttpServerRequest) =>
  Stream.runFoldEffect(
    request.stream,
    () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
    (state, chunk) =>
      state.size + chunk.length > MAX_REQUEST_BYTES
        ? Effect.fail("too_large" as const)
        : Effect.succeed({ chunks: [...state.chunks, chunk], size: state.size + chunk.length }),
  ).pipe(Effect.map(({ chunks }) => Buffer.concat(chunks)));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Sorted keys, so equal content always serializes to equal bytes. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .toSorted()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** The part of a request a server can cache across turns: system text and tools. */
function staticPrefixOf(protocol: InferenceApiProtocol, body: Record<string, unknown>) {
  switch (protocol) {
    case "chat-completions": {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const end = messages.findIndex(
        (message) =>
          !isRecord(message) || (message.role !== "system" && message.role !== "developer"),
      );
      return { system: end === -1 ? messages : messages.slice(0, end), tools: body.tools ?? null };
    }
    case "responses":
      return { instructions: body.instructions ?? null, tools: body.tools ?? null };
    case "messages":
      return { system: body.system ?? null, tools: body.tools ?? null };
    case "completions":
      return undefined;
  }
}

/** The canonical static prefix the gateway hashes for prompt cache health, for one request body. */
export const inferenceStaticPrefix = (
  protocol: InferenceApiProtocol,
  body: Record<string, unknown>,
) => {
  const prefix = staticPrefixOf(protocol, body);
  return prefix === undefined ? undefined : canonicalJson(prefix);
};

const tokenCount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Model and stream flag for accounting, plus the body to send: OpenAI streams ask for usage. */
function prepareBody(protocol: InferenceApiProtocol, raw: Uint8Array) {
  // A cheap upper bound: about four bytes per token.
  const promptEstimate = Math.ceil(raw.length / 4);
  const unparsed = {
    model: "unknown",
    streaming: false,
    body: raw,
    staticPrefix: undefined,
    previousResponseId: undefined,
    contextTokens: promptEstimate,
    namespaces: undefined,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return unparsed;
  }
  if (!isRecord(parsed)) return unparsed;
  const model =
    typeof parsed.model === "string" && parsed.model.trim() !== ""
      ? parsed.model.trim()
      : "unknown";
  const streaming = parsed.stream === true;
  const prefix = staticPrefixOf(protocol, parsed);
  const shape = {
    model,
    streaming,
    staticPrefix: prefix === undefined ? undefined : canonicalJson(prefix),
    previousResponseId:
      protocol === "responses" && typeof parsed.previous_response_id === "string"
        ? parsed.previous_response_id
        : undefined,
    contextTokens:
      promptEstimate +
      Math.max(
        tokenCount(parsed.max_tokens),
        tokenCount(parsed.max_completion_tokens),
        tokenCount(parsed.max_output_tokens),
      ),
    namespaces: undefined,
  };
  if (protocol === "responses") {
    const flat = flattenNamespaceTools(parsed);
    if (flat !== undefined) {
      const body = new TextEncoder().encode(JSON.stringify(flat.body));
      return { ...shape, body, namespaces: flat.names };
    }
  }
  const options = parsed.stream_options;
  if (
    streaming &&
    (protocol === "chat-completions" || protocol === "completions") &&
    (options === undefined || (isRecord(options) && options.include_usage === undefined))
  ) {
    const body = {
      ...parsed,
      stream_options: { ...(isRecord(options) ? options : {}), include_usage: true },
    };
    return { ...shape, body: new TextEncoder().encode(JSON.stringify(body)) };
  }
  return { ...shape, body: raw };
}

const STOP_MESSAGES: Record<WatchdogReason, string> = {
  loop: "Houston stopped this reply: the model kept repeating the same text.",
  "reasoning-limit": "Houston stopped this reply: the model reasoned at length without answering.",
  idle: "Houston stopped this reply: the model server stopped sending anything.",
};

/** The protocol's own error event, so the harness ends the turn instead of taking it as done. */
function stopNotice(protocol: InferenceApiProtocol, reason: WatchdogReason): Uint8Array {
  const message = STOP_MESSAGES[reason];
  const event =
    protocol === "responses"
      ? `event: error\ndata: ${JSON.stringify({ type: "error", code: `houston_watchdog_${reason}`, message })}\n\n`
      : protocol === "messages"
        ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`
        : `data: ${JSON.stringify({ error: { message, type: "houston_watchdog", code: reason } })}\n\n`;
  return new TextEncoder().encode(event);
}

export class InferenceGateway extends Context.Service<
  InferenceGateway,
  {
    /** The scope is the request's: it closes once the response is written or abandoned. */
    readonly handle: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope>;
  }
>()("@houston-app/cli/houston/inference/InferenceGateway") {}

const make = Effect.gen(function* () {
  const credentials = yield* InferenceGatewayCredentials.InferenceGatewayCredentials;
  const secrets = yield* HoustonSecrets.HoustonSecrets;
  const admission = yield* InferenceAdmission.InferenceAdmission;
  const requestLog = yield* InferenceRequests.InferenceRequestLog;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  // Keep upstream affinity private and separate from another environment's thread/run IDs.
  const affinityNamespace = yield* random.uuidV4();
  const routing = yield* InferenceRouting.InferenceRouting;
  const registry = yield* InferenceServerRegistry.InferenceServerRegistry;
  const stops = yield* InferenceStops.InferenceStops;
  const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
  // Redirects are refused, not followed, so the upstream key never reaches another origin.
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  );

  const readApiKey = Effect.fnUntraced(function* (serverId: InferenceServerId) {
    const read = yield* secrets
      .get(InferenceServerRegistry.inferenceApiKeySecretName(serverId))
      .pipe(
        Effect.map((value) => Option.map(value, (key) => Redacted.value(key).trim())),
        Effect.option,
      );
    return read._tag === "Some" ? read.value : Option.none<string>();
  });

  /**
   * Server-side only: a run started by a scheduled task is scheduled, any other run interactive.
   * A delegated child thread also names the parent run that spawned it.
   */
  const attribute = Effect.fn("InferenceGateway.attribute")(function* (
    caller: InferenceGatewayCredentials.InferenceCaller,
  ) {
    const unattributed = { runId: null, parentRunId: null };
    if (caller.threadId === undefined) {
      const purpose: InferenceRequestPurpose =
        caller.providerInstanceId === undefined ? "background" : "interactive";
      return { purpose, ...unattributed };
    }
    if (Option.isNone(threads)) return { purpose: "interactive" as const, ...unattributed };
    const threadId = caller.threadId;
    const shell = yield* threads.value
      .getThreadShell(threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const runId: RunId | null = shell?.activeRunId ?? null;
    const parentRunId: RunId | null =
      shell?.lineage.relationshipToParent === "subagent"
        ? yield* threads.value
            .getThreadRecords(threadId, ["contextTransfers"], {
              contextTransferStatuses: ["consumed"],
            })
            .pipe(
              Effect.map(
                (records) =>
                  records.contextTransfers.findLast(
                    (transfer) =>
                      transfer.type === "subagent_spawn" && transfer.targetThreadId === threadId,
                  )?.sourcePoint.runId ?? null,
              ),
              Effect.orElseSucceed(() => null),
            )
        : null;
    if (runId === null) return { purpose: "interactive" as const, runId, parentRunId };
    const scheduled = yield* threads.value
      .getThreadRecords(threadId, ["runs", "messages"], {
        runIds: [runId],
        messageRoles: ["user"],
      })
      .pipe(
        Effect.map((records) => {
          const run = records.runs.find((candidate) => candidate.id === runId);
          return records.messages.some(
            (message) => message.id === run?.userMessageId && message.scheduledTaskId !== undefined,
          );
        }),
        Effect.orElseSucceed(() => false),
      );
    return {
      purpose: scheduled ? ("scheduled" as const) : ("interactive" as const),
      runId,
      parentRunId,
    };
  });

  const upstreamHeaders = (request: HttpServerRequest.HttpServerRequest, apiKey: string) => {
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    if (apiKey !== "") {
      headers.authorization = `Bearer ${apiKey}`;
      headers["x-api-key"] = apiKey;
    }
    return headers;
  };

  const responseHeaders = (headers: Readonly<Record<string, string | undefined>>) => {
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) kept[name] = value;
    }
    // Generation streams must reach the agent token by token, never buffered or compressed.
    kept["cache-control"] = "no-store, no-transform";
    return kept;
  };

  const handle = Effect.fn("InferenceGateway.handle")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const receivedAt = yield* Clock.currentTimeMillis;
    const path = new URL(request.url, "http://gateway").pathname;
    const match = /^\/inference\/([^/]+)\/v1\/(.+)$/.exec(path);
    if (match === null) return errorResponse(404, "not_found", "Unknown inference route.");
    const serverId = InferenceServerId.make(decodeURIComponent(match[1]!));
    const route = match[2]!;
    const protocol = GENERATION_PATHS[route];
    const listsModels = route === "models";
    if (!listsModels && protocol === undefined) {
      return errorResponse(404, "not_found", "The gateway does not forward this route.");
    }
    if ((listsModels && request.method !== "GET") || (!listsModels && request.method !== "POST")) {
      return errorResponse(405, "method_not_allowed", "Method not allowed.");
    }

    const caller = yield* credentials.resolve(presentedToken(request));
    if (caller === undefined) {
      return errorResponse(401, "authentication_error", "Missing or unknown gateway credential.");
    }
    if (caller.serverId !== serverId) {
      return errorResponse(403, "permission_error", "This credential is for another server.");
    }
    const config = caller.pinned;
    const endpoint = InferenceServerRegistry.parseBaseUrl(config.baseUrl);
    if ("error" in endpoint) {
      return errorResponse(404, "not_found", "This inference server is off or not registered.");
    }
    const apiKey = yield* readApiKey(caller.serverId);
    if (Option.isNone(apiKey)) {
      return errorResponse(502, "upstream_error", "Could not read the server's API key.");
    }
    const upstreamUrl = `${endpoint.base}/${route}`;

    if (listsModels) {
      // Listing costs no generation, so it bypasses admission and the request log.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* HttpClient.withScope(client).execute(
            HttpClientRequest.get(upstreamUrl).pipe(
              HttpClientRequest.setHeaders(upstreamHeaders(request, apiKey.value)),
            ),
          );
          return HttpServerResponse.text(yield* response.text, {
            status: response.status,
            headers: responseHeaders(response.headers),
          });
        }),
      ).pipe(
        Effect.catchCause(() =>
          Effect.succeed(errorResponse(502, "upstream_error", "The server did not answer.")),
        ),
      );
    }

    const raw = yield* readBounded(request).pipe(Effect.result);
    if (raw._tag === "Failure") {
      return raw.failure === "too_large"
        ? errorResponse(413, "request_too_large", "The request body is too large.")
        : errorResponse(400, "invalid_request_error", "Could not read the request body.");
    }
    const prepared = prepareBody(protocol!, raw.success);
    const staticPrefixHash =
      prepared.staticPrefix === undefined
        ? null
        : (yield* digest.digestHex(
            Digest.sha256,
            new TextEncoder().encode(prepared.staticPrefix),
          )).slice(0, 16);
    const { purpose, runId, parentRunId } = yield* attribute(caller);
    const requestId = yield* random.uuidV4();
    const proxyHeaders: Record<string, string> = { "x-proxy-client": "houston" };
    // Generate these from authenticated thread state, never from caller-supplied proxy headers.
    // Without a known active run, leave the request untracked rather than pin unrelated work.
    if (caller.threadId !== undefined && runId !== null) {
      const threadAffinity = `${affinityNamespace}:${caller.threadId.length}:${caller.threadId}`;
      proxyHeaders["x-proxy-session-id"] = yield* digest.digestHex(
        Digest.sha256,
        new TextEncoder().encode(threadAffinity),
      );
      proxyHeaders["x-proxy-turn-id"] = yield* digest.digestHex(
        Digest.sha256,
        new TextEncoder().encode(`${threadAffinity}:${runId}`),
      );
    }
    // Only streamed replies can run away; a turned-off watchdog leaves the server to its limits.
    const watching = prepared.streaming && config.watchdog?.enabled !== false;
    const watchdog = makeInferenceWatchdog();
    let pendingStop: WatchdogReason | undefined;
    let upstreamHttpStatus: number | null = null;
    let failureSignal: InferenceDiagnostics.InferenceSignal = "unknown";
    let progressed = false;
    const meter = makeUsageMeter(
      protocol!,
      prepared.streaming,
      watching
        ? (channel, text) => {
            progressed = true;
            pendingStop ??= watchdog.onDelta(channel, text);
          }
        : undefined,
    );
    const stopSignal = yield* Deferred.make<WatchdogReason>();
    // "finished" once the reply has ended on its own, so a late idle tick cannot stop it.
    const stoppedFor = yield* Ref.make<WatchdogReason | "finished" | undefined>(undefined);
    const lastProgressAt = yield* Ref.make(receivedAt);
    const stopFor = (reason: WatchdogReason) =>
      Ref.modify(stoppedFor, (current) => [current === undefined, current ?? reason]).pipe(
        Effect.flatMap((first) =>
          first ? Deferred.succeed(stopSignal, reason).pipe(Effect.asVoid) : Effect.void,
        ),
      );
    const milestones = yield* Ref.make<{
      admittedAt?: number;
      dispatchedAt?: number;
      firstContentAt?: number;
    }>({});
    const served = yield* Ref.make<{
      serverId: InferenceServerId;
      fallbackFrom: InferenceServerId | null;
    }>({ serverId, fallbackFrom: null });
    // The lease: the admission slot and the upstream fetch live in `lifetime`. The first terminal
    // writer records the request and closes it, which frees the slot and aborts the fetch; any
    // later writer is a no-op.
    const lifetime = yield* Scope.make();
    const settled = yield* Ref.make(false);
    const finish = Effect.fnUntraced(function* (
      status: InferenceRequests.InferenceRequestStatus,
      signal?: InferenceDiagnostics.InferenceSignal,
      watchdog?: InferenceDiagnostics.InferenceWatchdog,
    ) {
      if (yield* Ref.getAndSet(settled, true)) return;
      failureSignal = signal ?? failureSignal;
      const completedAt = yield* Clock.currentTimeMillis;
      const marks = yield* Ref.get(milestones);
      const target = yield* Ref.get(served);
      yield* Scope.close(lifetime, Exit.void);
      const usage = meter.finish();
      const responseId = meter.responseId();
      if (responseId !== undefined) yield* routing.rememberResponse(responseId, target.serverId);
      const failureCause =
        status === "completed"
          ? null
          : InferenceDiagnostics.inferenceFailureCause(
              status === "cancelled" ? "cancelled" : failureSignal,
              upstreamHttpStatus ?? undefined,
              watchdog,
            );
      yield* requestLog.record({
        requestId,
        serverId: target.serverId,
        model: prepared.model,
        threadId: caller.threadId ?? null,
        runId,
        parentRunId,
        purpose,
        status,
        fallbackFrom: target.fallbackFrom,
        staticPrefixHash,
        receivedAt,
        queueWaitMs: marks.admittedAt === undefined ? null : marks.admittedAt - receivedAt,
        ttftMs:
          marks.firstContentAt === undefined || marks.dispatchedAt === undefined
            ? null
            : marks.firstContentAt - marks.dispatchedAt,
        decodeMs:
          marks.firstContentAt === undefined || status !== "completed"
            ? null
            : completedAt - marks.firstContentAt,
        durationMs: completedAt - receivedAt,
        failureCause,
        upstreamHttpStatus,
        ...usage,
      });
      yield* registry.publishRequestFailure(
        target.serverId,
        status === "completed"
          ? null
          : {
              at: DateTime.formatIso(DateTime.makeUnsafe(completedAt)),
              status: status === "rejected" ? "rejected" : "failed",
              ...(failureCause === null ? {} : { cause: failureCause }),
              ...(failureCause === null
                ? {}
                : { advice: InferenceDiagnostics.inferenceFailureAdvice(failureCause) }),
              ...(upstreamHttpStatus === null ? {} : { httpStatus: upstreamHttpStatus }),
            },
      );
    }, Effect.uninterruptible);
    // The request scope closes even when the body is never read, e.g. the client left before it.
    yield* Scope.addFinalizer(yield* Scope.Scope, finish("cancelled"));
    // A harness retrying the reply the watchdog just stopped would only run it away again.
    if (runId !== null && (yield* stops.refusesRetry(runId, receivedAt))) {
      yield* finish("rejected");
      return errorResponse(
        400,
        "houston_watchdog_stopped",
        "Houston stopped this run's last reply. Send a new message to continue.",
      );
    }

    const plan = yield* routing
      .plan({
        primary: serverId,
        pinned: config,
        threadId: caller.threadId,
        protocol: protocol!,
        model: prepared.model,
        previousResponseId: prepared.previousResponseId,
        contextTokens: prepared.contextTokens,
      })
      .pipe(Effect.result);
    if (plan._tag === "Failure") {
      yield* finish("rejected");
      return plan.failure.reason === "not_registered"
        ? errorResponse(404, "not_found", plan.failure.message)
        : errorResponse(503, "server_unavailable", plan.failure.message);
    }

    const recordStop = Effect.fn("InferenceGateway.recordStop")(function* (reason: WatchdogReason) {
      const target = yield* Ref.get(served);
      failureSignal = "watchdog";
      yield* stops.record({
        threadId: caller.threadId,
        runId,
        serverId: target.serverId,
        model: prepared.model,
        reason,
        atMs: yield* Clock.currentTimeMillis,
      });
    });

    // Only failures before the request reaches a server move it to the next target.
    let upstream: HttpClientResponse.HttpClientResponse | undefined;
    let retryBody = prepared.body;
    let retried = false;
    let bufferedReply: Uint8Array | undefined;
    const targets: Array<InferenceRouting.RouteTarget> = [...plan.success];
    for (const [index, target] of targets.entries()) {
      const next = targets[index + 1];
      if (next !== undefined && !target.ready) continue;
      yield* Ref.set(served, { serverId: target.serverId, fallbackFrom: target.fallbackFrom });
      const attempt = yield* Scope.fork(lifetime);
      const admitted = yield* admission
        .admit({ serverId: target.serverId, purpose, threadId: caller.threadId })
        .pipe(Scope.provide(attempt), Effect.result);
      if (admitted._tag === "Failure") {
        yield* finish("rejected");
        return errorResponse(503, "overloaded_error", admitted.failure.message);
      }
      const dispatchedAt = yield* Clock.currentTimeMillis;
      yield* Ref.set(milestones, { admittedAt: dispatchedAt, dispatchedAt });
      const execute = HttpClient.withScope(client).execute(
        HttpClientRequest.post(`${target.base}/${route}`).pipe(
          HttpClientRequest.setHeaders({
            ...upstreamHeaders(request, target.apiKey),
            ...proxyHeaders,
          }),
          HttpClientRequest.bodyUint8Array(retryBody, "application/json"),
        ),
      );
      // A server holding back its headers holds the slot too, so the first-content limit
      // runs from dispatch.
      const answered = yield* (
        watching
          ? execute.pipe(Effect.timeoutOption(Duration.millis(FIRST_CONTENT_TIMEOUT_MS)))
          : Effect.asSome(execute)
      ).pipe(Scope.provide(attempt), Effect.result);
      if (answered._tag === "Success") {
        if (Option.isSome(answered.success)) {
          upstream = answered.success.value;
          upstreamHttpStatus = upstream.status;
          if (prepared.streaming || retried) break;
          const buffered = yield* upstream.arrayBuffer.pipe(Effect.result);
          if (buffered._tag === "Failure") {
            yield* finish("failed", "transport");
            return errorResponse(
              502,
              "upstream_error",
              "Could not read the inference server's reply.",
            );
          }
          const raw = new Uint8Array(buffered.success);
          meter.push(raw);
          meter.finish();
          if (raw.length > 1024 * 1024) {
            bufferedReply = raw;
            break;
          }
          const empty = upstream.status < 400 && meter.empty();
          const nextBody = empty
            ? retryBody
            : upstream.status >= 400
              ? recoverField(raw, retryBody)
              : undefined;
          if (nextBody === undefined) {
            bufferedReply = raw;
            break;
          }
          yield* Scope.close(attempt, Exit.void);
          const completedAt = yield* Clock.currentTimeMillis;
          yield* requestLog.record({
            requestId,
            serverId: target.serverId,
            model: prepared.model,
            threadId: caller.threadId ?? null,
            runId,
            parentRunId,
            purpose,
            status: "failed",
            failureCause: empty ? "empty-completed" : "unsupported-field",
            fallbackFrom: target.fallbackFrom,
            staticPrefixHash,
            receivedAt,
            queueWaitMs: null,
            ttftMs: null,
            decodeMs: null,
            durationMs: completedAt - receivedAt,
            upstreamHttpStatus,
            ...meter.finish(),
          });
          targets.push({ ...target, ready: true });
          retryBody = nextBody;
          retried = true;
          continue;
        }
        yield* recordStop("idle");
        yield* finish("failed", "watchdog", "idle");
        return errorResponse(
          504,
          "houston_watchdog_idle",
          "Houston stopped this reply: the inference server sent nothing for 5 minutes.",
        );
      }
      if (next === undefined || !isPreDispatchFailure(answered.failure)) {
        yield* finish("failed", "transport");
        return errorResponse(502, "upstream_error", "Could not reach the inference server.");
      }
      yield* Scope.close(attempt, Exit.void);
    }
    if (upstream === undefined) {
      yield* finish("failed", "transport");
      return errorResponse(502, "upstream_error", "Could not reach the inference server.");
    }
    upstreamHttpStatus = upstream.status;
    if (upstream.status >= 300 && upstream.status < 400) {
      yield* finish("failed");
      return errorResponse(502, "upstream_error", "The inference server answered with a redirect.");
    }
    upstreamHttpStatus = upstream.status;
    const succeeded = upstream.status < 400;
    if (watching && succeeded) {
      yield* Ref.set(lastProgressAt, (yield* Ref.get(milestones)).dispatchedAt ?? receivedAt);
      // Lives in `lifetime`, so it ends with the request however that ends.
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("5 seconds");
          const now = yield* Clock.currentTimeMillis;
          const marks = yield* Ref.get(milestones);
          const limit =
            marks.firstContentAt === undefined ? FIRST_CONTENT_TIMEOUT_MS : IDLE_TIMEOUT_MS;
          if (now - (yield* Ref.get(lastProgressAt)) > limit) return yield* stopFor("idle");
        }
      }).pipe(Effect.forkIn(lifetime));
    }
    const upstreamStream =
      bufferedReply === undefined ? upstream.stream : Stream.make(bufferedReply);
    const body = upstreamStream.pipe(
      // Untraced per chunk: the request span already covers the stream.
      Stream.tap((chunk) => {
        const moved = progressed;
        progressed = false;

        return Effect.gen(function* () {
          if (bufferedReply !== undefined) return;
          const first = meter.push(chunk);
          const reason = pendingStop;
          if (first || moved) {
            const now = yield* Clock.currentTimeMillis;
            if (first)
              yield* Ref.update(milestones, (marks) => ({ ...marks, firstContentAt: now }));
            yield* Ref.set(lastProgressAt, now);
          }
          if (reason !== undefined) yield* stopFor(reason);
        });
      }),
      (stream) =>
        watching ? stream.pipe(Stream.interruptWhen(Deferred.await(stopSignal))) : stream,
      (stream) => {
        if (prepared.namespaces === undefined) return stream;
        const restorer = makeResponseRestorer(prepared.namespaces, prepared.streaming);
        return stream.pipe(
          Stream.map(restorer.push),
          Stream.concat(Stream.sync(restorer.flush)),
          Stream.filter((chunk) => chunk.length > 0),
        );
      },
      // A stopped reply ends with the protocol's error, so the harness never takes it as done.
      Stream.concat(
        Stream.unwrap(
          Ref.modify(stoppedFor, (current) => [current, current ?? "finished"] as const).pipe(
            Effect.map((reason) =>
              reason === undefined || reason === "finished"
                ? Stream.empty
                : Stream.make(stopNotice(protocol!, reason)),
            ),
          ),
        ),
      ),
      Stream.onExit((exit) =>
        Ref.get(stoppedFor).pipe(
          Effect.flatMap((reason) =>
            reason !== undefined && reason !== "finished"
              ? recordStop(reason).pipe(Effect.andThen(finish("failed")))
              : finish(
                  Exit.isSuccess(exit)
                    ? succeeded
                      ? "completed"
                      : "failed"
                    : Exit.hasInterrupts(exit)
                      ? meter.finished() && succeeded
                        ? "completed"
                        : "cancelled"
                      : "failed",
                  Exit.hasInterrupts(exit) && !(meter.finished() && succeeded)
                    ? "cancelled"
                    : undefined,
                ),
          ),
        ),
      ),
    );
    return HttpServerResponse.stream(body, {
      status: upstream.status,
      headers: responseHeaders(upstream.headers),
      ...(upstream.headers["content-type"] === undefined
        ? {}
        : { contentType: upstream.headers["content-type"] }),
    });
  });

  return InferenceGateway.of({ handle });
});

export const layer = Layer.effect(InferenceGateway, make);

/** Outside environment auth: the gateway credential is the only key, as with the MCP route. */
export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const gateway = yield* InferenceGateway;
    return HttpRouter.add("*", `${INFERENCE_ROUTE_PREFIX}/*`, (request) => gateway.handle(request));
  }),
);
