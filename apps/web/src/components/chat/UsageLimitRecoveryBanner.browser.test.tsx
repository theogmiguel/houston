import { RunId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { translate } from "~/i18n/translate";
import { render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const runId = RunId.make("run:banner-action");
const stoppedAt = new Date(2026, 9, 20, 12, 0);
const resetAt = new Date(2026, 9, 20, 14, 32);

function actions(onStartHeld: () => Promise<void> | void) {
  return usageLimitRecoveryBannerItem({
    runId,
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: null,
    recovery: { runId, resetAt: resetAt.toISOString(), autoResume: true },
    timestampFormat: "24-hour",
    heldStarts: 1,
    onStartHeld,
    translate: (source, params) => translate("en", source, params),
    onChange: async () => {},
  }).actions;
}

describe("usage limit banner held-starts action", () => {
  it("disables while starting and ignores a second click", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    const onStartHeld = vi.fn(() => new Promise<void>(() => {}));
    await page.viewport(1100, 300);
    await using screen = await render(<div>{actions(onStartHeld)}</div>);

    await screen.getByRole("button", { name: "Start held items" }).click();
    const starting = screen.getByRole("button", { name: "Starting…" });
    await expect.element(starting).toBeDisabled();
    (starting.element() as HTMLElement).click();
    expect(onStartHeld).toHaveBeenCalledTimes(1);
  });

  it("reports a failed start without an unhandled rejection", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    using toast = vi.spyOn(toastManager, "add");
    const onStartHeld = vi.fn(async () => {
      throw new Error("The server is unreachable.");
    });
    await page.viewport(1100, 300);
    await using screen = await render(<div>{actions(onStartHeld)}</div>);

    await screen.getByRole("button", { name: "Start held items" }).click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not start held items",
      description: "The server is unreachable.",
    });
    await expect.element(screen.getByRole("button", { name: "Start held items" })).toBeEnabled();
  });
});
