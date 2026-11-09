import { scopeThreadRef, scopedThreadKey } from "@houston-app/client-runtime/environment";
import { ThreadId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { createMemoryHistory } from "@tanstack/react-router";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useGridStore } from "~/grid/gridStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useDiffPanelStore } from "~/diffPanelStore";
import {
  ENVIRONMENT_ID,
  gitActionRequests,
  installFakeEnvironment,
  threadWithHistory,
  withPendingChanges,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer: the client runtime hands every connection the in-process session.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
type FakeDriver = import("../../test/fakeEnvironment").FakeDriver;

// The fake server leaves most requests unanswered, which would raise the slow-request toast.
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Composed fixture: a checkout with one changed file, an open pull request and a context meter.
const vcsStatus = {
  local: {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/phone",
    hasWorkingTreeChanges: true,
    workingTree: {
      rootPath: "/workspace/render",
      files: [
        {
          path: "src/App.tsx",
          insertions: 3,
          deletions: 1,
          unstaged: true,
          status: "modified" as const,
        },
      ],
      insertions: 3,
      deletions: 1,
    },
    branchChanges: { baseRef: "main", insertions: 3, deletions: 1 },
  },
  remote: {
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: {
      number: 42,
      title: "Phone details",
      url: "https://example.test/pr/42",
      baseRef: "main",
      headRef: "feature/phone",
      state: "open" as const,
      isDraft: false,
      updatedAt: "2026-03-17T19:12:28.000Z",
    },
  },
};

installFakeEnvironment(
  [
    withPendingChanges(
      {
        ...threadWithHistory("phone-details", 2),
        branch: "feature/phone",
        contextUsage: { usedTokens: 2_000, maxTokens: 8_000 },
      },
      [{ path: "src/App.tsx", additions: 3, deletions: 1 }],
    ),
  ],
  { vcsStatus, workspaceFiles: true },
);

async function mountApp(width: number) {
  useGridStore.setState({ grids: [], threadOrigins: {} });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    threadPanelPresentationByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
    pendingMaximizeThreadKey: null,
  });
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(width, 844);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: 844px; width: ${width}px;`;
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

const phoneBar = () => document.querySelector<HTMLElement>("[data-phone-thread-bar]");
const detailsSheet = () => document.querySelector<HTMLElement>("[data-phone-details-sheet]");
const composer = () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]');

async function openThread(width: number) {
  const { screen, router } = await mountApp(width);
  const row = await vi.waitFor(
    () => {
      const found = document.querySelector<HTMLElement>(
        '[data-sidebar-row="environment-render:phone-details"]',
      );
      expect(found).not.toBeNull();
      return found!;
    },
    { timeout: 5_000 },
  );
  await userEvent.click(row);
  await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/grid\//), {
    timeout: 5_000,
  });
  if (width < 640) {
    await vi.waitFor(() => expect(phoneBar()).not.toBeNull(), { timeout: 5_000 });
  } else {
    await vi.waitFor(() => expect(document.querySelector("[data-grid-page]")).not.toBeNull(), {
      timeout: 5_000,
    });
  }
  return { screen, router };
}

const detailsButton = () =>
  document.querySelector<HTMLButtonElement>(
    '[data-phone-thread-bar] [aria-label="Thread details"]',
  );

const detailsRowButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("[data-thread-details-row]")].find((row) =>
    row.textContent?.trim().startsWith(label),
  );

// The diff viewer and the read-only file preview render inside shadow roots.
function allText(root: ParentNode): string {
  let text = root.textContent ?? "";
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) text += `\n${allText(element.shadowRoot)}`;
  }
  return text;
}

async function openDetails() {
  await userEvent.click(detailsButton()!);
  await vi.waitFor(() => expect(detailsSheet()).not.toBeNull(), { timeout: 5_000 });
}

async function closeDetailsWithSameButton() {
  await userEvent.click(detailsButton()!);
  await vi.waitFor(() => expect(detailsSheet()).toBeNull(), { timeout: 5_000 });
}

it("opens thread details in a bottom sheet and closes it with the same button", async () => {
  const { screen } = await openThread(390);
  await using _screen = screen;

  await openDetails();
  await expect.element(page.getByRole("heading", { name: "Thread details" })).toBeVisible();

  const sheetText = allText(detailsSheet()!);
  // Workspace and branch come from the desktop details card.
  expect(sheetText).toContain("feature/phone");
  // Changes: the base label, both line counts and the commit quick action.
  expect(sheetText).toContain("vs main");
  const changesRow = detailsRowButton("Changes");
  expect(changesRow?.textContent).toContain("+3");
  expect(changesRow?.textContent).toContain("-1");
  expect(sheetText).toContain("Commit");
  // The open pull request and the context meter share the same card.
  expect(sheetText).toContain("#42");
  expect(sheetText).toContain("Context");

  await closeDetailsWithSameButton();
  expect(detailsButton()?.getAttribute("aria-pressed")).toBe("false");
});

it("commits from the phone details sheet and records the action", async () => {
  const { screen } = await openThread(390);
  await using _screen = screen;
  await openDetails();

  await userEvent.click(page.getByRole("button", { name: "Git action options" }).element());
  await userEvent.click(page.getByRole("menuitem", { name: "Commit" }));
  await expect.element(page.getByRole("heading", { name: "Commit changes" })).toBeVisible();
  const message = page.getByPlaceholder("Leave empty to auto-generate");
  await userEvent.type(message.element() as HTMLTextAreaElement, "Phone commit");
  await userEvent.click(page.getByRole("button", { name: "Commit" }).element());

  await vi.waitFor(() => {
    expect(
      gitActionRequests.some(
        (request) => request.action === "commit" && request.commitMessage === "Phone commit",
      ),
    ).toBe(true);
  });
});

it("opens Changes, selects a changed file and shows its diff", async () => {
  const { screen } = await openThread(390);
  await using _screen = screen;
  await openDetails();

  await userEvent.click(detailsRowButton("Changes")!);
  await vi.waitFor(() => expect(detailsSheet()).toBeNull(), { timeout: 5_000 });
  await vi.waitFor(
    () => expect(document.querySelector('[data-preview-panel-mode="sheet"]')).not.toBeNull(),
    { timeout: 5_000 },
  );
  await expect.element(page.getByRole("button", { name: "Back to thread" })).toBeVisible();

  const changedFile = await vi.waitFor(
    () => {
      const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("App.tsx"),
      );
      expect(found).not.toBeUndefined();
      return found!;
    },
    { timeout: 10_000 },
  );
  await userEvent.click(changedFile);
  await vi.waitFor(() => expect(allText(document.body)).toContain("export const app = phone();"), {
    timeout: 10_000,
  });

  await userEvent.click(page.getByRole("button", { name: "Back to thread" }).element());
  await vi.waitFor(
    () => expect(document.querySelector('[data-preview-panel-mode="sheet"]')).toBeNull(),
    { timeout: 5_000 },
  );
  expect(composer()).not.toBeNull();
});

it("opens Files, browses the tree and reads a file without editing", async () => {
  const { screen } = await openThread(390);
  await using _screen = screen;
  await openDetails();

  await userEvent.click(detailsRowButton("Files")!);
  await vi.waitFor(() => expect(detailsSheet()).toBeNull(), { timeout: 5_000 });
  await expect.element(page.getByRole("button", { name: "Back to thread" })).toBeVisible();

  const tree = await vi.waitFor(
    () => {
      const found = document.querySelector<HTMLElement>('[role="tree"]');
      expect(found).not.toBeNull();
      return found!;
    },
    { timeout: 10_000 },
  );
  expect(tree.getAttribute("aria-label")).toBe("render files");

  const readme = await vi.waitFor(
    () => {
      const found = document.querySelector<HTMLElement>(
        '[role="treeitem"][data-item-path="README.md"]',
      );
      expect(found).not.toBeNull();
      return found!;
    },
    { timeout: 10_000 },
  );
  await userEvent.click(readme);
  await vi.waitFor(
    () =>
      expect(allText(document.body)).toContain(
        "The phone Files surface reads this file without writing it.",
      ),
    { timeout: 10_000 },
  );
  expect(
    document.querySelector('[data-preview-panel-mode="sheet"] [contenteditable="true"]'),
  ).toBeNull();

  await userEvent.click(page.getByRole("button", { name: "Back to thread" }).element());
  await vi.waitFor(
    () => expect(document.querySelector('[data-preview-panel-mode="sheet"]')).toBeNull(),
    { timeout: 5_000 },
  );
  expect(composer()).not.toBeNull();
});

it("hides a restored desktop-only terminal tab on phone", async () => {
  const { screen } = await openThread(390);
  await using _screen = screen;
  const ref = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("phone-details"));
  useRightPanelStore.setState({
    byThreadKey: {
      [scopedThreadKey(ref)]: {
        isOpen: true,
        activeSurfaceId: "terminal:phone",
        surfaces: [
          {
            id: "terminal:phone",
            kind: "terminal",
            resourceId: "terminal-phone",
            terminalIds: ["terminal-phone"],
            activeTerminalId: "terminal-phone",
          },
          { id: "diff", kind: "diff" },
        ],
      },
    },
  });

  const tabbar = await vi.waitFor(
    () => {
      const found = document.querySelector<HTMLElement>("[data-right-panel-tabbar]");
      expect(found).not.toBeNull();
      return found!;
    },
    { timeout: 5_000 },
  );
  expect(tabbar.textContent).not.toContain("Terminal");
  await expect.element(page.getByRole("button", { name: "Back to thread" })).toBeVisible();
  await vi.waitFor(() => expect(tabbar.textContent).toContain("Changes"));
});

it("keeps the details sheet and its controls inside a 320px viewport", async () => {
  const { screen } = await openThread(320);
  await using _screen = screen;
  await openDetails();

  const sheet = detailsSheet()!;
  await expect.poll(() => sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth + 1);
  const rect = sheet.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(320.5);

  for (const control of sheet.querySelectorAll<HTMLElement>("button, textarea, input")) {
    if (control.getClientRects().length === 0) continue;
    const controlRect = control.getBoundingClientRect();
    expect(
      controlRect.left,
      control.getAttribute("aria-label") ?? control.textContent ?? "control",
    ).toBeGreaterThanOrEqual(-0.5);
    expect(
      controlRect.right,
      control.getAttribute("aria-label") ?? control.textContent ?? "control",
    ).toBeLessThanOrEqual(320.5);
  }
});

it("keeps the desktop details card and right panel at 1024px", async () => {
  const { screen } = await openThread(1024);
  await using _screen = screen;

  expect(phoneBar()).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Toggle thread details panel" }));
  await vi.waitFor(
    () => expect(document.querySelector("[data-thread-details-card]")).not.toBeNull(),
    { timeout: 5_000 },
  );
  expect(detailsSheet()).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Toggle right panel" }));
  await vi.waitFor(
    () => expect(document.querySelector('[data-preview-panel-mode="inline"]')).not.toBeNull(),
    { timeout: 5_000 },
  );
  await expect
    .element(screen.getByRole("button", { name: "Back to thread" }))
    .not.toBeInTheDocument();
});
