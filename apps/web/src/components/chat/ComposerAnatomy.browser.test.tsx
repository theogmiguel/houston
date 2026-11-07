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

    // One anatomy: the workspace, branch and access chips live in the composer's own toolbar,
    // never in a second band under the card.
    expect(document.querySelector('[data-slot="composer-context-strip"]')).toBeNull();
    const footer = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
        if (found?.querySelector("[data-composer-context-control]") == null) {
          throw new Error("context controls are not in the composer footer yet");
        }
        return found;
      },
      { timeout: 10_000 },
    );
    expect(footer.getBoundingClientRect().top).toBeLessThan(cardBox.bottom);
    const contextControls = [
      ...footer.querySelectorAll<HTMLElement>("[data-composer-context-control]"),
    ];
    expect(contextControls.length).toBeGreaterThan(0);
    for (const control of contextControls) {
      expect(card.contains(control)).toBe(true);
      expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(cardBox.right + 1);
    }

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
    expect(editorBox.top + parseFloat(editorStyle.paddingTop) - cardBox.top).toBeGreaterThanOrEqual(
      10,
    );
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

      const contextControls = [
        ...footer.querySelectorAll<HTMLElement>("[data-composer-context-control]"),
      ];
      // Below 520 the workspace, branch and access controls fold into one chip.
      if (width < 520) expect(contextControls.length).toBeLessThanOrEqual(2);

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
      // The model chip stays at every width; below 380px it is the provider mark only.
      const modelChip = footer.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
      expect(modelChip).not.toBeNull();
      if (width < 380) {
        await vi.waitFor(() =>
          expect(modelChip!.dataset.chatProviderModelPickerIconOnly).toBe("true"),
        );
        expect(modelChip!.getAttribute("title") ?? "").not.toBe("");
      }
      // The workspace chip never repeats a segment ("Local · Local").
      const workspaceChip = footer.querySelector<HTMLElement>('[aria-label^="Workspace:"]');
      if (workspaceChip !== null) {
        const segments = (workspaceChip.textContent ?? "")
          .split("·")
          .map((part) => part.trim())
          .filter(Boolean);
        expect(new Set(segments).size).toBe(segments.length);
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
        // The folded workspace chip keeps checkout, branch and access reachable.
        const chip = footer.querySelector<HTMLElement>('[aria-label^="Workspace:"]')!;
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
