#!/usr/bin/env node
/**
 * Captures the renderer screens the style guide embeds, from a running dev server on the
 * Replay (dev) provider. Usage: node scripts/capture-styleguide.mjs --base-url <url> --pair-url <url> [--out <dir>]
 * Capture from a fresh state directory when the images must match across runs.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { chromium } from "playwright-core";
import sharp from "sharp";

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const SCREENSHOT_QUALITY = 52;

const SETTINGS_SECTIONS = [
  "General",
  "Appearance",
  "Chat",
  "Diffs & pull requests",
  "Keybindings",
  "SnapShots",
  "Providers",
  "Threads",
  "Browser",
  "Devices",
  "Scheduled tasks",
  "Projects",
  "Source control",
  "Worktrees",
  "Environments",
  "Sharing & access",
  "Maintenance",
  "Labs",
  "About",
  "Archive",
];

const REPLAYS = [
  { id: "showcase", screen: "thread-showcase", waitFor: '[aria-label="Approval needed"]' },
  { id: "approval", screen: "thread-approval", waitFor: "text=The agent wants to run a command" },
  { id: "question", screen: "thread-question", waitFor: "text=Input requested" },
  { id: "todo-list", screen: "thread-plan", waitFor: "text=todo list fixture complete" },
  { id: "multi-turn", screen: "thread-multi-turn", waitFor: "text=first fixture turn complete" },
];

const PANEL_SURFACES = [
  { label: "Files", screen: "panel-files" },
  { label: "Diff", screen: "panel-diff" },
  { label: "Browser", screen: "panel-browser" },
];

const { values: options } = NodeUtil.parseArgs({
  options: {
    "base-url": { type: "string" },
    "pair-url": { type: "string" },
    "storage-state": { type: "string" },
    out: { type: "string", default: "docs/internals/styleguide" },
    themes: { type: "string", default: "light,dark" },
    only: { type: "string" },
    width: { type: "string" },
    height: { type: "string" },
  },
});

if (!options["base-url"]) {
  console.error("--base-url is required, for example http://localhost:5842");
  process.exit(1);
}

const baseUrl = options["base-url"].replace(/\/$/, "");
const outputDirectory = NodePath.resolve(options.out);
const width = Number(options.width ?? DEFAULT_WIDTH);
const height = Number(options.height ?? DEFAULT_HEIGHT);
const themes = (options.themes ?? "light,dark")
  .split(",")
  .map((theme) => theme.trim())
  .filter(Boolean);
for (const theme of themes) {
  if (theme !== "light" && theme !== "dark") {
    console.error(`Unknown theme "${theme}". Expected light or dark.`);
    process.exit(1);
  }
}
const only = new Set(
  (options.only ?? "")
    .split(",")
    .map((screen) => screen.trim())
    .filter(Boolean),
);
const shouldCapture = (screen) => only.size === 0 || only.has(screen);

await NodeFSP.mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
let captured = 0;

try {
  const storageState = await resolveStorageState();
  const recorded = { threads: new Map() };

  for (const theme of themes) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      ...(storageState === null ? {} : { storageState }),
    });
    await context.addInitScript((mode) => {
      try {
        localStorage.setItem("t3code:theme-appearance-mode", mode);
        localStorage.setItem("t3code:theme", mode === "dark" ? "graphite" : "paper");
      } catch {
        // Private-mode storage failures leave the app on its default theme.
      }
    }, theme);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.error(`[${theme}] page error: ${error.message}`));
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });

    try {
      const wantsPanels = PANEL_SURFACES.some((panel) => shouldCapture(panel.screen));

      if (shouldCapture("home")) {
        await openApp(page, "/");
        await capture(page, "home", theme);
      }

      if (shouldCapture("grid")) {
        await openApp(page, "/");
        await openGrid(page);
        await capture(page, "grid", theme);
      }

      for (const replay of REPLAYS) {
        if (!shouldCapture(replay.screen) && !(wantsPanels && replay.id === "showcase")) {
          continue;
        }
        await playReplay(page, replay, recorded);
        if (shouldCapture(replay.screen)) await capture(page, replay.screen, theme);
      }

      if (wantsPanels) {
        const showcase = REPLAYS.find((replay) => replay.id === "showcase");
        const showcaseUrl = await playReplay(page, showcase, recorded);
        for (const panel of PANEL_SURFACES) {
          if (!shouldCapture(panel.screen)) continue;
          await openApp(page, showcaseUrl);
          await openRightPanel(page, panel.label);
          await capture(page, panel.screen, theme);
        }
      }

      if (shouldCapture("pull-requests")) {
        await openApp(page, "/");
        await clickSidebarItem(page, "Pull requests");
        await page.waitForURL(/\/pull-requests/, { timeout: 60_000 });
        await settle(page);
        await capture(page, "pull-requests", theme);
      }

      if (shouldCapture("usage")) {
        await openApp(page, "/");
        await clickSidebarItem(page, "Usage");
        await page.waitForURL(/\/usage/, { timeout: 60_000 });
        await settle(page);
        await capture(page, "usage", theme);
      }

      const settingsScreens = SETTINGS_SECTIONS.map((section) => `settings-${slug(section)}`);
      if (settingsScreens.some(shouldCapture)) {
        await openApp(page, "/");
        await page.getByRole("button", { name: "Settings" }).click();
        await page.waitForURL(/\/settings\//, { timeout: 60_000 });
        await settle(page);
        for (const [index, section] of SETTINGS_SECTIONS.entries()) {
          if (!shouldCapture(settingsScreens[index])) continue;
          await clickSettingsSection(page, section);
          await settle(page);
          await capture(page, settingsScreens[index], theme);
        }
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

console.log(
  `Captured ${captured} image${captured === 1 ? "" : "s"} in ${NodePath.relative(process.cwd(), outputDirectory)}`,
);

async function resolveStorageState() {
  if (options["storage-state"]) {
    try {
      const state = JSON.parse(await NodeFSP.readFile(options["storage-state"], "utf8"));
      if (Array.isArray(state.cookies) && state.cookies.length > 0) return state;
    } catch {
      // The file does not exist yet; pair below and write it.
    }
  }
  const pairUrl = options["pair-url"];
  if (!pairUrl) return null;

  const token = pairingToken(pairUrl);
  if (token === null) {
    throw new Error(`No token in --pair-url "${pairUrl}". Expected .../pair#token=<token>.`);
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const response = await page.evaluate(async (credential) => {
      const result = await fetch("/api/auth/browser-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      return { status: result.status, body: await result.text() };
    }, token);
    if (response.status !== 200) {
      throw new Error(
        `Pairing failed with HTTP ${response.status}: ${response.body.slice(0, 200)}. ` +
          "A one-time token is consumed on first use; issue a new pairing link.",
      );
    }
    const state = await context.storageState();
    if (options["storage-state"]) {
      await NodeFSP.writeFile(options["storage-state"], `${JSON.stringify(state, null, 2)}\n`);
    }
    return state;
  } finally {
    await context.close();
  }
}

function pairingToken(pairUrl) {
  const url = new URL(pairUrl);
  const fromHash = new URLSearchParams(url.hash.replace(/^#/, "")).get("token");
  return (fromHash ?? url.searchParams.get("token") ?? "").trim() || null;
}

async function openApp(page, target) {
  const url = target.startsWith("http") ? target : `${baseUrl}${target}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => document.getElementById("boot-shell") === null, null, {
    timeout: 180_000,
  });
  await settle(page);
}

async function settle(page) {
  await page.mouse.move(0, 0);
  await page
    .waitForFunction(() => !document.body.innerText.includes("Syncing messages"), null, {
      timeout: 30_000,
    })
    .catch(() => {});
  await page.waitForTimeout(1_200);
}

async function playReplay(page, replay, recorded) {
  const known = recorded.threads.get(replay.screen);
  if (known !== undefined) {
    await openApp(page, known);
    await page.locator(replay.waitFor).first().waitFor({ timeout: 120_000 });
    await settle(page);
    return known;
  }
  await openApp(page, "/");
  const threadId = await page.evaluate((scenario) => window.t3dev.replay(scenario), replay.id);
  await page.waitForFunction((id) => window.location.pathname.includes(id), threadId, {
    timeout: 120_000,
  });
  await page.waitForFunction(() => document.getElementById("boot-shell") === null, null, {
    timeout: 120_000,
  });
  await page.locator(replay.waitFor).first().waitFor({ timeout: 120_000 });
  await settle(page);
  const threadUrl = page.url();
  recorded.threads.set(replay.screen, threadUrl);
  return threadUrl;
}

async function openGrid(page) {
  let actions = page.getByRole("button", { name: /^Grid actions for / });
  if ((await actions.count()) === 0) {
    await page.getByRole("button", { name: "New grid" }).click();
    await page
      .getByRole("menuitem")
      .filter({ hasNotText: /^Open folder/ })
      .first()
      .click();
    await settle(page);
    actions = page.getByRole("button", { name: /^Grid actions for / });
  }
  await actions.first().click();
  await page.getByRole("menuitem", { name: "New thread" }).click();
  await page.waitForURL(/\/grid\//, { timeout: 60_000 });
  await settle(page);
}

async function clickSidebarItem(page, name) {
  const button = page.locator("button", { hasText: new RegExp(`^${escapeRegExp(name)}`) }).first();
  await button.click();
}

async function clickSettingsSection(page, section) {
  const navigation = page.locator('[aria-label="Settings sections"]').first();
  await navigation
    .getByRole("button", { name: section, exact: true })
    .or(navigation.getByRole("treeitem", { name: section, exact: true }))
    .first()
    .click();
}

async function openRightPanel(page, label) {
  const toggle = page.locator("[data-right-panel-toggle]").first();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
    await settle(page);
  }
  if ((await page.getByRole("button", { name: `Close ${label}` }).count()) > 0) return;

  const launcher = page.getByRole("button", { name: new RegExp(`^${escapeRegExp(label)}\\b`) });
  if ((await launcher.count()) > 0) {
    await launcher.first().click({ timeout: 30_000 });
  } else {
    await page.getByRole("button", { name: "Add panel surface" }).click();
    await page.getByRole("menuitem", { name: new RegExp(`^${escapeRegExp(label)}\\b`) }).click();
  }
  await settle(page);
}

async function capture(page, screen, theme) {
  if (!shouldCapture(screen)) return;
  const file = NodePath.join(outputDirectory, `${screen}--${theme}.webp`);
  const png = await page.screenshot({ type: "png" });
  await sharp(png).webp({ quality: SCREENSHOT_QUALITY }).toFile(file);
  captured += 1;
  console.log(`captured ${NodePath.relative(process.cwd(), file)}`);
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
