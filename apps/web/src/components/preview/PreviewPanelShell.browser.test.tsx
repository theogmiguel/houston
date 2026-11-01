import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { PreviewPanelShell } from "./PreviewPanelShell";

function inlineSize(setWidth: (width: number) => void): PreviewPanelInlineSize {
  return {
    width: 400,
    minWidth: 360,
    maxWidth: 700,
    setWidth,
    handlers: {
      ref: () => {},
      onPointerDown: () => {},
      onPointerMove: () => {},
      onPointerUp: () => {},
      onPointerCancel: () => {},
      onLostPointerCapture: () => {},
    },
    observeRow: () => () => {},
  };
}

it("exposes the panel resize handle and resizes it from the keyboard", async () => {
  const setWidth = vi.fn();
  await using screen = await render(
    <PreviewPanelShell mode="inline" open inlineSize={inlineSize(setWidth)}>
      <div />
    </PreviewPanelShell>,
  );

  const handle = screen.getByRole("separator", { name: "Resize panel" });
  await expect.element(handle).toHaveAttribute("aria-valuenow", "400");
  screen.container.querySelector<HTMLElement>('[aria-label="Resize panel"]')!.focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(setWidth).toHaveBeenLastCalledWith(416);
  await userEvent.keyboard("{ArrowRight}");
  expect(setWidth).toHaveBeenLastCalledWith(384);
  await userEvent.keyboard("{Home}");
  expect(setWidth).toHaveBeenLastCalledWith(360);
  await userEvent.keyboard("{End}");
  expect(setWidth).toHaveBeenLastCalledWith(700);
});
