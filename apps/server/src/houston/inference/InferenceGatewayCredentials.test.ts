import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@houston-app/contracts";
import { InferenceServerId } from "@houston-app/contracts/houston/inference";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as InferenceGatewayCredentials from "./InferenceGatewayCredentials.ts";

const rtx = InferenceServerId.make("rtx");
const thread = ThreadId.make("thread-1");
const instance = ProviderInstanceId.make("opencode");
const pinned = { baseUrl: "http://rtx.test/v1", enabled: true } as const;

const layer = (now = { value: 1_000 }) =>
  Layer.effect(
    InferenceGatewayCredentials.InferenceGatewayCredentials,
    InferenceGatewayCredentials.__testing.make({
      now: () => now.value,
      endpoint: "http://gateway.test",
    }),
  ).pipe(Layer.provide(NodeCrypto.layer));

const issueSession = (
  service: InferenceGatewayCredentials.InferenceGatewayCredentials["Service"],
) =>
  service.issueSession({
    serverId: rtx,
    pinned,
    threadId: thread,
    providerSessionId: "session-1",
    providerInstanceId: instance,
  });

it.effect("resolves a session credential to its server, thread and pinned settings", () =>
  Effect.gen(function* () {
    const service = yield* InferenceGatewayCredentials.InferenceGatewayCredentials;
    const credential = yield* issueSession(service);
    expect(credential.baseUrl).toBe("http://gateway.test/inference/rtx/v1");
    expect(credential.token.length).toBeGreaterThan(20);
    expect(yield* service.resolve(credential.token)).toEqual({
      serverId: rtx,
      pinned,
      threadId: thread,
      providerSessionId: "session-1",
      providerInstanceId: instance,
    });
    expect(yield* service.resolve("not-a-token")).toBeUndefined();
  }).pipe(Effect.provide(layer())),
);

it.effect("revokes with its thread and its provider session", () =>
  Effect.gen(function* () {
    const service = yield* InferenceGatewayCredentials.InferenceGatewayCredentials;
    const first = yield* issueSession(service);
    const second = yield* issueSession(service);
    yield* service.revokeThread(thread);
    expect(yield* service.resolve(first.token)).toBeUndefined();
    expect(yield* service.resolve(second.token)).toBeUndefined();
  }).pipe(Effect.provide(layer())),
);

it.effect("ends a background credential when its scope closes", () =>
  Effect.gen(function* () {
    const service = yield* InferenceGatewayCredentials.InferenceGatewayCredentials;
    const credential = yield* Effect.scoped(service.issueBackground({ serverId: rtx, pinned }));
    // The scope is closed, so the token is gone.
    expect(yield* service.resolve(credential.token)).toBeUndefined();
    const live = yield* Effect.scoped(
      Effect.gen(function* () {
        const issued = yield* service.issueBackground({ serverId: rtx, pinned });
        expect(yield* service.resolve(issued.token)).toMatchObject({ serverId: rtx });
        return issued;
      }),
    );
    expect(yield* service.resolve(live.token)).toBeUndefined();
  }).pipe(Effect.provide(layer())),
);

it.effect("stops resolving a background credential after its ttl", () => {
  const clock = { value: 1_000 };
  return Effect.gen(function* () {
    const service = yield* InferenceGatewayCredentials.InferenceGatewayCredentials;
    const scope = yield* Scope.make();
    const credential = yield* service
      .issueBackground({ serverId: rtx, pinned })
      .pipe(Scope.provide(scope));
    expect(yield* service.resolve(credential.token)).toBeDefined();
    clock.value += InferenceGatewayCredentials.BACKGROUND_INFERENCE_TTL_MS + 1;
    expect(yield* service.resolve(credential.token)).toBeUndefined();
    yield* Scope.close(scope, Exit.void);
  }).pipe(Effect.provide(layer(clock)));
});

it.effect("maps a shared harness session to its thread only while a holder is registered", () =>
  Effect.gen(function* () {
    const service = yield* InferenceGatewayCredentials.InferenceGatewayCredentials;
    const scoped = Effect.scoped(
      Effect.gen(function* () {
        yield* service.attributeSessions(instance, (sessionId) =>
          sessionId === "opencode-1" ? thread : undefined,
        );
        return yield* service.harnessSessionThread(instance, "opencode-1");
      }),
    );
    expect(yield* scoped).toBe(thread);
    expect(yield* service.harnessSessionThread(instance, "opencode-1")).toBeUndefined();
  }).pipe(Effect.provide(layer())),
);
