export type TasksView = "queue" | "projects" | "sources";

export interface TasksSearch {
  readonly task?: string;
  readonly view?: TasksView;
  readonly workspace?: string;
  readonly q?: string;
  readonly new?: boolean;
}

/** The search a Tasks URL carries, shared by the routed page and a Tasks tab. */
export function validateTasksSearch(raw: Record<string, unknown>): TasksSearch {
  return {
    ...(typeof raw.task === "string" && raw.task ? { task: raw.task.trim().slice(0, 40) } : {}),
    view: raw.view === "projects" ? "projects" : raw.view === "sources" ? "sources" : "queue",
    ...(typeof raw.workspace === "string" && raw.workspace
      ? { workspace: raw.workspace.slice(0, 200) }
      : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
    ...(raw.new === true ? { new: true } : {}),
  };
}
