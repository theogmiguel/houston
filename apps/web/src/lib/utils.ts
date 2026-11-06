import { MessageId, ProjectId, ThreadId } from "@houston-app/contracts";
import { isMacPlatform } from "@houston-app/shared/keybindings";
import { type CxOptions, cx } from "class-variance-authority";
import * as Hex from "effect/encoding/Hex";
import { extendTailwindMerge } from "tailwind-merge";
import { DraftId } from "../composerDraftStore";

const IS_WINDOWS_PLATFORM_PATTERN = /^win(dows)?/i;
const NORMALIZE_SEARCH_TEXT_PATTERN = /\p{M}/gu;
const WHITESPACE_RUN = /\s+/g;

// Register extra font sizes and background images so tailwind-merge does not
// treat text-2xs or bg-composer-seam-below as colors.
const twMerge = extendTailwindMerge({
  extend: {
    theme: { text: ["2xs", "3xs", "4xs", "5xs"] },
    classGroups: { "bg-image": [{ bg: ["composer-seam-below", "composer-seam-above"] }] },
  },
});

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export { isMacPlatform };

export function isWindowsPlatform(platform: string): boolean {
  return IS_WINDOWS_PLATFORM_PATTERN.test(platform);
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(NORMALIZE_SEARCH_TEXT_PATTERN, "")
    .toLowerCase()
    .replace(WHITESPACE_RUN, " ")
    .trim();
}

export function getLocalFileManagerName(platform: string): string {
  if (isMacPlatform(platform)) {
    return "Finder";
  }
  if (isWindowsPlatform(platform)) {
    return "File Explorer";
  }
  return "Files";
}

export function randomUUID(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Hex.encode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const newProjectId = (): ProjectId => ProjectId.make(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.make(randomUUID());

export const newDraftId = (): DraftId => DraftId.make(randomUUID());

export const newMessageId = (): MessageId => MessageId.make(randomUUID());
