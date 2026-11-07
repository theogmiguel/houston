import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";
import { HostImageUrlContext } from "./chat/hostImageUrl";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
const parsedSources = vi.hoisted(() => [] as string[]);
const linkScans = vi.hoisted(() => [] as string[]);
vi.mock(import("@houston-app/shared/markdownLinks"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    extractMarkdownLinkHrefs: (markdown: string) => {
      linkScans.push(markdown);
      return actual.extractMarkdownLinkHrefs(markdown);
    },
  };
});
const linkResolutions = vi.hoisted(() => ({ count: 0 }));
vi.mock(import("../markdown-links"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    resolveMarkdownFileLinkMeta: (
      ...args: Parameters<typeof actual.resolveMarkdownFileLinkMeta>
    ) => {
      linkResolutions.count += 1;
      return actual.resolveMarkdownFileLinkMeta(...args);
    },
  };
});
vi.mock(import("mdast-util-from-markdown"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    fromMarkdown: ((source: string, ...rest: never[]) => {
      parsedSources.push(String(source));
      return (actual.fromMarkdown as (...args: unknown[]) => unknown)(source, ...rest);
    }) as typeof actual.fromMarkdown,
  };
});

vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@houston-app/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const appearance = vi.hoisted(() => ({
  value: "light" as "light" | "dark",
  listeners: new Set<() => void>(),
}));
vi.mock(import("../hooks/useTheme"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    appearance.listeners.add(listener);
    return () => appearance.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useRenderedAppearance: () => useSyncExternalStore(subscribe, () => appearance.value),
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";
import { AudioPreview } from "./files/AudioPreview";

it("keeps compact audio playback loaded across signed URL renewals", async () => {
  const original =
    "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
  const renewed = `${original}#renewed`;
  const preview = (src: string, revision = "clip-v1") => (
    <AudioPreview compact name="clip.wav" src={src} revision={revision} />
  );
  await using screen = await render(preview(original));
  const audio = screen.container.querySelector("audio")!;
  await act(() => {
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("play"));
  });
  await screen.rerender(preview(renewed));
  expect(screen.container.querySelector("audio")).toBe(audio);
  expect(audio.getAttribute("src")).toBe(original);
  await expect.element(screen.getByRole("button", { name: "Pause clip.wav" })).toBeEnabled();
  await screen.rerender(preview(renewed, "clip-v2"));
  expect(screen.container.querySelector("audio")).not.toBe(audio);
  expect(screen.container.querySelector("audio")?.getAttribute("src")).toBe(renewed);
});

function setup() {
  appearance.value = "light";
  parsedSources.length = 0;
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

it("shows unavailable audio when a workspace embed has no thread", async () => {
  setup();
  await using screen = await renderText("![recording](clip.wav)");
  expect(screen.container.textContent).toContain("Audio unavailable");
  expect(screen.container.textContent).not.toContain("Loading audio");
  expect(screen.container.querySelector("audio")).toBeNull();
});

it("loads a host image through the page's own route when there is no environment", async () => {
  setup();
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const hostImageUrl = vi.fn((_path: string) => pixel);
  await using screen = await render(
    <HostImageUrlContext value={hostImageUrl}>
      <ChatMarkdown cwd={undefined} text="![Shot](</work/my shot.png>)" />
    </HostImageUrlContext>,
  );
  await expect.element(screen.getByAltText("Shot")).toHaveAttribute("src", pixel);
  expect(new Set(hostImageUrl.mock.calls.map(([path]) => path))).toEqual(
    new Set(["/work/my shot.png"]),
  );
});

it("loads the <picture> source for the current theme through the image route", async () => {
  setup();
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const hostImageUrl = (path: string) => `${pixel}#${path}`;
  await using screen = await render(
    <HostImageUrlContext value={hostImageUrl}>
      <ChatMarkdown
        cwd={undefined}
        text={
          '<picture><source media="(prefers-color-scheme: dark)" srcset="/work/dark.png"><img src="/work/light.png" alt="Shot"></picture>'
        }
      />
    </HostImageUrlContext>,
  );
  await expect
    .element(screen.getByAltText("Shot"))
    .toHaveAttribute("src", `${pixel}#/work/light.png`);

  await act(() => {
    appearance.value = "dark";
    for (const listener of appearance.listeners) listener();
  });
  await expect
    .element(screen.getByAltText("Shot"))
    .toHaveAttribute("src", `${pixel}#/work/dark.png`);
});

it("reuses the parse of a streaming reply's finished blocks when it remounts", async () => {
  setup();
  const message = (
    <ChatMarkdown cwd="/tmp/project" text={"Finished block\n\nStill growing"} isStreaming />
  );
  {
    await using _first = await render(message);
  }
  await using screen = await render(message);
  await expect.element(screen.getByText("Still growing")).toBeVisible();
  expect(parsedSources.filter((source) => source.includes("Finished block"))).toHaveLength(1);
});

it("reuses the parse of a remounted message that has stable extra plugins", async () => {
  setup();
  const parsed = vi.fn();
  const countingPlugins = [() => () => void parsed()];
  const message = (
    <ChatMarkdown cwd="/tmp/project" text="Cached text" extraRemarkPlugins={countingPlugins} />
  );
  {
    await using _first = await render(message);
  }
  await using screen = await render(message);
  await expect.element(screen.getByText("Cached text")).toBeVisible();
  expect(parsed).toHaveBeenCalledTimes(1);
});

it("classifies a finished message's links once, however often it remounts", async () => {
  setup();
  const text = Array.from(
    { length: 20 },
    (_, index) =>
      `Step ${index} edits [file ${index}](src/file${index}.ts) and \`src/code${index}.ts\`.`,
  ).join("\n\n");
  {
    await using first = await renderText(text);
    expect(first.container.querySelectorAll(".chat-markdown-file-link")).toHaveLength(40);
  }
  linkScans.length = 0;
  linkResolutions.count = 0;
  await using screen = await renderText(text);
  expect(screen.container.querySelectorAll(".chat-markdown-file-link")).toHaveLength(40);
  expect(linkScans).toEqual([]);
  expect(linkResolutions.count).toBe(0);
});

// React numbers generated ids per mount, so two mounts differ there alone.
const GENERATED_ID = /_r_[0-9a-z]+_/g;

describe("ChatMarkdown finished blocks", () => {
  const blocks = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `Paragraph ${index} edits [file ${index}](src/file${index}.ts).`,
    ).join("\n\n");

  it("parses only the last block again when a streamed reply finishes", async () => {
    setup();
    const text = `${blocks(20)}\n\nThe last block.`;
    const message = (isStreaming: boolean) => (
      <ChatMarkdown cwd="/tmp/project" text={text} isStreaming={isStreaming} />
    );
    await using screen = await render(message(true));
    await expect.element(screen.getByText("The last block.")).toBeVisible();
    parsedSources.length = 0;
    await screen.rerender(message(false));
    await expect.element(screen.getByText("The last block.")).toBeVisible();
    expect(parsedSources.filter((source) => source.includes("Paragraph"))).toEqual([]);
    expect(screen.container.querySelectorAll(".chat-markdown-file-link")).toHaveLength(20);
  });

  it("classifies no block again when a thread's split messages remount", async () => {
    setup();
    const messages = Array.from({ length: 6 }, (_, message) =>
      Array.from(
        { length: 120 },
        (_, index) => `Message ${message} block ${index} edits \`src/m${message}/f${index}.ts\`.`,
      ).join("\n\n"),
    );
    const thread = () => (
      <div>
        {messages.map((text) => (
          <ChatMarkdown key={text.slice(0, 9)} cwd="/tmp/project" text={text} isStreaming={false} />
        ))}
      </div>
    );
    {
      await using first = await render(thread());
      await expect.element(first.getByText("Message 5 block 119", { exact: false })).toBeVisible();
    }
    linkScans.length = 0;
    await using screen = await render(thread());
    await expect.element(screen.getByText("Message 5 block 119", { exact: false })).toBeVisible();
    expect(linkScans).toHaveLength(0);
  });

  // An extra remark plugin keeps a message in one tree, which is the reference rendering.
  const ONE_TREE = [() => undefined];
  const html = (element: HTMLElement) => element.innerHTML.replace(GENERATED_ID, "_r_");
  it.each([
    "# Plan\n\n## Steps\n\n1. first `src/a.ts`\n2. second\n\n- [ ] open task\n- [x] done task\n\n### Notes\n\n> [!NOTE]\n> keep\n\n| a | b |\n| - | - |\n| [x](src/x.ts) | 2 |\n\n```ts\nconst a = 1;\n```\n\nThe end, see https://example.com.",
    "## Setup\n\nText\n\n## Setup\n\nMore text",
    "Intro\n\n3. starts at three\n4. four\n\n---\n\n* star list\n\n  continued",
    // A definition inside a container, or with a label across lines, still defines the document's.
    "See [the docs][1] for details.\n\n> [1]: https://example.com/docs",
    "Logo: ![logo][img]\n\n> [img]: https://example.com/a.png",
    "See [foo\nbar] now.\n\n[foo\nbar]: https://example.com/fb",
    // Raw inline HTML left open in one paragraph continues into the next.
    "Start <b>bold\n\nstill bold</b> end",
    "Start <em>bold\n\nstill bold</em> end",
    "Start <code>bold\n\nstill bold</code> end",
    'Read <a href="https://example.com">the guide\n\nand more</a> after.',
    // A fence line with an info string is content, not a closer, so it hides no heading.
    "## Setup\n\nText\n\n```md\n```js\nx\n```\n\n## Setup\n\nMore",
    // Lists, fences, quotes, tables and headings.
    "- see [a][r]\n\n- [r]: https://example.com/r",
    "1. one\n\n2. two\n\n3. three\n\nAfter.",
    "1. one\n2. two\n\nPara\n\n3. three",
    "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;",
    "````md\n```ts\nx\n```\n\n````\n\nafter\n\n## End",
    "> one\n\n> two\n>\n> more\n\n> three",
    "| a |\n| - |\n| 1 |\n\n| b |\n| - |\n| 2 |",
    "- [ ] one\n- [x] two\n\n- [ ] three",
    "- item\n\n    code or item?\n\nnext",
    "## snake_case_name\n\ntext\n\n## other_name",
    "## `fetch` usage\n\ntext\n\n## fetch usage",
    "## *Setup*\n\ntext\n\n## Setup",
    "> ## Quoted\n\n- ## Listed",
    "## Setup\n\n    ## Setup\n\nafter",
    "## Setup ##\n\ntext\n\n## Setup",
    "## 🚀 Launch\n\ntext\n\n## Launch",
    "See <https://example.com> and www.example.com.\n\n~~gone~~\n\nhttps://example.org",
    "Area is $a^2$.\n\nAnd $b < c$ holds.",
    "Text\n\n---\n\nMore\n\n***\n\n- - -\n\nEnd",
    "Before <!-- note --> after\n\nNext",
    "# Report\n\n1. `src/a.ts`: fixed\n2. `src/b.ts`: added\n\n> [!TIP]\n> run it\n\n```sh\npnpm test\n```\n\n| file | lines |\n| --- | --- |\n| a.ts | 3 |\n\nDone, see https://example.com.",
    // Code spans and fences that hold HTML-like text.
    "Use `Promise<T>` here.\n\nAnd `Map<K, V>` there.\n\nDone.",
    "```ts\ninterface A {\n  [key: string]: number;\n}\n```\n\nUse it.\n\nEnd",
    "| Type | Use |\n| --- | --- |\n| `Vec<T>` | list |\n\nAfter.",
    "```ts\nconst re = /<[a-z]+>/g;\n```\n\nMatches tags.\n\nEnd",
    "```tsx\n<Button onClick={go}>Go</Button>\n```\n\nRenders a button.\n\nEnd",
    '```html\n<h2 id="setup">Setup</h2>\n```\n\n## Setup\n\ntext\n\n## Usage',
    "A span `starts\nhere <b>` and\n\nends.",
    "Cost $a` + <b>$ then `x`\n\nstill</b>",
    "[link](`x) <b>` y\n\nstill</b>",
    "| a | b |\n| - | - |\n| `x | <b>` | y |\n\nstill</b>",
    "a | b\n- | -\n`x | <b>` | y\n\nstill</b>",
    "\\`not code <b>\\` here\n\nstill</b>",
    "``` a`b\n<b>x\n\ny</b>\n\nnext",
    "- item\n\n  ```\n  code\n\n      ```\n\n  still\n\nafter",
    "See [foo\nbar].\n\n> [foo\n> bar]: https://example.com",
    "Text[^1]\n\n- [^1]: note",
    "Text[^1] here\n\nMore\n\nEnd",
    "Run `cmd | grep <x>` now.\n\nNext\n\nEnd",
    "Visit <https://example.com/a>.\n\nMail <mailto:a@example.com>.\n\nEnd",
    "Use ``a ` <b> c`` here.\n\nnext",
    "`a<b>`\n`c<d>`\n\nnext",
    "See https://example.com/`a <b>` x\n\nstill</b>",
    "- `A | B<T>` works\n- `C`\n\nAfter",
    "1. Edit:\n\n   ```rust\n   fn a() -> Vec<u8> {}\n   ```\n\n2. Run.",
    "Use `x` then <b>bold\n\nstill</b>",
    "Use ``a` <b>`` and `c\n\nstill</b>",
    "~~~md\n```\n<b>x\n```\n~~~\n\nafter",
    "> | a | b |\n> | - | - |\n> | `x | <b>` | y |\n\nstill</b>",
    "Use `lines[1:]` and `x[::2]`.\n\n```python\nprint(a[1:])\n```\n\nDone.",
  ])("renders a finished message as one tree renders it: %j", async (text) => {
    setup();
    await using split = await renderText(text);
    const splitHtml = html(split.container);
    await using whole = await renderText(text, { extraRemarkPlugins: ONE_TREE });
    expect(splitHtml).toBe(html(whole.container));
  });
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    await using screen = await render(markdown("https://example.com"));
    const { container, rerender } = screen;
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/houston/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

describe("ChatMarkdown streaming", () => {
  it("scans only the growing block for file links on each streamed chunk", async () => {
    setup();
    const finished = Array.from(
      { length: 40 },
      (_, index) => `Step ${index} edits [file ${index}](src/file${index}.ts).`,
    ).join("\n\n");
    const message = (tail: string, isStreaming = true) => (
      <ChatMarkdown cwd="/tmp/project" text={`${finished}\n\n${tail}`} isStreaming={isStreaming} />
    );
    await using screen = await render(message("Now"));
    await expect.element(screen.getByText("Now")).toBeVisible();
    let tail = "Now";
    for (let chunk = 0; chunk < 10; chunk += 1) {
      tail += ` chunk ${chunk}`;
      linkScans.length = 0;
      await screen.rerender(message(tail));
      const scanned = linkScans.reduce((total, scan) => total + scan.length, 0);
      expect(scanned).toBeLessThanOrEqual(tail.length);
    }
    await expect.element(screen.getByText(/chunk 9/)).toBeVisible();

    // Every link stays a file link, streamed or settled: 40 in finished blocks and the last one.
    for (const isStreaming of [true, false]) {
      await screen.rerender(message(`${tail} [last](src/last.ts)`, isStreaming));
      expect(screen.container.querySelectorAll(".chat-markdown-file-link")).toHaveLength(41);
    }
  });

  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    await using rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
  });
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown skill chips", () => {
  it("shows the skill's details and opens its instructions", async () => {
    setup();
    const threadRef = {
      environmentId: EnvironmentId.make("workspace"),
      threadId: ThreadId.make("thread"),
    };
    await using screen = await renderText("Run $review now", {
      threadRef,
      skills: [
        {
          name: "review",
          displayName: "Review",
          description: "Reviews the current branch.",
          path: "/skills/review/SKILL.md",
          enabled: true,
        },
      ],
    });
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});

    await userEvent.click(screen.getByRole("button", { name: "Skill Review. Show details" }));
    await expect.element(page.getByText("Reviews the current branch.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "View instructions" }));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/skills/review/SKILL.md");
  });
});

describe("ChatMarkdown headings", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    setup();
    await using screen = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    const { container } = screen;
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown inline code selection", () => {
  it("selects the whole inline code span on double-click, but only a word in fenced code", async () => {
    setup();
    await using screen = await renderText(
      "Run `migration-gate --dry-run` first.\n\n```txt\nfenced-block word\n```",
    );
    await userEvent.dblClick(screen.getByText("migration-gate --dry-run"));
    expect(window.getSelection()?.toString()).toBe("migration-gate --dry-run");

    window.getSelection()?.removeAllRanges();
    const fenced = screen.container.querySelector("pre code")!;
    await userEvent.dblClick(fenced, { position: { x: 4, y: 4 } });
    expect(window.getSelection()?.toString()).toBe("fenced");
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it("still rejects unsafe schemes", async () => {
    setup();
    for (const parseRawHtml of [true, false]) {
      await using screen = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      const { container } = screen;
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});
