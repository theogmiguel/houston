import { assert, describe, it } from "@effect/vitest";

import {
  renderUrlHandlerDesktopEntry,
  shouldRegisterUrlHandler,
} from "./DesktopLinuxUrlHandler.ts";

describe("URL scheme registration", () => {
  it("registers only on the installed release channel", () => {
    assert.isTrue(
      shouldRegisterUrlHandler({ platform: "linux", isDevelopment: false, channel: null }),
    );
    assert.isFalse(
      shouldRegisterUrlHandler({ platform: "linux", isDevelopment: true, channel: null }),
    );
    assert.isFalse(
      shouldRegisterUrlHandler({ platform: "linux", isDevelopment: false, channel: "dev" }),
    );
    assert.isFalse(
      shouldRegisterUrlHandler({ platform: "win32", isDevelopment: false, channel: null }),
    );
  });

  it("registers the release scheme and desktop entry", () => {
    const entry = renderUrlHandlerDesktopEntry({
      displayName: "Houston",
      execTarget: "/opt/houston/houston",
      scheme: "houston",
    });
    assert.include(entry, "MimeType=x-scheme-handler/houston;");
    assert.include(entry, "Exec=/opt/houston/houston %U");
  });
});
