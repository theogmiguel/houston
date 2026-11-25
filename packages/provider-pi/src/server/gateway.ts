import type { ProviderInstanceId } from "@houston-app/contracts";
import * as InferenceGateway from "@houston-app/provider-core/server/inferenceGateway";
import type { McpProviderSessionConfig } from "@houston-app/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import { materializePiHoustonGatewayExtension, type PiGatewayLaunch } from "./mcpInjection.ts";

export interface PiBackgroundGateway extends PiGatewayLaunch {
  readonly extensionPath: string;
}

export interface PiGatewaySource {
  /** What the instance's link resolves to; undefined when it is not linked. */
  readonly resolution: Effect.Effect<InferenceGateway.ManagedServerResolution | undefined>;
  /** A thread session's gateway, using the credential minted with its MCP session. */
  readonly forSession: (
    mcpSession: McpProviderSessionConfig | undefined,
  ) => Effect.Effect<PiGatewayLaunch | undefined>;
  /** Discovery and text generation borrow a background credential for the scope. */
  readonly forBackground: Effect.Effect<PiBackgroundGateway | undefined, never, Scope.Scope>;
}

const unmanaged: PiGatewaySource = {
  resolution: Effect.undefined,
  forSession: () => Effect.undefined,
  forBackground: Effect.undefined,
};

/** Without Houston's gateway service (tests, other hosts) Pi runs unmanaged, as before. */
export const makePiGatewaySource = Effect.fn("makePiGatewaySource")(function* (
  instanceId: ProviderInstanceId,
  cacheDir: string,
) {
  const access = yield* Effect.serviceOption(InferenceGateway.InferenceGatewayAccess);
  if (Option.isNone(access)) return unmanaged;
  const fileSystem = yield* FileSystem.FileSystem;
  return {
    resolution: access.value.resolve(instanceId, "chat-completions"),
    forSession: Effect.fn("PiGateway.forSession")(function* (mcpSession) {
      const credential = mcpSession?.inferenceGateway;
      if (credential === undefined) return undefined;
      const server = yield* access.value.managedServer(instanceId, "chat-completions");
      return server?.serverId === credential.serverId ? { server, credential } : undefined;
    }),
    forBackground: Effect.gen(function* () {
      const background = yield* access.value.backgroundCredential(instanceId, "chat-completions");
      if (background === undefined) return undefined;
      const extensionPath = yield* materializePiHoustonGatewayExtension(cacheDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.option,
      );
      return Option.isNone(extensionPath)
        ? undefined
        : { ...background, extensionPath: extensionPath.value };
    }).pipe(Effect.withSpan("PiGateway.forBackground")),
  } satisfies PiGatewaySource;
});

export const unmanagedPiGatewaySource = unmanaged;
