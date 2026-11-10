import { useSyncExternalStore } from "react";

import { prefersReducedMotion, subscribeReducedMotion } from "../motion/registry";

export { prefersReducedMotion };

/**
 * Whether animations should not play, re-read when it changes: the Appearance
 * "Animations" setting is off or the system asks for reduced motion.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}
