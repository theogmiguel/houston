import type {
  HoustonLayoutWorkspacePutInput,
  HoustonLayoutWorkspacePutResult,
  HoustonLayoutWorkspaceRecord,
} from "@houston-app/contracts/houston/layoutWorkspaces";

import type { LayoutState } from "./layoutModel";
import {
  layoutRecordContentKey,
  layoutStateFromRecords,
  layoutStateToRecords,
  type KnownLayoutRecord,
} from "./layoutRecords";
import type { useLayoutStore } from "./layoutStore";

/**
 * How long a change settles before it is sent. A divider drag or a run of key presses changes the
 * layout many times a second; 300 ms is longer than the gap between those events and short enough
 * that an agent sees the finished layout within about a third of a second.
 */
export const LAYOUT_PUSH_DEBOUNCE_MS = 300;

/**
 * Saves of one workspace that lose a revision race before the window gives up and shows the
 * server's copy. Each retry reads the winner's revision first, so a second loss means another
 * writer saved between the two; three is enough for a person and one agent editing together.
 */
export const LAYOUT_CONFLICT_ATTEMPTS = 3;

export interface LayoutSyncDeps {
  readonly store: Pick<typeof useLayoutStore, "getState" | "setState" | "subscribe">;
  /** Calls `listener` with the server's workspaces on every stream event; the stream reconnects itself. */
  readonly watchServer: (
    listener: (snapshot: {
      readonly workspaces: ReadonlyArray<HoustonLayoutWorkspaceRecord>;
      readonly loaded: boolean;
    }) => void,
  ) => () => void;
  /** Rejects when the request fails or the server refuses it; a refusal carries its `kind`. */
  readonly put: (input: HoustonLayoutWorkspacePutInput) => Promise<HoustonLayoutWorkspacePutResult>;
  readonly reorder: (workspaceIds: ReadonlyArray<string>) => Promise<unknown>;
  readonly delete: (workspaceId: string) => Promise<unknown>;
  readonly now?: () => string;
  readonly report?: (message: string) => void;
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

const isDuplicateContent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly kind?: unknown }).kind === "duplicate_content";

const orderKey = (records: ReadonlyArray<{ readonly id: string }>): string =>
  records.map((record) => record.id).join("\u0000");

function ghostIdsOf(layout: LayoutState): Set<string> {
  const ids = new Set<string>();
  for (const workspace of layout.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) if (tab.ghostOf !== undefined) ids.add(tab.id);
      }
    }
  }
  return ids;
}

/**
 * Keeps the layout store and the server's workspaces in step. The server owns the columns, panes,
 * tabs, sizes and names; its changes flow into the store, and a local change is sent back once it
 * settles. A change is sent only when its content differs from what the server last reported, so
 * a change that came from the server is never echoed. Returns a stop function.
 */
export function startLayoutSync(deps: LayoutSyncDeps): () => void {
  const { store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const report = deps.report ?? ((message: string) => console.warn(message));

  let server = new Map<string, HoustonLayoutWorkspaceRecord>();
  let loaded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let changedWhileRunning = false;
  let applying = false;

  const known = (): Map<string, KnownLayoutRecord> =>
    new Map(
      [...server].map(([id, record]) => [id, { name: record.name, createdAt: record.createdAt }]),
    );
  const serverOrder = () => [...server.values()].toSorted((a, b) => a.position - b.position);
  const desired = (): HoustonLayoutWorkspaceRecord[] =>
    layoutStateToRecords(store.getState().layout, known(), now());

  const differsFromServer = (): boolean => {
    const wanted = desired();
    const have = serverOrder();
    if (orderKey(wanted) !== orderKey(have)) return true;
    return wanted.some((record) => {
      const stored = server.get(record.id);
      return (
        stored === undefined || layoutRecordContentKey(record) !== layoutRecordContentKey(stored)
      );
    });
  };

  const adoptServer = (first = false) => {
    // Before the first snapshot the layout is the placeholder the store starts with.
    const current = first ? null : store.getState().layout;
    const layout = layoutStateFromRecords(
      serverOrder(),
      current,
      current === null ? new Set() : ghostIdsOf(current),
    );
    applying = true;
    try {
      store.getState().setLayoutFromServer(layout);
    } finally {
      applying = false;
    }
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void push();
    }, LAYOUT_PUSH_DEBOUNCE_MS);
  };

  /** Saves one workspace; false when the window gave up and the server's copy stands. */
  async function putOne(record: HoustonLayoutWorkspaceRecord): Promise<"saved" | "gave-up"> {
    let expectedRevision = server.get(record.id)?.revision ?? 0;
    for (let attempt = 1; attempt <= LAYOUT_CONFLICT_ATTEMPTS; attempt += 1) {
      const result = await deps.put({ workspace: record, expectedRevision });
      if (result.status === "saved") {
        server.set(record.id, result.workspace);
        return "saved";
      }
      if (result.current === null) {
        server.delete(record.id);
        expectedRevision = 0;
      } else {
        server.set(record.id, result.current);
        expectedRevision = result.current.revision;
      }
    }
    report(
      `Workspace '${record.name}' (${record.id}) lost ${LAYOUT_CONFLICT_ATTEMPTS} revision races in a row; showing the server's copy at revision ${server.get(record.id)?.revision ?? 0}.`,
    );
    return "gave-up";
  }

  async function push(): Promise<void> {
    if (running) {
      changedWhileRunning = true;
      return;
    }
    running = true;
    let adopt = false;
    try {
      const wanted = desired();
      const wantedIds = new Set(wanted.map((record) => record.id));
      const doomed = [...server.values()].filter((record) => !wantedIds.has(record.id));
      // A workspace the window removed is emptied before it is deleted: deleting it would move its
      // chat tabs to the first workspace, and these were closed or already live somewhere else.
      const puts = [
        ...doomed
          .filter((record) => record.columns.length > 0)
          .map((record) => ({ ...record, columns: [] })),
        ...wanted.filter((record) => {
          const stored = server.get(record.id);
          return (
            stored === undefined ||
            layoutRecordContentKey(record) !== layoutRecordContentKey(stored)
          );
        }),
      ];
      // One tab shows one content across the layout, so a tab moved between workspaces is saved
      // out of its old workspace first; a save the server refuses for that waits for the others.
      let pending = puts;
      let progressed = true;
      while (pending.length > 0 && progressed) {
        progressed = false;
        const refused: HoustonLayoutWorkspaceRecord[] = [];
        for (const record of pending) {
          try {
            const outcome = await putOne(record);
            if (outcome === "gave-up") adopt = true;
            progressed = true;
          } catch (error) {
            if (isDuplicateContent(error)) {
              refused.push(record);
            } else {
              report(
                `Workspace '${record.name}' (${record.id}) was not saved to the server: ${errorText(error)}`,
              );
              adopt = true;
            }
          }
        }
        pending = refused;
      }
      for (const record of pending) {
        report(
          `Workspace '${record.name}' (${record.id}) was not saved: another workspace still shows one of its tabs, and one tab shows one thing across the layout.`,
        );
        adopt = true;
      }
      for (const record of doomed) {
        if (adopt) break;
        try {
          await deps.delete(record.id);
          server.delete(record.id);
        } catch (error) {
          report(`Workspace '${record.name}' (${record.id}) was not deleted: ${errorText(error)}`);
          adopt = true;
        }
      }
      const order = wanted.filter((record) => server.has(record.id)).map((record) => record.id);
      if (!adopt && order.length > 1 && orderKey(serverOrder()) !== order.join("\u0000")) {
        try {
          await deps.reorder(order);
          order.forEach((id, position) => {
            const stored = server.get(id);
            if (stored !== undefined) server.set(id, { ...stored, position });
          });
        } catch (error) {
          report(
            `The workspace order (${order.length} workspaces) was not saved: ${errorText(error)}`,
          );
          adopt = true;
        }
      }
    } finally {
      running = false;
    }
    if (changedWhileRunning) {
      changedWhileRunning = false;
      schedule();
      return;
    }
    if (adopt || (timer === null && differsFromServer())) adoptServer();
  }

  const onStoreChange = (
    next: { readonly layout: LayoutState },
    previous: { readonly layout: LayoutState },
  ) => {
    if (applying || !loaded || next.layout === previous.layout) return;
    if (running) changedWhileRunning = true;
    if (differsFromServer()) schedule();
    else if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const stopStore = store.subscribe(onStoreChange);

  const stopServer = deps.watchServer((snapshot) => {
    if (!snapshot.loaded) return;
    const firstSnapshot = !loaded;
    loaded = true;
    server = new Map(snapshot.workspaces.map((record) => [record.id, record]));
    // Unsent local changes keep priority; the push uses the revisions just learned.
    if (timer !== null || running) return;
    if (firstSnapshot) adoptServer(true);
    else if (differsFromServer()) adoptServer();
  });

  return () => {
    stopStore();
    stopServer();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
