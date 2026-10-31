import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { GridEmptyDraft } from "../components/grid/GridEmptyDraft";
import { GridHost } from "../components/grid/GridHost";
import { GridThreadBranch } from "../components/grid/GridThreadBranch";
import { GridThreadCell } from "../components/grid/GridThreadCell";
import {
  EMPTY_PROVIDER_ENTRIES,
  sidebarProviderEntriesAtom,
} from "../components/sidebar/sidebarProviderEntries";
import { GridTopBarControls } from "../components/grid/GridTopBarControls";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { isTauriHost } from "../lib/desktopWindow";
import { useGrid, useGridStore } from "../grid/gridStore";
import { useOpenGridDraft } from "../grid/useOpenGridDraft";
import { containsThread, preorderThreads } from "../grid/tree";
import { isEditableFocused } from "../lib/editableFocus";
import { useQuietThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";

export const Route = createFileRoute("/_chat/grid/$gridId")({
  component: GridRoute,
});

function GridRoute() {
  const { gridId } = Route.useParams();
  const grid = useGrid(gridId);
  const shells = useQuietThreadShells();
  const navigate = useNavigate();
  const setTree = useGridStore((store) => store.setTree);
  const addThread = useGridStore((store) => store.addThread);
  const focusThread = useGridStore((store) => store.focusThread);
  const openDraft = useOpenGridDraft();
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);

  const focusEmptyComposer = () => {
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '[data-grid-empty-draft] [contenteditable="true"], [data-grid-empty-draft] textarea',
        )
        ?.focus();
    });
  };

  const openNewThread = () => {
    if (grid === null) return;
    void openDraft({ gridId: grid.id, focusedThreadId: grid.focusedThreadId }).then(() => {
      if (grid.tree === null) focusEmptyComposer();
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the grid's T shortcut
  useEffect(() => {
    if (grid === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "t") return;
      if (isEditableFocused(event.target)) return;
      if (document.querySelector('[data-slot="menu-popup"], [role="dialog"]') !== null) return;
      event.preventDefault();
      event.stopPropagation();
      openNewThread();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  if (grid === null) {
    return (
      <SidebarInset className="h-svh min-h-0 items-center justify-center overflow-hidden md:h-dvh">
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          <p className="text-sm font-medium">This grid no longer exists</p>
          <p className="text-xs text-muted-foreground">
            It was deleted on this machine, or its workspace is no longer open.
          </p>
          <Link to="/" className="text-xs text-primary underline-offset-4 hover:underline">
            Back to threads
          </Link>
        </div>
      </SidebarInset>
    );
  }

  const workspaceThreads = shells.filter(
    (thread) =>
      thread.environmentId === grid.environmentId &&
      thread.projectId === grid.projectId &&
      thread.archivedAt === null,
  );
  const visibleThreadIds = new Set(
    (grid.tree === null ? [] : preorderThreads(grid.tree)).map((leaf) => leaf.threadId),
  );
  const providerEntries =
    providerEntriesByEnvironment.get(grid.environmentId) ?? EMPTY_PROVIDER_ENTRIES;
  const availableThreads = workspaceThreads
    .filter((thread) => !visibleThreadIds.has(thread.id))
    .map((thread) => ({ threadId: thread.id, title: thread.title }));
  const soloLeaves = grid.tree === null ? [] : preorderThreads(grid.tree);
  const soloThread =
    soloLeaves.length === 1
      ? (workspaceThreads.find((thread) => thread.id === soloLeaves[0]!.threadId) ?? null)
      : null;

  const openThread = (environmentId: string, threadId: string) => {
    if (
      environmentId !== grid.environmentId ||
      !workspaceThreads.some((thread) => thread.id === threadId)
    ) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(environmentId as EnvironmentId, threadId as ThreadId),
        ),
      });
      return;
    }
    if (grid.tree === null || !containsThread(grid.tree, threadId)) {
      addThread(grid.id, threadId);
    }
    focusThread(grid.id, threadId);
    void navigate({ to: "/grid/$gridId", params: { gridId: grid.id } });
  };

  const createThread = (side: "left" | "right" | "top" | "bottom", besideThreadId: string) => {
    void openDraft({
      gridId: grid.id,
      focusedThreadId: besideThreadId,
      side,
    });
  };

  return (
    <SidebarInset
      data-grid-new-thread-shortcut=""
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
    >
      <WorkspacePageHeader
        electron={isElectron}
        reserveNativeControls={isElectron || isTauriHost()}
        className="border-b border-(--divider)"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">Houston</span>
          <span aria-hidden>/</span>
          <span className="truncate">{grid.name}</span>
          {soloThread === null ? null : (
            <>
              <span aria-hidden>/</span>
              <span className="truncate font-medium text-foreground">{soloThread.title}</span>
              {soloThread.branch ? (
                <GridThreadBranch
                  branch={soloThread.branch}
                  worktreePath={soloThread.worktreePath}
                />
              ) : null}
            </>
          )}
        </span>
        <span className="flex-1" />
        <GridTopBarControls grid={grid} />
      </WorkspacePageHeader>
      <GridHost
        grid={grid}
        onTreeChange={(tree) => setTree(grid.id, tree)}
        onFocusThread={(threadId) => focusThread(grid.id, threadId)}
        renderThread={({ node, focused, onClose, onSplit }) => (
          <GridThreadCell
            key={node.id}
            node={node}
            grid={grid}
            focused={focused}
            availableThreads={availableThreads}
            providerEntries={providerEntries}
            onFocus={() => focusThread(grid.id, node.threadId)}
            onClose={onClose}
            onSplit={onSplit}
            onNewThread={(side) => createThread(side, node.threadId)}
            onOpenThread={(ref) => openThread(ref.environmentId, ref.threadId)}
          />
        )}
        renderEmpty={() => <GridEmptyDraft key={grid.id} grid={grid} />}
      />
    </SidebarInset>
  );
}
