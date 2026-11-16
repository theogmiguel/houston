import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HOUSTON_TASK_SOURCE_LIMITS,
  HoustonTaskSourceCredentialSetInput,
  HoustonTaskSourceProvider,
  HoustonTaskSourceSettingsSetInput,
} from "./taskSources.ts";

const decodeProvider = Schema.decodeUnknownExit(HoustonTaskSourceProvider);
const decodeSet = Schema.decodeUnknownExit(HoustonTaskSourceSettingsSetInput);
// As the RPC decodes a request: from its JSON form.
const decodeCredential = Schema.decodeUnknownSync(
  Schema.toCodecJson(HoustonTaskSourceCredentialSetInput),
);

const TOKEN = "ntn_contract_token_5b0c1d";

describe("task source schemas bound their fields and redact the token", () => {
  it("decodes both providers and refuses slack", () => {
    expect(decodeProvider("github_issues")._tag).toBe("Success");
    expect(decodeProvider("notion")._tag).toBe("Success");
    expect(decodeProvider("slack")._tag).toBe("Failure");
  });

  it("a settings object with a field over its bound fails to decode", () => {
    const settings = { enabled: true, githubRepository: "octo-org/project", githubLabel: "import" };
    expect(decodeSet({ projectId: "p", provider: "github_issues", settings })._tag).toBe("Success");
    const long = "x".repeat(HOUSTON_TASK_SOURCE_LIMITS.fieldBytes + 1);
    expect(
      decodeSet({
        projectId: "p",
        provider: "github_issues",
        settings: { ...settings, githubLabel: long },
      })._tag,
    ).toBe("Failure");
    expect(
      decodeSet({
        projectId: "p",
        provider: "notion",
        settings: {
          enabled: false,
          notionActiveStatusValues: Array.from(
            { length: HOUSTON_TASK_SOURCE_LIMITS.listItems + 1 },
            () => "a",
          ),
        },
      })._tag,
    ).toBe("Failure");
  });

  it("the decoded credential.set payload prints the token as <redacted>", () => {
    const input = decodeCredential({ projectId: "p", provider: "notion", token: TOKEN });
    expect(Redacted.value(input.token)).toBe(TOKEN);
    expect(String(input.token)).toBe("<redacted>");
    expect(JSON.stringify(input)).not.toContain(TOKEN);
    expect(`${JSON.stringify(input.token)} ${String(input)}`).not.toContain(TOKEN);
  });
});
