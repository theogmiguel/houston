import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandDialog, CommandDialogPopup } from "./ui/command-dialog";
import { CommandItem, CommandList } from "./ui/command";

function SubmenuPalette() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandDialogPopup aria-label="Command palette">
          <CommandPaletteContent
            items={["Project A"]}
            inputProps={{
              placeholder: "Search projects",
              startAddon: (
                <button type="button" aria-label="Back">
                  Back
                </button>
              ),
            }}
          >
            <CommandList>
              {(item: string) => <CommandItem value={item}>{item}</CommandItem>}
            </CommandList>
          </CommandPaletteContent>
        </CommandDialogPopup>
      </CommandDialog>
    </>
  );
}

describe("CommandPaletteContent", () => {
  it("focuses the search input, not the Back button, when it opens into a submenu", async () => {
    await using _screen = await render(<SubmenuPalette />);

    await userEvent.click(page.getByRole("button", { name: "Open" }));

    await expect.element(page.getByPlaceholder("Search projects")).toHaveFocus();
  });

  it("paints the highlighted row with the selection token, instantly", async () => {
    await using screen = await render(
      <CommandDialog open>
        <CommandDialogPopup aria-label="Command palette">
          <CommandPaletteContent items={["Project A"]} inputProps={{ placeholder: "Search" }}>
            <CommandList>
              {(item: string) => (
                <CommandItem value={item} active>
                  {item}
                </CommandItem>
              )}
            </CommandList>
          </CommandPaletteContent>
        </CommandDialogPopup>
      </CommandDialog>,
    );
    const row = screen.getByText("Project A").element().closest<HTMLElement>("[data-active]")!;
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--sel)";
    document.body.append(probe);
    const selection = getComputedStyle(probe).backgroundColor;
    probe.remove();

    expect(getComputedStyle(row).backgroundColor).toBe(selection);
    expect(getComputedStyle(row).transitionDuration).toBe("0s");
  });
});
