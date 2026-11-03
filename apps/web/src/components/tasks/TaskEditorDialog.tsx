import { type EnvironmentId, type ProjectId } from "@houston-app/contracts";
import type {
  HoustonTask,
  HoustonTaskAcceptanceItem,
  HoustonTaskDomainKind,
  HoustonTaskPriority,
  HoustonTaskStatus,
} from "@houston-app/contracts/houston/tasks";

import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { useState } from "react";

import { useTaskCommands } from "./useTaskCommands";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { TASK_KIND_LABELS, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "./tasks.logic";

export interface TaskDeliveryOption {
  readonly id: number;
  readonly key: string;
  readonly title: string;
}

function readableFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The task request failed.";
}

function TaskEditorForm({
  environmentId,
  projects,
  task,
  domainKind,
  deliveries,
  acceptance,
  onSaved,
  onCancel,
  onConflict,
}: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  task: HoustonTask | null;
  domainKind: HoustonTaskDomainKind | null;
  deliveries: ReadonlyArray<TaskDeliveryOption>;
  acceptance: ReadonlyArray<HoustonTaskAcceptanceItem>;
  onSaved: () => void;
  onCancel: () => void;
  onConflict?: (() => void) | undefined;
}) {
  const commands = useTaskCommands(environmentId);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [status, setStatus] = useState<HoustonTaskStatus>(task?.status ?? "backlog");
  const [priority, setPriority] = useState<HoustonTaskPriority>(task?.priority ?? "none");
  const [projectId, setProjectId] = useState<string | null>(task?.projectId ?? null);
  const [kind, setKind] = useState<HoustonTaskDomainKind | null>(
    domainKind ?? (task === null ? "delivery" : null),
  );
  const [parentId, setParentId] = useState<number | null>(task?.parentId ?? null);
  const [acceptanceText, setAcceptanceText] = useState(
    acceptance.map((item) => item.text).join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deliveryOptions = deliveries.some((delivery) => delivery.id === parentId)
    ? deliveries
    : task?.parentId === null || task?.parentId === undefined || parentId === null
      ? deliveries
      : [...deliveries, { id: parentId, key: `#${parentId}`, title: "Current delivery" }];
  const canSave = title.trim().length > 0 && (kind !== "slice" || parentId !== null);
  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    const patch = {
      title: title.trim(),
      description,
      status,
      priority,
      projectId: projectId as ProjectId | null,
      acceptance: acceptanceText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      ...(kind === null ? {} : { parentId: kind === "slice" ? parentId : null }),
    };
    const outcome = await commands.save(
      task === null
        ? { ...(projectId === null ? {} : { projectId: projectId as ProjectId }), patch }
        : { id: task.key, expectedRevision: task.revision, patch },
    );
    if (outcome._tag === "Failure") {
      setBusy(false);
      const failure = squashAtomCommandFailure(outcome);
      if (
        typeof failure === "object" &&
        failure !== null &&
        "kind" in failure &&
        (failure as { kind?: unknown }).kind === "conflict"
      ) {
        onConflict?.();
      }
      const message = readableFailure(failure);
      setError(message);
      toastManager.add({ type: "error", title: "Task not saved", description: message });
      return;
    }
    const saved = outcome.value as { readonly key: string; readonly revision: number };
    if (kind !== null && kind !== domainKind) {
      const domain = await commands.saveDomain({
        id: saved.key,
        expectedRevision: saved.revision,
        kind,
      });
      if (domain._tag === "Failure") {
        setBusy(false);
        const message = readableFailure(squashAtomCommandFailure(domain));
        setError(message);
        toastManager.add({ type: "error", title: "Task kind not saved", description: message });
        return;
      }
    }
    setBusy(false);
    onSaved();
  };

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogPanel>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              autoFocus
              maxLength={200}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={description}
              rows={5}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select
                value={status}
                onValueChange={(value) => {
                  if (typeof value === "string" && value in TASK_STATUS_LABELS) {
                    setStatus(value as HoustonTaskStatus);
                  }
                }}
              >
                <SelectTrigger aria-label="Status">
                  <SelectValue>{TASK_STATUS_LABELS[status]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {(Object.keys(TASK_STATUS_LABELS) as HoustonTaskStatus[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {TASK_STATUS_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Priority</Label>
              <Select
                value={priority}
                onValueChange={(value) => {
                  if (typeof value === "string" && value in TASK_PRIORITY_LABELS) {
                    setPriority(value as HoustonTaskPriority);
                  }
                }}
              >
                <SelectTrigger aria-label="Priority">
                  <SelectValue>{TASK_PRIORITY_LABELS[priority]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {(Object.keys(TASK_PRIORITY_LABELS) as HoustonTaskPriority[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {TASK_PRIORITY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Workspace</Label>
            <Select
              value={projectId ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string") setProjectId(value === "" ? null : value);
              }}
            >
              <SelectTrigger aria-label="Workspace">
                <SelectValue>
                  {projectId === null
                    ? "No workspace"
                    : (projects.find((project) => project.id === projectId)?.title ?? projectId)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">No workspace</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Kind</Label>
            <Select
              value={kind ?? ""}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                const next = value === "delivery" || value === "slice" ? value : null;
                setKind(next);
                if (next !== "slice") setParentId(null);
              }}
            >
              <SelectTrigger aria-label="Kind">
                <SelectValue>{kind === null ? "Set a kind" : TASK_KIND_LABELS[kind]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(TASK_KIND_LABELS) as HoustonTaskDomainKind[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {TASK_KIND_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Text variant="caption" tone="muted">
              A task needs a delivery or slice kind before it can be planned.
            </Text>
            {kind !== "slice" ? null : (
              <>
                <Label>Parent delivery</Label>
                <Select
                  value={parentId === null ? "" : String(parentId)}
                  onValueChange={(value) => {
                    if (typeof value === "string") {
                      setParentId(value === "" ? null : Number(value));
                    }
                  }}
                >
                  <SelectTrigger aria-label="Parent delivery">
                    <SelectValue>
                      {parentId === null
                        ? "Choose a delivery"
                        : (() => {
                            const delivery = deliveryOptions.find((entry) => entry.id === parentId);
                            return delivery === undefined
                              ? `#${parentId}`
                              : `${delivery.key} ${delivery.title}`;
                          })()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {deliveryOptions.map((delivery) => (
                      <SelectItem key={delivery.id} value={String(delivery.id)}>
                        {delivery.key} {delivery.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {parentId === null ? (
                  <Text variant="caption" tone="warning">
                    A slice needs a parent delivery.
                  </Text>
                ) : null}
              </>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-acceptance">Acceptance</Label>
            <Textarea
              id="task-acceptance"
              value={acceptanceText}
              rows={4}
              placeholder="One check per line"
              onChange={(event) => setAcceptanceText(event.currentTarget.value)}
            />
            <Text variant="caption" tone="muted">
              {acceptanceText.split("\n").filter((line) => line.trim().length > 0).length} of 50
              items
            </Text>
          </div>
          {error === null ? null : (
            <Text variant="callout" tone="danger">
              {error}
            </Text>
          )}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave || busy}>
          {task === null ? "Create task" : "Save task"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function TaskEditorDialog({
  open,
  onOpenChange,
  environmentId,
  projects,
  task = null,
  domainKind = null,
  deliveries = [],
  acceptance = [],
  onSaved,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  task?: HoustonTask | null;
  domainKind?: HoustonTaskDomainKind | null;
  deliveries?: ReadonlyArray<TaskDeliveryOption>;
  acceptance?: ReadonlyArray<HoustonTaskAcceptanceItem>;
  onSaved: () => void;
  onConflict?: (() => void) | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{task === null ? "New task" : "Edit task"}</DialogTitle>
        </DialogHeader>
        {open ? (
          <TaskEditorForm
            key={task?.id ?? "new"}
            environmentId={environmentId}
            projects={projects}
            task={task}
            domainKind={domainKind}
            deliveries={deliveries}
            acceptance={acceptance}
            onSaved={() => {
              onSaved();
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
            onConflict={onConflict}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
