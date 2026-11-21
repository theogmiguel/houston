import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

/** Sets the interface language for one test and restores the defaults on dispose. */
function setLanguage(language: string): Disposable {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, language });
  return { [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS) };
}

function renderSend(hasSendableContent: boolean) {
  return render(
    <TooltipProvider delay={0}>
      <ComposerPrimaryActions
        compact={false}
        canOperateThread
        pendingAction={null}
        isRunning={false}
        canInterrupt={false}
        showPlanFollowUpPrompt={false}
        promptHasText={hasSendableContent}
        isSendBusy={false}
        sendDisabledReason={null}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent={hasSendableContent}
        onSubmitMessage={() => {}}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />
    </TooltipProvider>,
  );
}

function tokenColor(property: "backgroundColor" | "color", value: string) {
  const probe = document.createElement("span");
  document.body.append(probe);
  probe.style[property] = value;
  const resolved = getComputedStyle(probe)[property];
  probe.remove();
  return resolved;
}

function sendButtonStyle() {
  const button = page.getByRole("button", { name: "Submit message" }).element();
  const style = getComputedStyle(button);
  return { disabled: (button as HTMLButtonElement).disabled, style };
}

it("draws an empty composer's send button as an inert neutral control", async () => {
  await using _screen = await renderSend(false);
  const { disabled, style } = sendButtonStyle();
  expect(disabled).toBe(true);
  expect(style.opacity).toBe("1");
  expect(style.backgroundColor).toBe(tokenColor("backgroundColor", "var(--sel)"));
  expect(style.color).toBe(tokenColor("color", "var(--houston)"));
  expect(style.backgroundColor).not.toBe(tokenColor("backgroundColor", "var(--accent)"));
});

it("renders the send button with the full accent fill once there is content", async () => {
  await using _screen = await renderSend(true);
  const { disabled, style } = sendButtonStyle();
  expect(disabled).toBe(false);
  expect(style.opacity).toBe("1");

  expect(style.backgroundColor).toBe(tokenColor("backgroundColor", "var(--accent)"));
  expect(style.color).toBe(tokenColor("color", "var(--primary-foreground)"));
});

it("renders the idle-disabled send glyph at full opacity in the muted ink", async () => {
  await using _screen = await renderSend(false);
  const button = page.getByRole("button", { name: "Submit message" }).element();
  expect(Number(getComputedStyle(button.querySelector("svg")!).opacity)).toBe(1);
});

function renderStop(interruptPending: boolean, onInterrupt: () => void) {
  return render(
    <TooltipProvider delay={0}>
      <ComposerPrimaryActions
        compact={false}
        canOperateThread
        pendingAction={null}
        isRunning={false}
        runningStartedAt="2026-06-20T12:00:00.000Z"
        canInterrupt
        interruptPending={interruptPending}
        showPlanFollowUpPrompt={false}
        promptHasText={false}
        isSendBusy={false}
        sendDisabledReason={null}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent={false}
        onSubmitMessage={() => {}}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={onInterrupt}
        onImplementPlanInNewThread={() => {}}
      />
    </TooltipProvider>,
  );
}

it("marks the Stop control as stopping and ignores repeated clicks while pending", async () => {
  let interrupts = 0;
  await using _screen = await renderStop(true, () => {
    interrupts += 1;
  });
  const button = page.getByRole("button", { name: "Stopping…" });
  await expect.element(button).toBeDisabled();
  const element = button.element() as HTMLButtonElement;
  element.click();
  expect(interrupts).toBe(0);
});

it("sends one interrupt when the Stop control is not pending", async () => {
  let interrupts = 0;
  await using _screen = await renderStop(false, () => {
    interrupts += 1;
  });
  await page.getByRole("button", { name: "Stop generation · Running" }).click();
  expect(interrupts).toBe(1);
});

it("keeps the composer send action in English when the language is English", async () => {
  using _language = setLanguage("en");
  await using _screen = await renderSend(true);
  await expect.element(page.getByRole("button", { name: "Submit message" })).toBeVisible();
});

it("renders the composer send action in Brazilian Portuguese", async () => {
  using _language = setLanguage("pt-BR");
  await using _screen = await renderSend(true);
  await expect.element(page.getByRole("button", { name: "Enviar mensagem" })).toBeVisible();
});
