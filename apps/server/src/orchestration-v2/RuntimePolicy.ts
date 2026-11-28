// @effect-diagnostics nodeBuiltinImport:off - the containment check is purely lexical and must not add a Path requirement to the runtime policy.
import {
  isRuntimeModeAbove,
  managedRuntimeModeCeilingMessage,
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@houston-app/contracts";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { HoustonBotThreads } from "../houston/bots/botThreads.ts";
import { HoustonReadOnlyThreads, hasReadOnlyRun, readOnlyPolicy } from "../houston/sideThreads.ts";
import * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";
import { isThreadProjectNotFoundError, repositoriesOf } from "../project/threadRepositories.ts";
import * as HoustonTaskFolders from "../houston/worktrees/TaskFolders.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
    /** Houston: a refusal the user can act on, shown instead of the generic message. */
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return (
      this.detail ??
      `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`
    );
  }
}

/**
 * A turn would start in a mode above the policy's ceiling. The orchestrator refuses those when
 * they are dispatched; this catches the ones it never saw, such as a run resumed after a restart
 * on a thread whose mode predates the policy.
 */
export class RuntimePolicyAboveCeilingError extends Schema.TaggedError<RuntimePolicyAboveCeilingError>()(
  "RuntimePolicyAboveCeilingError",
  {
    threadId: ThreadId,
    runtimeMode: RuntimeMode,
    maxRuntimeMode: RuntimeMode,
    organization: Schema.String,
  },
) {
  override get message(): string {
    return `${managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode)} Switch this thread's mode to continue.`;
  }
}

export const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

/** A provider would start a turn unable to read repositories the project covers. */
export class RuntimePolicyUnreachableRepositoriesError extends Schema.TaggedError<RuntimePolicyUnreachableRepositoriesError>()(
  "RuntimePolicyUnreachableRepositoriesError",
  {
    threadId: ThreadId,
    provider: Schema.String,
    missingCapability: Schema.String,
    folders: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Provider ${this.provider} cannot start thread ${this.threadId}: ${this.missingCapability}. It cannot reach ${this.folders.join(", ")}; expected a provider that reads additional directories.`;
  }
}

export const isRuntimePolicyUnreachableRepositoriesError = Schema.is(
  RuntimePolicyUnreachableRepositoriesError,
);

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  RuntimePolicyAboveCeilingError,
  RuntimePolicyUnreachableRepositoriesError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "@houston-app/cli/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function (input) {
    return Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    });
  }),
});

function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

const refuseAboveCeiling = (
  managedPolicy: ServerSettings.ServerSettingsService["Service"]["managedPolicy"],
  thread: OrchestrationV2AppThread,
) => {
  const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
  return managedPolicy !== undefined &&
    maxRuntimeMode !== undefined &&
    isRuntimeModeAbove(thread.runtimeMode, maxRuntimeMode)
    ? Effect.fail(
        new RuntimePolicyAboveCeilingError({
          threadId: thread.id,
          runtimeMode: thread.runtimeMode,
          maxRuntimeMode,
          organization: managedPolicy.organization,
        }),
      )
    : Effect.void;
};

/** Lays the policy's ceiling over another runtime policy, as `layerFromProjectStore` does. */
export const layerEnforcingCeiling: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolveWithinCeiling")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        return yield* base.resolve(input);
      }),
    });
  }),
);

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const taskFolders = yield* HoustonTaskFolders.HoustonTaskFolders;
    // The same ceiling the orchestrator enforces, fixed for the server's life.
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        const repositories = yield* repositoriesOf(
          input.thread,
          projects.get(input.thread.projectId),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                cause: isThreadProjectNotFoundError(cause) ? "Project not found." : cause,
              }),
          ),
        );
        // A task folder is the thread's cwd; its repository worktrees sit inside it.
        const taskFolder =
          input.thread.worktreePath === null
            ? null
            : yield* taskFolders.find(input.thread.worktreePath).pipe(
                Effect.mapError(
                  (cause) =>
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause,
                    }),
                ),
              );
        const cwd = taskFolder?.folderPath ?? repositories[0].root;
        const directories =
          taskFolder === null
            ? repositories.map((repository) => repository.root)
            : taskFolder.repositories.map((repository) => repository.worktreePath);
        const outsideCwd = directories.filter((directory) => {
          if (directory === cwd) return false;
          const relative = NodePath.relative(cwd, directory);
          return relative !== "" && (relative.startsWith("..") || NodePath.isAbsolute(relative));
        });
        if (
          outsideCwd.length > 0 &&
          instance?.orchestrationAdapter.supportsAdditionalDirectories !== true
        ) {
          return yield* new RuntimePolicyUnreachableRepositoriesError({
            threadId: input.thread.id,
            provider: instance?.driverKind ?? input.modelSelection.instanceId,
            missingCapability: "reading directories outside its cwd",
            folders: outsideCwd,
          });
        }
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
          directories,
          ...(maxRuntimeMode === undefined ? {} : { maxRuntimeMode }),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
  // Houston: limits the override to these threads, so a replay can leave others unchanged.
  options: { readonly threadIds?: ReadonlyArray<string> } = {},
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          options.threadIds !== undefined && !options.threadIds.includes(input.thread.id)
            ? base.resolve(input)
            : base.resolve(input).pipe(
                Effect.map((policy) =>
                  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                    ...policy,
                    ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                    ...(override.approvalPolicy === undefined
                      ? {}
                      : { approvalPolicy: override.approvalPolicy }),
                    ...(override.sandboxPolicy === undefined
                      ? {}
                      : { sandboxPolicy: override.sandboxPolicy }),
                    ...(override.reasoningEffort === undefined
                      ? {}
                      : { reasoningEffort: override.reasoningEffort }),
                  }),
                ),
              ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}

/** Houston: a side thread, or a task's planner or reviewer, resolves read-only, or fails on a
 * provider that cannot enforce it. */
export const layerReadOnlySideThreads: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ProviderAdapterRegistry.ProviderAdapterRegistryV2 | HoustonReadOnlyThreads
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const readOnlyThreads = yield* HoustonReadOnlyThreads;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolveSideThread")(function* (input) {
        const policy = yield* base.resolve(input);
        if (
          input.thread.side === undefined &&
          !(yield* readOnlyThreads.isReadOnly(input.thread.id))
        )
          return policy;
        const refuse = (cause: unknown) =>
          new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause,
          });
        const capabilities = yield* adapters.get(input.modelSelection.instanceId).pipe(
          Effect.flatMap((adapter) => adapter.getCapabilities()),
          Effect.mapError(refuse),
        );
        if (!hasReadOnlyRun(capabilities)) {
          return yield* refuse(
            `Read-only thread ${input.thread.id} needs a read-only run; ${input.modelSelection.instanceId} declares none.`,
          );
        }
        const submitTool =
          input.thread.side === undefined
            ? yield* readOnlyThreads.submitToolOf(input.thread.id)
            : undefined;
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...readOnlyPolicy(policy),
          ...(submitTool === undefined ? {} : { houstonTaskSubmitTool: submitTool }),
        });
      }),
    });
  }),
);

/** Houston: a bot thread runs under its bot run's rules, or fails on a driver that cannot apply
 * them. The kind's mode is set before the base resolves, so the ceiling and the provider's
 * supported modes see the mode that runs. */
export const layerBotThreads: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ProviderAdapterRegistry.ProviderAdapterRegistryV2 | HoustonBotThreads
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const botThreads = yield* HoustonBotThreads;
    return RuntimePolicyV2.of({
      // Untraced: every thread's turn passes here, so a span would cost threads that are no bot's.
      resolve: Effect.fnUntraced(function* (input) {
        const refuse = (cause: unknown, detail?: string) =>
          new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause,
            ...(detail === undefined ? {} : { detail }),
          });
        const found = yield* botThreads
          .policyOf(input.thread)
          .pipe(Effect.mapError((error) => refuse(error, error.message)));
        if (found === undefined) return yield* base.resolve(input);
        const { botName, kind } = found.provider;
        const capabilities = yield* adapters.get(input.modelSelection.instanceId).pipe(
          Effect.flatMap((adapter) => adapter.getCapabilities()),
          Effect.mapError((cause) => refuse(cause)),
        );
        if (capabilities.runtimePolicy.houstonBotRuns?.includes(kind) !== true) {
          return yield* refuse(
            "undeclared bot run kind",
            `${botName} runs here as an ${kind} bot run, and ${input.modelSelection.instanceId} cannot apply the rules of an ${kind} bot run. Choose a Claude account for this thread.`,
          );
        }
        const policy = yield* base.resolve(
          found.runtimeMode === undefined
            ? input
            : {
                ...input,
                thread: {
                  ...input.thread,
                  runtimeMode: found.runtimeMode,
                  interactionMode: "default",
                },
              },
        );
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...policy,
          houstonBot: found.provider,
        });
      }),
    });
  }),
);
