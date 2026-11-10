import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import {
  SourceControlProviderKind,
  UsageDay,
  type PullRequestListEntry,
  type UsageBucket,
} from "@houston-app/contracts";
import { formatDayShort, makeWindow } from "@houston-app/shared/usageFormat";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { SETTINGS_SECTION_LABELS } from "~/components/settings/settingsSearch";
import { getRouter } from "~/router";
import { installFakeEnvironment, PROJECT_ID, threadWithHistory } from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
type FakeDriver = import("../../test/fakeEnvironment").FakeDriver;

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const AT = "2026-03-17T19:12:28.000Z";
const PHONE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
] as const;

function pullRequestEntry(overrides: Partial<PullRequestListEntry>): PullRequestListEntry {
  return {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: PROJECT_ID,
    projectTitle: "render",
    repository: "theogmiguel/houston",
    number: 42,
    title: "A pull request title long enough to need truncating on a phone screen",
    url: "https://github.com/theogmiguel/houston/pull/42",
    author: { login: "theogmiguel", name: "Theo", avatarUrl: null },
    headBranch: "v2-phone-pages-layout",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 12,
    deletions: 3,
    createdAt: AT,
    updatedAt: AT,
    viewerReviewRequested: false,
    labels: [{ name: "renderer", color: "ededed" }],
    reviewDecision: "approved",
    checksState: "passing",
    ...overrides,
  };
}

const pullRequests: ReadonlyArray<PullRequestListEntry> = [
  pullRequestEntry({ number: 42 }),
  pullRequestEntry({
    number: 7,
    title: "A stacked pull request whose title is short",
    headBranch: "fix/phone",
    checksState: "failing",
    reviewDecision: "changes-requested",
    labels: [],
  }),
];

function usageBucket(day: string, model: string, costUsd: number): UsageBucket {
  return {
    day: UsageDay.make(day),
    provider: "codex",
    model,
    totals: {
      uncachedInputTokens: 12_000,
      cachedInputTokens: 48_000,
      cacheCreationTokens: 0,
      outputTokens: 6_000,
      reasoningTokens: 0,
    },
    costUsd,
    cacheSavingsUsd: costUsd / 4,
    costSource: "modelPriced",
    records: 4,
    unpricedRecords: 0,
    sessions: 2,
  };
}

const usageBuckets: ReadonlyArray<UsageBucket> = [
  usageBucket("2026-11-03", "gpt-5.4", 1.25),
  usageBucket("2026-11-05", "gpt-5.4-mini", 0.4),
  usageBucket("2026-11-08", "claude-sonnet-4-5-20250929-with-a-long-name", 2.1),
];

function installEnvironment(): Disposable {
  return installFakeEnvironment([threadWithHistory("thread-phone", 2)], {
    pullRequests: { entries: pullRequests, viewers: { "github.com": "theogmiguel" } },
    usage: { buckets: usageBuckets },
  });
}

async function mountApp(path: string, width: number, height: number) {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(width, height);
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: ${height}px; width: ${width}px;`;
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

interface AuditFinding {
  readonly name: string;
  readonly tag: string;
  readonly left: number;
  readonly right: number;
}

function* ancestorsOf(element: HTMLElement) {
  for (let current = element.parentElement; current !== null; current = current.parentElement) {
    yield current;
  }
}

/** Everything a phone must keep reachable: no page scroll and no control past the viewport. */
function auditPage() {
  const root = document.documentElement;
  const viewport = window.innerWidth;
  const outside: AuditFinding[] = [];
  const controls = document.querySelectorAll<HTMLElement>(
    'button, a[href], input, textarea, select, [role="button"], [role="switch"], [role="checkbox"], [role="tab"], [role="treeitem"], [role="option"], [role="combobox"], [tabindex]:not([tabindex="-1"])',
  );
  for (const control of controls) {
    if (control.closest("[inert]") !== null) continue;
    // A control inside a horizontally scrollable region is reachable by scrolling it.
    if (
      [...ancestorsOf(control)].some((ancestor) => {
        const style = getComputedStyle(ancestor);
        return (
          (style.overflowX === "auto" || style.overflowX === "scroll") &&
          ancestor.scrollWidth > ancestor.clientWidth + 1
        );
      })
    )
      continue;
    const style = getComputedStyle(control);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = control.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.left < -0.5 || rect.right > viewport + 0.5) {
      outside.push({
        name: (control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 60),
        tag: control.tagName.toLowerCase(),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      });
    }
  }
  return {
    viewport,
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    overflow: root.scrollWidth - root.clientWidth,
    outside,
  };
}

function expectPhoneLayout(label: string) {
  const audit = auditPage();
  expect(
    { label, overflow: audit.overflow, outside: audit.outside },
    `${label} at ${audit.viewport}px`,
  ).toEqual({ label, overflow: 0, outside: [] });
}

const rectOf = (element: Element) => element.getBoundingClientRect();
const centerY = (element: Element) => rectOf(element).top + rectOf(element).height / 2;
const leafWithText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLElement>("span, h1, code, button")].find(
    (element) => element.children.length === 0 && element.textContent?.trim() === text,
  ) ?? null;
/** The element's text is shown whole: no ellipsis clips it and nothing overflows its box. */
const expectNotTruncated = (element: HTMLElement, label: string) =>
  expect(element.scrollWidth, `${label} is clipped`).toBeLessThanOrEqual(element.clientWidth + 1);
/** A phone control reaches 44px tall. */
const expectTapHeight = (element: Element, label: string) =>
  expect(rectOf(element).height, `${label} height`).toBeGreaterThanOrEqual(43.5);
const expectGutter = (element: Element, label: string, viewport: number) => {
  expect(Math.round(rectOf(element).left), `${label} left gutter`).toBe(16);
  expect(Math.round(viewport - rectOf(element).right), `${label} right gutter`).toBe(16);
};

const waitForText = (text: string) =>
  vi.waitFor(() => expect(document.body.textContent).toContain(text), { timeout: 10_000 });

const waitForSelector = (selector: string) =>
  vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull(), { timeout: 10_000 });

// The client keeps the shell it last read, so the test that needs a project without threads runs
// before any test that installs threads.
it("offers a new thread under a project that has none", async () => {
  using _environment = installFakeEnvironment([], {});
  for (const { width, height } of PHONE_VIEWPORTS) {
    const { screen } = await mountApp("/", width, height);
    await using _screen = screen;
    await waitForSelector("[data-project-empty]");
    const empty = document.querySelector<HTMLElement>("[data-project-empty]")!;
    expect(empty.textContent).toContain("No threads yet");
    expect(Math.round(rectOf(empty.querySelector("p")!).left + 8), "empty line gutter").toBe(16);
    const action = empty.querySelector<HTMLElement>("button")!;
    expect(action.textContent).toContain("New thread");
    expectTapHeight(action, "New thread");
    expectPhoneLayout(`empty project at ${width}px`);
    await screen.unmount();
  }
});

// The client keeps what it read for each usage window, so this test reads a window (90 days) that
// no test with buckets reads.
it("shows one short line instead of zeroed cards when usage is empty", async () => {
  using _environment = installFakeEnvironment([threadWithHistory("thread-phone", 2)], {
    usage: { buckets: [] },
  });
  for (const { width, height } of PHONE_VIEWPORTS) {
    localStorage.setItem(
      "houston:usage-page-preferences:v1",
      JSON.stringify({ metric: "cost", windowDays: 90 }),
    );
    const { screen } = await mountApp("/usage", width, height);
    await using _screen = screen;
    await waitForSelector("[data-usage-empty]");
    expect(document.body.textContent).not.toContain("API-equivalent cost");
    expect(document.body.textContent).not.toContain("0 sessions");
    expectPhoneLayout(`empty usage at ${width}px`);
    await screen.unmount();
  }
  localStorage.removeItem("houston:usage-page-preferences:v1");
});

it("keeps pull requests and their detail on a phone screen", async () => {
  using _environment = installEnvironment();
  for (const { width, height } of PHONE_VIEWPORTS) {
    const { screen } = await mountApp("/pull-requests", width, height);
    await using _screen = screen;
    await waitForSelector("[data-pull-request-key]");
    expectPhoneLayout("pull requests");
    expect(
      document.querySelector<HTMLElement>("[data-pull-request-key]")?.getBoundingClientRect()
        .height,
    ).toBeGreaterThanOrEqual(44);

    const row = screen.getByRole("button", { name: /A pull request title long enough/ });
    await userEvent.click(row);
    await waitForSelector('[data-preview-panel-maximized="true"]');
    expectPhoneLayout("pull request detail");

    // The open request takes the page; Back returns to the list it came from.
    await userEvent.click(
      screen.getByRole("button", { name: "Back to this thread's pull requests" }),
    );
    await vi.waitFor(
      () => expect(document.querySelector('[data-preview-panel-maximized="true"]')).toBeNull(),
      { timeout: 5_000 },
    );
    await expect
      .element(screen.getByRole("button", { name: /A pull request title long enough/ }))
      .toBeVisible();
    expectPhoneLayout("pull requests after Back");
    await screen.unmount();
  }
});

it("keeps usage on a phone screen", async () => {
  using _environment = installEnvironment();
  for (const { width, height } of PHONE_VIEWPORTS) {
    localStorage.removeItem("houston:usage-page-preferences:v1");
    const { screen } = await mountApp("/usage", width, height);
    await using _screen = screen;
    await waitForText("API-equivalent cost");
    await vi.waitFor(
      () => expect(document.querySelector('ul[aria-label="Usage by model"]')).not.toBeNull(),
      { timeout: 10_000 },
    );
    expectPhoneLayout("usage");
    expect(
      document
        .querySelector<HTMLElement>('ul[aria-label="Usage by model"] button')
        ?.getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);

    // The range filter changes the window the page reports.
    const sevenDays = page.getByRole("button", { name: "7 days" });
    await userEvent.click(sevenDays);
    await expect.element(sevenDays).toHaveAttribute("aria-pressed", "true");
    const week = makeWindow(7, undefined, "day");
    await waitForText(`${formatDayShort(week.sinceDay)} to ${formatDayShort(week.untilDay)}`);
    expectPhoneLayout("usage after a range change");
    await screen.unmount();
  }
});

it("gives the pull requests list the phone bar, a 16px gutter and 44px controls", async () => {
  using _environment = installEnvironment();
  for (const { width, height } of PHONE_VIEWPORTS) {
    const { screen } = await mountApp("/pull-requests", width, height);
    await using _screen = screen;
    await waitForSelector("[data-pull-request-key]");

    const bar = document.querySelector<HTMLElement>("[data-phone-page-bar]");
    expect(bar, `phone bar at ${width}px`).not.toBeNull();
    expect(rectOf(bar!).height).toBe(44);
    expect(rectOf(bar!).top).toBeGreaterThanOrEqual(0);
    expect(getComputedStyle(bar!).borderBottomWidth).toBe("1px");
    const title = bar!.querySelector<HTMLElement>("h1")!;
    expect(title.textContent).toBe("Pull requests");
    expectNotTruncated(title, "pull requests title");
    expect(Math.round(rectOf(title).left)).toBe(16);
    // The bar carries no panel toggles; the tab bar is the navigation.
    expect(screen.getByRole("button", { name: "Toggle main sidebar" }).elements()).toHaveLength(0);
    expect(document.querySelector("[data-workspace-titlebar-controls]")).toBeNull();

    const involvement = document.querySelector<HTMLElement>(
      '[aria-label="Pull request involvement"]',
    )!;
    const refresh = screen.getByRole("button", { name: "Refresh pull requests" }).element();
    const search = document.querySelector<HTMLElement>('input[aria-label="Search pull requests"]')!;
    expectGutter(search.closest('[data-slot="input-group"]') ?? search, "search", width);
    expect(Math.round(rectOf(involvement).left), "segment left gutter").toBe(16);
    expect(Math.round(width - rectOf(refresh).right), "refresh right gutter").toBe(16);
    for (const toggle of involvement.querySelectorAll("button")) expectTapHeight(toggle, "segment");
    expectTapHeight(refresh, "refresh");
    expectTapHeight(search, "search");
    // The refresh button shares the segment's row.
    expect(Math.abs(centerY(refresh) - centerY(involvement))).toBeLessThan(4);
    for (const name of [/^Sort pull requests/, /^Filters/, /^Filter by provider/]) {
      expectTapHeight(screen.getByRole("button", { name }).element(), String(name));
    }
    for (const toggle of document.querySelectorAll('[aria-label="Pull request view"] button')) {
      expectTapHeight(toggle, "view segment");
    }
    expectPhoneLayout(`pull requests list at ${width}px`);
    await screen.unmount();
  }
});

it("lays pull request rows out the same way, with no persistent fill", async () => {
  using _environment = installEnvironment();
  for (const { width, height } of PHONE_VIEWPORTS) {
    const { screen } = await mountApp("/pull-requests", width, height);
    await using _screen = screen;
    await waitForSelector("[data-pull-request-key]");
    // Opening and closing a request leaves it selected, which must not fill its row.
    await userEvent.click(screen.getByRole("button", { name: /A stacked pull request/ }));
    await waitForSelector('[data-preview-panel-maximized="true"]');
    await userEvent.click(
      screen.getByRole("button", { name: "Back to this thread's pull requests" }),
    );
    await vi.waitFor(
      () => expect(document.querySelector('[data-preview-panel-maximized="true"]')).toBeNull(),
      { timeout: 5_000 },
    );

    const rows = [...document.querySelectorAll<HTMLElement>("[data-pull-request-key]")];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const numberTops: number[] = [];
    const numberLefts: number[] = [];
    for (const row of rows) {
      expect(getComputedStyle(row).backgroundColor, "row fill").toBe("rgba(0, 0, 0, 0)");
      expectGutter(row, "row", width);
      expectTapHeight(row, "row");
      const number =
        [...row.querySelectorAll<HTMLElement>("span")].find(
          (element) => element.children.length === 0 && /^#\d+$/.test(element.textContent ?? ""),
        ) ?? null;
      expect(number, "row number").not.toBeNull();
      numberTops.push(rectOf(number!).top - rectOf(row).top);
      numberLefts.push(rectOf(number!).left);
      const author = leafWithText(row, "theogmiguel");
      expect(author, "row author").not.toBeNull();
      expectNotTruncated(author!, "row author");
      const stat = leafWithText(row, "+12");
      expect(stat, "row diff stat").not.toBeNull();
      // The stat shares the meta line with the author instead of floating on its own line.
      expect(Math.abs(centerY(stat!) - centerY(author!))).toBeLessThan(4);
      // The repository chip yields its room to the author on a phone.
      const repository = leafWithText(row, "theogmiguel/houston");
      expect(repository === null || rectOf(repository).width === 0, "repository chip hidden").toBe(
        true,
      );
    }
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    expect(
      spread(numberTops),
      `number offsets ${numberTops.join(", ")} at ${width}px`,
    ).toBeLessThan(1.5);
    expect(spread(numberLefts), `number x ${numberLefts.join(", ")} at ${width}px`).toBeLessThan(
      1.5,
    );
    await screen.unmount();
  }
});

it("shows a pull request on the phone bar with wrapped text and one gutter", async () => {
  using _environment = installEnvironment();
  for (const { width, height } of PHONE_VIEWPORTS) {
    const { screen } = await mountApp("/pull-requests", width, height);
    await using _screen = screen;
    await waitForSelector("[data-pull-request-key]");
    await userEvent.click(screen.getByRole("button", { name: /A pull request title long enough/ }));
    await waitForSelector('[data-preview-panel-maximized="true"]');

    // No desktop tab strip: the page has its own back control instead.
    expect(document.querySelector("[data-right-panel-tabbar]")).toBeNull();
    const back = screen
      .getByRole("button", { name: "Back to this thread's pull requests" })
      .element();
    expectTapHeight(back, "back");
    expectTapHeight(
      document.querySelector('nav[aria-label="Pull request tabs"] button')!,
      "detail tab",
    );
    const heading = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-preview-panel-maximized="true"] h1');
      if (found === null) throw new Error("no title");
      return found;
    });
    expect(heading.scrollHeight).toBeGreaterThan(24);
    expectNotTruncated(heading, "title");
    expect(Math.round(rectOf(heading).left), "title gutter").toBe(16);
    expect(Math.round(rectOf(back).left) + 14, "back glyph gutter").toBe(16);
    const tabs = document.querySelector<HTMLElement>('nav[aria-label="Pull request tabs"]')!;
    expect(Math.round(rectOf(tabs.firstElementChild!).left), "tab gutter").toBe(16);
    const checkout = document.querySelector<HTMLElement>(
      '[aria-label="Copy checkout command"] code',
    );
    if (checkout !== null) expectNotTruncated(checkout, "checkout command");
    // The panel runs down to the tab bar instead of stopping short.
    const panel = document.querySelector<HTMLElement>('[data-preview-panel-maximized="true"]')!;
    const tabBar = document.querySelector<HTMLElement>("[data-phone-tab-bar]")!;
    expect(Math.round(rectOf(panel).bottom)).toBe(Math.round(rectOf(tabBar).top));
    const content = document.querySelector<HTMLElement>(
      '[data-right-panel-surface-content] [data-slot="swap-layer"][data-state="active"] > div > *',
    )!;
    // Compared by height: the panel's entrance animation offsets its top by a few pixels.
    expect(Math.round(rectOf(content).height), "detail fills the panel").toBe(
      Math.round(rectOf(panel).height),
    );
    expectPhoneLayout(`pull request detail at ${width}px`);
    // The open request outlives the mount, so close it for the next viewport.
    await userEvent.click(back);
    await vi.waitFor(
      () => expect(document.querySelector('[data-preview-panel-maximized="true"]')).toBeNull(),
      { timeout: 5_000 },
    );
    await screen.unmount();
  }
});

it("titles usage once, inside the gutter, with 44px controls", async () => {
  using _environment = installEnvironment();
  for (const { width, height } of PHONE_VIEWPORTS) {
    localStorage.removeItem("houston:usage-page-preferences:v1");
    const { screen } = await mountApp("/usage", width, height);
    await using _screen = screen;
    await waitForText("API-equivalent cost");

    const headings = [...document.querySelectorAll("h1")].filter(
      (heading) => heading.textContent === "Usage",
    );
    expect(headings, "one Usage title").toHaveLength(1);
    expect(headings[0]!.closest("[data-phone-page-bar]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Toggle main sidebar" }).elements()).toHaveLength(0);

    const period = document.querySelector<HTMLElement>('[aria-label="Usage period"]')!;
    const metric = document.querySelector<HTMLElement>('[aria-label="Usage metric"]')!;
    for (const group of [period, metric]) {
      expect(Math.round(rectOf(group).left), "segment left gutter").toBe(16);
      expect(Math.round(width - rectOf(group).right), "segment right gutter").toBe(16);
      for (const toggle of group.querySelectorAll("button")) expectTapHeight(toggle, "segment");
    }
    const card = document.querySelector<HTMLElement>("section")!;
    expectGutter(card, "usage card", width);
    expectTapHeight(screen.getByRole("button", { name: "Refresh usage" }).element(), "refresh");
    expectPhoneLayout(`usage at ${width}px`);
    await screen.unmount();
  }
});

it("renders a missing grid inside the phone shell", async () => {
  using _environment = installEnvironment();
  for (const { width, height } of PHONE_VIEWPORTS) {
    const { screen } = await mountApp("/grid/missing-grid", width, height);
    await using _screen = screen;
    await waitForSelector("[data-phone-missing-grid]");
    expect(document.querySelector("[data-phone-page-bar]")).not.toBeNull();
    expect(document.querySelector("[data-phone-tab-bar]")).not.toBeNull();
    const message = screen.getByText("This grid no longer exists").element();
    const detail = screen.getByText(/It was deleted on this machine/).element();
    for (const text of [message, detail]) {
      expect(getComputedStyle(text).textWrap, "balanced text").toMatch(/balance/);
      expect(rectOf(text).left, "text gutter").toBeGreaterThanOrEqual(16);
      expect(width - rectOf(text).right, "text gutter").toBeGreaterThanOrEqual(16);
    }
    const back = screen.getByRole("link", { name: "Back to threads" }).element();
    expectTapHeight(back, "Back to threads");
    expectPhoneLayout(`missing grid at ${width}px`);
    await screen.unmount();
  }
});

const SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "connections",
  "devices",
  "access",
  "providers",
  "projects",
  "chat",
  "voice",
  "diffs",
  "keybindings",
  "snap-shot",
  "threads",
  "browser",
  "scheduled-tasks",
  "source-control",
  "worktrees",
  "task-sources",
  "secrets",
  "maintenance",
  "labs",
  "about",
  "archived",
] as const;

async function auditSettingsPages({ width, height }: { width: number; height: number }) {
  for (const section of SETTINGS_SECTIONS) {
    const { screen } = await mountApp(`/settings/${section}`, width, height);
    await using _screen = screen;
    await waitForSelector("[data-settings-page-scroll]");
    await waitForText(SETTINGS_SECTION_LABELS[`/settings/${section}`]);
    expectPhoneLayout(`settings/${section}`);
    await screen.unmount();
  }
}

it("keeps settings pages on a 390px phone screen", async () => {
  using _environment = installEnvironment();
  await auditSettingsPages({ width: 390, height: 844 });
});

it("keeps settings pages on a 320px phone screen", async () => {
  using _environment = installEnvironment();
  await auditSettingsPages({ width: 320, height: 640 });
});

it("lists settings sections as a page and returns to the chosen one", async () => {
  using _environment = installEnvironment();
  for (const { width, height } of PHONE_VIEWPORTS) {
    const { screen } = await mountApp("/settings/general", width, height);
    await using _screen = screen;
    await waitForText("Project grouping");

    await userEvent.click(page.getByRole("button", { name: "Back to settings sections" }));
    await waitForSelector('[aria-label="Settings sections"]');
    await expect.element(page.getByRole("button", { name: /^Back/ })).toBeVisible();
    expectPhoneLayout("settings sections");
    expect(
      page.getByRole("treeitem", { name: "Appearance" }).element().getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);

    await userEvent.click(page.getByRole("treeitem", { name: "Appearance" }));
    await vi.waitFor(
      () => expect(document.body.textContent).toContain("Theme, contrast, chat width and motion."),
      { timeout: 10_000 },
    );
    expectPhoneLayout("settings/appearance after choosing it");
    await screen.unmount();
  }
});

it("keeps the desktop layout at 1024px", async () => {
  using _environment = installEnvironment();
  await page.viewport(1024, 900);
  {
    const { screen } = await mountApp("/pull-requests", 1024, 900);
    await using _screen = screen;
    await waitForSelector("[data-pull-request-key]");
    await userEvent.click(screen.getByRole("button", { name: /A pull request title long enough/ }));
    await waitForSelector('[data-preview-panel-maximized="false"]');
    const list = document.querySelector<HTMLElement>('[data-workspace-area="pull-requests"]');
    expect(list?.getBoundingClientRect().width ?? 0).toBeGreaterThan(0);
    expect(document.querySelector("[data-pull-request-key]")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Back to this thread's pull requests" }).elements(),
    ).toHaveLength(0);
  }

  {
    const { screen } = await mountApp("/usage", 1024, 900);
    await using _screen = screen;
    await waitForText("API-equivalent cost");
    expect(document.querySelector('ul[aria-label="Usage by model"]')).toBeNull();
    expect(document.querySelector("table")).not.toBeNull();
  }

  {
    const { screen } = await mountApp("/settings/general", 1024, 900);
    await using _screen = screen;
    await waitForText("Project grouping");
    const nav = document.querySelector<HTMLElement>('[aria-label="Settings sections"]');
    expect(nav?.closest("nav")?.getBoundingClientRect().width).toBe(264);
    expect(page.getByRole("button", { name: "Back to settings sections" }).elements()).toHaveLength(
      0,
    );
  }
});
