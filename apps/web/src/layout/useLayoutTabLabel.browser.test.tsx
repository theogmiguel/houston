import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import type { LayoutTab } from "./layoutModel";
import { useLayoutTabLabel } from "./useLayoutTabLabel";

function Icons({ tabs }: { readonly tabs: readonly LayoutTab[] }) {
  const labelOf = useLayoutTabLabel();
  return (
    <div>
      {tabs.map((tab) => (
        <span key={tab.id} data-tab={tab.id}>
          {labelOf(tab).icon}
        </span>
      ))}
    </div>
  );
}

const pageTab = (kind: "settings" | "usage" | "pull-requests"): LayoutTab => ({
  id: kind,
  content: { kind },
});

describe("page tab icons", () => {
  it("gives Settings, Usage and Pull requests each their own icon", async () => {
    await using screen = await render(
      <Icons tabs={[pageTab("settings"), pageTab("usage"), pageTab("pull-requests")]} />,
    );
    const iconOf = (id: string) =>
      screen.container.querySelector(`[data-tab="${id}"] svg`)?.getAttribute("class") ?? "";
    const icons = ["settings", "usage", "pull-requests"].map(iconOf);
    expect(new Set(icons).size, `icon classes: ${icons.join(" | ")}`).toBe(3);
    expect(iconOf("pull-requests")).toContain("pull-request");
  });
});
