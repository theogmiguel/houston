import { assert, describe, it } from "@effect/vitest";

import { policyFor } from "./kinds.ts";
import { connectorCallReads, decideToolCall, ghCommandReads } from "./toolRules.ts";

const bot = { askedMode: "auto", unattendedFullAccess: false, maxMinutes: 20 } as const;
const unattended = policyFor({ kind: "unattended", bot });
const asked = policyFor({ kind: "asked", bot });

const decide = (
  policy: typeof unattended,
  toolName: string,
  toolInput: unknown = {},
  mcpServer?: { readonly name: string },
) =>
  decideToolCall({
    refusedTools: policy.refusedTools,
    rules: policy.rules,
    toolName,
    toolInput,
    ...(mcpServer === undefined ? {} : { mcpServer }),
  });

describe("connector calls, unattended", () => {
  // [tool part of the name, allowed]
  const NAMES: ReadonlyArray<readonly [string, boolean]> = [
    ["search_items", true],
    ["send_item", false],
    ["frobnicate", false],
    ["get_issue", true],
    ["list_issues", true],
    ["read_file", true],
    ["fetch", true],
    ["query_database", true],
    ["find_users", true],
    ["lookup_user", true],
    ["view_page", true],
    ["describe_table", true],
    ["getIssue", true],
    ["listPullRequests", true],
    ["searchMessages", true],
    ["readResource", true],
    ["fetchDocument", true],
    ["get-page", true],
    ["search.files", true],
    ["GetUserProfile", true],
    ["get_merge_request", false],
    ["get_draft", false],
    ["create_issue", false],
    ["update_issue", false],
    ["delete_page", false],
    ["post_message", false],
    ["write_file", false],
    ["remove_label", false],
    ["add_comment", false],
    ["set_status", false],
    ["edit_page", false],
    ["move_card", false],
    ["archive_channel", false],
    ["schedule_meeting", false],
    ["upload_file", false],
    ["reply_to_thread", false],
    ["comment", false],
    ["invite_user", false],
    ["publish_post", false],
    ["execute_query", false],
    ["run_workflow", false],
    ["merge_pull_request", false],
    ["close_issue", false],
    ["assign_issue", false],
    ["share_document", false],
    ["apply_patch", false],
    ["draft_reply", false],
    ["sendMessage", false],
    ["createPullRequest", false],
    ["listAndDeleteItems", false],
    // The known hole: a read-named tool whose other words are not on the write list.
    ["searchAndReplace", true],
    ["getOrCreateUser", false],
    ["read_and_send", false],
    ["notify", false],
    ["ping", false],
    ["sync", false],
    ["", false],
    ["123", false],
    ["get", true],
    ["searchArchive", false],
  ];

  it("names sixty connector tools and decides each by the verbs in its name", () => {
    assert.lengthOf(NAMES, 60);
    for (const [tool, allowed] of NAMES) {
      assert.strictEqual(connectorCallReads(tool), allowed, tool);
      const decision = decide(unattended, `mcp__sample__${tool}`);
      assert.strictEqual(decision.allow, allowed, tool);
    }
  });

  it("treats a call that names its server as a connector call whatever the tool is called", () => {
    assert.isFalse(decide(unattended, "send_item", {}, { name: "sample" }).allow);
    assert.isTrue(decide(unattended, "search_items", {}, { name: "sample" }).allow);
  });

  it("refuses every browser tool", () => {
    for (const tool of ["tabs_context_mcp", "read_page", "get_page_text", "find"]) {
      assert.isFalse(decide(unattended, `mcp__claude-in-chrome__${tool}`).allow, tool);
    }
  });

  it("allows every connector call in an asked bot run", () => {
    assert.isTrue(decide(asked, "mcp__sample__send_item").allow);
    assert.isTrue(decide(asked, "mcp__sample__frobnicate").allow);
  });
});

describe("Houston's own tools", () => {
  it("allows only the listed names unattended, whatever server is called houston", () => {
    assert.isTrue(decide(unattended, "mcp__houston__houston_thread_read").allow);
    assert.isTrue(decide(unattended, "mcp__houston__houston_bot_result").allow);
    assert.isTrue(
      decide(unattended, "mcp__houston__houston_thread_list", {}, { name: "houston" }).allow,
    );
    for (const tool of [
      "delegate_task",
      "houston_thread_send",
      "create_issue",
      "comment_on_issue",
    ]) {
      assert.isFalse(decide(unattended, `mcp__houston__${tool}`).allow, tool);
      assert.isFalse(decide(unattended, `mcp__houston__${tool}`, {}, { name: "houston" }).allow);
    }
  });

  it("refuses Houston's scheduling tools in both kinds", () => {
    for (const policy of [asked, unattended]) {
      for (const tool of ["schedule_task", "delete_scheduled_task", "run_scheduled_task_now"]) {
        assert.isFalse(decide(policy, `mcp__houston__${tool}`).allow, tool);
      }
    }
    assert.isTrue(decide(asked, "mcp__houston__delegate_task").allow);
  });
});

describe("built-in tools", () => {
  it("refuses timers in both kinds", () => {
    for (const policy of [asked, unattended]) {
      for (const tool of [
        "CronCreate",
        "CronDelete",
        "CronList",
        "ScheduleWakeup",
        "RemoteTrigger",
      ]) {
        assert.isFalse(decide(policy, tool).allow, tool);
      }
    }
  });

  it("refuses a tool a later CLI adds when unattended, and allows it when asked", () => {
    assert.isFalse(decide(unattended, "FutureTool").allow);
    assert.isTrue(decide(asked, "FutureTool").allow);
    assert.isTrue(decide(unattended, "Read").allow);
    assert.isFalse(decide(unattended, "Monitor").allow);
    assert.isFalse(decide(unattended, "Agent").allow);
  });

  it("names the tool in a refusal", () => {
    const decision = decide(unattended, "Monitor");
    assert.isFalse(decision.allow);
    if (!decision.allow) assert.include(decision.reason, "Monitor");
  });
});

describe("gh in a shell command, unattended", () => {
  const READS = [
    "gh pr list",
    "gh pr view 12 --json title",
    "gh -R owner/repo issue view 3",
    "gh --repo owner/repo pr checks 4",
    "gh run list --limit 5",
    "gh release view v1",
    "gh repo view",
    "gh pr diff 7",
    "gh search issues bots",
    "gh api repos/o/r/pulls",
    "gh api graphql --paginate",
    "git status && gh pr status",
    "echo gh",
    "git commit -m 'fix the gh call'",
    "ls | grep gh",
  ];
  const WRITES = [
    "gh api -X POST repos/o/r/issues",
    "gh api --method=PATCH repos/o/r",
    "gh api repos/o/r/issues -f title=x",
    "gh api repos/o/r/issues -Ftitle=x",
    "gh api repos/o/r --input body.json",
    "gh -R o/r issue create --title x",
    "gh label create bug",
    "gh issue transfer 3 o/other",
    "gh workflow run ci.yml",
    "gh pr merge 4",
    "gh pr comment 4 --body x",
    "gh",
    "git status; gh issue close 3",
    "true || gh pr create",
    "ls\ngh issue edit 3",
    "FOO=1 gh issue delete 3",
    "env gh pr merge 1",
    "bash -c 'gh issue create'",
    "echo 'unbalanced && gh pr merge 1",
    "echo $(gh issue create)",
    "/usr/bin/gh pr merge 1",
  ];

  it("allows reads", () => {
    for (const command of READS) assert.isTrue(ghCommandReads(command), command);
  });

  it("refuses writes, unknown subcommands and commands it cannot split", () => {
    for (const command of WRITES) assert.isFalse(ghCommandReads(command), command);
  });

  it("checks Bash and PowerShell commands unattended, and leaves asked bot runs alone", () => {
    assert.isFalse(decide(unattended, "Bash", { command: "gh pr merge 1" }).allow);
    assert.isFalse(decide(unattended, "PowerShell", { command: "gh pr merge 1" }).allow);
    assert.isTrue(decide(unattended, "Bash", { command: "gh pr view 1" }).allow);
    assert.isTrue(decide(asked, "Bash", { command: "gh pr merge 1" }).allow);
  });

  it("refuses a shell call whose command is not text", () => {
    assert.isFalse(decide(unattended, "Bash", { command: 3 }).allow);
  });
});
