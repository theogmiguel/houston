# Wire protocol v112

Transport: one WebSocket at `ws://127.0.0.1:<port>/ws`, served by the daemon
(`core/houston-core/src/server.rs`). Auth: a bearer token in the first message —
the renderer reads `{port, token}` from the Tauri `host_config` command
(`src-tauri/src/host.rs`, reporting the daemon the app itself started), while
helpers and scripts read the same pair from the channel's `daemon.json` (mode
0600, written after bind). Schema source of truth:
`core/houston-protocol/src/lib.rs`, which owns `PROTOCOL_VERSION` and every
message and payload type; the TypeScript mirror is generated from it by
`scripts/gen-protocol-types.sh` and committed under
`ui/src/renderer/src/houston/generated/`. The version must match **exactly** on
both sides — no negotiation, no compatibility window.

## Handshake

The first client message MUST be `hello` —
`{"type":"hello","token":"<uuid>","protocol":81}`. Anything else gets an `error`
and the socket closes.

- Version is compared first: `protocol != PROTOCOL_VERSION` is an `error` naming
  both numbers, then close. The token is then compared in constant time; a
  mismatch is `error: invalid token`, then close.
- On success the server sends `hello_ok` (protocol, current sessions,
  workspaces, optional boot-recovery summary, the daemon's safe-mode flags).
- A second `hello` after auth is answered `error: already authenticated` and
  the socket stays open.

## Framing

**Text frames** are JSON control messages, externally tagged by a `type` field
in `snake_case` (`{"type":"session_resize","session":7,"cols":120,"rows":40}`).
Unparseable text is answered with an `error` carrying the first 200 characters
of the offending payload as `context`.

**Binary frames** carry PTY bytes and never pass through JSON or base64. All
multi-byte integers are big-endian.

```
FRAME_OUTPUT = 1  server → client, raw PTY bytes      header 13 (FRAME_OUTPUT_HEADER_LEN)
  [0] u8 kind=1 | [1..5] u32 session | [5..13] u64 offset of the first payload byte | [13..] payload
FRAME_STDIN = 2   client → server, raw keystrokes     header 5 (FRAME_STDIN_HEADER_LEN)
  [0] u8 kind=2 | [1..5] u32 session | [5..] payload
FRAME_GAP = 3     server → client, this connection fell behind   exactly 21 bytes (FRAME_GAP_LEN)
  [0] u8 kind=3 | [1..5] u32 session | [5..13] u64 bytes_seen (where loss began) | [13..21] u64 dropped | no payload
```

Output frames are **opt-in per connection**. The daemon sends them only for
sessions this socket has asked about: `session_attach`, `session_visibility`
with `visible: true`, or having created the session on this socket
(`session_create` / `session_respawn`). `session_visibility{visible:false}`
withdraws one. The PTY is always drained daemon-side, so an agent never blocks
on a pane nobody is watching, and scrollback keeps recording either way. Stdin
frames are accepted for any live session; a write failure comes back as an
`error` with `context: "stdin"`.

**Frames are bounded per connection and per session, by payload bytes.** Each
socket owns one queue per session it takes frames for, capped at 4 MiB of
payload (an item-count safety net exists too, but at 4096 items it is not
what a real flood trips); the PTY is always drained daemon-side, so a client
that stops reading fills only its own queues and slows nobody else. A frame
contiguous with whatever the queue is currently holding merges into it
instead of taking a new slot, up to a 256 KiB per-item ceiling, so a message
on the wire can be larger than any single PTY read. When a queue drops, the
loss is a `FRAME_GAP`: `bytes_seen` is the stream offset loss began at,
`dropped` the payload bytes lost from there, and it is written after every frame
that preceded the loss and before the first that survived it (or on its own,
when nothing followed). The client answers with exactly one `session_attach`; the
reply marks the replay start (below). A gap is never a log line, and a log line is
never a gap.

**Control messages ride a separate broadcast** with its own bound. A connection
that falls that far behind cannot be repaired in place — a lifecycle event it
never saw is gone — so the daemon sends an `error` with `context: "control_lag"`
and closes the socket; the client reconnects and `hello_ok` carries the whole
state again.

**Base64 appears twice on this wire, for the same reason both times:** the
`scrollback` replay and the `attach_snapshot` state. Both ride the JSON channel
so they order against the `session_attach` that asked for them on the same
socket; the binary channel carries PTY bytes and nothing else.

## Client → server

Every message below is a variant of `ClientMsg`; `?` marks an optional field.
"direct" = to the asking connection only, "bcast" = to every connection. Any
failure not given a typed refusal comes back as `error`.

### Session and pane

| Message | Fields | Reply |
|---|---|---|
| `hello` | `token`, `protocol` | `hello_ok` (direct), or `error` + close |
| `session_create` | `agent: AgentKind`, `project_dir`, `cmd?: string[]` (required for `custom`), `cols?`/`rows?` (default 80×24), `cwd_from?: u32` (start in that session's live cwd), `shell_integration?` (default true), `auto_approve?` (default false; refused for a kind with no bypass flag), `acp?` (slug from the ACP roster; refused with `cmd`), `profile?: ProfileChoice`, `prompt?` (initial task, delivered as argv, or as a `.houston/prompts/` file the child is told to read once it is over the argv-safe threshold) | `session_created` (bcast); this socket starts receiving that session's frames |
| `session_kill` | `session`, `confirm_children?` | `session_state` (bcast); refused `live_children_confirmation_required:` when the pane has live children and `confirm_children` is not set |
| `session_close` | `session`, `confirm_children?` | `session_removed` (bcast); same children refusal |
| `session_respawn` | `session`, `shell_integration?`, `cwd?` (must exist), `shell?` (absolute shell binary, shell panes only), `force?` (restart a still-live session: kill, reap, respawn — without it a live session is refused by name) | broadcasts; a failed spawn leaves the husk intact |
| `session_resize` | `session`, `cols`, `rows` | `session_resized` (direct) |
| `session_list` | — | `session_list` (direct) |
| `session_attach` | `session`, `replay_bytes?` (cap the tail; omitted = whole ring), `snapshot?` (v94: ask for emulator state instead of a byte replay) | `scrollback` **or** `attach_snapshot` (direct), numbered by `attempt`; this socket starts receiving that session's frames, and nothing below the reply's cutoff follows it. `snapshot: true` is answered with `attach_snapshot` when the daemon has an emulator and could encode one, and with `scrollback` otherwise — a client must handle either reply |
| `session_rename` | `session`, `title` (trimmed, non-empty, ≤ 40 chars) | `session_renamed` (bcast) |
| `session_set_tags` | `session`, `tags: u32[]` (registry ids, ≤ `MAX_TAGS_PER_SESSION` (5), whole-set replacement) | `session_tags_set` (bcast); unknown session or tag id, or over the cap, is an `error` naming the limit and the value |
| `tag_create` | `name` (trimmed, non-empty, ≤ `MAX_TAG_NAME_LEN` (32) chars, unique case-insensitively), `color` (`#rrggbb` from `TAG_PALETTE`) | `tag_list` (bcast); collisions and non-palette colors are `error`s naming the offending value |
| `tag_update` | `tag`, `name`, `color` (same rules as `tag_create`) | `tag_list` (bcast); sessions follow — they carry the id |
| `tag_delete` | `tag` | `tag_list` + `tag_deleted` (bcast); detaches from every session carrying it (the caller owns the confirm) |
| `session_reparent` | `session`, `project_dir` | `session_reparented` (bcast) |
| `session_cwd` | `session` | `session_cwd` (direct) — live cwd, resolved |
| `session_cwds` | `sessions: u32[]` | `session_cwds` (direct); unknown ids degrade to `cwd: null` |
| `session_running_procs` | `sessions: u32[]` | `session_running_procs` (direct) |
| `session_visibility` | `session`, `visible` | none; changes this socket's frame filter |
| `wait_for_idle` | `request`, `session`, `timeout_ms?` (default 10000, cap 120000), `idle_quiet_ms?` (default 500, cap 30000) | `idle` (bcast), keyed by `request` |
| `session_policy_get` | — | `session_policy` (direct) |
| `session_policy_set` | `policy: SessionPolicy` | `session_policy` (bcast) |
| `update_get` | — | `update` (direct) |
| `update_policy_set` | `policy: UpdatePolicy` | `update` (bcast) |
| `update_check_now` | — | no direct reply; the daemon's check loop is woken and broadcasts `update` as the state moves |

### Workspace

| Message | Fields | Reply |
|---|---|---|
| `workspace_add` | `path` | `workspace_list` + `orchestration_state` (bcast) |
| `workspace_remove` | `path` | kills and removes every session rooted there; `workspace_list` + `orchestration_state` (bcast) |
| `workspace_rename` | `path`, `name` | `workspace_list` (bcast) |
| `workspace_list` | — | `workspace_list` (direct) |

### Orchestration

| Message | Fields | Reply |
|---|---|---|
| `orchestration_settings_get` | — | `orchestration_state` (direct) |
| `orchestration_set` | `enabled` | `orchestration_state` (bcast) — the one app-wide spawning switch; off by default |
| `orchestration_caps_set` | `max_live_children`, `max_spawn_depth` (both `1..=ORCHESTRATION_CAP_MAX`) | `orchestration_state` (bcast); out of range is an `error` naming cap and value |
| `inbox_list` | `workspace` | `inbox_rows` (direct) — every row addressed to the operator for that workspace |
| `inbox_ack` | `id` | `inbox_changed` (bcast); `error` naming the id if no operator row matched. Opening a row is delivery, not resolution |
| `inbox_resolve` | `id` | `inbox_changed` (bcast); `error` naming the id if no row matched. Writes `reason: "operator"` |
| `inbox_deliver_now` | `session` | v97, door 3: release the composer hold on that pane and deliver what it is owed. `inbox_changed` per row (bcast), or an `error` naming the session. The only way out of the hold for a pane whose CLI reports no submission boundary |

### Git and PR

| Message | Fields | Reply |
|---|---|---|
| `git_status` | `dir`, `base?` (branch name = branch-vs-base scope; unresolvable base is an `error`) | `git_status` (direct) |
| `git_diff` | `dir`, `path?` (absent = full patch), `base?` | `git_diff` (direct) |
| `git_branch` | `dir` | `git_branch` (direct); non-repo/detached yields `branch: null` |
| `git_stage` | `dir`, `paths` (empty = all) | fresh `git_status` (direct) |
| `git_unstage` | `dir`, `paths` (empty = all) | fresh `git_status` (direct) |
| `git_commit` | `dir`, `message` | `git_commit` then `git_status` (direct) |
| `git_push` | `dir` | fresh `git_status` (direct); `error` on failure |
| `git_discard` | `dir`, `path`, `kind: GitDiscardKind` | fresh `git_status` (direct). Absolute paths, `..` segments and sensitive paths are refused before any git call |
| `git_review_diffs` | `dir` | `git_review_diffs` (direct) — one pre-ship review bundle |
| `git_branches` | `dir` | `git_branches` (direct) — locals, remote-tracking branches and the default apart |
| `git_worktrees` | `dir` | `git_worktrees` (direct); a reply to a mutation carries the note in `message` |
| `git_checkpoints` | `dir` | `git_checkpoints` (direct) — every owner |
| `git_checkpoint_diff` | `dir`, `ref`, `against: GitCheckpointAgainst` | `git_checkpoint_diff` (direct); the patch is redacted and capped like `git_diff` |
| `git_pull` | `dir` | `git_pull` (direct) with `pulled` or `up_to_date`; a conflict or a missing upstream is an `error` naming it. Fast-forward only |
| `git_fetch` | `dir` | `git_fetch` (direct) with `gh`'s summary line |
| `git_branch_create` | `dir`, `name`, `base?`, `switch_to` | fresh `git_branches` then `git_status` (both direct). A non-`check-ref-format` name is refused by name |
| `git_branch_switch` | `dir`, `name` | fresh `git_branches` then `git_status`; a remote-tracking name gets a local twin |
| `git_branch_rename` | `dir`, `from`, `to` | fresh `git_branches` then `git_status` |
| `git_branch_delete` | `dir`, `name`, `force` (`-D`; unmerged without it is refused) | fresh `git_branches` then `git_status` |
| `git_worktree_create` | `dir`, `name`, `base?` | `git_worktrees` carrying a `message` naming the new path and branch |
| `git_worktree_remove` | `dir`, `path`, `force` (a dirty worktree without it is refused) | `git_worktrees` carrying a `message` |
| `git_worktree_prune` | `dir` | `git_worktrees` carrying a `message` (the summary, or "Nothing to prune.") |
| `git_checkpoint_create` | `dir`, `label` (suffixed `-2`… on collision) | fresh `git_checkpoints` |
| `git_checkpoint_restore` | `dir`, `ref` | fresh `git_checkpoints` then `git_status`; the UI confirms first |
| `git_checkpoint_delete` | `dir`, `ref` | fresh `git_checkpoints` |
| `pr_status` | `dir` | `pr_status` (direct) — never `error` for a missing or unauthenticated `gh` |
| `pr_create` | `dir`, `title?`, `body?` (both = the caller's own text; absent = `gh pr create --fill`) | `pr_create` (direct) — same non-erroring `gh` contract |
| `pr_detail` | `dir`, `request`, `number?` (absent = the stored link, else the branch's own) | `pr_detail` (direct) — a `gh` problem is `gh` + `hint`, a failed read is `message` |
| `pr_link` | `dir`, `number` (positive), `request` | `pr_linked` then a fresh `pr_detail` carrying the same `request`; `number: 0` is refused by name |
| `pr_unlink` | `dir`, `request` | `pr_unlinked` then a fresh `pr_detail` carrying the same `request`; the reply names the number that was removed |
| `pr_merge` | `dir`, `number`, `method: PrMergeMethod`, `expected_head_sha`, `request` | `pr_merged` then a fresh `pr_detail` on success. The daemon re-reads the pull request, refuses a moved head, re-runs the merge gate, and calls `gh pr merge --match-head-commit`; never `--admin`, `--auto` or branch deletion |
| `pr_action` | `dir`, `number`, `action: PrAction`, `merge_method?` (auto-merge), `update_method?` (update-branch), `request` | `pr_mutation {kind: action}` then a fresh `pr_detail`. The daemon re-reads what GitHub says this viewer may do and refuses a missing permission by name before `gh` is called |
| `pr_edit` | `dir`, `number`, `title?`, `body?` (both absent is refused), `request` | `pr_mutation {kind: edit}` then a fresh `pr_detail` |
| `pr_comment` | `dir`, `number`, `body`, `request` | `pr_mutation {kind: comment}` then a fresh `pr_detail` |
| `pr_comment_edit` | `dir`, `number`, `comment_id`, `kind: PrCommentKind`, `body`, `request` | `pr_mutation {kind: comment_edit}` then a fresh `pr_detail` |
| `pr_review` | `dir`, `number`, `verdict: PrReviewVerdict`, `body`, `comments: PrReviewDraft[]`, `request` | `pr_mutation {kind: review}` then a fresh `pr_detail`; the whole review is one request, inline drafts included |
| `pr_thread_reply` | `dir`, `number`, `thread_id`, `body`, `request` | `pr_mutation {kind: thread_reply}` then a fresh `pr_detail` |
| `pr_thread_resolve` | `dir`, `number`, `thread_id`, `resolved`, `request` | `pr_mutation {kind: thread_resolve}` then a fresh `pr_detail` |
| `pr_reaction` | `dir`, `number`, `subject_id?` (absent = the pull request itself), `content: PrReaction`, `reacted`, `request` | `pr_mutation {kind: reaction}` then a fresh `pr_detail`; a subject that does not belong to `number` is refused |
| `pr_reviewers` | `dir`, `number`, `request` | `pr_reviewer_candidates` (direct) |
| `pr_reviewer_set` | `dir`, `number`, `reviewers: PrReviewer[]`, `requested`, `request` | `pr_mutation {kind: reviewer_set}` then a fresh `pr_detail` |
| `pr_labels` | `dir`, `number`, `request` | `pr_label_candidates` (direct) |
| `pr_label_set` | `dir`, `number`, `labels: string[]`, `applied`, `request` | `pr_mutation {kind: label_set}` then a fresh `pr_detail` |
| `pr_list` | `dir`, `state: PrListState`, `involvement: PrListInvolvement`, `query?`, `limit` (1–`PR_LIST_LIMIT_MAX`) | `pr_list` (direct); a limit over the cap is an `error` naming the cap and the value |
| `pr_diff` | `dir`, `number`, `request` | `pr_diff` (direct) — `gh pr diff --color never`, capped with `truncated` |
| `pr_stack` | `dir`, `number`, `request` | `pr_stack` (direct) — the host's own stack, `stack: null` where the preview answers 404 |
| `pr_stack_merge` | `dir`, `number`, `stack_number`, `heads: PrStackHead[]`, `merge_method?`, `request` | `pr_mutation {kind: action}` then a fresh `pr_detail`. Every open layer up to `number` must match `heads` and be open and non-draft; GitHub's async job is polled for up to two minutes |

### History

| Message | Fields | Reply |
|---|---|---|
| `history_clear` | `workspace?` (absent = all) | none |
| `history_count` | — | `history_count` (direct), counted across every workspace; no rows replies `count: 0` |
| `command_history_ignore_globs_get` | — | `command_history_ignore_globs` (direct) |
| `command_history_ignore_globs_set` | `globs: string[]` | `command_history_ignore_globs` (bcast); over `COMMAND_HISTORY_IGNORE_GLOBS_MAX` entries or `..._GLOB_LEN_MAX` bytes per entry is an `error`, list untouched |

### Handoff

| Message | Fields | Reply |
|---|---|---|
| `handoff_generate` | `session`, `provider: AgentKind`, `cmd?` | `handoff_started`, then `handoff_chunk`*, then `handoff_done` or `handoff_error` (all bcast) |
| `handoff_cancel` | `request` | the job ends with `handoff_error` |

### SSH

| Message | Fields | Reply |
|---|---|---|
| `ssh_connect` | `request`, `host`, `port?` (22), `user`, `auth: SshAuth`, `cols?`/`rows?`, `profile?` (name of a saved profile) | runs on its own task: possibly `ssh_host_key`, then `session_created` (bcast) or `error` naming the request |
| `ssh_host_key_answer` | `request`, `accept` | none; `accept` records the key (TOFU) and resumes |
| `ssh_upload_terminal_file` | `request`, `session` (must be a live SSH pane), `local_path`, `remote_name?` (a name: no `/`, no control chars, not `.`/`..`, ≤ 255 bytes) | `ssh_upload_done` (bcast) or `error`. Read by the daemon, streamed on a second channel of the same connection; cap 64 MiB; destination `$HOME/.houston/uploads/`, never clobbering |
| `ssh_profile_save` | `profile: SshProfile` (upsert by name; `last_used_at` is ignored) | `ssh_profiles` (bcast) |
| `ssh_profile_delete` | `name` | `ssh_profiles` (bcast) |
| `ssh_profile_list` | — | `ssh_profiles` (direct) |
| `ssh_credential_set` | `profile`, `password` | `ssh_profiles` (bcast). The only message carrying a credential — straight to the OS keychain, never stored in the DB, never echoed, never logged |
| `ssh_credential_clear` | `profile` | `ssh_profiles` (bcast) |
| `ssh_config_hosts` | — | `ssh_config_hosts` (direct) — importable single-literal-alias `Host` blocks from `~/.ssh/config` |

### Keymap and MCP

| Message | Fields | Reply |
|---|---|---|
| `keymap_get` | — | `keymap` (direct) |
| `keymap_set` | `overrides: KeymapOverrides` | `keymap` (bcast) |
| `mcp_state` | — | `mcp_state` (direct) — Houston's own server list plus what each tool has |
| `mcp_sync` | `tool: AgentKind \| null` (key required; `null` = all four tools) | `mcp_state` (bcast) with per-tool `results`. A server the user already configured under that name is skipped with a reason, never overwritten. Claude Code is written only via `claude mcp add`/`remove` |
| `mcp_import` | `tool: AgentKind` | `mcp_state` (bcast) — additive; removes nothing |
| `mcp_set_enabled` | `name`, `enabled` | `mcp_state` (bcast); an unknown name is refused naming it |
| `mcp_server_upsert` | `previous_name: string \| null`, `server: McpServer` | `mcp_state` (bcast) — create/edit/rename Houston's own list; apply via `mcp_sync` |
| `mcp_server_remove` | `name` | `mcp_state` (bcast) — remove from Houston's list; an explicit sync retracts managed copies |
| `mcp_test` | `name` | `mcp_state` (bcast, `checking` then a settled result) — a bounded MCP handshake |

### Profiles

| Message | Fields | Reply |
|---|---|---|
| `agent_profile_list` | — | `agent_profile_state` (direct) |
| `agent_profile_upsert` | `id?` (absent creates), `agent` (`claude`\|`codex` only), `name`, `config_dir` | `agent_profile_state` (bcast) |
| `agent_profile_delete` | `id` | `agent_profile_state` (bcast); clears the active pointer if it was active |
| `agent_profile_set_active` | `agent`, `id?` (absent clears) | `agent_profile_state` (bcast). Takes effect at the NEXT spawn; never mutates a running session |

### Routines

| Message | Fields | Reply |
|---|---|---|
| `routine_list` | — | `routines` (direct) |
| `routine_create` | `name` (≤ `ROUTINE_NAME_MAX`), `prompt` (non-empty, ≤ `ROUTINE_PROMPT_MAX`), `cadence: Cadence`, `workspace_id?` (the routine's own working directory), `engine?` (mandatory — the provider every run executes with), `model?` (the provider's model ID), `effort?` (only where that CLI exposes a per-run flag), `permission_mode?` (default `accept_edits`), `isolate?` (default false) | `routine_refused` (direct) for a cap or a duplicate folded name; `error` for an out-of-range value, for `isolate` without a git workspace, for `bypass_permissions` without `isolate`, for an unsupported effort/access combination, and for a create with no `engine`; `routines` (bcast) on success |
| `routine_update` | `id`, `expected_revision`, `name?`, `prompt?`, `cadence?`, `enabled?` (`false` = pause), `workspace_id?` (three-state: absent unchanged, `null` clears, string sets), `engine?`, `model?`/`effort?` (three-state: absent unchanged, `null` clears, value sets), `permission_mode?`, `isolate?` | `routine_refused` (direct) `not_found`\|`conflict`\|`duplicate_name`; invalid launch combinations are an `error`; `routines` (bcast) on success |
| `routine_delete` | `id`, `expected_revision` | `routine_refused` (direct) `not_found`\|`conflict`; `routines` (bcast) on success |
| `routine_run_now` | `id` | `routines` (bcast) on success — the run starts on exactly the scheduler's path, only `RoutineRun.trigger` differs; `routine_refused` (direct) `not_found`\|`already_running` (one routine runs one turn at a time) |
| `routine_runs` | `routine_id?` (absent lists every routine's) | `routine_runs` (direct) — the independent run records, newest first, at most `ROUTINE_RUNS_PAGE` |

### Skill sync and push

| Message | Fields | Reply |
|---|---|---|
| `skill_sync` | — | `skill_sync` (direct) — which skills each tool can see, compared by digest. With `auto_push_enabled`, this read also performs the drift push |
| `skill_push` | `tool`, `skill` (both keys required, either may be `null`; both `null` = every drifted skill into every non-Claude tool) | `skill_sync` (bcast). Claude Code is the source, never a target; every write is recorded so undo can reverse it |
| `skill_push_undo` | `tool`, `skill` | `skill_sync` (bcast); no record for that pair is a logged no-op |
| `skill_auto_push_set` | `enabled` (default off) | `skill_sync` (bcast) |

### Hooks

| Message | Fields | Reply |
|---|---|---|
| `agent_hooks` | — | `agent_hooks` (direct) — what is installed per provider, and the exact file each writes |
| `agent_hooks_set` | `provider: AgentKind`, `enabled` | `agent_hooks` (bcast). A failed install does not flip the setting; the refusal rides that provider's row |

### Voice

| Message | Fields | Reply |
|---|---|---|
| `voice_settings_get` | — | `voice_settings` (direct) |
| `voice_settings_set` | `settings: VoiceSettings` | `voice_settings` (bcast) — an open microphone is machine-wide state |
| `voice_key_set` | `provider: CloudStt`, `key` | `voice_settings` (bcast). Written to secret storage and **read back** before success; never echoed by any reply |
| `voice_key_clear` | `provider: CloudStt` | `voice_settings` (bcast) |
| `voice_devices_get` | — | `voice_devices` (direct); its own round trip because enumeration blocks |
| `voice_start` | `session` (the delivery target, fixed here) | `voice_state` (bcast) |
| `voice_stop` | `session` | `voice_transcript`, or `voice_state` carrying a `VoiceFailure` |
| `voice_model_download` | `model_id` | repeated `voice_model_state` (bcast); SHA-256 verified |
| `voice_model_delete` | `model_id` | `voice_model_state` + `voice_settings` (bcast) |
| `voice_level_monitor` | `enabled` | `voice_level` every `VOICE_LEVEL_INTERVAL_MS` while anyone is monitoring. Opens the microphone; refcounted per connection as a set, and released on disconnect |

### Host and usage

| Message | Fields | Reply |
|---|---|---|
| `host_info_get` | — | `host_info` (direct), never a broadcast — a point-in-time snapshot the client re-polls (~30 s is the recommended cadence) |
| `restore_budget_set` | `budget` (`0..=RESTORE_BUDGET_MAX`) | `host_info` (bcast); out of range is an `error` naming ceiling and value |
| `mailbox_retention_set` | `hours` (`1..=MAILBOX_RETENTION_HOURS_MAX`) | `host_info` (bcast); same refusal shape |
| `usage_summary_get` | `since_ms` (inclusive), `until_ms` (exclusive), `refresh_pricing?` | `usage_summary` (direct), never a broadcast. A half-open instant range: the daemon has no time zone, so the client converts local days to instants and back. Refused when `until_ms <= since_ms` or the span exceeds `USAGE_MAX_WINDOW_DAYS` |
| `browser_tool_result` | `request_id`, `ok`, `output?: JSON`, `error?` | reply to a `browser_tool_call` this connection received — the browser-tool relay's app-to-daemon half (v93, Detach). Ignored if the daemon is no longer waiting on `request_id` |

## Server → client

| Message | Fields | When it fires |
|---|---|---|
| `hello_ok` | `protocol`, `sessions: SessionInfo[]`, `workspaces: Workspace[]`, `tags: TagInfo[]` (v100: the tag registry, whole), `recovery?: RecoverySummary`, `safe_mode: SafeModeSummary`, `snapshot_attach` (v94: this daemon has a terminal emulator), `snapshot_format_version` (v94: the container version it writes) | direct, once, on a successful handshake |
| `session_created` | `info: SessionInfo` | bcast — a session was spawned; precedes any frame, `agent_detected` or `session_state` for it |
| `session_state` | `session`, `state: SessionState`, `exit_code?` | bcast on every lifecycle transition |
| `session_list` | `sessions: SessionInfo[]` | direct reply to `session_list` |
| `session_removed` | `session` | bcast — the session is gone from the roster |
| `scrollback` | `session`, `data` (base64), `generation`, `replayed_bytes`, `bytes_seen`, `attempt` (how many `session_attach` for this session this socket has sent, this one included) | direct reply to `session_attach`; honoured only when `attempt` matches the client's own count |
| `attach_snapshot` | `session`, `generation`, `attempt`, `output_offset` (the cutoff), `format_version`, `state` (base64, the container below) | v94: direct reply to a `session_attach` that asked for a snapshot; same `attempt` rule as `scrollback` |
| `session_resized` | `session`, `cols`, `rows` | direct reply. Dims are read back from the PTY for live local sessions; SSH and dead sessions echo the request |
| `session_renamed` | `session`, `title` | bcast after `session_rename` |
| `session_tags_set` | `session`, `tags: u32[]` | v100: bcast after `session_set_tags` — the whole set, client replaces |
| `tag_list` | `tags: TagInfo[]` | v100: bcast after any `tag_*` mutation; whole registry, client replaces |
| `tag_deleted` | `tag` | v100: bcast beside the `tag_list` that follows a delete — clients holding the id (a tag filter) clean up without diffing |
| `session_reparented` | `session`, `project_dir` | bcast — a session moved to another workspace |
| `session_cwd` | `session`, `cwd` | direct reply to `session_cwd` |
| `session_cwds` | `entries: SessionCwdEntry[]` | direct reply to `session_cwds` |
| `session_running_procs` | `entries: SessionProcsEntry[]` | direct reply to `session_running_procs` |
| `live_children_changed` | `session`, `live_children`, `children_waiting` | bcast after any transition that can change either of a parent's child counts — a child spawning, dying or respawning moves the first; a child blocking, stalling or being released moves the second |
| `delegation_changed` | `session` (the CHILD), `delegation: DelegationInfo` | bcast after every write to a delegation record — spawn, state transition, stall flag, staging, flush, close. The whole record, so a client replaces rather than patches |
| `inbox_rows` | `workspace`, `rows: InboxRow[]` | v96: direct reply to `inbox_list` — every row addressed to the operator for that workspace, oldest first |
| `inbox_changed` | `workspace`, `row: InboxRow` | v96: bcast on every write to a row — produced, released, delivered, confirmed, re-addressed, acked, resolved. The whole row, so a client replaces rather than patches |
| `idle` | `request`, `session`, `idle` | bcast — a `wait_for_idle` resolved (`true` = quiet window elapsed or not running; `false` = timeout while output flowed) |
| `session_policy` | `policy: SessionPolicy` | direct reply to `session_policy_get`; bcast after a set |
| `update` | `policy: UpdatePolicy`, `state: UpdateState` | direct reply to `update_get`; bcast on every state change. Policy and state travel together, so a client can never render one against a stale copy of the other |
| `keymap` | `overrides: KeymapOverrides` | direct reply to `keymap_get`; bcast after a set |
| `workspace_list` | `workspaces: Workspace[]` | direct reply; bcast after add/remove/rename |
| `orchestration_state` | `enabled`, `caps: OrchestrationCaps`, `acp_agents: AcpAgentInfo[]` | direct reply to `orchestration_settings_get`; bcast after any switch or cap change |
| `swarm_message` | `message: SwarmMessage` | bcast — the mailbox layer recorded a message, status, escalation or completion |
| `swarm_agent` | `agent: SwarmAgentInfo` | bcast — an orchestrated agent's status or activity changed |
| `agent_detected` | `session`, `agent: AgentKind` | bcast, only when the detected identity changes |
| `agent_status` | `session`, `status: AgentStatus` | bcast, only on change. Driven by hooks or ACP; process liveness only starts the bounded `spawning` grace and never guesses activity |
| `session_context` | `session`, `context?: SessionContext` | v111: bcast, only on change. The pane's context-window occupancy, read from the Claude transcript the hook names; every other provider stays absent, which the client renders as "not tracked" |
| `agent_notice` | `session`, `kind: AgentNoticeKind` | bcast — an attention-worthy event for the client's notification inbox |
| `clipboard_set` | `session`, `text` | bcast — the pane wrote an OSC 52 clipboard payload (decoded, 1 MiB cap; queries are never answered) |
| `git_status` | `dir`, `files: GitFileStatus[]`, `branch?`, `upstream?`, `ahead`, `behind`, `base?`, `default_base?` | direct reply to `git_status` and to every mutating git message |
| `git_diff` | `dir`, `path?`, `patch`, `truncated`, `base?` | direct reply to `git_diff` |
| `git_branch` | `dir`, `branch?` | direct reply to `git_branch` |
| `git_commit` | `dir`, `sha`, `summary` | direct reply to `git_commit`, followed by a fresh `git_status` |
| `git_review_diffs` | `dir`, `branch?`, `upstream?`, `ahead`, `behind`, `head?`, `files: GitFileStatus[]`, `sections: GitReviewSection[]`, `blocked_paths`, `warnings`, `truncated`, `redacted` | direct reply to `git_review_diffs`; one entry per non-empty scope |
| `git_branches` | `dir`, `branches: GitBranchInfo[]`, `remotes: GitBranchInfo[]`, `default_branch?`, `truncated` | direct reply to `git_branches` and every branch mutation |
| `git_worktrees` | `dir`, `worktrees: GitWorktreeInfo[]`, `message?` | direct reply to `git_worktrees` and every worktree mutation; `message` is the mutation's note |
| `git_checkpoints` | `dir`, `checkpoints: GitCheckpointInfo[]` | direct reply to `git_checkpoints` and every checkpoint mutation |
| `git_checkpoint_diff` | `dir`, `ref`, `patch`, `truncated`, `redacted` | direct reply to `git_checkpoint_diff` |
| `git_pull` | `dir`, `status: GitPullStatus` | direct reply to `git_pull` |
| `git_fetch` | `dir`, `summary` | direct reply to `git_fetch` |
| `pr_status` | `dir`, `gh: GhState`, `has_upstream`, `pr?: PrInfo`, `hint?` | direct reply — a `gh` problem is reported in `gh` + `hint`, never as `error` |
| `pr_create` | `dir`, `gh: GhState`, `pr?: PrInfo`, `message?` | direct reply — `message` carries `gh`'s own first stderr line on a genuine failure |
| `pr_detail` | `dir`, `request`, `gh: GhState`, `has_upstream`, `link?: PullRequestLink`, `detail?: PrDetail`, `linked`, `hint?`, `message?` | direct reply to `pr_detail`, and pushed after link/unlink/merge carrying that mutation's `request`. `linked` marks a manual association; `detail.merge_disabled_reason` is the server's merge gate |
| `pr_linked` | `dir`, `request`, `ok`, `message?` | direct reply to `pr_link`; success is followed by a fresh `pr_detail` with the same `request` |
| `pr_unlinked` | `dir`, `request`, `number?`, `ok`, `message?` | direct reply to `pr_unlink`; `number` names what was removed |
| `pr_merged` | `dir`, `request`, `number`, `ok`, `message?` | direct reply to `pr_merge`; `message` carries the refusal (moved head, merge gate, or gh's own stderr line). Success is followed by a fresh `pr_detail` |
| `pr_mutation` | `dir`, `request`, `number`, `kind: PrMutationKind`, `ok`, `message?` | direct reply to every pull-request write but merge; success is followed by a fresh `pr_detail` with the same `request` |
| `pr_reviewer_candidates` | `dir`, `request`, `candidates: PrReviewerCandidate[]`, `truncated`, `message?` | direct reply to `pr_reviewers`; a failed read is `message`, never an `error` |
| `pr_label_candidates` | `dir`, `request`, `candidates: PrLabelCandidate[]`, `truncated`, `message?` | direct reply to `pr_labels` |
| `pr_list` | `dir`, `request`, `items: PrListItem[]`, `truncated`, `message?` | direct reply to `pr_list`; `truncated` says the host has more rows than `limit` |
| `pr_diff` | `dir`, `request`, `number`, `patch`, `truncated`, `message?` | direct reply to `pr_diff`; `patch` is a unified diff, capped byte-wise with `truncated` |
| `pr_stack` | `dir`, `request`, `stack?: PrStack`, `message?` | direct reply to `pr_stack`; `stack: null` with no message is "not in a stack or the host has no stacks preview" |
| `history_count` | `count` | direct reply to `history_count` |
| `command_history_ignore_globs` | `globs: string[]` | direct reply to the get; bcast after a set |
| `handoff_started` | `request`, `session`, `provider` | bcast — a generation began |
| `handoff_chunk` | `request`, `text` (ANSI-stripped) | bcast, streamed generator output |
| `handoff_done` | `request`, `markdown`, `saved_path` (`""` when the write failed) | bcast — the handoff finished |
| `handoff_error` | `request`, `message` | bcast — failure, inactivity timeout, or cancel |
| `ssh_host_key` | `request`, `host`, `port`, `algorithm`, `fingerprint`, `randomart`, `changed`, `previous_fingerprint?` | bcast — a TOFU decision is needed; `changed` means a different key was trusted before |
| `ssh_upload_done` | `request`, `session`, `remote_path` (absolute, from the far side), `bytes` | bcast after a successful upload |
| `ssh_profiles` | `profiles: SshProfile[]`, `keyring_error?` | direct reply to `ssh_profile_list`; bcast after save/delete/credential change |
| `ssh_config_hosts` | `hosts: SshConfigHost[]` | direct reply to `ssh_config_hosts` |
| `skill_sync` | `tools: SkillToolState[]`, `pushes: SkillPushRecord[]`, `auto_push_enabled` | direct reply to `skill_sync`; bcast after a push, undo or auto-push toggle |
| `mcp_state` | `source: McpServer[]`, `source_path`, `tools: McpToolState[]`, `results: McpSyncResult[]`, `checks: [string, McpConnectionCheck][]` | direct reply to `mcp_state`; bcast after sync/import/enable/upsert/remove/test |
| `agent_hooks` | `providers: AgentHookState[]` | direct reply to `agent_hooks`; bcast after `agent_hooks_set` |
| `agent_profile_state` | `profiles: AgentProfile[]`, `active: AgentProfileActive[]` | direct reply to `agent_profile_list`; bcast after any profile change |
| `routines` | `routines: Routine[]`, `running: u32[]` (routine ids whose run is in flight) | direct reply to `routine_list`; bcast after any routine mutation and on every run start/end |
| `routine_refused` | `id?` (`null` for a refused create), `kind: RoutineErrorKind`, `limit?`, `requested?` | direct reply only; nothing changed |
| `routine_runs` | `runs: RoutineRun[]` | direct reply to `routine_runs` |
| `routine_run_event` | `run: RoutineRun` | bcast — one run changed state: opened, refused before it spawned, or ended with an outcome |
| `voice_settings` | `settings: VoiceSettings`, `cloud_key_present`, `keyring_error?`, `models: VoiceModelState[]` | direct reply to `voice_settings_get`; bcast after any settings or key change |
| `voice_devices` | `devices: VoiceDevice[]` | direct reply to `voice_devices_get` |
| `voice_state` | `state: VoiceState` | bcast on every capture transition, including failures |
| `voice_transcript` | `session`, `text`, `engine` (`"local:<model_id>"` or `"groq"`), `translated` (what happened, not what was asked) | bcast — one finished utterance for the pane named at `voice_start` |
| `voice_model_state` | `model: VoiceModelState` | bcast — download progress, completion, failure or deletion |
| `voice_level` | `rms` | bcast every `VOICE_LEVEL_INTERVAL_MS` while any connection is monitoring; same normalized scale as `VoiceSettings.rms_floor` |
| `host_info` | see `HostInfo` below | direct reply to `host_info_get`; bcast after a knob change |
| `usage_summary` | `since_ms`, `until_ms`, `read_at_ms`, `buckets: UsageBucket[]`, `sources: UsageSource[]`, `pricing: UsagePricing`, `untracked_agents: AgentKind[]`, `scan_duration_ms` | direct reply to `usage_summary_get` |
| `error` | `message`, `context?` | direct, to the offending connection only |
| `browser_tool_call` | `request_id`, `tool`, `args: JSON`, `session_id`, `workspace_id` | daemon-initiated, to the one connection owning the current window — the browser-tool relay (v93, Detach) |

## Shared shapes

Enum values are `snake_case` on the wire unless marked otherwise. Enums with
data are internally tagged; the tag field is named in each entry below.

```
AgentKind          claude | codex | antigravity | shell | custom | opencode | cursor | grok | droid | copilot | aider | ssh
SessionState       running | exited | killed | interrupted
AgentStatus        kebab: spawning | working | idle | needs-input | unavailable
AgentNoticeKind    kebab: finished | needs-input | error
ContextState       snake: unknown | idle | working | near_limit | reset
ContextSource      snake: reported | derived
SessionContext     used_tokens, window_tokens?, used_percent? (0-100, floored),
                   state: ContextState, source: ContextSource, as_of_ms
RestoreReason      kebab: circuit-breaker | invalid-cwd | ssh | budget | previous-crash | safe-mode | spawn-failed

SessionInfo        id, agent: AgentKind, project_dir, cwd (the actual run dir), state: SessionState, title,
                   codename (v98: the spawn-time codename, kept when the first prompt renames
                   `title`; parent-facing labels read this. Empty from an older daemon —
                   read `title` instead),
                   detected_agent?, hidden, ssh_host?, restore_deferred?: RestoreReason, status?: AgentStatus,
                   context?: SessionContext (v111: runtime-only occupancy; absent or `unknown` means
                   not tracked; never persisted, so it resets on respawn),
                   swarm_agent?, spawned_by?, acp? (slug), live_children, children_waiting, profile_label?,
                   delegation?: DelegationInfo, inbox_unread (v96: undelivered, unresolved pane_inbox rows
                   addressed to this pane),
                   tags (v100: tag ids in application order; resolved against the tag registry —
                   ids, never names, so a rename/recolor needs no session rewrite)
DelegationInfo     parent, role?, state: DelegationState, stalled, result_staged, superseded, ended_at?,
                   stop_reason?, turn_end_source: TurnEndSource, inbox_owed, inbox_provisional,
                   last_result_corrected_by?, capability_note?, hold_reason? (v98: what the child
                   still owes its parent, the correction link, what its CLI cannot report, and
                   why door 3 is holding the rows). The record a pane is the CHILD of; `None`
                   for an operator-spawned pane. Deliberately NOT the record's `brief` (8 000 chars, on
                   every roster broadcast) — that stays MCP-only, on `pane_get`'s `DelegationView`
DelegationState    snake: spawning | working | needs_input | done | failed | cancelled | unknown
                   (the last four terminal; `unknown` is a daemon restart mid-flight, not a failure)
TurnEndSource      kebab: stop-hook | acp-turn | quiet-settle
InboxRow           v96: id, to_session, original_to?, workspace, from_session?, request_id?,
                   kind: InboxKind, urgent, summary, body, artifacts, superseded, provisional, corrects?,
                   reason?, created_at, ready_at?, resolved_at?, delivered_at?, delivered_via?:
                   InboxDeliveredVia, confirmed_at?, attempts (delivery attempts by any door). The renderer's
                   copy of a `pane_inbox` row —
                   drops `reserved_at`/`delivery_id` (door internals)
InboxKind          snake: result | no_handback | needs_input | exited | stalled | operator_note | mail
InboxDeliveredVia  snake: wait | stop_hook | paste | operator
Workspace          path, name
TagInfo            v100: id, name (trimmed, non-empty, ≤ MAX_TAG_NAME_LEN (32) chars, unique
                   case-insensitively), color (#rrggbb, one of TAG_PALETTE's eleven fills —
                   fixed, because the chrome's 4.5:1 ink/ground gate can only clear colors
                   somebody measured). One registry row; sessions reference it by id
RecoverySummary    respawned, deferred, crashed
SessionPolicy      idle_reap_enabled (default false), idle_reap_minutes (default 15)
UpdatePolicy       check (default true) — off means no request is ever made, and the one
                   request carries no version, OS or identifier
UpdateRelease      version, notes (GitHub's release body verbatim; empty when the release
                   carries none), notes_url
UpdateState        tag "kind": unknown | disabled | checking | up_to_date{checked_at_ms}
                   | available{release: UpdateRelease, checked_at_ms} | failed{error, checked_at_ms}
                   — unknown means never asked, which is different from asked and found
                   nothing; disabled is what the state becomes the moment the setting is off
SessionCwdEntry    session, cwd?
SessionProcsEntry  session, has_procs? (direct children, zombies count), has_running_procs? (full descendant
                   walk, zombies excluded); both null for unknown/hidden/not-live/SSH
KeyChord           code, ctrl, alt, shift, meta
KeymapOverrides    bindings: { action -> KeyChord }, shortcuts_enabled

OrchestrationCaps     max_live_children, max_spawn_depth
AcpAgentInfo          slug, display_name, command, agent: AgentKind
SwarmMessage          id, swarm, from, to, body, created_at,
                      kind (message | status | escalation | worker_done | swarm_complete)
SwarmAgentInfo        id, swarm, label, role, agent, session?, auto_approve, plan_mode, model?,
                      custom_prompt?, cmd?, status, activity?, created_at

GitFileState       modified | added | deleted | renamed | untracked | conflicted
GitFileStatus      path, status: GitFileState, staged, added?, deleted?, is_sensitive
GitReviewSection   scope (staged | unstaged | untracked), patch
GitDiscardKind     staged | unstaged | untracked
GhState            missing | unauthenticated | ready
PrChecks           none | running | passing | failing
PrInfo             number, url, state, review_decision?, checks: PrChecks
PullRequestState   open | closed | merged
PullRequestLink    host, repository, number, url, state: PullRequestState,
                   source (manual | created | agent | detected), title?, is_draft,
                   additions, deletions, changed_files, checks?: PrChecks, review_decision?,
                   linked_at, merged_at?, closed_at?, synced_at?
PrDetail           body?, author?, base_ref?, head_ref?, head_sha, commit_count,
                   created_at, updated_at, mergeable (mergeable | conflicting | unknown),
                   merge_state (clean | behind | blocked | dirty | draft | has_hooks |
                   unstable | unknown), checks: PrCheck[], comments: PrComment[],
                   reviews: PrReview[], comments_total, reviews_total, merge_disabled_reason?
PrCheck            name, state (queued | running | passing | failing | skipped | unknown),
                   url?, duration_ms?
PrComment          author, body, created_at, url?
PrReview           author, state, body, submitted_at
PrMergeMethod      merge | squash | rebase

SshAuth            tag "kind": agent | identity_file{path, passphrase_profile?} | password{profile} | ssh_config
                   — no variant ever carries a secret; `profile` names a keychain entry
SshProfile         name, host, port, user, auth: SshAuth, default_dir?, startup_cmd?, last_used_at?,
                   has_credential (asked of the keychain when the list is built, never stored)
SshConfigHost      alias, hostname, user?, port?, identity_file?

McpTransport       stdio | http | sse
McpServer          name, transport, command?, args, env, url?, headers, cwd?, enabled,
                   fingerprint (identity across the four config formats), destinations (empty = all supported tools)
McpToolState       tool: AgentKind, path, detected, servers, error?
McpSyncResult      tool, written, removed, skipped (with reasons), error?
McpConnectionCheck tag "state": not_checked | checking | verified{tool_count} | failed{message}
SkillEntry         name, path, digest
SkillToolState     tool, path, detected, inherits_claude, skills, error?
SkillPushRecord    tool, skill, path, pushed_at, had_existing
AgentHookState     provider, path (the exact file Houston writes), scope (workspace | global), enabled, installed, error?,
                   present (the CLI binary resolves on PATH), version? (what `<binary> --version` reported),
                   trust? (HookTrust, Codex only: whether its own review screen has ever trusted a hook)

AgentProfile       id, agent (claude | codex), name, config_dir
AgentProfileActive agent, id
ProfileChoice      tag "kind": default | profile{id}

Routine            id, name, prompt, cadence,
                   enabled,
                   workspace_id? (the routine's own working directory — where a run starts,
                   and the base an isolated run branches from),
                   engine: AgentKind (the provider every run executes with),
                   model?, effort?: ChatEffort,
                   next_run_at_ms, last_run_at_ms?, last_run_session_id?, last_error?,
                   permission_mode: ChatPermissionMode (no "automatic" — a run has nobody to ask),
                   isolate (run in a linked worktree; required by bypass_permissions),
                   last_outcome?: RoutineOutcome,
                   revision (a content hash; every mutation must echo it)
RoutineRun         id, routine_id, trigger: RoutineTrigger, status: RoutineRunStatus,
                   session_id? (the pane run's session), error?, started_at_ms, ended_at_ms?
RoutineTrigger     schedule | manual
RoutineRunStatus   running | ok | denied | killed_at_cap | engine_refused | failed
                   (the non-`running` arms are `RoutineOutcome`'s)
RoutineOutcome     ok | denied | killed_at_cap | engine_refused | failed
Cadence            tag "type": interval{seconds >= ROUTINE_MIN_INTERVAL_SECS} | clock{hour, minute, weekdays?}
                   — weekdays absent = daily; 1 = Sunday … 7 = Saturday; an empty list is refused
RoutineErrorKind   conflict | duplicate_name | limit | not_found | already_running

Run caps (generated into `DEFAULTS.ts` beside the record caps, so the tab can
show a limit before it trips): `ROUTINE_TICK_MS` 15 000 — how often the loop
looks; `ROUTINE_RUNS_CONCURRENT` 3 — unattended runs in flight at once, the
fourth waits for a slot; `ROUTINE_RUN_MAX_MS` 1 800 000 — one run's ceiling,
past which it is stopped as `killed_at_cap`; `ROUTINE_RUNS_PAGE` 50 — how many
run records `routine_runs` answers with.

CloudStt           groq
VoiceEngine        tag "kind": local{model_id} | cloud{provider: CloudStt}
VoiceSettings      enabled (default false — this is what opens the microphone), engine,
                   output_mode (original | english), input_language?, capture_mode (hold | toggle),
                   input_device?, insert_mode (direct | confirm_first), vocabulary, agent_preamble,
                   mic_policy (persistent | on_keypress), rms_floor
VoiceDevice        id (what input_device stores), label, is_default
VoiceModelStatus   tag "kind": not_downloaded | downloading{progress} | downloaded{size_bytes} | failed{reason}
VoiceModelState    id, display_name, size_bytes, status, cooldown_remaining_ms?
VoiceFailure       tag "kind": no_model{model_id} | missing_key{provider} | device_unavailable{device}
                   | too_quiet{rms, floor} | too_short{seconds, minimum} | ring_buffer_overrun{dropped}
                   | no_speech | target_gone{session} | engine{message} — every variant carries its numbers
VoiceState         tag "state": idle | listening{session} | transcribing{session} | error{failure: VoiceFailure}

ChatEffort         low | medium | high | xhigh | max
ChatPermissionMode accept_edits | bypass_permissions

HostInfo           channel, state_dir, pid, port, protocol_version, app_version, build_commit, uptime_ms,
                   live_sessions, restore_budget, restore_deferred, orchestration_depth_in_use,
                   orchestration_max_depth, mailbox_files_on_disk, mailbox_retention_hours,
                   command_history_ignore_glob_count, session_db_bytes

UsageProvider      claude | codex
UsageTokenTotals   uncached_input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_tokens
UsageBucket        hour_start_ms, provider, model, totals, cost_usd, cache_savings_usd, records,
                   cost_source (provider_reported | model_priced | unpriced), unpriced_records, sessions
UsageSource        provider, path, profile_name?, status (ok | missing | partial | failed), scanned_files,
                   skipped_files, failed_files, distinct_sessions, message?
UsagePricing       status (fresh | cached | unavailable), source, fetched_at_ms?, known_models, message?
```

Every cap and default named above is a constant in `lib.rs`, mirrored into the
UI as `DEFAULTS.ts` by `scripts/gen-protocol-types.sh` so a client can refuse an
out-of-range value before the daemon has to. One definition, two consumers —
never a number typed twice.

## Attach sequencing

Every byte a session produces has a stable stream offset, and every output frame
carries the offset of its first byte. `scrollback` reports three numbers:
`bytes_seen` (total stream bytes so far), `replayed_bytes` (how many of them
`data` covers — the replay is the window `[bytes_seen - replayed_bytes,
bytes_seen)`), and `generation` (a byte-offset epoch; offsets are comparable
only within one generation). The ordering contract:

1. `session_created` for a session always precedes that session's first output
   frame, its `agent_detected` and its `session_state`.
2. `session_attach` starts this connection's frame delivery as it is processed.
   On `/ws` the reply is the attachment boundary: no frame queued after it is
   entirely covered by the replay (`bytes_seen`) — the daemon prunes its queue
   for that session when it takes the attach and refuses later frames the
   replay covers. A frame that started before the cutoff but extends past it
   (a straddler — ordinary from one large PTY read, more likely once
   contiguous reads have merged into one) survives whole rather than being
   split: the client discards the covered prefix itself, the same trim it
   already does for any frame. A drop episode the replay covers is closed by
   the attach, so recovery never asks for a second attach.
3. The client buffers frames from the moment it sends `session_attach` until the
   reply lands, then discards buffered bytes below `bytes_seen`. Replay and
   live output interleave exactly, with no duplication and no hole.
4. `attempt` numbers the attaches one socket has sent for one session; the
   daemon counts every one it takes, refused or not. A reply whose `attempt` is
   below the client's count answers an attach the client already gave up on
   (timed out, superseded by a re-attach after a gap) and is ignored, so a late
   replay can never re-sync a pane to an older boundary. Hiding a session
   (`session_visibility{visible:false}`) keeps its count.

A replay that does not begin at stream offset 0 (a trimmed ring, or a
`replay_bytes` cap) is cut at an escape-safe boundary — never inside an ESC
sequence — and prefixed with `\x1b[0m` so trimmed SGR state cannot bleed;
`replayed_bytes` counts stream bytes only, excluding that cosmetic prefix.

Scrollback survives daemon restarts for sessions that were live: rings are
persisted under the channel's `scrollback/<id>.bin` on session end and on
graceful shutdown, and a restored husk replays from disk with its stream
accounting intact. Closing a husk deletes its ring.

### Snapshot attach (v94)

A client that asked for `snapshot: true` gets `attach_snapshot` instead of
`scrollback`, and `output_offset` plays exactly the role `bytes_seen` plays
above: the state accounts for every stream byte below it and none at or above
it, and the client applies frames from there, once. Everything in points 1-4
holds unchanged — the buffering window, the straddler trim, the `attempt`
rule, the pruned queue.

Three things are specific to it:

- **Atomicity.** The cutoff and the state are captured under one hold of the
  session's scrollback lock, in the order the read path takes it, so no chunk
  is ever counted in the offset but missing from the state (a hole) or the
  reverse (a double paint).
- **Import is a window.** The client buffers arriving frames while it imports,
  bounded by the same per-session queue bytes a `/ws` queue is bounded by.
  Overflow invalidates the attempt: the client discards what it buffered and
  sends exactly one fresh `session_attach`, rather than importing a state its
  live tail no longer joins. Input is not accepted until the import has
  applied the modes, and terminal-query replies are suppressed while it runs —
  a half-imported screen must not answer a question about itself.
- **Refusal is named.** A daemon without an emulator sets
  `hello_ok.snapshot_attach: false` and a client must not ask; a daemon that
  has one but could not encode answers `scrollback`, and the client falls back
  to the byte replay it already knows how to apply.

#### The snapshot container

`state` is base64 of a little-endian, length-prefixed container. Produced and
consumed by one Zig module compiled into both the daemon's native
libghostty-vt and the renderer's wasm32 build, so there is exactly one
implementation of this format:

```
"HVTS"          4 B    magic
formatVersion   u32    refused unless equal -- there is no compatibility window
sections until end of buffer:
  tag           4 B
  len           u32
  body          len B
```

| tag | body |
|---|---|
| `HEAD` | cols u16, rows u16, active screen u8 (0 primary / 1 alternate), alternate present u8, pending truncated u8, reserved u8, mode bit count u16 |
| `TERM` | VT: palette (OSC 4), tabstops, pwd (OSC 7), keyboard modes |
| `SCRG` | VT: scrolling region (DECSTBM/DECSLRM) |
| `MODE` | mode values / saved / defaults, each a 128-bit image of the mode bitfield |
| `TFLG` | mouse event u8, mouse format u8, modify-other-keys u8, shift capture u8, status display u8, previous char present u8 + u32 |
| `SCRP` / `SCRA` | primary / alternate screen |
| `PEND` | the in-flight escape-sequence prefix, replayed last |

A screen body is `vt_len u32`, that many bytes of VT repaint (SGR runs, OSC 8
hyperlinks, real codepoints, cursor/protection/charset extras), `target_rows
u32` (the row count the paint must end up holding — the repaint trims trailing
blank rows, and the importer scrolls the difference back in), then
`cursor_x u16, cursor_y u16, pending_wrap u8, cursor_style u8,
cursor_protected u8, protected_mode u8`, the kitty keyboard flag stack
(`flags[8]` u8 + `idx` u8), and `saved_present u8` with — when set — the saved
cursor: x, y, protected, pending_wrap, origin, its style (3 x [tag u8 + 3
colour bytes] + flags u16) and its charset state (G0-G3, GL, GR,
single_shift with 0xFF for none).

Nothing in it is library memory. Page storage is a pooled list of native
pointers, four bytes wide on wasm32 and eight on x86_64, so a byte copy could
not cross the boundary this exists to cross; the bulk of a screen travels as
the library's own VT re-encoding and comes back through the same parser that
reads a real program's output. The importer's order is fixed and load-bearing:
`TERM` (a tabstop is HTS at a cursor position, so it walks the cursor) before
the paint, the paint with the scrolling region and origin mode still at their
defaults, then row padding, `SCRG`, the modes, the cursor, and `PEND` last so
the parser lands in the state the cutoff caught it in.

## Errors and refusals

The generic failure envelope is `{"type":"error","message":"…","context":"…"}`,
sent only to the connection that caused it. `context` is optional and carries
the surrounding fact — the message kind that failed, or a truncated echo of an
unparseable payload. Refusals follow two rules:

- **A refusal names the offending value and the expected shape.** "invalid
  session title \"\": expected non-empty and ≤ 40 chars, got 0" — not "invalid
  title".
- **A limit someone can hit is a limit they can see.** When a cap trips, the
  refusal carries the limit, the actual value, and what was asked for, and the
  stored state is left exactly as it was — never truncated to fit. Several
  families have a typed refusal instead of `error` so a client can route it
  without matching English prose: `routine_refused` (`kind`/`limit`/`requested`).
  Two refusals carry a machine-readable prefix on a plain
  `error` — `live_children_confirmation_required:` and `USAGE_WINDOW_REFUSED`
  (`usage_window_refused:`); the sentence after the marker is shown verbatim.

A refusal never half-applies. A failed skill write stores nothing, a failed
rename leaves the row untouched, a failed hook install does not flip the
setting that claims it.

## Management (`/manage`)

Management uses a small, authenticated HTTP request/response surface on the same
loopback listener as `/ws`, for callers with no live `/ws` session — the
renderer's Settings → Daemon section and `houston-core --status`. Never a
second transport for PTY data or control messages; `/ws` remains the only
one of those.

- **Auth**: `Authorization: Bearer <token>` — the *same* `daemon.token`
  `/ws`'s `Hello` checks, never a pane's per-session MCP credential. A
  missing or wrong bearer gets `401` with `{"error":"…"}`.
- **Version**: carried in the request BODY (`manage_version`), not a header
  — `MANAGE_VERSION` is independent of `PROTOCOL_VERSION`: `/manage`'s shape
  can change without an application-wire bump, and vice versa. A mismatch
  gets `409` with `{"error":"manage version mismatch: daemon …, caller …"}`.
- **When to bump `MANAGE_VERSION`**: only when a shape a caller already
  consumes changes. Adding a verb, or changing the response of a verb no
  shipped caller has ever sent, is additive and keeps the number — a bump
  there would `409`-refuse every *unrelated* call from a caller that is
  otherwise perfectly compatible (`manage.ts` hardcodes its own number and
  only ever sends `daemon_status`/`daemon_shutdown`). `daemon_handoff`'s
  richer `ManageDaemonHandoffResult` landed under this rule at version 1.
  `ManageRequest::candidate_bin` landed under it too: it is optional, every
  shipped caller omits it, and its absence is exactly the old behaviour.
  `daemon_shutdown_if_idle` is likewise additive: only the updater sends it,
  and older daemons refuse the unknown verb instead of changing an existing
  caller's response shape.
- **Request**: `POST /manage` with
  `{"manage_version":1,"verb":"daemon_status"|"daemon_shutdown"|"daemon_shutdown_if_idle"|"daemon_handoff","candidate_bin"?:"/absolute/path"}`.
  This exact shape — and every response shape below — is pinned by the
  renderer's own hand-written client and its tests
  (`ui/src/renderer/src/houston/manage.ts`, `manage.test.ts`); it is
  deliberately not the tagged-enum shape `/ws` uses.
  `candidate_bin` is meaningful only with `daemon_handoff`: the absolute path
  of the daemon binary the retiring daemon should spawn as its successor. It
  is how the daemon is moved across a version change in two moments: right
  after a deb/rpm install, the running app names the sidecar the install
  replaced next to it; and at startup, an app whose live daemon reports a
  different build or protocol names its own sidecar and hands the channel to
  it before attaching — for an AppImage, that is the sidecar of the mount the
  new AppImage was launched from, never the retiring daemon's old mount. A
  path that is not absolute, not a regular file, or not executable is refused
  by name before any session is parked, and a handoff already in progress is
  refused by name so two callers cannot move one channel at once. Omitting it
  keeps the old behaviour — the daemon resolves its own executable, which is
  what `scripts/dev.sh --fresh` sends. Any other verb carrying `candidate_bin`
  gets `400` naming the field.
  - `daemon_status` → `200` with
    ```json
    {
      "manage_version": 1, "protocol_version": 92, "build": "abc1234",
      "pid": 4321, "started_at": "2026-09-05T07:00:00Z",
      "live_sessions": {"count": 3, "ids": [1,2,3]},
      "routines_enabled": 2, "clients_connected": 1,
      "handoff": {"supported": false, "reason": "…"},
      "reap": {"armed": false, "deadline_ms": null}
    }
    ```
    `build` is the short git SHA (`"unknown"` outside a git checkout).
    `started_at` is RFC 3339 UTC — the one field on this wire that is a
    calendar string rather than epoch ms. `routines_enabled` counts every
    enabled routine, any author — an agent-authored one never fires on its
    own, but it is still a reason the operator expects the daemon to keep
    existing. `clients_connected` is `/ws` connections only; a `/manage`
    request never registers as one. `reap.deadline_ms` is `null`, never an
    omitted key, exactly when `reap.armed` is `false`.
  - `daemon_shutdown` → refuses new mutations, kills every live
    session through its backend lifecycle, drains, checkpoints, marks the
    shutdown clean only on success, then either
    `200 {"ok":true,"stopped_sessions":…,"disarmed_routines":…}` followed by
    the process actually exiting a beat later, or
    `200 {"ok":false,"error":"…"}` with the process still running and
    nothing marked clean. Both land on `200`: the daemon answered, it just
    declined — the client discriminates by the presence of `error`, never
    by HTTP status.
  - `daemon_shutdown_if_idle` (Windows updater only) → closes the mutation
    gate, then stops the daemon only when it owns no live sessions. If any
    session is live it returns `200 {"ok":false,"error":"…",
    "unterminated":[…]}` naming the count and ids, kills nothing, and keeps
    the daemon running. This closes the race between the updater's initial
    session check and the installer replacing the running sidecar.
  - `daemon_handoff` (Linux only) → asks the running daemon to hand its
    live sessions to a fresh generation in place (`adoption.rs`). `200
    {"accepted":true,"reason":null,"generation":2,"sessions_transferred":3}`
    once the new generation has committed ownership — the connection then
    drops as the old process retires; a reconnect to the same port reaches
    the new one. `200 {"accepted":false,"reason":"…","generation":null,
    "sessions_transferred":null}` when refused (naming a live SSH session's
    ids, a schema/manifest mismatch, an exceeded descriptor/byte cap, an
    unsupported platform, or no `houston-supervisor` in front of this
    daemon, or an unusable `candidate_bin`) — the daemon answering is
    unchanged and still owns every session. This response shape is
    `ManageDaemonHandoffResult`, distinct
    from `daemon_status.handoff` (`ManageHandoffInfo`, `{supported,
    reason}`), which is a cheap static readiness check, not a per-attempt
    result.
- **CORS**: the renderer's Settings → Daemon section calls `/manage` with a
  plain `fetch` from the webview's own origin, which the webview treats as
  cross-origin and preflights with `OPTIONS` before the real `POST`. The two
  allowed origins are `tauri://localhost` (Linux/macOS) and
  `http://tauri.localhost` (Windows) — the same pair the app's webview runs
  under. `OPTIONS /manage` from either origin gets `204` with
  `Access-Control-Allow-Origin`, `-Methods: POST, OPTIONS`,
  `-Headers: authorization, content-type`, `-Max-Age: 600` and
  `Vary: Origin`; from any other `Origin` it gets `403` naming the offending
  origin. A `POST` whose `Origin` is one of the two allowed values carries
  `Access-Control-Allow-Origin` and `Vary: Origin` back on the response,
  success or error alike; a request with no `Origin` header at all (curl,
  `scripts/dev.sh`, `src-tauri/src/host.rs`) gets no CORS header and is
  otherwise unaffected — the bearer token, not the browser's same-origin
  policy, is what protects this surface.
- A daemon predating `/manage` simply has no route there — a caller gets a
  connection refusal or a 404, and must treat that the same as
  `handoff.supported: false`, never infer a live session count from it.

## Versioning rules

- `PROTOCOL_VERSION` is bumped **once per wire-touching batch**, not once per
  message. A version that has merged is closed — never reuse it.
- The daemon and the UI ship a wire change in the **same commit** — a daemon and
  a UI that disagree on this number cannot complete the handshake — and this
  document is updated in that same commit; its first line carries the version.
- The generated TypeScript under `ui/src/renderer/src/houston/generated/` is
  regenerated by `scripts/gen-protocol-types.sh` and **committed**, never
  hand-edited.
- `scripts/check-protocol-sync.sh` (in CI) fails unless the Rust constant, the
  generated TS constant and this file's header all agree;
  `scripts/check-renderer-fresh.sh` catches a built renderer behind the sources.

## Version history

Only the current window; older bumps live in git history.

| Version | What changed |
|---|---|
| 112 | **Pane lifecycle reports uncertainty.** `AgentStatus` gains `unavailable`: a hook-capable or ACP pane enters `spawning` at process creation and moves there if no lifecycle signal arrives within the bounded grace period, instead of being guessed idle. Later provider evidence replaces it normally |
| 111 | **The context downbar.** `SessionInfo` gains an optional `context: SessionContext` and a matching `session_context` broadcast, both runtime-only. `SessionContext` carries `used_tokens` (the input side of the most recent turn: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`), a nullable `window_tokens` and `used_percent`, a `state` (`unknown`\|`idle`\|`working`\|`near_limit`\|`reset`), a `source` (`reported`\|`derived` — the window's provenance) and `as_of_ms`. The Claude daemon reads its own transcript path from the hook payload (`HookDrop` gains `transcript_path`) and broadcasts on turn boundaries; every other provider carries no `context` and the client renders "not tracked" |
| 110 | **One update channel.** `UpdatePolicy` loses its `channel` field and `UpdateChannel` is deleted. The daemon always asks `releases/latest` and offers only a strictly newer release; a draft and a prerelease are refused unconditionally, so a release candidate can never reach a stable install. The stored `updates_channel` settings row is left in place, inert |
| 109 | **"Write with AI" is removed.** Gone from the wire: `git_commit_message` and `git_pr_content` with their two server replies; `headless_roles_get`/`headless_role_set` with `ServerMsg::HeadlessRoles`; and with them `HeadlessRoleKind`, `HeadlessEngineOption` and `HeadlessRoleView`. The sparkles that wrote commit messages and pull-request text — and the Settings ▸ Houston's own agents section that chose their engine and model — are removed. The Writer was the last caller of the headless engine seam, so the engines and the decode vocabulary v108 preserved for them (`ChatQuestion`, `ChatQuestionOption`, `ChatQuestionKind`, `ChatUsage`) go too. There is no migration: the stored role keys simply have no reader. Pane agents, routines and the rest of source control are untouched |
| 108 | **Bots are removed; routines stand alone.** Gone from the wire: `AgentList`/`AgentCreate`/`AgentUpdate`/`AgentDelete`/`AgentExport`/`AgentDuplicate` and their `agents`/`agent_created`/`agent_export_data`/`agent_limit_refused` replies; `AgentMemorySet`; `AgentSkillStarters`/`AgentSkillGet`/`AgentSkillSet`/`AgentSkillRemove`/`AgentSkillStarterInstall` and their `agent_skill_*` replies; `AgentMessagingGet`/`AgentMessagingSet` and `agent_messaging_state`; the whole chat surface (`ChatMessages`/`RunIndex`/`ChatSend`/`ChatStop`/`ChatAnswer`/`ChatMarkRead`/`ChatStartFresh`/`ChatEngineSupportGet` and `chat_history`/`run_rows`/`chat_event`/`chat_refused`/`chat_notice`/`chat_engine_support`); the record types behind them (`Agent`, `AgentInbox`, `AgentActivity`, `AgentMark`, `AgentMemoryFile`, `AgentLimitKind`, `AgentSkill`, `AgentSkillDoc`, `SkillStarter`, `AgentExportFile`, `AgentExportRoutine`, `AgentSkillExport`, `ReflectionMode`, `ChatThread`, `ChatRowKind`, `ChatToolStatus`, `ChatMessage`, `RunKicker`, `ChatEventKind`, `ChatRefusalKind`, `ChatEngineSupport`) and the `AGENT_*`/`CHAT_*`/`SKILL_*` caps. `Routine` loses `agent_id` and `continue_context`, `RoutineRun` loses `thread_id`: every routine is a standalone automation and every run is a pane session. `ROUTINES_PER_AGENT` is gone — `ROUTINES_TOTAL` is the only cap. At boot the `routines` table is rebuilt without the bot columns (data preserved), `routine_runs` without `thread_id`, and the `named_agents`/`agent_messages`/`agent_skill_sources`/`chat_threads`/`chat_messages` tables are dropped. `ChatEffort`/`ChatPermissionMode` stay (routine fields); `ChatQuestion`/`ChatUsage` stay as the preserved headless adapters' decode vocabulary. Pane agents, pane orchestration and Writer are untouched |
| 107 | **Routines own their execution.** `Routine.agent_id` becomes optional — a routine with no bot is a standalone automation. `Routine` gains `engine`, `model?` and `effort?`, and `workspace_id` is re-anchored as the record's own working directory: a bot-owned routine inherits engine, model, effort and directory from its bot once, at create or at the boot migration (the `routines` table is rebuilt with `agent_id` nullable and backfilled from `named_agents`), and a fire never reads a bot's settings again. Every execution is an independent `RoutineRun` (`routine_runs` table): `trigger` (`schedule`\|`manual`), `status` (the new `RoutineRunStatus`, `running` plus `RoutineOutcome`'s arms), the pane's `session_id?` and the bot conversation's `thread_id?`, `error?` and timestamps. New `routine_run_now` starts one on exactly the scheduler's path, refused `already_running` (the new `RoutineErrorKind` arm) while the previous run is in flight; new `routine_runs` lists the records newest first (`ROUTINE_RUNS_PAGE`) and `routine_run_event` broadcasts every transition. A botless routine always runs as a terminal pane; bot-owned runs keep landing in the bot's conversation. A run still `running` when the daemon stops is closed as `failed` at the next boot |
| 106 | **The update offer carries its notes, not a guessed installer URL.** `UpdateRelease` gains `notes` — GitHub's release body verbatim, empty when the release has none — and drops `asset_url`/`signature_url`. The app no longer picks a download from the release's asset list: its own signed updater manifest names the artifact for the running bundle, verifies it against the bundled public key and installs it, refused by name when the manifest or the signature disagrees. A nightly's exact identity comes from its controlled `Houston nightly <version>` release title, including build metadata; once installed, the commit suffix prevents that same rolling build from being offered again. The daemon still only asks GitHub and broadcasts what it found |
| 105 | **Autopilot and "Create with AI" are removed.** Gone from the wire: `autopilot_start`/`autopilot_cancel` and `autopilot_state` with the whole `Autopilot*` type family (`AutopilotMode`, `AutopilotStopped`, `AutopilotCheckIn`, `AutopilotSpend`, the turn caps); `agent_draft_with_ai` and `agent_draft`/`agent_draft_error` with `AgentDraftErrorKind`; the pane-header Autopilot chip and its popover. `HeadlessRoleKind` loses `judge` and `draft` — only `writer` ("Write with AI") remains, and `headless_roles` now carries a single `writer: HeadlessRoleView`. There is no migration: a stored role setting has no reader, and a run lived in memory only |
| 102 | **A nightly channel you have to ask for.** `UpdatePolicy` gains `channel: UpdateChannel` (`stable` \| `nightly`, default stable, absent or unrecognised reads as stable). The daemon fetches `releases/latest` on stable and the rolling `releases/tags/nightly` on nightly — `releases/latest` is documented to skip prereleases and would never return it. A prerelease payload is refused on stable and accepted on nightly; a draft is refused on both. Nightly also offers an equal version, because a rolling tag carries whatever `main` is at and strictly-greater would never fire. Moving the channel drops the standing answer: what stable found is not an answer about nightly |
| 101 | **Houston tells you a version exists.** Three client messages — `update_get`, `update_policy_set` and `update_check_now` — and one server message, `update{policy: UpdatePolicy, state: UpdateState}`, with the new `UpdatePolicy`/`UpdateState`/`UpdateRelease` types. The daemon asks GitHub on start, every 24 h and on demand, broadcasting each state change; `updates_check` off means no request is ever made, and nothing identifying the machine is sent either way. The daemon never installs anything — that is the operator's click |
| 100 | **Session tags.** The daemon gains a tag registry (`TagInfo`: name ≤ `MAX_TAG_NAME_LEN`, color from the fixed `TAG_PALETTE`, unique case-insensitively) and per-session membership (`SessionInfo.tags`, tag ids, ≤ `MAX_TAGS_PER_SESSION`). New `tag_create`/`tag_update`/`tag_delete` (replies: `tag_list` bcast, plus `tag_deleted` beside a delete so clients holding the id — a tag filter — clean up) and `session_set_tags` (reply: `session_tags_set` bcast). `hello_ok` carries the registry at hello. Membership by id, not name: a rename is one registry write every client follows, no session rewrite |
| 72 | Agents-mode chat: `chat_list`/`chat_messages`/`chat_create`/`chat_rename`/`chat_delete`/`chat_send`/`chat_stop`/`chat_answer`, `chats`/`chat_history`/`chat_event`/`chat_refused`, the whole `Chat*` type family, and `Agent.working_dir` |
| 73 | `session_create` gains `prompt?` — the initial task the new-session composer hands each pane, delivered as argv rather than typed into a PTY |
| 74 | `Agent.purpose` + `AGENT_PURPOSE_MAX`; `agent_create` gains `working_dir?`/`purpose?`; new `agent_created` and `chat_started` direct replies; `ChatTarget`/`ChatEffort`/`ChatPermissionMode`; `chat_create` removed — a thread is born by its first send |
| 75 | `Agent.{default_model, default_effort, default_permission_mode, default_plan}` and matching `agent_update` patch fields: record defaults that seed a new chat draft, not thread values |
| 76 | `Agent.skills` becomes a list of DOCUMENTS: `AgentSkill`/`AgentSkillDoc`/`SkillStarter`, the five `agent_skill_*` messages, `agent_skill_doc`/`agent_skill_error`, `AgentLimitKind::skill_source`, and the four `SKILL_*` caps |
| 77 | `orchestration_master_set` + `OrchestrationState.master_enabled` — the global orchestration kill-switch becomes daemon state; the consent broadcast now carries the full roster instead of the toggled workspace alone |
| 78 | Agent mail: `Agent.allow_agent_messaging`, `agent_messaging_get`/`set` + `agent_messaging_state` (app-wide pause), `ChatRowKind::{receipt, mail}`, `ChatEventKind::{receipt_row, mail_row}`, three new `ChatRefusalKind`s, and `chat_send.mentions` |
| 79 | Settings → Usage: `usage_summary_get` → `usage_summary`, the eight `Usage*` types, `USAGE_MAX_WINDOW_DAYS` and `USAGE_WINDOW_REFUSED` |
| 80 | Create with AI: `agent_draft_with_ai{seed}` → `agent_draft{name, brief}` or `agent_draft_error{kind}`. A draft writes nothing |
| 81 | Resume is removed. Gone: `agent_sessions_resumable`/`agent_sessions_history`/`agent_sessions_latest_for_panes` and their replies, `ResumableAgentSession`/`HistoryAgentSession`/`AgentSessionStatus`, `session_create.resume_native_id`, `RestoreReason::resume_offered`, and `SwarmAgentInfo.{native_session_id, config_dir}`. A restarted pane comes back on a fresh CLI |
| 83 | **Autopilot says what it costs.** `autopilot_state` gains `spend: AutopilotSpend` — `calls`, `input_tokens`, `cache_creation_tokens`, `cache_read_tokens`, `output_tokens`, `cost_usd` — summed from the judge CLI's `--output-format json` envelope, which the daemon previously read for `result` and threw the rest away. `usage/` cannot cover this: it prices pane transcripts, and a judge call is not a pane. `cost_usd` is the CLI's own figure and reads 0 on a subscription |
| 82 | Autopilot modes, per-mode budgets, named stops and the settle detector. **New `AutopilotMode`** (`complete`/`review`/`harden`/`goal`/`dream`) on `autopilot_start`, with `objective` now optional and legal only for `goal`. `AUTOPILOT_DEFAULT_MAX_TURNS`/`AUTOPILOT_MAX_MAX_TURNS` are replaced by `AUTOPILOT_STANDARD_MAX_TURNS` (60) and `AUTOPILOT_DREAM_MAX_TURNS` (240), selected by `autopilot_turn_cap(mode)`. **`AutopilotStopped` gains four variants** — `needs_input`, `unsettled`, `pane_exited`, `agent_changed` — so a stop says which thing to do about it instead of collapsing into `stuck`. `autopilot_state` gains `mode`, `objectives_completed` and a per-verdict `check_in`, because an unattended loop that cannot be read afterwards is not auditable. The arm-time refusal for a CLI with no full hook map is gone: such panes now run on a settle detector (bounded, hookless-only) recorded as the fourth content exception in `docs/internals/invariants.md`. **The judge model is a setting**, not a source constant: `AutopilotJudgeModelGet`/`AutopilotJudgeModelSet` → `ServerMsg::AutopilotJudgeModel{model, choices}` with `AUTOPILOT_JUDGE_MODELS` riding the wire, so the settings row offers exactly what the daemon accepts and an off-list value is refused naming it rather than stored to fail one judge call at a time |
| 86 | **Orchestration is one switch.** Per-workspace consent is gone: `OrchestrationConsent`, `orchestration_settings_set` and `OrchestrationState.consents` are removed, `orchestration_master_set` becomes `orchestration_set{enabled}`, `OrchestrationState.master_enabled` becomes `enabled`, and `orchestration_settings_get` takes no `workspace`. The switch is off by default (an absent key used to read as on above a consent that started off; with nothing underneath it, it inherits the conservative default). Workspace add/remove no longer broadcast `orchestration_state`. `history_count` loses its `workspace` on both sides and counts every workspace — the same rows `history_clear` with no `workspace` removes |
| 87 | **Agents become bots.** `Routine` gains `thread_id?`/`permission_mode`/`isolate`/`last_outcome?` and the new `RoutineOutcome`; `routine_create`/`routine_update` take the last three; `routines` carries `running`. `ChatThread` gains `last_read_at?` and `chat_mark_read` sets it, making unread daemon state. New `chat_notice` (thread-keyed `agent_notice`) with `CHAT_PREVIEW_MAX`. `Agent` gains a resolved `avatar: AgentMark` + `avatar_generated`, with the three-state `agent_update.avatar`. Three run caps ride the generated constants: `ROUTINE_TICK_MS`, `ROUTINE_RUNS_CONCURRENT`, `ROUTINE_RUN_MAX_MS` |
| 88 | **One conversation per bot.** `Agent` gains `title`/`notify`/`retain_detail_days`/`thread_id?`; `AgentInbox.preview_thread_id` is replaced by `bytes`. `Routine.thread_id` is replaced by `continue_context` — every run now lands in `Agent.thread_id`. `ChatRowKind::Run` + `ChatMessage.run?: RunKicker` carry a routine run as a transcript row. Every chat message is addressed by `agent_id`, never a thread id: `chat_list`/`chat_rename`/`chat_delete`, `Chats`/`ChatStarted` and `ChatTarget` are gone; `chat_messages`/`chat_history` are paged (`before?`/`older`, `CHAT_PAGE_ROWS`); new `run_index`/`run_rows` list a bot's runs; new `chat_engine_support_get`/`chat_engine_support` replace the table `Chats` used to carry. New `agent_export`/`agent_export_data` (`AgentExportFile`, `AGENT_EXPORT_VERSION`) and `agent_duplicate`; `agent_create` gains the matching optional import fields. `agent_update` gains `title?`/`notify?` and three-state `retain_detail_days?`. `RoutineCreate`/`RoutineUpdate` gain `continue_context?`. `RoutineOutcome` and `ChatRefusalKind` gain `archive_full`. New `chat_start_fresh`. `ChatEventKind` gains `run_row`/`note_row` |
| 90 | **The two headless roles become one setting each.** Autopilot's judge and "Create with AI" (`docs/internals/agent-lifecycle.md`) gain an engine picker beside their model picker. New `HeadlessRoleKind` (`judge`\|`draft`), `HeadlessEngineOption` (`engine`, `enabled`, `reason?`, `verified`, `models`) and `HeadlessRoleView` (`role`, resolved `engine`/`engine_is_default`, resolved `model?`/`model_is_default`, `engines: HeadlessEngineOption[]`). `AutopilotJudgeModelGet`/`AutopilotJudgeModelSet` → `ServerMsg::AutopilotJudgeModel` are replaced by `HeadlessRolesGet`/`HeadlessRoleSet{role, engine?, model?}` → `ServerMsg::HeadlessRoles{judge, draft}`; a stored v82 `autopilot_judge_model` value is still honoured for the judge until the role is set through the new message |

| 99 | **Codex hook trust on the setup row.** `AgentHookState` gains `trust: HookTrust?` (`no_config`\|`not_confirmed`\|`some_trusted`), filled for Codex from `~/.codex/config.toml`'s `[hooks.state]` — whether Codex's own review screen has ever accepted a hook, and `None` for every other provider |
| 98 | **The codename survives the rename.** `SessionInfo` gains `codename`: the spawn-time codename, kept when the first prompt renames `title`. `sessions.codename` is written at spawn and backfilled on read (a row still at `title_source = 'codename'` takes its title, any other row without one is minted a fresh codename, persisted on first load). `child_label`/`inbox_sender_label` and the `pane_spawn`/`pane_list` shapes read `role (codename)`, so `compose_inbox`'s `from <role (codename)>` holds by construction |
| 97 | **The orchestration inbox: producers and door 3.** Every signal a pane owes another pane is written to `pane_inbox` and delivered by paste; `delegations.staged_result`/`staged_superseded` are gone (migrated into the table, `SCHEMA_VERSION` 1 → 2). One new message, `inbox_deliver_now{session}`: door 3 never pastes over a prompt the operator has typed and not submitted, and on a pane whose CLI reports no submission boundary this is the only thing that clears the hold. `DelegationInfo.result_staged`/`superseded` keep their names and their meaning, fed from the inbox instead of the dropped columns |
| 96 | **The orchestration inbox: schema and wire, additive only.** `SessionInfo` gains `inbox_unread`; new `InboxRow`/`InboxKind`/`InboxDeliveredVia` and `inbox_list{workspace}` → `inbox_rows`, `inbox_ack{id}`/`inbox_resolve{id}` → `inbox_changed` (bcast) or a named `error`. Nothing reads `pane_inbox` on any hot path yet — no producer, no door, no paste; this PR only lays the table and the wire the following ones read from |
| 94 | **Headless VT: a pane reattaches from state.** `hello_ok` gains `snapshot_attach` (this daemon owns a terminal emulator) and `snapshot_format_version` (the container it writes). `session_attach` gains `snapshot?`, and its reply may now be the new `attach_snapshot{session, generation, attempt, output_offset, format_version, state}` — the emulator's versioned state at an output cutoff, base64 on the JSON channel, in place of a byte replay. A daemon with no emulator (Windows) advertises `snapshot_attach: false`, and a snapshot that cannot be encoded falls back to `scrollback`, so byte replay remains the contract nothing may lose |
| 93 | **Detach.** `hello_ok` gains `safe_mode: SafeModeSummary` (`disable_auto_restore`, `disable_swarm_autolaunch`) — under Detach the app is a separate process from the daemon and can no longer read the daemon's own `HOUSTON_SAFE_MODE` env var, so this rides the connect-time message the same way `recovery` already does. New `ServerMsg::BrowserToolCall{request_id, tool, args}` / `ClientMsg::BrowserToolResult{request_id, ok, output?, error?}`: the browser-tool relay's wire half, for the `ToolProvider` that moved from the app's own process into the daemon and now must ask whichever `/ws` connection owns the window to actually run the tool |
| 92 | **Frames leave the broadcast; a drop is a gap.** Each `/ws` connection takes PTY frames from its own bounded queue per attached session (144 frames / 4 MiB); a client that falls behind drops only its own frames and receives a `FRAME_GAP` anchored where loss began. Control lag closes the socket with `error{context:"control_lag"}` instead of dropping lifecycle events silently. `scrollback` gains `attempt`, the attachment generation, so a late reply cannot re-sync a pane to an older boundary, and nothing a replay covers follows its reply |
| 91 | Connections adds `McpServer.destinations` (empty = all supported tools), `mcp_server_upsert`, `mcp_server_remove`, and `mcp_test`. Upsert/remove change Houston's list; `mcp_sync` applies it. `mcp_state.checks` reports ephemeral `McpConnectionCheck` results from explicit connection tests. |
