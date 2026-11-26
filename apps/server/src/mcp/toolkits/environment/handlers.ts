import {
  AuthStandardClientScopes,
  OrchestratorMcpFailure,
  type ServerSettings,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
/** Long enough for a window to save and connect with it, and no longer: an unused code dies. */
const CLIENT_PAIRING_TTL = Duration.minutes(3);
const LINK_CLIENT_NAME_PREFIX = "Houston · ";

export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  houston_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  houston_peer_link_client_pairing: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const settings = yield* Settings.ServerSettingsService;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const enabled = yield* settings.getSettings.pipe(
        Effect.map((current) => current.linkedEnvironmentsEnabled),
        Effect.orElseSucceed(() => false),
      );
      if (!enabled) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Linked environments is off on this machine. Turn it on in Settings → Labs before pairing a client.",
        });
      }
      const client = scope.client;
      if (client?.linked !== true) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only a linked environment may pair a client here.",
        });
      }
      if (client.access !== "full-access") {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `Pairing a client needs a full-access link. This link's access is ${client.access}.`,
        });
      }
      // Never more than the client holds where it asked, nor more than a pairing code grants.
      const scopes = AuthStandardClientScopes.filter((scope) => input.scopes.includes(scope));
      if (scopes.length === 0) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "The client holds no access a pairing code could carry.",
        });
      }
      const via = client.label.startsWith(LINK_CLIENT_NAME_PREFIX)
        ? client.label.slice(LINK_CLIENT_NAME_PREFIX.length)
        : client.label;
      const issued = yield* auth
        .createPairingLink({
          scopes,
          ttl: CLIENT_PAIRING_TTL,
          label: `${input.clientLabel} · via ${via}`,
        })
        .pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "This environment could not create a pairing code.",
              }),
          ),
        );
      return { credential: issued.credential, expiresAt: DateTime.formatIso(issued.expiresAt) };
    }),
  ),
  houston_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
