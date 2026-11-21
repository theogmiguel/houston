import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { INLINE_EDIT_COUNTER_LEAD, InlineEditField } from "./inline-edit-field";

function field(
  overrides: Partial<Parameters<typeof InlineEditField>[0]> = {},
): Parameters<typeof InlineEditField>[0] {
  return {
    initialValue: "Houston Dev",
    label: "Rename workspace",
    scale: "heading",
    onCommit: () => null,
    onCancel: () => {},
    ...overrides,
  };
}

describe("InlineEditField", () => {
  it("selects the whole value when it takes focus", async () => {
    await using screen = await render(<InlineEditField {...field()} />, { router: false });
    const input = screen.getByRole("textbox", { name: "Rename workspace" }).element();
    await expect
      .poll(() => [
        (input as HTMLInputElement).selectionStart,
        (input as HTMLInputElement).selectionEnd,
      ])
      .toEqual([0, 11]);
  });

  it("commits the trimmed value once on Enter, even though Enter blurs the input", async () => {
    const onCommit = vi.fn(() => null);
    const onCancel = vi.fn();
    await using screen = await render(<InlineEditField {...field({ onCommit, onCancel })} />, {
      router: false,
    });
    const input = screen.getByRole("textbox").element() as HTMLInputElement;
    await userEvent.fill(input, "  Review  ");
    await userEvent.keyboard("{Enter}");
    input.blur();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Review");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("commits an unchanged value on Enter so a default name can be accepted as is", async () => {
    const onCommit = vi.fn(() => null);
    await using screen = await render(<InlineEditField {...field({ onCommit })} />, {
      router: false,
    });
    await expect.element(screen.getByRole("textbox")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Houston Dev");
  });

  it("cancels on Escape and does not commit when the blur that follows arrives", async () => {
    // Regression: the phone bar's field committed on the blur after Escape.
    const onCommit = vi.fn(() => null);
    const onCancel = vi.fn();
    await using screen = await render(<InlineEditField {...field({ onCommit, onCancel })} />, {
      router: false,
    });
    const input = screen.getByRole("textbox").element() as HTMLInputElement;
    await userEvent.fill(input, "Changed");
    await userEvent.keyboard("{Escape}");
    input.blur();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits on blur and cancels an empty value on blur", async () => {
    const onCommit = vi.fn(() => null);
    const onCancel = vi.fn();
    {
      await using screen = await render(<InlineEditField {...field({ onCommit })} />, {
        router: false,
      });
      const input = screen.getByRole("textbox").element() as HTMLInputElement;
      await userEvent.fill(input, "Blurred");
      input.blur();
      expect(onCommit).toHaveBeenCalledExactlyOnceWith("Blurred");
    }
    {
      await using screen = await render(<InlineEditField {...field({ onCommit, onCancel })} />, {
        router: false,
      });
      const input = screen.getByRole("textbox").element() as HTMLInputElement;
      await userEvent.fill(input, "   ");
      input.blur();
      expect(onCancel).toHaveBeenCalledOnce();
      expect(onCommit).toHaveBeenCalledOnce();
    }
  });

  it("refuses an empty value on Enter with the given message and keeps editing", async () => {
    const onCommit = vi.fn(() => null);
    await using screen = await render(
      <InlineEditField {...field({ onCommit, emptyMessage: "A name cannot be empty." })} />,
      { router: false },
    );
    const input = screen.getByRole("textbox");
    await userEvent.fill(input.element(), "  ");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("A name cannot be empty.");
    expect(input.element().getAttribute("aria-invalid")).toBe("true");
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.type(input.element(), "x");
    expect(screen.container.querySelector("[role='alert']")).toBeNull();
  });

  it("shows a refusal from the save inline, keeps the typed text and stays open", async () => {
    const onCommit = vi.fn((value: string) =>
      value === "Taken" ? "A workspace named 'Taken' already exists." : null,
    );
    const onCancel = vi.fn();
    await using screen = await render(<InlineEditField {...field({ onCommit, onCancel })} />, {
      router: false,
    });
    const input = screen.getByRole("textbox").element() as HTMLInputElement;
    await userEvent.fill(input, "Taken");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("alert").element().textContent).toContain("'Taken' already exists");
    expect(input.value).toBe("Taken");
    expect(document.activeElement).toBe(input);

    input.blur();
    expect(onCancel).not.toHaveBeenCalled();

    input.focus();
    await userEvent.fill(input, "Free");
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenLastCalledWith("Free");
  });

  it("counts characters only near the limit and refuses past it, naming the limit and the length", async () => {
    const onCommit = vi.fn(() => null);
    await using screen = await render(<InlineEditField {...field({ onCommit, maxChars: 20 })} />, {
      router: false,
    });
    const input = screen.getByRole("textbox").element() as HTMLInputElement;
    expect(screen.container.querySelector("[data-inline-edit-counter]")).toBeNull();

    await userEvent.fill(input, "x".repeat(20 - INLINE_EDIT_COUNTER_LEAD));
    await expect
      .element(screen.container.querySelector("[data-inline-edit-counter]") as HTMLElement)
      .toHaveTextContent(`${20 - INLINE_EDIT_COUNTER_LEAD}/20`);

    await userEvent.fill(input, "x".repeat(23));
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("alert").element().textContent).toContain("at most 20 characters");
    expect(screen.getByRole("alert").element().textContent).toContain("23");
    await userEvent.keyboard("{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("shows the hint until a message replaces it", async () => {
    await using screen = await render(
      <InlineEditField {...field({ hint: "Enter saves · Esc undoes", emptyMessage: "Empty." })} />,
      { router: false },
    );
    await expect
      .element(screen.container.querySelector("[data-inline-edit-hint]") as HTMLElement)
      .toHaveTextContent("Enter saves · Esc undoes");
    await userEvent.fill(screen.getByRole("textbox").element(), "");
    await userEvent.keyboard("{Enter}");
    expect(screen.container.querySelector("[data-inline-edit-hint]")).toBeNull();
  });

  it("ignores Enter and Escape while an input method is composing", async () => {
    const onCommit = vi.fn(() => null);
    const onCancel = vi.fn();
    await using screen = await render(<InlineEditField {...field({ onCommit, onCancel })} />, {
      router: false,
    });
    const input = screen.getByRole("textbox").element();
    for (const key of ["Enter", "Escape"]) {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, cancelable: true }),
      );
    }
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps Enter and Escape from reaching the row around it", async () => {
    const onRowKey = vi.fn();
    await using screen = await render(
      <div onKeyDown={onRowKey}>
        <InlineEditField {...field()} />
      </div>,
      { router: false },
    );
    await expect.element(screen.getByRole("textbox")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onRowKey).not.toHaveBeenCalled();
  });
});
