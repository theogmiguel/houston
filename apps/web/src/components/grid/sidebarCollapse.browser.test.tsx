import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  COLLAPSED_GRIDS_STORAGE_KEY,
  COLLAPSED_WORKSPACES_STORAGE_KEY,
  useCollapsedKeys,
} from "./sidebarCollapse";

function Probe({ storageKey, itemKey }: { storageKey: string; itemKey: string }) {
  const { collapsed, toggle } = useCollapsedKeys(storageKey);
  return (
    <button type="button" onClick={() => toggle(itemKey)}>
      {collapsed.has(itemKey) ? "collapsed" : "expanded"}
    </button>
  );
}

describe("useCollapsedKeys", () => {
  it.each([
    ["workspaces", COLLAPSED_WORKSPACES_STORAGE_KEY],
    ["grids", COLLAPSED_GRIDS_STORAGE_KEY],
  ])("remembers a collapsed %s key across a remount", async (_label, storageKey) => {
    localStorage.clear();
    await using first = await render(<Probe storageKey={storageKey} itemKey="section-a" />, {
      router: false,
    });

    await userEvent.click(first.getByRole("button", { name: "expanded" }));
    await expect.element(first.getByRole("button", { name: "collapsed" })).toBeVisible();
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toEqual(["section-a"]);

    await first.unmount();
    await using second = await render(<Probe storageKey={storageKey} itemKey="section-a" />, {
      router: false,
    });
    await expect.element(second.getByRole("button", { name: "collapsed" })).toBeVisible();

    await userEvent.click(second.getByRole("button", { name: "collapsed" }));
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toEqual([]);
  });
});
