import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@houston-app/contracts";
import { McpProviderSessions } from "@houston-app/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import { AssetSigner } from "../assets/AssetSigner.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { HoustonMergeQueueProject } from "../houston/mergeQueue/Project.ts";
import { HoustonMergeQueueService } from "../houston/mergeQueue/Service.ts";
import { HoustonSlackConversation } from "../houston/slack/Conversation.ts";
import { HoustonTaskRuns } from "../houston/tasks/TaskRuns.ts";
import { HoustonTaskService } from "../houston/tasks/TaskService.ts";
import { IssueService } from "../issue/IssueService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import { PeerForwarding } from "../peer/PeerForwarding.ts";
import { PeerLinkRequests } from "../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { RemoteDelegation } from "../peer/RemoteDelegation.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { PreviewBrowser } from "../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { ThreadIssueService } from "../orchestration-v2/ThreadIssueService.ts";
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";
import { DocumentText } from "./DocumentText.ts";
import { EnvironmentThemeService } from "../environmentTheme.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";
import budget from "./agentContextBudget.json" with { type: "json" };
import { layerNoWorkspaces } from "../houston/workspaceToolkit/workspaceToolkit.testkit.ts";

// Registration only stores tool definitions, so the handlers' services are never called.
const toolHandlerServices = Layer.mergeAll(
  Layer.mock(AssetSigner)({}),
  Layer.mock(EnvironmentAuth)({}),
  Layer.mock(DeviceService)({}),
  Layer.mock(DocumentText)({}),
  Layer.mock(EnvironmentThemeService)({}),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(IssueService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions)({}),
  Layer.mock(OrchestratorV2)({}),
  Layer.mock(PeerForwarding)({}),
  Layer.mock(PeerLinkRequests)({}),
  Layer.mock(PeerLinks)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(ProjectCloneTracker)({}),
  Layer.mock(ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService)({}),
  Layer.mock(RemoteDelegation)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(SecretRequests)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "houston-agent-context-budget-" }),
  Layer.mock(ServerEnvironment)({}),
  Layer.mock(ServerSecretStore)({}),
  Layer.mock(ServerSettingsService)({}),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(ThreadIssueService)({}),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService)({}),
  layerNoWorkspaces,
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
  Layer.mock(HoustonSlackConversation)({}),
  Layer.mock(HoustonMergeQueueProject)({}),
  Layer.mock(HoustonMergeQueueService)({}),
  Layer.mock(HoustonTaskRuns)({}),
  Layer.mock(HoustonTaskService)({}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

const claudeSystemAppend = () => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
      model: "claude-opus-5-5",
    },
    nativeThreadId: "context-budget",
    resume: false,
    cwd: null,
    mcpServers: { houston: { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  return typeof systemPrompt === "object" && "append" in systemPrompt ? systemPrompt.append : "";
};

const codexAdditionalContext = () =>
  Object.values(
    buildCodexAdditionalContext(
      { model: "gpt-6.1-sol", modelName: "GPT-6.1 Sol", reasoningEffort: "high" },
      { browser: true, device: true },
    ),
  )
    .map((entry) => entry.value)
    .join("");

const layerAdvertisedTools = McpHttpServer.layerTools.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(toolHandlerServices),
);

type AdvertisedTool = {
  readonly tool: {
    readonly name: string;
    readonly description?: string | undefined;
    readonly inputSchema: unknown;
  };
  readonly annotations: Context.Context<never>;
};

// The model sees these fields. outputSchema and annotations are protocol metadata.
const toolListJsonBytes = (tools: ReadonlyArray<AdvertisedTool>) =>
  utf8Bytes(
    JSON.stringify(
      tools.map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    ),
  );

// A root thread's default credential: browser tools on, device tools off, no linked session.
const defaultRootThreadScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("context-budget"),
  capabilities: new Set<McpInvocationContext.McpCapability>([
    "orchestration",
    "worktree",
    "pull-requests",
    "issues",
    "preview",
  ]),
  issuedAt: 0,
  requestNamespace: "context-budget",
  thread: {
    threadId: ThreadId.make("context-budget"),
    providerSessionId: "context-budget",
    providerInstanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
  },
  client: undefined,
});

// EnabledWhen reads the Houston caller from the request fiber, so apply it inside the scope.
const toolsForScope = (
  tools: ReadonlyArray<AdvertisedTool>,
  scope: McpInvocationContext.McpInvocationScope,
): Effect.Effect<{
  readonly enabled: ReadonlyArray<AdvertisedTool>;
  readonly disabled: ReadonlyArray<AdvertisedTool>;
}> =>
  Effect.sync(() => {
    const isEnabled = (annotations: Context.Context<never>) => {
      const enabledWhen = Context.getOrUndefined(annotations, McpSchema.EnabledWhen);
      return (
        enabledWhen === undefined ||
        enabledWhen({
          protocolVersion: "2025-06-18",
          capabilities: McpSchema.ClientCapabilities.make({}),
        })
      );
    };
    const enabled: Array<AdvertisedTool> = [];
    const disabled: Array<AdvertisedTool> = [];
    for (const entry of tools) (isEnabled(entry.annotations) ? enabled : disabled).push(entry);
    return { enabled, disabled };
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));

// Claude Code loads these tools up front instead of behind ToolSearch, outside this budget.
it.effect("only request_secret asks Claude Code to load it up front", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const alwaysLoad = mcp.tools
      .filter(({ tool }) => tool._meta?.["anthropic/alwaysLoad"] !== undefined)
      .map(({ tool }) => [tool.name, tool._meta]);
    expect(alwaysLoad).toEqual([["request_secret", { "anthropic/alwaysLoad": true }]]);
  }).pipe(Effect.provide(layerAdvertisedTools)),
);

it.effect("a tool hidden from a default thread grows the registered total only", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const scope = defaultRootThreadScope();
    const { enabled, disabled } = yield* toolsForScope(mcp.tools, scope);
    // The registered set already holds tools a default thread never lists.
    expect(disabled.length).toBeGreaterThan(0);

    const hiddenProbe = {
      tool: {
        name: "context_budget_hidden_probe",
        description: "A tool no default thread lists.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      annotations: Context.make(McpSchema.EnabledWhen, () => false) as Context.Context<never>,
    };
    const registeredWithProbe = [...mcp.tools, hiddenProbe];
    const { enabled: defaultWithProbe } = yield* toolsForScope(registeredWithProbe, scope);

    expect(toolListJsonBytes(registeredWithProbe)).toBeGreaterThan(toolListJsonBytes(mcp.tools));
    expect(toolListJsonBytes(defaultWithProbe)).toBe(toolListJsonBytes(enabled));
    expect(defaultWithProbe.map(({ tool }) => tool.name)).not.toContain(hiddenProbe.tool.name);
  }).pipe(Effect.provide(layerAdvertisedTools)),
);

// CI rejects a PR that raises any value above main's agentContextBudget.json, so growth
// needs the agent-context-increase label. Lower the values when the text shrinks.
it.effect("agent context matches the committed budget", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const { enabled: defaultThreadTools } = yield* toolsForScope(
      mcp.tools,
      defaultRootThreadScope(),
    );
    const measured = {
      claudeSystemAppendBytes: utf8Bytes(claudeSystemAppend()),
      codexAdditionalContextBytes: utf8Bytes(codexAdditionalContext()),
      mcpToolListJsonBytes: toolListJsonBytes(mcp.tools),
      defaultThreadMcpToolListJsonBytes: toolListJsonBytes(defaultThreadTools),
    };

    expect(
      measured,
      "Set agentContextBudget.json to the measured values. Before you cut text to fit, run the evals that cover it (evals/README.md).",
    ).toEqual(budget);
  }).pipe(Effect.provide(layerAdvertisedTools)),
);
