import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";
import { configureMotion } from "../motion/registry";
import {
  createLayoutState,
  focusLayoutWorkspace,
  normalizeLayout,
  openLayoutTab,
  selectFocusedTab,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { createLayoutWorkspaceNamed } from "./layoutWorkspaces";
import { LayoutOverview, overviewCloseHintText } from "./LayoutOverview";
import { OverviewStageOverlay } from "./OverviewStageOverlay";
import { setOverviewPhase } from "./overviewPhase";
import { selectOverviewStage } from "./overviewStage";
import { overviewZoomTransition } from "./overviewZoom";

const environmentId = EnvironmentId.make("local");
const chat = (name: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(name)) },
});

function stacked(count: number): LayoutState {
  let state = createLayoutState();
  for (let index = 0; index < count; index += 1) {
    state = openLayoutTab(state, chat(`thread-${index}`));
    state = createLayoutWorkspaceNamed(state, "").state;
  }
  return focusLayoutWorkspace(normalizeLayout(state), state.workspaces[0]!.id);
}

beforeEach(() => {
  useLayoutStore.getState().reset();
  setOverviewPhase("closed");
});
afterEach(() => {
  useLayoutStore.getState().setOverviewOpen(false);
  setOverviewPhase("closed");
  useLayoutStore.getState().reset();
  configureMotion({ off: false });
});

describe("overviewCloseHintText", () => {
  it("names the user's keys when they sit on the arrows", () => {
    expect(overviewCloseHintText("Alt+O", "Alt+Shift+Left")).toBe(
      "hjkl, arrows or Alt+Shift+arrows to move, Enter to open, Alt+O or Esc to close",
    );
  });

  it("leaves a rebinding off the arrows unnamed", () => {
    expect(overviewCloseHintText(null, "Alt+H")).toBe("hjkl or arrows to move, Enter to open, Esc to close");
  });
});

describe("LayoutOverview", () => {
  it("opens from the store, shows its hint and closes on Escape", async () => {
    useLayoutStore.setState({ layout: stacked(2) });
    await using _screen = await render(<LayoutOverview />);
    useLayoutStore.getState().setOverviewOpen(true);
    await expect.element(page.getByText(/to move, Enter to open/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(useLayoutStore.getState().overviewOpen).toBe(false);
    expect(page.getByText(/to move, Enter to open/).elements()).toHaveLength(0);
  });

  it("moves the selection by keyboard and opens the focused pane on Enter", async () => {
    useLayoutStore.setState({ layout: stacked(2) });
    const picked = vi.fn();
    await using _screen = await render(<LayoutOverview onPick={picked} />);
    useLayoutStore.getState().setOverviewOpen(true);
    await expect.element(page.getByText(/to move, Enter to open/)).toBeVisible();
    const before = useLayoutStore.getState().layout.focusedWorkspaceId;
    await userEvent.keyboard("j");
    await expect.poll(() => useLayoutStore.getState().layout.focusedWorkspaceId).not.toBe(before);
    await userEvent.keyboard("{Enter}");
    expect(picked).toHaveBeenCalledTimes(1);
    const focused = selectFocusedTab(useLayoutStore.getState().layout);
    expect(picked.mock.calls[0]![0]?.id).toBe(focused?.id);
    expect(useLayoutStore.getState().overviewOpen).toBe(false);
  });

  it("opens with an empty workspace and picks nothing", async () => {
    const picked = vi.fn();
    await using _screen = await render(<LayoutOverview onPick={picked} />);
    useLayoutStore.getState().setOverviewOpen(true);
    await expect.element(page.getByText(/to move, Enter to open/)).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(picked).toHaveBeenCalledWith(null);
    expect(useLayoutStore.getState().overviewOpen).toBe(false);
  });

  it("leaves the keys to a dialog open above it", async () => {
    useLayoutStore.setState({ layout: stacked(2) });
    await using _screen = await render(
      <>
        <LayoutOverview />
        <div data-slot="dialog-popup" tabIndex={-1} />
      </>,
    );
    useLayoutStore.getState().setOverviewOpen(true);
    await expect.element(page.getByText(/to move, Enter to open/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(useLayoutStore.getState().overviewOpen).toBe(true);
  });
});

describe("OverviewStageOverlay", () => {
  function renderOverlay(layout: LayoutState, onPick = vi.fn()) {
    const viewport = { width: 1000, whenNoRoom: "shrink-then-scroll" } as const;
    const stage = selectOverviewStage(layout, viewport, 1000);
    return {
      onPick,
      ui: (
        <div style={{ position: "relative", width: 1000, height: 600 }}>
          <OverviewStageOverlay
            layout={layout}
            stage={stage}
            phase="open"
            onPick={onPick}
            resolveTabLabel={(tab) => ({ icon: null, title: tab.id })}
          />
        </div>
      ),
    };
  }

  it("draws a pane per workspace row and picks one on click", async () => {
    const layout = stacked(3);
    useLayoutStore.setState({ layout });
    setOverviewPhase("open");
    const { ui, onPick } = renderOverlay(layout);
    await using screen = await render(ui);
    const panes = screen.container.querySelectorAll("[data-overview-pane]");
    expect(panes).toHaveLength(3);
    await userEvent.click(panes[2] as HTMLElement);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(useLayoutStore.getState().overviewOpen).toBe(false);
  });

  it("marks the focused pane and shows an empty workspace as a dashed row", async () => {
    const layout = createLayoutState();
    useLayoutStore.setState({ layout });
    setOverviewPhase("open");
    const { ui } = renderOverlay(layout);
    await using screen = await render(ui);
    expect(screen.container.querySelectorAll("[data-overview-pane]")).toHaveLength(0);
    expect(screen.container.querySelector("[data-overview-workspace]")).not.toBeNull();
  });
});

describe("overview motion", () => {
  it("zooms with a spring by default and at once under reduced motion", () => {
    expect(Number.parseFloat(String(overviewZoomTransition().transitionDuration))).toBeGreaterThan(0);
    configureMotion({ off: true });
    expect(overviewZoomTransition().transitionDuration).toBe("0ms");
  });
});
