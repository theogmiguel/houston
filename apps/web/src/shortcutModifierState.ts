import { useState, useSyncExternalStore } from "react";
import { useStableCallback } from "./hooks/useStableCallback";
import { isEditableFocused } from "./lib/editableFocus";

export interface ShortcutModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const EMPTY_SHORTCUT_MODIFIER_STATE: ShortcutModifierState = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

function areShortcutModifierStatesEqual(
  left: ShortcutModifierState,
  right: ShortcutModifierState,
): boolean {
  return (
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  );
}

function createShortcutModifierStore(ignoreEditable: boolean) {
  let state = EMPTY_SHORTCUT_MODIFIER_STATE;
  const listeners = new Set<() => void>();
  let stopTracking: (() => void) | null = null;

  const updateState = (next: ShortcutModifierState) => {
    if (areShortcutModifierStatesEqual(state, next)) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const onKeyboardEvent = (event: KeyboardEvent) => {
    updateState(
      ignoreEditable && isEditableFocused(event.target)
        ? EMPTY_SHORTCUT_MODIFIER_STATE
        : shortcutModifierStateAfterKeyboardEvent(state, event),
    );
  };
  // Dictation tools can omit Meta keyup after synthetic paste, leaving jump hints stuck.
  const onResetEvent = () => {
    updateState(EMPTY_SHORTCUT_MODIFIER_STATE);
  };
  const onFocus = (event: FocusEvent) => {
    if (ignoreEditable && isEditableFocused(event.target)) onResetEvent();
  };
  const startTracking = () => {
    window.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKeyboardEvent, true);
    window.addEventListener("keyup", onKeyboardEvent, true);
    window.addEventListener("paste", onResetEvent, true);
    window.addEventListener("blur", onResetEvent);
    return () => {
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKeyboardEvent, true);
      window.removeEventListener("keyup", onKeyboardEvent, true);
      window.removeEventListener("paste", onResetEvent, true);
      window.removeEventListener("blur", onResetEvent);
      state = EMPTY_SHORTCUT_MODIFIER_STATE;
    };
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      stopTracking ??= startTracking();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopTracking?.();
        stopTracking = null;
      };
    },
    getSnapshot: () => state,
  };
}

// One tracker per editable policy, shared by every subscriber, so a held key is tracked once.
const shortcutModifierStore = createShortcutModifierStore(false);
const editableIgnoringShortcutModifierStore = createShortcutModifierStore(true);

/** Re-renders on every modifier change; prefer a selector or a hold hook for a large component. */
export function useShortcutModifierState(ignoreEditable = false): ShortcutModifierState {
  const store = ignoreEditable ? editableIgnoringShortcutModifierStore : shortcutModifierStore;
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Re-renders only when `select`, a pure read of the held modifiers returning a primitive, changes. */
export function useShortcutModifierSelector<T extends boolean | number | string | null>(
  select: (modifiers: ShortcutModifierState) => T,
): T {
  return useSyncExternalStore(
    shortcutModifierStore.subscribe,
    () => select(shortcutModifierStore.getSnapshot()),
    () => select(EMPTY_SHORTCUT_MODIFIER_STATE),
  );
}

/**
 * Whether `wanted` has held for `delayMs` without a break. The hold's timer lives in the
 * subscription, so the host renders when the answer flips and not on each modifier press: a
 * quick chord never renders it. `wanted` is read at press, release and expiry time.
 */
export function useHeldShortcutModifiers(
  wanted: (modifiers: ShortcutModifierState) => boolean,
  delayMs: number,
): boolean {
  const readWanted = useStableCallback(wanted);
  const [hold] = useState(() => {
    let held = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      subscribe: (notify: () => void) => {
        const settle = () => {
          if (!readWanted(shortcutModifierStore.getSnapshot())) {
            clearTimeout(timer);
            timer = undefined;
            if (held) {
              held = false;
              notify();
            }
            return;
          }
          if (held || timer !== undefined) return;
          timer = setTimeout(() => {
            timer = undefined;
            if (!readWanted(shortcutModifierStore.getSnapshot())) return;
            held = true;
            notify();
          }, delayMs);
        };
        const stop = shortcutModifierStore.subscribe(settle);
        settle();
        return () => {
          stop();
          clearTimeout(timer);
          timer = undefined;
          held = false;
        };
      },
      getSnapshot: () => held,
    };
  });
  return useSyncExternalStore(hold.subscribe, hold.getSnapshot, () => false);
}

function normalizeModifierKey(key: string): keyof ShortcutModifierState | null {
  switch (key) {
    case "Meta":
    case "OS":
    case "Command":
      return "metaKey";
    case "Control":
      return "ctrlKey";
    case "Alt":
    case "Option":
      return "altKey";
    case "Shift":
      return "shiftKey";
    default:
      return null;
  }
}

export function shortcutModifierStateAfterKeyboardEvent(
  currentState: ShortcutModifierState,
  event: KeyboardEvent,
): ShortcutModifierState {
  const normalizedModifierKey = normalizeModifierKey(event.key);
  let nextState: ShortcutModifierState;
  if (normalizedModifierKey) {
    nextState = {
      ...currentState,
      [normalizedModifierKey]: event.type === "keydown",
    };
  } else {
    // Dictation paste can poison real events with metaKey=true until a physical Meta press.
    nextState = {
      metaKey: currentState.metaKey && event.metaKey,
      ctrlKey: currentState.ctrlKey && event.ctrlKey,
      altKey: currentState.altKey && event.altKey,
      shiftKey: currentState.shiftKey && event.shiftKey,
    };
  }

  return areShortcutModifierStatesEqual(currentState, nextState) ? currentState : nextState;
}
