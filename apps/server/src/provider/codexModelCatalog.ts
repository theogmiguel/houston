import type { ServerProviderUpdateRequiredModel } from "@houston-app/contracts";
import * as ModelCatalog from "@houston-app/provider-core/server/ModelCatalog";
import type { ServerProviderDraft } from "@houston-app/provider-core/server/snapshotProbe";
import { codexModelFamily } from "@houston-app/shared/model";
import { compareSemverVersions, parseSemver } from "@houston-app/shared/semver";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "@houston-app/contracts";

const CODEX_MATCHING: ModelCatalog.CatalogMatching = { family: codexModelFamily };

const CodexModelAdapter = Schema.Struct({
  codex: Schema.optional(Schema.Struct({ minVersion: Schema.optional(TrimmedNonEmptyString) })),
});
const decodeCodexModelAdapter = Schema.decodeUnknownOption(CodexModelAdapter);

const LEADING_V = /^v/;

/** Codex catalogs omit models released after the installed CLI. */
function codexUpdateRequiredModels(
  catalog: ModelCatalog.ProviderCatalog | undefined,
  draft: ServerProviderDraft,
): ReadonlyArray<ServerProviderUpdateRequiredModel> {
  const version = draft.version?.replace(LEADING_V, "");
  if (!catalog || !version || parseSemver(version) === null) return [];
  const discovered = new Set(draft.models.map((model) => codexModelFamily(model.slug)));
  return catalog.models.flatMap((entry) => {
    if (entry.status !== "current" || discovered.has(codexModelFamily(entry.slug))) return [];
    const minVersion = Option.getOrUndefined(decodeCodexModelAdapter(entry.adapter ?? {}))?.codex
      ?.minVersion;
    if (!minVersion || parseSemver(minVersion) === null) return [];
    if (compareSemverVersions(version, minVersion) >= 0) return [];
    return [
      {
        slug: entry.slug,
        name: entry.name,
        ...(entry.badge ? { badge: entry.badge } : {}),
        minVersion,
      },
    ];
  });
}

export function applyCodexModelCatalog(
  draft: ServerProviderDraft,
  catalog: ModelCatalog.ProviderCatalog | undefined,
): ServerProviderDraft {
  const updateRequiredModels = codexUpdateRequiredModels(catalog, draft);
  return {
    ...ModelCatalog.applyModelCatalog(draft, catalog, CODEX_MATCHING),
    ...(updateRequiredModels.length > 0 ? { updateRequiredModels } : {}),
  };
}
