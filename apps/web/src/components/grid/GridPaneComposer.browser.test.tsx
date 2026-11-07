import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithPendingQuestion,
  threadWithHistory,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import {
  addThreadToGrid,
  createGridRecord,
  useGridStore,
  workspaceKeyOf,
} from "../../grid/gridStore";

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

const cellsOf = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[data-grid-cell]"),
];

async function renderGrid(gridId: string) {
  await page.viewport(1000, 800);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/grid/${gridId}`] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 800px; width: 1000px;";
  return render(<AppRoot router={router} />, { container, router: false });
}

// Boots the whole app and a three-cell grid; on a loaded 4-vCPU CI runner that has exceeded the default 15 s budget.
const APP_BOOT_TEST_TIMEOUT_MS = 45_000;

it(
  "keeps the two-row composer with its model and workspace chips in a narrow pane",
  async () => {
    using _environment = installFakeEnvironment([
      threadWithHistory("pane-composer-a", 1),
      threadWithHistory("pane-composer-b", 1),
      threadWithHistory("pane-composer-c", 1),
    ]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const gridId = seedGrid(["pane-composer-a", "pane-composer-b", "pane-composer-c"]);
    await using screen = await renderGrid(gridId);
    await vi.waitFor(() => expect(cellsOf(screen.container)).toHaveLength(3));
    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll('[data-testid="composer-editor"]')).toHaveLength(3),
    );

    for (const cell of cellsOf(screen.container)) {
      expect(cell.getBoundingClientRect().width).toBeLessThan(400);
      const editor = cell.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
      const footer = await vi.waitFor(() => {
        const found = cell.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
        expect(found).not.toBeNull();
        return found!;
      });
      // Row 1 is the input alone; the toolbar sits wholly under it.
      expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        editor.getBoundingClientRect().bottom - 1,
      );
      const placeholder = [...editor.querySelectorAll<HTMLElement>("span")].find(
        (node) => node.textContent === "Ask anything…",
      );
      if (placeholder !== undefined) {
        expect(placeholder.getBoundingClientRect().height).toBeLessThanOrEqual(24);
      }

      // The model chip survives as the provider mark with the full name in its tooltip.
      const modelChip = await vi.waitFor(() => {
        const found = footer.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
        expect(found).not.toBeNull();
        return found!;
      });
      await vi.waitFor(() =>
        expect(modelChip.dataset.chatProviderModelPickerIconOnly).toBe("true"),
      );
      expect(modelChip.getAttribute("title") ?? "").not.toBe("");
      expect(footer.querySelector('[aria-label^="Workspace:"]')).not.toBeNull();

      const controls = [...footer.querySelectorAll<HTMLElement>("button")].filter(
        (control) =>
          control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden",
      );
      const footerBox = footer.getBoundingClientRect();
      for (const [index, first] of controls.entries()) {
        const a = first.getBoundingClientRect();
        expect(a.right).toBeLessThanOrEqual(footerBox.right + 1);
        for (const second of controls.slice(index + 1)) {
          const b = second.getBoundingClientRect();
          const overlaps =
            a.left < b.right - 1 &&
            b.left < a.right - 1 &&
            a.top < b.bottom - 1 &&
            b.top < a.bottom - 1;
          expect(
            overlaps,
            `${first.ariaLabel} ${JSON.stringify(a)} overlaps ${second.ariaLabel} ${JSON.stringify(b)} cell ${cell.getBoundingClientRect().width}`,
          ).toBe(false);
        }
      }
    }
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "keeps the question card's Submit clear of the toolbar controls in a narrow pane",
  async () => {
    using _environment = installFakeEnvironment([
      threadWithPendingQuestion("pane-question-a"),
      threadWithHistory("pane-question-b", 1),
      threadWithHistory("pane-question-c", 1),
    ]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const gridId = seedGrid(["pane-question-a", "pane-question-b", "pane-question-c"]);
    await using screen = await renderGrid(gridId);
    await vi.waitFor(() => expect(cellsOf(screen.container)).toHaveLength(3));
    const cell = cellsOf(screen.container).find(
      (candidate) => candidate.getAttribute("data-thread-id") === "pane-question-a",
    )!;
    expect(cell.getBoundingClientRect().width).toBeLessThan(400);
    await vi.waitFor(() =>
      expect(cell.querySelector("[data-chat-composer-top-drawer]")).not.toBeNull(),
    );
    const footer = cell.querySelector<HTMLElement>('[data-chat-composer-footer="true"]')!;
    const cellBox = cell.getBoundingClientRect();
    const submit = await vi.waitFor(() => {
      const found = [...footer.querySelectorAll<HTMLElement>("button")].find((button) =>
        /submit/i.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
      );
      expect(found).toBeDefined();
      return found!;
    });
    const submitBox = submit.getBoundingClientRect();
    expect(submitBox.right).toBeLessThanOrEqual(cellBox.right + 1);
    expect(submitBox.left).toBeGreaterThanOrEqual(cellBox.left);
    const controls = [...footer.querySelectorAll<HTMLElement>("button")].filter(
      (control) =>
        control !== submit &&
        control.getClientRects().length > 0 &&
        getComputedStyle(control).visibility !== "hidden",
    );
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      const overlaps =
        box.left < submitBox.right - 1 &&
        submitBox.left < box.right - 1 &&
        box.top < submitBox.bottom - 1 &&
        submitBox.top < box.bottom - 1;
      expect(overlaps, `${control.ariaLabel} overlaps Submit`).toBe(false);
    }
    // The answer field is the first row; the toolbar sits under it.
    const editor = cell.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      editor.getBoundingClientRect().bottom - 1,
    );
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
