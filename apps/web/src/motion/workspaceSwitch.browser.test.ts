import { describe, expect, it, vi } from "vite-plus/test";

import type { LayoutState, LayoutTabContent } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { configureMotion } from "./registry";
import { WHEEL_STREAM_IDLE_MS } from "./wheelGesture";
import {
  attachWorkspaceSwitch,
  finishWorkspaceSwitch,
  rememberWorkspaceCamera,
  workspaceCamera,
  workspaceStackCamera,
} from "./workspaceSwitch";

const content: LayoutTabContent = { kind: "tasks" };

function workspace(id: string) {
  return {
    id,
    name: null,
    focusedPaneId: `pane-${id}`,
    cameraWidth: null,
    columns: [
      {
        id: `column-${id}`,
        width: 1,
        panes: [
          {
            id: `pane-${id}`,
            size: 1,
            activeTabId: `tab-${id}`,
            tabs: [{ id: `tab-${id}`, content }],
          },
        ],
      },
    ],
  };
}

const twoWorkspaces = (focusedWorkspaceId: string): LayoutState => ({
  workspaces: [workspace("a"), workspace("b"), { ...workspace("c"), columns: [] }],
  focusedWorkspaceId,
});

/** Resolves after about `ms` of polling; counts polls so no clock is read. */
const elapsed = (ms: number) => {
  const interval = 10;
  let polls = 0;
  return vi.waitFor(() => expect(++polls * interval).toBeGreaterThanOrEqual(ms), {
    timeout: ms + 2000,
    interval,
  });
};

/** The host settles a couple of frames after it mounts; a focus change before then is a restore. */
const hostSettled = () => elapsed(100);

function mount(options: { blocked?: boolean; focused?: string } = {}) {
  const original = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: twoWorkspaces(options.focused ?? "a") });
  const root = document.createElement("div");
  const scroller = document.createElement("div");
  scroller.style.cssText = "width:400px;height:300px;overflow:hidden";
  const stage = document.createElement("div");
  scroller.append(stage);
  root.append(scroller);
  document.body.append(root);
  const detach = attachWorkspaceSwitch({
    root,
    scroller,
    stage,
    gap: () => 8,
    blocked: () => options.blocked ?? false,
    stripShown: () => true,
  });
  return {
    root,
    stage,
    detach,
    [Symbol.dispose]: () => {
      detach();
      finishWorkspaceSwitch();
      useLayoutStore.setState({ layout: original });
      configureMotion({ off: false });
      root.remove();
    },
  };
}

describe("attachWorkspaceSwitch", () => {
  it("springs the stack to the focused workspace's row and rests when it lands", async () => {
    using host = mount();
    await hostSettled();
    useLayoutStore.getState().focusWorkspace("b");
    expect(host.stage.style.transform).toBe("translateY(calc(-100% - 8px))");
    expect(host.stage.getAnimations().length).toBeGreaterThan(0);
    await Promise.all(host.stage.getAnimations().map((animation) => animation.finished));
    host.detach();
    expect(host.stage.style.transform).toBe("");
  });

  it("goes up one row for the workspace above", async () => {
    using host = mount({ focused: "b" });
    await hostSettled();
    useLayoutStore.getState().focusWorkspace("a");
    expect(host.stage.style.transform).toBe("translateY(calc(100% + 8px))");
  });

  it("shows the new workspace without a stack when motion is off", async () => {
    configureMotion({ off: true });
    using host = mount();
    await hostSettled();
    useLayoutStore.getState().focusWorkspace("b");
    expect(host.stage.style.transform).toBe("");
    expect(host.stage.getAnimations()).toHaveLength(0);
  });

  it("does not move the stage while another surface owns it", async () => {
    using host = mount({ blocked: true });
    await hostSettled();
    useLayoutStore.getState().focusWorkspace("b");
    expect(host.stage.style.transform).toBe("");
  });

  it("does not animate a focus change made before the host settled", () => {
    using host = mount();
    useLayoutStore.getState().focusWorkspace("b");
    expect(host.stage.style.transform).toBe("");
  });
});

describe("wheel", () => {
  const notch = (init: MouseEventInit = {}) =>
    new WheelEvent("wheel", {
      deltaY: 3,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      bubbles: true,
      cancelable: true,
      ...init,
    });
  const modifier = { ctrlKey: true, metaKey: true, altKey: true };
  // A wheel stream that ended inside the idle gap would adopt this test's first event.
  const streamEnded = () => elapsed(WHEEL_STREAM_IDLE_MS + 30);

  it("steps one workspace on a modified notch and never opens a new one", async () => {
    configureMotion({ off: true });
    using host = mount();
    await Promise.all([hostSettled(), streamEnded()]);
    host.root.dispatchEvent(notch(modifier));
    expect(useLayoutStore.getState().layout.focusedWorkspaceId).toBe("b");
  });

  it("leaves an unmodified wheel to the content", async () => {
    using host = mount();
    await Promise.all([hostSettled(), streamEnded()]);
    const event = notch();
    host.root.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(useLayoutStore.getState().layout.focusedWorkspaceId).toBe("a");
  });
});

describe("workspace cameras", () => {
  it("remembers where a workspace was last scrolled", () => {
    rememberWorkspaceCamera("cam-a", 120);
    expect(workspaceCamera("cam-a")).toBe(120);
    expect(workspaceCamera("cam-unknown")).toBeNull();
  });

  it("moves a remembered camera just enough to show the focused pane", () => {
    const ws = workspace("cam-b");
    const slots = [
      { paneId: "other", rect: { left: 0, top: 0, width: 0.25, height: 1 } },
      { paneId: "pane-cam-b", rect: { left: 0.75, top: 0, width: 0.25, height: 1 } },
    ] as never;
    rememberWorkspaceCamera("cam-b", 0);
    expect(workspaceStackCamera(ws, slots, 2000, 400)).toBe(1500);
  });

  it("finishes a switch that never started as a no-op", () => {
    expect(finishWorkspaceSwitch()).toEqual({ rowOffset: 0, scrollLeft: null });
  });
});
