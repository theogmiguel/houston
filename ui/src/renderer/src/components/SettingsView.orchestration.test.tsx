// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SettingsView,
  type HostInfo,
  type OrchestrationStateView,
} from "./SettingsView";
import { setSettingsNavForTests } from "../settingsNav";
import { NOTIFY_KINDS_DEFAULT } from "../notifyPrefs";
import type { KeymapOverrides } from "../houston/client";

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ =
  "0.0.0-test";

function baseProps(): React.ComponentProps<typeof SettingsView> {
  return {
    update: null,
    onUpdateCheckNow: () => {},
    onUpdatePolicySet: () => {},
    onOpenExternal: () => {},
    usage: null,
    usageLoading: false,
    usageError: null,
    onUsageRequest: () => {},
    voiceSettings: null,
    voiceCloudKeyPresent: false,
    voiceKeyringError: null,
    voiceModels: [],
    voiceDevices: [],
    onVoiceSettingsSet: () => {},
    onVoiceKeySet: () => {},
    onVoiceKeyClear: () => {},
    onVoiceDevicesRefresh: () => {},
    onVoiceModelDownload: () => {},
    onVoiceModelDelete: () => {},
    onVoiceLevelMonitor: () => {},
    agentProfiles: null,
    onAgentProfileUpsert: () => {},
    onAgentProfileDelete: () => {},
    onAgentProfileSetActive: () => {},
    chromeTheme: "graphite",
    onChromeTheme: () => {},
    theme: "warm-espresso",
    fontSize: 14,
    onFontSize: () => {},
    fontMin: 8,
    fontMax: 24,
    fontDefault: 14,
    fontFamilyId: "nerd",
    shiftEnterNewline: true,
    openLinksInPane: false,
    notifyKinds: NOTIFY_KINDS_DEFAULT,
    onNotifyKinds: () => {},
    onOpenLinksInPane: () => {},
    onShiftEnterNewline: () => {},
    onFontFamilyId: () => {},
    uiZoom: 1,
    onUiZoom: () => {},
    zoomMin: 0.5,
    zoomMax: 2,
    zoomStep: 0.1,
    onTheme: () => {},
    shellIntegration: true,
    onShellIntegration: () => {},
    osc52: true,
    onOsc52: () => {},
    copyOnSelect: false,
    onCopyOnSelect: () => {},
    stripBoxGlyphs: true,
    onStripBoxGlyphs: () => {},
    orchestrationState: null,
    onOpenAcpPane: () => {},
    historyWorkspace: null,
    historyWorkspaceName: null,
    historyCount: null,
    onClearHistory: () => {},
    historyIgnoreGlobs: null,
    onHistoryIgnoreGlobsSet: () => {},
    onOpenLogsFolder: () => {},
    onContact: () => {},
    onOpenLicense: () => {},
    onRestoreBudgetSet: () => {},
    sessionPolicy: null,
    onSessionPolicy: () => {},
    orchestrationEnabled: true,
    onOrchestrationEnabled: () => {},
    onOrchestrationCapsSet: () => {},
    onMailboxRetentionSet: () => {},
    hostInfo: null,
    agentHooks: null,
    onOpenHooks: () => {},
    onAgentHooksSet: () => {},
    onAgentHooksRefresh: () => {},
    onRevealSessionDb: () => {},
    keymapOverrides: {} as KeymapOverrides,
    onKeymapOverrides: () => {},
    notifyEnabled: false,
    onNotifyEnabled: () => {},
    notifySound: true,
    onNotifySound: () => {},
    onNotifyPreview: () => {},
  };
}

function openOrchestration(_container: HTMLDivElement): void {
  act(() => setSettingsNavForTests({ section: "orchestration" }));
}

function hostInfoFixture(overrides: Partial<HostInfo> = {}): HostInfo {
  return {
    type: "host_info",
    channel: "dev",
    state_dir: "/home/t/.houston-dev",
    pid: 4242,
    port: 43153,
    protocol_version: 70,
    app_version: "0.0.0-test",
    build_commit: "abc1234",
    uptime_ms: 3_600_000,
    live_sessions: 3,
    restore_budget: 6,
    restore_deferred: 0,
    orchestration_depth_in_use: 1,
    orchestration_max_depth: 4,
    mailbox_files_on_disk: 0,
    mailbox_retention_hours: 24,
    command_history_ignore_glob_count: 0,
    session_db_bytes: 1024,
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function state(
  overrides: Partial<OrchestrationStateView>,
): OrchestrationStateView {
  return {
    caps: { max_live_children: 4, max_spawn_depth: 4 },
    enabled: true,
    acpAgents: [
      {
        slug: "acp-opencode",
        display_name: "opencode",
        command: "opencode acp",
        agent: "opencode",
      },
      {
        slug: "acp-omp",
        display_name: "omp",
        command: "omp acp",
        agent: "custom",
      },
    ],
    ...overrides,
  };
}

describe("Settings › Orchestration — the switch and the caps (v62 D3)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("settings-38/-39: the two caps are editable inputs, seeded from orchestration_state, never hardcoded", () => {
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          orchestrationState={state({
            caps: { max_live_children: 7, max_spawn_depth: 2 },
          })}
        />,
      );
    });
    openOrchestration(container);
    const children = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-orchestration-cap-children"]',
    );
    const depth = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-orchestration-cap-depth"]',
    );
    expect(children?.value).toBe("7");
    expect(depth?.value).toBe("2");
    expect(
      container.querySelector('[data-testid="settings-orchestration-caps"]'),
    ).toBeNull();
  });

  it("settings-38/-39: both caps land as ONE save, not two round trips", () => {
    const saved: Array<[number, number]> = [];
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          orchestrationState={state({
            caps: { max_live_children: 4, max_spawn_depth: 4 },
          })}
          onOrchestrationCapsSet={(children, depth) =>
            saved.push([children, depth])
          }
        />,
      );
    });
    openOrchestration(container);
    const children = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-orchestration-cap-children"]',
    )!;
    const depth = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-orchestration-cap-depth"]',
    )!;
    const save = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-orchestration-caps-save"]',
    )!;
    expect(save.disabled).toBe(true);
    setInputValue(children, "9");
    setInputValue(depth, "3");
    expect(save.disabled).toBe(false);
    expect(saved).toEqual([]);
    act(() => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(saved).toEqual([[9, 3]]);
  });

  it("settings-41: Mailbox retention commits on blur, seeded from host_info", () => {
    const committed: number[] = [];
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          orchestrationState={state({})}
          hostInfo={hostInfoFixture({ mailbox_retention_hours: 24 })}
          onMailboxRetentionSet={(h) => committed.push(h)}
        />,
      );
    });
    openOrchestration(container);
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-mailbox-retention"]',
    )!;
    expect(input.value).toBe("24");
    setInputValue(input, "48");
    act(() => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(committed).toEqual([48]);
  });

  it("the switch sends the clicked value and says what each state means", () => {
    const sent: boolean[] = [];
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          orchestrationState={state({})}
          orchestrationEnabled={false}
          onOrchestrationEnabled={(v) => sent.push(v)}
        />,
      );
    });
    openOrchestration(container);
    const master = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-orchestration-master"]',
    )!;
    expect(master.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("no agent may spawn");
    act(() => master.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(sent).toEqual([true]);
    expect(
      container.querySelector('[data-testid="settings-orchestration-consents"]'),
    ).toBeNull();
  });

  it("says it is still asking rather than claiming spawning is off", () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} orchestrationState={null} />);
    });
    openOrchestration(container);
    expect(container.textContent).toContain("Asking the daemon");
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(
      container.querySelector(
        '[data-testid="settings-orchestration-cap-children"]',
      ),
    ).toBeNull();
  });

});

describe("Settings › Orchestration — ACP panes (v62 #11)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function openButton(slug: string): HTMLButtonElement {
    const btn = container.querySelector<HTMLButtonElement>(
      `[data-testid="settings-acp-open-${slug}"]`,
    );
    if (!btn) throw new Error(`no Open-pane button for ${slug}`);
    return btn;
  }

  it("lists one row per wire roster entry, naming the argv that will run", () => {
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          orchestrationState={state({})}
          historyWorkspace="/tmp/alpha"
        />,
      );
    });
    openOrchestration(container);
    const roster = container.querySelector(
      '[data-testid="settings-acp-roster"]',
    );
    if (!roster) throw new Error("no ACP roster");
    const text = roster.textContent ?? "";
    expect(text).toContain("opencode acp");
    expect(text).toContain("omp acp");
    expect(text).toContain("opens as opencode");
    expect(text).toContain("opens as custom");
  });

  it("opens the clicked row, handing back the whole wire entry", () => {
    const opened: string[] = [];
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          orchestrationState={state({})}
          historyWorkspace="/tmp/alpha"
          onOpenAcpPane={(a) => opened.push(`${a.slug}:${a.agent}`)}
        />,
      );
    });
    openOrchestration(container);
    act(() => {
      openButton("acp-omp").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(opened).toEqual(["acp-omp:custom"]);
  });

  it("disables Open pane with a reason when no single workspace is selected", () => {
    const opened: string[] = [];
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          orchestrationState={state({})}
          historyWorkspace={null}
          onOpenAcpPane={(a) => opened.push(a.slug)}
        />,
      );
    });
    openOrchestration(container);
    const btn = openButton("acp-opencode");
    expect(btn.disabled).toBe(true);
    expect(btn.closest("[data-tooltip]")?.getAttribute("data-tooltip")).toContain(
      "Select a single workspace",
    );
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toEqual([]);
  });

  it("says so plainly when this build has no ACP agents at all", () => {
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          orchestrationState={state({ acpAgents: [] })}
          historyWorkspace="/tmp/alpha"
        />,
      );
    });
    openOrchestration(container);
    const roster = container.querySelector(
      '[data-testid="settings-acp-roster"]',
    );
    expect(roster?.textContent ?? "").toContain("No ACP agents");
  });
});
