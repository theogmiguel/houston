import { createFileRoute } from "@tanstack/react-router";

import { TasksPage, type TasksSearch } from "../components/tasks/TasksPage";

export const Route = createFileRoute("/_chat/tasks")({
  validateSearch: (raw: Record<string, unknown>): TasksSearch => ({
    ...(typeof raw.task === "string" && raw.task ? { task: raw.task.trim().slice(0, 40) } : {}),
    view: raw.view === "projects" ? "projects" : raw.view === "sources" ? "sources" : "queue",
    ...(typeof raw.workspace === "string" && raw.workspace
      ? { workspace: raw.workspace.slice(0, 200) }
      : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
    ...(raw.new === true ? { new: true } : {}),
  }),
  component: TasksPage,
});
