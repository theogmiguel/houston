import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../test/render";
import {
  shortcutModifierStateAfterKeyboardEvent,
  useHeldShortcutModifiers,
  useShortcutModifierSelector,
  type ShortcutModifierState,
} from "./shortcutModifierState";

const emptyState = (): ShortcutModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

function keyboardEventLike(type: "keydown" | "keyup", init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type,
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("shortcutModifierState", () => {
  it("tracks bare modifier keydown and keyup events explicitly", () => {
    let state = emptyState();
    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Meta",
        metaKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Shift",
        metaKey: true,
        shiftKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Shift",
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
  });

  it("ignores poisoned modifier flags on non-modifier keys", () => {
    // Synthetic dictation paste can poison later real key events with metaKey=true.
    const state = shortcutModifierStateAfterKeyboardEvent(
      emptyState(),
      keyboardEventLike("keydown", { key: "Enter", metaKey: true }),
    );
    expect(state).toEqual(emptyState());
  });

  it("clears a held modifier when a non-modifier key reports it released", () => {
    const heldMeta: ShortcutModifierState = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const state = shortcutModifierStateAfterKeyboardEvent(
      heldMeta,
      keyboardEventLike("keydown", { key: "a", metaKey: false }),
    );
    expect(state).toEqual(emptyState());
  });
});

const HOLD_MS = 200;
const onHeldRender = vi.fn();
const onSelectedRender = vi.fn();

function HeldControl() {
  const shown = useHeldShortcutModifiers((modifiers) => modifiers.ctrlKey, HOLD_MS);
  onHeldRender();
  return createElement("output", null, shown ? "shown" : "hidden");
}

function ShiftOnly() {
  const shifted = useShortcutModifierSelector((modifiers) => modifiers.shiftKey);
  onSelectedRender();
  return createElement("output", null, shifted ? "shifted" : "plain");
}

const press = (type: "keydown" | "keyup", key: string) =>
  act(() => window.dispatchEvent(new KeyboardEvent(type, { key, ctrlKey: key === "Control" })));

describe("useHeldShortcutModifiers", () => {
  it("never renders its host for a chord released before the delay", async () => {
    await using screen = await render(createElement(HeldControl), {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    using _timers = fakeTimers();
    const settled = onHeldRender.mock.calls.length;
    await press("keydown", "Control");
    await act(() => vi.advanceTimersByTime(HOLD_MS - 1));
    await press("keyup", "Control");
    await act(() => vi.advanceTimersByTime(1_000));
    expect(onHeldRender.mock.calls.length).toBe(settled);
    await expect.element(screen.getByRole("status")).toHaveTextContent("hidden");
  });

  it("shows after the delay, hides on release and waits the delay again on a second hold", async () => {
    await using screen = await render(createElement(HeldControl), { router: false });
    using _timers = fakeTimers();
    const status = screen.getByRole("status");

    await press("keydown", "Control");
    await expect.element(status).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(HOLD_MS));
    await expect.element(status).toHaveTextContent("shown");

    await press("keyup", "Control");
    await expect.element(status).toHaveTextContent("hidden");

    await press("keydown", "Control");
    await expect.element(status).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(HOLD_MS));
    await expect.element(status).toHaveTextContent("shown");
  });
});

describe("useShortcutModifierSelector", () => {
  it("renders only when the selected value changes", async () => {
    await using screen = await render(createElement(ShiftOnly), { router: false });
    const settled = onSelectedRender.mock.calls.length;
    await press("keydown", "Control");
    await press("keyup", "Control");
    expect(onSelectedRender.mock.calls.length).toBe(settled);

    await act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true })),
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("shifted");
    expect(onSelectedRender.mock.calls.length).toBeGreaterThan(settled);
  });
});
