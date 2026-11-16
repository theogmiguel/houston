import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { configureMotion } from "../motion/registry";
import { finishWorkspaceSwitch } from "../motion/workspaceSwitch";
import { registerCommands } from "../shortcuts/dispatcher";
import { buildLayoutCommandHandlers } from "../shortcuts/layoutCommandHandlers";
import { buildLayout } from "./layoutFixtures";
import { selectFocusedPane } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { LayoutOverview } from "./LayoutOverview";
import { getOverviewPhase, setOverviewPhase } from "./overviewPhase";
import { LayoutWorkspaceStrip } from "./WorkspaceStrip";

function resetSession() {
  finishWorkspaceSwitch();
  useLayoutStore.getState().setOverviewOpen(false);
  useLayoutStore.getState().reset();
  useLayoutStore.setState({ maximizedTabId: null, unseenTabIds: new Set() });
  setOverviewPhase("closed");
  configureMotion({ off: false });
}

function openLayout(shape: string[][][][]): Disposable {
  resetSession();
  useLayoutStore.getState().setLayoutFromServer(buildLayout(shape));
  return { [Symbol.dispose]: resetSession };
}

/** Bindings on a letter, with Alt where the overview must tell the key from its own typing. */
function bindings(
  entries: ReadonlyArray<[string, KeybindingCommand, boolean?]>,
): ResolvedKeybindingsConfig {
  return entries.map(([key, command, alt = false]) => ({
    command,
    shortcut: {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: alt,
      modKey: false,
    },
  }));
}

const KEYS = () =>
  bindings([
    ["q", "layout.focusRight"],
    ["w", "layout.focusLeft"],
    ["e", "layout.overview", true],
    ["r", "layout.focusWorkspaceDown"],
  ]);

function Harness() {
  const layout = useLayoutStore((state) => state.layout);
  return (
    <div style={{ width: 1000, height: 600, position: "relative" }}>
      <LayoutWorkspaceStrip
        layout={layout}
        narrow={false}
        renderTab={(tab) => (
          <div data-body={tab.id} style={{ flex: 1 }}>
            {tab.id}
          </div>
        )}
        tabLabel={(tab) => ({ title: tab.id })}
      />
      <LayoutOverview />
    </div>
  );
}

const focusedPaneId = () => selectFocusedPane(useLayoutStore.getState().layout)?.id;

describe("layout keys through the dispatcher", () => {
  it("moves focus to the next column", async () => {
    using _layout = openLayout([[[["a"]], [["b"]]]]);
    using stack = new DisposableStack();
    stack.defer(registerCommands(buildLayoutCommandHandlers(), { keybindings: KEYS }));
    await using _screen = await render(<Harness />, { router: false });
    await userEvent.keyboard("q");
    expect(focusedPaneId()).toBe("w0c1p0");
    await userEvent.keyboard("w");
    expect(focusedPaneId()).toBe("w0c0p0");
  });

  it("opens the overview from its key, stays in it, and closes it on the same key", async () => {
    using _layout = openLayout([[[["a"]], [["b"]]], [[["c"]]]]);
    using stack = new DisposableStack();
    stack.defer(registerCommands(buildLayoutCommandHandlers(), { keybindings: KEYS }));
    await using screen = await render(<Harness />, { router: false });
    await userEvent.keyboard("{Alt>}e{/Alt}");
    await expect.poll(() => getOverviewPhase()).toBe("open");
    expect(screen.container.querySelector("[data-layout-overview]")).not.toBeNull();
    // A layout key the overview does not list is swallowed, not run on the strip beneath it.
    const before = focusedPaneId();
    await userEvent.keyboard("r");
    expect(focusedPaneId()).toBe(before);
    await userEvent.keyboard("{Alt>}e{/Alt}");
    await expect.poll(() => getOverviewPhase()).toBe("closed");
    expect(useLayoutStore.getState().overviewOpen).toBe(false);
  });
});
