import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, type ModelSelection } from "@houston-app/contracts";
import type { HoustonBotProviderPolicy } from "@houston-app/contracts/houston/bots";
import { HOUSTON_ORCHESTRATION_INSTRUCTIONS } from "@houston-app/provider-core/server/orchestrationInstructions";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { policyFor } from "../../houston/bots/kinds.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  claudeBotLaunchRefusal,
  claudeBotToolCheckUnsupportedMessage,
  claudeStartedToolCalls,
  ClaudeBotToolDecisions,
  makeClaudeBotToolCheck,
} from "./claudeBotRules.ts";

const SETTINGS = Schema.decodeSync(ClaudeSettings)({
  launchArgs: "--verbose --add-dir /extra",
  autoCompactWindow: "300000",
});
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "high" }],
};
const MCP = {
  houston: {
    type: "http" as const,
    url: "http://127.0.0.1:1/mcp",
    headers: { Authorization: "Bearer test" },
  },
};

/** The options of an ordinary thread with Houston's tools, devices and launch arguments. */
const ordinaryOptions = () =>
  ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: MODEL,
    nativeThreadId: "ordinary-thread",
    resume: true,
    cwd: "/workspace",
    settings: SETTINGS,
    claudeInChrome: true,
    mcpServers: MCP,
    deviceToolsAvailable: true,
    allowedTools: ["mcp__houston__*"],
    permissionMode: "auto",
    sdkSettings: { env: { SAMPLE: "1" } },
  });

describe("an ordinary thread's Claude options", () => {
  it("are byte-identical to what they were before bot threads existed", () => {
    expect(JSON.stringify(ordinaryOptions())).toMatchInlineSnapshot(
      `"{"model":"claude-sonnet-4-6","tools":{"type":"preset","preset":"claude_code"},"permissionMode":"auto","includePartialMessages":true,"promptSuggestions":false,"effort":"high","resume":"ordinary-thread","allowedTools":["mcp__houston__*"],"thinking":{"type":"adaptive","display":"summarized"},"settings":{"env":{"SAMPLE":"1","CLAUDE_CODE_AUTO_COMPACT_WINDOW":"300000"},"autoCompactWindow":300000,"showThinkingSummaries":true},"pathToClaudeCodeExecutable":"claude","mcpServers":{"houston":{"type":"http","url":"http://127.0.0.1:1/mcp","headers":{"Authorization":"Bearer test"}}},"systemPrompt":{"type":"preset","preset":"claude_code","append":"<runtime_info>In case you're asked: you are running in Houston through the Claude Code harness. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in Houston's files viewer.</runtime_info>\\n\\n<pull_request_linking>\\nLink each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.\\n</pull_request_linking>\\n\\n## Houston orchestration\\n\\nOrdinary coding tasks need no Houston tools.\\n\\n- Subagents: use your native tool (Claude \`Agent\` always with \`run_in_background:false\`; Codex \`spawn_agent\`, then wait) when the child uses your provider, a model it offers, and no settings beyond yours, and finishes in this turn with no command likely to run over a few minutes (a test suite or build). Use \`delegate_task\` otherwise, and for a separate checkout, another project or a request for it by name; a native type on another provider's model counts as that provider. Workflow only when asked.\\n- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.\\n- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`houston_thread_send\`; so is new work for a child idle over an hour (give it that child's last summary). Fix small review findings yourself, without delegates. Told to run fewer or none: \`task_cancel\` the extras, start no replacement.\\n- Follow a running delegate's \`next\`. Never poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). \`task_cancel\` a delegate run you replace or no longer need, never \`houston_thread_interrupt\` its \`childThreadId\`.\\n- Subagent or child: do the work yourself. Start no subagents unless your task says to.\\n\\n- \`houston_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. \\"Subagent\\", \\"delegate\\", and \\"parallel\\" never mean one. Worktree thread: set \`workspaceStrategy\`. Honor a requested base. Otherwise, independent work uses the default branch as \`remote/branch\` with \`startFromOrigin:true\`; with no remote, use the local default. Required unpublished commits and dependent work use their local base. Shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.\\n- Given a thread id, \`houston_thread_read\` it before you answer about it.\\n- Another machine: \`houston_environment_links\` lists linked ones. Pass its \`environmentId\` to a Houston tool to act there. Ids are then that machine's, so pass \`threadId\`.\\n- A machine the user names that is not linked (\\"delegate this to my vps\\"): call \`houston_environment_link\` with a \`hint\` from their words. Never ask for a pairing code in chat.\\n- In your reply, mention a thread by its \`link\`, verbatim. Never a plain title or bare id.\\n- A login, token, PIN or pairing code only the user can give: call \`request_secret\`, not a chat ask or a handoff. Not for access you have. When asked only to schedule, \`schedule_task\` without running its prompt.\\n- Houston tools may load late. Try the name once before you call it absent.\\n\\n### Visuals and preview\\n\\n- Answer data with a trend or comparison with a chart, and show any visual the user asks for here: pass the path to an HTML file, or inline HTML, to \`html_preview\`, then \`html_render\`. A screenshot on disk or a text description does not show it. Never start a server for it. Tools a web page exposes give data only. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.\\n- Never use \`preview_*\` unasked to verify or show your own edit. Use them when the current request asks for browser work, including recording edits, or names a page or tab. Do not repeat preview calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.\\n\\n\\n### Background work you wait on\\n\\nTo wait for a background command or Monitor you started (tests, a build), call \`houston_background_wait\` with \`taskIds: [id]\` before you end your turn. Do not mark work you leave running, or PRs. Houston MCP tools are deferred: load one with ToolSearch first.\\n\\n## Houston devices\\n\\nWhen a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel. Load them with ToolSearch \`select:mcp__houston__device_list,mcp__houston__device_open,mcp__houston__device_screenshot,mcp__houston__device_close\`.\\n1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.\\n2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.\\n3. Call \`device_screenshot\` to look at the screen.\\n\\nNever do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.\\n"},"hooks":{"SubagentStart":[{"hooks":[null]}]},"extraArgs":{"verbose":null,"chrome":null,"thinking-display":"summarized"},"additionalDirectories":["/workspace","/extra"],"cwd":"/workspace"}"`,
    );
  });
});

const providerPolicy = (
  kind: "asked" | "unattended",
  extra: Partial<HoustonBotProviderPolicy> = {},
): HoustonBotProviderPolicy => {
  const stored = policyFor({
    kind,
    bot: { askedMode: "auto", unattendedFullAccess: false, maxMinutes: 20 },
  });
  return {
    botName: "Digest writer",
    kind,
    child: false,
    refusedTools: stored.refusedTools,
    rules: stored.rules,
    neverAsk: stored.neverAsk,
    ...extra,
  };
};

const botOptions = (houstonBot: HoustonBotProviderPolicy) =>
  ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: MODEL,
    nativeThreadId: "bot-thread",
    resume: false,
    cwd: "/workspace",
    settings: SETTINGS,
    claudeInChrome: true,
    mcpServers: MCP,
    deviceToolsAvailable: true,
    permissionMode: "auto",
    sdkSettings: { autoMemoryEnabled: true, autoDreamEnabled: true, env: { SAMPLE: "1" } },
    houstonBot,
    botToolCheck: makeClaudeBotToolCheck(houstonBot, new ClaudeBotToolDecisions()),
  });

const preToolUse = (
  toolName: string,
  toolInput: unknown = {},
  extra: Partial<Extract<HookInput, { hook_event_name: "PreToolUse" }>> = {},
): HookInput => ({
  hook_event_name: "PreToolUse",
  session_id: "session",
  transcript_path: "/transcript",
  cwd: "/workspace",
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: `use-${toolName}`,
  ...extra,
});

describe("a bot thread's Claude options", () => {
  it("unattended: refused names, a blocking check, memory off after launch settings, no browser and no orchestration text", () => {
    const policy = providerPolicy("unattended", { instructionsAppend: "BOT APPEND" });
    const options = botOptions(policy);
    for (const name of ["CronCreate", "ScheduleWakeup", "Monitor", "Agent", "Task"]) {
      assert.include(options.disallowedTools, name);
    }
    const preToolUseHooks = options.hooks?.PreToolUse ?? [];
    assert.lengthOf(preToolUseHooks, 1);
    assert.strictEqual(preToolUseHooks[0]?.onFailure, "block");
    assert.isUndefined(options.hooks?.SubagentStart);
    const settings = options.settings as Record<string, unknown>;
    assert.isFalse(settings["autoMemoryEnabled"]);
    assert.isFalse(settings["autoDreamEnabled"]);
    assert.deepEqual(settings["env"], { SAMPLE: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" });
    assert.notProperty(options.extraArgs ?? {}, "chrome");
    const append = options.systemPrompt as { readonly append: string };
    assert.notInclude(append.append, HOUSTON_ORCHESTRATION_INSTRUCTIONS);
    assert.include(append.append, "BOT APPEND");
  });

  it("asked: the same refusals, check and memory keys; the owner's browser and Houston's text stay", () => {
    const options = botOptions(providerPolicy("asked"));
    for (const name of [
      "CronCreate",
      "CronList",
      "ScheduleWakeup",
      "mcp__houston__schedule_task",
    ]) {
      assert.include(options.disallowedTools, name);
    }
    assert.notInclude(options.disallowedTools, "Agent");
    assert.strictEqual(options.hooks?.PreToolUse?.[0]?.onFailure, "block");
    assert.isDefined(options.hooks?.SubagentStart);
    assert.isFalse((options.settings as Record<string, unknown>)["autoMemoryEnabled"]);
    assert.property(options.extraArgs ?? {}, "chrome");
    assert.include(
      (options.systemPrompt as { readonly append: string }).append,
      HOUSTON_ORCHESTRATION_INSTRUCTIONS,
    );
  });
});

describe("a bot thread's tool check", () => {
  const check = (policy: HoustonBotProviderPolicy, decisions = new ClaudeBotToolDecisions()) => ({
    decisions,
    hook: makeClaudeBotToolCheck(policy, decisions),
  });
  const run = (hook: ReturnType<typeof makeClaudeBotToolCheck>, input: HookInput) =>
    hook(input, undefined, { signal: new AbortController().signal });

  it("denies a refused call with its reason and records every call it decided", async () => {
    const { hook, decisions } = check(providerPolicy("unattended"));
    const denied = await run(
      hook,
      preToolUse(
        "mcp__sample__send_item",
        {},
        { mcp_server: { name: "sample", source: "project" } as never },
      ),
    );
    assert.deepInclude(
      (denied as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput,
      { hookEventName: "PreToolUse", permissionDecision: "deny" },
    );
    assert.deepEqual(await run(hook, preToolUse("Read", { file_path: "/a" })), {});
    assert.isTrue(decisions.has("use-mcp__sample__send_item"));
    assert.isTrue(decisions.has("use-Read"));
    assert.isFalse(decisions.has("use-other"));
  });

  it("decides a subagent's calls the same way", async () => {
    const { hook } = check(providerPolicy("unattended"));
    const denied = await run(
      hook,
      preToolUse("CronCreate", {}, { agent_id: "agent-1", agent_type: "general-purpose" }),
    );
    assert.strictEqual(
      (denied as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision,
      "deny",
    );
    const asked = check(providerPolicy("asked")).hook;
    const askedDenied = await run(asked, preToolUse("ScheduleWakeup", {}, { agent_id: "agent-1" }));
    assert.strictEqual(
      (askedDenied as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision,
      "deny",
    );
  });
});

describe("launch arguments of a bot thread's account", () => {
  const refusal = (kind: "asked" | "unattended", launchArgs: string, sdkSettings?: string) =>
    claudeBotLaunchRefusal({
      policy: providerPolicy(kind),
      account: "claude-work",
      launchArgs,
      sdkSettings,
    });

  it("allows the listed flags unattended and refuses any other by name", () => {
    assert.isUndefined(
      refusal(
        "unattended",
        "--add-dir /x --model opus --effort high --thinking-display omitted --verbose --debug",
      ),
    );
    const refused = refusal("unattended", "--verbose --mcp-config extra.json");
    assert.include(refused, "--mcp-config");
    assert.include(refused, "claude-work");
    assert.include(refused, "Digest writer");
    assert.include(
      refusal("unattended", "--dangerously-skip-permissions"),
      "--dangerously-skip-permissions",
    );
  });

  it("leaves an asked bot run's flags alone, but refuses a settings file memory cannot be turned off in", () => {
    assert.isUndefined(refusal("asked", "--mcp-config extra.json --chrome"));
    assert.include(refusal("asked", "", "/settings.json"), "memory");
  });
});

describe("a Claude Code that cannot run the tool check", () => {
  it("fails a bot thread's query by name, through the errors that wrap it", () => {
    const old = new Error(
      'The process answering initialize does not honor onFailure on hook matchers, so a hook that fails would not block. Update Claude Code if it is old, or remove onFailure: "block" from your hooks.',
    );
    const message = claudeBotToolCheckUnsupportedMessage("claude-work", {
      _tag: "ClaudeAgentSdkQueryRunnerError",
      cause: old,
    });
    assert.include(message, "claude-work");
    assert.include(message, "cannot run Houston's tool check");
    assert.include(message, "Settings ▸ Providers");
    const unregistered = new Error(
      'This session was already running and did not register your hooks, so a hook set to onFailure: "block" would never run.',
    );
    assert.include(
      claudeBotToolCheckUnsupportedMessage("claude-work", unregistered),
      "cannot run Houston's tool check",
    );
  });

  it("leaves every other failure as it was", () => {
    assert.isUndefined(
      claudeBotToolCheckUnsupportedMessage("claude-work", new Error("socket hang up")),
    );
    assert.isUndefined(claudeBotToolCheckUnsupportedMessage("claude-work", undefined));
  });
});

describe("the live process key of a bot thread", () => {
  const policy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy({
    runtimeMode: "auto",
    interactionMode: "default",
    cwd: "/workspace",
  });
  const key = (houstonBot?: HoustonBotProviderPolicy) =>
    ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(policy, {}, houstonBot);

  it("holds the rules, not the instructions or the name", () => {
    const unattended = providerPolicy("unattended");
    assert.notEqual(key(unattended), key(providerPolicy("asked")));
    assert.notEqual(key(unattended), key({ ...unattended, refusedTools: [] }));
    assert.equal(key(unattended), key({ ...unattended, instructionsAppend: "changed" }));
    assert.equal(key(unattended), key({ ...unattended, botName: "Renamed" }));
  });

  it("is unchanged for an ordinary thread", () => {
    assert.equal(key(), JSON.stringify({ runtimePolicy: JSON.parse(key()).runtimePolicy }));
  });
});

describe("Houston's tools pre-approved in a bot thread", () => {
  it("are the bot's list by name instead of the wildcard", () => {
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: { endpoint: "http://127.0.0.1:1/mcp", authorizationHeader: "Bearer t" } as never,
      readOnlySandbox: false,
      houstonBotTools: ["houston_thread_read", "houston_bot_result"],
    });
    assert.deepEqual(overrides.allowedTools, [
      "mcp__houston__houston_thread_read",
      "mcp__houston__houston_bot_result",
    ]);
  });
});

describe("calls a frame shows to have started", () => {
  it("reads progress and results, and tells a result Claude Code wrote without running anything", () => {
    const progress = {
      type: "tool_progress",
      tool_use_id: "a",
      tool_name: "Bash",
    } as unknown as SDKMessage;
    assert.deepEqual(claudeStartedToolCalls(progress), [{ toolUseId: "a", unrun: false }]);
    const results = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "b", content: "ok" },
          {
            type: "tool_result",
            tool_use_id: "c",
            is_error: true,
            content: "<tool_use_error>Error: No such tool available: Imaginary</tool_use_error>",
          },
          { type: "text", text: "ignored" },
        ],
      },
    } as unknown as SDKMessage;
    assert.deepEqual(claudeStartedToolCalls(results), [
      { toolUseId: "b", unrun: false },
      { toolUseId: "c", unrun: true },
    ]);
  });
});
