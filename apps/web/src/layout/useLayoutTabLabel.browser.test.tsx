import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ProviderDriverKind, ProviderInstanceId } from "@houston-app/contracts";

import { render } from "../../test/render";
import type { SidebarProviderEntry } from "../components/sidebar/SidebarThreadRow";
import { DraftId as DraftIdValue, useComposerDraftStore } from "../composerDraftStore";
import type { LayoutTab } from "./layoutModel";
import { ChatTabIcon, useLayoutTabLabel } from "./useLayoutTabLabel";

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () =>
    [
      { environmentId: "env-1", id: "p-notes", title: "notes-app", archivedAt: null },
      {
        environmentId: "env-1",
        id: "p-scratch",
        title: "No project",
        archivedAt: null,
        isScratch: true,
      },
    ] as never,
}));

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

const pageTab = (kind: "pull-requests" | "tasks"): LayoutTab => ({
  id: kind,
  content: { kind },
});

describe("page tab icons", () => {
  it("gives Pull requests and Tasks each their own icon", async () => {
    await using screen = await render(
      <Icons tabs={[pageTab("pull-requests"), pageTab("tasks")]} />,
    );
    const iconOf = (id: string) =>
      screen.container.querySelector(`[data-tab="${id}"] svg`)?.getAttribute("class") ?? "";
    const icons = ["pull-requests", "tasks"].map(iconOf);
    expect(new Set(icons).size, `icon classes: ${icons.join(" | ")}`).toBe(2);
    expect(iconOf("pull-requests")).toContain("pull-request");
  });
});

describe("chat tab icon", () => {
  const shell = {
    id: "t1",
    environmentId: "env-1",
    runtime: null,
    latestRun: { runId: "run-1" },
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

  it("shows the provider mark of a thread that has run", async () => {
    await using screen = await render(
      <ChatTabIcon shell={shell} providerEntries={new Map([["claude", claude]])} />,
    );
    const icon = screen.container.querySelector<HTMLElement>("[data-chat-tab-icon]")!;
    expect(icon.querySelector('[data-provider-mark][aria-label="Claude"]')).not.toBeNull();
    const folder = icon.querySelector<SVGElement>("svg.lucide-square-pen")!;
    expect(getComputedStyle(folder).display).toBe("none");
  });

  it("shows the new-thread glyph for a draft, a thread that has not run and an unknown provider", async () => {
    const unsent = { ...shell, latestRun: null } as EnvironmentThreadShell;
    for (const [value, entries] of [
      [null, new Map([["claude", claude]])],
      [unsent, new Map([["claude", claude]])],
      [shell, new Map<string, SidebarProviderEntry>()],
    ] as const) {
      await using screen = await render(<ChatTabIcon shell={value} providerEntries={entries} />);
      const icon = screen.container.querySelector<HTMLElement>("[data-chat-tab-icon]")!;
      expect(icon.querySelector("[data-provider-mark]")).toBeNull();
      const folder = icon.querySelector<SVGElement>("svg.lucide-square-pen")!;
      expect(getComputedStyle(folder).display).not.toBe("none");
    }
  });
});

describe("chat tab title", () => {
  const draftSession = (projectId: string, threadId: string) =>
    ({
      environmentId: "env-1",
      projectId,
      threadId,
      logicalProjectKey: `env-1:${projectId}`,
      createdAt: "2026-11-19T00:00:00.000Z",
      runtimeMode: "default",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
    }) as never;
  const draftTab = (draftId: string): LayoutTab => ({
    id: `chat:${draftId}`,
    content: { kind: "chat", target: { kind: "draft", draftId: DraftIdValue.make(draftId) } },
  });
  function Labels({ tabs }: { readonly tabs: readonly LayoutTab[] }) {
    const labelOf = useLayoutTabLabel();
    return (
      <div>
        {tabs.map((tab) => {
          const label = labelOf(tab);
          return (
            <span key={tab.id} data-title={tab.id} data-tooltip={label.tooltip ?? ""}>
              {label.title}
            </span>
          );
        })}
      </div>
    );
  }

  it("names the draft's project in the tab and its tooltip", async () => {
    using _restore = {
      [Symbol.dispose]: () => useComposerDraftStore.setState({ draftThreadsByThreadKey: {} }),
    };
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: { "draft-notes": draftSession("p-notes", "thread-notes") },
    });
    await using screen = await render(<Labels tabs={[draftTab("draft-notes")]} />);
    const title = screen.container.querySelector<HTMLElement>('[data-title="chat:draft-notes"]')!;
    expect(title.textContent).toBe("New thread · notes-app");
    expect(title.dataset.tooltip).toBe("New thread · notes-app");
  });

  it("keeps a scratch draft's tab titled New thread", async () => {
    using _restore = {
      [Symbol.dispose]: () => useComposerDraftStore.setState({ draftThreadsByThreadKey: {} }),
    };
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: { "draft-scratch": draftSession("p-scratch", "thread-scratch") },
    });
    await using screen = await render(<Labels tabs={[draftTab("draft-scratch")]} />);
    const title = screen.container.querySelector<HTMLElement>('[data-title="chat:draft-scratch"]')!;
    expect(title.textContent).toBe("New thread");
    expect(title.dataset.tooltip).toBe("");
  });
});
