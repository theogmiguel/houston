// @effect-diagnostics globalFetchInEffect:off -- the test calls the gateway as an outside HTTP client.
// @effect-diagnostics abortControllerInEffect:off -- aborting fetch is how that client disconnects.
import * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import { MessageId, RunId, ScheduledTaskId, ThreadId } from "@houston-app/contracts";
import {
  InferenceServerId,
  type InferenceServerSnapshot,
} from "@houston-app/contracts/houston/inference";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as InferenceGatewayCredentials from "./InferenceGatewayCredentials.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as InferenceRequests from "./InferenceRequests.ts";
import * as InferenceAdmission from "./InferenceAdmission.ts";
import * as InferenceGateway from "./InferenceGateway.ts";
import * as InferenceStops from "./InferenceStops.ts";
import * as InferenceRouting from "./InferenceRouting.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";
import * as HoustonSecrets from "../secrets/HoustonSecrets.ts";
import * as ServerSettings from "../../serverSettings.ts";

const thread = ThreadId.make("thread-1");
const rtx = InferenceServerId.make("rtx");
const spark = InferenceServerId.make("spark1");

const snapshotOf = (
  id: InferenceServerId,
  overrides: Partial<InferenceServerSnapshot> = {},
): InferenceServerSnapshot => ({
  id,
  displayName: id,
  baseUrl: `http://${id}.test/v1`,
  enabled: true,
  status: "ready",
  checkedAt: null,
  models: [{ id: "m", servedContextWindow: 100_000 }],
  apiProtocols: ["chat-completions", "responses"],
  ...overrides,
});

const encoder = new TextEncoder();
const sse = (events: ReadonlyArray<unknown>) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

const CHAT_STREAM = sse([
  { choices: [{ delta: { role: "assistant" } }] },
  { choices: [{ delta: { content: "Hi" } }] },
  {
    choices: [],
    usage: { prompt_tokens: 15, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } },
  },
]);

const flatCall = {
  type: "function_call",
  call_id: "c1",
  name: "mcp__t3_code__echo_x",
  arguments: "{}",
};
const RESPONSES_STREAM = sse([
  { type: "response.output_item.added", item: flatCall },
  {
    type: "response.completed",
    response: { id: "resp_1", output: [flatCall], usage: { input_tokens: 7, output_tokens: 4 } },
  },
]);

interface Seen {
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

/** A port that was just freed, so connecting to it is refused. */
const closedPort = Effect.promise(
  () =>
    new Promise<number>((resolve) => {
      const server = NodeNet.createServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address() as NodeNet.AddressInfo;
        server.close(() => resolve(port));
      });
    }),
);

/** Fake upstreams mounted beside the gateway on one in-process server. */
const makeHarness = Effect.fnUntraced(function* (threads: Layer.Layer<never> = Layer.empty) {
  const seen = yield* Queue.unbounded<Seen>();
  const records = yield* Queue.unbounded<InferenceRequests.InferenceRequestRecord>();
  const hangStarted = yield* Deferred.make<void>();
  const capture = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = request.method === "POST" ? yield* request.text : "";
    yield* Queue.offer(seen, {
      url: request.url,
      headers: request.headers,
      body: text === "" ? undefined : JSON.parse(text),
    });
  });
  const upstream = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/up/v1/chat/completions",
      capture.pipe(
        Effect.as(
          HttpServerResponse.text(CHAT_STREAM, {
            contentType: "text/event-stream",
            headers: { "set-cookie": "upstream=1" },
          }),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/up/v1/responses",
      capture.pipe(
        Effect.as(HttpServerResponse.text(RESPONSES_STREAM, { contentType: "text/event-stream" })),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/up/v1/messages",
      capture.pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe({
            content: [{ type: "text", text: "Hi" }],
            usage: { input_tokens: 9, cache_read_input_tokens: 1, output_tokens: 3 },
          }),
        ),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/up/v1/models",
      capture.pipe(Effect.as(HttpServerResponse.jsonUnsafe({ object: "list", data: [] }))),
    ),
    HttpRouter.add(
      "POST",
      "/redirect/v1/chat/completions",
      HttpServerResponse.empty({ status: 307, headers: { location: "/up/v1/chat/completions" } }),
    ),
    HttpRouter.add(
      "POST",
      "/loop/v1/chat/completions",
      Effect.as(
        capture,
        HttpServerResponse.stream(
          Stream.concat(
            // The same text over and over and never a terminal event: only the watchdog ends it.
            Stream.range(1, 40).pipe(
              Stream.map(() =>
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "[],".repeat(100) } }] })}\n\n`,
                ),
              ),
            ),
            Stream.never,
          ),
          { contentType: "text/event-stream" },
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/hang/v1/chat/completions",
      Effect.as(
        capture,
        HttpServerResponse.stream(
          Stream.concat(
            // Content but no terminal event: the response is still mid-stream.
            Stream.make(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`,
              ),
            ),
            Stream.fromEffect(Deferred.succeed(hangStarted, undefined)).pipe(
              Stream.flatMap(() => Stream.never),
            ),
          ),
          { contentType: "text/event-stream" },
        ),
      ),
    ),
  );

  // Filled once the server's origin is known; credentials pin their server's settings at issue.
  const tokens: Record<string, InferenceGatewayCredentials.InferenceCaller> = {};
  const secrets = HoustonSecrets.makeMemory();
  for (const id of ["rtx", "hang", "loop", "redirect"]) {
    secrets.entries.set(`houston-inference-server-${id}`, "upstream-secret");
  }
  secrets.entries.set("houston-inference-server-dead", "dead-secret");
  const services = yield* Layer.build(
    HttpRouter.serve(Layer.mergeAll(InferenceGateway.routeLayer, upstream), {
      disableListenLog: true,
    }).pipe(
      // The test server's own client prefixes its origin; the gateway dials absolute URLs.
      Layer.provide(
        InferenceGateway.layer.pipe(Layer.provide([FetchHttpClient.layer, InferenceRouting.layer])),
      ),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(ServerSettings.layerTest()),
      Layer.provideMerge(InferenceStops.layer),
      Layer.provide([
        NodeCrypto.layer,
        Layer.succeed(InferenceRequests.InferenceRequestLog, {
          record: (record) => Queue.offer(records, record).pipe(Effect.asVoid),
          summarize: () => Effect.die("unused"),
          latestForThread: () => Effect.die("unused"),
        }),
        Layer.effect(
          InferenceAdmission.InferenceAdmission,
          InferenceAdmission.__testing.make({
            capacity: () => Effect.succeed(1),
            publish: () => Effect.void,
          }),
        ),
        Layer.mock(InferenceGatewayCredentials.InferenceGatewayCredentials)({
          resolve: (token) => Effect.succeed(tokens[token]),
        }),
        HoustonSecrets.layerMemory(secrets),
        Layer.mock(InferenceServerRegistry.InferenceServerRegistry)({
          current: Effect.succeed([
            snapshotOf(InferenceServerId.make("rtx"), { models: [{ id: "GLM-5.3-Flash" }] }),
            // Reported ready, so the gateway really dials it and must classify the refusal.
            snapshotOf(InferenceServerId.make("dead")),
          ]),
          publishRequestFailure: () => Effect.void,
        }),
        threads,
      ]),
    ),
  );
  const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
  const settings = Context.get(services, ServerSettings.ServerSettingsService);
  const server = (path: string) => ({
    baseUrl: `${origin}/${path}/v1`,
    enabled: true,
  });
  const servers = {
    [InferenceServerId.make("rtx")]: server("up"),
    [InferenceServerId.make("hang")]: server("hang"),
    [InferenceServerId.make("loop")]: server("loop"),
    [InferenceServerId.make("redirect")]: server("redirect"),
    [InferenceServerId.make("dead")]: {
      baseUrl: `http://127.0.0.1:${yield* closedPort}/v1`,
      enabled: true,
      fallbackServerId: InferenceServerId.make("rtx"),
    },
  };
  yield* settings.updateSettings({ inferenceServers: servers });
  const caller = (id: string, threadId?: ThreadId) => ({
    serverId: InferenceServerId.make(id),
    pinned: servers[InferenceServerId.make(id)]!,
    ...(threadId === undefined ? {} : { threadId }),
  });
  Object.assign(tokens, {
    "thread-token": caller("rtx", thread),
    "other-thread-token": caller("rtx", ThreadId.make("thread-2")),
    "background-token": caller("rtx"),
    "hang-token": caller("hang", thread),
    "loop-token": caller("loop", thread),
    "redirect-token": caller("redirect"),
    "dead-token": caller("dead", thread),
  });
  const call = (path: string, init: RequestInit = {}) =>
    Effect.promise(() => fetch(`${origin}/inference/${path}`, init));
  const stops = Context.get(services, InferenceStops.InferenceStops);
  return { call, seen, records, hangStarted, settings, stops };
});

const post = (token: string, body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

it.live("stops a looping reply with the protocol's error, records why, and frees the server", () =>
  Effect.gen(function* () {
    const { call, records, stops } = yield* makeHarness();
    const response = yield* call(
      "loop/v1/chat/completions",
      post("loop-token", { model: "m", stream: true, messages: [] }),
    );
    const text = yield* Effect.promise(() => response.text());
    expect(text).toContain(`"type":"houston_watchdog","code":"loop"`);
    expect(yield* Queue.take(records)).toMatchObject({ status: "failed", threadId: thread });
    expect(yield* stops.latest(thread)).toMatchObject({ reason: "loop", model: "m" });
  }),
);

it.live("streams chat completions with only the server's key and records usage", () =>
  Effect.gen(function* () {
    const { call, seen, records } = yield* makeHarness();
    const response = yield* call(
      "rtx/v1/chat/completions",
      post(
        "thread-token",
        { model: "GLM-5.3-Flash", stream: true, messages: [] },
        {
          cookie: "t3=session",
          "x-api-key": "thread-token",
          "x-proxy-client": "spoofed",
          "x-proxy-session-id": "spoofed-session",
          "x-proxy-turn-id": "spoofed-turn",
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(yield* Effect.promise(() => response.text())).toBe(CHAT_STREAM);

    const upstream = yield* Queue.take(seen);
    expect(upstream.headers.authorization).toBe("Bearer upstream-secret");
    expect(upstream.headers["x-api-key"]).toBe("upstream-secret");
    expect(upstream.headers.cookie).toBeUndefined();
    expect(upstream.headers["x-proxy-client"]).toBe("houston");
    expect(upstream.headers["x-proxy-session-id"]).toBeUndefined();
    expect(upstream.headers["x-proxy-turn-id"]).toBeUndefined();
    expect(upstream.body).toEqual({
      model: "GLM-5.3-Flash",
      stream: true,
      messages: [],
      stream_options: { include_usage: true },
    });

    const record = yield* Queue.take(records);
    expect(record).toMatchObject({
      serverId: "rtx",
      model: "GLM-5.3-Flash",
      threadId: thread,
      purpose: "interactive",
      status: "completed",
      promptTokens: 15,
      cachedPromptTokens: 3,
      completionTokens: 2,
    });
    expect(record.queueWaitMs).toBeTypeOf("number");
    expect(record.ttftMs).toBeTypeOf("number");
  }),
);

it.live("sends namespace tools as flat functions and restores the namespace on calls", () =>
  Effect.gen(function* () {
    const { call, seen, records } = yield* makeHarness();
    const echo = { type: "function", name: "echo_x", parameters: {} };
    const response = yield* call(
      "rtx/v1/responses",
      post("thread-token", {
        model: "GLM-5.3-Flash",
        stream: true,
        tools: [{ type: "namespace", name: "mcp__t3_code", tools: [echo] }],
        input: [],
      }),
    );
    const restored = { ...flatCall, namespace: "mcp__t3_code", name: "echo_x" };
    expect(yield* Effect.promise(() => response.text())).toBe(
      sse([
        { type: "response.output_item.added", item: restored },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            output: [restored],
            usage: { input_tokens: 7, output_tokens: 4 },
          },
        },
      ]),
    );
    expect((yield* Queue.take(seen)).body).toMatchObject({
      tools: [{ ...echo, name: "mcp__t3_code__echo_x" }],
    });
    expect(yield* Queue.take(records)).toMatchObject({
      status: "completed",
      promptTokens: 7,
      completionTokens: 4,
    });
  }),
);

it.live("reads non-streaming Anthropic usage and attributes background credentials", () =>
  Effect.gen(function* () {
    const { call, records } = yield* makeHarness();
    const response = yield* call("rtx/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "background-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 10, messages: [] }),
    });
    expect(response.status).toBe(200);
    yield* Effect.promise(() => response.json());
    expect(yield* Queue.take(records)).toMatchObject({
      purpose: "background",
      threadId: null,
      status: "completed",
      promptTokens: 10,
      cachedPromptTokens: 1,
      completionTokens: 3,
      ttftMs: null,
    });
  }),
);

it.live("refuses unknown credentials, other servers, and routes off the allowlist", () =>
  Effect.gen(function* () {
    const { call, seen } = yield* makeHarness();
    const statusOf = (path: string, init: RequestInit) =>
      call(path, init).pipe(Effect.map((response) => response.status));
    expect(yield* statusOf("rtx/v1/chat/completions", post("mcp-token", {}))).toBe(401);
    expect(yield* statusOf("hang/v1/chat/completions", post("thread-token", {}))).toBe(403);
    expect(yield* statusOf("rtx/v1/embeddings", post("thread-token", {}))).toBe(404);
    expect(yield* statusOf("rtx/v1/models", post("thread-token", {}))).toBe(405);
    const models = yield* call("rtx/v1/models", {
      headers: { authorization: "Bearer thread-token" },
    });
    expect(models.status).toBe(200);
    expect((yield* Queue.take(seen)).url).toBe("/up/v1/models");
  }),
);

it.live(
  "keeps a live credential on the URL it was issued for after its server moves or is off",
  () =>
    Effect.gen(function* () {
      const { call, seen, settings } = yield* makeHarness();
      const current = yield* settings.getSettings;
      yield* settings.updateSettings({
        inferenceServers: {
          ...current.inferenceServers,
          [rtx]: {
            ...current.inferenceServers[rtx]!,
            baseUrl: "http://moved.test/v1",
            enabled: false,
          },
        },
      });
      const response = yield* call(
        "rtx/v1/chat/completions",
        post("thread-token", { model: "GLM-5.3-Flash", stream: true, messages: [] }),
      );
      expect(response.status).toBe(200);
      yield* Effect.promise(() => response.text());
      expect((yield* Queue.take(seen)).url).toBe("/up/v1/chat/completions");
    }),
);

it.live("serves a refused primary's request from its fallback over real sockets", () =>
  Effect.gen(function* () {
    const { call, seen, records } = yield* makeHarness();
    const response = yield* call(
      "dead/v1/chat/completions",
      post("dead-token", { model: "GLM-5.3-Flash", stream: true, messages: [] }),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toBe(CHAT_STREAM);
    const upstream = yield* Queue.take(seen);
    expect(upstream.url).toBe("/up/v1/chat/completions");
    expect(upstream.headers.authorization).toBe("Bearer upstream-secret");
    expect(yield* Queue.take(records)).toMatchObject({
      status: "completed",
      serverId: "rtx",
      fallbackFrom: "dead",
    });
  }),
);

it.live("answers an upstream redirect with an error instead of following it", () =>
  Effect.gen(function* () {
    const { call, seen, records } = yield* makeHarness();
    const response = yield* call(
      "redirect/v1/chat/completions",
      post("redirect-token", { model: "m", stream: true }),
    );
    expect(response.status).toBe(502);
    expect((yield* Queue.take(records)).status).toBe("failed");
    expect(yield* Queue.size(seen)).toBe(0);
  }),
);

it.live("records a client disconnect mid-stream and frees the slot", () =>
  Effect.gen(function* () {
    const { call, records, hangStarted } = yield* makeHarness();
    const abort = new AbortController();
    const response = yield* call("hang/v1/chat/completions", {
      ...post("hang-token", { model: "m", stream: true }),
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    yield* Effect.promise(() => reader.read());
    yield* Deferred.await(hangStarted);
    abort.abort();
    const record = yield* Queue.take(records);
    expect(record.status).toBe("cancelled");
    expect(record.ttftMs).toBeTypeOf("number");

    // Capacity is one, so this is admitted only if the cancelled request released its slot.
    const again = new AbortController();
    const next = yield* call("hang/v1/chat/completions", {
      ...post("hang-token", { model: "m", stream: true }),
      signal: again.signal,
    });
    expect(next.status).toBe(200);
    again.abort();
    expect((yield* Queue.take(records)).status).toBe("cancelled");
  }),
);

it.live("attributes a request to its active run, its delegating run and its scheduled origin", () =>
  Effect.gen(function* () {
    const runId = RunId.make("run-1");
    const userMessageId = MessageId.make("message-1");
    const { call, records } = yield* makeHarness(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            activeRunId: runId,
            lineage: { relationshipToParent: "subagent" },
          } as never),
        getThreadRecords: () =>
          Effect.succeed({
            runs: [{ id: runId, userMessageId }],
            messages: [{ id: userMessageId, scheduledTaskId: ScheduledTaskId.make("task-1") }],
            contextTransfers: [
              {
                type: "subagent_spawn",
                targetThreadId: thread,
                sourcePoint: { threadId: "parent", runId: "parent-run" },
              },
            ],
          } as never),
      }),
    );
    const response = yield* call(
      "rtx/v1/chat/completions",
      post("thread-token", { model: "m", stream: true }),
    );
    yield* Effect.promise(() => response.text());
    expect(yield* Queue.take(records)).toMatchObject({
      purpose: "scheduled",
      runId,
      parentRunId: "parent-run",
    });
  }),
);

interface Exchange {
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
  readonly aborted: Deferred.Deferred<void>;
  readonly reply: Deferred.Deferred<Response, Error>;
}

/** A web response whose body the test writes to, chunk by chunk. */
const controlledBody = (init: ResponseInit = {}) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (control) => {
      controller = control;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      ...init,
    }),
    push: (text: string) => Effect.sync(() => controller.enqueue(encoder.encode(text))),
    end: Effect.sync(() => controller.close()),
    fail: Effect.sync(() => controller.error(new Error("upstream reset"))),
  };
};

interface LifecycleOptions {
  readonly fallback?: boolean;
  readonly snapshots?: ReadonlyArray<InferenceServerSnapshot>;
}

const connectionError = (code: string) =>
  Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

const makeLifecycle = Effect.fnUntraced(function* (options: LifecycleOptions = {}) {
  const exchanges = yield* Queue.unbounded<Exchange>();
  const records = yield* Queue.unbounded<InferenceRequests.InferenceRequestRecord>();
  const queued = yield* Queue.unbounded<InferenceServerId>();
  const gate = yield* Deferred.make<void>();
  const gates: Record<string, Deferred.Deferred<void>> = {
    [rtx]: gate,
    [spark]: yield* Deferred.make<void>(),
  };
  const releases: Record<string, number> = {};
  const snapshots = { current: options.snapshots ?? [snapshotOf(rtx), snapshotOf(spark)] };

  const upstream = HttpClient.make((request, url, signal) =>
    Effect.gen(function* () {
      const aborted = yield* Deferred.make<void>();
      if (signal.aborted) Deferred.doneUnsafe(aborted, Exit.void);
      signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Exit.void));
      const reply = yield* Deferred.make<Response, Error>();
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      yield* Queue.offer(exchanges, {
        url: url.toString(),
        headers: request.headers,
        body,
        aborted,
        reply,
      });
      const response = yield* Deferred.await(reply).pipe(
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause }),
            }),
        ),
      );
      return HttpClientResponse.fromWeb(request, response);
    }),
  );

  const rtxConfig = {
    baseUrl: "http://rtx.test/v1",
    enabled: true,
    ...(options.fallback === true ? { fallbackServerId: spark } : {}),
  };
  const secrets = HoustonSecrets.makeMemory();
  secrets.entries.set("houston-inference-server-rtx", "rtx-key");
  secrets.entries.set("houston-inference-server-spark1", "spark-key");
  const gateway = yield* Layer.build(
    InferenceGateway.layer.pipe(
      Layer.provide(InferenceRouting.layer),
      Layer.provide([
        Layer.succeed(HttpClient.HttpClient, upstream),
        ServerSettings.layerTest({
          inferenceServers: {
            [rtx]: rtxConfig,
            [spark]: { baseUrl: "http://spark1.test/v1", enabled: true },
          },
        }),
        Layer.mock(InferenceServerRegistry.InferenceServerRegistry)({
          current: Effect.sync(() => snapshots.current),
          publishRequestFailure: () => Effect.void,
        }),
        InferenceStops.layer,
        NodeCrypto.layer,
        Layer.succeed(InferenceRequests.InferenceRequestLog, {
          record: (record) => Queue.offer(records, record).pipe(Effect.asVoid),
          summarize: () => Effect.die("unused"),
          latestForThread: () => Effect.die("unused"),
        }),
        Layer.succeed(InferenceAdmission.InferenceAdmission, {
          // Mirrors the real queue: enqueueing is the acquire, waiting for a slot is interruptible.
          admit: (ticket) =>
            Effect.acquireRelease(Queue.offer(queued, ticket.serverId), () =>
              Effect.sync(() => {
                releases[ticket.serverId] = (releases[ticket.serverId] ?? 0) + 1;
              }),
            ).pipe(Effect.andThen(Deferred.await(gates[ticket.serverId]!))),
        }),
        Layer.mock(InferenceGatewayCredentials.InferenceGatewayCredentials)({
          resolve: () => Effect.succeed({ serverId: rtx, pinned: rtxConfig, threadId: thread }),
        }),
        HoustonSecrets.layerMemory(secrets),
      ]),
    ),
  ).pipe(Effect.map((context) => Context.get(context, InferenceGateway.InferenceGateway)));

  /** Starts a request the way the HTTP server does: in a request scope the test closes. */
  const start = Effect.fnUntraced(function* (
    body: unknown = { model: "m", stream: true },
    route = "chat/completions",
  ) {
    const requestScope = yield* Scope.make();
    const handler = yield* gateway
      .handle(
        HttpServerRequest.fromWeb(
          new Request(`http://gateway.test/inference/rtx/v1/${route}`, {
            method: "POST",
            headers: { authorization: "Bearer thread-token", "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      )
      .pipe(Scope.provide(requestScope), Effect.forkChild({ startImmediately: true }));
    /** The client went away: the server interrupts the handler and closes the request scope. */
    const disconnect = Fiber.interrupt(handler).pipe(
      Effect.andThen(Scope.close(requestScope, Exit.void)),
    );
    /** Only supplies the upstream bytes: a safe retry has no downstream response to drain yet. */
    const respond = (exchange: Exchange, response: Response) =>
      Deferred.succeed(exchange.reply, response);
    /** Answers the request upstream and plays the client reading the whole response. */
    const serve = Effect.fnUntraced(function* (exchange: Exchange, response: Response) {
      yield* respond(exchange, response);
      const sent = yield* Fiber.join(handler);
      yield* Stream.runDrain(bodyText(sent));
      yield* Scope.close(requestScope, Exit.void);
      return sent;
    });
    return { handler, requestScope, disconnect, serve, respond };
  });

  /** Exactly one terminal record and one admission release per server tried. */
  const settledOnce = Effect.fnUntraced(function* (
    expectedReleases: Record<string, number> = { [rtx]: 1 },
  ) {
    const record = yield* Queue.take(records);
    expect(yield* Queue.size(records)).toBe(0);
    expect(releases).toEqual(expectedReleases);
    return record;
  });

  return { start, exchanges, queued, gate, gates, snapshots, records, settledOnce };
});

const bodyText = (response: HttpServerResponse.HttpServerResponse) =>
  (response.body._tag === "Stream" ? response.body.stream : Stream.empty).pipe(Stream.orDie);

it.effect("a client leaving while queued settles once and never dispatches", () =>
  Effect.gen(function* () {
    const { start, exchanges, queued, settledOnce } = yield* makeLifecycle();
    const { disconnect } = yield* start();
    yield* Queue.take(queued);
    yield* disconnect;
    expect(yield* settledOnce()).toMatchObject({ status: "cancelled", failureCause: "cancelled" });
    expect(yield* Queue.size(exchanges)).toBe(0);
  }),
);

it.effect("a client leaving while upstream headers are pending aborts the upstream", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { disconnect } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    yield* disconnect;
    yield* Deferred.await(exchange.aborted);
    expect((yield* settledOnce()).status).toBe("cancelled");
  }),
);

it.effect("stops a server that holds back its headers past the first-content limit", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    yield* TestClock.adjust("5 minutes");
    expect((yield* Fiber.join(handler)).status).toBe(504);
    yield* Deferred.await(exchange.aborted);
    expect(yield* settledOnce()).toMatchObject({ status: "failed", failureCause: "watchdog-idle" });
  }),
);

it.effect("a client gone before the body is subscribed releases the lease and aborts", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler, requestScope } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    yield* Deferred.succeed(exchange.reply, controlledBody().response);
    expect((yield* Fiber.join(handler)).status).toBe(200);
    // A destroyed response is never written: the server closes the scope without reading the body.
    yield* Scope.close(requestScope, Exit.void);
    yield* Deferred.await(exchange.aborted);
    expect((yield* settledOnce()).status).toBe("cancelled");
  }),
);

it.effect("a client leaving mid-stream aborts the upstream and settles once", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler, requestScope } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    const upstream = controlledBody();
    yield* Deferred.succeed(exchange.reply, upstream.response);
    const response = yield* Fiber.join(handler);
    const received = yield* Queue.unbounded<Uint8Array>();
    const writer = yield* Stream.runForEach(bodyText(response), (chunk) =>
      Queue.offer(received, chunk),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* upstream.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`);
    yield* Queue.take(received);
    yield* Fiber.interrupt(writer);
    yield* Scope.close(requestScope, Exit.void);
    yield* Deferred.await(exchange.aborted);
    const record = yield* settledOnce();
    expect(record.status).toBe("cancelled");
    expect(record.ttftMs).toBeTypeOf("number");
  }),
);

it.effect("a client abort racing an upstream error records one terminal state", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler, requestScope } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    const upstream = controlledBody();
    yield* Deferred.succeed(exchange.reply, upstream.response);
    const writer = yield* Stream.runDrain(bodyText(yield* Fiber.join(handler))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* upstream.fail;
    yield* Fiber.interrupt(writer);
    yield* Scope.close(requestScope, Exit.void);
    expect(["failed", "cancelled"]).toContain((yield* settledOnce()).status);
  }),
);

it.effect("a client abort racing body completion records one terminal state", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler, requestScope } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    const upstream = controlledBody();
    yield* Deferred.succeed(exchange.reply, upstream.response);
    const writer = yield* Stream.runDrain(bodyText(yield* Fiber.join(handler))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* upstream.push(CHAT_STREAM);
    yield* upstream.end;
    yield* Fiber.interrupt(writer);
    yield* Scope.close(requestScope, Exit.void);
    expect(["completed", "cancelled"]).toContain((yield* settledOnce()).status);
  }),
);

it.effect("a completed request settles once with its usage", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler, requestScope } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    const upstream = controlledBody();
    yield* Deferred.succeed(exchange.reply, upstream.response);
    const writer = yield* Stream.runDrain(bodyText(yield* Fiber.join(handler))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* upstream.push(CHAT_STREAM);
    yield* upstream.end;
    yield* Fiber.join(writer);
    yield* Scope.close(requestScope, Exit.void);
    expect(yield* settledOnce()).toMatchObject({
      status: "completed",
      promptTokens: 15,
      cachedPromptTokens: 3,
    });
  }),
);

const chatResponse = () =>
  new Response(CHAT_STREAM, { headers: { "content-type": "text/event-stream" } });

it.effect("fails over to the fallback with its own URL and key when the primary refuses", () =>
  Effect.gen(function* () {
    const { start, exchanges, gates, settledOnce } = yield* makeLifecycle({ fallback: true });
    yield* Deferred.succeed(gates[rtx]!, undefined);
    yield* Deferred.succeed(gates[spark]!, undefined);
    const { serve } = yield* start();
    const refused = yield* Queue.take(exchanges);
    expect(refused.url).toBe("http://rtx.test/v1/chat/completions");
    yield* Deferred.fail(refused.reply, connectionError("ECONNREFUSED"));
    const fallback = yield* Queue.take(exchanges);
    expect(fallback.url).toBe("http://spark1.test/v1/chat/completions");
    expect(fallback.headers.authorization).toBe("Bearer spark-key");
    expect((yield* serve(fallback, chatResponse())).status).toBe(200);
    expect(yield* settledOnce({ [rtx]: 1, [spark]: 1 })).toMatchObject({
      status: "completed",
      serverId: spark,
      fallbackFrom: rtx,
    });
  }),
);

it.effect("never replays a request that failed after it was dispatched", () =>
  Effect.gen(function* () {
    const { start, exchanges, gates, settledOnce } = yield* makeLifecycle({ fallback: true });
    yield* Deferred.succeed(gates[rtx]!, undefined);
    const { handler } = yield* start();
    yield* Deferred.fail((yield* Queue.take(exchanges)).reply, connectionError("ECONNRESET"));
    expect((yield* Fiber.join(handler)).status).toBe(502);
    expect(yield* settledOnce()).toMatchObject({ status: "failed", serverId: rtx });
    expect(yield* Queue.size(exchanges)).toBe(0);
  }),
);

it.effect("skips a primary the registry does not report ready", () =>
  Effect.gen(function* () {
    const { start, exchanges, gates, settledOnce } = yield* makeLifecycle({
      fallback: true,
      snapshots: [snapshotOf(rtx, { status: "unreachable" }), snapshotOf(spark)],
    });
    yield* Deferred.succeed(gates[spark]!, undefined);
    const { serve } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    expect(exchange.url).toBe("http://spark1.test/v1/chat/completions");
    yield* serve(exchange, chatResponse());
    expect((yield* settledOnce({ [spark]: 1 })).fallbackFrom).toBe(rtx);
  }),
);

it.effect("waits on a busy primary instead of overflowing to an idle fallback", () =>
  Effect.gen(function* () {
    const { start, exchanges, queued, gates, settledOnce } = yield* makeLifecycle({
      fallback: true,
    });
    yield* Deferred.succeed(gates[spark]!, undefined);
    const { serve } = yield* start();
    expect(yield* Queue.take(queued)).toBe(rtx);
    yield* TestClock.adjust("1 minute");
    expect(yield* Queue.size(queued)).toBe(0);
    yield* Deferred.succeed(gates[rtx]!, undefined);
    const exchange = yield* Queue.take(exchanges);
    expect(exchange.url).toBe("http://rtx.test/v1/chat/completions");
    yield* serve(exchange, chatResponse());
    expect((yield* settledOnce()).fallbackFrom).toBeNull();
  }),
);

it.effect("pins a previous_response_id to the server that issued it, or refuses", () =>
  Effect.gen(function* () {
    const { start, exchanges, gates, snapshots, records } = yield* makeLifecycle({
      fallback: true,
      snapshots: [snapshotOf(rtx, { status: "unreachable" }), snapshotOf(spark)],
    });
    yield* Deferred.succeed(gates[rtx]!, undefined);
    yield* Deferred.succeed(gates[spark]!, undefined);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

    const first = yield* start({ model: "m", input: "hi" }, "responses");
    const issued = yield* Queue.take(exchanges);
    expect(issued.url).toBe("http://spark1.test/v1/responses");
    yield* first.serve(issued, json({ id: "resp_1", usage: { input_tokens: 3 } }));
    yield* Queue.take(records);

    snapshots.current = [snapshotOf(rtx), snapshotOf(spark, { status: "unreachable" })];
    const pinned = yield* start(
      { model: "m", input: "more", previous_response_id: "resp_1" },
      "responses",
    );
    const refused = yield* Fiber.join(pinned.handler);
    expect(refused.status).toBe(503);
    expect(yield* Queue.size(exchanges)).toBe(0);
    expect((yield* Queue.take(records)).status).toBe("rejected");
  }),
);

it.effect("fingerprints only the static prefix, independent of key order", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, records } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const hashOf = Effect.fnUntraced(function* (body: unknown) {
      const { serve } = yield* start(body);
      yield* serve(yield* Queue.take(exchanges), chatResponse());
      return (yield* Queue.take(records)).staticPrefixHash;
    });
    const system = { role: "system", content: "You are T3." };
    const tool = { type: "function", function: { name: "read", parameters: {} } };
    const first = yield* hashOf({
      model: "m",
      stream: true,
      messages: [system, { role: "user", content: "one" }],
      tools: [tool],
    });
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(
      yield* hashOf({
        tools: [{ function: { parameters: {}, name: "read" }, type: "function" }],
        messages: [system, { role: "user", content: "two" }, { role: "assistant", content: "x" }],
        stream: true,
        model: "m",
      }),
    ).toBe(first);
    expect(
      yield* hashOf({ model: "m", stream: true, messages: [system], tools: [tool, tool] }),
    ).not.toBe(first);
  }),
);
