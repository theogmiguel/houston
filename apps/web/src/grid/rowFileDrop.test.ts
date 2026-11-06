import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planRowFileDrop } from "./rowFileDrop";

const file = (name: string, type: string, size = 10) =>
  new File([new Uint8Array(size)], name, { type });

describe("planRowFileDrop", () => {
  it("splits dropped files into images and other files", () => {
    const plan = planRowFileDrop([file("a.png", "image/png"), file("b.txt", "text/plain")], {
      fileLimitBytes: 1000,
      heldCount: 0,
    });
    expect(plan.images.map((f) => f.name)).toEqual(["a.png"]);
    expect(plan.files.map((f) => f.name)).toEqual(["b.txt"]);
    expect(plan.error).toBeNull();
  });

  it("refuses files when the environment takes none, naming the reason", () => {
    const plan = planRowFileDrop([file("b.txt", "text/plain")], {
      fileLimitBytes: null,
      heldCount: 0,
    });
    expect(plan.files).toEqual([]);
    expect(plan.error).toBe("This environment does not support file attachments.");
  });

  it("refuses an empty file and an oversized one by name and limit", () => {
    expect(
      planRowFileDrop([file("e.txt", "text/plain", 0)], { fileLimitBytes: 100, heldCount: 0 })
        .error,
    ).toBe("'e.txt' is empty or could not be read.");
    expect(
      planRowFileDrop([file("big.bin", "application/octet-stream", 2048)], {
        fileLimitBytes: 1024,
        heldCount: 0,
      }).error,
    ).toBe("'big.bin' exceeds the 1 KB attachment limit.");
  });

  it("refuses an unsupported image type", () => {
    const plan = planRowFileDrop([file("x.xyz", "image/xyz")], {
      fileLimitBytes: 100,
      heldCount: 0,
    });
    expect(plan.images).toEqual([]);
    expect(plan.error).toContain("'x.xyz' is not a supported image type");
  });

  it("stops at the attachment cap counting what the draft already holds", () => {
    const plan = planRowFileDrop([file("a.txt", "text/plain"), file("b.txt", "text/plain")], {
      fileLimitBytes: 100,
      heldCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });
    expect(plan.files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(plan.error).toContain(`up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments`);
  });
});
