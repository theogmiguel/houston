import { create } from "zustand";

/** Whether the "Use Houston in another app" wizard is open; kept apart so the root loads no wizard code. */
export const useInAnotherAppRequest = create<{ readonly open: boolean }>(() => ({ open: false }));

/** Opens the wizard for this device's primary environment. */
export function openUseInAnotherApp(): void {
  useInAnotherAppRequest.setState({ open: true });
}

export function closeUseInAnotherApp(): void {
  useInAnotherAppRequest.setState({ open: false });
}
