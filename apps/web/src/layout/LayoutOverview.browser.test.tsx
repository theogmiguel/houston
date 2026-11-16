import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
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

/** Puts the stores in a known state for one test and restores them when the test ends. */
function openSession(): Disposable {
  useLayoutStore.getState().reset();
  setOverviewPhase("closed");
  return {
    [Symbol.dispose]() {
      useLayoutStore.getState().setOverviewOpen(false);
      setOverviewPhase("closed");
      useLayoutStore.getState().reset();
      configureMotion({ off: false });
    },
  };
}

describe("overviewCloseHintText", () => {
  it("names the user's keys when they sit on the arrows", () => {
    using _session = openSession();
    expect(overviewCloseHintText("Alt+O", "Alt+Shift+Left")).toBe(
      "hjkl, arrows or Alt+Shift+arrows to move, Enter to open, Alt+O or Esc to close",
    );
  });

  it("leaves a rebinding off the arrows unnamed", () => {
    using _session = openSession();
    expect(overviewCloseHintText(null, "Alt+H")).toBe(
      "hjkl or arrows to move, Enter to open, Esc to close",
    );
  });
});

describe("LayoutOverview", () => {
  it("opens from the store, shows its hint and closes on Escape", async () => {
    using _session = openSession();
    useLayoutStore.setState({ layout: stacked(2) });
    await using _screen = await render(<LayoutOverview />);
    useLayoutStore.getState().setOverviewOpen(true);
    await expect.element(page.getByText(/to move, Enter to open/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(useLayoutStore.getState().overviewOpen).toBe(false);
    expect(page.getByText(/to move, Enter to open/).elements()).toHaveLength(0);
  });

  it("moves the selection by keyboard and opens the focused pane on Enter", async () => {
    using _session = openSession();
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
    using _session = openSession();
    const picked = vi.fn();
    await using _screen = await render(<LayoutOverview onPick={picked} />);
    useLayoutStore.getState().setOverviewOpen(true);
    await expect.element(page.getByText(/to move, Enter to open/)).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(picked).toHaveBeenCalledWith(null);
    expect(useLayoutStore.getState().overviewOpen).toBe(false);
  });

  it("leaves the keys to a dialog open above it", async () => {
    using _session = openSession();
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

function renderOverlay(layout: LayoutState, onPick = vi.fn(), width = 1000) {
  const viewport = { width, whenNoRoom: "shrink-then-scroll" } as const;
  const stage = selectOverviewStage(layout, viewport, width);
  return {
    onPick,
    ui: (
      <div data-overview-host="" style={{ position: "relative", width, height: 600 }}>
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

describe("OverviewStageOverlay", () => {
  it("draws a pane per workspace row and picks one on click", async () => {
    using _session = openSession();
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
    using _session = openSession();
    const layout = createLayoutState();
    useLayoutStore.setState({ layout });
    setOverviewPhase("open");
    const { ui } = renderOverlay(layout);
    await using screen = await render(ui);
    expect(screen.container.querySelectorAll("[data-overview-pane]")).toHaveLength(0);
    expect(screen.container.querySelector("[data-overview-workspace]")).not.toBeNull();
  });
});

describe("overview at a narrow width", () => {
  it("keeps every pane and the close hint inside a 320px window", async () => {
    using _session = openSession();
    await page.viewport(360, 640);
    try {
      const layout = stacked(3);
      useLayoutStore.setState({ layout });
      setOverviewPhase("open");
      const { ui } = renderOverlay(layout, vi.fn(), 320);
      await using screen = await render(
        <>
          {ui}
          <LayoutOverview />
        </>,
      );
      useLayoutStore.getState().setOverviewOpen(true);
      await expect.element(page.getByText(/to move, Enter to open/)).toBeVisible();
      const host = screen.container.querySelector("[data-overview-host]")!.getBoundingClientRect();
      const panes = [...screen.container.querySelectorAll("[data-overview-pane]")];
      expect(panes).toHaveLength(3);
      for (const pane of panes) {
        const rect = pane.getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(host.left - 1);
        expect(rect.right).toBeLessThanOrEqual(host.right + 1);
      }
      const footer = document.querySelector("[data-overview-close-hint]")!.getBoundingClientRect();
      expect(footer.width).toBeLessThanOrEqual(360);
    } finally {
      await page.viewport(1280, 720);
    }
  });
});

describe("overview motion", () => {
  it("draws its footer without a transition under reduced motion", async () => {
    using _session = openSession();
    useLayoutStore.setState({ layout: stacked(2) });
    configureMotion({ off: true });
    await using _screen = await render(<LayoutOverview />);
    useLayoutStore.getState().setOverviewOpen(true);
    await expect.element(page.getByText(/to move, Enter to open/)).toBeVisible();
    const footer = document.querySelector<HTMLElement>("[data-overview-close-hint]")!;
    expect(footer.style.transitionDuration).toBe("0ms");
  });

  it("zooms with a spring by default and at once under reduced motion", () => {
    using _session = openSession();
    expect(Number.parseFloat(String(overviewZoomTransition().transitionDuration))).toBeGreaterThan(
      0,
    );
    configureMotion({ off: true });
    expect(overviewZoomTransition().transitionDuration).toBe("0ms");
  });
});
