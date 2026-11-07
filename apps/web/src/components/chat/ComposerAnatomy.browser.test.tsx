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
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

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

    // Wide form: the checkout and branch sit in one context row, the first row inside the card's
    // border, never in a second band under it and never in the card's own toolbar.
    expect(document.querySelector('[data-slot="composer-context-strip"]')).toBeNull();
    expect(document.querySelector("[data-composer-context-tray]")).toBeNull();
    const row = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>('[data-composer-context-row="true"]');
        if (found?.querySelector("[data-composer-context-control]") == null) {
          throw new Error("context controls are not in the composer row yet");
        }
        return found;
      },
      { timeout: 10_000 },
    );
    const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]')!;
    expect(footer.querySelector("[data-composer-context-control]")).toBeNull();
    expect(footer.querySelector('[aria-label^="Workspace:"]')).toBeNull();
    const rowBox = row.getBoundingClientRect();
    const cardWithRow = card.getBoundingClientRect();
    // Inside the card's border, flush with its top, spanning its width, closed by a 1px divider.
    expect(card.contains(row)).toBe(true);
    expect(rowBox.top - cardWithRow.top).toBeLessThanOrEqual(2);
    expect(rowBox.left - cardWithRow.left).toBeLessThanOrEqual(2);
    expect(cardWithRow.right - rowBox.right).toBeLessThanOrEqual(2);
    expect(getComputedStyle(row).borderBottomWidth).toBe("1px");
    expect(getComputedStyle(row).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(row).flexWrap).not.toBe("wrap");
    // Nothing is pending, so the row has no changes summary, and access is not repeated here.
    expect(row.querySelector("[data-changed-files-bar]")).toBeNull();
    expect(row.querySelector('[aria-label^="Permissions:"]')).toBeNull();
    for (const control of row.querySelectorAll<HTMLElement>("[data-composer-context-control]")) {
      expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(rowBox.right + 1);
    }
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
      editorBox.top + parseFloat(editorStyle.paddingTop) - rowBox.bottom,
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
      const contextRowHeight =
        document
          .querySelector<HTMLElement>('[data-composer-context-row="true"]')
          ?.getBoundingClientRect().height ?? 0;
      const restingHeight = surface.getBoundingClientRect().height;
      const inputRowHeight =
        restingHeight - footer.getBoundingClientRect().height - contextRowHeight;
      expect(inputRowHeight, `resting input row height at ${width}px`).toBeLessThanOrEqual(64);
      expect(
        restingHeight - contextRowHeight,
        `resting composer height at ${width}px`,
      ).toBeLessThanOrEqual(80);
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

      const contextControls = [
        ...footer.querySelectorAll<HTMLElement>("[data-composer-context-control]"),
      ];
      const rowNow = document.querySelector<HTMLElement>('[data-composer-context-row="true"]');
      if (width >= 520) {
        // Wide form: the row holds the context; the body has no workspace chip.
        expect(rowNow).not.toBeNull();
        expect(contextControls).toHaveLength(0);
        expect(rowNow!.querySelector("[data-composer-context-control]")).not.toBeNull();
      } else {
        // Compact form: no row; one workspace chip folds checkout and branch.
        expect(rowNow).toBeNull();
        expect(contextControls.length).toBeLessThanOrEqual(2);
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
      const modelChip = footer.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
      expect(modelChip).not.toBeNull();
      if (width >= 340) {
        expect(modelChip!.dataset.chatProviderModelPickerIconOnly).toBeUndefined();
        expect(
          modelChip!.querySelector<HTMLElement>("[data-chat-provider-model-picker-label]")!
            .textContent,
        ).not.toBe("");
      }
      // The workspace chip never repeats a segment ("Local · Local").
      const workspaceChip = footer.querySelector<HTMLElement>('[aria-label^="Workspace:"]');
      if (workspaceChip !== null) {
        // With no branch known the chip shows the checkout label and no branch icon.
        expect(workspaceChip.textContent?.trim()).toMatch(/^(Local|Worktree)$/);
        expect(workspaceChip.querySelector(".lucide-git-branch")).toBeNull();
        // A 1px divider separates the model chip from the workspace group.
        expect(footer.querySelector("[data-composer-divider]")).not.toBeNull();
        const segments = (workspaceChip.textContent ?? "")
          .split("·")
          .map((part) => part.trim())
          .filter(Boolean);
        expect(new Set(segments).size).toBe(segments.length);
        // The chip is as wide as its content: no gap between its children beyond 6px.
        const parts = [...workspaceChip.children].map((child) => child.getBoundingClientRect());
        for (const [index, part] of parts.slice(1).entries()) {
          expect(
            part.left - parts[index]!.right,
            `chip gap ${index} at ${width}px`,
          ).toBeLessThanOrEqual(6);
        }
      }
      // No control overlaps another.
      for (const [index, first] of toolbarControls.entries()) {
        for (const second of toolbarControls.slice(index + 1)) {
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
        // The folded workspace chip keeps checkout and branch reachable.
        const chip = footer.querySelector<HTMLElement>('[aria-label^="Workspace:"]')!;
        expect(chip).not.toBeNull();
        await userEvent.click(chip);
        const panel = await vi.waitFor(() => {
          const found = document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
          expect(found).not.toBeNull();
          return found!;
        });
        expect(panel.querySelectorAll("[data-composer-context-control]").length).toBeGreaterThan(0);
        await userEvent.keyboard("{Escape}");
        await vi.waitFor(() =>
          expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull(),
        );
      }
    }
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
