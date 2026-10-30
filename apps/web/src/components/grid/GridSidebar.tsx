import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { openCommandPalette } from "../../commandPaletteBus";
import {
  type GridRecord,
  gridsForWorkspace,
  useGridStore,
  workspaceKeyOf,
} from "../../grid/gridStore";
import { preorderThreads } from "../../grid/tree";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useThreadActions } from "../../hooks/useThreadActions";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarRailNav, SidebarRailSearchButton } from "../sidebar/SidebarRailNav";
import { SidebarRowTime, threadTimeTimestamp } from "../sidebar/SidebarRowTime";
import { SidebarThreadStatusGlyph } from "../sidebar/SidebarStatusGlyph";
import {
  EMPTY_PROVIDER_ENTRIES,
  sidebarProviderEntriesAtom,
} from "../sidebar/sidebarProviderEntries";
import { SidebarProviderStack, type SidebarProviderEntry } from "../sidebar/SidebarThreadRow";
import { SidebarContent, SidebarHeader } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useQuietThreadShells, useProjects } from "../../state/entities";
import { resolveProjectStatusIndicator, resolveThreadStatusPill } from "../Sidebar.logic";

export function GridSidebar() {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const grids = useGridStore((store) => store.grids);
  const createGrid = useGridStore((store) => store.createGrid);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.new");
  const navigate = useNavigate();
  const handleNewThread = () => {
    if (projects.length === 0) {
      openCommandPalette({ open: "add-project" });
      return;
    }
    openCommandPalette({ open: "new-thread-in" });
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarHeader>
        <SidebarRailNav
          search={<SidebarRailSearchButton />}
          onNewThread={handleNewThread}
          newThreadDisabled={projects.length === 0}
          newThreadShortcutLabel={newThreadShortcutLabel}
        />
      </SidebarHeader>
      <SidebarContent>
        <div className="flex flex-col gap-px px-2 pb-2">
          <Link
            to="/"
            className="flex h-7 items-center gap-2 rounded-(--control-radius) px-2 text-sm text-secondary-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <MessageSquareIcon aria-hidden className="size-[15px] shrink-0 text-secondary-label" />
            All threads
          </Link>
          {projects.length === 0 ? (
            <p className="px-2 py-3 text-xs text-secondary-label">
              Open a project to create its first grid.
            </p>
          ) : null}
          {projects.map((project) => (
            <WorkspaceGroup
              key={workspaceKeyOf(project.environmentId, project.id)}
              project={project}
              grids={gridsForWorkspace(grids, workspaceKeyOf(project.environmentId, project.id))}
              threads={threads.filter(
                (thread) =>
                  thread.environmentId === project.environmentId &&
                  thread.projectId === project.id &&
                  thread.archivedAt === null,
              )}
              providerEntriesByEnvironment={providerEntriesByEnvironment}
              onCreateGrid={() => {
                const gridId = createGrid({
                  environmentId: project.environmentId,
                  projectId: project.id,
                  workspaceKey: workspaceKeyOf(project.environmentId, project.id),
                });
                void navigate({ to: "/grid/$gridId", params: { gridId } });
              }}
            />
          ))}
        </div>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function WorkspaceGroup({
  project,
  grids,
  threads,
  providerEntriesByEnvironment,
  onCreateGrid,
}: {
  project: EnvironmentProject;
  grids: GridRecord[];
  threads: ReadonlyArray<EnvironmentThreadShell>;
  providerEntriesByEnvironment: ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>;
  onCreateGrid: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const rollup = resolveProjectStatusIndicator(
    threads.map((thread) => resolveThreadStatusPill({ thread })),
  );
  const providerEntries =
    providerEntriesByEnvironment.get(project.environmentId) ?? EMPTY_PROVIDER_ENTRIES;
  return (
    <section className="group/workspace mt-1 flex flex-col gap-px">
      <div className="relative flex items-center">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => setCollapsed((value) => !value)}
                className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-(--control-radius) px-2 text-left text-sm font-semibold text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                aria-expanded={!collapsed}
              />
            }
          >
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-secondary-label transition-transform",
                collapsed && "-rotate-90",
              )}
            />
            <span className="min-w-0 flex-1 truncate">{project.title}</span>
            {collapsed && rollup !== null ? (
              <SidebarThreadStatusGlyph status={rollup} label={`A thread: ${rollup.label}`} />
            ) : (
              <span className="shrink-0 text-xs text-secondary-label tabular-nums group-hover/workspace:invisible">
                {threads.length}
              </span>
            )}
          </TooltipTrigger>
          <TooltipPopup side="right">{project.workspaceRoot}</TooltipPopup>
        </Tooltip>
        <span className="absolute inset-y-0 right-1 flex items-center opacity-0 group-hover/workspace:opacity-100 focus-within:opacity-100">
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label={`New grid in ${project.title}`}
            onClick={onCreateGrid}
          >
            <PlusIcon />
          </Button>
        </span>
      </div>
      {collapsed ? null : (
        <div className="flex flex-col gap-px">
          {grids.length === 0 ? (
            <button
              type="button"
              onClick={onCreateGrid}
              className="flex h-7 items-center gap-2 rounded-(--control-radius) px-2 pl-6.5 text-left text-sm text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <PlusIcon aria-hidden className="size-[15px]" />
              New grid
            </button>
          ) : null}
          {grids.map((grid) => (
            <GridRow
              key={grid.id}
              grid={grid}
              workspaceThreads={threads}
              providerEntries={providerEntries}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function GridRow({
  grid,
  workspaceThreads,
  providerEntries,
}: {
  grid: GridRecord;
  workspaceThreads: ReadonlyArray<EnvironmentThreadShell>;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
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
  const branch =
    leaves
      .map((leaf) => workspaceThreads.find((thread) => thread.id === leaf.threadId)?.branch)
      .find((candidate) => candidate != null) ?? null;

  const openThread = (threadId: string) => {
    focusThread(grid.id, threadId);
    void navigate({ to: "/grid/$gridId", params: { gridId: grid.id } });
  };

  return (
    <div className="group/grid relative flex flex-col gap-px">
      <div className="relative flex items-center gap-1">
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
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
            className="h-6 min-w-0 flex-1 rounded-(--control-radius) border border-input bg-background px-1.5 text-2xs font-semibold text-foreground outline-none focus:border-ring"
          />
        ) : (
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-(--control-radius) pl-6.5 pr-6 text-left text-2xs font-semibold text-secondary-label outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            aria-expanded={!collapsed}
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
            />
            <span className="truncate">{grid.name}</span>
            <span className="min-w-0 truncate font-mono text-2xs font-normal transition-opacity group-hover/grid:opacity-0">
              {branch ?? `${leaves.length} ${leaves.length === 1 ? "thread" : "threads"}`}
            </span>
          </button>
        )}
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={`Grid actions for ${grid.name}`}
                className="absolute right-0 top-1/2 inline-grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-label opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground group-hover/grid:opacity-100 focus-visible:opacity-100"
              >
                <MoreHorizontalIcon aria-hidden className="size-3.5" />
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
        <div className="flex flex-col gap-px">
          {leaves.map((leaf) => (
            <ThreadRow
              key={leaf.id}
              threadId={leaf.threadId}
              draftId={leaf.draftId}
              shell={workspaceThreads.find((candidate) => candidate.id === leaf.threadId)}
              providerEntries={providerEntries}
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
                  className="flex h-6 items-center gap-1.5 rounded-(--control-radius) pl-6.5 pr-1 text-left text-2xs text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                >
                  <PlusIcon aria-hidden className="size-3" />
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
  threadId,
  draftId,
  shell,
  providerEntries,
  active,
  onOpen,
  onRemove,
}: {
  threadId: string;
  draftId: string | undefined;
  shell: EnvironmentThreadShell | undefined;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
  active: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const draft = useComposerDraftStore((store) =>
    draftId === undefined ? null : store.getDraftSession(draftId as DraftId),
  );
  const isDraft = shell === undefined && draft !== null;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(shell?.title ?? "New thread");
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { archiveThread } = useThreadActions();
  const status = shell === undefined ? null : resolveThreadStatusPill({ thread: shell });
  const threadRef = shell === undefined ? null : scopeThreadRef(shell.environmentId, shell.id);
  const title = shell?.title ?? (isDraft ? "New thread" : "Untitled thread");
  const meta = shell === undefined ? (isDraft ? "draft" : "missing") : null;
  const needsAttention =
    status !== null &&
    (status.label === "Pending Approval" ||
      status.label === "Awaiting Input" ||
      status.label === "Guest Request" ||
      status.label === "Plan Ready");
  return (
    <div className="group/sess relative flex h-7 items-center">
      {renaming ? (
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
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
          className="h-7 min-w-0 flex-1 rounded-(--control-radius) border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ring"
        />
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-(--control-radius) pl-6.5 pr-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            active
              ? "bg-sidebar-row-selected text-sidebar-foreground"
              : needsAttention
                ? "font-medium text-sidebar-foreground hover:bg-sidebar-row-hover"
                : "text-secondary-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          )}
          data-thread-key={threadRef === null ? undefined : scopedThreadKey(threadRef)}
          data-thread-id={threadId}
        >
          <span className="inline-grid size-3.5 shrink-0 place-items-center text-secondary-label">
            {shell !== undefined ? (
              <SidebarProviderStack thread={shell} providerEntryByInstanceId={providerEntries} />
            ) : (
              <span className="size-3 rounded-full border border-sidebar-border" aria-hidden />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <SidebarThreadStatusGlyph status={status} />
          <span className="w-[26px] shrink-0 text-right group-hover/sess:opacity-0">
            {meta !== null ? (
              <span className="text-2xs text-secondary-label">{meta}</span>
            ) : (
              <SidebarRowTime timestamp={shell === undefined ? null : threadTimeTimestamp(shell)} />
            )}
          </span>
        </button>
      )}
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`Thread actions for ${title}`}
              className="absolute right-1 top-1/2 inline-grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-label opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground group-hover/sess:opacity-100 focus-visible:opacity-100"
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
