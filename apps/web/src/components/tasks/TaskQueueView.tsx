import type { HoustonTaskSummary } from "@houston-app/contracts/houston/tasks";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Text } from "../ui/text";
import { TaskRow } from "./TaskRow";
import type { QueuedTaskGroups, TaskNextActionKind } from "./tasks.logic";

export function TaskQueueView({
  groups,
  onOpen,
  onAction,
}: {
  groups: QueuedTaskGroups;
  onOpen: (summary: HoustonTaskSummary) => void;
  onAction: (kind: TaskNextActionKind, summary: HoustonTaskSummary) => void;
}) {
  const [foldedOpen, setFoldedOpen] = useState(false);
  if (groups.sections.length === 0 && groups.folded.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
        <Text variant="headline" weight="semibold">
          No tasks here
        </Text>
        <Text variant="callout" tone="muted">
          Create a task, or choose another workspace.
        </Text>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.sections.map((group) => (
        <section key={group.section} className="flex flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <Text as="span" variant="caption" weight="semibold" tone="secondary">
              {group.label}
            </Text>
            <Text as="span" variant="caption" tone="muted">
              {group.tasks.length}
            </Text>
            <Separator className="flex-1" />
          </div>
          {group.tasks.map((task) => (
            <TaskRow key={task.id} summary={task} onOpen={onOpen} onAction={onAction} />
          ))}
        </section>
      ))}
      {groups.folded.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="justify-start"
            aria-expanded={foldedOpen}
            onClick={() => setFoldedOpen((open) => !open)}
          >
            {foldedOpen ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
            Done and archived {groups.folded.length}
          </Button>
          {foldedOpen
            ? groups.folded.map((task) => (
                <TaskRow key={task.id} summary={task} onOpen={onOpen} onAction={onAction} />
              ))
            : null}
        </section>
      )}
    </div>
  );
}
