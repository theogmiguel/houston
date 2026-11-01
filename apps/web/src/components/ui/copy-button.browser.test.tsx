import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { CopyButton } from "./copy-button";

describe("CopyButton", () => {
  it("copies the value, announces Copied, and clears the announcement", async () => {
    using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await using screen = await render(
      <CopyButton label="Copy message" timeout={50} value="hello" />,
      { router: false },
    );
    const status = screen.getByRole("status");

    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("hello"));
    await expect.element(status).toHaveTextContent("Copied");
    await vi.waitFor(() => expect(status.element().textContent).toBe(""));
  });

  it("copies text resolved only when the button is pressed", async () => {
    using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const getValue = vi.fn().mockResolvedValue("lazy text");
    await using screen = await render(<CopyButton getValue={getValue} label="Copy contents" />, {
      router: false,
    });

    await userEvent.click(screen.getByRole("button", { name: "Copy contents" }));

    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("lazy text"));
    expect(getValue).toHaveBeenCalledOnce();
  });

  it("reports a clipboard failure instead of announcing a copy", async () => {
    using write = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const onError = vi.fn();
    await using screen = await render(
      <CopyButton label="Copy message" onError={onError} value="hello" />,
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]![0].message).toBe("Failed to copy text to the clipboard.");
    expect(write).toHaveBeenCalledWith("hello");
    expect(screen.getByRole("status").element().textContent).toBe("");
  });
});
