import { createFileRoute } from "@tanstack/react-router";

import { TasksPage } from "../components/tasks/TasksPage";
import { validateTasksSearch } from "../components/tasks/tasksSearch";

export const Route = createFileRoute("/_chat/tasks")({
  validateSearch: validateTasksSearch,
  component: TasksPage,
});
