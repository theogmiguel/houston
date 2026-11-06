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

function sendButtonStyle() {
  const button = page.getByRole("button", { name: "Submit message" }).element();
  const style = getComputedStyle(button);
  return { disabled: (button as HTMLButtonElement).disabled, style };
}

function resolved(property: "backgroundColor" | "color", value: string) {
  const probe = document.createElement("span");
  document.body.append(probe);
  probe.style[property] = value;
  const result = getComputedStyle(probe)[property];
  probe.remove();
  return result;
}

it("fills an empty composer's send button neutral at full opacity, disabled with a not-allowed cursor", async () => {
  await using _screen = await renderSend(false);
  const { disabled, style } = sendButtonStyle();
  expect(disabled).toBe(true);
  expect(style.opacity).toBe("1");
  const wrapper = page.getByRole("button", { name: "Submit message" }).element().parentElement!;
  expect(getComputedStyle(wrapper).cursor).toBe("not-allowed");

  expect(style.backgroundColor).toBe(resolved("backgroundColor", "var(--secondary)"));
  expect(style.color).toBe(resolved("color", "var(--color-muted-foreground)"));
  expect(style.backgroundColor).not.toBe(resolved("backgroundColor", "var(--accent)"));
});

it("renders the send button with the full accent fill once there is content", async () => {
  await using _screen = await renderSend(true);
  const { disabled, style } = sendButtonStyle();
  expect(disabled).toBe(false);
  expect(style.opacity).toBe("1");

  const probe = document.createElement("span");
  document.body.append(probe);
  probe.style.backgroundColor = "var(--accent)";
  const accent = getComputedStyle(probe).backgroundColor;
  probe.remove();
  expect(style.backgroundColor).toBe(accent);
  expect(style.color).toBe(resolved("color", "var(--primary-foreground)"));
});
