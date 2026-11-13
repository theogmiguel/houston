import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import { ThreadId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import "~/index.css";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { loadEmptyLayout } from "../../../test/loadedLayout";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ComposerAttachButton } from "./ComposerAttachmentStrip";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
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

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Boots the whole app; on a loaded 4-vCPU CI runner that has exceeded the default 15 s budget.
const APP_BOOT_TEST_TIMEOUT_MS = 45_000;

let bootCount = 0;

async function bootDraftComposer() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  loadEmptyLayout();
  const draftId = DraftId.make(`draft-anatomy-${++bootCount}`);
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make(`thread-anatomy-${bootCount}`),
    });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  return app;
}

async function bootThreadComposer() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  loadEmptyLayout();
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/anatomy-caret`] }),
  );
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  return app;
}

function resolveColor(cssValue: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = cssValue;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved;
}

it(
  "keeps one composer anatomy at every width and starts with thread details closed",
  async () => {
    const previousViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1440, 900);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(previousViewport.width, previousViewport.height),
    };
    using _environment = installFakeEnvironment([]);
    await using _app = await bootDraftComposer();

    // The composer resolves once the environment connects and the project mounts.
    const card = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>("[data-chat-composer-main-surface]");
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 10_000 },
    );
    const cardBox = card.getBoundingClientRect();

    // Wide form: one quiet footer row under the card holds the checkout and branch on the left
    // and the pickers on the right; the card itself holds only the text with attach, voice and send.
    expect(document.querySelector('[data-composer-changes-tray="true"]')).toBeNull();
    const tray = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>('[data-composer-context-tray="true"]');
        if (found?.querySelector("[data-composer-context-control]") == null) {
          throw new Error("context controls are not in the composer's workspace line yet");
        }
        return found;
      },
      { timeout: 10_000 },
    );
    const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]')!;
    expect(footer.querySelector("[data-composer-context-control]")).toBeNull();
    expect(footer.querySelector('[aria-label^="Workspace:"]')).toBeNull();
    expect(footer.querySelector("[data-chat-provider-model-picker]")).toBeNull();
    const pickers = tray.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
    expect(pickers).not.toBeNull();
    const trayBox = tray.getBoundingClientRect();
    const cardWithTray = card.getBoundingClientRect();
    expect(trayBox.top).toBeGreaterThanOrEqual(cardWithTray.bottom);
    expect(trayBox.top - cardWithTray.bottom).toBeLessThanOrEqual(12);
    expect(getComputedStyle(tray).borderTopWidth).toBe("0px");
    expect(getComputedStyle(tray).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(tray).flexWrap).not.toBe("wrap");
    const controls = [...tray.querySelectorAll<HTMLElement>("[data-composer-context-control]")];
    for (const control of controls) {
      expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(trayBox.right + 1);
    }
    const lefts = controls.map((control) => control.getBoundingClientRect().left);
    expect(Math.min(...lefts) - trayBox.left).toBeLessThan(trayBox.width / 4);
    // Checkout and branch stay on the left; the model picker is the right-aligned end of the row.
    expect(Math.max(...controls.map((c) => c.getBoundingClientRect().right))).toBeLessThan(
      pickers!.getBoundingClientRect().left,
    );
    expect(trayBox.right - pickers!.getBoundingClientRect().right).toBeLessThan(trayBox.width / 4);
    expect(footer.getBoundingClientRect().top).toBeLessThan(cardBox.bottom);
    expect(card.contains(footer)).toBe(true);

    // A wide composer spells out the mention syntax in the placeholder.
    const editorPlaceholder =
      document.querySelector('[data-testid="composer-editor"]')?.getAttribute("aria-placeholder") ??
      "";
    expect(editorPlaceholder).toBe("Ask anything. @ files, $ skills, / commands");

    // The text sits well inside the card, and the resting input is one line tall.
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    const editorBox = editor.getBoundingClientRect();
    const editorStyle = getComputedStyle(editor);
    expect(
      editorBox.left + parseFloat(editorStyle.paddingLeft) - cardBox.left,
    ).toBeGreaterThanOrEqual(16);
    expect(
      editorBox.top + parseFloat(editorStyle.paddingTop) - card.getBoundingClientRect().top,
    ).toBeGreaterThanOrEqual(10);
    expect(editorBox.height).toBeLessThanOrEqual(40);

    // The details card opens only from its toggle or shortcut.
    expect(document.querySelector('[aria-label="Thread details"]')).toBeNull();

    expect(cardBox.top).toBeLessThanOrEqual(footer.getBoundingClientRect().top);
    const lastButton = () => [...footer.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
    // The label reads "Environment disconnected" until the connection is up.
    await vi.waitFor(() => expect(lastButton().getAttribute("aria-label")).toBe("Submit message"), {
      timeout: 10_000,
    });
    // Nothing follows the primary action, and only one button submits.
    expect(footer.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(lastButton().type).toBe("submit");

    // The send button is a 32px circle: a neutral inert control while there is nothing to send.
    const send = lastButton();
    const emptyStyle = getComputedStyle(send);
    expect(send.disabled).toBe(true);
    expect(send.getBoundingClientRect().width).toBe(32);
    expect(send.getBoundingClientRect().height).toBe(32);
    expect(emptyStyle.backgroundColor).toBe(resolveColor("var(--sel)"));
    expect(emptyStyle.opacity).toBe("1");

    await userEvent.click(page.getByTestId("composer-editor"));
    await userEvent.keyboard("hello");
    await vi.waitFor(() => expect(send.disabled).toBe(false));
    // The fill moves from the neutral disabled recipe to the accent over the feedback role.
    await vi.waitFor(() =>
      expect(getComputedStyle(send).backgroundColor).toBe(resolveColor("var(--accent)")),
    );
    expect(Number(getComputedStyle(send).opacity)).toBe(1);
    await userEvent.keyboard("{Control>}a{/Control}{Backspace}");

    await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
    await expect.element(page.getByPlaceholder("Search models")).toBeVisible();
    await userEvent.keyboard("{Escape}");

    // One anatomy at every composer width: the placeholder never wraps away from its row, the
    // workspace controls collapse into one chip, and nothing leaves the card.
    const form = document.querySelector<HTMLFormElement>('[data-chat-composer-form="true"]')!;
    const surface = document.querySelector<HTMLElement>('[data-chat-composer-surface="true"]')!;
    for (const width of [760, 500, 340]) {
      form.style.width = `${width}px`;
      form.style.maxWidth = "none";
      await vi.waitFor(() =>
        expect(Math.abs(surface.getBoundingClientRect().width - width)).toBeLessThan(3),
      );

      const placeholder = () =>
        document
          .querySelector('[data-testid="composer-editor"]')
          ?.getAttribute("aria-placeholder") ?? "";
      await vi.waitFor(() =>
        expect(placeholder()).toBe(
          width >= 520 ? "Ask anything. @ files, $ skills, / commands" : "Ask anything…",
        ),
      );
      // The placeholder stays on one line, so it never pushes the input taller.
      const placeholderBox = [
        ...surface.querySelectorAll<HTMLElement>('[data-testid="composer-editor"] span'),
      ].find((node) => node.textContent === placeholder());
      if (placeholderBox !== undefined) {
        expect(placeholderBox.getBoundingClientRect().height).toBeLessThanOrEqual(24);
      }

      // The empty composer rests at one input line plus the 40px toolbar, grows while typing and
      // shrinks back when the text is gone.
      const restingHeight = surface.getBoundingClientRect().height;
      const inputRowHeight = restingHeight - footer.getBoundingClientRect().height;
      expect(inputRowHeight, `resting input row height at ${width}px`).toBeLessThanOrEqual(64);
      expect(restingHeight, `resting composer height at ${width}px`).toBeLessThanOrEqual(80);
      await userEvent.click(page.getByTestId("composer-editor"));
      await userEvent.keyboard("one{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{/Shift}three");
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}four{Shift>}{Enter}{/Shift}five");
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}six");
      await vi.waitFor(() =>
        expect(surface.getBoundingClientRect().height).toBeGreaterThan(restingHeight + 60),
      );
      await userEvent.keyboard("{Control>}a{/Control}{Backspace}");
      await vi.waitFor(() =>
        expect(Math.abs(surface.getBoundingClientRect().height - restingHeight)).toBeLessThan(2),
      );

      // The card's footer never holds context or pickers, at any width.
      expect(footer.querySelectorAll("[data-composer-context-control]")).toHaveLength(0);
      expect(footer.querySelector("[data-chat-provider-model-picker]")).toBeNull();
      const trayNow = document.querySelector<HTMLElement>('[data-composer-context-tray="true"]')!;
      expect(trayNow).not.toBeNull();
      expect(trayNow.querySelector("[data-composer-context-control]")).not.toBeNull();
      // The row stays one line: no control wraps below another or leaves the row.
      expect(trayNow.getBoundingClientRect().height).toBeLessThanOrEqual(32);
      const trayBoxNow = trayNow.getBoundingClientRect();
      for (const control of trayNow.querySelectorAll<HTMLElement>("button")) {
        if (control.getClientRects().length === 0) continue;
        const box = control.getBoundingClientRect();
        expect(
          box.left,
          `${control.ariaLabel} clipped on the left at ${width}px`,
        ).toBeGreaterThanOrEqual(trayBoxNow.left - 1);
        expect(
          box.right,
          `${control.ariaLabel} clipped on the right at ${width}px`,
        ).toBeLessThanOrEqual(trayBoxNow.right + 1);
      }

      // Two rows at every width: the input alone on row 1, the toolbar under it.
      const editorTop = document
        .querySelector<HTMLElement>('[data-testid="composer-editor"]')!
        .getBoundingClientRect().top;
      const editorBottom = document
        .querySelector<HTMLElement>('[data-testid="composer-editor"]')!
        .getBoundingClientRect().bottom;
      const toolbarControls = [...footer.querySelectorAll<HTMLElement>("button")].filter(
        (control) =>
          control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden",
      );
      for (const control of toolbarControls) {
        expect(control.getBoundingClientRect().top).toBeGreaterThanOrEqual(editorBottom - 1);
        expect(control.getBoundingClientRect().top).toBeGreaterThan(editorTop);
      }
      // The model chip stays at every width: it names the model down to a 340px pane and is the
      // provider mark only below that.
      const modelChip = trayNow.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
      expect(modelChip).not.toBeNull();
      if (width >= 340) {
        expect(modelChip!.dataset.chatProviderModelPickerIconOnly).toBeUndefined();
        expect(
          modelChip!.querySelector<HTMLElement>("[data-chat-provider-model-picker-label]")!
            .textContent,
        ).not.toBe("");
      }
      // The workspace chip never repeats a segment ("Local · Local").
      const workspaceChip = trayNow.querySelector<HTMLElement>('[aria-label^="Workspace:"]');
      if (workspaceChip !== null) {
        // With no branch known the chip shows the checkout label and no branch icon.
        expect(workspaceChip.textContent?.trim()).toMatch(/^(Local|Worktree)$/);
        expect(workspaceChip.querySelector(".lucide-git-branch")).toBeNull();
        const segments = (workspaceChip.textContent ?? "")
          .split("·")
          .map((part) => part.trim())
          .filter(Boolean);
        expect(new Set(segments).size).toBe(segments.length);
      }
      // No control overlaps another, in the card or in the row under it.
      const rowControls = [...trayNow.querySelectorAll<HTMLElement>("button")].filter(
        (control) =>
          control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden",
      );
      for (const [index, first] of [...toolbarControls, ...rowControls].entries()) {
        for (const second of [...toolbarControls, ...rowControls].slice(index + 1)) {
          const a = first.getBoundingClientRect();
          const b = second.getBoundingClientRect();
          const overlaps =
            a.left < b.right - 1 &&
            b.left < a.right - 1 &&
            a.top < b.bottom - 1 &&
            b.top < a.bottom - 1;
          expect(overlaps, `${first.ariaLabel} overlaps ${second.ariaLabel} at ${width}px`).toBe(
            false,
          );
        }
      }

      const surfaceBox = surface.getBoundingClientRect();
      for (const button of footer.querySelectorAll<HTMLElement>("button")) {
        expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(surfaceBox.right + 1);
      }
      const sendRight = lastButton().getBoundingClientRect();
      expect(sendRight.right).toBeLessThanOrEqual(surfaceBox.right + 1);
      expect(sendRight.left).toBeGreaterThanOrEqual(surfaceBox.left);

      if (width < 520) {
        // The folded workspace chip keeps checkout, branch and access reachable.
        const chip = trayNow.querySelector<HTMLElement>('[aria-label^="Workspace:"]')!;
        expect(chip).not.toBeNull();
        await userEvent.click(chip);
        const panel = await vi.waitFor(() => {
          const found = document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
          expect(found).not.toBeNull();
          return found!;
        });
        expect(panel.querySelectorAll("[data-composer-context-control]").length).toBeGreaterThan(1);
        await userEvent.keyboard("{Escape}");
        await vi.waitFor(() =>
          expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull(),
        );
      }
    }
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it.each(["draft", "thread"] as const)(
  "keeps the caret line and the last line fully visible above the controls row while a long draft with headings grows in a %s composer",
  async (scene) => {
    const previousViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1440, 900);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(previousViewport.width, previousViewport.height),
    };
    using _environment = installFakeEnvironment(
      scene === "thread" ? [threadWithHistory("anatomy-caret", 2)] : [],
    );
    await using _app = scene === "thread" ? await bootThreadComposer() : await bootDraftComposer();

    // The editor and footer are read live: the composer may remount while the app settles.
    const editorNode = () =>
      document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    const footerNode = () =>
      document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]')!;
    await vi.waitFor(
      async () => {
        await userEvent.click(page.getByTestId("composer-editor"));
        expect(editorNode().contains(document.activeElement)).toBe(true);
      },
      { timeout: 10_000 },
    );
    // Headings are taller than a body line, so the draft's height is not a whole number of lines.
    const lines = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`);
    const SB = "{Shift>}{Enter}{/Shift}";
    await userEvent.keyboard(
      [
        ...lines.slice(0, 6),
        "## First heading",
        ...lines.slice(6, 12),
        "## Second heading",
        ...lines.slice(12, 14),
      ].join(SB),
    );

    // The draft outgrew the editor, so it scrolls.
    await vi.waitFor(() => expect(editorNode().textContent).toContain("line 14"));
    await vi.waitFor(() =>
      expect(editorNode().scrollHeight).toBeGreaterThan(editorNode().clientHeight + 1),
    );

    const caretLine = () => {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const rects = range ? [...range.getClientRects()] : [];
      const rect = rects.at(-1) ?? range?.getBoundingClientRect();
      if (rect && rect.height > 0) return rect;
      return editorNode().lastElementChild!.getBoundingClientRect();
    };
    const expectCaretInsideVisibleArea = () => {
      const caret = caretLine();
      const editorBox = editorNode().getBoundingClientRect();
      const footerBox = footerNode().getBoundingClientRect();
      expect(caret.bottom, "caret line sits above the editor's bottom edge").toBeLessThanOrEqual(
        editorBox.bottom + 0.5,
      );
      expect(caret.top, "caret line sits below the editor's top edge").toBeGreaterThanOrEqual(
        editorBox.top - 0.5,
      );
      expect(caret.bottom, "caret line sits above the controls row").toBeLessThanOrEqual(
        footerBox.top + 0.5,
      );
    };

    // Typing at the end: the caret line is the last line, whole.
    await vi.waitFor(expectCaretInsideVisibleArea);
    editorNode().scrollTop = editorNode().scrollHeight;
    await vi.waitFor(expectCaretInsideVisibleArea);

    // The last line is whole: its box ends above the controls row and inside the editor.
    const lastLine = editorNode().lastElementChild!.getBoundingClientRect();
    expect(lastLine.bottom).toBeLessThanOrEqual(footerNode().getBoundingClientRect().top + 0.5);
    expect(lastLine.bottom).toBeLessThanOrEqual(editorNode().getBoundingClientRect().bottom + 0.5);

    // Typing more lines keeps following the caret.
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}one more{Shift>}{Enter}{/Shift}and another");
    await vi.waitFor(expectCaretInsideVisibleArea);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

// Compact toolbar at a 370px pane, a 340px small pane and narrower: each chip shows
// its whole label or only its icon, and nothing overlaps.
it.each([342, 312, 280, 240])(
  "folds the compact toolbar's chips to whole labels or icons in a %ipx composer",
  async (width) => {
    const previousViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1440, 900);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(previousViewport.width, previousViewport.height),
    };
    using _environment = installFakeEnvironment([]);
    await using _app = await bootDraftComposer();

    const form = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLFormElement>('[data-chat-composer-form="true"]');
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 10_000 },
    );
    form.style.width = `${width}px`;
    form.style.maxWidth = "none";
    const surface = document.querySelector<HTMLElement>('[data-chat-composer-surface="true"]')!;
    await vi.waitFor(() =>
      expect(Math.abs(surface.getBoundingClientRect().width - width)).toBeLessThan(3),
    );
    const footer = document.querySelector<HTMLElement>('[data-composer-context-tray="true"]')!;
    const modelChip = await vi.waitFor(() => {
      const found = footer.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
      expect(found).not.toBeNull();
      return found!;
    });
    const workspaceChip = await vi.waitFor(() => {
      const found = footer.querySelector<HTMLElement>('[aria-label^="Workspace:"]');
      expect(found).not.toBeNull();
      return found!;
    });

    // Let the tier settle: nothing overflows the toolbar.
    const controls = footer.querySelector<HTMLElement>('[data-chat-composer-controls="footer"]')!;
    await vi.waitFor(
      () => expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth + 1),
      { timeout: 5_000 },
    );

    const isVisibleText = (node: HTMLElement) => {
      const box = node.getBoundingClientRect();
      return box.width > 1 && getComputedStyle(node).visibility !== "hidden";
    };
    // A label is whole (6+ characters, not cut) or absent; its chip then keeps an accessible name.
    const modelLabel = modelChip.querySelector<HTMLElement>(
      "[data-chat-provider-model-picker-label]",
    )!;
    if (isVisibleText(modelLabel)) {
      expect(modelLabel.textContent!.length).toBeGreaterThanOrEqual(6);
      expect(modelLabel.scrollWidth).toBeLessThanOrEqual(modelLabel.clientWidth + 1);
    } else {
      expect(modelChip.getAttribute("title")).toContain(modelLabel.textContent!);
    }
    const branchLabel = workspaceChip.querySelector<HTMLElement>("[data-composer-label]")!;
    if (isVisibleText(branchLabel)) {
      expect(branchLabel.textContent!.trim().length).toBeGreaterThanOrEqual(5);
      expect(branchLabel.scrollWidth).toBeLessThanOrEqual(branchLabel.clientWidth + 1);
    } else {
      expect(workspaceChip.getAttribute("title")).not.toBeNull();
    }
    // The branch label drops before the model label, so a visible branch label means a visible model.
    if (isVisibleText(branchLabel)) expect(isVisibleText(modelLabel)).toBe(true);
    if (width >= 342) expect(isVisibleText(modelLabel)).toBe(true);

    const surfaceBox = surface.getBoundingClientRect();
    const buttons = [...footer.querySelectorAll<HTMLElement>("button")].filter(
      (button) =>
        button.getClientRects().length > 0 && getComputedStyle(button).visibility !== "hidden",
    );
    for (const button of buttons) {
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(surfaceBox.right + 1);
    }
    for (const [index, first] of buttons.entries()) {
      for (const second of buttons.slice(index + 1)) {
        const a = first.getBoundingClientRect();
        const b = second.getBoundingClientRect();
        const overlaps =
          a.left < b.right - 1 &&
          b.left < a.right - 1 &&
          a.top < b.bottom - 1 &&
          b.top < a.bottom - 1;
        expect(overlaps, `${first.ariaLabel} overlaps ${second.ariaLabel} at ${width}px`).toBe(
          false,
        );
      }
    }
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it("labels the attach button 'Attach files' and draws it as a paperclip", async () => {
  await using _screen = await render(
    <TooltipProvider delay={0}>
      <ComposerAttachButton addComposerAttachments={async () => true} focusComposer={() => {}} />
    </TooltipProvider>,
    { router: false },
  );
  const button = page.getByRole("button", { name: "Attach files" }).element();
  expect(button.querySelector("svg.lucide-paperclip")).not.toBeNull();
  expect(button.querySelector("svg.lucide-plus")).toBeNull();
});
