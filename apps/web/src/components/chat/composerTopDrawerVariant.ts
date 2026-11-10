import type { ComposerBannerVariant } from "./ComposerBanner";

/**
 * A pending question asks for an answer and keeps the warning tint; a finished plan is not a
 * warning, so its drawer stays neutral.
 */
export function composerTopDrawerVariant(input: {
  hasPendingUserInput: boolean;
}): ComposerBannerVariant {
  return input.hasPendingUserInput ? "warning" : "default";
}
