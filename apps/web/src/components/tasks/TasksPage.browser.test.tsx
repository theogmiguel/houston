import type { HoustonTaskSummary, HoustonTaskScope } from "@houston-app/contracts/houston/tasks";
import { EnvironmentId } from "@houston-app/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const route = vi.hoisted(() => {
  let search: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  return {
    get: () => search,
    set: (next: Record<string, unknown>) => {
      search = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    calls: [] as unknown[],
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const React = await import("react");
  return {
    ...(await importOriginal<typeof import("@tanstack/react-router")>()),
    useSearch: () => React.useSyncExternalStore(route.subscribe, route.get),
    useNavigate: () => (options: unknown) => {
      route.calls.push(options);
      const search = (options as { search?: Record<string, unknown> } | null)?.search;
      if (search !== undefined) route.set(search);
    },
  };
});

const fixture = vi.hoisted(() => ({
  tasks: [] as HoustonTaskSummary[],
  scope: null as HoustonTaskScope | null,
  calls: [] as unknown[],
}));

vi.mock("~/state/tasks", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    tasksEnvironment: {
      start: {},
      planStart: {},
      saveInitiative: {},
      save: {},
      comment: {},
      check: {},
      archive: {},
      saveDomain: {},
      archiveInitiative: {},
      runControl: {},
      planAnswer: {},
      planApprove: {},
      reviewStart: {},
    },
    useTasksView: (_environmentId: unknown, scope: HoustonTaskScope) => {
      fixture.scope = scope;
      return {
        snapshot: { tasks: fixture.tasks, counts: {}, truncated: false, loaded: true },
        error: null,
      };
    },
    loadTaskSettings: async () => null,
    refreshTaskDetail: () => {},
    refreshTaskInitiatives: () => {},
    useTaskInitiativesResult: () => AsyncResult.success([]),
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (value: unknown) => {
    fixture.calls.push(value);
    return { _tag: "Success", value: { key: "HOU-99", revision: 2 } };
  },
}));
vi.mock("~/state/projects", () => ({
  environmentProjects: {
    projectsAtom: Atom.make([
      { id: "p1", title: "Houston", environmentId: EnvironmentId.make("env") },
    ]),
  },
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("env"),
}));
vi.mock("~/state/server", () => ({
  primaryServerKeybindingsAtom: Atom.make({}),
}));
vi.mock("~/threads/useOpenThread", () => ({ useOpenThread: () => async () => {} }));
vi.mock("./TaskDetailPanel", () => ({
  TaskDetailPanel: ({ taskKey }: { taskKey: string }) => <div data-task-detail>{taskKey}</div>,
}));
vi.mock("../RightPanelTabs", () => ({
  RightPanelTabs: ({
    surfaces,
    children,
  }: {
    surfaces: { id: string; taskKey?: string }[];
    children: import("react").ReactNode;
  }) => (
    <div data-right-panel>
      {surfaces.map((surface) => (
        <span key={surface.id}>{surface.taskKey}</span>
      ))}
      {children}
    </div>
  ),
}));

import { useRightPanelStore } from "~/rightPanelStore";
import { render } from "../../../test/render";
import { TasksPage } from "./TasksPage";

function task(
  overrides: Partial<HoustonTaskSummary> &
    Pick<HoustonTaskSummary, "id" | "number" | "key" | "title">,
): HoustonTaskSummary {
  return {
    projectId: "p1" as never,
    status: "todo",
    priority: "none",
    parentId: null,
    refUrl: null,
    revision: 1,
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    acceptanceChecked: 0,
    acceptanceTotal: 0,
    domainKind: null,
    queue: "none",
    ready: false,
    openRun: null,
    ...overrides,
  };
}

function reset() {
  route.set({});
  route.calls = [];
  fixture.calls = [];
  fixture.scope = null;
  fixture.tasks = [
    task({
      id: 1,
      number: 45,
      key: "HOU-45",
      title: "Rename Harness review to Harness",
      status: "in_progress",
      queue: "up_next",
      ready: true,
    }),
    task({
      id: 2,
      number: 53,
      key: "HOU-53",
      title: "Cache usage totals per day",
      projectId: null as never,
    }),
  ];
  useRightPanelStore.setState({ byThreadKey: {} });
}

it("lists the queue with the workspace picker and opens the new task editor", async () => {
  reset();
  await using screen = await render(<TasksPage />);

  expect(screen.container.textContent).toContain("HOU-45");
  expect(screen.container.textContent).toContain("Cache usage totals per day");
  await screen.getByRole("button", { name: "New task" }).click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  expect(screen.container.textContent).toContain("New task");
});

it("opens a task in the right panel tab and records it in the route", async () => {
  reset();
  await using screen = await render(<TasksPage />);

  await screen.getByRole("button", { name: "HOU-45 Rename Harness review to Harness" }).click();

  expect(screen.container.textContent).toContain("HOU-45");
  expect(route.calls).toContainEqual({
    to: "/tasks",
    search: expect.objectContaining({ task: "HOU-45" }),
    replace: true,
  });
  await expect.element(screen.getByText("HOU-45", { exact: true }).last()).toBeVisible();
});

it("filters rows by the search field", async () => {
  reset();
  await using screen = await render(<TasksPage />);

  await screen.getByRole("textbox", { name: "Search tasks" }).fill("usage");
  expect(screen.container.textContent).toContain("Cache usage totals per day");
  expect(screen.container.textContent).not.toContain("Rename Harness review to Harness");
});

it("switches to the project view", async () => {
  reset();
  await using screen = await render(<TasksPage />);

  await screen.getByRole("button", { name: "By project" }).click();
  expect(screen.container.textContent).toContain("Houston");
  expect(screen.container.textContent).toContain("No project");
});

it("sets a kind in the editor and requires a parent delivery for a slice", async () => {
  reset();
  await using screen = await render(<TasksPage />);

  await screen.getByRole("button", { name: "New task" }).click();
  const kind = page.getByRole("combobox", { name: "Kind" });
  await expect.element(kind).toBeVisible();
  expect(kind.element().textContent).toContain("Delivery");

  await userEvent.click(kind);
  await userEvent.click(page.getByRole("option", { name: "Slice" }));

  await expect.element(page.getByText("A slice needs a parent delivery.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Create task" })).toBeDisabled();
});

it("creates a task with its kind so it can be planned", async () => {
  reset();
  await using screen = await render(<TasksPage />);

  await screen.getByRole("button", { name: "New task" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Plan the usage page");
  await userEvent.keyboard("{Enter}");

  expect(fixture.calls).toContainEqual({
    environmentId: EnvironmentId.make("env"),
    input: expect.objectContaining({
      patch: expect.objectContaining({ title: "Plan the usage page", parentId: null }),
    }),
  });
  expect(fixture.calls).toContainEqual({
    environmentId: EnvironmentId.make("env"),
    input: { id: "HOU-99", expectedRevision: 2, kind: "delivery" },
  });
});
