import "~/index.css";
import { EMPTY_TERMINAL_SESSION_STATE } from "@houston-app/client-runtime/state/terminal";
import { EnvironmentId, ProjectId, ThreadId } from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("~/state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    primaryServerKeybindingsAtom: Atom.make([]),
    serverEnvironment: {},
  } as never;
});

vi.mock(
  import("~/state/entities"),
  () =>
    ({
      useProject: () => ({
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/repo",
      }),
      useQuietThreadShell: () => null,
    }) as never,
);

vi.mock(import("~/state/terminalSessions"), async () => {
  const { Atom } = await import("effect/reactivity");
  const session = Atom.make(EMPTY_TERMINAL_SESSION_STATE);
  return {
    attachedTerminalSessionAtom: () => session,
    useKnownTerminalSessions: () => [],
  } as never;
});

vi.mock(
  import("~/state/session"),
  () =>
    ({
      useEnvironmentScope: () => true,
      readEnvironmentScope: () => true,
    }) as never,
);

vi.mock(
  import("~/state/use-atom-command"),
  () =>
    ({
      useAtomCommand: () => async () => ({ _tag: "Success" }),
    }) as never,
);

vi.mock(
  import("~/state/terminal"),
  () =>
    ({
      terminalEnvironment: { open: {}, write: {}, close: {}, resize: {} },
    }) as never,
);

vi.mock(import("~/state/preview"), () => ({ previewEnvironment: { open: {} } }) as never);

vi.mock(import("~/state/tasks"), () => ({ isKnownTaskKey: () => false }) as never);

vi.mock(
  import("~/components/preview/openTerminalLinkInPreview"),
  () =>
    ({
      openTerminalLinkInPreview: () => {},
    }) as never,
);

vi.mock(import("~/localApi"), () => ({ readLocalApi: () => null }) as never);

vi.mock(import("~/hooks/useSettings"), async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@houston-app/contracts/settings");
  return {
    useClientSettings: <T,>(select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
      select(DEFAULT_CLIENT_SETTINGS),
  } as never;
});

vi.mock(
  import("~/terminal/ghostty/surface"),
  () =>
    ({
      GhosttyTerminalSurface: { create: () => new Promise(() => {}) },
    }) as never,
);

import { render } from "../../../test/render";
import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import type { GridRecord } from "../../grid/gridStore";
import { threadLeaf } from "../../grid/tree";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { GridHost, type GridCellRenderProps } from "./GridHost";
import { GridTerminalDock } from "./GridTerminalDock";
import { GridTopBarControls } from "./GridTopBarControls";
import { gridTerminalThreadRef } from "../../grid/gridTerminal";

const environmentId = EnvironmentId.make("env-1");

const grid: GridRecord = {
  id: "g-1",
  name: "Review",
  environmentId,
  projectId: ProjectId.make("project-1"),
  workspaceKey: "env-1:project-1",
  tree: {
    kind: "split",
    dir: "row",
    children: [threadLeaf("thread-a", "p1"), threadLeaf("thread-b", "p2")],
    weights: [50, 50],
  },
  focusedThreadId: "thread-a",
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00Z",
};

function cellMarkup(cell: GridCellRenderProps) {
  return (
    <div data-grid-cell="" data-thread-id={cell.node.threadId} className="flex flex-1">
      {cell.node.threadId}
    </div>
  );
}

it("opens one terminal docked below the whole grid, outside every cell", async () => {
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  const screen = await render(
    <div style={{ display: "flex", width: 900 }}>
      <div style={{ display: "flex", flexDirection: "column", width: 900, height: 600 }}>
        <GridTopBarControls
          grid={grid}
          gridTerminalRef={gridTerminalThreadRef(environmentId, grid.id)}
        />
        <GridHost
          grid={grid}
          onTreeChange={() => {}}
          onFocusThread={() => {}}
          renderThread={cellMarkup}
        />
        <GridTerminalDock grid={grid} keybindings={[]} />
      </div>
    </div>,
    { router: false },
  );
  await using _screen = screen;

  const toggle = screen.getByRole("button", { name: "Toggle terminal drawer" });
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();

  const drawer = screen.container.querySelector<HTMLElement>("[data-thread-terminal-drawer]");
  expect(drawer).not.toBeNull();
  expect(drawer?.closest("[data-grid-cell]")).toBeNull();

  const dock = screen.container.querySelector<HTMLElement>("[data-grid-terminal-dock]");
  expect(dock).not.toBeNull();
  const dockWidth = dock?.getBoundingClientRect().width ?? 0;
  const cellWidth =
    screen.container.querySelector<HTMLElement>("[data-grid-cell]")?.getBoundingClientRect()
      .width ?? 0;
  expect(Math.round(dockWidth)).toBe(900);
  expect(dockWidth).toBeGreaterThan(cellWidth);

  // The grid's terminal state is keyed apart from any thread's drawer.
  const state = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
  expect(state[scopedThreadKey(gridTerminalThreadRef(environmentId, grid.id))]?.terminalOpen).toBe(
    true,
  );
  expect(
    state[scopedThreadKey({ environmentId, threadId: ThreadId.make("thread-a") })],
  ).toBeUndefined();
});
