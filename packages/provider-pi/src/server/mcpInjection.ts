import { tokenizeCliArgs } from "@houston-app/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { ManagedInferenceServer } from "@houston-app/provider-core/server/inferenceGateway";
import type { McpToolProfile } from "@houston-app/provider-core/server/mcpToolProfile";
import type {
  InferenceGatewayCredential,
  McpProviderSessionConfig,
} from "@houston-app/provider-core/server/mcpSession";
import {
  HOUSTON_GATEWAY_MODELS_ENV,
  HOUSTON_GATEWAY_PROVIDER_ENV,
  HOUSTON_GATEWAY_TOKEN_ENV,
  HOUSTON_GATEWAY_URL_ENV,
  PI_HOUSTON_GATEWAY_EXTENSION_FILENAME,
  PI_HOUSTON_GATEWAY_EXTENSION_SOURCE,
} from "./gatewayExtensionSource.ts";
import {
  PI_HOUSTON_MCP_EXTENSION_FILENAME,
  PI_HOUSTON_MCP_EXTENSION_SOURCE,
  HOUSTON_MCP_BEARER_ENV,
  HOUSTON_MCP_URL_ENV,
  HOUSTON_PI_RUNTIME_MODE_ENV,
  HOUSTON_PI_MCP_EXTENSION_PATH_ENV,
  HOUSTON_PI_TOOL_PROFILE_ENV,
} from "./mcpExtensionSource.ts";

const RESERVED_PI_LAUNCH_ARGUMENTS = new Set([
  "--continue",
  "-c",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--list-models",
  "--mode",
  "--no-session",
  "--print",
  "-p",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--version",
  "-v",
]);

export const PI_ARGUMENTS_WITH_VALUES = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--model",
  "--models",
  "--name",
  "-n",
  "--prompt-template",
  "--provider",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
  "--tui-mode",
  "--use-theme",
]);

const PI_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--no-extensions",
  "-ne",
  "--no-prompt-templates",
  "-np",
  "--no-skills",
  "-ns",
  "--no-themes",
  "--no-tools",
  "-nt",
  "--offline",
  "--verbose",
]);

export type PiLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function reservedPiArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_PI_LAUNCH_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

function normalizePiBuiltInEqualsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg) => {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) return [arg];
    const option = arg.slice(0, equalsIndex);
    return PI_ARGUMENTS_WITH_VALUES.has(option) ? [option, arg.slice(equalsIndex + 1)] : [arg];
  });
}

export function resolvePiLaunchArgs(launchArgs: string): PiLaunchArgsResolution {
  // Pi treats equals-form tokens as extension flags; split only known built-ins.
  const args = normalizePiBuiltInEqualsArguments(tokenizeCliArgs(launchArgs));
  let hasProvider = false;
  let hasModel = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedPiArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `Pi launch argument '${reserved}' is controlled by Houston and cannot be overridden.`,
      };
    }
    if (arg === "--") {
      return {
        ok: false,
        message: "Pi launch arguments cannot include positional prompts.",
      };
    }
    if (PI_ARGUMENTS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: `Pi launch argument '${arg}' requires a value.` };
      }
      if (arg === "--provider") hasProvider = true;
      if (arg === "--model") hasModel = true;
      index += 1;
      continue;
    }
    if (PI_ARGUMENTS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) {
      continue;
    }
    if (arg.startsWith("--")) {
      // Arbitrary extension flags may consume one following non-flag token.
      if (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-") &&
        !args[index + 1]!.startsWith("@")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `Pi launch argument '${arg}' is not supported by Houston.` };
    }
    return {
      ok: false,
      message: `Pi launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  if (hasProvider && !hasModel) {
    return { ok: false, message: "Pi launch argument '--provider' requires '--model'." };
  }
  return { ok: true, args };
}

function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

const BACKSLASH = /\\/g;
const TRAILING_SLASHES = /\/+$/;

function normalizedPiPath(value: string): string {
  return value.replace(BACKSLASH, "/").replace(TRAILING_SLASHES, "");
}

function hasExplicitExtension(args: ReadonlyArray<string>, extensionPath: string): boolean {
  const wanted = normalizedPiPath(extensionPath);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--extension" && arg !== "-e") continue;
    const configured = args[index + 1];
    if (configured !== undefined && normalizedPiPath(configured) === wanted) return true;
    index += 1;
  }
  return false;
}

function withoutExplicitExtensions(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--extension" || arg === "-e") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--extension=") || arg.startsWith("-e=")) continue;
    filtered.push(arg);
  }
  return filtered;
}

function withoutToolSelectionArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--tools" || arg === "-t" || arg === "--exclude-tools" || arg === "-xt") {
      index += 1;
      continue;
    }
    if (
      arg === "--no-tools" ||
      arg === "-nt" ||
      arg === "--no-builtin-tools" ||
      arg === "-nbt" ||
      arg.startsWith("--tools=") ||
      arg.startsWith("-t=") ||
      arg.startsWith("--exclude-tools=") ||
      arg.startsWith("-xt=")
    ) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function piHoustonMcpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(BACKSLASH, "/")}/${PI_HOUSTON_MCP_EXTENSION_FILENAME}`;
}

export const materializePiHoustonMcpExtension = Effect.fn("materializePiHoustonMcpExtension")(
  function* (cacheDir: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    const dest = piHoustonMcpExtensionDestPath(cacheDir);
    const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
    if (existing !== PI_HOUSTON_MCP_EXTENSION_SOURCE) {
      yield* fs.writeFileString(dest, PI_HOUSTON_MCP_EXTENSION_SOURCE);
    }
    return dest;
  },
);

const materializeSource = Effect.fnUntraced(function* (dest: string, source: string) {
  const fs = yield* FileSystem.FileSystem;
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== source) {
    yield* fs.writeFileString(dest, source);
  }
  return dest;
});

/** For discovery and text generation, which run without Houston's full extension. */
export const materializePiHoustonGatewayExtension = Effect.fn(
  "materializePiHoustonGatewayExtension",
)(function* (cacheDir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  return yield* materializeSource(
    `${cacheDir.replace(BACKSLASH, "/")}/${PI_HOUSTON_GATEWAY_EXTENSION_FILENAME}`,
    PI_HOUSTON_GATEWAY_EXTENSION_SOURCE,
  );
});

export interface PiGatewayLaunch {
  readonly server: ManagedInferenceServer;
  readonly credential: InferenceGatewayCredential;
}

const piGatewayProviderName = (serverId: string) => `houston-${serverId}`;

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Pi's documented defaults for a model that does not say.
const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_DEFAULT_MAX_TOKENS = 16_384;

/** Pi model configs for registerProvider; a level the server does not advertise is unsupported. */
function piGatewayModels(server: ManagedInferenceServer) {
  return server.models.map((model) => {
    const efforts = new Set(model.reasoningEfforts ?? []);
    return {
      id: model.id,
      name: `${model.id} (${server.displayName})`,
      reasoning: efforts.size > 0,
      ...(efforts.size === 0
        ? {}
        : {
            thinkingLevelMap: Object.fromEntries(
              PI_THINKING_LEVELS.map((level) => [level, efforts.has(level) ? level : null]),
            ),
          }),
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? PI_DEFAULT_CONTEXT_WINDOW,
      maxTokens: Math.min(
        model.maxOutputTokens ?? PI_DEFAULT_MAX_TOKENS,
        model.contextWindow ?? Number.POSITIVE_INFINITY,
      ),
    };
  });
}

/** An explicit profile wins; "auto" follows the instance's link to an enabled inference server. */
export function resolvePiToolProfile(
  setting: "auto" | "full" | "lean",
  linkedToInferenceServer: boolean,
): McpToolProfile {
  if (setting !== "auto") return setting;
  return linkedToInferenceServer ? "lean" : "full";
}

export function buildPiRpcLaunch(input: {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  readonly sessionPath?: string | undefined;
  readonly ephemeral?: boolean;
  // Discovery stops these processes as soon as they answer. They run --offline because Pi's
  // startup catalog refresh renews expired OAuth tokens, and a stop mid-request loses the
  // rotated one.
  readonly shortLived?: boolean;
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
  /** A managed inference server: registered in Pi as `houston-<serverId>` through Houston's gateway. */
  readonly gateway?: PiGatewayLaunch | undefined;
  /** Loaded alone, even under --no-extensions, when Houston's full extension is not. */
  readonly gatewayExtensionPath?: string | undefined;
  readonly toolProfile?: McpToolProfile;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const hasHoustonExtension = input.disableExtensions !== true && input.extensionPath !== undefined;
  const hasHoustonMcp = hasHoustonExtension && input.mcpSession !== undefined;
  const extensionSafeArgs =
    input.disableExtensions === true
      ? withoutExplicitExtensions(input.launchArgs)
      : input.launchArgs;
  const launchArgs =
    input.disableTools === true ? withoutToolSelectionArgs(extensionSafeArgs) : extensionSafeArgs;
  const args = [
    "--mode",
    "rpc",
    ...(input.ephemeral === true
      ? ["--no-session"]
      : input.sessionPath !== undefined
        ? ["--session", input.sessionPath]
        : []),
    ...launchArgs,
    ...(input.shortLived === true && !launchArgs.includes("--offline") ? ["--offline"] : []),
    // Restrictions must follow launch args so user flags cannot re-enable unattended tools/extensions.
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true ? ["--no-tools"] : []),
  ];
  if (
    hasHoustonExtension &&
    input.extensionPath !== undefined &&
    !hasExplicitExtension(args, input.extensionPath)
  ) {
    args.push("--extension", input.extensionPath);
  }
  const gatewayCarrier = hasHoustonExtension
    ? "full"
    : input.gateway !== undefined && input.gatewayExtensionPath !== undefined
      ? "gateway-only"
      : undefined;
  if (gatewayCarrier === "gateway-only" && input.gatewayExtensionPath !== undefined) {
    args.push("--extension", input.gatewayExtensionPath);
  }
  const environment = { ...input.environment };
  // MCP credentials belong to this Houston session; discard inherited server/parent credentials.
  for (const name of [
    HOUSTON_GATEWAY_URL_ENV,
    HOUSTON_GATEWAY_TOKEN_ENV,
    HOUSTON_GATEWAY_PROVIDER_ENV,
    HOUSTON_GATEWAY_MODELS_ENV,
  ]) {
    delete environment[name];
  }
  delete environment[HOUSTON_MCP_URL_ENV];
  delete environment[HOUSTON_MCP_BEARER_ENV];
  delete environment[HOUSTON_PI_MCP_EXTENSION_PATH_ENV];
  delete environment[HOUSTON_PI_TOOL_PROFILE_ENV];

  return {
    args,
    env: {
      ...environment,
      ...(hasHoustonExtension && input.extensionPath !== undefined
        ? { [HOUSTON_PI_MCP_EXTENSION_PATH_ENV]: input.extensionPath }
        : {}),
      ...(hasHoustonExtension && input.runtimeMode !== undefined
        ? {
            [HOUSTON_PI_RUNTIME_MODE_ENV]:
              input.runtimeMode === "auto" ? "approval-required" : input.runtimeMode,
          }
        : {}),
      ...(hasHoustonMcp && input.toolProfile !== undefined
        ? { [HOUSTON_PI_TOOL_PROFILE_ENV]: input.toolProfile }
        : {}),
      ...(hasHoustonMcp && input.mcpSession !== undefined
        ? {
            [HOUSTON_MCP_URL_ENV]: input.mcpSession.endpoint,
            [HOUSTON_MCP_BEARER_ENV]: bearerTokenFromAuthorizationHeader(
              input.mcpSession.authorizationHeader,
            ),
          }
        : {}),
      ...(gatewayCarrier !== undefined && input.gateway !== undefined
        ? {
            [HOUSTON_GATEWAY_URL_ENV]: input.gateway.credential.baseUrl,
            [HOUSTON_GATEWAY_TOKEN_ENV]: input.gateway.credential.token,
            [HOUSTON_GATEWAY_PROVIDER_ENV]: piGatewayProviderName(input.gateway.server.serverId),
            [HOUSTON_GATEWAY_MODELS_ENV]: JSON.stringify(piGatewayModels(input.gateway.server)),
          }
        : {}),
    },
  };
}
