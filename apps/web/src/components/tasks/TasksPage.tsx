import { EnvironmentId } from "@houston-app/contracts";
import type { HoustonTaskSummary } from "@houston-app/contracts/houston/tasks";

import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { environmentProjects } from "~/state/projects";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { loadTaskSettings, tasksEnvironment, useTasksView } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOpenThreadInGrid } from "~/grid/openThreadInGrid";
import { requestConfirmDialog } from "~/confirmDialog";
import { isDesktopHost } from "~/env";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { cn } from "~/lib/utils";
import { usePanelAnimationSettings, usePanelPresence } from "~/panelAnimations";
import {
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { TASKS_PANEL_REF } from "./taskPanel";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { RightPanelTabs } from "../RightPanelTabs";
import { Alert, AlertDescription } from "../ui/alert";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Skeleton } from "../ui/skeleton";
import { Card } from "../ui/card";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { TaskEditorDialog } from "./TaskEditorDialog";
import { TaskProjectPanel, TaskProjectView } from "./TaskProjectView";
import { TaskQueueView } from "./TaskQueueView";
import { TaskSourcesView } from "./TaskSourcesView";
import {
  groupTasksByProject,
  queueTaskGroups,
  type ProjectTaskGroup,
  type TaskNextActionKind,
} from "./tasks.logic";

export type TasksView = "queue" | "projects" | "sources";

export interface TasksSearch {
  readonly task?: string;
  readonly view?: TasksView;
  readonly workspace?: string;
  readonly q?: string;
  readonly new?: boolean;
}

function readableFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The task request failed.";
}

function getShortcutContext() {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
    isWeb: !isDesktopHost,
    isDesktop: isDesktopHost,
  };
}

function workspaceOptions(projects: ReadonlyArray<{ id: string; title: string }>) {
  return [
    { value: "all", label: "All workspaces" },
    { value: "none", label: "No workspace" },
    ...projects.map((project) => ({ value: project.id, label: project.title })),
  ];
}

function NewProjectDialog({
  open,
  onOpenChange,
  environmentId,
  projectId,
  projectTitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId | null;
  projectId: string | null;
  projectTitle: string | null;
}) {
  const saveInitiative = useAtomCommand(tasksEnvironment.saveInitiative);
  const [name, setName] = useState(projectTitle ?? "");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const canSave = environmentId !== null && projectId !== null && name.trim().length > 0;
  const create = async () => {
    if (!canSave || environmentId === null || projectId === null || busy) return;
    setBusy(true);
    const outcome = await saveInitiative({
      environmentId,
      input: {
        projectId: projectId as never,
        name: name.trim(),
        trackerDescription: description.trim().length === 0 ? null : description,
        localDecisions: [],
      },
    });
    setBusy(false);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Project not created",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
      return;
    }
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Text variant="caption" tone="muted" weight="medium">
                Workspace
              </Text>
              <Text variant="callout">{projectTitle ?? "Choose a workspace first"}</Text>
            </div>
            <div className="grid gap-1.5">
              <Text variant="caption" tone="muted" weight="medium">
                Name
              </Text>
              <Input
                value={name}
                autoFocus
                onChange={(event) => setName(event.currentTarget.value)}
                aria-label="Project name"
              />
            </div>
            <div className="grid gap-1.5">
              <Text variant="caption" tone="muted" weight="medium">
                Tracker description
              </Text>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
                aria-label="Tracker description"
                rows={4}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave || busy} onClick={() => void create()}>
            Create project
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function TasksPage() {
  const search = useSearch({ from: "/_chat/tasks" });
  const navigate = useNavigate({ from: "/tasks" });
  const environmentId = usePrimaryEnvironmentId();
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (project) => environmentId === null || project.environmentId === environmentId,
  );
  const projectTitles = new Map(projects.map((project) => [project.id as string, project.title]));
  const projectOptions = projects.map((project) => ({
    id: project.id as string,
    title: project.title,
  }));
  const view: TasksView =
    search.view === "projects" ? "projects" : search.view === "sources" ? "sources" : "queue";
  const workspace = search.workspace ?? "all";
  const scope =
    workspace === "all"
      ? ("all" as const)
      : workspace === "none"
        ? ("unassigned" as const)
        : { projectId: workspace as never };
  const { snapshot, error: tasksError } = useTasksView(
    environmentId,
    view === "sources" ? "all" : scope,
  );
  const openThread = useOpenThreadInGrid();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const startTask = useAtomCommand(tasksEnvironment.start);
  const planStart = useAtomCommand(tasksEnvironment.planStart);
  const [editorOpenState, setEditorOpenState] = useState(false);
  const editorOpen = editorOpenState || search.new === true;
  const setEditorOpen = (next: boolean) => {
    setEditorOpenState(next);
    if (!next && search.new === true) updateSearch({ new: undefined });
  };
  const [sourceProjectId, setSourceProjectId] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectPanel, setProjectPanel] = useState<ProjectTaskGroup | null>(null);

  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, TASKS_PANEL_REF),
  );
  const selectedSurface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, TASKS_PANEL_REF),
  );
  const activeTaskSurface =
    selectedSurface?.kind === "task" && selectedSurface.environmentId === environmentId
      ? selectedSurface
      : null;
  const taskSurfaces = rightPanelState.surfaces.filter(
    (surface): surface is Extract<RightPanelSurface, { kind: "task" }> => surface.kind === "task",
  );
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const projectPanelPresence = usePanelPresence(
    projectPanel !== null,
    projectPanel,
    panelAnimationsActive,
    TASKS_PANEL_REF.threadId,
    panelAnimationDurationMs,
  );
  const renderedProjectPanel = projectPanelPresence.value;
  const taskRightPanelOpen =
    rightPanelState.isOpen && activeTaskSurface !== null && environmentId !== null;

  type TasksSearchPatch = { [K in keyof TasksSearch]?: TasksSearch[K] | undefined };
  const updateSearch = (patch: TasksSearchPatch) => {
    const next: Record<string, unknown> = { ...search };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    void navigate({ to: "/tasks", search: next as TasksSearch, replace: true });
  };

  const openTask = (taskKey: string) => {
    if (environmentId === null) return;
    setProjectPanel(null);
    useRightPanelStore.getState().openTask(TASKS_PANEL_REF, { environmentId, taskKey });
    updateSearch({ task: taskKey });
  };

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps the shared right-panel store's task tab in step with the route's task param while the page is mounted
  useEffect(() => {
    const taskKey = search.task;
    if (taskKey === undefined || environmentId === null) return;
    const current = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      TASKS_PANEL_REF,
    );
    const existing = current.surfaces.find(
      (surface) =>
        surface.kind === "task" &&
        surface.taskKey.toUpperCase() === taskKey.toUpperCase() &&
        surface.environmentId === environmentId,
    );
    if (existing === undefined) {
      useRightPanelStore.getState().openTask(TASKS_PANEL_REF, { environmentId, taskKey });
    } else if (current.activeSurfaceId !== existing.id) {
      useRightPanelStore.getState().activateSurface(TASKS_PANEL_REF, existing.id);
    }
  }, [environmentId, search.task]);

  const activeKeyTask =
    activeTaskSurface?.taskKey ??
    taskSurfaces.find((surface) => surface.id === rightPanelState.activeSurfaceId)?.taskKey ??
    null;

  const closeSurface = (surface: RightPanelSurface) => {
    useRightPanelStore.getState().closeSurface(TASKS_PANEL_REF, surface.id);
    const next = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      TASKS_PANEL_REF,
    );
    updateSearch({ task: next?.kind === "task" ? next.taskKey : undefined });
  };

  const activateSurface = (surface: RightPanelSurface) => {
    useRightPanelStore.getState().activateSurface(TASKS_PANEL_REF, surface.id);
    if (surface.kind === "task") updateSearch({ task: surface.taskKey });
  };

  const openRunThread = (summary: HoustonTaskSummary) => {
    if (environmentId === null || summary.openRun?.threadId == null) return;
    void openThread({
      environmentId,
      projectId: summary.projectId,
      threadId: summary.openRun.threadId as never,
    });
  };

  const startTaskNow = async (summary: HoustonTaskSummary, overrideReadiness = false) => {
    if (environmentId === null) return;
    if (environmentId === null) return;
    const outcome = await startTask({
      environmentId,
      input: {
        id: summary.key,
        ...(summary.projectId === null ? {} : { projectId: summary.projectId }),
        ...(overrideReadiness ? { overrideReadiness: true } : {}),
      },
    });
    if (outcome._tag === "Failure") {
      const error = squashAtomCommandFailure(outcome);
      if (
        !overrideReadiness &&
        typeof error === "object" &&
        error !== null &&
        "kind" in error &&
        (error as { kind?: unknown }).kind === "unready"
      ) {
        const confirmed = await requestConfirmDialog(
          `${readableFailure(error)}\nStart anyway? The queue will still skip it.`,
        );
        if (confirmed === true) await startTaskNow(summary, true);
        return;
      }
      toastManager.add({
        type: "error",
        title: `${summary.key} not started`,
        description: readableFailure(error),
      });
      return;
    }
    if (outcome.value.run.threadId !== null) {
      void openThread({
        environmentId,
        projectId: summary.projectId,
        threadId: outcome.value.run.threadId as never,
      });
    }
  };

  const planTask = async (summary: HoustonTaskSummary) => {
    if (environmentId === null || summary.projectId === null) return;
    const settings = await loadTaskSettings(environmentId, summary.projectId);
    if (settings === null) {
      openTask(summary.key);
      toastManager.add({
        type: "error",
        title: `${summary.key} not planned`,
        description: "The workspace's task settings are not loaded yet.",
      });
      return;
    }
    const outcome = await planStart({
      environmentId,
      input: {
        id: summary.key,
        expectedRevision: summary.revision,
        modelSelection: settings.startModel,
      },
    });
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `${summary.key} not planned`,
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
      openTask(summary.key);
      return;
    }
    const threadId = outcome.value.planning?.threadId ?? null;
    if (threadId !== null) {
      void openThread({
        environmentId,
        projectId: summary.projectId,
        threadId: threadId as never,
      });
    }
  };

  const handleAction = (kind: TaskNextActionKind, summary: HoustonTaskSummary) => {
    switch (kind) {
      case "answer":
        if (summary.openRun?.threadId !== null && summary.openRun?.threadId !== undefined) {
          openRunThread(summary);
        } else {
          openTask(summary.key);
        }
        return;
      case "start":
        void startTaskNow(summary);
        return;
      case "plan":
        void planTask(summary);
        return;
      case "resume":
      case "review":
        openTask(summary.key);
        return;
    }
  };

  const deliveryParentIds = new Set(
    snapshot.tasks.map((task) => task.parentId).filter((id): id is number => id !== null),
  );
  const deliveries = snapshot.tasks
    .filter((task) => deliveryParentIds.has(task.id))
    .map((task) => ({ id: task.id, key: task.key, title: task.title }));
  const taskGroups = queueTaskGroups(snapshot.tasks, { query: search.q ?? "" });
  const projectGroups = groupTasksByProject(snapshot.tasks, projectTitles, {
    query: search.q ?? "",
  });
  const selectedProject =
    workspace === "all" || workspace === "none"
      ? null
      : (projectOptions.find((project) => project.id === workspace) ?? null);

  const newTaskDisabled = environmentId === null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <WorkspacePageHeader desktop={isDesktopHost}>
            <WorkspaceBreadcrumb ariaLabel="Tasks breadcrumb">
              <WorkspaceBreadcrumbItem current={view !== "sources"}>
                <Text as="h1" variant="headline" weight="semibold">
                  Tasks
                </Text>
              </WorkspaceBreadcrumbItem>
              {view === "sources" ? (
                <>
                  <WorkspaceBreadcrumbSeparator />
                  <WorkspaceBreadcrumbItem current>
                    <Text as="h1" variant="headline" weight="semibold">
                      Sources
                    </Text>
                  </WorkspaceBreadcrumbItem>
                </>
              ) : null}
            </WorkspaceBreadcrumb>
          </WorkspacePageHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ToggleGroup
                value={[view]}
                onValueChange={(next) => {
                  const target =
                    next[0] === "projects"
                      ? "projects"
                      : next[0] === "sources"
                        ? "sources"
                        : "queue";
                  updateSearch({ view: target });
                }}
              >
                <Toggle value="queue">Queue</Toggle>
                <Toggle value="projects">By project</Toggle>
                <Toggle value="sources">Sources</Toggle>
              </ToggleGroup>
              {view === "sources" ? null : (
                <>
                  <InputGroup className="min-w-40 flex-1">
                    <InputGroupAddon>
                      <SearchIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      value={search.q ?? ""}
                      placeholder="Search"
                      aria-label="Search tasks"
                      size="compact"
                      onChange={(event) =>
                        updateSearch({ q: event.currentTarget.value || undefined })
                      }
                    />
                  </InputGroup>
                  <div className="w-48 shrink-0">
                    <Select
                      value={workspace}
                      onValueChange={(value) => {
                        if (typeof value === "string") updateSearch({ workspace: value });
                      }}
                    >
                      <SelectTrigger aria-label="Workspace">
                        <SelectValue>
                          {workspaceOptions(projectOptions).find(
                            (option) => option.value === workspace,
                          )?.label ?? "All workspaces"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {workspaceOptions(projectOptions).map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  {view === "projects" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={selectedProject === null}
                      onClick={() => setNewProjectOpen(true)}
                    >
                      <PlusIcon aria-hidden />
                      New project
                    </Button>
                  ) : null}
                  <Button size="sm" disabled={newTaskDisabled} onClick={() => setEditorOpen(true)}>
                    <PlusIcon aria-hidden />
                    New task
                  </Button>
                </>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tasksError !== null && !snapshot.loaded ? (
                <Alert variant="error">
                  <AlertDescription>{tasksError}</AlertDescription>
                </Alert>
              ) : !snapshot.loaded ? (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} className="h-9 w-full" />
                  ))}
                </div>
              ) : view === "sources" ? (
                <TaskSourcesView
                  environmentId={environmentId as EnvironmentId}
                  projects={projectOptions}
                  tasks={snapshot.tasks}
                  projectId={
                    sourceProjectId ??
                    (workspace === "all" || workspace === "none"
                      ? (projectOptions[0]?.id ?? null)
                      : workspace)
                  }
                  onProjectChange={setSourceProjectId}
                  onOpenTask={openTask}
                />
              ) : view === "queue" ? (
                <TaskQueueView
                  groups={taskGroups}
                  onOpen={(summary) => openTask(summary.key)}
                  onAction={handleAction}
                />
              ) : (
                <TaskProjectView
                  groups={projectGroups}
                  onOpen={(summary) => openTask(summary.key)}
                  onAction={handleAction}
                  onOpenProject={(group) => {
                    setProjectPanel(group);
                    useRightPanelStore.getState().closeAllSurfaces(TASKS_PANEL_REF);
                    updateSearch({ task: undefined });
                  }}
                />
              )}
            </div>
          </div>
        </div>
        {/* An open project panel wins over the task's right panel; a closing one yields to it. */}
        {renderedProjectPanel !== null && (projectPanel !== null || !taskRightPanelOpen) ? (
          <aside
            className={cn(
              "flex shrink-0 flex-col overflow-clip",
              projectPanel !== null ? "w-[420px]" : "w-0",
              panelAnimationsActive &&
                "[[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-standard",
              panelAnimationsActive &&
                projectPanel !== null &&
                "[[data-panel-animations=true]_&]:starting:w-0!",
            )}
            data-slot="tasks-project-panel"
          >
            <div className="flex min-h-0 flex-1 flex-col p-2">
              <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <TaskProjectPanel
                  environmentId={environmentId as EnvironmentId}
                  group={renderedProjectPanel}
                  onClose={() => setProjectPanel(null)}
                />
              </Card>
            </div>
          </aside>
        ) : taskRightPanelOpen ? (
          <RightPanelTabs
            mode="inline"
            open={rightPanelState.isOpen}
            keybindings={keybindings}
            getShortcutContext={getShortcutContext}
            widthStorageKey="houston:tasks-panel-width"
            defaultWidth={400}
            surfaces={taskSurfaces}
            environmentId={environmentId}
            activeSurfaceId={activeTaskSurface.id}
            pendingSurfaceIds={new Set()}
            previewSessions={{}}
            desktopByTabId={{}}
            terminalLabelsById={new Map()}
            onActivate={activateSurface}
            onCloseSurface={closeSurface}
            onCloseOtherSurfaces={(surface) => {
              useRightPanelStore.getState().closeOtherSurfaces(TASKS_PANEL_REF, surface.id);
              if (surface.kind === "task") updateSearch({ task: surface.taskKey });
            }}
            onCloseSurfacesToRight={(surface) => {
              useRightPanelStore.getState().closeSurfacesToRight(TASKS_PANEL_REF, surface.id);
              if (surface.kind === "task") updateSearch({ task: surface.taskKey });
            }}
            onCloseAllSurfaces={() => {
              useRightPanelStore.getState().closeAllSurfaces(TASKS_PANEL_REF);
              updateSearch({ task: undefined });
            }}
            onMoveSurface={(surfaceId, toIndex) =>
              useRightPanelStore.getState().moveSurface(TASKS_PANEL_REF, surfaceId, toIndex)
            }
            onCopyFilePath={() => undefined}
            onAddBrowser={() => undefined}
            onAddBrowserInProfile={() => undefined}
            onAddTerminal={() => undefined}
            onAddDiff={() => undefined}
            onAddFiles={() => undefined}
            onAddPullRequest={() => undefined}
            onAddPullRequests={() => undefined}
            onAddDevice={() => undefined}
            browserAvailable={false}
            terminalAvailable={false}
            diffAvailable={false}
            filesAvailable={false}
            pullRequestAvailable={false}
            pullRequestsAvailable={false}
            deviceAvailable={false}
          >
            {activeKeyTask === null ? null : (
              <TaskDetailPanel
                key={activeKeyTask}
                environmentId={environmentId}
                taskKey={activeKeyTask}
                projects={projectOptions}
                deliveries={deliveries}
              />
            )}
          </RightPanelTabs>
        ) : null}
      </div>
      <TaskEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        environmentId={environmentId as EnvironmentId}
        projects={projectOptions}
        deliveries={deliveries}
        onSaved={() => undefined}
      />
      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        environmentId={environmentId}
        projectId={selectedProject?.id ?? null}
        projectTitle={selectedProject?.title ?? null}
      />
    </SidebarInset>
  );
}
