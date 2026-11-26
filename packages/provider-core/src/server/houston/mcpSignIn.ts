import type { ProviderDriverKind } from "@houston-app/contracts";
import { HoustonMcpSignInError } from "@houston-app/contracts/houston/mcpSignIn";
import * as Effect from "effect/Effect";

import type {
  ProviderAdapterV2McpSignIn,
  ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";

/**
 * The session's MCP sign-in capability, or a refusal naming the provider and the missing
 * capability. Providers without one keep the plain-text notice.
 */
export const requireMcpSignIn = (
  runtime: Pick<ProviderAdapterV2SessionRuntime, "mcpSignIn">,
  input: { readonly driver: ProviderDriverKind; readonly server: string },
): Effect.Effect<ProviderAdapterV2McpSignIn, HoustonMcpSignInError> =>
  runtime.mcpSignIn === undefined
    ? Effect.fail(
        new HoustonMcpSignInError({
          kind: "unsupported-provider",
          server: input.server,
          message: `The ${input.driver} provider does not support MCP sign-in (capability: MCP sign-in), so ${input.server} cannot be signed in from Houston.`,
        }),
      )
    : Effect.succeed(runtime.mcpSignIn);
