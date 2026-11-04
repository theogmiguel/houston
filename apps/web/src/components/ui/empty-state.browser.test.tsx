import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { PageEmptyState, PageEmptyTile, PageEmptyTiles, PanelEmptyState } from "./empty-state";

describe("PanelEmptyState", () => {
  it("renders the glyph, title, description and one way forward", async () => {
    await using screen = await render(
      <PanelEmptyState
        icon={<span>glyph</span>}
        title="No linked pull requests"
        description="Link one from a URL or a number."
        action={<button type="button">Link pull request</button>}
      />,
      { router: false },
    );
    await expect.element(screen.getByText("No linked pull requests")).toBeVisible();
    await expect.element(screen.getByText("Link one from a URL or a number.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Link pull request" })).toBeVisible();
    await expect.element(screen.getByText("glyph")).toBeVisible();
  });

  it("tones the glyph as an error for failed states", async () => {
    await using screen = await render(
      <PanelEmptyState tone="error" icon={<span>glyph</span>} title="Couldn't load this diff" />,
      { router: false },
    );
    const glyph = screen.container.querySelector("[aria-hidden]");
    expect(glyph?.className).toContain("text-error-foreground");
  });
});

describe("PageEmptyState", () => {
  it("renders faded ghost rows toward the title", async () => {
    await using screen = await render(
      <PageEmptyState ghostRows={3} title="No archived threads" description="Nothing here yet." />,
      { router: false },
    );
    await expect.element(screen.getByText("No archived threads")).toBeVisible();
    const ghost = screen.container.querySelector<HTMLElement>("[aria-hidden]");
    expect(ghost?.children).toHaveLength(3);
    expect(ghost?.children[0]?.className).toContain("opacity-70");
    expect(ghost?.children[2]?.className).toContain("opacity-25");
  });

  it("renders the icon, aligned start with hint tiles", async () => {
    await using screen = await render(
      <PageEmptyState
        align="start"
        icon={<span>glyph</span>}
        title="Choose a project"
        description="Pick one to manage it."
      >
        <PageEmptyTiles narrow title="What you can set">
          <PageEmptyTile icon={<span>tile</span>} title="Name" description="Shown in the sidebar" />
        </PageEmptyTiles>
      </PageEmptyState>,
      { router: false },
    );
    await expect.element(screen.getByText("Choose a project")).toBeVisible();
    await expect.element(screen.getByText("glyph")).toBeVisible();
    await expect.element(screen.getByText("What you can set")).toBeVisible();
    await expect.element(screen.getByText("Shown in the sidebar")).toBeVisible();
    const root = screen.container.firstElementChild as HTMLElement;
    expect(root.className).toContain("items-start");
    expect(root.className).toContain("text-left");
  });
});
