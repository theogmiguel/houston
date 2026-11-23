import { expect, it, vi } from "vite-plus/test";

import { observeSelectionActions } from "./selectionActions";

function resetDocument(): Disposable {
  return {
    [Symbol.dispose]() {
      window.getSelection()?.removeAllRanges();
      document.body.replaceChildren();
    },
  };
}

function observed(getActionElement: () => HTMLElement | null) {
  const element = document.createElement("p");
  element.textContent = "Selected answer text";
  document.body.append(element);
  const onSelection = vi.fn();
  const actions = observeSelectionActions({
    element,
    getActionElement,
    onSelection,
    onDismiss: vi.fn(),
  });
  const select = (start: number, end: number) => {
    const range = document.createRange();
    range.setStart(element.firstChild!, start);
    range.setEnd(element.firstChild!, end);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  };
  return {
    actions,
    select,
    onSelection,
    [Symbol.dispose]() {
      actions.dispose();
      resetDocument()[Symbol.dispose]();
    },
  };
}

it("schedules nothing when the caret moves while no actions are open", () => {
  using observation = observed(() => null);
  observation.select(3, 3);
  observation.actions.selectionChanged();
  expect(observation.actions.pending).toBe(false);
});

it("schedules the actions for a range selected while none are open", () => {
  using observation = observed(() => null);
  observation.select(0, 8);
  observation.actions.selectionChanged();
  expect(observation.actions.pending).toBe(true);
});

it("re-evaluates open actions when the selection collapses", () => {
  using _document = resetDocument();
  const toolbar = document.createElement("button");
  const element = document.createElement("p");
  element.textContent = "Selected answer text";
  document.body.append(element, toolbar);
  const actions = observeSelectionActions({
    element,
    getActionElement: () => toolbar,
    onSelection: vi.fn(),
    onDismiss: vi.fn(),
  });
  const range = document.createRange();
  range.setStart(element.firstChild!, 3);
  range.setEnd(element.firstChild!, 3);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  actions.selectionChanged();
  expect(actions.pending).toBe(true);
  actions.dispose();
});
