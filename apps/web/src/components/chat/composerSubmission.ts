import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@houston-app/contracts";
import { expandAssistantCitationsForProvider } from "@houston-app/shared/assistantCitations";

import { parseShellCommand } from "../../composer-logic";

type ComposerSubmitEvent = { preventDefault: () => void };

type ComposerSubmissionInput = {
  prompt: string;
  providerInput?: string;
  submissionTarget: "provider-turn" | "pending-user-input";
};

export function getComposerPromptLengthValidationMessage(prompt: string): string | null {
  const normalizedPrompt = prompt.trim();
  const inputLength = Math.max(
    normalizedPrompt.length,
    expandAssistantCitationsForProvider(normalizedPrompt).length,
  );
  const excessCharacters = inputLength - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;

  const characterLabel = excessCharacters === 1 ? "character" : "characters";
  return `Prompt is ${excessCharacters.toLocaleString("en-US")} ${characterLabel} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Shorten or split it before sending.`;
}

export function getComposerSubmissionValidationMessage(
  options: ComposerSubmissionInput,
): string | null {
  return options.submissionTarget === "provider-turn"
    ? getComposerPromptLengthValidationMessage(options.providerInput ?? options.prompt)
    : null;
}

export interface ComposerShellCommandSubmission {
  readonly prompt: string;
  /** An open question or a literal pending answer owns the draft. */
  readonly blocked: boolean;
  /** Absent when the thread has no terminal; the submission then reports `onUnavailable`. */
  readonly runShellCommand?: ((command: string) => void) | undefined;
  readonly onUnavailable?: (() => void) | undefined;
}

/**
 * Routes a `!command` submission to the terminal instead of the agent. Returns true when this
 * path handled the submission, so the caller must not send the draft as a message.
 */
export function dispatchShellCommandSubmission(options: ComposerShellCommandSubmission): boolean {
  const parsed = options.blocked ? null : parseShellCommand(options.prompt);
  if (!parsed) return false;
  if (options.runShellCommand) {
    options.runShellCommand(parsed.command);
  } else {
    options.onUnavailable?.();
  }
  return true;
}

export function submitComposerDraft(
  options: ComposerSubmissionInput & {
    event: ComposerSubmitEvent | undefined;
    onSend: (event?: ComposerSubmitEvent) => boolean | void;
  },
): { validationMessage: string | null; didDispatch: boolean } {
  const validationMessage = getComposerSubmissionValidationMessage(options);
  if (validationMessage) {
    options.event?.preventDefault();
    return { validationMessage, didDispatch: false };
  }

  if (options.onSend(options.event) === false) {
    options.event?.preventDefault();
    return { validationMessage: null, didDispatch: false };
  }
  return { validationMessage: null, didDispatch: true };
}
