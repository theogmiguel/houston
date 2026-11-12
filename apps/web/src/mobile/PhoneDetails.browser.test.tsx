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
import { useRightPanelStore } from "~/rightPanelStore";
import { useDiffPanelStore } from "~/diffPanelStore";
import {
  ENVIRONMENT_ID,
  gitActionRequests,
  installFakeEnvironment,
  threadWithHistory,
  withPendingChanges,
} from "../../test/fakeEnvironment";
import { loadEmptyLayout } from "../../test/loadedLayout";
import { render } from "../../test/render";
import { expectFullWidthRows, expectSheetRecipe, textLeft } from "./phoneGeometry";

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
  loadEmptyLayout();
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
  await vi.waitFor(
    () => expect(router.state.location.pathname).toMatch(/^\/environment-render\//),
    {
      timeout: 5_000,
    },
  );
  if (width < 640) {
    await vi.waitFor(() => expect(phoneBar()).not.toBeNull(), { timeout: 5_000 });
  } else {
    await vi.waitFor(() => expect(document.querySelector("[data-layout-strip]")).not.toBeNull(), {
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

async function closeDetailsFromSheet() {
  await userEvent.click(page.getByRole("button", { name: "Close" }).element());
  await vi.waitFor(() => expect(detailsSheet()).toBeNull(), { timeout: 5_000 });
}

it("opens thread details in a bottom sheet and closes it from the sheet header", async () => {
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

  await closeDetailsFromSheet();
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

it("opens Changes and shows the only changed file's diff", async () => {
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

  // A single changed file loads without a tap: its header is the only row.
  await expect.element(page.getByRole("button", { name: "src/App.tsx" })).toBeVisible();
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

it.each([390, 320])(
  "lays the details sheet out like the other phone sheets at %ipx",
  async (width) => {
    const { screen } = await openThread(width);
    await using _screen = screen;
    await openDetails();
    const sheet = detailsSheet()!;
    await vi.waitFor(() => expect(allText(sheet)).toContain("#42"), { timeout: 5_000 });
    expectSheetRecipe(sheet, width);

    // One surface: the card inside the sheet adds no shadow, radius or inset of its own.
    const card = sheet.querySelector<HTMLElement>("[data-thread-details-card]")!;
    expect(getComputedStyle(card).boxShadow).toBe("none");
    expect(parseFloat(getComputedStyle(card).borderTopLeftRadius)).toBe(0);
    expect(card.getBoundingClientRect().left).toBeCloseTo(sheet.getBoundingClientRect().left, 0);

    // The sheet is sized to its rows: no blank band under the last one.
    const rows = [...sheet.querySelectorAll<HTMLElement>("[data-thread-details-row]")].filter(
      (row) => row.getClientRects().length > 0,
    );
    expectFullWidthRows(sheet, rows, width);
    const sheetRect = sheet.getBoundingClientRect();
    const lastBottom = Math.max(...rows.map((row) => row.getBoundingClientRect().bottom));
    expect(sheetRect.bottom - lastBottom).toBeLessThanOrEqual(64);

    // Select rows (workspace, branch) put their icon on the same inset as the plain rows.
    for (const label of sheet.querySelectorAll<HTMLElement>('[data-slot="select-label"]')) {
      const icon = label.querySelector<SVGElement>("svg");
      if (icon === null) continue;
      expect(icon.getBoundingClientRect().left - sheetRect.left).toBeCloseTo(16, 0);
    }

    // The pull request row has a leading icon and its label shares the other rows' label column.
    const prRow = rows.find((row) => row.textContent?.includes("#42"))!;
    const prIcon = prRow.querySelector<SVGElement>("svg")!;
    expect(prIcon.getBoundingClientRect().left - sheetRect.left).toBeCloseTo(16, 0);
    const changesRow = detailsRowButton("Changes")!;
    const labelLeft = (row: HTMLElement, text: string) => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes(text)) {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getBoundingClientRect().left;
        }
      }
      throw new Error(`no text "${text}" in row`);
    };
    expect(labelLeft(prRow, "#42")).toBeCloseTo(labelLeft(changesRow, "Changes"), 0);
  },
);

it.each([390, 320])(
  "gives the Changes panel a 44px bar, one close action and a 16px gutter at %ipx",
  async (width) => {
    const { screen } = await openThread(width);
    await using _screen = screen;
    await openDetails();
    await userEvent.click(detailsRowButton("Changes")!);
    const panel = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>('[data-preview-panel-mode="sheet"]');
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 5_000 },
    );
    const popup = panel.closest<HTMLElement>('[data-slot="sheet-popup"]')!;
    expect(parseFloat(getComputedStyle(popup).borderInlineStartWidth)).toBe(0);

    const bar = panel.querySelector<HTMLElement>("[data-right-panel-tabbar]")!;
    expect(bar.getBoundingClientRect().height).toBeCloseTo(44, 0);
    expect(parseFloat(getComputedStyle(bar).borderBottomWidth)).toBe(1);
    const back = page.getByRole("button", { name: "Back to thread" }).element();
    expect(back.getBoundingClientRect().height).toBeGreaterThanOrEqual(43.5);
    expect(back.querySelector("svg")!.getBoundingClientRect().left).toBeCloseTo(16, 0);
    expect(
      panel.querySelector('[data-diff-panel-scope] [aria-label="Close Changes"]'),
      "the back control is the only close action",
    ).toBeNull();

    // One file is one header: path, counts and copy on the gutter, with no list above it.
    const changedFile = await vi.waitFor(
      () => {
        const found = panel.querySelector<HTMLButtonElement>("button[data-title]");
        expect(found).not.toBeNull();
        expect(found!.textContent).toBe("src/App.tsx");
        return found!;
      },
      { timeout: 10_000 },
    );
    const fileHeader = changedFile.parentElement!;
    expect(fileHeader.getBoundingClientRect().height).toBeGreaterThanOrEqual(43.5);
    expect(changedFile.getBoundingClientRect().left).toBeCloseTo(16, 0);
    expect(fileHeader.querySelector('[aria-label="Collapse src/App.tsx"]')).toBeNull();
    const headerStat = fileHeader.querySelector<HTMLElement>('[role="group"]')!;
    expect(headerStat.textContent).toContain("+1");
    const copy = fileHeader.querySelector<HTMLElement>('[aria-label="Copy file path"]')!;
    expect(width - copy.getBoundingClientRect().right).toBeCloseTo(16, 0);
    expect(panel.querySelectorAll("button[data-title]")).toHaveLength(1);
    expect(
      [...panel.querySelectorAll<HTMLElement>("button")].filter(
        (button) => button.textContent?.trim() === "App.tsx",
      ),
      "no second row names the file",
    ).toHaveLength(0);

    const toolbar = panel.querySelector<HTMLElement>("[data-surface-subheader]")!;
    const toolbarControls = [...toolbar.querySelectorAll<HTMLElement>("button")].filter(
      (control) => control.getClientRects().length > 0,
    );
    expect(toolbarControls.length).toBeGreaterThan(0);
    for (const control of toolbarControls) {
      expect(
        control.getBoundingClientRect().height,
        control.getAttribute("aria-label") ?? control.textContent ?? "control",
      ).toBeGreaterThanOrEqual(43.5);
    }
    const toolbarText = [...toolbar.querySelectorAll<HTMLElement>("span")].find((span) =>
      span.textContent?.includes("Against"),
    );
    if (toolbarText) {
      expect(toolbarText.getBoundingClientRect().left).toBeCloseTo(16, 0);
    }
    for (const button of panel.querySelectorAll<HTMLElement>('[aria-label="Add panel surface"]')) {
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(43.5);
    }

    await vi.waitFor(
      () => expect(allText(document.body)).toContain("export const app = phone();"),
      {
        timeout: 30_000,
      },
    );
    const viewer = panel.querySelector<HTMLElement>("diffs-container");
    expect(viewer, "diff viewer").not.toBeNull();
    const viewerRect = viewer!.getBoundingClientRect();
    // The hunk and its expand row sit on the same 16px gutter as the header.
    expect(viewerRect.left).toBeCloseTo(16, 0);
    expect(width - viewerRect.right).toBeGreaterThanOrEqual(16 - 0.5);
    const surface = panel.querySelector<HTMLElement>(".diff-render-surface")!;
    expect(surface.getBoundingClientRect().left).toBeCloseTo(16, 0);
    expect(width - surface.getBoundingClientRect().right).toBeCloseTo(16, 0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);

    // No reserved header band between the file bar and the first line, and the expand row shares
    // the code's edges.
    const fileBar = panel.querySelector<HTMLElement>("button[data-title]")!.parentElement!;
    const root = viewer!.shadowRoot!;
    const firstLine = root.querySelector<HTMLElement>("[data-line]")!;
    expect(
      firstLine.getBoundingClientRect().top - fileBar.getBoundingClientRect().bottom,
      "gap under the file bar",
    ).toBeLessThanOrEqual(8);
    const expandRow = root.querySelector<HTMLElement>("[data-separator-wrapper]");
    if (expandRow) {
      expect(expandRow.getBoundingClientRect().left).toBeCloseTo(viewerRect.left, 0);
      expect(expandRow.getBoundingClientRect().right).toBeCloseTo(viewerRect.right, 0);
      expect(parseFloat(getComputedStyle(expandRow).paddingLeft)).toBe(0);
    }
  },
);

it.each([390, 320])(
  "gives the Files panel full-width 44px rows on the 16px gutter at %ipx",
  async (width) => {
    const { screen } = await openThread(width);
    await using _screen = screen;
    await openDetails();
    await userEvent.click(detailsRowButton("Files")!);
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
    const panel = document.querySelector<HTMLElement>('[data-preview-panel-mode="sheet"]')!;
    const popup = panel.closest<HTMLElement>('[data-slot="sheet-popup"]')!;
    expect(parseFloat(getComputedStyle(popup).borderInlineStartWidth)).toBe(0);
    const bar = panel.querySelector<HTMLElement>("[data-right-panel-tabbar]")!;
    expect(bar.getBoundingClientRect().height).toBeCloseTo(44, 0);
    expect(
      page.getByRole("button", { name: "Back to thread" }).element().getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(43.5);

    const rect = readme.getBoundingClientRect();
    expect(rect.left).toBeCloseTo(0, 0);
    expect(rect.right).toBeCloseTo(width, 0);
    expect(rect.height).toBeGreaterThanOrEqual(43.5);
    expect(readme.firstElementChild!.getBoundingClientRect().left).toBeCloseTo(16, 0);
    const search = panel.querySelector<HTMLElement>('input[type="search"]')!;
    expect(
      search.closest("[data-surface-subheader]")!.getBoundingClientRect().height,
    ).toBeGreaterThan(44);
    expect(
      search.parentElement!.getBoundingClientRect().left,
      "the filter field sits on the gutter",
    ).toBeCloseTo(16, 0);
  },
);

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

it.each([390, 320])(
  "shows a back button and a plain title in the Changes bar, without desktop tab chrome at %ipx",
  async (width) => {
    const { screen } = await openThread(width);
    await using _screen = screen;
    await openDetails();
    await userEvent.click(detailsRowButton("Changes")!);
    const panel = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>('[data-preview-panel-mode="sheet"]');
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 5_000 },
    );
    const bar = panel.querySelector<HTMLElement>("[data-right-panel-tabbar]")!;
    expect(bar.querySelector('[aria-label="Add panel surface"]')).toBeNull();
    expect(bar.querySelector('[role="tablist"], [role="tab"]')).toBeNull();
    const title = bar.querySelector<HTMLElement>("[data-right-panel-phone-title]")!;
    expect(title.textContent).toBe("Changes");
    expect(getComputedStyle(title).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    const back = page.getByRole("button", { name: "Back to thread" }).element();
    expect(back.getBoundingClientRect().right).toBeLessThanOrEqual(
      title.getBoundingClientRect().left + 0.5,
    );
    // The toolbar has no split-view toggle on a phone.
    await vi.waitFor(() => expect(panel.querySelector("[data-surface-subheader]")).not.toBeNull(), {
      timeout: 10_000,
    });
    const split = [...panel.querySelectorAll<HTMLElement>("button")].filter(
      (button) =>
        button.getClientRects().length > 0 &&
        /diff view/i.test(button.getAttribute("aria-label") ?? ""),
    );
    expect(split).toHaveLength(0);
  },
);

it.each([390, 320])(
  "gives the Changes file header, counts and toolbar one text size and no band above at %ipx",
  async (width) => {
    const { screen } = await openThread(width);
    await using _screen = screen;
    await openDetails();
    await userEvent.click(detailsRowButton("Changes")!);
    const panel = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>('[data-preview-panel-mode="sheet"]');
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 5_000 },
    );
    const toolbar = await vi.waitFor(
      () => {
        const found = panel.querySelector<HTMLElement>("[data-surface-subheader]");
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 10_000 },
    );
    const path = await vi.waitFor(
      () => {
        const found = panel.querySelector<HTMLElement>("button[data-title]");
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 10_000 },
    );
    const header = path.parentElement!;
    // The file header starts right under the toolbar's border: no lighter band between them.
    expect(header.getBoundingClientRect().top).toBeCloseTo(
      toolbar.getBoundingClientRect().bottom,
      0,
    );
    const toolbarStat = toolbar.querySelector<HTMLElement>('[role="group"]')!;
    const headerStat = header.querySelector<HTMLElement>('[role="group"]')!;
    expect(getComputedStyle(toolbarStat).fontSize).toBe(getComputedStyle(headerStat).fontSize);
    expect(getComputedStyle(path).fontSize).toBe(getComputedStyle(headerStat).fontSize);
    expect(path.scrollWidth).toBeLessThanOrEqual(path.clientWidth + 1);
  },
);

it.each([390, 320])(
  "ends every trailing control of the details sheet on the 16px right gutter at %ipx",
  async (width) => {
    const { screen } = await openThread(width);
    await using _screen = screen;
    await openDetails();
    const sheet = detailsSheet()!;
    await vi.waitFor(() => expect(allText(sheet)).toContain("#42"), { timeout: 5_000 });
    const sheetRect = sheet.getBoundingClientRect();
    type Item = { box: DOMRect; icon: boolean; text: string };
    const items: Item[] = [
      ...sheet.querySelectorAll<HTMLElement>(
        "[data-thread-details-card] svg, [data-thread-details-card] span",
      ),
    ]
      .filter((node) => {
        const box = node.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        if (node instanceof SVGElement) return node.tagName.toLowerCase() === "svg";
        return node.children.length === 0 && (node.textContent ?? "").trim() !== "";
      })
      .map((node) => ({
        box: node.getBoundingClientRect(),
        icon: node instanceof SVGElement,
        text: (node.textContent ?? "").trim(),
      }));
    // Group by row: items on one row share a vertical centre.
    const centre = (box: DOMRect) => box.top + box.height / 2;
    items.sort((a, b) => centre(a.box) - centre(b.box));
    const lines: Item[][] = [];
    for (const item of items) {
      const line = lines.at(-1);
      if (line && Math.abs(centre(line[0]!.box) - centre(item.box)) < 12) line.push(item);
      else lines.push([item]);
    }
    let trailing = 0;
    for (const line of lines) {
      line.sort((a, b) => a.box.left - b.box.left);
      const last = line.at(-1)!;
      // A trailing control is a chevron or icon after the label, or the counts or percentage.
      const isTrailing = (last.icon && line.length > 1) || /^[+\-−]\d|%$/.test(last.text);
      if (!isTrailing) continue;
      trailing += 1;
      expect(sheetRect.right - last.box.right, last.text || "icon").toBeCloseTo(16, 0);
    }
    expect(trailing).toBeGreaterThanOrEqual(4);

    // Every row's label starts after the same 16px icon and 8px gap.
    const changes = detailsRowButton("Changes")!;
    expect(textLeft(changes, "Changes") - sheetRect.left).toBeCloseTo(40, 0);
  },
);
