import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";

import { GridHost } from "../components/grid/GridHost";
import { GridThreadCell } from "../components/grid/GridThreadCell";
import { SidebarInset } from "../components/ui/sidebar";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useGrid, useGridStore } from "../grid/gridStore";
import { containsThread, insertBeside, preorderThreads, threadLeaf } from "../grid/tree";
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
  const handleNewThread = useNewThreadHandler();

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
  const availableThreads = workspaceThreads
    .filter((thread) => !visibleThreadIds.has(thread.id))
    .map((thread) => ({ threadId: thread.id, title: thread.title }));

  const openThread = (environmentId: string, threadId: string) => {
    if (
      environmentId !== grid.environmentId ||
      !workspaceThreads.some((thread) => thread.id === threadId)
    ) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(
            environmentId as EnvironmentId,
            threadId as ThreadId,
          ),
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
    void (async () => {
      const created = await handleNewThread(
        scopeProjectRef(
          grid.environmentId as EnvironmentId,
          grid.projectId as ProjectId,
        ),
        { replace: true },
      );
      if (created === null) return;
      if (grid.tree === null) {
        addThread(grid.id, created.threadId, created.draftId);
      } else {
        setTree(
          grid.id,
          insertBeside(
            grid.tree,
            besideThreadId,
            threadLeaf(created.threadId, undefined, created.draftId),
            side,
          ),
        );
        focusThread(grid.id, created.threadId);
      }
      void navigate({ to: "/grid/$gridId", params: { gridId: grid.id } });
    })();
  };

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
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
            onFocus={() => focusThread(grid.id, node.threadId)}
            onClose={onClose}
            onSplit={onSplit}
            onNewThread={(side) => createThread(side, node.threadId)}
            onOpenThread={(ref) => openThread(ref.environmentId, ref.threadId)}
          />
        )}
      />
    </SidebarInset>
  );
}
