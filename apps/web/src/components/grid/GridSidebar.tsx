import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ChevronRightIcon,
  FolderIcon,
  LayoutGridIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { type GridRecord, gridsForWorkspace, useGridStore } from "../../grid/gridStore";
import { preorderThreads } from "../../grid/tree";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarContent, SidebarFooter, SidebarHeader } from "../ui/sidebar";
import { cn } from "../../lib/utils";
import { useQuietThreadShells, useProjects } from "../../state/entities";
import { resolveThreadStatusPill } from "../Sidebar.logic";

export function workspaceKeyOf(project: Pick<EnvironmentProject, "environmentId" | "id">): string {
  return `${project.environmentId}:${project.id}`;
}

export function GridSidebar() {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const grids = useGridStore((store) => store.grids);
  const createGrid = useGridStore((store) => store.createGrid);
  const navigate = useNavigate();

  return (
    <>
      <SidebarHeader className="gap-1 p-2">
        <div className="flex items-center gap-2 px-1.5 py-1">
          <LayoutGridIcon className="size-4 text-muted-foreground" />
          <span className="text-xs font-semibold tracking-wide text-sidebar-foreground uppercase">
            Grids
          </span>
        </div>
        <Link
          to="/"
          className="flex h-7 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <MessageSquareIcon className="size-3.5" />
          All threads
        </Link>
      </SidebarHeader>
      <SidebarContent className="gap-1 px-2 pb-2">
        {projects.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Open a project to create its first grid.
          </p>
        ) : null}
        {projects.map((project) => (
          <WorkspaceGroup
            key={workspaceKeyOf(project)}
            project={project}
            grids={gridsForWorkspace(grids, workspaceKeyOf(project))}
            threads={threads.filter(
              (thread) =>
                thread.environmentId === project.environmentId &&
                thread.projectId === project.id &&
                thread.archivedAt === null,
            )}
            onCreateGrid={() => {
              const gridId = createGrid({
                environmentId: project.environmentId,
                projectId: project.id,
                workspaceKey: workspaceKeyOf(project),
              });
              void navigate({ to: "/grid/$gridId", params: { gridId } });
            }}
          />
        ))}
      </SidebarContent>
      <SidebarFooter className="p-2">
        <Link
          to="/settings"
          className="flex h-7 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <SettingsIcon className="size-3.5" />
          Settings
        </Link>
      </SidebarFooter>
    </>
  );
}

function WorkspaceGroup({
  project,
  grids,
  threads,
  onCreateGrid,
}: {
  project: EnvironmentProject;
  grids: GridRecord[];
  threads: ReadonlyArray<EnvironmentThreadShell>;
  onCreateGrid: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="flex flex-col">
      <div className="group flex items-center gap-1">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-xs font-medium text-sidebar-foreground hover:bg-sidebar-row-hover"
          title={project.workspaceRoot}
          aria-expanded={!collapsed}
        >
          <ChevronRightIcon
            className={cn("size-3 shrink-0 text-muted-foreground", !collapsed && "rotate-90")}
          />
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{project.title}</span>
        </button>
        <Button
          variant="ghost-muted"
          size="icon-micro"
          aria-label={`New grid in ${project.title}`}
          onClick={onCreateGrid}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <PlusIcon />
        </Button>
      </div>
      {collapsed ? null : (
        <div className="ml-3 flex flex-col gap-0.5 border-l border-sidebar-border/60 pl-2">
          {grids.length === 0 ? (
            <button
              type="button"
              onClick={onCreateGrid}
              className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <PlusIcon className="size-3.5" />
              New grid
            </button>
          ) : null}
          {grids.map((grid) => (
            <GridRow key={grid.id} grid={grid} workspaceThreads={threads} />
          ))}
        </div>
      )}
    </section>
  );
}

function GridRow({
  grid,
  workspaceThreads,
}: {
  grid: GridRecord;
  workspaceThreads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const navigate = useNavigate();
  const renameGrid = useGridStore((store) => store.renameGrid);
  const deleteGrid = useGridStore((store) => store.deleteGrid);
  const addThread = useGridStore((store) => store.addThread);
  const removeThreadFromGrid = useGridStore((store) => store.removeThreadFromGrid);
  const focusThread = useGridStore((store) => store.focusThread);
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(grid.name);
  const leaves = preorderThreads(grid.tree);
  const leafIds = new Set(leaves.map((leaf) => leaf.threadId));
  const available = workspaceThreads.filter((thread) => !leafIds.has(thread.id));

  const openThread = (threadId: string) => {
    focusThread(grid.id, threadId);
    void navigate({ to: "/grid/$gridId", params: { gridId: grid.id } });
  };

  return (
    <div className="flex flex-col">
      <div className="group flex items-center gap-1">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-sidebar-foreground hover:bg-sidebar-row-hover"
          aria-expanded={!collapsed}
        >
          <ChevronRightIcon
            className={cn("size-3 shrink-0 text-muted-foreground", !collapsed && "rotate-90")}
          />
          <LayoutGridIcon className="size-3.5 shrink-0 text-muted-foreground" />
          {renaming ? (
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onBlur={() => {
                renameGrid(grid.id, name);
                setRenaming(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setName(grid.name);
                  setRenaming(false);
                }
              }}
              className="h-5 min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-xs text-foreground outline-none focus:border-ring"
            />
          ) : (
            <>
              <span className="truncate">{grid.name}</span>
              <span className="text-2xs text-muted-foreground">{leaves.length}</span>
            </>
          )}
        </button>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={`Grid actions for ${grid.name}`}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground group-hover:opacity-100 focus-visible:opacity-100"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </button>
            }
          />
          <MenuPopup side="bottom" align="end">
            <MenuItem
              onClick={() => {
                setName(grid.name);
                setRenaming(true);
              }}
            >
              Rename grid
            </MenuItem>
            <MenuItem
              onClick={() => {
                void navigate({ to: "/grid/$gridId", params: { gridId: grid.id } });
              }}
            >
              Open grid
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => void deleteGridWithConfirm(grid, deleteGrid)}>
              Delete grid
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {collapsed ? null : (
        <div className="ml-3 flex flex-col gap-0.5 border-l border-sidebar-border/60 pl-2">
          {leaves.map((leaf) => (
            <ThreadRow
              key={leaf.id}
              environmentId={grid.environmentId}
              threadId={leaf.threadId}
              shell={workspaceThreads.find((candidate) => candidate.id === leaf.threadId)}
              active={grid.focusedThreadId === leaf.threadId}
              onOpen={() => openThread(leaf.threadId)}
              onRemove={() => removeThreadFromGrid(grid.id, leaf.threadId)}
            />
          ))}
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                >
                  <PlusIcon className="size-3" />
                  Add thread
                </button>
              }
            />
            <MenuPopup side="bottom" align="start">
              {available.length === 0 ? (
                <MenuItem disabled>Every workspace thread is already here</MenuItem>
              ) : (
                available.map((thread) => (
                  <MenuItem
                    key={thread.id}
                    onClick={() => {
                      addThread(grid.id, thread.id);
                      openThread(thread.id);
                    }}
                  >
                    {thread.title}
                  </MenuItem>
                ))
              )}
              <MenuSeparator />
              <NewThreadItem grid={grid} />
            </MenuPopup>
          </Menu>
        </div>
      )}
    </div>
  );
}

async function deleteGridWithConfirm(
  grid: GridRecord,
  deleteGrid: (gridId: string) => void,
): Promise<void> {
  const { requestConfirmDialog } = await import("../../confirmDialog");
  const confirmed =
    (await requestConfirmDialog(
      `Delete the grid “${grid.name}”? Its threads stay in the workspace.`,
      { variant: "destructive" },
    )) ?? false;
  if (confirmed) deleteGrid(grid.id);
}

function NewThreadItem({ grid }: { grid: GridRecord }) {
  const handleNewThread = useNewThreadHandler();
  const addThread = useGridStore((store) => store.addThread);
  const navigate = useNavigate();
  return (
    <MenuItem
      onClick={() => {
        void (async () => {
          const created = await handleNewThread(
            scopeProjectRef(grid.environmentId as never, grid.projectId as never),
            { replace: true },
          );
          if (created === null) return;
          addThread(grid.id, created.threadId, created.draftId);
          void navigate({ to: "/grid/$gridId", params: { gridId: grid.id } });
        })();
      }}
    >
      New thread…
    </MenuItem>
  );
}

function ThreadRow({
  environmentId,
  threadId,
  shell,
  active,
  onOpen,
  onRemove,
}: {
  environmentId: string;
  threadId: string;
  shell: EnvironmentThreadShell | undefined;
  active: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(shell?.title ?? "Untitled thread");
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { archiveThread } = useThreadActions();
  const status = shell === undefined ? null : resolveThreadStatusPill({ thread: shell });
  const threadRef = shell === undefined ? null : scopeThreadRef(shell.environmentId, shell.id);
  const title = shell?.title ?? "Untitled thread";

  return (
    <div className="group flex items-center gap-1">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-xs hover:bg-sidebar-row-hover",
          active
            ? "bg-sidebar-row-selected text-sidebar-foreground"
            : "text-sidebar-foreground/90",
        )}
        data-thread-key={threadRef === null ? undefined : scopedThreadKey(threadRef)}
        data-thread-id={threadId}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status?.dotClass ?? "bg-muted-foreground/40",
            status?.pulse && "animate-status-pulse",
          )}
          aria-hidden
        />
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={() => {
              setRenaming(false);
              if (shell === undefined || name.trim() === shell.title) return;
              void (async () => {
                const result = await updateThreadMetadata({
                  environmentId: shell.environmentId,
                  input: { threadId: shell.id, title: name.trim() },
                });
                if (result._tag === "Failure") {
                  toastManager.add({
                    type: "error",
                    title: "Failed to rename thread",
                    description: "The server did not accept the new title.",
                  });
                }
              })();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setName(title);
                setRenaming(false);
              }
            }}
            className="h-5 min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-xs text-foreground outline-none focus:border-ring"
          />
        ) : (
          <span className="truncate">{title}</span>
        )}
        {shell === undefined ? (
          <span className="shrink-0 text-2xs text-muted-foreground">missing</span>
        ) : null}
      </button>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`Thread actions for ${title}`}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground group-hover:opacity-100 focus-visible:opacity-100"
            >
              <MoreHorizontalIcon className="size-3.5" />
            </button>
          }
        />
        <MenuPopup side="bottom" align="end">
          <MenuItem onClick={onOpen}>Open in grid</MenuItem>
          <MenuItem
            onClick={() => {
              setName(title);
              setRenaming(true);
            }}
            disabled={shell === undefined}
          >
            Rename thread
          </MenuItem>
          <MenuItem
            onClick={() => {
              if (threadRef !== null) void archiveThread(threadRef, {});
              onRemove();
            }}
            disabled={threadRef === null}
          >
            <ArchiveIcon className="size-3.5" />
            Archive thread
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={onRemove}>
            <XIcon className="size-3.5" />
            Remove from grid
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
