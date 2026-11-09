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

const waitForText = (text: string) =>
  vi.waitFor(() => expect(document.body.textContent).toContain(text), { timeout: 10_000 });

const waitForSelector = (selector: string) =>
  vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull(), { timeout: 10_000 });

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
