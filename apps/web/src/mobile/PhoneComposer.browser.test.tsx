import { createMemoryHistory } from "@tanstack/react-router";
import type { ServerProvider } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useGridStore } from "~/grid/gridStore";
import {
  advertiseFileUploads,
  dispatchedCommands,
  installFakeEnvironment,
  runningRun,
  threadWithHistory,
  threadWithPendingApproval,
  threadWithPendingQuestion,
  withPendingChanges,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";
import { expectFullWidthRows, expectSheetRecipe } from "./phoneGeometry";

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

const reasoningCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Effort",
      type: "select" as const,
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
  ],
};

// Composed fixture: two models whose reasoning levels the phone sheet can switch between.
const providerModels: ServerProvider["models"] = [
  { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: reasoningCapabilities },
  { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: reasoningCapabilities },
];

function runningThread(name: string) {
  const history = threadWithHistory(name, 1);
  return {
    ...history,
    supportsActiveSteering: true,
    runs: [
      ...history.runs,
      runningRun(history.id, `${name}-run-live`, history.runs.length + 1, `${name}-user-live`),
    ],
  };
}

installFakeEnvironment(
  [
    threadWithHistory("phone-composer", 2),
    threadWithHistory("phone-add", 1),
    threadWithHistory("phone-send", 1),
    withPendingChanges({ ...threadWithHistory("phone-changes", 1), branch: "feature/phone" }, [
      { path: "src/App.tsx", additions: 3, deletions: 1 },
    ]),
    threadWithPendingApproval("phone-approve"),
    threadWithPendingApproval("phone-decline"),
    threadWithPendingQuestion("phone-question"),
    runningThread("phone-queue"),
    runningThread("phone-steer"),
  ],
  { providerModels },
);
advertiseFileUploads();

async function openThread(
  width: number,
  threadId: string,
  settings: Partial<typeof DEFAULT_CLIENT_SETTINGS> = {},
) {
  // The grid store outlives one test's app; a leftover grid would mount extra hidden composers.
  useGridStore.setState({ grids: [], threadOrigins: {} });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    ...settings,
  });
  await page.viewport(width, 844);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: 844px; width: ${width}px;`;
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  const row = await vi.waitFor(
    () => {
      const found = document.querySelector<HTMLElement>(
        `[data-sidebar-row="environment-render:${threadId}"]`,
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
  if (width >= 640) {
    await vi.waitFor(() => expect(document.querySelector("[data-grid-page]")).not.toBeNull(), {
      timeout: 5_000,
    });
  } else {
    await vi.waitFor(
      () => expect(document.querySelector("[data-phone-thread-bar]")).not.toBeNull(),
      {
        timeout: 5_000,
      },
    );
  }
  return { screen, router };
}

async function expandComposer() {
  const expand = document.querySelector<HTMLElement>('[aria-label="Expand composer"]');
  if (expand !== null) await userEvent.click(expand);
  await vi.waitFor(
    () => expect(document.querySelector('[data-chat-composer-footer="true"]')).not.toBeNull(),
    { timeout: 5_000 },
  );
}

const modelTrigger = () =>
  document.querySelector<HTMLButtonElement>("[data-phone-model-sheet-trigger]");
const addTrigger = () =>
  document.querySelector<HTMLButtonElement>("[data-phone-add-sheet-trigger]");
const editor = () => {
  const found = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  expect(found).not.toBeNull();
  return found!;
};

it.each([390, 320])("lays the phone model sheet out as one 16px column at %ipx", async (width) => {
  const { screen } = await openThread(width, "phone-composer");
  await using _screen = screen;
  await expandComposer();
  await userEvent.click(modelTrigger()!);
  const sheet = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>("[data-phone-model-sheet]");
    expect(found).not.toBeNull();
    return found!;
  });
  await expect.element(page.getByRole("option", { name: /GPT-5\.5/ })).toBeVisible();
  expectSheetRecipe(sheet, width);
  expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth + 1);

  const options = [...sheet.querySelectorAll<HTMLElement>('[role="option"]')];
  expectFullWidthRows(sheet, options, width);
  for (const option of options) {
    const label = option.querySelector<HTMLElement>("span")!;
    expect(label.getBoundingClientRect().left - sheet.getBoundingClientRect().left).toBeCloseTo(
      16,
      0,
    );
  }
  const radios = [
    ...sheet.querySelectorAll<HTMLElement>('[data-composer-permissions] [role="radio"]'),
  ];
  expectFullWidthRows(sheet, radios, width);
  expect(radios.at(-1)!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    sheet.getBoundingClientRect().bottom - 8 + 0.5,
  );

  // The effort panel and the permissions list follow each other without a blank band.
  const effort = sheet.querySelector<HTMLElement>("[data-model-picker-effort]")!;
  const permissions = sheet.querySelector<HTMLElement>("[data-composer-permissions]")!;
  expect(
    permissions.getBoundingClientRect().top - effort.getBoundingClientRect().bottom,
  ).toBeLessThanOrEqual(1);
  for (const chip of effort.querySelectorAll<HTMLElement>('[role="radio"]')) {
    expect(chip.getBoundingClientRect().height).toBeGreaterThanOrEqual(43.5);
    expect(chip.getBoundingClientRect().right).toBeLessThanOrEqual(width - 16 + 0.5);
  }
  // The provider rail is a row above the list, not a second column.
  const rail = sheet.querySelector<HTMLElement>("[data-model-picker-sidebar]")!;
  expect(rail.getBoundingClientRect().width).toBeCloseTo(width, 0);
  expect(rail.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    options[0]!.getBoundingClientRect().top + 0.5,
  );
});

it.each([390, 320])(
  "lays the phone add sheet out with 44px rows and no preselected row at %ipx",
  async (width) => {
    const { screen } = await openThread(width, "phone-add");
    await using _screen = screen;
    await expandComposer();
    await userEvent.click(addTrigger()!);
    const sheet = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-phone-add-sheet]");
      expect(found).not.toBeNull();
      return found!;
    });
    await expect.element(page.getByRole("button", { name: "Commands" })).toBeVisible();
    expectSheetRecipe(sheet, width);
    const rows = [...sheet.querySelectorAll<HTMLElement>("button")].filter(
      (button) => button.getAttribute("aria-label") !== "Close",
    );
    expect(rows).toHaveLength(3);
    expectFullWidthRows(sheet, rows, width);
    for (const row of rows) {
      const icon = row.querySelector<SVGElement>("svg")!;
      expect(icon.getBoundingClientRect().left - sheet.getBoundingClientRect().left).toBeCloseTo(
        16,
        0,
      );
      expect(document.activeElement, "no row takes initial focus").not.toBe(row);
      expect(row.hasAttribute("data-highlighted")).toBe(false);
    }
  },
);

it("picks model, effort and permissions from the phone sheet", async () => {
  const { screen } = await openThread(390, "phone-composer");
  await using _screen = screen;
  await expandComposer();

  expect(modelTrigger()?.getAttribute("aria-label")).toBe("GPT-5.4, Medium");
  await userEvent.click(modelTrigger()!);
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Model and permissions" })).toBeVisible();

  // The model list is the desktop picker: a pick applies at once and keeps the sheet open.
  await userEvent.click(page.getByRole("option", { name: /GPT-5\.5/ }));
  await vi.waitFor(() =>
    expect(modelTrigger()?.getAttribute("aria-label")).toBe("GPT-5.5, Medium"),
  );
  expect(
    page
      .getByRole("option", { name: /GPT-5\.5/ })
      .element()
      .getAttribute("aria-selected"),
  ).toBe("true");

  // Effort levels come from the same reasoning control the desktop effort panel renders.
  const high = page.getByRole("radio", { name: "High" });
  await userEvent.click(high);
  await vi.waitFor(() => expect(high.element().getAttribute("aria-checked")).toBe("true"));
  await vi.waitFor(() => expect(modelTrigger()?.getAttribute("aria-label")).toBe("GPT-5.5, High"));

  // Permissions are the desktop picker's radios, not a phone-only copy.
  const supervised = page.getByRole("radio", { name: "Supervised" });
  await userEvent.click(supervised);
  await vi.waitFor(() => expect(supervised.element().getAttribute("aria-checked")).toBe("true"));

  await userEvent.click(page.getByRole("button", { name: "Close" }));
  await vi.waitFor(() => expect(document.querySelector("[data-phone-model-sheet]")).toBeNull());
  expect(modelTrigger()?.getAttribute("aria-label")).toBe("GPT-5.5, High");
});

it("toggles plan mode from the phone model sheet", async () => {
  const { screen } = await openThread(390, "phone-composer", { planModeEnabled: true });
  await using _screen = screen;
  await expandComposer();

  await userEvent.click(modelTrigger()!);
  const planToggle = () =>
    document.querySelector<HTMLButtonElement>("[data-phone-plan-mode] button");
  await vi.waitFor(() => expect(planToggle()).not.toBeNull());
  expect(planToggle()?.getAttribute("aria-pressed")).toBe("false");
  await userEvent.click(planToggle()!);
  await vi.waitFor(() => expect(planToggle()?.getAttribute("aria-pressed")).toBe("true"));
  expect(planToggle()?.getAttribute("aria-label")).toContain("return to normal build mode");
  // The sheet stays open, like the desktop docked picker after a mode pick.
  await expect.element(page.getByRole("dialog")).toBeVisible();
});

it("attaches a file, mentions a file and lists commands from the add sheet", async () => {
  const { screen } = await openThread(390, "phone-add");
  await using _screen = screen;
  await expandComposer();

  await userEvent.click(addTrigger()!);
  await expect.element(page.getByRole("heading", { name: "Add to message" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Attach image or file" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Mention a file" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Commands" })).toBeVisible();

  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  await userEvent.upload(input!, new File(["# notes"], "notes.md", { type: "text/markdown" }));
  await vi.waitFor(() =>
    expect(
      [...document.querySelectorAll("[data-attachment-tile]")].some((tile) =>
        tile.textContent?.includes("notes.md"),
      ),
    ).toBe(true),
  );
  await userEvent.click(addTrigger()!);
  await userEvent.click(page.getByRole("button", { name: "Mention a file" }));
  await vi.waitFor(() =>
    expect(document.querySelector("[data-composer-command-drawer]")).not.toBeNull(),
  );
  expect(editor().textContent).toContain("@");

  await userEvent.click(addTrigger()!);
  await userEvent.click(page.getByRole("button", { name: "Commands" }));
  await vi.waitFor(() =>
    expect(document.querySelector("[data-composer-command-drawer]")?.textContent).toContain(
      "/model",
    ),
  );
});

it("sends a message from the phone composer", async () => {
  const { screen } = await openThread(390, "phone-send");
  await using _screen = screen;
  await expandComposer();

  await userEvent.click(editor());
  await userEvent.keyboard("Summarize the notes");
  const submit = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === "Submit message",
    );
    expect(found).not.toBeNull();
    return found!;
  });
  await userEvent.click(submit);
  await vi.waitFor(() => expect(editor().textContent).not.toContain("Summarize the notes"));
  await expect.element(page.getByText("Summarize the notes")).toBeVisible();
});

it("approves a pending approval from the phone composer", async () => {
  const { screen } = await openThread(390, "phone-approve");
  await using _screen = screen;

  const approve = page.getByRole("button", { name: "Approve" });
  await expect.element(approve).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Decline" })).toBeVisible();
  await userEvent.click(approve.element());
  await vi.waitFor(() =>
    expect(
      dispatchedCommands.some(
        (command) =>
          command.type === "runtime-request.respond" &&
          String(command.requestId) === "phone-approve-approval" &&
          command.decision === "accept",
      ),
    ).toBe(true),
  );
});

it("declines a pending approval from the phone composer", async () => {
  const { screen } = await openThread(390, "phone-decline");
  await using _screen = screen;

  const decline = page.getByRole("button", { name: "Decline" });
  await expect.element(decline).toBeVisible();
  await userEvent.click(decline.element());
  await vi.waitFor(() =>
    expect(
      dispatchedCommands.some(
        (command) =>
          command.type === "runtime-request.respond" &&
          String(command.requestId) === "phone-decline-approval" &&
          command.decision === "decline",
      ),
    ).toBe(true),
  );
});

it("answers an agent question from the phone composer", async () => {
  const { screen } = await openThread(390, "phone-question");
  await using _screen = screen;

  const option = page.getByRole("button", { name: /Strict schemas \(Recommended\)/ });
  await expect.element(option).toBeVisible();
  await userEvent.click(option);
  await vi.waitFor(() => {
    const option = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.includes("Strict schemas (Recommended)"),
    );
    expect(option?.getAttribute("aria-pressed")).toBe("true");
  });
  await userEvent.click(page.getByRole("button", { name: /^Submit/ }).element());
  await vi.waitFor(() => {
    const submit = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      /^Submit/.test(candidate.textContent ?? ""),
    );
    expect(submit?.textContent).toBe("Submitting…");
  });
});

it("queues a message while the agent runs", async () => {
  const { screen } = await openThread(390, "phone-queue");
  await using _screen = screen;
  await expandComposer();

  await userEvent.click(editor());
  await userEvent.keyboard("Queue this follow-up");
  await userEvent.click(page.getByRole("button", { name: "Send options" }).element());
  await expect.element(page.getByRole("menuitem", { name: "Steer message" })).toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: "Queue message" }));
  await vi.waitFor(() => expect(editor().textContent).not.toContain("Queue this follow-up"));
});

it("steers a message into the running turn", async () => {
  const { screen } = await openThread(390, "phone-steer");
  await using _screen = screen;
  await expandComposer();

  await userEvent.click(editor());
  await userEvent.keyboard("Steer this follow-up");
  await userEvent.click(page.getByRole("button", { name: "Send options" }).element());
  const steer = page.getByRole("menuitem", { name: "Steer message" });
  await expect.element(steer).toBeVisible();
  expect(steer.element().getAttribute("aria-disabled")).toBeNull();
  await userEvent.click(steer);
  await vi.waitFor(() => expect(editor().textContent).not.toContain("Steer this follow-up"));
});

it("keeps the phone composer and its controls inside a 320px viewport", async () => {
  const { screen } = await openThread(320, "phone-composer");
  await using _screen = screen;
  await expandComposer();

  for (const selector of [
    '[data-chat-composer-form="true"]',
    '[data-chat-composer-surface="true"]',
    '[data-chat-composer-footer="true"]',
  ]) {
    const element = document.querySelector<HTMLElement>(selector)!;
    expect(element.scrollWidth, selector).toBeLessThanOrEqual(element.clientWidth + 1);
  }

  expect(modelTrigger()).not.toBeNull();
  expect(addTrigger()).not.toBeNull();
  const composer = document.querySelector<HTMLElement>('[data-chat-composer-form="true"]')!;
  const controls = [...composer.querySelectorAll<HTMLElement>("button, input")].filter(
    (control) =>
      control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden",
  );
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    expect(
      rect.left,
      control.getAttribute("aria-label") ?? control.textContent,
    ).toBeGreaterThanOrEqual(-0.5);
    expect(
      rect.right,
      control.getAttribute("aria-label") ?? control.textContent,
    ).toBeLessThanOrEqual(320.5);
  }
});

it("keeps the desktop composer at 1024px", async () => {
  const { screen } = await openThread(1024, "phone-composer");
  await using _screen = screen;

  expect(document.querySelector("[data-phone-thread-bar]")).toBeNull();
  expect(modelTrigger()).toBeNull();
  expect(addTrigger()).toBeNull();
  await vi.waitFor(() =>
    expect(document.querySelector("[data-chat-provider-model-picker]")).not.toBeNull(),
  );
  await expect.element(page.getByRole("button", { name: "Attach files" })).toBeVisible();
});

const GUTTER = 16;
// The pane draws a 1px edge, so a 16px gutter starts 17px from the viewport.
const EDGE = 1;

function rect(element: Element) {
  return element.getBoundingClientRect();
}

for (const width of [390, 320]) {
  it(`keeps the model name whole and spaces the toolbar evenly at ${width}px`, async () => {
    const { screen } = await openThread(width, "phone-composer");
    await using _screen = screen;
    await expandComposer();

    const label = modelTrigger()!.querySelector<HTMLElement>("[data-composer-control-label]")!;
    expect(label.textContent).toMatch(/^GPT-5\.\d$/);
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);

    const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]')!;
    const controls = [...footer.querySelectorAll<HTMLElement>("button")]
      .filter((control) => control.getClientRects().length > 0)
      .map((control) => rect(control))
      .sort((a, b) => a.left - b.left);
    expect(controls.length).toBeGreaterThanOrEqual(4);
    const gaps = controls.slice(1).map((box, index) => box.left - controls[index]!.right);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(6);
  });

  it(`renders no empty tray above the composer at ${width}px`, async () => {
    const { screen } = await openThread(width, "phone-changes");
    await using _screen = screen;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-chat-composer-form="true"]')).not.toBeNull(),
    );
    expect(document.querySelector("[data-composer-context-tray]")).toBeNull();
    await expandComposer();
    expect(document.querySelector("[data-composer-context-tray]")).toBeNull();
  });

  it(`puts the timeline, composer and cards on one 16px gutter at ${width}px`, async () => {
    const { screen } = await openThread(width, "phone-composer");
    await using _screen = screen;
    const left = EDGE + GUTTER;
    const right = width - EDGE - GUTTER;

    const form = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-chat-composer-form="true"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(rect(form).left).toBeCloseTo(left, 0);
    expect(rect(form).right).toBeCloseTo(right, 0);

    const prose = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[data-timeline-root] p")].find(
        (node) => node.textContent === "Answer 0 for phone-composer.",
      );
      expect(found).toBeDefined();
      return found!;
    });
    expect(rect(prose).left).toBeCloseTo(left, 0);

    const bubbleText = [...document.querySelectorAll<HTMLElement>("[data-timeline-root] *")].find(
      (node) => node.children.length === 0 && node.textContent === "phone-composer: question 0",
    )!;
    let bubble: HTMLElement | null = bubbleText;
    while (bubble !== null && getComputedStyle(bubble).backgroundColor === "rgba(0, 0, 0, 0)") {
      bubble = bubble.parentElement;
    }
    expect(bubble).not.toBeNull();
    expect(rect(bubble!).right).toBeCloseTo(right, 0);

    const stamp = document.querySelector<HTMLElement>("[data-timeline-root] span.text-xs.tabular-nums");
    if (stamp !== null && stamp.getClientRects().length > 0) {
      expect(rect(stamp).right).toBeLessThanOrEqual(right + 0.5);
    }
    const meta = document.querySelector<HTMLElement>("[data-assistant-meta-footer]");
    if (meta !== null) expect(rect(meta).left).toBeGreaterThanOrEqual(left - GUTTER / 2);
  });

  it(`shows the approval command and 44px decisions at ${width}px`, async () => {
    const { screen } = await openThread(width, "phone-approve");
    await using _screen = screen;
    const card = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-composer-approval-card]");
      expect(found).not.toBeNull();
      return found!;
    });
    const detail = card.querySelector<HTMLElement>('[aria-label="Approval detail"]')!;
    expect(detail.textContent?.trim()).not.toBe("");
    expect(detail.scrollWidth).toBeLessThanOrEqual(detail.clientWidth);
    const buttons = [...card.querySelectorAll<HTMLElement>("button")].map((b) => rect(b));
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const box of buttons) expect(box.height).toBeGreaterThanOrEqual(44);
    const cardBox = rect(card);
    expect(buttons[0]!.left - cardBox.left).toBeCloseTo(cardBox.right - buttons.at(-1)!.right, 0);
    for (const [index, box] of buttons.slice(1).entries()) {
      expect(box.left - buttons[index]!.right).toBeGreaterThanOrEqual(6);
    }
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  });

  it(`gives the question card a 44px submit and no key hints at ${width}px`, async () => {
    const { screen } = await openThread(width, "phone-question");
    await using _screen = screen;
    await vi.waitFor(() =>
      expect(document.querySelector("[data-pending-user-input-toggle]")).not.toBeNull(),
    );
    const submit = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-chat-composer-mobile-pending-actions] button[type="submit"]',
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(rect(submit).height).toBeGreaterThanOrEqual(44);
    expect(
      [...document.querySelectorAll("kbd")].filter((node) => node.getClientRects().length > 0),
    ).toHaveLength(0);
  });
}
