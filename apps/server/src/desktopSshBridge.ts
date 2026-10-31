// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics effectFnOpportunity:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalErrorInEffectCatch:off
// @effect-diagnostics globalErrorInEffectFailure:off
// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics preferSchemaOverJson:off
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import * as SshAuth from "@t3tools/ssh/auth";
import { resolveSshTarget } from "@t3tools/ssh/command";
import { discoverSshHosts } from "@t3tools/ssh/config";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import {
  resolveLoopbackSshHttpBaseUrl,
  SshEnvironmentManager,
  type RemoteT3RunnerOptions,
} from "@t3tools/ssh/tunnel";
import * as NetService from "@t3tools/shared/Net";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Crypto from "effect/Crypto";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Path from "effect/Path";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import packageJson from "../package.json" with { type: "json" };

const PROMPT_TIMEOUT_MS = 3 * 60 * 1000;

type BridgeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshAuth.SshPasswordPrompt;

class SshBridgeRequestError extends Data.TaggedError("SshBridgeRequestError")<{
  readonly message: string;
}> {}

type HelperRequest = {
  readonly type: "request";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
};

type PasswordResolution = {
  readonly type: "resolve-password";
  readonly id: number;
  readonly requestId: string;
  readonly password: string | null;
};

type AnyMessage = HelperRequest | PasswordResolution | { readonly type: string };

function writeMessage(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function runnerOptions(): RemoteT3RunnerOptions {
  const devRemoteEntry = process.env.HOUSTON_DEV_REMOTE_T3_SERVER_ENTRY_PATH?.trim();
  if (devRemoteEntry) {
    return {
      nodeScriptPath: devRemoteEntry,
      nodeEngineRange: packageJson.engines?.node ?? null,
    };
  }
  return {
    archiveVersion: process.env.HOUSTON_SSH_APP_VERSION?.trim() || packageJson.version,
  };
}

function readSshHttpStatus(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const status = (cause as { readonly status?: unknown }).status;
  if (typeof status === "number") return status;
  const tag = (cause as { readonly _tag?: unknown })._tag;
  switch (tag) {
    case "EnvironmentRequestInvalidError":
      return 400;
    case "EnvironmentAuthInvalidError":
      return 401;
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return 403;
    case "EnvironmentInternalError":
      return 500;
    default:
      return null;
  }
}

function serializeError(error: unknown): {
  readonly message: string;
  readonly sshHttpStatus: number | null;
} {
  const message = error instanceof Error ? error.message : String(error);
  const sshHttpStatus = readSshHttpStatus(error);
  const prefix = sshHttpStatus === null ? "" : `[ssh_http:${sshHttpStatus}] `;
  return { message: `${prefix}${message}`, sshHttpStatus };
}

function isPasswordPromptCancellation(error: unknown): boolean {
  return (
    error instanceof SshPasswordPromptError &&
    /cancelled|timed out/iu.test(error.message)
  );
}

interface PendingPrompt {
  readonly resolve: (password: string) => void;
  readonly reject: (error: SshPasswordPromptError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function makePromptService() {
  const pending = new Map<string, PendingPrompt>();
  const service = SshAuth.SshPasswordPrompt.of({
    isAvailable: true,
    request: (request: SshAuth.SshPasswordRequest) =>
      Effect.tryPromise({
        try: () =>
          new Promise<string>((resolve, reject) => {
            const requestId = randomUUID();
            const expiresAt = new Date(Date.now() + PROMPT_TIMEOUT_MS).toISOString();
            const timer = setTimeout(() => {
              pending.delete(requestId);
              reject(
                new SshPasswordPromptError({
                  message: `SSH authentication timed out for ${request.destination}.`,
                }),
              );
            }, PROMPT_TIMEOUT_MS);
            pending.set(requestId, { resolve, reject, timer });
            writeMessage({
              type: "event",
              event: "ssh-password-prompt",
              request: {
                requestId,
                destination: request.destination,
                username: request.username,
                prompt: request.prompt,
                expiresAt,
              },
            });
          }),
        catch: (cause) =>
          cause instanceof SshPasswordPromptError
            ? cause
            : new SshPasswordPromptError({
                message: `SSH authentication failed for ${request.destination}.`,
                cause,
              }),
      }),
  });
  const resolve = (requestId: string, password: string | null): string | null => {
    const entry = pending.get(requestId);
    if (entry === undefined) return "SSH password prompt expired. Try connecting again.";
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (password === null) {
      entry.reject(
        new SshPasswordPromptError({ message: "SSH authentication cancelled." }),
      );
      return null;
    }
    entry.resolve(password);
    return null;
  };
  return { service, resolve };
}

function paramsOf<T>(
  params: unknown,
  method: string,
): Effect.Effect<T, SshBridgeRequestError> {
  if (typeof params !== "object" || params === null) {
    return Effect.fail(
      new SshBridgeRequestError({
        message: `${method} requires object parameters, got ${JSON.stringify(params)}`,
      }),
    );
  }
  return Effect.succeed(params as T);
}

export async function runDesktopSshBridge(): Promise<void> {
  const prompts = makePromptService();
  const runner = runnerOptions();
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerNodeHttp,
    NetService.layer,
    SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(runner) }),
  );

  const program = Effect.gen(function* () {
    const manager = yield* SshEnvironmentManager;
    const context = yield* Effect.context<BridgeServices>();
    const runFork = Effect.runForkWith(context);

    const withLoopback = <A, E, R>(
      httpBaseUrl: string,
      use: (resolved: string) => Effect.Effect<A, E, R>,
    ) => resolveLoopbackSshHttpBaseUrl(httpBaseUrl).pipe(Effect.flatMap(use));

    const handleRequest = (request: HelperRequest) =>
      Effect.gen(function* () {
        switch (request.method) {
          case "discover-hosts":
            return yield* discoverSshHosts({});
          case "resolve-host":
            return yield* resolveSshTarget(String((request.params as { alias?: unknown })?.alias ?? "").trim());
          case "ensure-environment": {
            const params = yield* paramsOf<{
              readonly target: DesktopSshEnvironmentTarget;
              readonly options?: { readonly issuePairingToken?: boolean };
            }>(request.params, request.method);
            return yield* manager
              .ensureEnvironment(params.target, params.options)
              .pipe(
                Effect.catchIf(isPasswordPromptCancellation, (error) =>
                  Effect.succeed({
                    type: "ssh-password-prompt-cancelled" as const,
                    message: error.message,
                  }),
                ),
              );
          }
          case "disconnect-environment": {
            const params = yield* paramsOf<{
              readonly target: DesktopSshEnvironmentTarget;
            }>(request.params, request.method);
            return yield* manager.disconnectEnvironment(params.target);
          }
          case "fetch-environment-descriptor": {
            const params = yield* paramsOf<{ readonly httpBaseUrl: string }>(
              request.params,
              request.method,
            );
            return yield* withLoopback(params.httpBaseUrl, (httpBaseUrl) =>
              fetchRemoteEnvironmentDescriptor({ httpBaseUrl }),
            );
          }
          case "bootstrap-bearer-session": {
            const params = yield* paramsOf<{
              readonly httpBaseUrl: string;
              readonly credential: string;
            }>(request.params, request.method);
            return yield* withLoopback(params.httpBaseUrl, (httpBaseUrl) =>
              bootstrapRemoteBearerSession({ httpBaseUrl, credential: params.credential }),
            );
          }
          case "fetch-session-state": {
            const params = yield* paramsOf<{
              readonly httpBaseUrl: string;
              readonly bearerToken: string;
            }>(request.params, request.method);
            return yield* withLoopback(params.httpBaseUrl, (httpBaseUrl) =>
              fetchRemoteSessionState({ httpBaseUrl, bearerToken: params.bearerToken }),
            );
          }
          default:
            return yield* new SshBridgeRequestError({
              message: `Unknown SSH bridge method ${JSON.stringify(request.method)}.`,
            });
        }
      }).pipe(
        Effect.map((result) => ({ type: "response", id: request.id, ok: true, result })),
        Effect.catch((error) => {
          const serialized = serializeError(error);
          return Effect.succeed({
            type: "response",
            id: request.id,
            ok: false,
            error: serialized,
          });
        }),
      );

    const handleResolution = (message: PasswordResolution) =>
      Effect.sync(() => {
        const error = prompts.resolve(message.requestId, message.password);
        writeMessage(
          error === null
            ? { type: "response", id: message.id, ok: true, result: null }
            : {
                type: "response",
                id: message.id,
                ok: false,
                error: { message: error, sshHttpStatus: null },
              },
        );
      });

    const dispatch = (line: string) => {
      let message: AnyMessage;
      try {
        message = JSON.parse(line) as AnyMessage;
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      if (message.type === "request") {
        runFork(
          handleRequest(message as HelperRequest).pipe(
            Effect.tap((response) => Effect.sync(() => writeMessage(response))),
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                writeMessage({
                  type: "response",
                  id: (message as HelperRequest).id,
                  ok: false,
                  error: { message: String(cause), sshHttpStatus: null },
                }),
              ),
            ),
          ),
        );
      } else if (message.type === "resolve-password") {
        runFork(handleResolution(message as PasswordResolution));
      }
    };

    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          const lines = readline.createInterface({
            input: process.stdin,
            crlfDelay: Infinity,
          });
          lines.on("line", dispatch);
          lines.on("close", resolve);
        }),
    );
  }).pipe(
    Effect.provideService(SshAuth.SshPasswordPrompt, prompts.service),
    Effect.scoped,
    Effect.provide(layer),
  );

  await Effect.runPromise(program);
}
