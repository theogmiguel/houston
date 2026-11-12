import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
  ServerSettings,
  ThreadId,
} from "@houston-app/contracts";
import type { EnvironmentProject } from "@houston-app/client-runtime/state/shell";
import { resolveProjectSettings } from "@houston-app/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@houston-app/shared/usageLimits";

import { ensureThreadPlaced } from "../../threads/ensureThreadPlaced";
import { gridById, MAX_GRID_THREADS, useGridStore } from "../../grid/gridStore";
import { preorderThreads } from "@houston-app/shared/grid/tree";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";

export interface QuickComposerGridOption {
  readonly id: string;
  readonly name: string;
}

export interface QuickComposerProjectOption {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly grids: ReadonlyArray<QuickComposerGridOption>;
}

export interface QuickComposerImage {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly previewUrl: string;
  readonly file: File;
}

export interface QuickComposerSubmitInput {
  readonly prompt: string;
  readonly images: ReadonlyArray<QuickComposerImage>;
}

export type QuickComposerSubmitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export function quickComposerProjectKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): string {
  return `${environmentId}:${projectId}`;
}

export function resolveQuickComposerStart(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
  readonly projectId: ProjectId;
  readonly project: EnvironmentProject | null;
  readonly now: number;
}):
  | {
      readonly ok: true;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    }
  | { readonly ok: false; readonly message: string } {
  const resolved = resolveProjectSettings(input.settings, input.projectId, input.project);
  const defaultSelection =
    resolved.settings.defaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(
      input.providers,
      resolved.settings,
      input.projectId,
    );
  const resolution = resolveNewThreadModelSelection({
    defaultSelection,
    fallbackSelection: resolved.settings.fallbackModelSelection,
    providers: input.providers,
    settings: resolved.settings,
    projectId: input.projectId,
    now: input.now,
  });
  if (resolution.selection === null) {
    return {
      ok: false,
      message: "No model is ready for this project. Set up a provider in Settings > Providers.",
    };
  }
  return {
    ok: true,
    modelSelection: resolution.selection,
    runtimeMode: resolved.settings.defaultRuntimeMode,
    interactionMode: "default",
  };
}

/** Places a thread the quick composer started: its chosen grid when there is room, else the workspace's grid. */
export function placeQuickComposerThread(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly gridId: string | null;
}): string | null {
  const store = useGridStore.getState();
  if (input.gridId !== null) {
    const grid = gridById(store.grids, input.gridId);
    const count = grid?.tree === null || grid === null ? 0 : preorderThreads(grid.tree).length;
    if (grid !== null && count < MAX_GRID_THREADS) {
      store.addThread(grid.id, input.threadId);
      return grid.id;
    }
  }
  return ensureThreadPlaced({
    environmentId: input.environmentId,
    projectId: input.projectId,
    threadId: input.threadId,
  });
}
