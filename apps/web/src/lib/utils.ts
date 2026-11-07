import { MessageId, ProjectId, ThreadId } from "@houston-app/contracts";
import { isMacPlatform } from "@houston-app/shared/keybindings";
import { type CxOptions, cx } from "class-variance-authority";
import * as Hex from "effect/encoding/Hex";
import { extendTailwindMerge } from "tailwind-merge";
import { DraftId } from "../composerDraftStore";

// The default LRU holds 500 class lists (up to twice that). A few thousand keep a long thread
// view's lists across renders and thread opens. Its two generations keep up to 10,000 entries of
// list plus merged result: about 1-4 MB of one-byte strings at 50-200 characters per list.
export const TAILWIND_MERGE_CACHE_SIZE = 5000;

// Register extra font sizes and background images so tailwind-merge does not
// treat text-2xs or bg-composer-seam-below as colors.
const twMerge = extendTailwindMerge({
  cacheSize: TAILWIND_MERGE_CACHE_SIZE,
  extend: {
    theme: { text: ["2xs", "3xs", "4xs", "5xs"] },
    classGroups: { "bg-image": [{ bg: ["composer-seam-below", "composer-seam-above"] }] },
  },
});

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export { isMacPlatform };

const WINDOWS_PLATFORM = /^win(dows)?/i;

export function isWindowsPlatform(platform: string): boolean {
  return WINDOWS_PLATFORM.test(platform);
}

const COMBINING_MARK = /\p{M}/gu;
const WHITESPACE_RUNS = /\s+/g;

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(COMBINING_MARK, "")
    .toLowerCase()
    .replace(WHITESPACE_RUNS, " ")
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
