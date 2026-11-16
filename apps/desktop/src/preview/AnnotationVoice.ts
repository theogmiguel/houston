import { DesktopPreviewAnnotationVoiceEventSchema } from "@houston-app/contracts";
import type {
  DesktopPreviewAnnotationVoiceConfig,
  DesktopPreviewAnnotationVoiceEvent,
  DesktopPreviewAnnotationVoiceState,
} from "@houston-app/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeAnnotationVoiceEvent = Schema.decodeUnknownOption(
  DesktopPreviewAnnotationVoiceEventSchema,
);

/** Voice state reaches a guest only while its pick session, by id, still owns the tab. */
export function pickSessionOwnsVoiceState(
  sessions: ReadonlyMap<string, { readonly voiceSessionId?: string | undefined }>,
  state: Pick<DesktopPreviewAnnotationVoiceState, "tabId" | "sessionId">,
): boolean {
  return sessions.get(state.tabId)?.voiceSessionId === state.sessionId;
}

/** A guest event is forwarded to the renderer only when it decodes and carries this session's id. */
export function decodeOwnedVoiceEvent(
  value: unknown,
  voice: DesktopPreviewAnnotationVoiceConfig | undefined,
): DesktopPreviewAnnotationVoiceEvent | null {
  if (!voice) return null;
  const decoded = decodeAnnotationVoiceEvent(value);
  if (Option.isNone(decoded)) return null;
  return decoded.value.sessionId === voice.sessionId ? decoded.value : null;
}
