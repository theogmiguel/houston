import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { MarkdownTable } from "./MarkdownTable";

function row(cells: string[]) {
  return (
    <MarkdownTable>
      <tbody>
        <tr>
          {cells.map((cell) => (
            <td key={cell}>{cell}</td>
          ))}
        </tr>
      </tbody>
    </MarkdownTable>
  );
}

function viewports(container: HTMLElement) {
  return container.querySelectorAll<HTMLElement>('[data-slot="scroll-area-viewport"]');
}

describe("MarkdownTable", () => {
  it("gives only a table wider than its lane a scroll area", async () => {
    await using screen = await render(
      <div className="chat-markdown" style={{ width: "400px" }}>
        {Array.from({ length: 20 }, (_, index) => (
          <div key={index}>{row([`Name ${index}`, `Value ${index}`])}</div>
        ))}
        {row(["wide", "x".repeat(200)])}
      </div>,
      { router: false },
    );

    // Resize observations arrive together, so once the wide table has switched the others were seen.
    await expect.poll(() => viewports(screen.container).length).toBeGreaterThan(0);
    const [viewport, ...rest] = viewports(screen.container);
    expect(rest).toHaveLength(0);
    expect(viewport!.querySelector("td")?.textContent).toBe("wide");
    expect(viewport!.scrollWidth).toBeGreaterThan(viewport!.clientWidth);
    expect(screen.container.querySelectorAll("table")).toHaveLength(21);
  });

  it("keeps the table mounted when it grows past its lane", async () => {
    await using screen = await render(
      <div className="chat-markdown" data-testid="lane" style={{ width: "600px" }}>
        <MarkdownTable>
          <tbody>
            <tr>
              <td>
                <button type="button">cell</button>
              </td>
              <td>{"x".repeat(40)}</td>
            </tr>
          </tbody>
        </MarkdownTable>
      </div>,
      { router: false },
    );
    const cell = screen.container.querySelector("td")!;
    const button = cell.querySelector("button")!;
    expect(viewports(screen.container)).toHaveLength(0);
    button.focus();

    // A narrowed window: the lane shrinks below the table's width.
    screen.container.querySelector<HTMLElement>('[data-testid="lane"]')!.style.width = "80px";
    await expect.poll(() => viewports(screen.container).length).toBe(1);
    expect(viewports(screen.container)[0]!.contains(cell)).toBe(true);
    expect(screen.container.querySelector("td")).toBe(cell);
    expect(document.activeElement).toBe(button);
  });
});
