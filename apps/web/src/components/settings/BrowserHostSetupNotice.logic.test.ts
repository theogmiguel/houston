import { describe, expect, it } from "vite-plus/test";
import { previewStreamHostSetupMessage } from "@houston-app/client-runtime/preview/server-browser-stream";

import { browserHostSetupBanner } from "./BrowserHostSetupNotice.logic";

const command = "sudo houston browser setup";

describe("browserHostSetupBanner", () => {
  it("names the sandbox setup and the server's command when the host blocks it", () => {
    expect(browserHostSetupBanner({ blocked: true, setupCommand: command })).toEqual({
      message: previewStreamHostSetupMessage({ need: "sandbox", command }),
      command,
    });
  });

  it("shows nothing when the host is unblocked or the state is not here yet", () => {
    expect(browserHostSetupBanner({ blocked: false, setupCommand: "" })).toBeNull();
    expect(browserHostSetupBanner(null)).toBeNull();
  });
});
