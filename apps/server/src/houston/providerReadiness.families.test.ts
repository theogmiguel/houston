// Each family's snapshot comes from that driver's own upstream probe with upstream's test
// doubles; readiness is then derived with no ledger entry.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { acpRegistryProbeFailure } from "@t3tools/provider-acp-registry/testing";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";
import { createModelCapabilities } from "@t3tools/shared/model";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as CodexErrors from "effect-codex-app-server/errors";

import { AcpRegistrySettings } from "../../../../packages/provider-acp-registry/src/settings.ts";
import * as AcpRegistrySupport from "../../../../packages/provider-acp-registry/src/server/AcpRegistrySupport.ts";
import { checkAcpRegistryProviderStatus } from "../../../../packages/provider-acp-registry/src/server/driver.ts";
import type { AcpRegistryConfigurationProbe } from "../../../../packages/provider-acp-registry/src/server/probe.ts";
import { OpenCodeSettings } from "../../../../packages/provider-opencode/src/settings.ts";
import * as OpenCodeServerOwner from "../../../../packages/provider-opencode/src/server/OpenCodeServerOwner.ts";
import {
  OPENCODE_1_RESPONSES,
  replayOpenCodeServer,
} from "../../../../packages/provider-opencode/src/server/probeResponses.fixture.ts";
import { checkOpenCodeProviderStatus } from "../../../../packages/provider-opencode/src/server/status.ts";
import { probeOpenCodeRuntime } from "../../../../packages/provider-opencode/src/server/versionProbe.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeAntigravityProvider } from "../provider/AntigravityProvider.ts";
import { checkClaudeProviderStatus } from "../provider/ClaudeProvider.ts";
import {
  checkCodexProviderStatus,
  type CodexAppServerProviderSnapshot,
} from "../provider/CodexProvider.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import { withReadiness } from "./providerReadiness.ts";

const readinessOf = (
  driver: string,
  snapshot: ServerProviderDraft | ServerProvider,
): ProviderReadiness | undefined =>
  withReadiness(
    {
      ...snapshot,
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
    } as ServerProvider,
    undefined,
  ).readiness;

const encoder = new TextEncoder();
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const layerClaudeSpawner = (
  run: (args: ReadonlyArray<string>) => { stdout: string; code: number } | "missing",
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const result = run((command as unknown as { args: ReadonlyArray<string> }).args);
      if (result === "missing") {
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(result.stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

const claudeVersionOnly = layerClaudeSpawner(() => ({ stdout: "1.0.0\n", code: 0 }));

const claudeCapabilities =
  (account: { tokenSource?: string; apiKeySource?: string; apiProvider?: string } = {}) =>
  () =>
    Effect.succeed({
      email: undefined,
      subscriptionType: undefined,
      tokenSource: account.tokenSource,
      apiKeySource: account.apiKeySource,
      apiProvider: account.apiProvider,
      slashCommands: [],
    });

const claudeSnapshot = (
  settings: { enabled?: boolean } = {},
  account?: Parameters<typeof claudeCapabilities>[0],
) =>
  checkClaudeProviderStatus(decodeClaudeSettings(settings), claudeCapabilities(account), {
    ANTHROPIC_BASE_URL: "",
  });

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const codexProbeSnapshot = (
  account: CodexAppServerProviderSnapshot["account"],
): CodexAppServerProviderSnapshot => ({
  version: "1.0.0",
  account,
  models: [
    {
      slug: "gpt-live-codex",
      name: "GPT Live Codex",
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    },
  ],
  skills: [],
});

const codexSnapshot = (
  settings: { enabled?: boolean },
  probe: Parameters<typeof checkCodexProviderStatus>[1],
) => checkCodexProviderStatus(decodeCodexSettings(settings), probe);

const codexSignedIn = () =>
  Effect.succeed(
    codexProbeSnapshot({
      account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
      requiresOpenaiAuth: false,
    }),
  );

const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

interface OpenCodeDoubleState {
  versionError: Error | null;
  connectionError: Error | null;
  inventoryError: Error | null;
  inventory: unknown;
}

const HEALTHY_OPENCODE_INVENTORY = {
  providerList: {
    connected: ["openai"],
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: { "gpt-5.4": { id: "gpt-5.4", name: "GPT-5.4", variants: {} } },
      },
    ],
    default: {},
  },
  agents: [],
  skills: [],
};

const makeOpenCodeRuntimeDouble = (
  state: OpenCodeDoubleState,
): OpenCodeRuntime.OpenCodeRuntime["Service"] => ({
  startOpenCodeServerProcess: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4301",
      version: "1.14.19",
      isRunning: Effect.succeed(true),
      exitCode: Effect.never,
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
    state.connectionError
      ? Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "global.health",
            detail: state.connectionError.message,
            cause: state.connectionError,
          }),
        )
      : Effect.succeed({
          url: serverUrl ?? "http://127.0.0.1:4301",
          ...(serverPassword ? { serverPassword } : {}),
          version: "1.14.19",
          exitCode: null,
          external: Boolean(serverUrl),
        }),
  runOpenCodeCommand: () =>
    state.versionError
      ? Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "runOpenCodeCommand",
            detail: state.versionError.message,
            cause: state.versionError,
          }),
        )
      : Effect.succeed({ stdout: "opencode 1.14.19\n", stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    ({}) as unknown as ReturnType<
      OpenCodeRuntime.OpenCodeRuntime["Service"]["createOpenCodeSdkClient"]
    >,
  loadOpenCodeInventory: () =>
    state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "loadOpenCodeInventory",
            detail: state.inventoryError.message,
            cause: state.inventoryError,
          }),
        )
      : Effect.succeed(state.inventory as OpenCodeRuntime.OpenCodeInventory),
  loadOpenCodeSkills: () => Effect.succeed([]),
});

const openCodeSnapshot = (
  settings: { enabled?: boolean; serverUrl?: string; serverPassword?: string },
  double: Partial<OpenCodeDoubleState> = {},
) => {
  const runtime = makeOpenCodeRuntimeDouble({
    versionError: null,
    connectionError: null,
    inventoryError: null,
    inventory: HEALTHY_OPENCODE_INVENTORY,
    ...double,
  });
  const openCodeSettings = decodeOpenCodeSettings({
    enabled: settings.enabled ?? true,
    binaryPath: "opencode",
    serverUrl: settings.serverUrl ?? "",
    serverPassword: settings.serverPassword ?? "",
    customModels: [],
  });
  return Effect.gen(function* () {
    const serverOwner = yield* OpenCodeServerOwner.make({
      binaryPath: openCodeSettings.binaryPath,
      directory: process.cwd(),
    });
    const probe = probeOpenCodeRuntime(openCodeSettings).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        replayOpenCodeServer(OPENCODE_1_RESPONSES, openCodeSettings.serverPassword),
      ),
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
    );
    return yield* checkOpenCodeProviderStatus(
      openCodeSettings,
      process.cwd(),
      probe,
      Effect.succeed([]),
    ).pipe(Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner));
  }).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime), Effect.scoped);
};

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const ANTIGRAVITY_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
  agentInfo: {
    name: "antigravity-acp",
    title: "Google Antigravity",
    version: "agy_acp_server_20260818_01_RC01",
  },
} satisfies EffectAcpSchema.InitializeResponse;

const layerAntigravity = ProviderHostLive.layer.pipe(
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "houston-readiness-antigravity-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

type AntigravityProbeError = EffectAcpErrors.AcpError | ProviderSetupError;

const makeAntigravity = Effect.fn("makeAntigravity")(function* (enabled: boolean) {
  const initialProbe = yield* Deferred.make<
    EffectAcpSchema.InitializeResponse,
    AntigravityProbeError
  >();
  const probe = yield* Ref.make<
    Effect.Effect<EffectAcpSchema.InitializeResponse, AntigravityProbeError>
  >(Deferred.await(initialProbe));
  const instanceId = ProviderInstanceId.make("antigravity");
  const provider = yield* makeAntigravityProvider(
    decodeAntigravitySettings({ enabled, customModels: [] }),
    {
      stampIdentity: (snapshot) =>
        Effect.succeed({ ...snapshot, instanceId, driver: ProviderDriverKind.make("antigravity") }),
      probe: Ref.get(probe).pipe(Effect.flatten),
      supportsTextGeneration: Effect.succeed(false),
    },
  );
  const firstProbe = yield* Stream.toPull(
    provider.snapshot.streamChanges.pipe(
      Stream.filter((snapshot) => snapshot.installed || snapshot.status === "error"),
    ),
  );
  const initialize = Deferred.succeed(initialProbe, ANTIGRAVITY_INITIALIZE).pipe(
    Effect.andThen(firstProbe),
    Effect.asVoid,
  );
  return { provider, probe, initialize };
});

const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);
const acpIdentity = {
  instanceId: ProviderInstanceId.make("acpRegistry"),
  displayName: "Mistral Vibe",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry",
};

const catalogWith = (
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] => ({
  search: () => Effect.die("unused search"),
  prepare: () => Effect.die("unused prepare"),
  inspect: () => Effect.succeed(inspection),
  resolve: () => Effect.die("unused resolve"),
  uninstallManagedBinary: () => Effect.die("unused uninstall"),
});

const READY_INSPECTION = {
  status: "ready",
  agentId: "mistral-vibe",
  version: "1.0.0",
  distribution: "npx",
} as const satisfies AcpRegistrySupport.AcpRegistryInspection;

const acpRegistrySnapshot = (
  enabled: boolean,
  inspection: AcpRegistrySupport.AcpRegistryInspection,
  probe: AcpRegistryConfigurationProbe,
) =>
  checkAcpRegistryProviderStatus(
    {
      ...acpIdentity,
      settings: decodeAcpRegistrySettings({ enabled, agentId: "mistral-vibe" }),
      cwd: "/workspace",
      environment: { PATH: "/provider/bin" },
    },
    probe,
  ).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalogWith(inspection)));

const acpRegistryProbed = () =>
  Effect.succeed({
    probe: {
      instanceId: acpIdentity.instanceId,
      ready: true as const,
      icon: null,
      authMethods: [],
      models: [{ id: "devstral", name: "Devstral", description: null }],
      currentModelId: "devstral",
      configOptions: [],
      sessionManagement: {
        canList: false,
        canLoad: false,
        canResume: false,
        canLogout: false,
        canDelete: false,
        canConfigureProviders: false,
      },
    },
    slashCommands: [],
    skills: [],
  });

const acpRegistryUnused = () => Effect.die("the probe must not run");

describe("a missing CLI is notInstalled for every family", () => {
  it.effect("Claude", () =>
    Effect.gen(function* () {
      const snapshot = yield* claudeSnapshot();
      assert.isFalse(snapshot.installed);
      assert.deepInclude(readinessOf("claudeAgent", snapshot), {
        state: "notInstalled",
        reason: "missing",
        message: "Claude Agent CLI (`claude`) was not found on PATH.",
      });
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          layerClaudeSpawner(() => "missing"),
        ),
      ),
    ),
  );

  it.effect("Codex", () =>
    Effect.gen(function* () {
      const snapshot = yield* codexSnapshot({}, () =>
        Effect.fail(
          new CodexErrors.CodexAppServerSpawnError({
            command: "codex app-server",
            cause: new Error("spawn codex ENOENT"),
          }),
        ),
      );
      assert.isFalse(snapshot.installed);
      assert.deepInclude(readinessOf("codex", snapshot), {
        state: "notInstalled",
        reason: "missing",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("OpenCode", () =>
    Effect.gen(function* () {
      const snapshot = yield* openCodeSnapshot(
        {},
        { versionError: new Error("spawn opencode ENOENT") },
      );
      assert.isFalse(snapshot.installed);
      assert.deepEqual(readinessOf("opencode", snapshot), {
        state: "notInstalled",
        reason: "missing",
        message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.layer(layerAntigravity)("Antigravity", (it) => {
    it.effect("a missing executable", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const antigravity = yield* makeAntigravity(true);
          yield* antigravity.initialize;
          yield* Ref.set(
            antigravity.probe,
            Effect.fail(new EffectAcpErrors.AcpSpawnError({ cause: { code: "ENOENT" } })),
          );
          const snapshot = yield* antigravity.provider.snapshot.refresh;
          assert.isFalse(snapshot.installed);
          assert.deepInclude(readinessOf("antigravity", snapshot), {
            state: "notInstalled",
            reason: "missing",
          });
        }),
      ),
    );
  });

  it.effect("ACP registry driver", () =>
    Effect.gen(function* () {
      const snapshot = yield* acpRegistrySnapshot(
        true,
        {
          status: "missing_runner",
          agentId: "mistral-vibe",
          version: "1.0.0",
          distribution: "npx",
          runner: "npx",
        },
        acpRegistryUnused,
      );
      assert.deepEqual(readinessOf("acpRegistry", snapshot), {
        state: "notInstalled",
        reason: "missing",
        message: "ACP executable 'npx' is not available on this environment's PATH.",
      });
    }),
  );
});

describe("a signed-out probe is signedOut for every family", () => {
  it.effect("Claude", () =>
    Effect.gen(function* () {
      const snapshot = yield* claudeSnapshot(
        {},
        { tokenSource: "none", apiKeySource: "none", apiProvider: "firstParty" },
      );
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.deepInclude(readinessOf("claudeAgent", snapshot), {
        state: "signedOut",
        source: "probe",
      });
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, claudeVersionOnly))),
  );

  it.effect("Codex", () =>
    Effect.gen(function* () {
      const snapshot = yield* codexSnapshot({}, () =>
        Effect.succeed(codexProbeSnapshot({ account: null, requiresOpenaiAuth: true })),
      );
      assert.deepEqual(readinessOf("codex", snapshot), {
        state: "signedOut",
        source: "probe",
        message: "Codex CLI is not authenticated. Run `codex login` and try again.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("OpenCode with an external server answering 401", () =>
    Effect.gen(function* () {
      const snapshot = yield* openCodeSnapshot(
        { serverUrl: "http://127.0.0.1:9999" },
        { connectionError: new Error("401 Unauthorized") },
      );
      assert.deepEqual(readinessOf("opencode", snapshot), {
        state: "signedOut",
        source: "probe",
        message: "OpenCode server rejected authentication. Check the server URL and password.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.layer(layerAntigravity)("Antigravity", (it) => {
    it.effect("signed out after initialize", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const antigravity = yield* makeAntigravity(true);
          yield* antigravity.initialize;
          yield* antigravity.provider.onSignedOut;
          const snapshot = yield* antigravity.provider.snapshot.getSnapshot;
          assert.equal(snapshot.auth.status, "unauthenticated");
          assert.deepInclude(readinessOf("antigravity", snapshot), {
            state: "signedOut",
            source: "probe",
          });
        }),
      ),
    );
  });

  it.effect("ACP registry driver", () =>
    Effect.gen(function* () {
      const snapshot = yield* acpRegistrySnapshot(true, READY_INSPECTION, () =>
        Effect.fail(
          acpRegistryProbeFailure(
            new EffectAcpErrors.AcpRequestError({
              code: -32000,
              errorMessage: "Authentication required",
            }),
          ),
        ),
      );
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.deepInclude(readinessOf("acpRegistry", snapshot), {
        state: "signedOut",
        source: "probe",
      });
    }),
  );
});

describe("local OpenCode refuses a probe-time signedOut", () => {
  it.effect.each([
    {
      name: "an auth-shaped version failure",
      double: { versionError: new Error("401 Unauthorized") },
    },
    {
      name: "an auth-shaped inventory failure",
      double: { inventoryError: new Error("Request failed with status code 401") },
    },
    { name: "a missing CLI", double: { versionError: new Error("spawn opencode ENOENT") } },
    { name: "a healthy server", double: {} },
  ])("$name never yields signedOut", ({ double }) =>
    Effect.gen(function* () {
      const snapshot = yield* openCodeSnapshot({}, double);
      assert.notEqual(snapshot.auth.status, "unauthenticated");
      assert.notEqual(readinessOf("opencode", snapshot)?.state, "signedOut");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("turning a provider off and on for every family", () => {
  it.effect("Claude", () =>
    Effect.gen(function* () {
      assert.deepInclude(readinessOf("claudeAgent", yield* claudeSnapshot({ enabled: false })), {
        state: "turnedOff",
      });
      assert.deepEqual(readinessOf("claudeAgent", yield* claudeSnapshot({ enabled: true })), {
        state: "ready",
      });
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, claudeVersionOnly))),
  );

  it.effect("Codex", () =>
    Effect.gen(function* () {
      assert.deepInclude(
        readinessOf("codex", yield* codexSnapshot({ enabled: false }, codexSignedIn)),
        { state: "turnedOff" },
      );
      assert.deepEqual(
        readinessOf("codex", yield* codexSnapshot({ enabled: true }, codexSignedIn)),
        {
          state: "ready",
        },
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("OpenCode", () =>
    Effect.gen(function* () {
      assert.deepInclude(readinessOf("opencode", yield* openCodeSnapshot({ enabled: false })), {
        state: "turnedOff",
      });
      assert.deepEqual(readinessOf("opencode", yield* openCodeSnapshot({ enabled: true })), {
        state: "ready",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.layer(layerAntigravity)("Antigravity", (it) => {
    it.effect("off, then on", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const off = yield* makeAntigravity(false);
          assert.deepInclude(readinessOf("antigravity", yield* off.provider.snapshot.refresh), {
            state: "turnedOff",
          });
          const on = yield* makeAntigravity(true);
          yield* on.initialize;
          assert.deepEqual(readinessOf("antigravity", yield* on.provider.snapshot.getSnapshot), {
            state: "ready",
          });
        }),
      ),
    );
  });

  it.effect("ACP registry driver", () =>
    Effect.gen(function* () {
      assert.deepInclude(
        readinessOf(
          "acpRegistry",
          yield* acpRegistrySnapshot(false, READY_INSPECTION, acpRegistryUnused),
        ),
        { state: "turnedOff" },
      );
      assert.deepEqual(
        readinessOf(
          "acpRegistry",
          yield* acpRegistrySnapshot(true, READY_INSPECTION, acpRegistryProbed),
        ),
        { state: "ready" },
      );
    }),
  );
});

describe("a healthy probe is ready for every family", () => {
  it.effect("Claude", () =>
    Effect.gen(function* () {
      const snapshot = yield* claudeSnapshot();
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(readinessOf("claudeAgent", snapshot), { state: "ready" });
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, claudeVersionOnly))),
  );

  it.effect("Codex", () =>
    Effect.gen(function* () {
      const snapshot = yield* codexSnapshot({}, codexSignedIn);
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(readinessOf("codex", snapshot), { state: "ready" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("OpenCode", () =>
    Effect.gen(function* () {
      const snapshot = yield* openCodeSnapshot({});
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(readinessOf("opencode", snapshot), { state: "ready" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.layer(layerAntigravity)("Antigravity", (it) => {
    it.effect("a warning with sign-in not checked is ready", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const antigravity = yield* makeAntigravity(true);
          yield* antigravity.initialize;
          const snapshot = yield* antigravity.provider.snapshot.getSnapshot;
          assert.equal(snapshot.status, "warning");
          assert.equal(snapshot.auth.status, "unknown");
          assert.deepEqual(readinessOf("antigravity", snapshot), { state: "ready" });
        }),
      ),
    );
  });

  it.effect("ACP registry driver", () =>
    Effect.gen(function* () {
      const snapshot = yield* acpRegistrySnapshot(true, READY_INSPECTION, acpRegistryProbed);
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(readinessOf("acpRegistry", snapshot), { state: "ready" });
    }),
  );
});
