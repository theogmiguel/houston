import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["t3code", "t3code-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it("keeps loopback web return destinations", () => {
    expect(
      providerAuthReturnUrl("http://127.0.0.1:5173/welcome?code=secret#agents:machine-id"),
    ).toBe("http://127.0.0.1:5173/welcome#agents:machine-id");
    expect(providerAuthReturnUrl("http://localhost:5173/settings/providers?code=secret")).toBe(
      "http://localhost:5173/settings/providers",
    );
  });
  it.each([
    "t3code://attacker/welcome",
    "t3code://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
