import { describe, expect, it } from "@effect/vitest";

import { decodeOwnedVoiceEvent, pickSessionOwnsVoiceState } from "./AnnotationVoice.ts";

const state = { tabId: "tab_1", sessionId: "first" };

describe("pickSessionOwnsVoiceState", () => {
  it("accepts state only for the session that owns the tab", () => {
    const sessions = new Map([["tab_1", { voiceSessionId: "first" }]]);
    expect(pickSessionOwnsVoiceState(sessions, state)).toBe(true);
    expect(pickSessionOwnsVoiceState(sessions, { ...state, sessionId: "second" })).toBe(false);
    expect(pickSessionOwnsVoiceState(sessions, { ...state, tabId: "tab_2" })).toBe(false);
  });

  it("rejects state once the session is gone or never had voice", () => {
    expect(pickSessionOwnsVoiceState(new Map(), state)).toBe(false);
    expect(pickSessionOwnsVoiceState(new Map([["tab_1", {}]]), state)).toBe(false);
  });
});

describe("decodeOwnedVoiceEvent", () => {
  const voice = { sessionId: "first", shortcuts: [] };
  const event = { sessionId: "first", text: "hello", cursor: 5, action: "sync" };

  it("forwards a well-formed event of the owning session", () => {
    expect(decodeOwnedVoiceEvent(event, voice)).toEqual(event);
  });

  it("drops events of another session, malformed events and sessions without voice", () => {
    expect(decodeOwnedVoiceEvent({ ...event, sessionId: "other" }, voice)).toBeNull();
    expect(decodeOwnedVoiceEvent({ ...event, action: "bogus" }, voice)).toBeNull();
    expect(decodeOwnedVoiceEvent({ ...event, cursor: -1 }, voice)).toBeNull();
    expect(decodeOwnedVoiceEvent("nope", voice)).toBeNull();
    expect(decodeOwnedVoiceEvent(event, undefined)).toBeNull();
  });
});
