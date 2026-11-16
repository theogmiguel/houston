import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

const COMMIT_HASH = /^[0-9a-f]{7,64}$/i;

export function isCommitSha(value: string): boolean {
  return COMMIT_HASH.test(value);
}

/** Normalize host timestamps to UTC for cross-host string sorting. */
export function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });
}

const HEADS_REF_PREFIX = /^refs\/heads\//;

export function normalizeRefName(refName: string): string {
  return refName.trim().replace(HEADS_REF_PREFIX, "");
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}
