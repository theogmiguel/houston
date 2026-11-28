import { describe, expect, it } from "vite-plus/test";

import { oauthCallbackUrl, pastedUrl } from "./oauthCallback.ts";

const redirectUri = "http://127.0.0.1:54213/callback/abc";
const state = "state-value-0123456789";
const code = "SECRET-AUTH-CODE-9f3a";
const callbackUrl = `${redirectUri}?code=${code}&state=${state}`;

const messageOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
};

describe("oauthCallbackUrl", () => {
  it("accepts the redirect address with its state and one code", () => {
    expect(oauthCallbackUrl(callbackUrl, redirectUri, state).toString()).toBe(callbackUrl);
  });

  it("accepts one error in place of a code", () => {
    expect(() =>
      oauthCallbackUrl(`${redirectUri}?error=access_denied&state=${state}`, redirectUri, state),
    ).not.toThrow();
  });

  it("accepts an address copied without its scheme or with leading whitespace", () => {
    expect(
      oauthCallbackUrl(callbackUrl.slice("http://".length), redirectUri, state).toString(),
    ).toBe(callbackUrl);
    expect(oauthCallbackUrl(` \t\n${callbackUrl}`, redirectUri, state).toString()).toBe(
      callbackUrl,
    );
  });

  it.each([
    ["another state", `${redirectUri}?code=${code}&state=other-state-0123456789`],
    ["a missing state", `${redirectUri}?code=${code}`],
    ["a repeated state", `${callbackUrl}&state=${state}`],
    ["another host", callbackUrl.replace("127.0.0.1", "localhost")],
    ["another port", callbackUrl.replace("54213", "54214")],
    ["another path", callbackUrl.replace("/callback/abc", "/callback/xyz")],
    ["a fragment", `${callbackUrl}#frag`],
    ["credentials", callbackUrl.replace("http://", "http://user:pw@")],
    ["no code or error", `${redirectUri}?state=${state}`],
    ["a code and an error", `${callbackUrl}&error=denied`],
  ])("refuses %s", (_name, pasted) => {
    expect(() => oauthCallbackUrl(pasted, redirectUri, state)).toThrow();
  });

  it("refuses a value above 16384 characters", () => {
    expect(() =>
      oauthCallbackUrl(`${callbackUrl}&pad=${"x".repeat(16_400)}`, redirectUri, state),
    ).toThrow();
  });

  it("names the expected shape and never echoes the pasted code or state", () => {
    const wrongState = `${redirectUri}?code=${code}&state=attacker-state-0123456789`;
    const message = messageOf(() => oauthCallbackUrl(wrongState, redirectUri, state));
    expect(message).toContain("http://127.0.0.1:54213/callback/abc");
    expect(message).toContain("state");
    expect(message).not.toContain(code);
    expect(message).not.toContain("attacker-state");
    expect(message).not.toContain(state);
  });

  it("does not echo the pasted value when it is not a URL, and carries no cause", () => {
    const junk = `not a url ${code}`;
    const error = (() => {
      try {
        oauthCallbackUrl(junk, redirectUri, state);
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(error.message).not.toContain(code);
    expect(error.cause).toBeUndefined();
  });
});

describe("pastedUrl", () => {
  it("supplies the protocol a browser hid", () => {
    expect(pastedUrl("127.0.0.1:1/x").toString()).toBe("http://127.0.0.1:1/x");
  });
});
