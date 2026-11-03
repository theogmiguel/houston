import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

function renderSendMenu(input: {
  readonly canSteer?: boolean;
  readonly followUpBehavior?: "queue" | "steer";
  readonly onSubmitWithMode?: (mode: "queue" | "steer" | "restart") => void;
}) {
  return render(
    <TooltipProvider delay={0}>
      <ComposerPrimaryActions
        compact={false}
        canOperateThread
        pendingAction={null}
        isRunning
        canInterrupt
        followUpBehavior={input.followUpBehavior ?? "steer"}
        canSteer={input.canSteer ?? true}
        showPlanFollowUpPrompt={false}
        promptHasText
        isSendBusy={false}
        sendDisabledReason={null}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent
        onSubmitMessage={() => {}}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
        onSubmitWithMode={input.onSubmitWithMode}
      />
    </TooltipProvider>,
  );
}

it("offers queue, steer and interrupt-and-send while a turn runs", async () => {
  const onSubmitWithMode = vi.fn<(mode: "queue" | "steer" | "restart") => void>();
  await using _screen = await renderSendMenu({ onSubmitWithMode });

  await userEvent.click(page.getByRole("button", { name: "Send options" }));
  await expect.element(page.getByRole("menuitem", { name: "Queue message" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Steer message" })).toBeVisible();

  await userEvent.click(page.getByRole("menuitem", { name: "Interrupt and send" }));
  expect(onSubmitWithMode).toHaveBeenCalledExactlyOnceWith("restart");
});

it("disables steering where the provider cannot steer, keeping interrupt available", async () => {
  const onSubmitWithMode = vi.fn<(mode: "queue" | "steer" | "restart") => void>();
  await using _screen = await renderSendMenu({ canSteer: false, onSubmitWithMode });

  await userEvent.click(page.getByRole("button", { name: "Send options" }));
  const steer = page.getByRole("menuitem", { name: "Steer message" });
  await expect.element(steer).toBeVisible();
  expect(steer.element().getAttribute("aria-disabled")).toBe("true");

  await userEvent.click(page.getByRole("menuitem", { name: "Interrupt and send" }));
  expect(onSubmitWithMode).toHaveBeenCalledExactlyOnceWith("restart");
});
