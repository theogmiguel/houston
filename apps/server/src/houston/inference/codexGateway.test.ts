import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProviderModel } from "@houston-app/contracts";
import * as InferenceGateway from "@houston-app/provider-core/server/inferenceGateway";
import type { McpProviderSessionConfig } from "@houston-app/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import {
  CODEX_GATEWAY_TOKEN_ENV,
  codexGatewayLaunch,
  codexModelCatalog,
  codexWithoutGatewayRefusal,
  makeCodexGatewaySource,
  withCodexGatewayStatus,
} from "./codexGateway.ts";

const server: InferenceGateway.ManagedInferenceServer = {
  serverId: "rtx",
  displayName: "rtx",
  models: [
    {
      id: "GLM-5.3-Flash",
      contextWindow: 813056,
      maxOutputTokens: 131072,
      reasoningEfforts: ["max", "high", "turbo", "low"],
    },
    { id: "tiny", contextWindow: 32768 },
  ],
};
const credential = {
  serverId: "rtx",
  baseUrl: "http://houston/inference/rtx/v1",
  token: "secret",
};

it("points app-server at the gateway's Responses route with the token only in env", () => {
  const launch = codexGatewayLaunch({ server, credential });
  expect(launch).toEqual({
    args: [
      "-c",
      'model_providers.houston-rtx={name="rtx (Houston)",base_url="http://houston/inference/rtx/v1",wire_api="responses",env_key="HOUSTON_INFERENCE_TOKEN"}',
      "-c",
      'model_provider="houston-rtx"',
      "-c",
      "features.multi_agent=false",
      "-c",
      'web_search="disabled"',
      "-c",
      "model_context_window=32768",
    ],
    environment: { [CODEX_GATEWAY_TOKEN_ENV]: "secret" },
  });
  expect(launch.args.join(" ")).not.toContain("secret");
  const unsized = codexGatewayLaunch({
    server: { ...server, models: [{ id: "tiny" }] },
    credential,
  });
  expect(unsized.args.some((arg) => arg.startsWith("model_context_window"))).toBe(false);
  const catalogued = codexGatewayLaunch({ server, credential }, "/cache/rtx.json");
  expect(catalogued.args.slice(-2)).toEqual(["-c", 'model_catalog_json="/cache/rtx.json"']);
  expect(catalogued.args.some((arg) => arg.startsWith("model_context_window"))).toBe(false);
});

it("a catalog gives each served model its own window and only the efforts Codex knows", () => {
  const [glm, tiny] = codexModelCatalog(server).models;
  expect(glm).toMatchObject({
    slug: "GLM-5.3-Flash",
    context_window: 813056,
    supported_reasoning_levels: [
      { effort: "max", description: "max" },
      { effort: "high", description: "high" },
      { effort: "low", description: "low" },
    ],
    input_modalities: ["text"],
    experimental_supported_tools: [],
  });
  expect(glm?.base_instructions.length).toBeGreaterThan(0);
  expect(tiny).toMatchObject({ context_window: 32768, supported_reasoning_levels: [] });
});

it.effect("a session gets the catalog only from a Codex that reads it, and never fails on it", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const access = InferenceGateway.InferenceGatewayAccess.of({
      resolve: () => Effect.succeed({ managed: true, server }),
      managedServer: () => Effect.succeed(server),
      backgroundCredential: () => Effect.die("unused"),
      instanceCredential: () => Effect.die("unused"),
      attributeSessions: () => Effect.void,
    });
    const launchWith = (version: string | undefined, catalogDirectory = directory) =>
      makeCodexGatewaySource(ProviderInstanceId.make("codex_local"), {
        directory: catalogDirectory,
        codexVersion: Effect.succeed(version),
      }).pipe(
        Effect.flatMap((source) =>
          source.forSession({ inferenceGateway: credential } as McpProviderSessionConfig),
        ),
        Effect.provideService(InferenceGateway.InferenceGatewayAccess, access),
        Effect.map((launch) => launch?.args.at(-1)),
      );

    const catalogArg = yield* launchWith("0.167.0");
    const catalogPath = JSON.parse(catalogArg!.slice("model_catalog_json=".length)) as string;
    expect(path.dirname(catalogPath)).toBe(directory);
    expect(JSON.parse(yield* fileSystem.readFileString(catalogPath))).toEqual(
      codexModelCatalog(server),
    );
    expect(yield* launchWith("0.167.0")).toBe(catalogArg);
    expect(yield* fileSystem.readDirectory(directory)).toEqual([path.basename(catalogPath)]);

    expect(yield* launchWith("0.165.2")).toBe("model_context_window=32768");
    expect(yield* launchWith(undefined)).toBe("model_context_window=32768");
    const notADirectory = path.join(directory, path.basename(catalogPath));
    expect(yield* launchWith("0.167.0", notADirectory)).toBe("model_context_window=32768");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a session launches managed only with its own credential for a Responses server", () =>
  Effect.gen(function* () {
    const sourceFor = (resolution: InferenceGateway.ManagedServerResolution) =>
      makeCodexGatewaySource(ProviderInstanceId.make("codex_local")).pipe(
        Effect.provideService(
          InferenceGateway.InferenceGatewayAccess,
          InferenceGateway.InferenceGatewayAccess.of({
            resolve: () => Effect.succeed(resolution),
            managedServer: (_, protocol) =>
              Effect.succeed(
                resolution.managed && protocol === "responses" ? resolution.server : undefined,
              ),
            backgroundCredential: () => Effect.die("unused"),
            instanceCredential: () => Effect.die("unused"),
            attributeSessions: () => Effect.die("unused"),
          }),
        ),
      );
    type Session = McpProviderSessionConfig;
    const session = { inferenceGateway: credential } as Session;

    const managed = yield* sourceFor({ managed: true, server });
    expect((yield* managed.forSession(session))?.environment).toEqual({
      [CODEX_GATEWAY_TOKEN_ENV]: "secret",
    });
    expect(yield* managed.forSession(undefined)).toBeUndefined();
    expect(
      yield* managed.forSession({
        inferenceGateway: { ...credential, serverId: "spark1" },
      } as Session),
    ).toBeUndefined();

    const noResponses = yield* sourceFor({ managed: false, reason: "No Responses API." });
    expect(yield* noResponses.forSession(session)).toBeUndefined();
  }),
);

it("a managed status offers the server's models; an unmanaged one says why", () => {
  const draft = { enabled: true, message: "Signed in.", models: [] as ServerProviderModel[] };
  const managed = withCodexGatewayStatus(draft, { managed: true, server });
  expect(managed.message).toMatch(/^Experimental: /);
  expect(managed.models.map((model) => [model.slug, model.isDefault])).toEqual([
    ["GLM-5.3-Flash", true],
    ["tiny", undefined],
  ]);
  expect(
    withCodexGatewayStatus(draft, { managed: false, reason: "No Responses API." }).message,
  ).toBe("Signed in. No Responses API. Codex runs unmanaged.");
  const cloudModels = { ...draft, models: managed.models };
  const waiting = withCodexGatewayStatus(cloudModels, {
    managed: false,
    reason: "Inference server rtx is not ready.",
    local: true,
  });
  expect(waiting.message).toBe(
    "Signed in. Inference server rtx is not ready. Codex waits for it instead of running in the cloud.",
  );
  expect(waiting.models).toEqual([]);
  expect(withCodexGatewayStatus(draft, undefined)).toBe(draft);
});

it("lets Codex use its own login without the gateway only once the server is disabled", () => {
  expect(codexWithoutGatewayRefusal(undefined)).toBeUndefined();
  expect(
    codexWithoutGatewayRefusal({ managed: false, reason: "Inference server rtx is disabled." }),
  ).toBeUndefined();
  expect(codexWithoutGatewayRefusal({ managed: false, reason: "Not ready.", local: true })).toMatch(
    /waits instead of using the cloud/,
  );
  expect(codexWithoutGatewayRefusal({ managed: true, server })).toMatch(/does not use the cloud/);
});
