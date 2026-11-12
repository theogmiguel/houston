import { LAYOUT_KEYBINDING_COMMANDS } from "@houston-app/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildLayoutPaletteItems, LAYOUT_ENTRIES } from "./layoutPaletteItems";
import { useLayoutStore } from "./layoutStore";

afterEach(() => {
  useLayoutStore.getState().setOverviewOpen(false);
});

describe("buildLayoutPaletteItems", () => {
  const [submenu, sheet] = buildLayoutPaletteItems();

  it("offers a Layout submenu and the shortcut sheet", () => {
    expect(submenu).toMatchObject({ kind: "submenu", title: "Layout…" });
    expect(sheet).toMatchObject({ kind: "action", shortcutCommand: "layout.shortcutSheet" });
  });

  it("gives every layout key except the sheet its own palette entry", () => {
    const commands = LAYOUT_ENTRIES.map((entry) => entry.command).toSorted();
    expect(commands).toEqual(
      LAYOUT_KEYBINDING_COMMANDS.filter((command) => command !== "layout.shortcutSheet").toSorted(),
    );
  });

  it("lists every workspace command: the scrolling strip needs no setting", () => {
    expect(
      submenu?.kind === "submenu" ? submenu.groups[0]?.items.map((item) => item.value) : [],
    ).toEqual(
      expect.arrayContaining([
        "action:layout.overview",
        "action:layout.focusWorkspaceDown",
        "action:layout.moveWorkspaceUp",
      ]),
    );
  });

  it("binds each entry to its command so the palette shows the key", () => {
    const items = submenu?.kind === "submenu" ? submenu.groups[0]!.items : [];
    for (const item of items) {
      expect(item).toMatchObject({ kind: "action" });
      expect(item.value).toBe(`action:${(item as { shortcutCommand?: string }).shortcutCommand}`);
    }
  });

  it("makes every entry findable by 'layout' and 'pane'", () => {
    const items = submenu?.kind === "submenu" ? submenu.groups[0]!.items : [];
    for (const item of items) {
      expect(item.searchTerms).toEqual(expect.arrayContaining(["layout", "pane"]));
    }
  });

  it("opens the overview from its palette entry", async () => {
    const items = submenu?.kind === "submenu" ? submenu.groups[0]!.items : [];
    const entry = items.find((item) => item.value === "action:layout.overview");
    expect(entry).toBeDefined();
    await (entry as { run: () => Promise<void> }).run();
    expect(useLayoutStore.getState().overviewOpen).toBe(true);
  });
});
