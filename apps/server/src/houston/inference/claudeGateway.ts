import type { ProviderInstanceId, ServerProviderModel } from "@houston-app/contracts";
import * as InferenceGateway from "@houston-app/provider-core/server/inferenceGateway";
import type { McpProviderSessionConfig } from "@houston-app/provider-core/server/mcpSession";
import { createModelCapabilities } from "@houston-app/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

/** Claude Code reads its Anthropic credentials from these, never from argv or settings files. */
export const CLAUDE_GATEWAY_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const CLAUDE_GATEWAY_BASE_URL_ENV = "ANTHROPIC_BASE_URL";

const TRAILING_SLASHES = /\/+$/;
const TRAILING_V1 = /\/v1$/;

/** The gateway route without `/v1`: Claude Code appends `/v1/messages` itself. */
export function claudeGatewayBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(TRAILING_SLASHES, "").replace(TRAILING_V1, "");
}

export interface ClaudeGateway {
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Points Claude Code at Houston's gateway. A previous base URL or API key would send the session
 * elsewhere, so it is replaced; Bedrock and Vertex switches are cleared for the same reason.
 */
export function claudeGatewayEnvironment(
  environment: NodeJS.ProcessEnv,
  gateway: InferenceGateway.ManagedServerCredential,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...environment,
    [CLAUDE_GATEWAY_BASE_URL_ENV]: claudeGatewayBaseUrl(gateway.credential.baseUrl),
    [CLAUDE_GATEWAY_TOKEN_ENV]: gateway.credential.token,
  };
  delete next.ANTHROPIC_API_KEY;
  delete next.CLAUDE_CODE_USE_BEDROCK;
  delete next.CLAUDE_CODE_USE_VERTEX;
  return next;
}

export interface ClaudeGatewaySource {
  /** Undefined when the instance is not linked to an inference server. */
  readonly resolution: Effect.Effect<InferenceGateway.ManagedServerResolution | undefined>;
  /** A thread session uses the credential minted with its MCP session. */
  readonly forSession: (
    environment: NodeJS.ProcessEnv,
    mcpSession: McpProviderSessionConfig | undefined,
  ) => Effect.Effect<ClaudeGateway | undefined>;
  /** Text generation borrows a background credential for the scope. */
  readonly forBackground: (
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<ClaudeGateway | undefined, never, Scope.Scope>;
  /**
   * Why Claude must not run without the gateway right now, or undefined when its own login may run
   * it. Without the gateway Claude would use the cloud, so a local link refuses.
   */
  readonly withoutGateway: Effect.Effect<string | undefined>;
}

/** A linked instance may fall back to its own login only once the user disabled its server. */
export function claudeWithoutGatewayRefusal(
  resolution: InferenceGateway.ManagedServerResolution | undefined,
): string | undefined {
  if (resolution === undefined) return undefined;
  if (resolution.managed) {
    return "Houston could not route this request through its gateway, and this Claude instance runs local models, so it does not use the cloud instead.";
  }
  return resolution.local
    ? `${resolution.reason} This Claude instance runs local models, so it waits instead of using the cloud.`
    : undefined;
}

const unmanaged: ClaudeGatewaySource = {
  resolution: Effect.undefined,
  forSession: () => Effect.undefined,
  forBackground: () => Effect.undefined,
  withoutGateway: Effect.undefined,
};

/** Without Houston's gateway service (tests, other hosts) Claude runs unmanaged, as before. */
export const makeClaudeGatewaySource = Effect.fn("ClaudeGateway.makeSource")(function* (
  instanceId: ProviderInstanceId,
) {
  const access = yield* Effect.serviceOption(InferenceGateway.InferenceGatewayAccess);
  if (Option.isNone(access)) return unmanaged;
  const gateway = access.value;
  return {
    resolution: gateway.resolve(instanceId, "messages"),
    forSession: Effect.fn("ClaudeGateway.forSession")(function* (environment, mcpSession) {
      const credential = mcpSession?.inferenceGateway;
      if (credential === undefined) return undefined;
      const server = yield* gateway.managedServer(instanceId, "messages");
      if (server?.serverId !== credential.serverId) return undefined;
      return { environment: claudeGatewayEnvironment(environment, { server, credential }) };
    }),
    forBackground: Effect.fn("ClaudeGateway.forBackground")(function* (environment) {
      const held = yield* gateway.backgroundCredential(instanceId, "messages");
      return held === undefined
        ? undefined
        : { environment: claudeGatewayEnvironment(environment, held) };
    }),
    withoutGateway: gateway
      .resolve(instanceId, "messages")
      .pipe(Effect.map(claudeWithoutGatewayRefusal)),
  } satisfies ClaudeGatewaySource;
});

/**
 * A managed instance offers only its server's models and needs no Claude login; otherwise the
 * status says why the link is not used, and a local link waits rather than calling the cloud.
 */
export function withClaudeGatewayStatus<
  Draft extends {
    readonly enabled: boolean;
    readonly message?: string | undefined;
    readonly models: ReadonlyArray<ServerProviderModel>;
    readonly status: "ready" | "warning" | "error" | "disabled";
    readonly auth: { readonly status: "authenticated" | "unauthenticated" | "unknown" };
    readonly installed: boolean;
    readonly version: string | null;
  },
>(draft: Draft, resolution: InferenceGateway.ManagedServerResolution | undefined): Draft {
  if (resolution === undefined || !draft.enabled) return draft;
  if (!resolution.managed) {
    const note = resolution.local
      ? `${resolution.reason} Claude waits for it instead of running in the cloud.`
      : `${resolution.reason} Claude runs unmanaged.`;
    return {
      ...draft,
      message: draft.message ? `${draft.message} ${note}` : note,
      ...(resolution.local
        ? {
            models: [],
            status: "warning" as const,
            auth: { status: "unknown" as const },
          }
        : {}),
    };
  }
  const { displayName, models } = resolution.server;
  const note = `Experimental: Houston runs Claude on ${displayName} through its gateway.`;
  return {
    ...draft,
    message: draft.installed ? note : draft.message ? `${draft.message} ${note}` : note,
    ...(draft.installed
      ? {
          status: "ready" as const,
          auth: { status: "authenticated" as const, type: "customEndpoint", label: "Model server" },
        }
      : {}),
    models: models.map((model, index) => ({
      slug: model.id,
      name: model.id,
      subProvider: displayName,
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    })),
  };
}
