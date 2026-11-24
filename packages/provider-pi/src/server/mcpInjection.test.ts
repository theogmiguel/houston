import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@houston-app/contracts";

import {
  HOUSTON_GATEWAY_MODELS_ENV,
  HOUSTON_GATEWAY_PROVIDER_ENV,
  HOUSTON_GATEWAY_TOKEN_ENV,
  HOUSTON_GATEWAY_URL_ENV,
} from "./gatewayExtensionSource.ts";
import {
  HOUSTON_MCP_BEARER_ENV,
  HOUSTON_MCP_URL_ENV,
  HOUSTON_PI_RUNTIME_MODE_ENV,
  HOUSTON_PI_MCP_EXTENSION_PATH_ENV,
} from "./mcpExtensionSource.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./mcpInjection.ts";

const threadId = ThreadId.make("thread-pi-houston-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-houston-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

const gateway = {
  server: {
    serverId: "rtx",
    displayName: "rtx",
    models: [
      {
        id: "GLM-5.3-Flash",
        contextWindow: 813056,
        reasoningEfforts: ["max", "high", "low"],
      },
      { id: "plain" },
    ],
  },
  credential: {
    serverId: "rtx",
    baseUrl: "http://127.0.0.1:43123/inference/rtx/v1",
    token: "gateway-secret",
  },
};

describe("pi Houston gateway provider", () => {
  it("hands a managed server's gateway to Pi through the environment only", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-houston-mcp-extension.ts",
      gateway,
    });
    assert.notInclude(launch.args.join(" "), "gateway-secret");
    assert.equal(launch.env[HOUSTON_GATEWAY_URL_ENV], "http://127.0.0.1:43123/inference/rtx/v1");
    assert.equal(launch.env[HOUSTON_GATEWAY_TOKEN_ENV], "gateway-secret");
    assert.equal(launch.env[HOUSTON_GATEWAY_PROVIDER_ENV], "houston-rtx");
    assert.deepEqual(JSON.parse(launch.env[HOUSTON_GATEWAY_MODELS_ENV]!), [
      {
        id: "GLM-5.3-Flash",
        name: "GLM-5.3-Flash (rtx)",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 813056,
        maxTokens: 16384,
      },
      {
        id: "plain",
        name: "plain (rtx)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ]);
  });

  it("loads only the gateway extension for background processes and drops stale credentials", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: ["--extension", "/home/user/.pi/agent/extensions/demo.ts"],
      environment: { [HOUSTON_GATEWAY_TOKEN_ENV]: "inherited" },
      mcpSession: undefined,
      extensionPath: undefined,
      gatewayExtensionPath: "/tmp/cache/pi-houston-gateway-extension.ts",
      gateway,
      ephemeral: true,
      shortLived: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args.slice(-2), [
      "--extension",
      "/tmp/cache/pi-houston-gateway-extension.ts",
    ]);
    assert.equal(launch.env[HOUSTON_GATEWAY_TOKEN_ENV], "gateway-secret");

    const unmanaged = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [HOUSTON_GATEWAY_TOKEN_ENV]: "inherited",
        [HOUSTON_GATEWAY_URL_ENV]: "http://x",
      },
      mcpSession: undefined,
      extensionPath: undefined,
      gatewayExtensionPath: "/tmp/cache/pi-houston-gateway-extension.ts",
      ephemeral: true,
    });
    assert.deepEqual(unmanaged.args, ["--mode", "rpc", "--no-session"]);
    assert.isUndefined(unmanaged.env[HOUSTON_GATEWAY_TOKEN_ENV]);
    assert.isUndefined(unmanaged.env[HOUSTON_GATEWAY_URL_ENV]);
  });
});

describe("pi Houston MCP injection", () => {
  it("always adds the permission bridge and configures MCP when available", () => {
    const resolvedArgs = resolvePiLaunchArgs(
      "--extension=/home/user/.pi/agent/extensions/demo.ts --session-dir=/tmp/pi-sessions --provider=anthropic --model=claude-sonnet --tools='' --name=-review --extension-flag=kept",
    );
    assert.isTrue(resolvedArgs.ok);
    if (!resolvedArgs.ok) return;
    const launch = buildPiRpcLaunch({
      launchArgs: resolvedArgs.args,
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-houston-mcp-extension.ts",
      runtimeMode: "approval-required",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--tools",
      "",
      "--name",
      "-review",
      "--extension-flag=kept",
      "--extension",
      "/tmp/cache/pi-houston-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env[HOUSTON_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[HOUSTON_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[HOUSTON_PI_RUNTIME_MODE_ENV], "approval-required");
    assert.equal(
      launch.env[HOUSTON_PI_MCP_EXTENSION_PATH_ENV],
      "/tmp/cache/pi-houston-mcp-extension.ts",
    );

    const permissionOnly = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [HOUSTON_MCP_URL_ENV]: "http://127.0.0.1:9999/stale",
        [HOUSTON_MCP_BEARER_ENV]: "stale-token",
        [HOUSTON_PI_MCP_EXTENSION_PATH_ENV]: "/stale/extension.ts",
      },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-houston-mcp-extension.ts",
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(permissionOnly.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-houston-mcp-extension.ts",
    ]);
    assert.isUndefined(permissionOnly.env[HOUSTON_MCP_URL_ENV]);
    assert.isUndefined(permissionOnly.env[HOUSTON_MCP_BEARER_ENV]);
    assert.equal(permissionOnly.env[HOUSTON_PI_RUNTIME_MODE_ENV], "auto-accept-edits");
    assert.equal(
      permissionOnly.env[HOUSTON_PI_MCP_EXTENSION_PATH_ENV],
      "/tmp/cache/pi-houston-mcp-extension.ts",
    );
  });

  it("forces tools and user extensions off for unattended text generation", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,write",
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--extension=./second.ts",
        "--provider",
        "anthropic",
      ],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-houston-mcp-extension.ts",
      sessionPath: "/fake/persisted.jsonl",
      ephemeral: true,
      shortLived: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "anthropic",
      "--offline",
      "--no-extensions",
      "--no-tools",
    ]);
    const alreadyOffline = buildPiRpcLaunch({
      launchArgs: ["--offline"],
      environment: {},
      mcpSession: undefined,
      extensionPath: undefined,
      ephemeral: true,
      shortLived: true,
    });
    assert.deepEqual(alreadyOffline.args, ["--mode", "rpc", "--no-session", "--offline"]);
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message: "Pi launch argument '--mode' is controlled by Houston and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("--plan @instructions.md"), { ok: false });
  });

  it("rejects --provider without --model, which Pi 1.0 refuses at startup", () => {
    const rejection = {
      ok: false,
      message: "Pi launch argument '--provider' requires '--model'.",
    };
    assert.deepInclude(resolvePiLaunchArgs("--provider openrouter"), rejection);
    assert.deepInclude(resolvePiLaunchArgs("--provider=openrouter --models gpt-6"), rejection);
    assert.isTrue(resolvePiLaunchArgs("--provider openrouter --model=deepseek/v4").ok);
    assert.isTrue(resolvePiLaunchArgs("--model deepseek/v4").ok);
  });
});
