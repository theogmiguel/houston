import { scopeThreadRef, scopedThreadKey } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@houston-app/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@houston-app/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useRightPanelStore } from "../../rightPanelStore";
import { useRightPanelWindowShortcuts } from "./useRightPanelWindowShortcuts";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const mac = /mac/i.test(navigator.platform);

const MAXIMIZE_BINDINGS: ResolvedKeybindingsConfig = [
  {
    command: "rightPanel.toggleMaximized",
    shortcut: {
      key: "m",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      modKey: true,
    },
  },
];

function Host(props: {
  readonly ref: typeof threadRef | null;
  readonly keybindings?: ResolvedKeybindingsConfig;
  readonly onToggleThreadDetails: () => void;
  readonly onPanelClosed: () => void;
}) {
  useRightPanelWindowShortcuts({
    keybindings: props.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS,
    getThreadRef: () => props.ref,
    onToggleThreadDetails: props.onToggleThreadDetails,
    onPanelClosed: props.onPanelClosed,
  });
  return null;
}

function press(key: string, modifiers: Partial<KeyboardEventInit>) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: !mac,
    metaKey: mac,
    ...modifiers,
  });
  window.dispatchEvent(event);
  return event;
}

const panelOf = () => useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)];

function freshPanelStore() {
  useRightPanelStore.setState({ byThreadKey: {} });
  return { [Symbol.dispose]: () => useRightPanelStore.setState({ byThreadKey: {} }) };
}

describe("right panel window shortcuts", () => {
  it("closes the front thread's open panel and reports it", async () => {
    using _store = freshPanelStore();
    useRightPanelStore.getState().open(threadRef, "diff");
    expect(panelOf()?.isOpen).toBe(true);
    const onPanelClosed = vi.fn();
    await using _screen = await render(
      <Host ref={threadRef} onToggleThreadDetails={() => {}} onPanelClosed={onPanelClosed} />,
    );

    const event = press("b", { altKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(panelOf()?.isOpen).toBe(false);
    expect(onPanelClosed).toHaveBeenCalledTimes(1);
  });

  it("maximizes an open panel and ignores a closed one", async () => {
    using _store = freshPanelStore();
    await using _screen = await render(
      <Host
        ref={threadRef}
        keybindings={MAXIMIZE_BINDINGS}
        onToggleThreadDetails={() => {}}
        onPanelClosed={() => {}}
      />,
    );
    expect(press("m", { altKey: true }).defaultPrevented).toBe(false);

    useRightPanelStore.getState().open(threadRef, "diff");
    expect(press("m", { altKey: true }).defaultPrevented).toBe(true);
    expect(panelOf()?.maximized).toBe(true);
  });

  it("toggles the details card even when no thread is in front", async () => {
    using _store = freshPanelStore();
    const onToggleThreadDetails = vi.fn();
    await using _screen = await render(
      <Host ref={null} onToggleThreadDetails={onToggleThreadDetails} onPanelClosed={() => {}} />,
    );

    const event = press("b", { shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(onToggleThreadDetails).toHaveBeenCalledTimes(1);
  });

  it("leaves the panel chord alone when no thread is in front", async () => {
    using _store = freshPanelStore();
    await using _screen = await render(
      <Host ref={null} onToggleThreadDetails={() => {}} onPanelClosed={() => {}} />,
    );
    expect(press("b", { altKey: true }).defaultPrevented).toBe(false);
  });
});
