import { EnvironmentId } from "@houston-app/contracts";
import type {
  HoustonTaskInitiative,
  HoustonTaskSummary,
} from "@houston-app/contracts/houston/tasks";

import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "~/localApi";
import { refreshTaskInitiatives, refreshTaskDetail, useTaskInitiativesResult } from "~/state/tasks";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Progress } from "../ui/progress";
import { Separator } from "../ui/separator";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { TaskRow } from "./TaskRow";
import { useTaskCommands } from "./useTaskCommands";
import type { ProjectTaskGroup, TaskNextActionKind } from "./tasks.logic";

function readableFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The task request failed.";
}

function ProjectEditorForm({
  environmentId,
  projectId,
  initiative,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  initiative: HoustonTaskInitiative | null;
}) {
  const commands = useTaskCommands(environmentId);
  const [name, setName] = useState(initiative?.name ?? "");
  const [trackerDescription, setTrackerDescription] = useState(
    initiative?.trackerDescription ?? "",
  );
  const [decisions, setDecisions] = useState((initiative?.localDecisions ?? []).join("\n"));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (name.trim().length === 0 || busy) return;
    setBusy(true);
    const outcome = await commands.saveInitiative({
      projectId: projectId as never,
      ...(initiative === null ? {} : { id: initiative.id, expectedRevision: initiative.revision }),
      name: name.trim(),
      trackerDescription: trackerDescription.trim().length === 0 ? null : trackerDescription,
      localDecisions: decisions
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      ...(initiative?.externalUrl === undefined ? {} : { externalUrl: initiative.externalUrl }),
    });
    setBusy(false);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Project not saved",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
      return;
    }
    refreshTaskInitiatives(environmentId, projectId);
  };

  const archive = async () => {
    if (initiative === null || busy) return;
    setBusy(true);
    const outcome = await commands.archiveInitiative({
      id: initiative.id,
      archived: true,
      expectedRevision: initiative.revision,
    });
    setBusy(false);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Project not archived",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
      return;
    }
    refreshTaskInitiatives(environmentId, projectId);
    refreshTaskDetail(environmentId, projectId);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex min-w-0 items-center gap-2">
        <Text variant="headline" weight="semibold" truncate className="flex-1">
          {name.trim().length === 0 ? "New project" : name}
        </Text>
        {initiative?.externalUrl === null || initiative?.externalUrl === undefined ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const url = initiative?.externalUrl ?? null;
              if (url === null) return;
              const api = readLocalApi();
              if (api == null) window.open(url, "_blank", "noreferrer");
              else void api.shell.openExternal(url);
            }}
          >
            Tracker
          </Button>
        )}
      </div>
      <div className="grid gap-1.5">
        <Text variant="caption" tone="muted" weight="medium">
          Name
        </Text>
        <Input
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          aria-label="Project name"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <Text variant="caption" tone="muted" weight="medium">
            Tracker description
          </Text>
          {initiative === null ? null : (
            <Badge variant="default" size="sm">
              Unverified snapshot
            </Badge>
          )}
        </div>
        <Textarea
          value={trackerDescription}
          onChange={(event) => setTrackerDescription(event.currentTarget.value)}
          placeholder="What the tracker says this project covers"
          aria-label="Tracker description"
          rows={4}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Text variant="caption" tone="muted" weight="medium">
          Local decisions
        </Text>
        <Textarea
          value={decisions}
          onChange={(event) => setDecisions(event.currentTarget.value)}
          placeholder="One decision per line"
          aria-label="Local decisions"
          rows={4}
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Button size="sm" disabled={busy || name.trim().length === 0} onClick={() => void save()}>
          Save project
        </Button>
        {initiative === null ? null : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void archive()}>
            <ArchiveIcon aria-hidden />
            Archive
          </Button>
        )}
      </div>
    </div>
  );
}

export function TaskProjectPanel({
  environmentId,
  group,
  onClose,
}: {
  environmentId: EnvironmentId;
  group: ProjectTaskGroup;
  onClose?: () => void;
}) {
  const result = useTaskInitiativesResult(environmentId, group.projectId);
  if (group.projectId === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6">
        <Text variant="headline" weight="semibold">
          No project
        </Text>
        <Text variant="callout" tone="muted">
          Assign a task to a workspace to group it under a project.
        </Text>
      </div>
    );
  }
  if (result._tag !== "Success") {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Text variant="callout" tone="muted">
          Loading project…
        </Text>
      </div>
    );
  }
  const initiative = result.value.find((entry) => entry.archivedAt === null) ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-w-0 items-center gap-2 p-4 pb-0">
        <Text variant="caption" tone="muted">
          Project · {group.title}
        </Text>
        <span className="flex-1" />
        <Text variant="caption" tone="muted">
          {group.deliveries.length} deliveries · {group.sliceDone} of {group.sliceTotal} slices done
        </Text>
        {onClose === undefined ? null : (
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
      <ProjectEditorForm
        key={initiative?.id ?? "new"}
        environmentId={environmentId}
        projectId={group.projectId}
        initiative={initiative}
      />
    </div>
  );
}

export function TaskProjectView({
  groups,
  onOpen,
  onAction,
  onOpenProject,
}: {
  groups: ReadonlyArray<ProjectTaskGroup>;
  onOpen: (summary: HoustonTaskSummary) => void;
  onAction: (kind: TaskNextActionKind, summary: HoustonTaskSummary) => void;
  onOpenProject: (group: ProjectTaskGroup) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string | null>>(new Set());
  if (groups.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
        <Text variant="headline" weight="semibold">
          No projects with tasks
        </Text>
        <Text variant="callout" tone="muted">
          Create a task, or choose another workspace.
        </Text>
      </div>
    );
  }
  const toggle = (projectId: string | null) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };
  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        const expanded = !collapsed.has(group.projectId);
        return (
          <Card key={group.projectId ?? "none"}>
            <div className="flex flex-col gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${group.title}`}
                  onClick={() => toggle(group.projectId)}
                >
                  {expanded ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-w-0"
                  disabled={group.projectId === null}
                  onClick={() => onOpenProject(group)}
                >
                  <Text as="span" variant="callout" weight="semibold" truncate>
                    {group.title}
                  </Text>
                </Button>
                {group.projectId === null || group.deliveries.length === 0 ? null : (
                  <Text variant="caption" tone="muted">
                    {group.deliveries.length} deliveries
                  </Text>
                )}
                <span className="flex-1" />
                {group.sliceTotal === 0 ? null : (
                  <>
                    <Progress
                      className="w-24"
                      value={group.sliceDone}
                      max={group.sliceTotal}
                      label={`${group.title} slices done`}
                    />
                    <Text variant="caption" tone="muted">
                      {group.sliceDone}/{group.sliceTotal}
                    </Text>
                  </>
                )}
              </div>
              {expanded ? (
                <div className="flex flex-col gap-1 pl-6">
                  {group.deliveries.map((delivery, index) => (
                    <div key={delivery.delivery.id} className="flex flex-col gap-1">
                      {index === 0 ? null : <Separator className="my-1" />}
                      <TaskRow
                        summary={delivery.delivery}
                        progressLabel={`${delivery.slices.filter((slice) => slice.status === "done").length}/${delivery.slices.length}`}
                        onOpen={onOpen}
                        onAction={onAction}
                      />
                      <div className="flex flex-col gap-1 pl-6">
                        {delivery.slices.map((slice) => (
                          <TaskRow
                            key={slice.id}
                            summary={slice}
                            onOpen={onOpen}
                            onAction={onAction}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  {group.loose.map((task) => (
                    <TaskRow key={task.id} summary={task} onOpen={onOpen} onAction={onAction} />
                  ))}
                </div>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
