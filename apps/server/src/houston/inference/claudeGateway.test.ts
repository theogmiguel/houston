import { it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProviderModel } from "@houston-app/contracts";
import * as InferenceGateway from "@houston-app/provider-core/server/inferenceGateway";
import type { McpProviderSessionConfig } from "@houston-app/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import {
  CLAUDE_GATEWAY_BASE_URL_ENV,
  CLAUDE_GATEWAY_TOKEN_ENV,
  claudeGatewayBaseUrl,
  claudeGatewayEnvironment,
  claudeWithoutGatewayRefusal,
  makeClaudeGatewaySource,
  withClaudeGatewayStatus,
} from "./claudeGateway.ts";

const server: InferenceGateway.ManagedInferenceServer = {
  serverId: "rtx",
  displayName: "rtx",
  models: [{ id: "GLM-5.3-Flash", contextWindow: 131072 }],
};
const credential = {
  serverId: "rtx",
  baseUrl: "http://houston/inference/rtx/v1",
  token: "secret",
};

it("points Claude at the gateway route without /v1 and keeps the token out of argv", () => {
  expect(claudeGatewayBaseUrl(credential.baseUrl)).toBe("http://houston/inference/rtx");
  expect(
    claudeGatewayEnvironment(
      {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "cloud-key",
        CLAUDE_CODE_USE_BEDROCK: "1",
        PATH: "/bin",
      },
      { server, credential },
    ),
  ).toEqual({
    PATH: "/bin",
    [CLAUDE_GATEWAY_BASE_URL_ENV]: "http://houston/inference/rtx",
    [CLAUDE_GATEWAY_TOKEN_ENV]: "secret",
  });
});

it.effect("a session uses only its own credential for a Messages server", () =>
  Effect.gen(function* () {
    const sourceFor = (resolution: InferenceGateway.ManagedServerResolution) =>
      makeClaudeGatewaySource(ProviderInstanceId.make("claude_local")).pipe(
        Effect.provideService(
          InferenceGateway.InferenceGatewayAccess,
          InferenceGateway.InferenceGatewayAccess.of({
            resolve: () => Effect.succeed(resolution),
            managedServer: (_, protocol) =>
              Effect.succeed(
                resolution.managed && protocol === "messages" ? resolution.server : undefined,
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
    expect((yield* managed.forSession({}, session))?.environment).toMatchObject({
      [CLAUDE_GATEWAY_TOKEN_ENV]: "secret",
      [CLAUDE_GATEWAY_BASE_URL_ENV]: "http://houston/inference/rtx",
    });
    expect(yield* managed.forSession({}, undefined)).toBeUndefined();
    expect(
      yield* managed.forSession({}, {
        inferenceGateway: { ...credential, serverId: "spark1" },
      } as Session),
    ).toBeUndefined();
    const noMessages = yield* sourceFor({
      managed: false,
      reason: "Inference server rtx does not serve the Anthropic Messages API Claude needs.",
      local: true,
    });
    expect(yield* noMessages.forSession({}, session)).toBeUndefined();
  }),
);

it("a managed status offers the server's models; a local link waits", () => {
  const draft = {
    enabled: true,
    installed: true,
    version: "2.0.0",
    status: "ready" as const,
    auth: { status: "unauthenticated" as const },
    message: undefined,
    models: [] as ServerProviderModel[],
  };
  const managed = withClaudeGatewayStatus(draft, { managed: true, server });
  expect(managed.message).toMatch(/^Experimental: /);
  expect(managed.status).toBe("ready");
  expect(managed.auth.status).toBe("authenticated");
  expect(managed.models.map((model) => [model.slug, model.isDefault])).toEqual([
    ["GLM-5.3-Flash", true],
  ]);
  const waiting = withClaudeGatewayStatus(
    { ...draft, models: managed.models },
    {
      managed: false,
      reason: "Inference server rtx is not ready.",
      local: true,
    },
  );
  expect(waiting.message).toContain("Claude waits for it instead of running in the cloud.");
  expect(waiting.models).toEqual([]);
  expect(waiting.status).toBe("warning");
  const disabled = withClaudeGatewayStatus(draft, {
    managed: false,
    reason: "Inference server rtx is disabled.",
  });
  expect(disabled.message).toBe("Inference server rtx is disabled. Claude runs unmanaged.");
  expect(withClaudeGatewayStatus(draft, undefined)).toBe(draft);
});

it("only a disabled server lets Claude use its own login", () => {
  expect(claudeWithoutGatewayRefusal(undefined)).toBeUndefined();
  expect(
    claudeWithoutGatewayRefusal({ managed: false, reason: "Inference server rtx is disabled." }),
  ).toBeUndefined();
  expect(
    claudeWithoutGatewayRefusal({ managed: false, reason: "Not ready.", local: true }),
  ).toMatch(/waits instead of using the cloud/);
  expect(claudeWithoutGatewayRefusal({ managed: true, server })).toMatch(/does not use the cloud/);
});
