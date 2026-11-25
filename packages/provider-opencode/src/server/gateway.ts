import type { ProviderInstanceId } from "@houston-app/contracts";
import * as InferenceGateway from "@houston-app/provider-core/server/inferenceGateway";
import type { McpProviderSessionConfig } from "@houston-app/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

/** OpenCode reads the key through `{env:...}`, so the token never lands in its config. */
export const OPENCODE_GATEWAY_TOKEN_ENV = "HOUSTON_INFERENCE_TOKEN";

const openCodeGatewayProviderId = (serverId: string) => `houston-${serverId}`;

function parseConfigObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds `houston-<serverId>` to the OPENCODE_CONFIG_CONTENT overlay, keeping the user's overlay.
 * OpenCode merges it over its config files; 2.x still reads this `provider` shape.
 */
export function withOpenCodeGateway(
  environment: NodeJS.ProcessEnv,
  gateway: InferenceGateway.ManagedServerCredential | undefined,
): NodeJS.ProcessEnv {
  if (gateway === undefined) return environment;
  const overlay = parseConfigObject(environment.OPENCODE_CONFIG_CONTENT ?? "{}");
  // An overlay Houston cannot parse stays the user's; OpenCode then runs unmanaged.
  if (overlay === undefined) return environment;
  const { server, credential } = gateway;
  const providers =
    typeof overlay.provider === "object" && overlay.provider !== null ? overlay.provider : {};
  return {
    ...environment,
    [OPENCODE_GATEWAY_TOKEN_ENV]: credential.token,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...overlay,
      provider: {
        ...providers,
        [openCodeGatewayProviderId(server.serverId)]: {
          npm: "@ai-sdk/openai-compatible",
          name: `${server.displayName} (Houston)`,
          options: {
            baseURL: credential.baseUrl,
            apiKey: `{env:${OPENCODE_GATEWAY_TOKEN_ENV}}`,
          },
          models: Object.fromEntries(
            server.models.map((model) => [
              model.id,
              {
                name: model.id,
                ...(model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0
                  ? {}
                  : { reasoning: true }),
                ...(model.images === false
                  ? {}
                  : {
                      attachment: true,
                      modalities: { input: ["text", "image"], output: ["text"] },
                    }),
                ...(model.contextWindow === undefined
                  ? {}
                  : {
                      limit: {
                        context: model.contextWindow,
                        output: Math.min(
                          model.maxOutputTokens ?? model.contextWindow,
                          model.contextWindow,
                        ),
                      },
                    }),
              },
            ]),
          ),
        },
      },
    }),
  };
}

export interface OpenCodeGatewaySource {
  /** Undefined when the instance is not linked to an inference server. */
  readonly resolution: Effect.Effect<InferenceGateway.ManagedServerResolution | undefined>;
  /**
   * For an OpenCode server process Houston starts: one credential per process, attributed to the
   * instance, revoked when the process scope closes.
   */
  readonly forProcess: (
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<NodeJS.ProcessEnv, never, Scope.Scope>;
  /** Changes when the managed server or its models do, so an idle shared process is restarted. */
  readonly processKey: Effect.Effect<string>;
  /** A process serving one thread uses the credential minted with that thread's MCP session. */
  readonly forSession: (
    environment: NodeJS.ProcessEnv,
    mcpSession: McpProviderSessionConfig | undefined,
  ) => Effect.Effect<NodeJS.ProcessEnv>;
}

export const unmanagedOpenCodeGatewaySource: OpenCodeGatewaySource = {
  resolution: Effect.undefined,
  forProcess: Effect.succeed,
  processKey: Effect.succeed(""),
  forSession: Effect.succeed,
};

/** Without Houston's gateway service (tests, other hosts) OpenCode runs unmanaged. */
export const makeOpenCodeGatewaySource = Effect.fn("makeOpenCodeGatewaySource")(function* (
  instanceId: ProviderInstanceId,
) {
  const access = yield* Effect.serviceOption(InferenceGateway.InferenceGatewayAccess);
  if (Option.isNone(access)) return unmanagedOpenCodeGatewaySource;
  const gateway = access.value;
  return {
    resolution: gateway.resolve(instanceId, "chat-completions"),
    processKey: gateway
      .resolve(instanceId, "chat-completions")
      .pipe(Effect.map((resolution) => JSON.stringify(resolution ?? null))),
    forProcess: (environment) =>
      gateway
        .instanceCredential(instanceId, "chat-completions")
        .pipe(Effect.map((held) => withOpenCodeGateway(environment, held))),
    forSession: Effect.fn("OpenCodeGateway.forSession")(function* (environment, mcpSession) {
      const credential = mcpSession?.inferenceGateway;
      if (credential === undefined) return environment;
      const server = yield* gateway.managedServer(instanceId, "chat-completions");
      return server?.serverId === credential.serverId
        ? withOpenCodeGateway(environment, { server, credential })
        : environment;
    }),
  } satisfies OpenCodeGatewaySource;
});
