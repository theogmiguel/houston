import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render as renderScreen } from "../../../test/render";

import { DiffViewControls } from "./diff-view-controls";
import { DropdownMenuItem } from "./menu";

// The default browser viewport is phone-sized; the cases below cover the desktop toolbar.
async function render(...args: Parameters<typeof renderScreen>) {
  await page.viewport(1280, 800);
  return renderScreen(...args);
}

function toolbar(width: string, props: ComponentProps<typeof DiffViewControls>) {
  return (
    <div className="@container/diff-toolbar" style={{ width }}>
      <DiffViewControls {...props} />
    </div>
  );
}

function props(): ComponentProps<typeof DiffViewControls> {
  return {
    diffLayout: "stacked",
    onDiffLayoutChange: () => {},
    wordWrap: true,
    onWordWrapChange: () => {},
    ignoreWhitespace: true,
    onIgnoreWhitespaceChange: () => {},
    hasFiles: true,
    fileTreeOpen: false,
    onFileTreeOpenChange: () => {},
    allFilesCollapsed: false,
    onToggleAllFiles: () => {},
    refresh: { refreshing: false, onRefresh: () => {} },
    testFileCount: 2,
    hideTestFiles: false,
    onHideTestFilesChange: () => {},
  };
}

describe("diff view controls", () => {
  it("keeps every control inline in a wide toolbar", async () => {
    const onDiffLayoutChange = vi.fn();
    const onWordWrapChange = vi.fn();
    const onIgnoreWhitespaceChange = vi.fn();
    const onHideTestFilesChange = vi.fn();
    const onFileTreeOpenChange = vi.fn();
    const onToggleAllFiles = vi.fn();
    await using screen = await render(
      toolbar("40rem", {
        ...props(),
        onDiffLayoutChange,
        onWordWrapChange,
        onIgnoreWhitespaceChange,
        onHideTestFilesChange,
        onFileTreeOpenChange,
        onToggleAllFiles,
      }),
      { router: false },
    );

    expect(screen.getByRole("button", { name: "Diff options" }).elements()).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Split diff view" }));
    expect(onDiffLayoutChange).toHaveBeenCalledWith("split");
    await userEvent.click(screen.getByRole("button", { name: "Disable diff line wrapping" }));
    expect(onWordWrapChange).toHaveBeenCalledWith(false);
    await userEvent.click(screen.getByRole("button", { name: "Show whitespace changes" }));
    expect(onIgnoreWhitespaceChange).toHaveBeenCalledWith(false);
    await userEvent.click(screen.getByRole("button", { name: "Hide test files" }));
    expect(onHideTestFilesChange).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Show file tree" }));
    expect(onFileTreeOpenChange).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Collapse all files" }));
    expect(onToggleAllFiles).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByRole("button", { name: "Refresh diff" })).toBeVisible();
  });

  it("folds the view controls into an overflow menu in a narrow toolbar", async () => {
    const onWordWrapChange = vi.fn();
    await using screen = await render(toolbar("20rem", { ...props(), onWordWrapChange }), {
      router: false,
    });

    await expect.element(screen.getByRole("button", { name: "Diff options" })).toBeVisible();
    // The layout toggle survives the narrowest width the panel still allows.
    await expect.element(screen.getByRole("button", { name: "Split diff view" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Disable diff line wrapping" }).elements(),
    ).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Diff options" }));
    await expect
      .element(page.getByRole("menuitemradio", { name: "Stacked view" }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Hide test files" }))
      .toBeVisible();
    await expect.element(page.getByRole("menuitemcheckbox", { name: "File tree" })).toBeVisible();
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Wrap lines" }));
    expect(onWordWrapChange).toHaveBeenCalledWith(false);
  });

  it("names the refresh in progress on the disabled menu row of a narrow toolbar", async () => {
    await using screen = await render(
      toolbar("20rem", { ...props(), refresh: { refreshing: true, onRefresh: () => {} } }),
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "Diff options" }));
    const row = page.getByRole("menuitem", { name: "Refreshing diff…" });
    await expect.element(row).toBeVisible();
    await expect.element(row).toHaveAttribute("aria-disabled", "true");
  });

  it("folds even the layout toggle below the narrowest breakpoint", async () => {
    await using screen = await render(toolbar("16rem", props()), { router: false });

    await expect.element(screen.getByRole("button", { name: "Diff options" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Split diff view" }).elements()).toHaveLength(0);
  });

  it("hosts the panel's own entries in the one overflow menu instead of a second one", async () => {
    const menuExtra = <DropdownMenuItem>Find in diff</DropdownMenuItem>;
    await using wide = await render(toolbar("40rem", { ...props(), menuExtra }), { router: false });

    expect(wide.getByRole("button", { name: "Diff options" }).elements()).toHaveLength(1);
    await userEvent.click(wide.getByRole("button", { name: "Diff options" }));
    await expect.element(page.getByRole("menuitem", { name: "Find in diff" })).toBeVisible();
    // Wide toolbars keep the view controls inline, so the menu holds only the host's entries.
    expect(page.getByRole("menuitemcheckbox", { name: "Wrap lines" }).elements()).toHaveLength(0);
  });

  it("adds the folded view controls above the host's entries in a narrow toolbar", async () => {
    const menuExtra = <DropdownMenuItem>Find in diff</DropdownMenuItem>;
    await using narrow = await render(toolbar("20rem", { ...props(), menuExtra }), {
      router: false,
    });

    expect(narrow.getByRole("button", { name: "Diff options" }).elements()).toHaveLength(1);
    await userEvent.click(narrow.getByRole("button", { name: "Diff options" }));
    await expect.element(page.getByRole("menuitemcheckbox", { name: "Wrap lines" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Find in diff" })).toBeVisible();
  });

  it("leaves the split layout toggle out on a phone, where side-by-side columns cannot fit", async () => {
    await page.viewport(390, 844);
    await using screen = await renderScreen(toolbar("40rem", props()), { router: false });

    expect(screen.getByRole("button", { name: "Split diff view" }).elements()).toHaveLength(0);
  });
});
