import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import {
  addThreadToGrid,
  createGridRecord,
  useGridStore,
  workspaceKeyOf,
} from "../../grid/gridStore";
import { useRightPanelStore } from "../../rightPanelStore";

// The socket is the only fake layer: the client runtime hands every connection the in-process session.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);
type FakeDriver = import("../../../test/fakeEnvironment").FakeDriver;

// The fake server leaves most requests unanswered, which would raise the slow-request toast.
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const THREAD_IDS = [
  "thread-details-a",
  "thread-details-b",
  "thread-details-c",
  "thread-details-d",
  "thread-details-e",
  "thread-details-f",
];
const THREADS = THREAD_IDS.map((name) => threadWithHistory(name, 2));
installFakeEnvironment(THREADS);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

function seedGrid(threadIds: ReadonlyArray<string>): string {
  const projectId = ProjectId.make("project-render");
  const grid = createGridRecord([], {
    environmentId: ENVIRONMENT_ID,
    projectId,
    workspaceKey: workspaceKeyOf(ENVIRONMENT_ID, projectId),
  });
  const withThreads = threadIds.reduce(
    (record, threadId) => addThreadToGrid(record, threadId),
    grid,
  );
  useGridStore.setState({ grids: [withThreads], threadOrigins: {} });
  return grid.id;
}

function resetPanelStore() {
  useRightPanelStore.setState({
    threadPanelVisibilityByThreadKey: {},
    threadPanelPresentationByThreadKey: {},
  });
}

async function renderGrid(gridId: string, width: number, height: number) {
  await page.viewport(width, height);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/grid/${gridId}`] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: ${height}px; width: ${width}px;`;
  return render(<AppRoot router={router} />, { container, router: false });
}

function cellsIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-grid-cell]")];
}

const inlineCardsIn = (container: HTMLElement) =>
  container.querySelectorAll('[data-grid-cell] [data-thread-details-panel="inline"]');

const popoverCard = () => document.querySelector('[data-thread-details-panel="popover"]');

const detailsToggle = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[aria-label="Toggle thread details panel"]');

it(
  "moves an open inline details card to the cell that gains focus",
  { timeout: 60_000 },
  async () => {
    resetPanelStore();
    const gridId = seedGrid(THREAD_IDS.slice(0, 2));
    await using screen = await renderGrid(gridId, 2800, 1000);
    await vi.waitFor(() => {
      expect(cellsIn(screen.container)).toHaveLength(2);
    });

    const toggle = detailsToggle(screen.container);
    expect(toggle).not.toBeNull();
    await userEvent.click(toggle!);

    await vi.waitFor(() => {
      const focused = screen.container.querySelector<HTMLElement>(
        '[data-grid-cell][data-focused="true"]',
      );
      expect(focused?.querySelector('[data-thread-details-panel="inline"]')).not.toBeNull();
    });

    const cells = cellsIn(screen.container);
    const focusedCell = cells.find((cell) => cell.getAttribute("data-focused") === "true")!;
    const nextCell = cells.find((cell) => cell !== focusedCell)!;
    await userEvent.click(nextCell.querySelector<HTMLElement>("[data-pane-label]")!);

    await vi.waitFor(() => {
      expect(nextCell.getAttribute("data-focused")).toBe("true");
      expect(nextCell.querySelector('[data-thread-details-panel="inline"]')).not.toBeNull();
      expect(focusedCell.querySelector('[data-thread-details-panel="inline"]')).toBeNull();
    });
  },
);

it(
  "keeps the details card inside the focused cell's top right and follows focus",
  { timeout: 60_000 },
  async () => {
    resetPanelStore();
    const gridId = seedGrid(THREAD_IDS.slice(0, 2));
    await using screen = await renderGrid(gridId, 1600, 1000);
    await vi.waitFor(() => {
      expect(cellsIn(screen.container)).toHaveLength(2);
    });

    const toggle = detailsToggle(screen.container);
    expect(toggle).not.toBeNull();
    await userEvent.click(toggle!);

    const focusedCell = () =>
      screen.container.querySelector<HTMLElement>('[data-grid-cell][data-focused="true"]');
    const inlinePanelIn = (cell: HTMLElement | null) =>
      cell?.querySelector<HTMLElement>('[data-thread-details-panel="inline"]') ?? null;

    await vi.waitFor(() => {
      expect(inlinePanelIn(focusedCell())).not.toBeNull();
    });

    const assertInsideTopRight = (cell: HTMLElement, panel: HTMLElement) => {
      const cellRect = cell.getBoundingClientRect();
      const cardRect = panel.getBoundingClientRect();
      expect(cardRect.left).toBeGreaterThanOrEqual(cellRect.left);
      expect(cardRect.right).toBeLessThanOrEqual(cellRect.right);
      expect(cardRect.top).toBeGreaterThanOrEqual(cellRect.top);
      expect(cardRect.bottom).toBeLessThanOrEqual(cellRect.bottom);
      // The card hugs the right half and the top of the cell, not the gutter between cells.
      expect(cardRect.right).toBeGreaterThan(cellRect.left + cellRect.width / 2);
      expect(cardRect.top - cellRect.top).toBeLessThan(80);
    };

    const firstCell = focusedCell()!;
    await vi.waitFor(() => assertInsideTopRight(firstCell, inlinePanelIn(firstCell)!));

    const otherCell = cellsIn(screen.container).find((cell) => cell !== firstCell)!;
    await userEvent.click(otherCell.querySelector<HTMLElement>("[data-pane-label]")!);

    await vi.waitFor(() => {
      expect(otherCell.getAttribute("data-focused")).toBe("true");
      expect(inlinePanelIn(otherCell)).not.toBeNull();
      expect(inlinePanelIn(firstCell)).toBeNull();
    });

    await vi.waitFor(() => assertInsideTopRight(otherCell, inlinePanelIn(otherCell)!));
    expect(inlinePanelIn(otherCell)!.getAttribute("data-workspace-focus-key")).toContain(
      THREAD_IDS[0],
    );

    for (const target of [firstCell, otherCell, firstCell]) {
      await userEvent.click(target.querySelector<HTMLElement>("[data-pane-label]")!);
      await vi.waitFor(() => {
        expect(target.getAttribute("data-focused")).toBe("true");
        expect(inlineCardsIn(screen.container)).toHaveLength(1);
        expect(inlinePanelIn(target)).not.toBeNull();
      });
      await vi.waitFor(() => assertInsideTopRight(target, inlinePanelIn(target)!));
    }

    await userEvent.click(detailsToggle(screen.container)!);
    await vi.waitFor(() => {
      expect(focusedCell()?.querySelector("[data-thread-details-panel]")).toBeNull();
      expect(popoverCard()).toBeNull();
    });
  },
);

for (const threadCount of [3, 6] as const) {
  it(
    `opens the focused thread's details as a popover in a ${threadCount}-thread grid`,
    { timeout: 60_000 },
    async () => {
      resetPanelStore();
      const gridId = seedGrid(THREAD_IDS.slice(0, threadCount));
      await using screen = await renderGrid(gridId, 1400, 900);
      await vi.waitFor(() => {
        expect(cellsIn(screen.container)).toHaveLength(threadCount);
      });

      const toggle = detailsToggle(screen.container);
      expect(toggle).not.toBeNull();
      await userEvent.click(toggle!);

      await vi.waitFor(() => {
        expect(popoverCard()).not.toBeNull();
        expect(inlineCardsIn(screen.container)).toHaveLength(0);
      });
    },
  );
}

it("toggles a compact cell's popover off from the same button", { timeout: 60_000 }, async () => {
  resetPanelStore();
  const gridId = seedGrid(THREAD_IDS.slice(0, 3));
  await using screen = await renderGrid(gridId, 1400, 900);
  await vi.waitFor(() => {
    expect(cellsIn(screen.container)).toHaveLength(3);
  });

  const toggle = detailsToggle(screen.container);
  expect(toggle).not.toBeNull();
  await userEvent.click(toggle!);
  await vi.waitFor(() => {
    expect(popoverCard()).not.toBeNull();
  });

  await userEvent.click(detailsToggle(screen.container)!);
  await vi.waitFor(() => {
    expect(popoverCard()).toBeNull();
    expect(detailsToggle(screen.container)!.getAttribute("aria-pressed")).toBe("false");
  });
});

it("closes the popover on Escape and on an outside press", { timeout: 60_000 }, async () => {
  resetPanelStore();
  const gridId = seedGrid(THREAD_IDS.slice(0, 3));
  await using screen = await renderGrid(gridId, 1400, 900);
  await vi.waitFor(() => {
    expect(cellsIn(screen.container)).toHaveLength(3);
  });

  const toggle = detailsToggle(screen.container);
  expect(toggle).not.toBeNull();
  await userEvent.click(toggle!);
  await vi.waitFor(() => {
    expect(popoverCard()).not.toBeNull();
  });

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => {
    expect(popoverCard()).toBeNull();
  });

  await userEvent.click(toggle!);
  await vi.waitFor(() => {
    expect(popoverCard()).not.toBeNull();
  });

  await userEvent.click(screen.container.querySelector("header")!);
  await vi.waitFor(() => {
    expect(popoverCard()).toBeNull();
  });
});

it("closes the popover when focus moves to another cell", { timeout: 60_000 }, async () => {
  resetPanelStore();
  const gridId = seedGrid(THREAD_IDS.slice(0, 3));
  await using screen = await renderGrid(gridId, 1400, 900);
  await vi.waitFor(() => {
    expect(cellsIn(screen.container)).toHaveLength(3);
  });

  const toggle = detailsToggle(screen.container);
  expect(toggle).not.toBeNull();
  await userEvent.click(toggle!);
  await vi.waitFor(() => {
    expect(popoverCard()).not.toBeNull();
  });

  // Focus the first thread without a pointer, so only the focus change can close it.
  useGridStore.getState().focusThread(gridId, THREAD_IDS[0]!);

  await vi.waitFor(() => {
    expect(popoverCard()).toBeNull();
    expect(
      screen.container
        .querySelector('[data-grid-cell][data-focused="true"]')
        ?.getAttribute("data-thread-id"),
    ).toBe(THREAD_IDS[0]);
  });
});
