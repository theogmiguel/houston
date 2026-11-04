const DIALOG_BACKDROP_BASE_CLASS =
  "fixed inset-0 z-50 transition-opacity duration-(--motion-modal-in) ease-standard data-ending-style:duration-(--motion-modal-out) data-ending-style:ease-exit data-ending-style:opacity-0 data-starting-style:opacity-0";

const DIALOG_BACKDROP_CLASS = `dialog-backdrop ${DIALOG_BACKDROP_BASE_CLASS}`;
const DIALOG_MEDIA_BACKDROP_CLASS = `${DIALOG_BACKDROP_BASE_CLASS} bg-black/75 backdrop-blur-none`;

const DIALOG_POPUP_BASE_CLASS =
  "-translate-y-[calc(1.25rem*var(--nested-dialogs))] relative flex min-h-0 w-full min-w-0 scale-[calc(1-0.1*var(--nested-dialogs))] flex-col opacity-[calc(1-0.1*var(--nested-dialogs))] outline-none transition-[scale,opacity,translate] duration-(--motion-modal-in) ease-standard data-ending-style:duration-(--motion-modal-out) data-ending-style:ease-exit data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-starting-style:translate-y-1 data-ending-style:opacity-0 data-starting-style:opacity-0 [-webkit-app-region:no-drag]";

const DIALOG_POPUP_CLASS = `dialog-glass ${DIALOG_POPUP_BASE_CLASS} rounded-[var(--r-dialog)] border`;
const DIALOG_MEDIA_POPUP_CLASS = `${DIALOG_POPUP_BASE_CLASS} max-h-[92vh] w-auto max-w-[92vw] overflow-visible rounded-none border border-transparent bg-transparent p-0 shadow-none`;

// The popup surface leads; its content follows once the surface is mostly there.
const DIALOG_CONTENT_ENTER_CLASS =
  "transition-opacity duration-(--motion-modal-in) ease-standard delay-(--motion-content-delay) in-[[data-starting-style]]:opacity-0";

const DIALOG_MOBILE_SHEET_CLASS =
  "max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))] max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4";

export {
  DIALOG_BACKDROP_CLASS,
  DIALOG_CONTENT_ENTER_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
};
