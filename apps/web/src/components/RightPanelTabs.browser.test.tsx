import type { EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ReactNode } from "react";

import { render } from "../../test/render";

vi.mock("@dnd-kit/core", () => ({
  closestCenter: () => null,
  DndContext: ({ children }: { children: ReactNode }) => children,
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
}));

vi.mock("@dnd-kit/modifiers", () => ({
  restrictToFirstScrollableAncestor: () => null,
  restrictToHorizontalAxis: () => null,
}));

vi.mock("@dnd-kit/sortable", () => ({
  horizontalListSortingStrategy: () => null,
  SortableContext: ({ children }: { children: ReactNode }) => children,
  useSortable: () => ({
    attributes: {},
    isDragging: false,
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
    transition: undefined,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Translate: { toString: () => undefined } },
}));


import type { RightPanelTabsProps } from "./RightPanelTabs";
import { RightPanelTabs } from "./RightPanelTabs";
import "~/index.css";

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("~/browser/browserDefaults", async (original) => ({
  ...(await original<typeof import("~/browser/browserDefaults")>()),
  useBrowserDefaults: () => ({ profiles: [] }),
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
  useQuietThreadShell: (() => null) as never,
  useServerConfigs: (() => new Map()) as never,
  useThreadShells: (() => []) as never,
}));

const noop = () => undefined;

function props(width: number): RightPanelTabsProps {
  const inlineSize = {
    width,
    handlers: {
      onPointerDown: noop,
      onKeyDown: noop,
      onDoubleClick: noop,
    },
    observeRow: () => noop,
  };
  return {
    mode: "inline",
    fixedTabs: true,
    open: true,
    keybindings: {} as ResolvedKeybindingsConfig,
    getShortcutContext: (() => ({})) as never,
    inlineSize: inlineSize as never,
    layoutControls: <button type="button">Panel control</button>,
    surfaces: [],
    environmentId: "env-1" as EnvironmentId,
    activeSurfaceId: null,
    pendingSurfaceIds: new Set(),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    onActivate: noop,
    onCloseSurface: noop,
    onCloseOtherSurfaces: noop,
    onCloseSurfacesToRight: noop,
    onCloseAllSurfaces: noop,
    onCopyFilePath: noop,
    onAddBrowser: noop,
    onAddBrowserInProfile: noop,
    onAddTerminal: noop,
    onAddDiff: noop,
    onAddFiles: noop,
    onAddPullRequest: noop,
    onAddPullRequests: noop,
    onAddDevice: noop,
    browserAvailable: true,
    terminalAvailable: true,
    diffAvailable: true,
    filesAvailable: true,
    pullRequestAvailable: true,
    pullRequestsAvailable: true,
    deviceAvailable: true,
    children: null,
  };
}

const FIXED_TABS = ["Changes", "Files", "Preview", "Pull request"];

describe("right panel fixed tab strip", () => {
  it("keeps every fixed tab visible at the default 400px width", async () => {
    await using screen = await render(<RightPanelTabs {...props(400)} />);
    const viewport = screen.container.querySelector<HTMLElement>(
      '[data-right-panel-tab-list] [data-slot="scroll-area-viewport"]',
    );
    expect(viewport).not.toBeNull();
    const tabs = [...screen.container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(FIXED_TABS);
    const viewportRect = viewport!.getBoundingClientRect();
    for (const tab of tabs) {
      const rect = tab.getBoundingClientRect();
      expect(tab.scrollWidth).toBe(tab.clientWidth);
      expect(rect.left).toBeGreaterThanOrEqual(viewportRect.left - 1);
      expect(rect.right).toBeLessThanOrEqual(viewportRect.right + 1);
    }
    expect(viewport!.scrollWidth).toBeLessThanOrEqual(viewport!.clientWidth + 1);
  });

  it("keeps every fixed tab label whole at 320px, scrolling the strip if needed", async () => {
    await using screen = await render(<RightPanelTabs {...props(320)} />);
    const viewport = screen.container.querySelector<HTMLElement>(
      '[data-right-panel-tab-list] [data-slot="scroll-area-viewport"]',
    );
    expect(viewport).not.toBeNull();
    const tabs = [...screen.container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(FIXED_TABS);
    for (const tab of tabs) {
      expect(tab.scrollWidth).toBe(tab.clientWidth);
      viewport!.scrollLeft = tab.offsetLeft;
      const rect = tab.getBoundingClientRect();
      const viewportRect = viewport!.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(viewportRect.left - 1);
      expect(rect.right).toBeLessThanOrEqual(viewportRect.right + 1);
    }
  });
});
