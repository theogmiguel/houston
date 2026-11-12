import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { dispatchMenuAction } from "../shortcuts/dispatcher";
import {
  LAYOUT_DEVICE_SETTINGS_KEY,
  resetLayoutDeviceSettings,
  updateLayoutDeviceSettings,
} from "./layoutDeviceSettings";
import {
  createLayoutState,
  focusLayoutWorkspace,
  normalizeLayout,
  openLayoutTab,
  renameLayoutWorkspace,
  type LayoutTabContent,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { createLayoutWorkspaceNamed } from "./layoutWorkspaces";
import { useThreeFingerSwipe } from "./useThreeFingerSwipe";

const environmentId = EnvironmentId.make("local");
const chat = (name: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(name)) },
});

function Swiper() {
  useThreeFingerSwipe();
  return null;
}

function twoWorkspaces() {
  let state = openLayoutTab(createLayoutState(), chat("a"));
  state = renameLayoutWorkspace(state, state.focusedWorkspaceId, "One");
  state = createLayoutWorkspaceNamed(state, "").state;
  state = openLayoutTab(state, chat("b"));
  return focusLayoutWorkspace(normalizeLayout(state), state.workspaces[0]!.id);
}

beforeEach(() => {
  localStorage.removeItem(LAYOUT_DEVICE_SETTINGS_KEY);
  resetLayoutDeviceSettings();
  useLayoutStore.setState({ layout: twoWorkspaces() });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetLayoutDeviceSettings();
  localStorage.removeItem(LAYOUT_DEVICE_SETTINGS_KEY);
  useLayoutStore.getState().reset();
});

describe("useThreeFingerSwipe", () => {
  it("moves one workspace per swipe on macOS once the setting is on", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    updateLayoutDeviceSettings({ threeFingerSwipe: true });
    await using _screen = await render(<Swiper />);
    const before = useLayoutStore.getState().layout.focusedWorkspaceId;
    dispatchMenuAction("layout-swipe-up");
    expect(useLayoutStore.getState().layout.focusedWorkspaceId).not.toBe(before);
  });

  it("ignores swipes while the setting is off", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using _screen = await render(<Swiper />);
    const before = useLayoutStore.getState().layout.focusedWorkspaceId;
    dispatchMenuAction("layout-swipe-up");
    expect(useLayoutStore.getState().layout.focusedWorkspaceId).toBe(before);
  });

  it("registers nothing off macOS, where no host emits the gesture", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    updateLayoutDeviceSettings({ threeFingerSwipe: true });
    await using _screen = await render(<Swiper />);
    const before = useLayoutStore.getState().layout.focusedWorkspaceId;
    dispatchMenuAction("layout-swipe-up");
    expect(useLayoutStore.getState().layout.focusedWorkspaceId).toBe(before);
  });

  it("lets a dialog above keep the gesture", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    updateLayoutDeviceSettings({ threeFingerSwipe: true });
    await using _screen = await render(
      <>
        <Swiper />
        <div data-slot="dialog-popup" />
      </>,
    );
    const before = useLayoutStore.getState().layout.focusedWorkspaceId;
    dispatchMenuAction("layout-swipe-up");
    expect(useLayoutStore.getState().layout.focusedWorkspaceId).toBe(before);
  });
});
