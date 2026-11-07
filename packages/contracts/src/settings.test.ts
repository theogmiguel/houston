import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  globalIdleCompaction,
  idleCompactionPatch,
  requiredScopesForProjectMutation,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  VoiceTranscriptionDestination,
  withIdleCompaction,
} from "./settings.ts";
import { SETTINGS_SECRET_MAX_BYTES } from "./settingsSecretValue.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeProviderInstanceEnvironment = Schema.encodeSync(ProviderInstanceEnvironment);
const decodeProviderInstanceEnvironment = Schema.decodeSync(ProviderInstanceEnvironment);
// The environment variable shape builds released before secret references decode.
const decodeStringOnlyEnvironment = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ name: Schema.String, value: Schema.String, sensitive: Schema.Boolean }),
  ),
);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeServerSettingsPatch = Schema.encodeSync(ServerSettingsPatch);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });

  it("ignores an invalid model filter without dropping the other settings", () => {
    const valid = { include: [{ provider: "newer-provider", model: "orbit-1" }] };
    expect(decodeServerSettings({ usageModelFilter: valid }).usageModelFilter).toEqual(valid);
    const settings = decodeServerSettings({
      usageModelFilter: { exclude: [{ model: "" }] },
      usageModelAliases: { "drift-9": "orbit-1" },
    });
    expect(settings.usageModelFilter).toBeUndefined();
    expect(settings.usageModelAliases).toEqual({ "drift-9": "orbit-1" });
  });
});

it("drops a hand-edited non-string hidden tag and keeps the rest of the settings", () => {
  const settings = decodeServerSettings({
    hiddenThreadTags: ["private", 123],
    hideTaggedThreads: true,
  });
  expect(settings.hiddenThreadTags).toEqual(["private"]);
  expect(settings.hideTaggedThreads).toBe(true);
});

describe("ServerSettings secret providers", () => {
  const onePassword = (account: string) => ({
    kind: "one_password",
    label: "Personal",
    config: { account },
  });

  it("keeps an unknown kind or a longer label from invalidating the rest of the settings", () => {
    const openbao = { kind: "openbao", label: "V".repeat(65), config: { address: "https://x" } };
    const decoded = decodeServerSettings({
      worktreesDirectory: "/work",
      secretProviders: { vault: openbao, personal: onePassword("my.1password.com") },
    });
    expect(decoded.worktreesDirectory).toBe("/work");
    expect(encodeServerSettings(decoded).secretProviders).toEqual({
      vault: openbao,
      personal: onePassword("my.1password.com"),
    });
  });

  it("accepts slug ids and null removals but no id that is not a slug", () => {
    expect(
      decodeServerSettingsPatch({
        secretProviders: { "1password": onePassword("my.1password.com"), work: null },
      }).secretProviders,
    ).toEqual({ "1password": onePassword("my.1password.com"), work: null });
    for (const id of ["", "My Vault", "a/b", "-vault"]) {
      expect(() =>
        decodeServerSettingsPatch({ secretProviders: { [id]: onePassword("my.1password.com") } }),
      ).toThrow();
    }
    expect(() =>
      decodeServerSettingsPatch({
        secretProviders: { work: { ...onePassword("my.1password.com"), label: "V".repeat(65) } },
      }),
    ).toThrow();
  });

  it("stores a provider environment secret reference in a layout older builds still decode", () => {
    const providerInstances = (secret: unknown) => ({
      codex: {
        driver: "codex",
        environment: [
          { name: "OPENAI_API_KEY", sensitive: true, value: "", secret },
          { name: "BASE_URL", value: "https://example.test" },
        ],
      },
    });
    const secret = { provider: "personal", reference: "op://Private/OpenAI/credential" };
    const environment = decodeServerSettings({ providerInstances: providerInstances(secret) })
      .providerInstances[ProviderInstanceId.make("codex")]?.environment;
    expect(environment).toEqual([
      { name: "OPENAI_API_KEY", value: secret, sensitive: true },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);

    const encoded = encodeProviderInstanceEnvironment(environment ?? []);
    expect(encoded).toEqual([
      { name: "OPENAI_API_KEY", value: "", sensitive: true, secret },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);
    expect(decodeProviderInstanceEnvironment(encoded)).toEqual(environment);
    expect(decodeStringOnlyEnvironment(encoded)).toEqual([
      { name: "OPENAI_API_KEY", value: "", sensitive: true },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);

    for (const invalid of [
      { provider: "My Vault", reference: "op://a/b/c" },
      { provider: "personal", reference: " " },
      { provider: "personal", reference: "op://Private/OpenAI\n/credential" },
      { provider: "personal", reference: "x".repeat(1025) },
    ]) {
      expect(() =>
        decodeServerSettings({ providerInstances: providerInstances(invalid) }),
      ).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("Claude in Chrome and Artifacts settings", () => {
  it("turns both switches on when they are absent", () => {
    const settings = decodeClaudeSettings({});
    expect(settings.claudeInChrome).toBe(true);
    expect(settings.claudeArtifacts).toBe(true);
  });

  it("keeps either explicit value", () => {
    expect(decodeClaudeSettings({ claudeInChrome: false }).claudeInChrome).toBe(false);
    expect(decodeClaudeSettings({ claudeArtifacts: false }).claudeArtifacts).toBe(false);
    expect(decodeClaudeSettings({ claudeArtifacts: true }).claudeArtifacts).toBe(true);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to the pill", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("pill");
  });

  it.each(["artwork", "nightly-artwork", "dev-artwork", "pill", "none"])(
    "still decodes the stored mode %s",
    (mode) => {
      expect(decodeClientSettings({ environmentIdentificationMode: mode })).toMatchObject({
        environmentIdentificationMode: mode,
      });
    },
  );
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("ClientSettings animations", () => {
  it("plays animations by default", () => {
    expect(decodeClientSettings({}).animationsEnabled).toBe(true);
  });

  it("ignores the retired panel animation duration", () => {
    const settings = decodeClientSettings({ panelAnimationDurationMs: 150 });

    expect(settings.animationsEnabled).toBe(true);
    expect(encodeClientSettings(settings)).not.toHaveProperty("panelAnimationDurationMs");
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("ServerSettings project overrides across versions", () => {
  it("sends back an override key from a newer server when an older client edits the entry", () => {
    const projectId = ProjectId.make("project-a");
    // As an older client reads a newer server's settings, with one key it does not know.
    const entry = decodeServerSettings({
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, addedByNewerServer: { mode: "kept" } },
      },
    }).projectSettingsOverrides[projectId];

    const sent = encodeServerSettingsPatch({
      projectSettingsOverrides: { [projectId]: { ...entry, defaultAutoPull: false } },
    });

    expect(decodeServerSettingsPatch(sent).projectSettingsOverrides?.[projectId]).toEqual({
      defaultAutoPull: false,
      addedByNewerServer: { mode: "kept" },
    });
  });
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});

describe("ClientSettings microphone", () => {
  it("defaults to auto dictation and accepts the other shortcut modes", () => {
    expect(decodeClientSettings({}).voiceShortcutMode).toBe("auto");
    expect(decodeClientSettingsPatch({ voiceShortcutMode: "hold" }).voiceShortcutMode).toBe("hold");
    expect(decodeClientSettingsPatch({ voiceShortcutMode: "toggle" }).voiceShortcutMode).toBe(
      "toggle",
    );
    expect(() => decodeClientSettingsPatch({ voiceShortcutMode: "invalid" })).toThrow();
  });
  it("accepts microphone selection patches", () => {
    expect(decodeClientSettingsPatch({ voiceMicrophone: "studio-mic" }).voiceMicrophone).toBe(
      "studio-mic",
    );
  });

  it("keeps dictation preferences on the device and drops the old environment pin", () => {
    const decoded = decodeClientSettings({
      voiceTranscriptionEnvironmentId: "environment-2",
      speechPostProcessingEnabled: true,
    });
    expect(decoded).not.toHaveProperty("voiceTranscriptionEnvironmentId");
    expect(decoded).not.toHaveProperty("speechPostProcessingEnabled");
    expect(decoded).toMatchObject({
      speechLanguage: "auto",
      speechTranslateToEnglish: false,
      speechCustomWords: [],
      speechSilenceFiltering: true,
      speechRemoveFillerWords: true,
      speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
      speechCorrectionWord: "",
    });
    expect(() => decodeClientSettingsPatch({ speechCorrectionWord: "x".repeat(51) })).toThrow();
  });
});

describe("VoiceTranscriptionDestination", () => {
  const decode = Schema.decodeUnknownSync(VoiceTranscriptionDestination);
  const environmentId = "environment-1";

  it("keeps decoding an environment destination", () => {
    expect(decode({ kind: "environment", environmentId })).toEqual({
      kind: "environment",
      environmentId,
    });
  });

  it("accepts a cloud grant per provider and requires an exact model for OpenRouter", () => {
    for (const provider of ["openai", "xai"]) {
      expect(decode({ kind: "cloud", environmentId, provider })).toMatchObject({ provider });
    }
    expect(() => decode({ kind: "cloud", environmentId, provider: "openrouter" })).toThrow();
    expect(
      decode({ kind: "cloud", environmentId, provider: "openrouter", model: "acme/voice-1" }),
    ).toMatchObject({ model: "acme/voice-1" });
    expect(() =>
      decode({ kind: "cloud", environmentId, provider: "openrouter", model: "openrouter/auto" }),
    ).toThrow();
  });
});

describe("ServerSettings cloud speech credentials", () => {
  it("defaults to no keys and accepts literals and references per provider", () => {
    expect(DEFAULT_SERVER_SETTINGS.cloudSpeechCredentials).toEqual({
      openai: "",
      xai: "",
      openrouter: "",
    });
    const reference = { provider: "vault", reference: "voice/key" };
    expect(
      decodeServerSettingsPatch({ cloudSpeechCredentials: { openai: "sk-1", xai: reference } }),
    ).toEqual({ cloudSpeechCredentials: { openai: "sk-1", xai: reference } });
  });

  it("refuses a key over the credential bound, naming the sizes", () => {
    const oversize = "k".repeat(SETTINGS_SECRET_MAX_BYTES + 1);
    expect(() =>
      decodeServerSettingsPatch({ cloudSpeechCredentials: { openrouter: oversize } }),
    ).toThrow(`over the limit of ${SETTINGS_SECRET_MAX_BYTES} bytes`);
  });
});

describe("ServerSettings speech", () => {
  it("stores the model and resources on the environment", () => {
    expect(DEFAULT_SERVER_SETTINGS).toMatchObject({
      speechModelId: "handy-computer/parakeet-unified-en-0.6b-gguf",
      speechAcceleration: "auto",
      speechModelUnloadTimeout: "min_15",
      speechProjectCustomWords: [],
      speechPostProcessingModelSelection: null,
    });
    expect(DEFAULT_SERVER_SETTINGS).not.toHaveProperty("speechLanguage");
    expect(DEFAULT_SERVER_SETTINGS).not.toHaveProperty("speechCustomWords");
    expect(DEFAULT_SERVER_SETTINGS).not.toHaveProperty("speechPostProcessingEnabled");
    expect(PROJECT_SCOPED_SERVER_SETTING_KEYS).toContain("speechProjectCustomWords");
  });

  it("decodes the cleanup model that older servers defaulted to as unset", () => {
    const legacyDefault = {
      instanceId: "codex",
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    expect(
      decodeServerSettings({ speechPostProcessingModelSelection: legacyDefault })
        .speechPostProcessingModelSelection,
    ).toBeNull();
    const chosen = { instanceId: "codex", model: "gpt-6-luna", options: [] };
    expect(
      decodeServerSettings({ speechPostProcessingModelSelection: chosen })
        .speechPostProcessingModelSelection,
    ).toEqual(chosen);
    expect(
      decodeServerSettingsPatch({ speechPostProcessingModelSelection: null })
        .speechPostProcessingModelSelection,
    ).toBeNull();
  });

  it("reads the retired dictation keys only through legacySpeech", () => {
    const legacySpeech = {
      speechLanguage: "pt",
      speechCustomWords: [{ term: "Houston", aliases: [] }],
      speechPostProcessingPrompt: { mode: "custom" as const, customInstructions: "Keep names." },
    };
    expect(decodeServerSettings({ legacySpeech }).legacySpeech).toEqual(legacySpeech);
    expect(decodeServerSettings({ speechLanguage: "pt" })).not.toHaveProperty("speechLanguage");
    expect(() => decodeServerSettings({ legacySpeech: { speechLanguage: "x" } })).toThrow();
  });
});

describe("ClientSettings composer context strip", () => {
  it("shows the strip in active threads unless the user turned it off", () => {
    expect(decodeClientSettings({}).persistComposerContextStrip).toBe(true);
    expect(
      decodeClientSettings({ persistComposerContextStrip: false }).persistComposerContextStrip,
    ).toBe(false);
  });
});
