import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  AlarmClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  EyeOffIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { isElectron } from "../../env";
import {
  type GridRecord,
  orderedGridsForWorkspace,
  useGridStore,
  workspaceKeyOf,
} from "../../grid/gridStore";
import {
  clearThreadSelection,
  gridThreadStateLabel,
  nextAttentionCard,
  openPullRequestNumber,
  resolveGridThreadState,
  summarizeOnHold,
  threadMatchesGridSearch,
  updateThreadSelection,
  visibleGridThreads,
  type AttentionCard,
  type GridThreadState,
  type ThreadSelection,
} from "../../grid/sidebar";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useQuietThreadShells, useProjects } from "../../state/entities";
import { registerSettleAndAdvance } from "../../settleAndAdvance";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useThreadActions } from "../../hooks/useThreadActions";
import { shortcutLabelForCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useNowSecond } from "../../hooks/useNowSecond";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { openCommandPalette } from "../../commandPaletteBus";
import { isAppModalPage } from "../sidebar/mainAppLocation";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarRailNav } from "../sidebar/SidebarRailNav";
import { SidebarProviderStack, type SidebarProviderEntry } from "../sidebar/SidebarThreadRow";
import {
  EMPTY_PROVIDER_ENTRIES,
  sidebarProviderEntriesAtom,
} from "../sidebar/sidebarProviderEntries";
import { useSnoozeWakeClock } from "../Sidebar.logic";
import { resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { SidebarContent, SidebarHeader, useSidebarVisibility } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";

const THREAD_DRAG_TYPE = "application/x-houston-thread";

interface DraggedThread {
  readonly gridId: string;
  readonly threadId: string;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
  return true;
}

function threadTimeLabel(thread: EnvironmentThreadShell, nowMinute: string): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return formatRelativeTimeLabel(timestamp, Date.parse(`${nowMinute}:00.000Z`)).replace(
    / ago$/,
    "",
  );
}

function wakeTimeLabel(snoozedUntil: string): string {
  const date = new Date(snoozedUntil);
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (needle.length === 0) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (;;) {
    const index = lower.indexOf(target, cursor);
    if (index === -1) break;
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark
        key={`${index}-${target}`}
        className="rounded-(--r-badge) bg-(--warn-wash) px-px text-inherit"
      >
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function GridSidebar() {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const grids = useGridStore((store) => store.grids);
  const createGrid = useGridStore((store) => store.createGrid);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.new");
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const sidebarVisible = useSidebarVisibility();
  const nowMinute = useNowMinute();
  const wakeClock = useSnoozeWakeClock(threads);
  const nowIso = new Date(wakeClock).toISOString();
  const openGridId = /^\/grid\/([^/]+)/.exec(pathname)?.[1] ?? null;
  const openGrid = openGridId === null ? null : (grids.find((grid) => grid.id === openGridId) ?? null);

  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<ThreadSelection>(clearThreadSelection);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState<DraggedThread | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const actions = useThreadActions();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  const handleNewThread = () => {
    if (projects.length === 0) {
      openCommandPalette({ open: "add-project" });
      return;
    }
    openCommandPalette({ open: "new-thread-in" });
  };

  const openThread = (gridId: string, threadId: string) => {
    useGridStore.getState().focusThread(gridId, threadId);
    void navigate({ to: "/grid/$gridId", params: { gridId } });
  };

  const orderedThreadKeys = projects.flatMap((project) =>
    orderedGridsForWorkspace(grids, workspaceKeyOf(project.environmentId, project.id))
      .filter((grid) => !grid.hidden)
      .flatMap((grid) =>
        visibleGridThreads(grid, threads, nowIso).map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
  );

  const allCards: AttentionCard[] = projects.flatMap((project) =>
    orderedGridsForWorkspace(grids, workspaceKeyOf(project.environmentId, project.id))
      .filter((grid) => !grid.hidden)
      .flatMap((grid) =>
        visibleGridThreads(grid, threads, nowIso).map((thread) => ({
          gridId: grid.id,
          threadId: thread.id,
          state: resolveGridThreadState(thread, nowIso),
        })),
      ),
  );

  const currentFocus =
    openGrid === null || openGrid.focusedThreadId === null
      ? null
      : { gridId: openGrid.id, threadId: openGrid.focusedThreadId };

  const removeFromSelection = (threadsToRemove: ReadonlyArray<EnvironmentThreadShell>) => {
    const keys = new Set(
      threadsToRemove.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    );
    setSelection((current) => ({
      selectedThreadKeys: new Set(
        [...current.selectedThreadKeys].filter((key) => !keys.has(key)),
      ),
      anchorThreadKey:
        current.anchorThreadKey !== null && keys.has(current.anchorThreadKey)
          ? null
          : current.anchorThreadKey,
    }));
  };

  const closeThreads = (threadsToClose: ReadonlyArray<EnvironmentThreadShell>) => {
    removeFromSelection(threadsToClose);
    const closedKeys = new Set<string>(threadsToClose.map((thread) => thread.id));
    if (openGrid !== null && openGrid.focusedThreadId !== null && closedKeys.has(openGrid.focusedThreadId)) {
      const remaining = visibleGridThreads(openGrid, threads, nowIso).filter(
        (thread) => !closedKeys.has(thread.id),
      );
      const next = remaining[0];
      if (next !== undefined) openThread(openGrid.id, next.id);
      else void navigate({ to: "/" });
    }
    for (const thread of threadsToClose) {
      void (async () => {
        const result = await actions.settleThread(
          scopeThreadRef(thread.environmentId, thread.id),
        );
        reportFailure("Failed to close thread", result);
      })();
    }
  };

  const holdThreads = (threadsToHold: ReadonlyArray<EnvironmentThreadShell>, snoozedUntil: string) => {
    removeFromSelection(threadsToHold);
    for (const thread of threadsToHold) {
      void (async () => {
        const result = await actions.snoozeThread(
          scopeThreadRef(thread.environmentId, thread.id),
          snoozedUntil,
        );
        reportFailure("Failed to hold thread", result);
      })();
    }
  };

  const pickHoldTime = async (): Promise<Pick<SnoozePreset, "snoozedUntil"> | null> =>
    requestCustomSnooze();

  const renameThread = (thread: EnvironmentThreadShell, title: string) => {
    if (title.length === 0 || title === thread.title) return;
    void (async () => {
      const result = await updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, title },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: "The server did not accept the new title.",
        });
      }
    })();
  };

  const setAutoClose = (thread: EnvironmentThreadShell, enabled: boolean) => {
    void (async () => {
      const result = await actions.setThreadAutoSettle(
        scopeThreadRef(thread.environmentId, thread.id),
        enabled,
      );
      reportFailure("Failed to change auto-close", result);
    })();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the module-level settle-and-advance registry pointing at the mounted rail
  useEffect(
    () =>
      registerSettleAndAdvance((threadRef) => {
        const thread = threads.find(
          (candidate) =>
            candidate.environmentId === threadRef.environmentId &&
            candidate.id === threadRef.threadId,
        );
        if (thread !== undefined) closeThreads([thread]);
      }),
    // The registry holds the newest close handler; re-registering costs one assignment.
    [closeThreads, threads],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the window's Esc and Ctrl J shortcuts in step with the visible rail while it is mounted
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !sidebarVisible) return;
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey || event.altKey) return;
      if (event.key.toLowerCase() !== "j") return;
      if (
        isEditableFocused(event.target) ||
        isTerminalFocused() ||
        isPreviewFocused() ||
        isCommandPaletteOpen() ||
        isModelPickerOpen() ||
        isAppModalPage(pathname)
      ) {
        return;
      }
      const card = nextAttentionCard(allCards, currentFocus, event.shiftKey ? -1 : 1);
      if (card === null) return;
      event.preventDefault();
      event.stopPropagation();
      openThread(card.gridId, card.threadId);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (isEditableFocused(event.target)) return;
      if (selection.selectedThreadKeys.size === 0) return;
      event.preventDefault();
      setSelection(clearThreadSelection());
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keydown", onEscape);
    };
  });

  const selectThread = (thread: EnvironmentThreadShell, input: { shiftKey: boolean; toggleKey: boolean }) => {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    setSelection((current) =>
      updateThreadSelection(current, {
        orderedKeys: orderedThreadKeys,
        clickedKey: key,
        shiftKey: input.shiftKey,
        toggleKey: input.toggleKey,
      }),
    );
  };

  const selectedThreads = threads.filter((thread) =>
    selection.selectedThreadKeys.has(
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    ),
  );

  const selectedHoldEnvironmentId = selectedThreads[0]?.environmentId ?? null;
  const selectionPresets =
    selectedHoldEnvironmentId === null
      ? []
      : resolveSnoozePresets(
          new Date(`${nowMinute}:00.000Z`),
          timestampFormat,
          selectedHoldEnvironmentId,
        );

  const handleDragStart = (gridId: string, thread: EnvironmentThreadShell) => {
    setDragging({ gridId, threadId: thread.id });
  };
  const handleDragEnd = () => {
    setDragging(null);
    setDropTarget(null);
  };
  const readDragged = (event: ReactDragEvent): DraggedThread | null => {
    const raw = event.dataTransfer.getData(THREAD_DRAG_TYPE);
    if (raw.length === 0) return null;
    try {
      return JSON.parse(raw) as DraggedThread;
    } catch {
      return null;
    }
  };
  const moveThreadToGrid = (source: DraggedThread, targetGridId: string) => {
    if (source.gridId === targetGridId) return;
    useGridStore.getState().removeThreadFromGrid(source.gridId, source.threadId);
    useGridStore.getState().addThread(targetGridId, source.threadId);
  };
  const dropThreadOnThread = (
    source: DraggedThread,
    targetGridId: string,
    targetThreadId: string,
  ) => {
    if (source.gridId === targetGridId) {
      useGridStore.getState().reorderGridThreads(targetGridId, source.threadId, targetThreadId);
      return;
    }
    moveThreadToGrid(source, targetGridId);
  };
  const moveThreadToWorkspace = (project: EnvironmentProject, source: DraggedThread) => {
    const gridId = createGrid({
      environmentId: project.environmentId,
      projectId: project.id,
      workspaceKey: workspaceKeyOf(project.environmentId, project.id),
    });
    moveThreadToGrid(source, gridId);
    useGridStore.getState().focusThread(gridId, source.threadId);
  };

  const query = search.trim();
  const searchMatchThreads = projects.flatMap((project) =>
    orderedGridsForWorkspace(grids, workspaceKeyOf(project.environmentId, project.id))
      .filter((grid) => !grid.hidden)
      .flatMap((grid) =>
        visibleGridThreads(grid, threads, nowIso).filter((thread) =>
          threadMatchesGridSearch(
            {
              title: thread.title,
              branch: thread.branch,
              pullRequests: thread.pullRequests,
            },
            query,
          ),
        ),
      ),
  );

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarHeader>
        <SidebarRailNav
          search={
            <label className="flex h-7 w-full shrink-0 items-center gap-2 rounded-(--control-radius) bg-(--field) px-2 text-sm text-secondary-foreground focus-within:ring-2 focus-within:ring-ring focus-within:ring-inset">
              <SearchIcon aria-hidden className="size-[15px] shrink-0 text-secondary-label" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setSearch("");
                  }
                  if (event.key === "Enter") {
                    const first = searchMatchThreads[0];
                    if (first === undefined) return;
                    const grid = grids.find((candidate) =>
                      visibleGridThreads(candidate, threads, nowIso).some(
                        (thread) => thread.id === first.id,
                      ),
                    );
                    if (grid !== undefined) openThread(grid.id, first.id);
                  }
                }}
                placeholder="Search"
                aria-label="Search workspaces, grids and threads"
                className="min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-secondary-label"
              />
              {query.length > 0 ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  className="inline-grid size-5 shrink-0 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              ) : null}
            </label>
          }
          onNewThread={handleNewThread}
          newThreadDisabled={projects.length === 0}
          newThreadShortcutLabel={newThreadShortcutLabel}
        />
      </SidebarHeader>
      <SidebarContent>
        <div className="flex flex-col gap-px px-2 pb-2">
          {projects.length === 0 ? (
            <p className="px-2 py-3 text-xs text-secondary-label">
              Open a project to create its first grid.
            </p>
          ) : null}
          {projects.map((project) => {
            const workspaceKey = workspaceKeyOf(project.environmentId, project.id);
            const workspaceGrids = orderedGridsForWorkspace(grids, workspaceKey);
            const visibleGrids = workspaceGrids.filter((grid) => !grid.hidden);
            const hiddenGrids = workspaceGrids.filter((grid) => grid.hidden);
            const workspaceMatches =
              query.length > 0 &&
              project.title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
            const renderedGrids = visibleGrids.flatMap((grid) => {
              const gridMatches =
                query.length > 0 &&
                grid.name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
              const gridThreads = visibleGridThreads(grid, threads, nowIso);
              const matchedThreads =
                query.length === 0 || workspaceMatches || gridMatches
                  ? gridThreads
                  : gridThreads.filter((thread) =>
                      threadMatchesGridSearch(
                        {
                          title: thread.title,
                          branch: thread.branch,
                          pullRequests: thread.pullRequests,
                        },
                        query,
                      ),
                    );
              if (
                query.length > 0 &&
                !workspaceMatches &&
                !gridMatches &&
                matchedThreads.length === 0
              ) {
                return [];
              }
              return [{ grid, threads: matchedThreads }];
            });
            if (query.length > 0 && !workspaceMatches && renderedGrids.length === 0) return null;
            const collapsed = query.length === 0 && collapsedWorkspaces.has(workspaceKey);
            const onHold = summarizeOnHold(visibleGrids, threads, nowIso);
            const providerEntries =
              providerEntriesByEnvironment.get(project.environmentId) ?? EMPTY_PROVIDER_ENTRIES;
            return (
              <WorkspaceGroup
                key={workspaceKey}
                project={project}
                collapsed={collapsed}
                query={query}
                grids={renderedGrids}
                hiddenGrids={hiddenGrids}
                onHold={onHold}
                providerEntries={providerEntries}
                openGridId={openGrid?.id ?? null}
                nowIso={nowIso}
                selection={selection}
                dragging={dragging}
                dropTarget={dropTarget}
                onToggle={() =>
                  setCollapsedWorkspaces((current) => {
                    const next = new Set(current);
                    if (next.has(workspaceKey)) next.delete(workspaceKey);
                    else next.add(workspaceKey);
                    return next;
                  })
                }
                onCreateGrid={() => {
                  const gridId = createGrid({
                    environmentId: project.environmentId,
                    projectId: project.id,
                    workspaceKey,
                  });
                  void navigate({ to: "/grid/$gridId", params: { gridId } });
                }}
                onOpenThread={openThread}
                onSelectThread={selectThread}
                onCloseThread={(thread) => closeThreads([thread])}
                onHoldThread={(thread, preset) => holdThreads([thread], preset.snoozedUntil)}
                onPickHoldTime={pickHoldTime}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOverGrid={setDropTarget}
                onDropOnGrid={(source, targetGridId) => moveThreadToGrid(source, targetGridId)}
                onDropOnThread={dropThreadOnThread}
                onDropOnWorkspace={(source) => moveThreadToWorkspace(project, source)}
                onDragLeave={() => setDropTarget(null)}
                readDragged={readDragged}
                onRenameThread={renameThread}
                onSetAutoClose={setAutoClose}
                onShowGrid={(gridId) => useGridStore.getState().setGridHidden(gridId, false)}
                onBringBack={(heldThreads) => {
                  for (const thread of heldThreads) {
                    void (async () => {
                      const result = await actions.unsnoozeThread(
                        scopeThreadRef(thread.environmentId, thread.id),
                      );
                      reportFailure("Failed to bring thread back", result);
                    })();
                  }
                }}
              />
            );
          })}
        </div>
      </SidebarContent>
      {selection.selectedThreadKeys.size > 0 ? (
        <div className="flex items-center gap-1 px-2 pb-2">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-(--r-ctl) border border-sidebar-border bg-(--surface-raised) px-2.5 text-xs text-secondary-foreground">
            <span className="flex-1 truncate font-semibold text-foreground">
              {selection.selectedThreadKeys.size} selected
            </span>
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className="inline-flex h-6 cursor-pointer items-center rounded-(--r-ctl) border border-(--line-strong) px-2 text-xs text-foreground hover:bg-sidebar-row-hover"
                  />
                }
              >
                Hold
              </MenuTrigger>
              <MenuPopup side="top" align="end">
                {selectionPresets.map((preset) => (
                  <MenuItem
                    key={preset.id}
                    onClick={() => holdThreads(selectedThreads, preset.snoozedUntil)}
                  >
                    {preset.label}
                    <span className="ml-auto text-2xs text-secondary-label">{preset.whenLabel}</span>
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  onClick={() => {
                    void (async () => {
                      const picked = await requestCustomSnooze();
                      if (picked !== null) holdThreads(selectedThreads, picked.snoozedUntil);
                    })();
                  }}
                >
                  Pick a time…
                </MenuItem>
              </MenuPopup>
            </Menu>
            <button
              type="button"
              className="inline-flex h-6 cursor-pointer items-center rounded-(--r-ctl) border border-(--line-strong) px-2 text-xs text-foreground hover:bg-sidebar-row-hover"
              onClick={() => {
                closeThreads(selectedThreads);
                setSelection(clearThreadSelection());
              }}
            >
              Close
            </button>
            <span className="ml-1 inline-flex h-4 items-center rounded-(--r-badge) border border-sidebar-border px-1 text-3xs text-secondary-label">
              Esc
            </span>
          </div>
        </div>
      ) : (
        <SidebarChromeFooter />
      )}
      {dragging !== null ? (
        <span aria-hidden className="sr-only">
          Dragging thread
        </span>
      ) : null}
    </>
  );
}

function WorkspaceGroup({
  project,
  collapsed,
  query,
  grids,
  hiddenGrids,
  onHold,
  providerEntries,
  openGridId,
  nowIso,
  selection,
  dragging,
  dropTarget,
  onToggle,
  onCreateGrid,
  onOpenThread,
  onSelectThread,
  onCloseThread,
  onHoldThread,
  onPickHoldTime,
  onDragStart,
  onDragEnd,
  onDragOverGrid,
  onDropOnGrid,
  onDropOnThread,
  onDropOnWorkspace,
  onDragLeave,
  readDragged,
  onShowGrid,
  onBringBack,
  onRenameThread,
  onSetAutoClose,
}: {
  project: EnvironmentProject;
  collapsed: boolean;
  query: string;
  grids: ReadonlyArray<{ grid: GridRecord; threads: EnvironmentThreadShell[] }>;
  hiddenGrids: ReadonlyArray<GridRecord>;
  onHold: ReturnType<typeof summarizeOnHold>;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
  openGridId: string | null;
  nowIso: string;
  selection: ThreadSelection;
  dragging: DraggedThread | null;
  dropTarget: string | null;
  onToggle: () => void;
  onCreateGrid: () => void;
  onOpenThread: (gridId: string, threadId: string) => void;
  onSelectThread: (
    thread: EnvironmentThreadShell,
    input: { shiftKey: boolean; toggleKey: boolean },
  ) => void;
  onCloseThread: (thread: EnvironmentThreadShell) => void;
  onHoldThread: (thread: EnvironmentThreadShell, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onPickHoldTime: () => Promise<Pick<SnoozePreset, "snoozedUntil"> | null>;
  onDragStart: (gridId: string, thread: EnvironmentThreadShell) => void;
  onDragEnd: () => void;
  onDragOverGrid: (key: string | null) => void;
  onDropOnGrid: (source: DraggedThread, targetGridId: string) => void;
  onDropOnThread: (source: DraggedThread, targetGridId: string, targetThreadId: string) => void;
  onDropOnWorkspace: (source: DraggedThread) => void;
  onDragLeave: () => void;
  readDragged: (event: ReactDragEvent) => DraggedThread | null;
  onShowGrid: (gridId: string) => void;
  onBringBack: (threads: ReadonlyArray<EnvironmentThreadShell>) => void;
  onRenameThread: (thread: EnvironmentThreadShell, title: string) => void;
  onSetAutoClose: (thread: EnvironmentThreadShell, enabled: boolean) => void;
}) {
  const workspaceKey = workspaceKeyOf(project.environmentId, project.id);
  const isDropTarget = dropTarget === `workspace:${workspaceKey}`;
  return (
    <section className="flex flex-col gap-px">
      <div
        className="group/grid relative flex items-center"
        onDragOver={(event) => {
          if (readDragged(event) === null) return;
          event.preventDefault();
          onDragOverGrid(`workspace:${workspaceKey}`);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          onDragLeave();
        }}
        onDrop={(event) => {
          const source = readDragged(event);
          event.preventDefault();
          onDragOverGrid(null);
          if (source !== null) onDropOnWorkspace(source);
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className={cn(
            "flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-(--r-ctl) px-3 text-left text-sm font-semibold text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            isDropTarget && "bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset",
          )}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 text-secondary-label", collapsed && "-rotate-90")}
          />
          <span className="min-w-0 truncate">
            <HighlightedText text={project.title} query={query} />
          </span>
        </button>
        <span className="absolute inset-y-0 right-1 flex items-center">
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
          {grids.length === 0 && query.length === 0 ? (
            <button
              type="button"
              onClick={onCreateGrid}
              className="flex h-7 items-center gap-2 rounded-(--r-ctl) pl-7 pr-2 text-left text-sm text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <PlusIcon aria-hidden className="size-[15px]" />
              New grid
            </button>
          ) : null}
          {grids.map(({ grid, threads }) => (
            <GridRow
              key={grid.id}
              grid={grid}
              threads={threads}
              query={query}
              open={openGridId === grid.id}
              providerEntries={providerEntries}
              nowIso={nowIso}
              selection={selection}
              dragging={dragging}
              dropTarget={dropTarget}
              onOpenThread={onOpenThread}
              onSelectThread={onSelectThread}
              onCloseThread={onCloseThread}
              onHoldThread={onHoldThread}
              onPickHoldTime={onPickHoldTime}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragOverGrid={onDragOverGrid}
              onDropOnGrid={onDropOnGrid}
              onDropOnThread={onDropOnThread}
              onDragLeave={onDragLeave}
              readDragged={readDragged}
              workspaceTitle={project.title}
              onRenameThread={onRenameThread}
              onSetAutoClose={onSetAutoClose}
            />
          ))}
          {query.length === 0 && onHold.threads.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className="flex h-6 items-center gap-1.5 rounded-(--r-ctl) pl-7 pr-2 text-left text-xs text-secondary-label hover:bg-sidebar-row-hover hover:text-secondary-foreground"
                  />
                }
              >
                <ClockIcon aria-hidden className="size-3" />
                <span>
                  {onHold.threads.length} on hold
                  {onHold.nextWakeAt !== null ? ` · next ${wakeTimeLabel(onHold.nextWakeAt)}` : ""}
                </span>
              </MenuTrigger>
              <MenuPopup side="bottom" align="start" className="w-60">
                {onHold.threads.map((thread) => {
                  const heldGrid = findGridForThread(grids, thread.id);
                  return (
                    <MenuItem
                      key={thread.id}
                      disabled={heldGrid === null}
                      onClick={() => {
                        if (heldGrid !== null) onOpenThread(heldGrid.id, thread.id);
                      }}
                    >
                      <ClockIcon aria-hidden className="size-3.5" />
                      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                      <span className="text-2xs text-secondary-label">
                        {thread.snoozedUntil === null ? "" : wakeTimeLabel(thread.snoozedUntil)}
                      </span>
                    </MenuItem>
                  );
                })}
                <MenuSeparator />
                <MenuItem onClick={() => onBringBack(onHold.threads)}>Bring all back now</MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          {query.length === 0 && hiddenGrids.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className="flex h-6 items-center gap-1.5 rounded-(--r-ctl) pl-7 pr-2 text-left text-xs text-secondary-label hover:bg-sidebar-row-hover hover:text-secondary-foreground"
                  />
                }
              >
                <EyeOffIcon aria-hidden className="size-3" />
                <span>
                  {hiddenGrids.length} hidden {hiddenGrids.length === 1 ? "grid" : "grids"}
                </span>
              </MenuTrigger>
              <MenuPopup side="bottom" align="start" className="w-56">
                {hiddenGrids.map((grid) => (
                  <MenuItem key={grid.id} onClick={() => onShowGrid(grid.id)}>
                    <EyeOffIcon aria-hidden className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">{grid.name}</span>
                    <span className="text-2xs text-secondary-label">Show</span>
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      )}
    </section>
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

function findGridForThread(
  grids: ReadonlyArray<{ grid: GridRecord; threads: EnvironmentThreadShell[] }>,
  threadId: string,
): GridRecord | null {
  return grids.find(({ threads }) => threads.some((thread) => thread.id === threadId))?.grid ?? null;
}

function GridRow({
  grid,
  threads,
  query,
  open,
  providerEntries,
  nowIso,
  selection,
  dragging,
  dropTarget,
  onOpenThread,
  onSelectThread,
  onCloseThread,
  onHoldThread,
  onPickHoldTime,
  onDragStart,
  onDragEnd,
  onDragOverGrid,
  onDropOnGrid,
  onDropOnThread,
  onDragLeave,
  readDragged,
  workspaceTitle,
  onRenameThread,
  onSetAutoClose,
}: {
  grid: GridRecord;
  workspaceTitle: string;
  onRenameThread: (thread: EnvironmentThreadShell, title: string) => void;
  onSetAutoClose: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  query: string;
  open: boolean;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
  nowIso: string;
  selection: ThreadSelection;
  dragging: DraggedThread | null;
  dropTarget: string | null;
  onOpenThread: (gridId: string, threadId: string) => void;
  onSelectThread: (
    thread: EnvironmentThreadShell,
    input: { shiftKey: boolean; toggleKey: boolean },
  ) => void;
  onCloseThread: (thread: EnvironmentThreadShell) => void;
  onHoldThread: (thread: EnvironmentThreadShell, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onPickHoldTime: () => Promise<Pick<SnoozePreset, "snoozedUntil"> | null>;
  onDragStart: (gridId: string, thread: EnvironmentThreadShell) => void;
  onDragEnd: () => void;
  onDragOverGrid: (key: string | null) => void;
  onDropOnGrid: (source: DraggedThread, targetGridId: string) => void;
  onDropOnThread: (source: DraggedThread, targetGridId: string, targetThreadId: string) => void;
  onDragLeave: () => void;
  readDragged: (event: ReactDragEvent) => DraggedThread | null;
}) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(grid.name);
  const renameGrid = useGridStore((store) => store.renameGrid);
  const pinGrid = useGridStore((store) => store.pinGrid);
  const unpinGrid = useGridStore((store) => store.unpinGrid);
  const setGridHidden = useGridStore((store) => store.setGridHidden);
  const deleteGrid = useGridStore((store) => store.deleteGrid);
  const handleNewThread = useNewThreadHandler();
  const isDropTarget = dropTarget === `grid:${grid.id}`;
  const readyThreads = threads.filter(
    (thread) => resolveGridThreadState(thread, nowIso) === "ready",
  );
  const closeAllReady = () => {
    for (const thread of readyThreads) onCloseThread(thread);
  };

  const createThread = () => {
    void (async () => {
      const created = await handleNewThread(
        scopeProjectRef(grid.environmentId as never, grid.projectId as never),
        { replace: true },
      );
      if (created === null) return;
      useGridStore.getState().addThread(grid.id, created.threadId, created.draftId);
      void navigate({ to: "/grid/$gridId", params: { gridId: grid.id } });
    })();
  };

  return (
    <div className="flex flex-col gap-px">
      <div
        className="group/grid relative flex items-center"
        onDragOver={(event) => {
          if (readDragged(event) === null) return;
          event.preventDefault();
          onDragOverGrid(`grid:${grid.id}`);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          onDragLeave();
        }}
        onDrop={(event) => {
          const source = readDragged(event);
          event.preventDefault();
          onDragOverGrid(null);
          if (source !== null) onDropOnGrid(source, grid.id);
        }}
      >
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
            className="h-7 min-w-0 flex-1 rounded-(--r-ctl) border border-input bg-background px-2 text-xs font-semibold text-foreground outline-none focus:border-ring"
          />
        ) : (
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                setName(grid.name);
                setRenaming(true);
              }
            }}
            aria-expanded={!collapsed}
            className={cn(
              "group/grid flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-left text-xs outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              isDropTarget && "bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset",
            )}
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0 text-secondary-label", collapsed && "-rotate-90")}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-semibold",
                open ? "text-foreground" : "text-secondary-foreground",
              )}
            >
              <HighlightedText text={grid.name} query={query} />
            </span>
            <span
              className="inline-grid size-5 shrink-0 place-items-center rounded-(--r-badge) text-secondary-label opacity-0 hover:bg-(--sel) hover:text-foreground group-hover/grid:opacity-100 group-focus-within/grid:opacity-100"
              role="button"
              tabIndex={0}
              aria-label={`New thread in ${grid.name}`}
              onClick={(event) => {
                event.stopPropagation();
                createThread();
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                createThread();
              }}
            >
              <PlusIcon aria-hidden className="size-3" />
            </span>
          </button>
        )}
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={`Grid actions for ${grid.name}`}
                className="absolute right-8 top-1/2 inline-grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-label opacity-0 hover:bg-(--sel) hover:text-foreground group-hover/grid:opacity-100 focus-visible:opacity-100"
              >
                <MoreHorizontalIcon aria-hidden className="size-3.5" />
              </button>
            }
          />
          <MenuPopup side="bottom" align="end">
            <MenuItem onClick={createThread}>New thread</MenuItem>
            <MenuItem
              onClick={() => {
                setName(grid.name);
                setRenaming(true);
              }}
            >
              Rename grid
              <MenuShortcut>F2</MenuShortcut>
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onClick={() =>
                grid.pinnedAt === null ? pinGrid(grid.id) : unpinGrid(grid.id)
              }
            >
              {grid.pinnedAt === null ? "Pin grid" : "Unpin grid"}
            </MenuItem>
            <MenuItem onClick={() => setGridHidden(grid.id, true)}>Hide grid</MenuItem>
            <MenuItem onClick={() => void deleteGridWithConfirm(grid, deleteGrid)}>
              Delete grid
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              disabled={readyThreads.length === 0}
              onClick={closeAllReady}
            >
              Close all ready
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {collapsed ? null : (
        <div className="flex flex-col gap-px">
          {threads.map((thread) => (
            <ThreadCard
              key={thread.id}
              gridId={grid.id}
              thread={thread}
              query={query}
              providerEntries={providerEntries}
              nowIso={nowIso}
              focused={open && grid.focusedThreadId === thread.id}
              selected={selection.selectedThreadKeys.has(
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
              )}
              dragging={dragging?.threadId === thread.id}
              workspaceTitle={workspaceTitle}
              onOpen={() => onOpenThread(grid.id, thread.id)}
              onSelect={(input) => onSelectThread(thread, input)}
              onClose={() => onCloseThread(thread)}
              onHold={(preset) => onHoldThread(thread, preset)}
              onPickHoldTime={onPickHoldTime}
              onRename={(title) => onRenameThread(thread, title)}
              onSetAutoClose={(enabled) => onSetAutoClose(thread, enabled)}
              onDragStart={() => onDragStart(grid.id, thread)}
              onDragEnd={onDragEnd}
              onDropOnThread={(source) => onDropOnThread(source, grid.id, thread.id)}
              readDragged={readDragged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadStateMark({ state, startedAt }: { state: GridThreadState; startedAt: string | null }) {
  if (state === "idle") return null;
  const elapsed =
    state === "running" && startedAt !== null ? (
      <RunningElapsed startedAt={startedAt} />
    ) : null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs font-medium whitespace-nowrap tabular-nums",
        state === "running" && "text-primary",
        state === "ready" && "text-success-foreground",
        state === "needs" && "text-(--warn-ink)",
        state === "failed" && "text-error-foreground",
        state === "back" && "text-secondary-foreground",
      )}
    >
      <StateIcon state={state} />
      <span>{gridThreadStateLabel(state)}</span>
      {elapsed}
    </span>
  );
}

function RunningElapsed({ startedAt }: { startedAt: string }) {
  const nowMs = useNowSecond();
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return null;
  return <span>{formatWorkingDurationLabel(nowMs - startedMs)}</span>;
}

function StateIcon({ state }: { state: GridThreadState }) {
  if (state === "running") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="size-3.5 shrink-0">
        <circle cx="12" cy="12" r="8" strokeDasharray="3 3.3" />
      </svg>
    );
  }
  if (state === "ready") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="size-3.5 shrink-0">
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
      </svg>
    );
  }
  if (state === "needs") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="size-3.5 shrink-0">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M9.8 9.6a2.3 2.3 0 0 1 4.4.9c0 1.6-2.2 1.9-2.2 3.2" />
        <path d="M12 16.6v.1" />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="size-3.5 shrink-0">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.8v5" />
        <path d="M12 16.2v.1" />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-3.5 shrink-0">
      <circle cx="12" cy="13" r="7" />
      <path d="M12 10v3.2l2 1.4M5 5.5 7.5 3.5M19 5.5l-2.5-2" />
    </svg>
  );
}

function ThreadCard({
  gridId,
  thread,
  query,
  providerEntries,
  nowIso,
  focused,
  selected,
  dragging,
  workspaceTitle,
  onOpen,
  onSelect,
  onClose,
  onHold,
  onPickHoldTime,
  onRename,
  onSetAutoClose,
  onDragStart,
  onDragEnd,
  onDropOnThread,
  readDragged,
}: {
  gridId: string;
  thread: EnvironmentThreadShell;
  query: string;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
  nowIso: string;
  focused: boolean;
  selected: boolean;
  dragging: boolean;
  workspaceTitle: string;
  onOpen: () => void;
  onSelect: (input: { shiftKey: boolean; toggleKey: boolean }) => void;
  onClose: () => void;
  onHold: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onPickHoldTime: () => Promise<Pick<SnoozePreset, "snoozedUntil"> | null>;
  onRename: (title: string) => void;
  onSetAutoClose: (enabled: boolean) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOnThread: (source: DraggedThread) => void;
  readDragged: (event: ReactDragEvent) => DraggedThread | null;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(thread.title);
  const nowMinute = useNowMinute();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const closeShortcut = shortcutLabelForCommand(keybindings, "thread.settle");
  const state = resolveGridThreadState(thread, nowIso);
  const attention = state === "needs" || state === "ready" || state === "back";
  const startedAt = resolveThreadWorkingStartedAt(thread);
  const pullRequestNumber = openPullRequestNumber(thread);
  const providerEntry = providerEntries.get(thread.providerInstanceId);
  const presets = resolveSnoozePresets(
    new Date(`${nowMinute}:00.000Z`),
    timestampFormat,
    thread.environmentId,
  );
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const modelLabel = thread.modelSelection?.model ?? null;

  const applyPreset = (preset: Pick<SnoozePreset, "snoozedUntil"> | undefined) => {
    if (preset !== undefined) onHold(preset);
  };

  const close = () => {
    onClose();
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            draggable={!renaming}
            onDragStart={(event) => {
              event.dataTransfer.setData(
                THREAD_DRAG_TYPE,
                JSON.stringify({ gridId, threadId: thread.id }),
              );
              event.dataTransfer.effectAllowed = "move";
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            onDragOver={(event) => {
              if (readDragged(event) === null) return;
              event.preventDefault();
              event.stopPropagation();
            }}
            onDrop={(event) => {
              const source = readDragged(event);
              if (source === null) return;
              event.preventDefault();
              event.stopPropagation();
              onDropOnThread(source);
            }}
            data-thread-key={threadKey}
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("button, [role='button'], [role='menu']") !== null
              ) {
                return;
              }
              if (event.shiftKey || event.metaKey || event.ctrlKey) {
                onSelect({ shiftKey: event.shiftKey, toggleKey: event.metaKey || event.ctrlKey });
                return;
              }
              onOpen();
            }}
            className={cn(
              "group/th relative flex w-full flex-col gap-0.75 rounded-lg py-1.75 pr-2.5 pl-7.5 text-left outline-none",
              "cursor-pointer",
              dragging && "opacity-50",
              selected
                ? "bg-(--accent-muted)"
                : focused
                  ? "bg-(--sel)"
                  : "hover:bg-(--hover)",
            )}
          />
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          {renaming ? (
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                setRenaming(false);
                onRename(name.trim());
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setName(thread.title);
                  setRenaming(false);
                }
              }}
              className="h-6 min-w-0 flex-1 rounded-(--r-ctl) border border-input bg-background px-1.5 text-xs text-foreground outline-none focus:border-ring"
            />
          ) : (
            <button
              type="button"
              data-card-open=""
              onClick={(event) => {
                if (event.shiftKey || event.metaKey || event.ctrlKey) {
                  event.preventDefault();
                  onSelect({ shiftKey: event.shiftKey, toggleKey: event.metaKey || event.ctrlKey });
                  return;
                }
                onOpen();
              }}
              onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
                if (event.key === "F2") {
                  event.preventDefault();
                  setName(thread.title);
                  setRenaming(true);
                }
              }}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none"
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-headline leading-4.75",
                  attention
                    ? "font-semibold text-foreground"
                    : "font-medium text-secondary-foreground",
                )}
              >
                <HighlightedText text={thread.title} query={query} />
              </span>
              <span className="shrink-0 group-hover/th:invisible">
                {state === "idle" ? (
                  <span className="text-xs text-secondary-label tabular-nums">
                    {threadTimeLabel(thread, nowMinute)}
                  </span>
                ) : (
                  <ThreadStateMark state={state} startedAt={startedAt} />
                )}
              </span>
            </button>
          )}
          <span className="absolute top-[5px] right-2 hidden items-center gap-0.5 group-hover/th:flex">
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Hold"
                    className="inline-grid size-[22px] cursor-pointer place-items-center rounded-(--r-badge) text-secondary-foreground hover:bg-(--sel) hover:text-foreground"
                  >
                    <ClockIcon aria-hidden className="size-3.5" />
                  </button>
                }
              />
              <MenuPopup side="bottom" align="end">
                <HoldMenuItems presets={presets} onPick={applyPreset} onPickTime={onPickHoldTime} />
              </MenuPopup>
            </Menu>
            <button
              type="button"
              aria-label="Close thread"
              onClick={close}
              className="inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-(--r-badge) px-1.5 text-xs text-secondary-foreground hover:bg-(--sel) hover:text-foreground"
            >
              <XIcon aria-hidden className="size-3.5" />
              Close
            </button>
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Thread actions for ${thread.title}`}
                    className="inline-grid size-[22px] cursor-pointer place-items-center rounded-(--r-badge) text-secondary-foreground hover:bg-(--sel) hover:text-foreground"
                  >
                    <MoreHorizontalIcon aria-hidden className="size-3.5" />
                  </button>
                }
              />
              <MenuPopup side="bottom" align="end">
                <MenuItem onClick={onOpen}>
                  Open in grid
                  <MenuShortcut>Enter</MenuShortcut>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setName(thread.title);
                    setRenaming(true);
                  }}
                >
                  Rename
                  <MenuShortcut>F2</MenuShortcut>
                </MenuItem>
                <MenuSeparator />
                <MenuSub>
                  <MenuSubTrigger>
                    Hold
                    <ChevronRightIcon aria-hidden className="ml-auto size-3.5 text-secondary-label" />
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <HoldMenuItems
                      presets={presets}
                      onPick={applyPreset}
                      onPickTime={onPickHoldTime}
                    />
                  </MenuSubPopup>
                </MenuSub>
                <MenuItem onClick={close}>
                  Close
                  {closeShortcut ? <MenuShortcut>{closeShortcut}</MenuShortcut> : null}
                </MenuItem>
                <MenuSeparator />
                <MenuCheckboxItem
                  checked={thread.autoSettleDisabledAt == null}
                  onCheckedChange={(checked) => onSetAutoClose(Boolean(checked))}
                >
                  Auto-close on merge
                  {thread.autoSettleDisabledAt == null ? (
                    <span className="ml-auto text-2xs text-secondary-label">On</span>
                  ) : null}
                </MenuCheckboxItem>
              </MenuPopup>
            </Menu>
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-caption leading-3.75 text-secondary-label">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-2xs">
            {thread.branch ?? "no branch"}
          </span>
          {pullRequestNumber !== null ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 tabular-nums">
              <span aria-hidden>#</span>
              {pullRequestNumber}
            </span>
          ) : null}
          <span className="inline-grid size-3.5 shrink-0 place-items-center">
            {providerEntry !== undefined ? (
              <SidebarProviderStack thread={thread} providerEntryByInstanceId={providerEntries} />
            ) : null}
          </span>
        </div>
        {selected ? (
          <span className="sr-only" aria-live="polite">
            Selected
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom" align="start" className="max-w-65">
        <div className="flex flex-col gap-1.5 px-3 py-2.5 text-xs leading-4 text-secondary-foreground">
          <span className="text-xs leading-4 font-semibold text-foreground">
            {thread.title}
          </span>
          <span className="flex items-center gap-1.5">
            <ChevronRightIcon aria-hidden className="size-3" />
            {workspaceTitle}
          </span>
          <span className="flex items-center gap-1.5">
            <GitBranchIcon aria-hidden className="size-3" />
            {thread.branch ?? "no branch"}
          </span>
          <span className="flex items-center gap-1.5">
            <AlarmClockIcon aria-hidden className="size-3" />
            {modelLabel ?? "model"}
          </span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function HoldMenuItems({
  presets,
  onPick,
  onPickTime,
}: {
  presets: ReadonlyArray<SnoozePreset>;
  onPick: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onPickTime: () => Promise<Pick<SnoozePreset, "snoozedUntil"> | null>;
}) {
  return (
    <>
      <div className="px-2 pt-1 pb-1 text-2xs font-semibold text-secondary-label">Hold until</div>
      {presets.map((preset) => (
        <MenuItem key={preset.id} onClick={() => onPick(preset)}>
          {preset.label}
          <span className="ml-auto text-2xs text-secondary-label">{preset.whenLabel}</span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        onClick={() => {
          void (async () => {
            const picked = await onPickTime();
            if (picked !== null) onPick(picked);
          })();
        }}
      >
        Pick a time…
      </MenuItem>
    </>
  );
}
