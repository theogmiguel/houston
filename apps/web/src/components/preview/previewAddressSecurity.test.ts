import { describe, expect, it } from "vite-plus/test";

import { previewAddressSecurity, previewAddressSecurityLabel } from "./previewAddressSecurity";

describe("preview address security", () => {
  it("labels https secure", () => {
    expect(previewAddressSecurity("https://example.com/path")).toBe("secure");
  });

  it("labels loopback http local", () => {
    expect(previewAddressSecurity("http://localhost:3000")).toBe("local");
    expect(previewAddressSecurity("http://127.0.0.1:5173")).toBe("local");
    expect(previewAddressSecurity("http://[::1]:8080")).toBe("local");
    expect(previewAddressSecurity("http://app.localhost")).toBe("local");
  });

  it("labels other http not secure", () => {
    expect(previewAddressSecurity("http://example.com")).toBe("not-secure");
  });

  it("has no label for empty or non-web URLs", () => {
    expect(previewAddressSecurity("")).toBeNull();
    expect(previewAddressSecurity("about:blank")).toBeNull();
    expect(previewAddressSecurity("not a url")).toBeNull();
  });

  it("renders sentence-case labels", () => {
    expect(previewAddressSecurityLabel("secure")).toBe("Secure");
    expect(previewAddressSecurityLabel("local")).toBe("Local");
    expect(previewAddressSecurityLabel("not-secure")).toBe("Not secure");
  });
});
