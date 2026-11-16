import {
  managedRuntimeModeDenial,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@houston-app/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { createModelSelection } from "@houston-app/shared/model";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
} from "~/providerInstances";
import { useMergeQueueEntry, mergeQueueEnvironment } from "~/state/mergeQueue";
import { useEnvironmentProviders, useEnvironments } from "~/state/environments";
import { EMPTY_SERVER_PROVIDERS } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { firstManagedDenial } from "~/state/managedPolicy";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  MERGE_QUEUE_DIALOG_EMPTY,
  MERGE_QUEUE_DIALOG_NOTE,
  MERGE_QUEUE_MODE_DESCRIPTION,
  MERGE_QUEUE_MODE_ICON,
  MERGE_QUEUE_MODE_ITEM,
  MERGE_QUEUE_MODE_LABEL,
} from "../ui/merge-queue-recipes";
import { mergeQueueFailureTitle } from "./mergeQueue.logic";

export function MergeQueueHandToThreadDialog({
  open,
  onOpenChange,
  environmentId,
  projectId,
  number,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  number: number;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const providers = providersByEnvironment.get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, projectId);
  const defaultSelection =
    resolveProjectDefaultProviderModelSelection(providers, settings, projectId) ??
    settings.defaultModelSelection;
  const [choice, setChoice] = useState<ModelSelection | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(settings.defaultRuntimeMode);
  const [saving, setSaving] = useState(false);
  const handToThread = useAtomCommand(mergeQueueEnvironment.handToThread, {
    reportFailure: false,
  });
  const { entry } = useMergeQueueEntry(environmentId, projectId, number);
  const selection = choice ?? defaultSelection;
  const activeEntry = selection
    ? (entries.find((candidate) => candidate.instanceId === selection.instanceId) ?? null)
    : null;
  const modelOptions = selection
    ? getCustomModelOptionsByInstance(settings, providers, selection.instanceId, selection.model)
    : new Map();
  const supportedModes = activeEntry?.snapshot.supportedRuntimeModes;
  const modes =
    supportedModes && supportedModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedModes.includes(mode))
      : runtimeModeOptions;
  const mode = modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode);
  const ModeIcon = runtimeModeConfig[mode].icon;

  const save = async () => {
    if (selection === null || saving) return;
    setSaving(true);
    const result = await handToThread({
      environmentId,
      input: { projectId, number, modelSelection: selection, runtimeMode: mode },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not hand #${number} to a thread`,
        description:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The merge queue refused it. Try again.",
      });
      return;
    }
    onOpenChange(false);
    toastManager.add({
      type: "success",
      title: `Opened a thread for #${number}`,
      description: entry?.failure
        ? `${mergeQueueFailureTitle(entry.failure)} is in the thread's first message.`
        : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Hand #{number} to a new thread</DialogTitle>
          <DialogDescription>
            The thread opens on the pull request's branch and starts with the failure. Its
            permissions decide what the agent may do without asking.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Model</Label>
              {selection === null ? (
                <p className={MERGE_QUEUE_DIALOG_EMPTY}>No provider is available here.</p>
              ) : (
                <div>
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptions}
                    disabled={saving}
                    onInstanceModelChange={(instanceId, model) =>
                      setChoice(createModelSelection(instanceId, model))
                    }
                  />
                </div>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label>Permissions</Label>
              <Select
                value={mode}
                onValueChange={(next) => setRuntimeMode(next as RuntimeMode)}
                disabled={saving}
              >
                <SelectTrigger aria-label="Thread permissions">
                  <SelectValue>
                    <span className="inline-flex items-center gap-1.5">
                      <ModeIcon className={MERGE_QUEUE_MODE_ICON} />
                      {runtimeModeConfig[mode].label}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {modes.map((candidate) => {
                    const option = runtimeModeConfig[candidate];
                    const Icon = option.icon;
                    const denied = firstManagedDenial(
                      [environment?.serverConfig?.managedPolicy],
                      (policy) => managedRuntimeModeDenial(policy, candidate),
                    );
                    return (
                      <SelectItem
                        key={candidate}
                        value={candidate}
                        disabled={denied !== undefined}
                        className="min-w-64"
                      >
                        <div className={MERGE_QUEUE_MODE_ITEM}>
                          <span className={MERGE_QUEUE_MODE_LABEL}>
                            <Icon className={MERGE_QUEUE_MODE_ICON} />
                            {option.label}
                          </span>
                          <span className={MERGE_QUEUE_MODE_DESCRIPTION}>
                            {denied ?? option.description}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            </div>
            <p className={MERGE_QUEUE_DIALOG_NOTE}>
              Defaults come from the project. The queue keeps the entry out of line while its thread
              works, and takes the new head back on its own.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={selection === null || saving} onClick={() => void save()}>
            Hand to a new thread
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
