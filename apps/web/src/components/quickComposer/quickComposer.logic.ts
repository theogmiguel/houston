import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
  ServerSettings,
} from "@houston-app/contracts";
import type { EnvironmentProject } from "@houston-app/client-runtime/state/shell";
import { resolveProjectSettings } from "@houston-app/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@houston-app/shared/usageLimits";

import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";

export interface QuickComposerProjectOption {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
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
