import { expect, it } from "@effect/vitest";
import { type ServerSettings, ThreadId } from "@houston-app/contracts";
import {
  InferenceServerId,
  type InferenceServerSnapshot,
} from "@houston-app/contracts/houston/inference";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettingsService from "../../serverSettings.ts";
import * as HoustonSecrets from "../secrets/HoustonSecrets.ts";
import * as InferenceRouting from "./InferenceRouting.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

const rtx = InferenceServerId.make("rtx");
const spark = InferenceServerId.make("spark1");
const other = InferenceServerId.make("other");
const thread = ThreadId.make("thread-1");

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
  models: [{ id: "m", servedContextWindow: 8_000 }],
  apiProtocols: ["chat-completions"],
  ...overrides,
});

const secrets = () => {
  const memory = HoustonSecrets.makeMemory();
  memory.entries.set("houston-inference-server-rtx", "rtx-key");
  memory.entries.set("houston-inference-server-spark1", "spark-key");
  memory.entries.set("houston-inference-server-other", "other-key");
  return memory;
};

const routing = (
  snapshots: ReadonlyArray<InferenceServerSnapshot> = [snapshotOf(rtx), snapshotOf(spark)],
  servers: Partial<ServerSettings["inferenceServers"]> = {},
) =>
  InferenceRouting.layer.pipe(
    Layer.provide([
      ServerSettingsService.layerTest({
        inferenceServers: {
          [rtx]: { baseUrl: "http://rtx.test/v1", fallbackServerId: spark },
          [spark]: { baseUrl: "http://spark1.test/v1" },
          [other]: { baseUrl: "http://other.test/v1" },
          ...servers,
        },
      }),
      Layer.mock(InferenceServerRegistry.InferenceServerRegistry)({
        current: Effect.succeed(snapshots),
      }),
      HoustonSecrets.layerMemory(secrets()),
    ]),
  );

const request: InferenceRouting.RouteRequest = {
  primary: rtx,
  pinned: {
    baseUrl: "http://rtx.test/v1",
    enabled: true,
    fallbackServerId: spark,
  },
  protocol: "chat-completions",
  model: "m",
  contextTokens: 1_000,
};

const planIds = (input: Partial<InferenceRouting.RouteRequest> = {}) =>
  InferenceRouting.InferenceRouting.pipe(
    Effect.flatMap((service) => service.plan({ ...request, ...input })),
    Effect.map((targets) => targets.map((target) => target.serverId)),
  );

it.effect("offers the fallback only with its own endpoint and key, after the primary", () =>
  Effect.gen(function* () {
    const service = yield* InferenceRouting.InferenceRouting;
    expect(yield* service.plan(request)).toEqual([
      {
        serverId: rtx,
        base: "http://rtx.test/v1",
        apiKey: "rtx-key",
        ready: true,
        fallbackFrom: null,
      },
      {
        serverId: spark,
        base: "http://spark1.test/v1",
        apiKey: "spark-key",
        ready: true,
        fallbackFrom: rtx,
      },
    ]);
  }).pipe(Effect.provide(routing())),
);

it.effect(
  "keeps a credential on its pinned endpoint and key after its server moves or is off",
  () =>
    Effect.gen(function* () {
      const service = yield* InferenceRouting.InferenceRouting;
      const [primary] = yield* service.plan(request);
      // The registry's unreachable status is about the moved URL, not the pinned one.
      expect(primary).toEqual({
        serverId: rtx,
        base: "http://rtx.test/v1",
        apiKey: "rtx-key",
        ready: true,
        fallbackFrom: null,
      });
    }).pipe(
      Effect.provide(
        routing([snapshotOf(rtx, { status: "unreachable" }), snapshotOf(spark)], {
          [rtx]: { baseUrl: "http://moved.test/v1", enabled: false },
        }),
      ),
    ),
);

it.effect.each([
  ["it is not ready", [snapshotOf(rtx), snapshotOf(spark, { status: "unreachable" })], {}],
  [
    "it does not serve the model",
    [snapshotOf(rtx), snapshotOf(spark, { models: [{ id: "x" }] })],
    {},
  ],
  [
    "it does not advertise the protocol",
    [snapshotOf(rtx), snapshotOf(spark, { apiProtocols: ["messages"] })],
    {},
  ],
  [
    "the prompt does not fit its context",
    [snapshotOf(rtx), snapshotOf(spark)],
    { contextTokens: 8_001 },
  ],
] as const)("leaves out the fallback when %s", ([, snapshots, input]) =>
  planIds(input).pipe(
    Effect.map((ids) => expect(ids).toEqual([rtx])),
    Effect.provide(routing(snapshots)),
  ),
);

it.effect("allows a fallback whose context window is unknown", () =>
  planIds({ contextTokens: 1_000_000 }).pipe(
    Effect.map((ids) => expect(ids).toEqual([rtx, spark])),
    Effect.provide(routing([snapshotOf(rtx), snapshotOf(spark, { models: [{ id: "m" }] })])),
  ),
);

it.effect("pins a previous response to its issuer and never to a server outside the pair", () =>
  Effect.gen(function* () {
    const service = yield* InferenceRouting.InferenceRouting;
    yield* service.rememberResponse("resp_spark", spark);
    yield* service.rememberResponse("resp_other", other);
    expect(yield* planIds({ threadId: thread, previousResponseId: "resp_spark" })).toEqual([spark]);
    expect(yield* planIds({ previousResponseId: "resp_unknown" })).toEqual([rtx]);
    expect(yield* planIds({ previousResponseId: "resp_other" })).toEqual([rtx]);
  }).pipe(Effect.provide(routing())),
);

it.effect("refuses a previous response whose issuer is unavailable", () =>
  Effect.gen(function* () {
    const service = yield* InferenceRouting.InferenceRouting;
    yield* service.rememberResponse("resp_spark", spark);
    const error = yield* planIds({ previousResponseId: "resp_spark" }).pipe(Effect.flip);
    expect(error.reason).toBe("affinity_unavailable");
    expect(error.message).toContain("spark1");
  }).pipe(Effect.provide(routing([snapshotOf(rtx), snapshotOf(spark, { status: "error" })]))),
);

it("fails over only on connection-phase errors", () => {
  const wrapped = (code: string) => ({ reason: { cause: { cause: { code } } } });
  expect(InferenceRouting.isPreDispatchFailure(wrapped("ECONNREFUSED"))).toBe(true);
  expect(InferenceRouting.isPreDispatchFailure(wrapped("ENOTFOUND"))).toBe(true);
  expect(InferenceRouting.isPreDispatchFailure(wrapped("ECONNRESET"))).toBe(false);
  expect(InferenceRouting.isPreDispatchFailure(wrapped("UND_ERR_HEADERS_TIMEOUT"))).toBe(false);
  expect(InferenceRouting.isPreDispatchFailure(new Error("socket hang up"))).toBe(false);
});
