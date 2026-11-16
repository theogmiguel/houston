import type { ModelCapabilities, ProviderDriverKind } from "@houston-app/contracts";
import { resolveModelShortName } from "@houston-app/client-runtime/provider-clients";

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
  /** The catalog's declared traits, which the picker shows beside the model. */
  capabilities?: ModelCapabilities | null | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

// Model names are formatted per render; the bound sits above the sub-providers of a model catalog.
const QUALIFIER_CACHE_MAX = 256;
const qualifierPatterns = new Map<string, RegExp>();

function qualifierPattern(qualifier: string): RegExp {
  let pattern = qualifierPatterns.get(qualifier);
  if (pattern === undefined) {
    if (qualifierPatterns.size >= QUALIFIER_CACHE_MAX) qualifierPatterns.clear();
    pattern = new RegExp(`^${escapeRegExp(qualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
    qualifierPatterns.set(qualifier, pattern);
  }
  return pattern;
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  return value.replace(qualifierPattern(trimmedQualifier), "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(
  model: ModelEsque,
  driverKind: ProviderDriverKind | null | undefined,
): string {
  const shortName = resolveModelShortName(model, driverKind);
  return getDisplayModelName({ ...model, shortName }, { preferShortName: true });
}
