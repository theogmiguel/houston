import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const IS_COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const BRANCH_REF_PREFIX = /^refs\/heads\//;

export function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function isCommitSha(value: string): boolean {
  return IS_COMMIT_SHA_PATTERN.test(value);
}

/** Normalize host timestamps to UTC for cross-host string sorting. */
export function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });
}

export function normalizeRefName(refName: string): string {
  return refName.trim().replace(BRANCH_REF_PREFIX, "");
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}
