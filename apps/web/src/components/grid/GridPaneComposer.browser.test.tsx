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

async function renderGrid(gridId: string, width = 1000) {
  await page.viewport(width, 800);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/grid/${gridId}`] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: 800px; width: ${width}px;`;
  return render(<AppRoot router={router} />, { container, router: false });
}

// Boots the whole app and a three-cell grid; on a loaded 4-vCPU CI runner that has exceeded the default 15 s budget.
const APP_BOOT_TEST_TIMEOUT_MS = 45_000;

// Runs first: the fake environment serves the thread-shell list once per app runtime, so a
// branch set on a later test's threads would never reach the shell this chip reads.
it(
  "keeps a 24-character branch readable in the folded workspace chip of a 370px pane",
  async () => {
    const branch = "feature/worktree-chip-12";
    expect(branch).toHaveLength(24);
    using _environment = installFakeEnvironment([
      {
        ...threadWithHistory("pane-branch-a", 1),
        branch,
        worktreePath: "/tmp/worktrees/pane-branch-a",
      },
      threadWithHistory("pane-branch-b", 1),
    ]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const gridId = seedGrid(["pane-branch-a", "pane-branch-b"]);
    await using screen = await renderGrid(gridId, 760);
    await vi.waitFor(() => expect(cellsOf(screen.container)).toHaveLength(2));
    const cell = cellsOf(screen.container).find(
      (candidate) => candidate.getAttribute("data-thread-id") === "pane-branch-a",
    )!;
    expect(cell.getBoundingClientRect().width).toBeGreaterThan(340);
    expect(cell.getBoundingClientRect().width).toBeLessThan(400);
    // Re-query on every attempt: the chip renders before the branch arrives and may be replaced.
    const chip = await vi.waitFor(
      () => {
        const found = cell.querySelector<HTMLElement>('[aria-label^="Workspace:"]');
        expect(found?.getAttribute("aria-label")).toBe(`Workspace: ${branch}, Worktree`);
        return found!;
      },
      { timeout: 10_000 },
    );
    expect(chip.getAttribute("title")).toBe(`${branch} · Worktree`);

    // The checkout label is an icon named "Worktree"; the branch keeps its room.
    const envIcon = chip.querySelector<SVGElement>('svg[aria-label="Worktree"]')!;
    expect(envIcon.getBoundingClientRect().width).toBeGreaterThan(0);
    const envText = [...chip.querySelectorAll<HTMLElement>("span")].find(
      (node) => node.textContent === "Worktree",
    )!;
    expect(getComputedStyle(envText).display).toBe("none");
    const label = chip.querySelector<HTMLElement>("[data-composer-label]")!;
    expect(label.textContent).toBe(branch);
    const probe = document.createElement("span");
    probe.className = "text-xs";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    probe.textContent = "0".repeat(10);
    document.body.append(probe);
    const tenCharacters = probe.getBoundingClientRect().width;
    probe.remove();
    expect(label.getBoundingClientRect().width).toBeGreaterThanOrEqual(tenCharacters - 1);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

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
    // The question card hides no toolbar control: the provider stays visible in the model chip.
    const modelChip = footer.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
    expect(modelChip).not.toBeNull();
    expect(modelChip!.getAttribute("title") ?? "").not.toBe("");
    // The answer field is the first row; the toolbar sits under it.
    const editor = cell.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      editor.getBoundingClientRect().bottom - 1,
    );
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
