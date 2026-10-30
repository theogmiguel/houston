import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ unavailable: false }));

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () =>
    state.unavailable
      ? { _tag: "Failure", error: new Error("missing") }
      : {
          _tag: "Success",
          url: "about:blank",
          expiresAt: Date.now() + 60 * 60_000,
        },
}));
vi.mock(import("~/assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrlRefresh: () => async () => "about:blank",
}));

import { HtmlRenderFrame } from "./HtmlRenderFrame";

describe("HtmlRenderFrame", () => {
  it("shows the pane head and reports leaving full screen when it unmounts while expanded", async () => {
    const onFullscreenChange = vi.fn();
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
        onFullscreenChange={onFullscreenChange}
      />,
    );

    await expect.element(screen.getByText("Report.html")).toBeVisible();
    await expect.element(screen.getByText("Interactive")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(true);

    await screen.unmount();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
  });

  it("explains an unavailable page and keeps the pane head", async () => {
    state.unavailable = true;
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
      />,
    );

    await expect.element(screen.getByText("Page unavailable")).toBeVisible();
    await expect
      .element(screen.getByText("Reconnect to the environment and try again."))
      .toBeVisible();
    await expect.element(screen.getByText("Report.html")).toBeVisible();
    state.unavailable = false;
  });
});
