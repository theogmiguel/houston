import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ProviderDriverKind, ProviderInstanceId } from "@houston-app/contracts";

import { render } from "../../test/render";
import type { SidebarProviderEntry } from "../components/sidebar/SidebarThreadRow";
import type { LayoutTab } from "./layoutModel";
import { ChatTabIcon, useLayoutTabLabel } from "./useLayoutTabLabel";

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

describe("chat tab icon", () => {
  const shell = {
    id: "t1",
    environmentId: "env-1",
    runtime: null,
    modelSelection: { instanceId: "claude", model: "claude-test" },
    providerInstanceHistory: [],
  } as unknown as EnvironmentThreadShell;
  const claude = {
    instanceId: ProviderInstanceId.make("claude"),
    driverKind: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    displayName: "Claude",
    accentColor: undefined,
    acpRegistryAgentId: undefined,
    acpRegistryIconUrl: undefined,
    models: [],
  } as unknown as SidebarProviderEntry;

  it("shows the thread's provider mark instead of the folder", async () => {
    await using screen = await render(
      <ChatTabIcon shell={shell} providerEntries={new Map([["claude", claude]])} />,
    );
    const icon = screen.container.querySelector<HTMLElement>("[data-chat-tab-icon]")!;
    expect(icon.querySelector('[data-provider-mark][aria-label="Claude"]')).not.toBeNull();
    const folder = icon.querySelector<SVGElement>("svg.lucide-folder")!;
    expect(getComputedStyle(folder).display).toBe("none");
  });

  it("keeps the folder for a draft and for a provider this client does not know", async () => {
    for (const [value, entries] of [
      [null, new Map([["claude", claude]])],
      [shell, new Map<string, SidebarProviderEntry>()],
    ] as const) {
      await using screen = await render(<ChatTabIcon shell={value} providerEntries={entries} />);
      const icon = screen.container.querySelector<HTMLElement>("[data-chat-tab-icon]")!;
      expect(icon.querySelector("[data-provider-mark]")).toBeNull();
      const folder = icon.querySelector<SVGElement>("svg.lucide-folder")!;
      expect(getComputedStyle(folder).display).not.toBe("none");
    }
  });
});
