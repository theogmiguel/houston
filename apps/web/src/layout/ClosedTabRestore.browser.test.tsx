import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";
import { useClosedViewStore } from "../closedViewStore";
import { toastManager } from "../components/ui/toast";
import { ClosedTabRestoreButton, reopenClosedTab } from "./ClosedTabRestore";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("t"));

/** Puts the stores in a known state for one test and restores them when the test ends. */
function openSession(): Disposable {
  useClosedViewStore.setState({ entries: [] });
  return {
    [Symbol.dispose]() {
      vi.restoreAllMocks();
      useClosedViewStore.setState({ entries: [] });
    },
  };
}

describe("ClosedTabRestoreButton", () => {
  it("explains that there is nothing to reopen and does not call the reopen", async () => {
    using _session = openSession();
    const add = vi.spyOn(toastManager, "add");
    const reopen = vi.fn(() => true);
    await using _screen = await render(<ClosedTabRestoreButton reopen={reopen} />);
    const button = page.getByRole("button", { name: "Reopen closed tab" });
    await expect.element(button).toHaveAttribute("aria-disabled", "true");
    // Playwright treats aria-disabled as unclickable; a person can still press it.
    (button.element() as HTMLButtonElement).click();
    expect(reopen).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "Nothing to reopen" }));
  });

  it("reopens when a tab was closed", async () => {
    using _session = openSession();
    useClosedViewStore.getState().remember({
      kind: "panel-tab",
      threadRef,
      surface: { kind: "diff", id: "diff" },
    });
    const reopen = vi.fn(() => true);
    await using _screen = await render(<ClosedTabRestoreButton reopen={reopen} />);
    const button = page.getByRole("button", { name: "Reopen closed tab" });
    await expect.element(button).not.toHaveAttribute("aria-disabled");
    await userEvent.click(button);
    expect(reopen).toHaveBeenCalledTimes(1);
  });
});

describe("reopenClosedTab", () => {
  it("reports a reopen that failed, with the reason when it threw", async () => {
    using _session = openSession();
    useClosedViewStore.getState().remember({
      kind: "panel-tab",
      threadRef,
      surface: { kind: "diff", id: "diff" },
    });
    const add = vi.spyOn(toastManager, "add");
    expect(await reopenClosedTab(() => false)).toBe(false);
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Could not reopen the tab" }),
    );
    expect(
      await reopenClosedTab(() => {
        throw new Error("the thread was deleted");
      }),
    ).toBe(false);
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "the thread was deleted" }),
    );
  });
});
