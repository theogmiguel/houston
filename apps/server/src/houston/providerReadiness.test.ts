import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderFailure,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import { acpRegistryPromptFailure } from "@t3tools/provider-acp-registry/testing";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";

import { classifyCodexManagedError } from "../provider/CodexManagedErrors.ts";
import { claudeSignedOutMessage } from "../provider/Drivers/ClaudeHome.ts";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  classifyTurnFailure,
  decorateProviderRegistry,
  layerReadinessLedger,
  ReadinessLedger,
  withReadiness,
  type TurnReport,
} from "./providerReadiness.ts";

const DISPLAY_NAMES: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  acpRegistry: "Mistral Vibe",
};

const makeProvider = (
  driver: string,
  overrides: Partial<ServerProvider> = {},
  instanceId: string = driver,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName: DISPLAY_NAMES[driver] ?? driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-29T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const failure = (
  input: Pick<OrchestrationV2ProviderFailure, "class" | "message" | "code"> &
    Partial<OrchestrationV2ProviderFailure>,
): OrchestrationV2ProviderFailure => ({ retryable: null, ...input });

// Literal failures each adapter's upstream tests assert (see checks.md, "Families").
const CLAUDE_USAGE_LIMIT = failure({
  class: "usage_limit",
  message: "Claude usage limit reached. Send the message again once the limit resets.",
  code: "api_error_429",
  retryable: true,
  resetAt: "2026-10-29T18:00:00.000Z",
});
const CODEX_USAGE_LIMIT = failure({
  class: "usage_limit",
  message: "Provider stopped this request.",
  code: "usageLimitExceeded",
  resetAt: "2033-05-19T07:20:00.000Z",
});
const OPENCODE_RATE_LIMIT = failure({
  class: "usage_limit",
  message: "Rate limit exceeded: free-models-per-min.",
  code: "provider.rate-limit",
});
const OPENCODE_EMPTY_BALANCE = failure({
  class: "provider_error",
  message: "Upstream request failed: Insufficient account funds",
  code: "provider.quota",
});
const MISTRAL_VIBE_RATE_LIMIT = acpRegistryPromptFailure(
  "mistral-vibe",
  new EffectAcpErrors.AcpRequestError({
    code: -31001,
    errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
  }),
);
const ACP_SIGNED_OUT = failure({
  class: "provider_error",
  message: "Missing Authentication header",
  code: "-32000",
});
const ACP_INTERNAL = failure({
  class: "provider_error",
  message: "Internal error",
  code: "-32603",
});

const T0 = DateTime.makeUnsafe("2026-10-29T12:00:00.000Z");
const at = (seconds: number) => DateTime.add(T0, { seconds });

const failed = (
  provider: ServerProvider,
  turnFailure: OrchestrationV2ProviderFailure,
  occurredAt: DateTime.Utc = T0,
): TurnReport => ({
  instanceId: provider.instanceId,
  driver: provider.driver,
  status: "failed",
  failure: turnFailure,
  occurredAt,
});

const completed = (provider: ServerProvider, occurredAt: DateTime.Utc): TurnReport => ({
  instanceId: provider.instanceId,
  driver: provider.driver,
  status: "completed",
  failure: null,
  occurredAt,
});

const makeFakeRegistry = Effect.fn("makeFakeRegistry")(function* (
  initial: ReadonlyArray<ServerProvider>,
) {
  const providersRef = yield* Ref.make(initial);
  const changes = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
  const current = Ref.get(providersRef);
  const service: ProviderRegistry.ProviderRegistry["Service"] = {
    getProviders: current,
    refresh: () => current,
    refreshInstance: () => current,
    reloadSecretsAndRefresh: () => current,
    refreshAfterUpdate: () => current,
    refreshWorkspaceSnapshot: () => current,
    getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused in this test"),
    setProviderMaintenanceActionState: () => current,
    get streamChanges() {
      return Stream.fromPubSub(changes);
    },
  };
  const publish = (next: ReadonlyArray<ServerProvider>) =>
    Ref.set(providersRef, next).pipe(Effect.andThen(PubSub.publish(changes, next)));
  return { service, publish };
});

const makeHarness = Effect.fn("makeHarness")(function* (providers: ReadonlyArray<ServerProvider>) {
  const fake = yield* makeFakeRegistry(providers);
  const registry = yield* decorateProviderRegistry(fake.service);
  const ledger = yield* ReadinessLedger;
  const readinessOf = (provider: ServerProvider) =>
    registry.getProviders.pipe(
      Effect.map(
        (published) =>
          published.find((candidate) => candidate.instanceId === provider.instanceId)?.readiness,
      ),
    );
  const readinessAfter = (provider: ServerProvider, reports: ReadonlyArray<TurnReport>) =>
    Effect.forEach(reports, ledger.report, { discard: true }).pipe(
      Effect.andThen(readinessOf(provider)),
    );
  return { fake, registry, ledger, readinessOf, readinessAfter };
});

/** Subscribes to published lists now; each pull takes the next one. */
const subscribe = Effect.fn("subscribe")(function* (
  changes: Stream.Stream<ReadonlyArray<ServerProvider>>,
) {
  const queue = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
  yield* Stream.runForEach(changes, (providers) => Queue.offer(queue, providers)).pipe(
    Effect.forkIn(yield* Effect.scope, { startImmediately: true }),
  );
  return Queue.take(queue).pipe(Effect.map((providers) => [providers] as const));
});

/** Pulls published lists until one satisfies the predicate. */
const awaitPublished = <E, R>(
  pull: Effect.Effect<ReadonlyArray<ReadonlyArray<ServerProvider>>, E, R>,
  predicate: (providers: ReadonlyArray<ServerProvider>) => boolean,
) =>
  Effect.gen(function* () {
    while (true) {
      const latest = (yield* pull).at(-1);
      if (latest !== undefined && predicate(latest)) return latest;
    }
  });

const stateOf = (providers: ReadonlyArray<ServerProvider>) => providers[0]?.readiness?.state;

const withLedger = <A, E>(effect: Effect.Effect<A, E, ReadinessLedger | Scope.Scope>) =>
  effect.pipe(Effect.provide(layerReadinessLedger), Effect.scoped);

describe("snapshot precedence", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly snapshot: Partial<ServerProvider>;
    readonly expected: Partial<ProviderReadiness>;
  }> = [
    {
      name: "unavailable and disabled is notInstalled, not turnedOff",
      snapshot: {
        availability: "unavailable",
        enabled: false,
        unavailableReason: "Driver 'codex' failed to load: spawn error.",
      },
      expected: {
        state: "notInstalled",
        reason: "missing",
        message: "Driver 'codex' failed to load: spawn error.",
      },
    },
    {
      name: "disabled and not installed is turnedOff",
      snapshot: { enabled: false, installed: false },
      expected: { state: "turnedOff" },
    },
    {
      name: "not installed is notInstalled",
      snapshot: { installed: false },
      expected: { state: "notInstalled", reason: "missing" },
    },
    {
      name: "unauthenticated with a health error is signedOut from the probe",
      snapshot: { auth: { status: "unauthenticated" }, status: "error" },
      expected: { state: "signedOut", source: "probe" },
    },
    {
      name: "a health error with unknown auth is an unusable install",
      snapshot: { status: "error", auth: { status: "unknown" } },
      expected: { state: "notInstalled", reason: "unusable" },
    },
    {
      name: "a warning with unknown auth is ready",
      snapshot: { status: "warning", auth: { status: "unknown" } },
      expected: { state: "ready" },
    },
    {
      name: "a ready snapshot is ready",
      snapshot: { status: "ready" },
      expected: { state: "ready" },
    },
  ];

  it.each(cases)("$name", ({ snapshot, expected }) => {
    const readiness = withReadiness(makeProvider("codex", snapshot), undefined).readiness;
    assert.isDefined(readiness);
    assert.deepInclude(readiness, expected);
  });

  it("a ledger entry outranks a failed health check", () => {
    const readiness = withReadiness(
      makeProvider("codex", { status: "error", auth: { status: "unknown" } }),
      {
        state: "rejected",
        code: "subscription_sharing_v2_invalid_user",
        message: "ChatGPT could not validate this connection.",
        at: "2026-10-29T12:00:00.000Z",
      },
    ).readiness;
    assert.deepInclude(readiness, {
      state: "rejected",
      code: "subscription_sharing_v2_invalid_user",
    });
  });
});

describe("every non-ready state names its cause", () => {
  it("falls back to a message naming the provider", () => {
    const codex = (overrides: Partial<ServerProvider>) =>
      withReadiness(makeProvider("codex", overrides), undefined).readiness;
    assert.deepEqual(codex({ installed: false }), {
      state: "notInstalled",
      reason: "missing",
      message: "Codex was not found",
    });
    assert.deepEqual(codex({ enabled: false }), {
      state: "turnedOff",
      message: "Codex is turned off in Settings",
    });
    assert.deepEqual(codex({ auth: { status: "unauthenticated" } }), {
      state: "signedOut",
      source: "probe",
      message: "Codex is signed out",
    });
    const unusable = codex({ status: "error", auth: { status: "unknown" } });
    assert.equal(unusable?.state, "notInstalled");
    assert.isTrue(unusable?.state !== "ready" && unusable!.message.trim().length > 0);
  });

  it("keeps the snapshot's own message when it has one", () => {
    const message = "OpenCode CLI (`opencode`) is not installed or not on PATH.";
    assert.deepEqual(
      withReadiness(makeProvider("opencode", { installed: false, message }), undefined).readiness,
      { state: "notInstalled", reason: "missing", message },
    );
    assert.deepEqual(
      withReadiness(
        makeProvider("codex", {
          status: "error",
          auth: { status: "unknown" },
          message: "Timed out while checking Codex app-server provider status.",
        }),
        undefined,
      ).readiness,
      {
        state: "notInstalled",
        reason: "unusable",
        message: "Timed out while checking Codex app-server provider status.",
      },
    );
  });

  it("gives every non-ready state a non-empty message", () => {
    const snapshots: ReadonlyArray<Partial<ServerProvider>> = [
      { availability: "unavailable" },
      { enabled: false },
      { installed: false },
      { auth: { status: "unauthenticated" } },
      { status: "error", auth: { status: "unknown" } },
    ];
    for (const snapshot of snapshots) {
      const readiness = withReadiness(makeProvider("claudeAgent", snapshot), undefined).readiness;
      assert.isDefined(readiness);
      if (readiness === undefined || readiness.state === "ready") {
        assert.fail(`expected a non-ready state for ${JSON.stringify(snapshot)}`);
      } else {
        assert.isAbove(readiness.message.trim().length, 0);
      }
    }
  });
});

describe("usage limits by family", () => {
  it.effect("Claude and Codex keep the failure's reset; OpenCode and ACP name the refusal", () =>
    withLedger(
      Effect.gen(function* () {
        const claude = makeProvider("claudeAgent");
        const codex = makeProvider("codex");
        const opencode = makeProvider("opencode");
        const vibe = makeProvider("acpRegistry", {}, "acpRegistry_vibe");
        const { readinessAfter } = yield* makeHarness([claude, codex, opencode, vibe]);

        assert.deepEqual(yield* readinessAfter(claude, [failed(claude, CLAUDE_USAGE_LIMIT)]), {
          state: "outOfUsage",
          resetsAt: "2026-10-29T18:00:00.000Z",
          message: CLAUDE_USAGE_LIMIT.message,
          at: "2026-10-29T12:00:00.000Z",
        });
        assert.deepInclude(yield* readinessAfter(codex, [failed(codex, CODEX_USAGE_LIMIT)]), {
          state: "outOfUsage",
          resetsAt: "2033-05-19T07:20:00.000Z",
        });
        assert.deepEqual(yield* readinessAfter(opencode, [failed(opencode, OPENCODE_RATE_LIMIT)]), {
          state: "outOfUsage",
          resetsAt: null,
          message: "OpenCode did not say when its limit resets",
          at: "2026-10-29T12:00:00.000Z",
        });
        assert.equal(MISTRAL_VIBE_RATE_LIMIT.class, "usage_limit");
        assert.deepEqual(yield* readinessAfter(vibe, [failed(vibe, MISTRAL_VIBE_RATE_LIMIT)]), {
          state: "outOfUsage",
          resetsAt: null,
          message: "Mistral Vibe did not say when its limit resets",
          at: "2026-10-29T12:00:00.000Z",
        });
      }),
    ),
  );

  it("refuses outOfUsage for Antigravity by name", () => {
    const antigravity = ProviderDriverKind.make("antigravity");
    assert.deepEqual(
      classifyTurnFailure(antigravity, failure({ ...CLAUDE_USAGE_LIMIT, code: null })),
      { state: "none" },
    );
  });
});

describe("signed-out codes by family", () => {
  it.effect("Claude's sign-out, Codex unauthorized and ACP -32000 sign the instance out", () =>
    withLedger(
      Effect.gen(function* () {
        const claude = makeProvider("claudeAgent");
        const codex = makeProvider("codex");
        const antigravity = makeProvider("antigravity");
        const vibe = makeProvider("acpRegistry");
        const { readinessAfter } = yield* makeHarness([claude, codex, antigravity, vibe]);

        // The failure ClaudeAdapterV2.test.ts asserts for an assistant authentication_failed.
        const claudeFailure = failure({
          class: "provider_error",
          message: claudeSignedOutMessage({ configDir: "/synthetic", cwd: "/workspace" }),
          code: "authentication_failed",
        });
        assert.deepEqual(yield* readinessAfter(claude, [failed(claude, claudeFailure)]), {
          state: "signedOut",
          source: "turn",
          message: claudeFailure.message,
        });
        const codexFailure = failure({
          class: "provider_error",
          message: "Provider stopped this request.",
          code: "unauthorized",
        });
        assert.deepEqual(yield* readinessAfter(codex, [failed(codex, codexFailure)]), {
          state: "signedOut",
          source: "turn",
          message: codexFailure.message,
        });
        for (const acp of [antigravity, vibe]) {
          assert.deepEqual(yield* readinessAfter(acp, [failed(acp, ACP_SIGNED_OUT)]), {
            state: "signedOut",
            source: "turn",
            message: "Missing Authentication header",
          });
        }
        const registryFailure = acpRegistryPromptFailure(
          "codex-acp",
          new EffectAcpErrors.AcpRequestError({
            code: -32000,
            errorMessage: "Authentication required",
          }),
        );
        assert.equal(classifyTurnFailure(vibe.driver, registryFailure).state, "signedOut");
      }),
    ),
  );

  it("never signs OpenCode out from a turn", () => {
    const opencode = ProviderDriverKind.make("opencode");
    for (const candidate of [
      OPENCODE_RATE_LIMIT,
      OPENCODE_EMPTY_BALANCE,
      failure({
        class: "provider_error",
        message: "Provider rejected the request",
        code: "provider",
      }),
      failure({ class: "provider_error", message: "Unauthorized", code: "-32000" }),
      failure({ class: "provider_error", message: "Unauthorized", code: "api_error_401" }),
      failure({ class: "provider_error", message: "Unauthorized", code: "unauthorized" }),
    ]) {
      assert.notEqual(classifyTurnFailure(opencode, candidate).state, "signedOut");
    }
  });
});

describe("refusal codes by family", () => {
  const CODEX_REFUSALS = [
    "subscription_sharing_v2_user_not_eligible",
    "subscription_sharing_user_not_eligible",
    "subscription_sharing_v2_client_not_enabled",
    "subscription_sharing_v2_invalid_user",
    "subscription_sharing_invalid_user",
    "chatpass_v2_scope_not_authorized",
    "chatpass_v2_invalid_authorization_context",
  ];

  it.effect("each of the 10 refusal codes rejects the instance with that code", () =>
    withLedger(
      Effect.gen(function* () {
        const claude = makeProvider("claudeAgent");
        const codex = makeProvider("codex");
        const opencode = makeProvider("opencode");
        const { readinessAfter } = yield* makeHarness([claude, codex, opencode]);
        const refusals: Array<readonly [ServerProvider, OrchestrationV2ProviderFailure]> = [
          [
            claude,
            failure({
              class: "provider_error",
              message: "API Error: 402 Your credit balance is too low.",
              code: "api_error_402",
            }),
          ],
          [
            claude,
            failure({
              class: "provider_error",
              message:
                "Failed to authenticate. API Error: 403 Your organization does not have access to this model.",
              code: "api_error_403",
            }),
          ],
          ...CODEX_REFUSALS.map((code) => {
            const managed = classifyCodexManagedError({ error: { code } });
            assert.equal(managed?.code, code);
            return [
              codex,
              failure({ class: "provider_error", message: managed!.message, code: managed!.code }),
            ] as const;
          }),
          [opencode, OPENCODE_EMPTY_BALANCE],
        ];
        assert.equal(refusals.length, 10);
        for (const [index, [provider, refusal]] of refusals.entries()) {
          assert.deepEqual(
            yield* readinessAfter(provider, [failed(provider, refusal, at(index))]),
            {
              state: "rejected",
              code: refusal.code!,
              message: refusal.message,
              at: DateTime.formatIso(at(index)),
            },
          );
        }
      }),
    ),
  );

  it("an OpenCode provider.quota that is a usage window is outOfUsage, not rejected", () => {
    const quotaWindow = failure({
      class: "usage_limit",
      message: "Subscription quota exceeded.",
      code: "provider.quota",
    });
    assert.equal(
      classifyTurnFailure(ProviderDriverKind.make("opencode"), quotaWindow).state,
      "outOfUsage",
    );
  });

  it("never rejects an ACP-family instance", () => {
    for (const driver of ["antigravity", "acpRegistry"]) {
      for (const candidate of [
        ACP_SIGNED_OUT,
        ACP_INTERNAL,
        failure({ class: "provider_error", message: "Forbidden", code: "api_error_403" }),
        failure({
          class: "provider_error",
          message: "Not eligible",
          code: "subscription_sharing_v2_user_not_eligible",
        }),
        failure({ class: "provider_error", message: "Provider turn failed.", code: null }),
      ]) {
        assert.notEqual(
          classifyTurnFailure(ProviderDriverKind.make(driver), candidate).state,
          "rejected",
        );
      }
    }
  });
});

describe("request-level failures leave readiness unchanged", () => {
  const REQUEST_LEVEL: ReadonlyArray<readonly [string, OrchestrationV2ProviderFailure]> = [
    [
      "claudeAgent",
      failure({
        class: "provider_error",
        message: "Claude API is overloaded (529). Try again shortly.",
        code: "api_error_529",
        retryable: true,
      }),
    ],
    [
      "claudeAgent",
      failure({
        class: "provider_error",
        message: "API Error: 400 Request rejected.",
        code: "api_error_400",
      }),
    ],
    [
      "claudeAgent",
      failure({ class: "transport_error", message: "Claude API connection error.", code: null }),
    ],
    [
      "codex",
      failure({
        class: "provider_error",
        message: "Codex ran out of room in the model's context window.",
        code: "contextWindowExceeded",
      }),
    ],
    ["acpRegistry", ACP_INTERNAL],
    [
      "opencode",
      failure({
        class: "provider_error",
        message: "Provider rejected the request",
        code: "provider",
      }),
    ],
  ];

  it.each(REQUEST_LEVEL)(
    "%s classifies its request-level failure as none",
    (driver, turnFailure) => {
      assert.deepEqual(classifyTurnFailure(ProviderDriverKind.make(driver), turnFailure), {
        state: "none",
      });
    },
  );

  it.effect("a ready instance stays ready and a rejected one keeps its code", () =>
    withLedger(
      Effect.gen(function* () {
        const providers = REQUEST_LEVEL.map(([driver], index) =>
          makeProvider(driver, {}, `${driver}-${index}`),
        );
        const { readinessAfter } = yield* makeHarness(providers);
        for (const [index, [, turnFailure]] of REQUEST_LEVEL.entries()) {
          const provider = providers[index]!;
          assert.deepEqual(yield* readinessAfter(provider, [failed(provider, turnFailure)]), {
            state: "ready",
          });
        }
        const claude = providers[0]!;
        const refusal = failure({
          class: "provider_error",
          message: "API Error: 403 Forbidden.",
          code: "api_error_403",
        });
        const after = yield* readinessAfter(claude, [
          failed(claude, refusal, at(1)),
          failed(claude, REQUEST_LEVEL[1]![1], at(2)),
          failed(claude, REQUEST_LEVEL[2]![1], at(3)),
        ]);
        assert.deepInclude(after, { state: "rejected", code: "api_error_403" });
      }),
    ),
  );
});

describe("a later completion clears only its own instance", () => {
  it.effect("clears on a later completion, not on another instance or an older one", () =>
    withLedger(
      Effect.gen(function* () {
        const first = makeProvider("codex", {}, "codex");
        const second = makeProvider("codex", {}, "codex_work");
        const { readinessAfter, readinessOf } = yield* makeHarness([first, second]);
        const refusal = failure({
          class: "provider_error",
          message: "ChatGPT sharing is unavailable for this account or workspace.",
          code: "subscription_sharing_v2_user_not_eligible",
        });

        yield* readinessAfter(first, [failed(first, refusal, at(10))]);
        assert.deepInclude(yield* readinessAfter(first, [completed(second, at(20))]), {
          state: "rejected",
        });
        assert.deepEqual(yield* readinessOf(second), { state: "ready" });
        // Ingested after the failure, but the turn completed before it.
        assert.deepInclude(yield* readinessAfter(first, [completed(first, at(5))]), {
          state: "rejected",
        });
        assert.deepEqual(yield* readinessAfter(first, [completed(first, at(11))]), {
          state: "ready",
        });
      }),
    ),
  );
});

describe("a named reset expires on the clock", () => {
  it.effect("is outOfUsage until the reset, then one event publishes the snapshot state", () =>
    withLedger(
      Effect.gen(function* () {
        const claude = makeProvider("claudeAgent");
        const { registry, readinessAfter, readinessOf } = yield* makeHarness([claude]);
        const now = yield* DateTime.now;
        const resetAt = DateTime.formatIso(DateTime.add(now, { seconds: 2 }));
        const events = yield* subscribe(registry.streamChanges);

        yield* readinessAfter(claude, [failed(claude, { ...CLAUDE_USAGE_LIMIT, resetAt }, now)]);
        // Drain the event that published outOfUsage.
        const limited = yield* awaitPublished(events, (list) => stateOf(list) === "outOfUsage");
        assert.deepInclude(limited[0]?.readiness, { state: "outOfUsage", resetsAt: resetAt });

        const settled = yield* Ref.make(false);
        const next = yield* events.pipe(
          Effect.tap(() => Ref.set(settled, true)),
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.seconds(1));
        assert.deepInclude(yield* readinessOf(claude), { state: "outOfUsage", resetsAt: resetAt });
        assert.isFalse(yield* Ref.get(settled));

        yield* TestClock.adjust(Duration.millis(1_500));
        const published = yield* Fiber.join(next);
        assert.equal(published.length, 1);
        assert.deepEqual(published[0]?.[0]?.readiness, { state: "ready" });
        assert.deepEqual(yield* readinessOf(claude), { state: "ready" });
      }),
    ),
  );

  it.effect("a second failure with a later reset replaces the first", () =>
    withLedger(
      Effect.gen(function* () {
        const claude = makeProvider("claudeAgent");
        const { readinessAfter, readinessOf } = yield* makeHarness([claude]);
        const now = yield* DateTime.now;
        const first = DateTime.formatIso(DateTime.add(now, { seconds: 2 }));
        const second = DateTime.formatIso(DateTime.add(now, { seconds: 5 }));

        yield* readinessAfter(claude, [
          failed(claude, { ...CLAUDE_USAGE_LIMIT, resetAt: first }, now),
          failed(
            claude,
            { ...CLAUDE_USAGE_LIMIT, resetAt: second },
            DateTime.add(now, { seconds: 1 }),
          ),
        ]);
        yield* TestClock.adjust(Duration.seconds(3));
        assert.deepInclude(yield* readinessOf(claude), { state: "outOfUsage", resetsAt: second });
        yield* TestClock.adjust(Duration.seconds(3));
        assert.deepEqual(yield* readinessOf(claude), { state: "ready" });
      }),
    ),
  );
});

describe("snapshot states take precedence over the ledger", () => {
  it.effect("turnedOff hides a rejection, which returns when the instance is enabled", () =>
    withLedger(
      Effect.gen(function* () {
        const codex = makeProvider("codex");
        const { fake, registry, readinessAfter } = yield* makeHarness([codex]);
        const refusal = failure({
          class: "provider_error",
          message: "ChatGPT could not validate this connection.",
          code: "subscription_sharing_v2_invalid_user",
        });
        assert.deepInclude(yield* readinessAfter(codex, [failed(codex, refusal)]), {
          state: "rejected",
          code: "subscription_sharing_v2_invalid_user",
        });

        const events = yield* subscribe(registry.streamChanges);
        yield* fake.publish([{ ...codex, enabled: false }]);
        const off = yield* awaitPublished(events, (list) => stateOf(list) === "turnedOff");
        assert.deepInclude(off[0]?.readiness, { state: "turnedOff" });
        yield* fake.publish([codex]);
        const back = yield* awaitPublished(events, (list) => stateOf(list) === "rejected");
        assert.deepInclude(back[0]?.readiness, {
          state: "rejected",
          code: "subscription_sharing_v2_invalid_user",
        });
      }),
    ),
  );
});

describe("a removed instance forgets its state", () => {
  it.effect("an instance re-added under the same id starts ready", () =>
    withLedger(
      Effect.gen(function* () {
        const codex = makeProvider("codex", {}, "codex");
        const work = makeProvider("codex", {}, "codex_work");
        const { fake, registry, ledger, readinessAfter } = yield* makeHarness([codex, work]);
        const refusal = failure({
          class: "provider_error",
          message: "ChatGPT could not validate this connection.",
          code: "subscription_sharing_v2_invalid_user",
        });
        assert.deepInclude(yield* readinessAfter(work, [failed(work, refusal)]), {
          state: "rejected",
        });

        const events = yield* subscribe(registry.streamChanges);
        yield* fake.publish([codex]);
        yield* awaitPublished(events, (list) => list.length === 1);
        assert.isFalse((yield* ledger.entries).has(work.instanceId));

        yield* fake.publish([codex, work]);
        const back = yield* awaitPublished(events, (list) => list.length === 2);
        assert.deepEqual(
          back.find((provider) => provider.instanceId === work.instanceId)?.readiness,
          { state: "ready" },
        );
      }),
    ),
  );
});

describe("one log entry per readiness change", () => {
  it.effect("logs each change once with its fields and nothing for a repeat", () => {
    const entries: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ message }) => {
      const parts = Array.isArray(message) ? message : [message];
      if (parts[0] === "houston.provider-readiness.changed") {
        entries.push(parts[1] as Record<string, unknown>);
      }
    });
    return withLedger(
      Effect.gen(function* () {
        const claude = makeProvider("claudeAgent");
        const { registry, readinessAfter } = yield* makeHarness([claude]);
        const events = yield* subscribe(registry.streamChanges);
        const refusal = failure({
          class: "provider_error",
          message: "API Error: 403 Forbidden.",
          code: "api_error_403",
        });

        yield* readinessAfter(claude, [failed(claude, refusal, at(1))]);
        yield* awaitPublished(events, (list) => stateOf(list) === "rejected");
        yield* readinessAfter(claude, [failed(claude, refusal, at(1))]);
        yield* readinessAfter(claude, [failed(claude, refusal, at(2))]);
        yield* awaitPublished(
          events,
          (list) =>
            list[0]?.readiness?.state === "rejected" && list[0].readiness.at.includes(":02"),
        );
        yield* readinessAfter(claude, [completed(claude, at(3))]);
        yield* awaitPublished(events, (list) => stateOf(list) === "ready");

        assert.deepEqual(entries, [
          {
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            from: "ready",
            to: "rejected",
            code: "api_error_403",
          },
          {
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            from: "rejected",
            to: "ready",
          },
        ]);
      }),
    ).pipe(Effect.provide(Logger.layer([logger])));
  });
});

describe("concurrent reports keep the newest", () => {
  it.effect.each(["completion", "failure"] as const)(
    "20 concurrent reports end in the newest, a %s",
    (newest) =>
      withLedger(
        Effect.gen(function* () {
          const codex = makeProvider("codex");
          const { ledger, readinessOf } = yield* makeHarness([codex]);
          const refusal = (index: number) =>
            failure({
              class: "provider_error",
              message: `refusal ${index}`,
              code:
                index % 2 === 0
                  ? "subscription_sharing_v2_user_not_eligible"
                  : "chatpass_v2_scope_not_authorized",
            });
          const reports = Array.from({ length: 20 }, (_, index) =>
            index === 19
              ? newest === "completion"
                ? completed(codex, at(index))
                : failed(codex, refusal(index), at(index))
              : index % 3 === 0
                ? completed(codex, at(index))
                : failed(codex, refusal(index), at(index)),
          );
          // Newest first, so every older report arrives after it.
          yield* Effect.forEach([...reports].reverse(), ledger.report, {
            concurrency: "unbounded",
            discard: true,
          });
          const readiness = yield* readinessOf(codex);
          if (newest === "completion") {
            assert.deepEqual(readiness, { state: "ready" });
          } else {
            assert.deepEqual(readiness, {
              state: "rejected",
              code: "chatpass_v2_scope_not_authorized",
              message: "refusal 19",
              at: DateTime.formatIso(at(19)),
            });
          }
        }),
      ),
  );
});
