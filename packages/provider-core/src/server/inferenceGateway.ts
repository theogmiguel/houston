import type { ProviderInstanceId, ThreadId } from "@houston-app/contracts";
import type { InferenceApiProtocol } from "@houston-app/contracts/houston/inference";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { InferenceGatewayCredential } from "./mcpSession.ts";

export interface ManagedInferenceModel {
  readonly id: string;
  /** The window the server enforces, when it reports one. */
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEfforts?: ReadonlyArray<string>;
  /** Whether the model reads images, as its engine reported; absent when unknown. */
  readonly images?: boolean;
}

/** A linked server whose route for a harness's protocol Houston's gateway can carry. */
export interface ManagedInferenceServer {
  readonly serverId: string;
  readonly displayName: string;
  readonly models: ReadonlyArray<ManagedInferenceModel>;
}

/** Why a linked server is or is not managed for a harness; the reason is user-facing text. */
export type ManagedServerResolution =
  | { readonly managed: true; readonly server: ManagedInferenceServer }
  | {
      readonly managed: false;
      readonly reason: string;
      /** The instance still counts as local, so it must wait rather than run on its own setup. */
      readonly local?: boolean;
    };

export interface ManagedServerCredential {
  readonly server: ManagedInferenceServer;
  readonly credential: InferenceGatewayCredential;
}

/**
 * How harnesses reach a linked inference server through Houston's gateway. Each asks for the
 * protocol it speaks. Thread sessions take their credential from their MCP session config;
 * discovery and text generation borrow a background one, and a shared harness process holds an
 * instance one.
 */
export class InferenceGatewayAccess extends Context.Service<
  InferenceGatewayAccess,
  {
    /** Undefined when the instance is not linked to a server. */
    readonly resolve: (
      instanceId: ProviderInstanceId,
      protocol: InferenceApiProtocol,
    ) => Effect.Effect<ManagedServerResolution | undefined>;
    /** Undefined unless the linked server is enabled, ready, and serves the protocol. */
    readonly managedServer: (
      instanceId: ProviderInstanceId,
      protocol: InferenceApiProtocol,
    ) => Effect.Effect<ManagedInferenceServer | undefined>;
    /** A short-lived credential for the instance's managed server, revoked with the scope. */
    readonly backgroundCredential: (
      instanceId: ProviderInstanceId,
      protocol: InferenceApiProtocol,
    ) => Effect.Effect<ManagedServerCredential | undefined, never, Scope.Scope>;
    /**
     * For a harness process that serves many threads: attributed to the instance, counted as
     * chat, and valid until the scope (the process) closes.
     */
    readonly instanceCredential: (
      instanceId: ProviderInstanceId,
      protocol: InferenceApiProtocol,
    ) => Effect.Effect<ManagedServerCredential | undefined, never, Scope.Scope>;
    /**
     * Lets the instance's shared harness name the thread behind a request: the gateway asks
     * `threadOf` with the harness session id the request carries, until the scope closes.
     */
    readonly attributeSessions: (
      instanceId: ProviderInstanceId,
      threadOf: (harnessSessionId: string) => ThreadId | undefined,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@houston-app/provider-core/server/inferenceGateway/InferenceGatewayAccess") {}
