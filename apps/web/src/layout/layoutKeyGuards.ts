/** Checks the layout's global keys and gestures make before acting, so a dialog or menu above keeps them. */

const MODAL_SELECTOR = '[data-slot="dialog-popup"], [data-slot="alert-dialog-popup"]';
const OPEN_LAYER_SELECTOR = `${MODAL_SELECTOR}, [data-slot="popover-popup"], [role="menu"], [role="listbox"]`;

/** A dialog is open: it owns the keyboard and the pointer. */
export function isLayoutModalOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(MODAL_SELECTOR) !== null;
}

/** The event came from inside a popover, menu or dialog drawn over the layout. */
export function isInOpenLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OPEN_LAYER_SELECTOR) !== null;
}

/** The first open popover, menu or dialog matching `selector`. */
export function findInOpenLayers(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

/** A popover above the overview, which keeps typing and Escape for itself. */
export function inPopoverAbove(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-slot="popover-popup"]') !== null;
}
