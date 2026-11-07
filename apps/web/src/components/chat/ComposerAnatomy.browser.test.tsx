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

/** Rasterises any CSS colour (including color-mix results) to opaque sRGB channels over `over`. */
function rasterColor(cssValue: string, over: string): [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = over;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = cssValue;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const luminance = (rgb: [number, number, number]) => {
    const [r, g, bl] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

it(
  "puts the context row under one composer card and starts with thread details closed",
  async () => {
    using _environment = installFakeEnvironment([]);
    await using _app = await bootDraftComposer();

    // The strip mounts once the environment connects and the project resolves.
    const strip = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>('[data-slot="composer-context-strip"]');
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 10_000 },
    );
    const card = document.querySelector<HTMLElement>("[data-chat-composer-main-surface]");
    expect(card).not.toBeNull();
    // The strip follows the card in the DOM and sits entirely below it, as plain text controls.
    expect(strip.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    const stripBox = strip.getBoundingClientRect();
    const cardBox = card!.getBoundingClientRect();
    expect(stripBox.top).toBeGreaterThanOrEqual(cardBox.bottom);
    expect(stripBox.left).toBeGreaterThanOrEqual(cardBox.left);
    expect(stripBox.right).toBeLessThanOrEqual(cardBox.right + 1);
    const stripStyle = getComputedStyle(strip);
    expect(stripStyle.borderTopWidth).toBe("0px");
    expect(stripStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(stripStyle.fontSize).toBe("12px");

    // Every control in the row is 12px sans in the muted label ink, readable against the canvas.
    const controls = [...strip.querySelectorAll<HTMLElement>("[data-composer-context-control]")];
    expect(controls.length).toBeGreaterThan(0);
    const canvasColor = resolveColor("var(--background)");
    for (const control of controls) {
      const style = getComputedStyle(control);
      expect(style.fontSize, control.textContent ?? "").toBe("12px");
      expect(style.color).toBe(resolveColor("var(--contrast-secondary-label)"));
      expect(
        contrastRatio(rasterColor(style.color, canvasColor), rasterColor(canvasColor, "#fff")),
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const label of strip.querySelectorAll<HTMLElement>("[data-composer-label] *")) {
      expect(getComputedStyle(label).fontFamily).not.toContain("JetBrains");
    }

    // The text sits well inside the card, and the resting input is a roomy 72px box.
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    const editorBox = editor.getBoundingClientRect();
    const editorStyle = getComputedStyle(editor);
    expect(
      editorBox.left + parseFloat(editorStyle.paddingLeft) - cardBox.left,
    ).toBeGreaterThanOrEqual(16);
    expect(editorBox.top + parseFloat(editorStyle.paddingTop) - cardBox.top).toBeGreaterThanOrEqual(
      10,
    );
    expect(editorBox.height).toBeGreaterThanOrEqual(72);

    // The details card opens only from its toggle or shortcut.
    expect(document.querySelector('[aria-label="Thread details"]')).toBeNull();

    const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
    expect(footer).not.toBeNull();
    expect(cardBox.top).toBeLessThanOrEqual(footer!.getBoundingClientRect().top);
    const lastButton = () => [...footer!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
    // The label reads "Environment disconnected" until the connection is up.
    await vi.waitFor(() => expect(lastButton().getAttribute("aria-label")).toBe("Submit message"), {
      timeout: 10_000,
    });
    // Nothing follows the primary action, and only one button submits.
    expect(footer!.querySelectorAll('button[type="submit"]')).toHaveLength(1);
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
    await expect.element(page.getByPlaceholder(/^Search .+ models$/)).toBeVisible();
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
