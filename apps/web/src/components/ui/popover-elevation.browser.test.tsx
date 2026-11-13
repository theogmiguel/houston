import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { CommandDialog, CommandDialogPopup } from "./command-dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

function surface(slot: string) {
  const popup = document.querySelector<HTMLElement>(`[data-slot=${slot}]`);
  if (popup === null) throw new Error(`expected an open [data-slot=${slot}]`);
  const style = getComputedStyle(popup);
  return {
    boxShadow: style.boxShadow,
    borderTop: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
    borderRadius: style.borderTopLeftRadius,
    backgroundColor: style.backgroundColor,
  };
}

describe("popover elevation", () => {
  it("draws menus, popovers and the command palette with one shadow, border, radius and fill", async () => {
    let menu: ReturnType<typeof surface>;
    {
      await using _screen = await render(
        <Menu open>
          <MenuTrigger>Open menu</MenuTrigger>
          <MenuPopup>
            <MenuItem>Rename</MenuItem>
          </MenuPopup>
        </Menu>,
        { router: false },
      );
      menu = surface("menu-popup");
    }
    let popover: ReturnType<typeof surface>;
    {
      await using _screen = await render(
        <Popover open>
          <PopoverTrigger>Open popover</PopoverTrigger>
          <PopoverPopup>Details</PopoverPopup>
        </Popover>,
        { router: false },
      );
      popover = surface("popover-popup");
    }
    let palette: ReturnType<typeof surface>;
    {
      await using _screen = await render(
        <CommandDialog open>
          <CommandDialogPopup aria-label="Command palette">Palette</CommandDialogPopup>
        </CommandDialog>,
        { router: false },
      );
      palette = surface("command-dialog-popup");
    }

    expect(menu.boxShadow).not.toBe("none");
    expect(menu.borderTop).toMatch(/^1px solid /);
    expect(popover).toEqual(menu);
    expect(palette).toEqual(menu);
  });
});
