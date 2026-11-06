import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

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
