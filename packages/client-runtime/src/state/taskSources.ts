import { WS_METHODS, type EnvironmentId, type ProjectId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

type Registry = AtomRegistry.AtomRegistry;

export function createTaskSourceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const settings = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:task-sources:settings",
    tag: WS_METHODS.houstonTaskSourcesSettingsGet,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const links = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:task-sources:links",
    tag: WS_METHODS.houstonTaskSourcesLinksGet,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const conflicts = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:task-sources:conflicts",
    tag: WS_METHODS.houstonTaskSourcesConflictsList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const importStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:task-sources:import-status",
    tag: WS_METHODS.houstonTaskSourcesImportV1Status,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const refreshProject = (
    registry: Registry,
    environmentId: EnvironmentId,
    projectId: ProjectId | undefined,
  ) =>
    Effect.sync(() => {
      if (projectId !== undefined) {
        registry.refresh(settings({ environmentId, input: { projectId } }));
      }
      registry.refresh(
        conflicts({ environmentId, input: projectId === undefined ? {} : { projectId } }),
      );
    });
  return {
    settings,
    links,
    conflicts,
    syncNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sources:sync-now",
      tag: WS_METHODS.houstonTaskSourcesSyncNow,
      scheduler,
      concurrency,
      onSuccess: (target, registry) =>
        refreshProject(registry, target.environmentId, target.input.projectId),
    }),
    saveSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sources:settings-set",
      tag: WS_METHODS.houstonTaskSourcesSettingsSet,
      scheduler,
      concurrency,
      onSuccess: (target, registry) =>
        refreshProject(registry, target.environmentId, target.input.projectId),
    }),
    setCredential: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sources:credential-set",
      tag: WS_METHODS.houstonTaskSourcesCredentialSet,
      scheduler,
      concurrency,
      onSuccess: (target, registry) =>
        refreshProject(registry, target.environmentId, target.input.projectId),
    }),
    clearCredential: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sources:credential-clear",
      tag: WS_METHODS.houstonTaskSourcesCredentialClear,
      scheduler,
      concurrency,
      onSuccess: (target, registry) =>
        refreshProject(registry, target.environmentId, target.input.projectId),
    }),
    importStatus,
    importRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sources:import-run",
      tag: WS_METHODS.houstonTaskSourcesImportV1Run,
      scheduler,
      concurrency,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(importStatus({ environmentId: target.environmentId, input: {} }));
          registry.refresh(conflicts({ environmentId: target.environmentId, input: {} }));
        }),
    }),
    resolve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sources:resolve",
      tag: WS_METHODS.houstonTaskSourcesConflictResolve,
      scheduler,
      concurrency,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(
            links({
              environmentId: target.environmentId,
              input: { taskId: target.input.taskId },
            }),
          );
          registry.refresh(conflicts({ environmentId: target.environmentId, input: {} }));
        }),
    }),
  };
}
