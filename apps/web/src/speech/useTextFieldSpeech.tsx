import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@houston-app/contracts";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import {
  ComposerSpeechMicButton,
  ComposerSpeechTray,
  ComposerSpeechUnavailableMic,
} from "~/components/chat/ComposerSpeechButton";
import { VoiceInputSetup } from "~/components/chat/VoiceInputSetup";
import { useProject } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useDictationShortcut } from "./useDictationShortcut";
import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";

/** Binds dictation to a plain textarea draft; the shortcut targets it only while it has focus. */
export function useTextFieldSpeech(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null | undefined;
  readonly ownerKey: string;
  readonly text: string;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly onTextChange: (text: string) => void;
  readonly disabled?: boolean | undefined;
}) {
  const latest = useRef(input);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- publishes committed field callbacks to the asynchronous recording controller
  useEffect(() => {
    latest.current = input;
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const project = useProject(
    input.projectId ? scopeProjectRef(input.environmentId, input.projectId) : null,
  );
  const speech = useEnvironmentSpeechInput({
    environmentId: input.environmentId,
    projectId: input.projectId,
    projectName: project?.title ?? null,
    ownerKey: input.ownerKey,
    draftText: input.text,
    disabled: input.disabled,
    readDraft: () => {
      const field = latest.current.textareaRef.current;
      const cursor = field?.selectionStart ?? latest.current.text.length;
      return {
        text: field?.value ?? latest.current.text,
        selection: { start: cursor, end: field?.selectionEnd ?? cursor },
      };
    },
    commitDraft: (text, selection) => {
      latest.current.onTextChange(text);
      window.requestAnimationFrame(() => {
        const field = latest.current.textareaRef.current;
        if (!field) return;
        field.focus({ preventScroll: true });
        field.setSelectionRange(selection.start, selection.end);
      });
    },
  });
  const shortcutLabel = useDictationShortcut({
    keybindings,
    speech,
    disabled: input.disabled ?? false,
    terminalOpen: false,
    modelPickerOpen: false,
    targetRef: input.textareaRef,
  });
  return { ...speech, shortcutLabel };
}

export type TextFieldSpeech = ReturnType<typeof useTextFieldSpeech>;

/** The live transcript and status, the mic and the setup dialog for one dictated field. */
export function TextFieldSpeechControls({
  speech,
  disabled = false,
}: {
  speech: TextFieldSpeech;
  disabled?: boolean;
}) {
  return (
    <>
      <ComposerSpeechTray
        className="w-full"
        state={speech.state}
        progress={speech.progress}
        level={speech.level}
        preview={speech.preview}
        onCancel={() => void speech.cancel()}
        onSkipPostProcessing={() => speech.skipPostProcessing()}
      />
      {speech.available ? (
        <ComposerSpeechMicButton
          state={speech.state}
          shortcutLabel={speech.shortcutLabel}
          disabled={disabled}
          onStart={() => void speech.start()}
          onStop={() => void speech.stop()}
          onCancel={() => void speech.cancel()}
        />
      ) : speech.unavailableReason ? (
        <ComposerSpeechUnavailableMic reason={speech.unavailableReason} />
      ) : null}
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        downloading={speech.setup.downloading}
        cancelled={speech.setup.cancelled}
        error={speech.setup.error}
        choosingDestination={speech.setup.choosingDestination}
        onChooseDestination={speech.setup.chooseDestination}
        onOpenChange={speech.setup.setOpen}
        onDownload={() => void speech.setup.download()}
        onCancelDownload={() => void speech.setup.cancelDownload()}
        onStartRecording={() => void speech.setup.startRecording()}
      />
    </>
  );
}

/** Render-prop form for editors that only sometimes have an environment to dictate on. */
export function SpeechTextField({
  children,
  ...input
}: Parameters<typeof useTextFieldSpeech>[0] & {
  children: (speech: TextFieldSpeech) => ReactNode;
}) {
  return children(useTextFieldSpeech(input));
}
