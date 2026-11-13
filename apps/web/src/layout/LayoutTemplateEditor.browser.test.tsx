import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";
import { LayoutTemplateEditor } from "./LayoutTemplateEditor";
import { DEFAULT_LAYOUT_TEMPLATE } from "./layoutSettings";
import { countLayoutTemplatePanes } from "./layoutTemplate";

describe("LayoutTemplateEditor", () => {
  it("adds a pane on the right when a chip is clicked", async () => {
    const onChange = vi.fn();
    await using _screen = await render(
      <LayoutTemplateEditor template={DEFAULT_LAYOUT_TEMPLATE} onChange={onChange} />,
    );
    await userEvent.click(page.getByRole("button", { name: "Files", exact: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0];
    expect(countLayoutTemplatePanes(next)).toBe(
      countLayoutTemplatePanes(DEFAULT_LAYOUT_TEMPLATE) + 1,
    );
    expect(next.columns.at(-1)?.panes[0]?.kind).toBe("files");
  });

  it("removes a pane from its popover and refuses to remove the only chat", async () => {
    const onChange = vi.fn();
    await using _screen = await render(
      <LayoutTemplateEditor template={DEFAULT_LAYOUT_TEMPLATE} onChange={onChange} />,
    );
    await userEvent.click(page.getByRole("button", { name: "Chat pane" }));
    await expect.element(page.getByRole("button", { name: /Remove pane/ })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Terminal pane" }));
    await userEvent.click(page.getByRole("button", { name: /Remove pane/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(countLayoutTemplatePanes(onChange.mock.calls[0]![0])).toBe(1);
  });
});
