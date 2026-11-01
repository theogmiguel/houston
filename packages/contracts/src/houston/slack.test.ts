import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HOUSTON_SLACK_LIMITS,
  HoustonSlackConfigureInput,
  HoustonSlackConnectInput,
  HoustonSlackInfo,
  HoustonSlackLanguage,
  HoustonSlackRequest,
  HoustonSlackRequestState,
} from "./slack.ts";

const decodeLanguage = Schema.decodeUnknownExit(HoustonSlackLanguage);
const decodeState = Schema.decodeUnknownExit(HoustonSlackRequestState);
const decodeConfigure = Schema.decodeUnknownExit(HoustonSlackConfigureInput);
const decodeRequest = Schema.decodeUnknownExit(HoustonSlackRequest);
const decodeInfo = Schema.decodeUnknownExit(HoustonSlackInfo);
// As the RPC decodes a request: from its JSON form.
const decodeConnect = Schema.decodeUnknownSync(Schema.toCodecJson(HoustonSlackConnectInput));

const APP = "xapp-1-A0CONTRACT-contract-app-token";
const BOT = "xoxb-1-contract-bot-token-7e21";

const channels = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ channelId: `C${index + 10}`, projectId: "p" }));

describe("slack schemas bound their fields and redact the tokens", () => {
  it("decodes the languages and request states, and refuses pt_br", () => {
    expect(decodeLanguage("en")._tag).toBe("Success");
    expect(decodeLanguage("pt-BR")._tag).toBe("Success");
    expect(decodeLanguage("pt_br")._tag).toBe("Failure");
    for (const state of ["pending", "queued", "started", "refused", "closed"]) {
      expect(decodeState(state)._tag).toBe("Success");
    }
    expect(decodeState("accepted")._tag).toBe("Failure");
  });

  it("decodes channel and member ids; the info refuses 17 channels and a lowercase channel id", () => {
    expect(HOUSTON_SLACK_LIMITS.channels).toBe(16);
    const info = {
      enabled: true,
      hasTokens: true,
      connection: "connected",
      team: "Acme",
      botUserId: "UBOT",
      ownerUserId: "U123",
      channels: channels(16),
      language: "en",
      lastEventAt: null,
      lastCatchupAt: null,
      error: null,
      revision: 1,
    };
    expect(decodeInfo(info)._tag).toBe("Success");
    expect(decodeInfo({ ...info, channels: channels(17) })._tag).toBe("Failure");
    expect(decodeInfo({ ...info, channels: [{ channelId: "c123", projectId: "p" }] })._tag).toBe(
      "Failure",
    );
    const ok = { ownerUserId: "U123", channels: [{ channelId: "C1", projectId: "p" }] };
    expect(decodeConfigure(ok)._tag).toBe("Success");
    expect(decodeConfigure({ ...ok, channels: [{ channelId: "G2", projectId: "p" }] })._tag).toBe(
      "Success",
    );
    expect(decodeConfigure({ channels: channels(16) })._tag).toBe("Success");
    // The input carries no count or channel id bound: the service refuses those by name (AD-101).
    expect(decodeConfigure({ channels: channels(17) })._tag).toBe("Success");
    expect(decodeConfigure({ channels: [{ channelId: "c123", projectId: "p" }] })._tag).toBe(
      "Success",
    );
    expect(decodeConfigure({ channels: [], language: "pt_br" })._tag).toBe("Failure");
    expect(
      decodeRequest({
        taskId: 1,
        projectId: "p",
        author: "U2",
        channelId: "C1",
        state: "queued",
        queuePosition: 1,
        permalink: null,
        statusReaction: "eyes",
      })._tag,
    ).toBe("Success");
  });

  it("the decoded connect payload prints both tokens as <redacted>", () => {
    const input = decodeConnect({ appToken: APP, botToken: BOT });
    expect(input.appToken === undefined ? null : Redacted.value(input.appToken)).toBe(APP);
    expect(input.botToken === undefined ? null : Redacted.value(input.botToken)).toBe(BOT);
    expect(String(input.appToken)).toBe("<redacted>");
    expect(String(input.botToken)).toBe("<redacted>");
    const printed = `${JSON.stringify(input)} ${String(input)} ${JSON.stringify(input.botToken)}`;
    expect(printed).not.toContain(APP);
    expect(printed).not.toContain(BOT);
    expect(decodeConnect({}).appToken).toBeUndefined();
  });
});
