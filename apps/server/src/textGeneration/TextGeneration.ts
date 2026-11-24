import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@houston-app/contracts";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow } from "@houston-app/shared/usageLimits";
import {
  defaultTextGenerationModel,
  fallbackTextGenerationModelSelection,
  isImplicitTextGenerationSelection,
  localTextGenerationModelSelection,
} from "@houston-app/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderTextGeneration } from "@houston-app/provider-core/server/textGeneration";
import { TextGenerationError } from "@houston-app/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { orderProviderSnapshots } from "../provider/providerStatusCache.ts";
import type { ProviderInstance } from "@houston-app/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  TranscriptionPostProcessingInput,
  TranscriptionPostProcessingResult,
} from "@houston-app/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "@houston-app/cli/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateTranscriptionPostProcessing"
  | "generateReviewGuide";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    requested: ModelSelection,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const snapshots = orderProviderSnapshots(
      yield* registry.listInstances.pipe(
        Effect.flatMap((instances) =>
          Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
        ),
      ),
    );
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Could not read text generation settings.",
            cause,
          }),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const canRun = (provider: ServerProvider, model: string) =>
      provider.enabled &&
      resolveProjectProviderInstanceEnabled(settings, null, provider.instanceId) &&
      provider.installed &&
      provider.auth.status !== "unauthenticated" &&
      provider.status !== "error" &&
      isProviderAvailable(provider) &&
      isProviderTextGenerationCapable(provider) &&
      (operation !== "generateReviewGuide" || INVESTIGATING_DRIVERS.has(provider.driver)) &&
      !exhaustedUsageWindow(provider, now, model);
    // "Local models only" holds even before any instance is marked local.
    const localPolicy = settings.textGenerationFallback === "local";
    const noLocalModel = new TextGenerationError({
      operation,
      detail:
        operation === "generateReviewGuide"
          ? "Review guides need a Codex or Claude instance, and no local one is ready. Mark one as running local models, or allow any provider in Settings, Models."
          : "No local model is ready for background writing. Set up a local model, or allow any provider in Settings, Models.",
    });

    let selection = requested;
    if (isImplicitTextGenerationSelection(settings, selection)) {
      const local = localTextGenerationModelSelection(snapshots, (provider) =>
        canRun(provider, ""),
      );
      if (local !== null) selection = local;
      else if (localPolicy) return yield* noLocalModel;
    }

    const selected = snapshots.find((provider) => provider.instanceId === selection.instanceId);
    // Only a failed probe counts: a pending one is also not installed yet.
    const unusable =
      (selected?.enabled === true &&
        selected.status === "error" &&
        (!selected.installed || selected.auth.status === "unauthenticated")) ||
      (operation === "generateReviewGuide" &&
        selected !== undefined &&
        !INVESTIGATING_DRIVERS.has(selected.driver));
    if (unusable || exhaustedUsageWindow(selected, now, selection.model)) {
      const usableElsewhere = (provider: ServerProvider, model: string) =>
        provider.instanceId !== selection.instanceId && canRun(provider, model);
      const fallback =
        settings.textGenerationFallback === "none"
          ? null
          : (localTextGenerationModelSelection(snapshots, (provider) =>
              usableElsewhere(provider, ""),
            ) ??
            fallbackTextGenerationModelSelection(
              settings.providerInstances,
              (instanceId, driver) => {
                const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
                return (
                  provider !== undefined &&
                  usableElsewhere(provider, defaultTextGenerationModel(driver))
                );
              },
              { includeConfiguredInstances: true, policy: settings.textGenerationFallback },
            ));
      if (fallback !== null) selection = fallback;
      else if (localPolicy || operation === "generateReviewGuide") return yield* noLocalModel;
    }
    return yield* resolveInstance(registry, operation, selection.instanceId).pipe(
      Effect.flatMap((service) => invoke(service, selection)),
    );
  });
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate("generateCommitMessage", input.modelSelection, (service, modelSelection) =>
        service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate("generatePrContent", input.modelSelection, (service, modelSelection) =>
        service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate("generateBranchName", input.modelSelection, (service, modelSelection) =>
        service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateTranscriptionPostProcessing: Effect.fn(
      "TextGeneration.generateTranscriptionPostProcessing",
    )(function (input) {
      return generate(
        "generateTranscriptionPostProcessing",
        input.modelSelection,
        (service, modelSelection) =>
          service.generateTranscriptionPostProcessing({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate("generateReviewGuide", input.modelSelection, (service, modelSelection) =>
        service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make);
