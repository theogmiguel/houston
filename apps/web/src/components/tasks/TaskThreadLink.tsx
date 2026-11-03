import type { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ListChecksIcon } from "lucide-react";

import { useTaskForThread } from "~/state/tasks";
import { Button } from "../ui/button";
import { Text } from "../ui/text";

/** A task run's thread names its task key and opens that task's detail. */
export function TaskThreadLink({ threadId }: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const task = useTaskForThread(threadId as string);
  const navigate = useNavigate();
  if (task === null) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={`Open task ${task.key}`}
      onClick={() => void navigate({ to: "/tasks", search: { task: task.key } })}
    >
      <ListChecksIcon aria-hidden />
      <Text as="span" variant="caption" mono>
        {task.key}
      </Text>
    </Button>
  );
}
