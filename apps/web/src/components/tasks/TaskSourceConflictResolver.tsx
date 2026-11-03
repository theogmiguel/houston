import type { EnvironmentId } from "@houston-app/contracts";
import type {
  HoustonTaskSourceConflict,
  HoustonTaskSourceConflictField,
  HoustonTaskSourceLink,
  HoustonTaskSourceResolution,
} from "@houston-app/contracts/houston/taskSources";
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { useState } from "react";

import { refreshTaskDetail } from "~/state/tasks";
import { taskSourcesEnvironment } from "~/state/taskSources";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Card, ValuePanel } from "../ui/card";
import { Input } from "../ui/input";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";
import { conflictFieldTitle, taskSourceProviderLabel } from "./taskSources.logic";

function readableFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The conflict could not be resolved.";
}

function ConflictCard({
  conflict,
  providerLabel,
  disabled,
  onResolve,
}: {
  conflict: HoustonTaskSourceConflict;
  providerLabel: string;
  disabled: boolean;
  onResolve: (resolution: HoustonTaskSourceResolution) => Promise<boolean>;
}) {
  const [writing, setWriting] = useState(false);
  const [custom, setCustom] = useState("");
  return (
    <Card>
      <div className="flex min-w-0 flex-col gap-2">
        <Text variant="caption" tone="muted" weight="medium">
          {conflictFieldTitle(conflict.field)}
        </Text>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <ValuePanel className="flex flex-col">
            <Text variant="caption" tone="muted">
              Houston
            </Text>
            <Text variant="callout" preserve breakWords>
              {conflict.local.length === 0 ? "Empty" : conflict.local}
            </Text>
          </ValuePanel>
          <ValuePanel className="flex flex-col">
            <Text variant="caption" tone="muted">
              {providerLabel}
            </Text>
            <Text variant="callout" preserve breakWords>
              {conflict.remote.length === 0 ? "Empty" : conflict.remote}
            </Text>
          </ValuePanel>
        </div>
        <Text variant="caption" tone="muted" breakWords>
          Last agreed: {conflict.base.length === 0 ? "Empty" : conflict.base}
        </Text>
        {writing ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <Input
              value={custom}
              autoFocus
              aria-label={`Your ${conflictFieldTitle(conflict.field)}`}
              onChange={(event) => setCustom(event.currentTarget.value)}
            />
            <Button
              size="sm"
              disabled={disabled || custom.trim().length === 0}
              onClick={() => {
                void onResolve({ custom: custom.trim() });
              }}
            >
              Keep
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setWriting(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void onResolve("local")}
            >
              Keep Houston
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void onResolve("remote")}
            >
              Use {providerLabel}
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setWriting(true)}>
              Write your own…
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function TaskSourceConflictResolver({
  environmentId,
  taskKey,
  taskRevision,
  initiativeRevision,
  link,
  onResolved,
}: {
  environmentId: EnvironmentId;
  taskKey: string;
  taskRevision: number;
  initiativeRevision: number | null;
  link: HoustonTaskSourceLink;
  onResolved?: (link: HoustonTaskSourceLink) => void;
}) {
  const resolve = useAtomCommand(taskSourcesEnvironment.resolve);
  const [busyField, setBusyField] = useState<string | null>(null);
  const providerLabel = taskSourceProviderLabel(link.provider);

  const onResolve = async (
    conflict: HoustonTaskSourceConflict,
    resolution: HoustonTaskSourceResolution,
  ): Promise<boolean> => {
    if (busyField !== null) return false;
    if (conflict.field.startsWith("project.") && initiativeRevision === null) {
      toastManager.add({
        type: "error",
        title: "Project conflict not resolved",
        description: "The task's project is not linked to an active initiative yet.",
      });
      return false;
    }
    setBusyField(conflict.field);
    const outcome = await resolve({
      environmentId,
      input: {
        taskId: taskKey,
        expectedTaskRevision: taskRevision,
        ...(initiativeRevision === null ? {} : { expectedInitiativeRevision: initiativeRevision }),
        provider: link.provider,
        externalId: link.externalId,
        field: conflict.field as HoustonTaskSourceConflictField,
        expectedLinkRevision: link.snapshot.revision,
        resolution,
      },
    });
    setBusyField(null);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Conflict not resolved",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
      return false;
    }
    refreshTaskDetail(environmentId, taskKey);
    onResolved?.(outcome.value);
    return true;
  };

  if (link.snapshot.conflicts.length === 0) {
    return (
      <Text variant="caption" tone="muted">
        Houston and {providerLabel} agree on this task.
      </Text>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {link.snapshot.conflicts.map((conflict) => (
        <ConflictCard
          key={conflict.field}
          conflict={conflict}
          providerLabel={providerLabel}
          disabled={busyField !== null}
          onResolve={(resolution) => onResolve(conflict, resolution)}
        />
      ))}
    </div>
  );
}
