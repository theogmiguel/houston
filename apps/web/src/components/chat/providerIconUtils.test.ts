import { describe, expect, it } from "@effect/vitest";

import { getProviderRowLabel } from "./ModelListRow";
import { getDisplayModelName } from "./providerIconUtils";

describe("getDisplayModelName", () => {
  it("strips the sub-provider qualifier on every call", () => {
    const model = { slug: "m", name: "OpenRouter: GPT 5", subProvider: "OpenRouter" };
    expect(getDisplayModelName(model)).toBe("GPT 5");
    expect(getDisplayModelName(model)).toBe("GPT 5");
    expect(getDisplayModelName({ ...model, name: "openrouter / GPT 5" })).toBe("GPT 5");
  });

  it("matches a qualifier with regex characters literally", () => {
    expect(getDisplayModelName({ slug: "m", name: "A+B: Model", subProvider: "A+B" })).toBe(
      "Model",
    );
    expect(getDisplayModelName({ slug: "m", name: "AAB: Model", subProvider: "A+B" })).toBe(
      "AAB: Model",
    );
  });

  it("keeps the name when stripping would empty it", () => {
    expect(getDisplayModelName({ slug: "m", name: "Vendor", subProvider: "Vendor" })).toBe(
      "Vendor",
    );
  });
});

describe("getProviderRowLabel", () => {
  it("uses a sub-provider that already names the provider, on every call", () => {
    expect(getProviderRowLabel("Grok", "grok 4 fast")).toBe("grok 4 fast");
    expect(getProviderRowLabel("Grok", "grok 4 fast")).toBe("grok 4 fast");
    expect(getProviderRowLabel("Grok", "Fireworks")).toBe("Grok · Fireworks");
    expect(getProviderRowLabel("C++", "C++ Agent")).toBe("C++ Agent");
    expect(getProviderRowLabel("C++", "CC Agent")).toBe("C++ · CC Agent");
  });
});
