import {
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type ServerSettings,
  type SpeechPostProcessingOptions,
} from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import { resolveSpeechPostProcessingModelSelection } from "@houston-app/shared/serverSettings";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { buildTranscriptionPostProcessingPrompt } from "../textGeneration/TranscriptionPostProcessing.ts";
import { applySpeechAliases } from "./customWords.ts";

/**
 * Cleans a transcript with a text-generation provider. The request itself is the consent to send
 * the transcript there: the device decides, and the server holds no switch for it.
 */
export const postProcessTranscript = Effect.fn("speech.postProcessTranscript")(function* (input: {
  readonly transcript: string;
  readonly draft: {
    readonly text: string;
    readonly selection: { readonly start: number; readonly end: number };
  };
  readonly options: SpeechPostProcessingOptions;
  readonly cwd: string;
  readonly settings: ServerSettings;
}) {
  if (input.transcript.trim().length === 0) return input.transcript;
  const { mode, customInstructions } = input.options.speechPostProcessingPrompt;
  const instructions =
    (mode === "custom" ? customInstructions.trim() : "") || DEFAULT_SPEECH_POST_PROCESSING_PROMPT;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const providers = (yield* registry.getProviders).filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      provider.auth.status !== "unauthenticated" &&
      isProviderAvailable(provider) &&
      isProviderTextGenerationCapable(provider),
  );
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const modelSelection = resolveSpeechPostProcessingModelSelection(
    input.settings,
    providers,
    policy.providers.isDriverAllowed,
  );
  if (modelSelection === null) {
    return input.transcript;
  }
  const textGeneration = yield* TextGeneration.TextGeneration;
  const { prompt } = buildTranscriptionPostProcessingPrompt(
    instructions,
    input.transcript,
    input.draft,
    input.options.speechCorrectionWord,
  );
  const generated = yield* textGeneration.generateTranscriptionPostProcessing({
    cwd: input.cwd,
    prompt,
    modelSelection,
  });
  const text = generated.transcription.trim();
  return text.length > 0
    ? applySpeechAliases(text, input.options.speechCustomWords)
    : input.transcript;
});
