//! Night shift runs as the daemon drives them: settings, start and preflight,
//! wrap-up and hard stop, the ledger the orchestrator writes, keep-awake,
//! restart recovery and provider substitution.
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use houston_protocol as proto;
use serde_json::{json, Value};

use super::{now_unix_ms, Daemon, RoutineRun};
use crate::db::{NightEntryWrite, NightRunRow};
use crate::night_shift::{awake, brief, preflight, settings, window};

type AwakeHook = Arc<dyn Fn(u32, bool) + Send + Sync>;
/// Every pane seen in a run's tree, with provider and first sighting.
type CrewSeen = HashMap<u32, (proto::AgentKind, i64)>;

enum HoldSlot {
    Real(#[allow(dead_code)] awake::Hold),
    Test,
}

/// What a run keeps in memory; the rest is in `night_runs`.
#[derive(Default)]
pub(crate) struct NightShiftCtx {
    /// Serializes read-modify-write of a run row.
    lock: Mutex<()>,
    holds: Mutex<HashMap<u32, HoldSlot>>,
    last_tick: Mutex<HashMap<u32, i64>>,
    /// Per run: every pane seen in its tree, with provider and first sighting.
    crew: Mutex<HashMap<u32, CrewSeen>>,
    stop_order: Mutex<HashMap<u32, Vec<u32>>>,
    /// Per ZCode pane of a run: when it last ended a turn (or was first seen).
    zcode_turns: Mutex<HashMap<u32, i64>>,
    facts_for_test: Mutex<Option<preflight::Facts>>,
    awake_for_test: Mutex<Option<AwakeHook>>,
    zcode_probe_for_test: Mutex<Option<bool>>,
}

const MINUTE_MS: i64 = 60_000;

fn parse_settings(json: &str) -> Result<proto::NightShiftSettings> {
    serde_json::from_str(json).with_context(|| format!("unreadable Night shift settings {json:?}"))
}

fn text_arg<'a>(args: &'a Value, key: &str, max: usize) -> Result<Option<&'a str>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let len = s.chars().count();
            if len > max {
                bail!("{key} is {len} characters; the limit is {max}");
            }
            Ok(Some(s.as_str()))
        }
        Some(other) => bail!("{key} must be a string; got {other}"),
    }
}

fn required<'a>(args: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    text_arg(args, key, max)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow!("{key} is required"))
}

fn bool_arg(args: &Value, key: &str) -> Result<Option<bool>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(other) => bail!("{key} must be true or false; got {other}"),
    }
}

fn gate_arg(args: &Value, key: &str, current: proto::NightGate) -> Result<proto::NightGate> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(current),
        Some(Value::String(s)) => match s.as_str() {
            "pending" => Ok(proto::NightGate::Pending),
            "passed" => Ok(proto::NightGate::Passed),
            "failed" => Ok(proto::NightGate::Failed),
            "none" => Ok(proto::NightGate::None),
            other => bail!("{key} {other:?} is not a gate; expected pending, passed or failed"),
        },
        Some(other) => bail!("{key} must be a string; got {other}"),
    }
}

impl Daemon {
    // ---- settings and state ----

    fn night_routine(&self, routine_id: u32) -> Result<crate::db::RoutineRow> {
        let row = self
            .db
            .routine(routine_id)?
            .ok_or_else(|| anyhow!("no routine with id {routine_id}"))?;
        if row.kind != proto::RoutineKind::NightShift {
            bail!(
                "routine {routine_id} ({:?}) is not a Night shift routine",
                row.name
            );
        }
        Ok(row)
    }

    fn night_settings(&self, routine_id: u32) -> Result<proto::NightShiftSettings> {
        match self.db.night_shift_settings_json(routine_id)? {
            Some(json) => parse_settings(&json),
            None => Ok(settings::defaults()),
        }
    }

    /// Creates the workspace's paused routine with the default settings, or
    /// answers the one it has.
    pub fn night_shift_create(self: &Arc<Self>, workspace: &str) -> Result<proto::ServerMsg> {
        if self.db.night_shift_routine_id(workspace)?.is_some() {
            return self.night_shift_state(workspace, None);
        }
        if !crate::git::is_git_repo(Path::new(workspace)) {
            bail!(
                "Night shift refused: {workspace:?} is not a git repository; each run works in \
                 an isolated worktree of it"
            );
        }
        let base = Path::new(workspace)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| workspace.to_string());
        let prefix = "Night shift · ";
        let base: String = base
            .chars()
            .take(proto::ROUTINE_NAME_MAX - prefix.chars().count() - 6)
            .collect();
        let first = format!("{prefix}{base}");
        let name = (1..=proto::ROUTINES_TOTAL)
            .map(|n| match n {
                1 => first.clone(),
                n => format!("{first} {n}"),
            })
            .find(|name| {
                !self
                    .db
                    .routine_name_taken(&crate::routines::fold_name(name), None)
                    .unwrap_or(true)
            })
            .ok_or_else(|| anyhow!("every Night shift routine name for {workspace} is taken"))?;
        let s = settings::defaults();
        let msg = self.routine_create_impl(
            &name,
            crate::night_shift::ROUTINE_PROMPT,
            Self::night_cadence(&s.window),
            Some(workspace.to_string()),
            s.orchestrator.provider,
            s.orchestrator.model.clone(),
            None,
            Some(proto::ChatPermissionMode::BypassPermissions),
            Some(true),
            false,
        )?;
        let proto::ServerMsg::Routines { routines, .. } = &msg else {
            return Ok(msg);
        };
        let folded = crate::routines::fold_name(&name);
        let created = routines
            .iter()
            .find(|r| crate::routines::fold_name(&r.name) == folded)
            .ok_or_else(|| anyhow!("the Night shift routine {name:?} was not listed"))?;
        self.db
            .set_night_shift_routine(created.id, &serde_json::to_string(&s)?)?;
        self.broadcast_control(&self.routine_list());
        self.night_shift_state(workspace, None)
    }

    fn night_cadence(w: &proto::NightWindow) -> proto::Cadence {
        proto::Cadence::Clock {
            hour: w.start.hour,
            minute: w.start.minute,
            weekdays: (!w.nights.is_empty()).then(|| w.nights.clone()),
        }
    }

    pub fn night_shift_state(
        self: &Arc<Self>,
        workspace: &str,
        preflight_until_ms: Option<i64>,
    ) -> Result<proto::ServerMsg> {
        let id = self.db.night_shift_routine_id(workspace)?;
        let routine = match id {
            Some(id) => self.db.routine(id)?.map(Self::routine_row_to_wire),
            None => None,
        };
        let settings = match id {
            Some(id) => self.night_settings(id)?,
            None => settings::defaults(),
        };
        let runs = match id {
            Some(id) => self
                .db
                .night_runs_of_routine(id, proto::NIGHT_SHIFT_RUNS_PAGE)?
                .into_iter()
                .map(|r| self.night_run_to_wire(r))
                .collect::<Result<Vec<_>>>()?,
            None => Vec::new(),
        };
        let facts = self.night_facts(&settings);
        let preflight = preflight_until_ms.map(|_| preflight::evaluate(&settings, &facts));
        let held = !self.night.holds.lock().expect("night holds").is_empty();
        Ok(proto::ServerMsg::NightShiftState {
            workspace: workspace.to_string(),
            routine,
            revision: settings::revision(&settings),
            settings,
            runs,
            preflight,
            machine: proto::NightMachine {
                memory_free_mib: facts.machine.memory_free_mib,
                disk_free_mib: facts.machine.disk_free_mib,
                on_battery: facts.machine.on_battery,
                keep_awake: if held {
                    proto::NightKeepAwake::Held
                } else {
                    proto::NightKeepAwake::Off
                },
            },
        })
    }

    pub fn night_shift_update(
        self: &Arc<Self>,
        routine_id: u32,
        next: proto::NightShiftSettings,
        expected_revision: &str,
    ) -> Result<proto::ServerMsg> {
        let row = self.night_routine(routine_id)?;
        let workspace = row
            .workspace_id
            .clone()
            .ok_or_else(|| anyhow!("Night shift routine {routine_id} has no workspace"))?;
        let current = settings::revision(&self.night_settings(routine_id)?);
        if current != expected_revision {
            bail!(
                "night_shift_update refused: the settings changed since they were read \
                 (expected revision {expected_revision}, current revision {current}); reload \
                 and apply the change again"
            );
        }
        let facts = settings::WorkspaceFacts {
            merge_verify_command: !self
                .db
                .merge_queue_settings(&workspace)?
                .verification_command
                .trim()
                .is_empty(),
        };
        settings::validate(&next, &facts)?;
        Self::check_routine_launch(
            next.orchestrator.provider,
            next.orchestrator.model.as_deref(),
            None,
            proto::ChatPermissionMode::BypassPermissions,
        )?;
        let cadence = Self::night_cadence(&next.window);
        let enabled = next.enabled;
        let now = now_unix_ms();
        let next_run_at_ms = window::next_start(now, &next.window).unwrap_or(row.next_run_at_ms);
        let revision = crate::routines::revision(
            &row.name,
            &row.prompt,
            &cadence,
            enabled,
            Some(&workspace),
            next.orchestrator.provider,
            next.orchestrator.model.as_deref(),
            None,
            proto::ChatPermissionMode::BypassPermissions,
            true,
        );
        self.db.update_routine(
            routine_id,
            &crate::db::RoutineWrite {
                name: &row.name,
                name_folded: &row.name_folded,
                prompt: &row.prompt,
                cadence_json: &serde_json::to_string(&cadence)?,
                enabled,
                workspace_id: Some(&workspace),
                engine: &crate::db::wire_name(&next.orchestrator.provider)?,
                model: next.orchestrator.model.as_deref(),
                effort: None,
                next_run_at_ms,
                permission_mode: &crate::db::wire_name(
                    &proto::ChatPermissionMode::BypassPermissions,
                )?,
                isolate: true,
                revision: &revision,
            },
        )?;
        self.db
            .set_night_shift_routine(routine_id, &serde_json::to_string(&next)?)?;
        self.routine_wake.notify_one();
        self.broadcast_control(&self.routine_list());
        self.night_shift_state(&workspace, None)
    }

    // ---- preflight facts ----

    #[doc(hidden)]
    pub fn set_night_shift_facts_for_test(&self, facts: Option<preflight::Facts>) {
        *self.night.facts_for_test.lock().expect("night facts") = facts;
    }

    /// Records keep-awake instead of asking the platform: `(run, held)`.
    #[doc(hidden)]
    pub fn set_night_shift_awake_for_test(&self, hook: Option<AwakeHook>) {
        *self.night.awake_for_test.lock().expect("night awake hook") = hook;
    }

    /// Forgets every run in flight, as a daemon restart does.
    #[doc(hidden)]
    pub fn forget_routine_runs_for_test(&self) {
        self.routine_runs.lock().expect("routine run lock").clear();
    }

    #[doc(hidden)]
    pub fn night_shift_mark_limited_for_test(
        self: &Arc<Self>,
        session: u32,
        provider: proto::AgentKind,
    ) {
        self.night_shift_provider_limited(session, provider, "test");
    }

    #[doc(hidden)]
    pub fn set_session_status_for_test(&self, session: u32, status: proto::AgentStatus) {
        if let Ok(s) = self.get(session) {
            *s.status.lock().expect("status lock") = Some(status);
        }
    }

    #[doc(hidden)]
    pub fn set_night_shift_zcode_probe_for_test(&self, ok: Option<bool>) {
        *self.night.zcode_probe_for_test.lock().expect("zcode probe") = ok;
    }

    fn night_facts(&self, s: &proto::NightShiftSettings) -> preflight::Facts {
        if let Some(f) = self
            .night
            .facts_for_test
            .lock()
            .expect("night facts")
            .clone()
        {
            return f;
        }
        let hooks = self.agent_hooks_state();
        let providers = preflight::providers_of(s)
            .into_iter()
            .map(|provider| preflight::ProviderFacts {
                provider,
                hooks_on: hooks
                    .iter()
                    .any(|h| h.provider == provider && h.enabled && h.installed),
                cli_present: hooks.iter().any(|h| h.provider == provider && h.present)
                    || self.cli_presence(provider).present,
            })
            .collect();
        let path = self.env().var("PATH");
        preflight::Facts {
            orchestration_enabled: self.orchestration_enabled(),
            providers,
            machine: preflight::probe_machine(&self.state_dir, path.as_deref()),
        }
    }

    // ---- start ----

    /// Run now with a duration: the hard stop is `until_ms`.
    pub fn night_shift_run_now(
        self: &Arc<Self>,
        routine_id: u32,
        until_ms: i64,
    ) -> Result<proto::ServerMsg> {
        let row = self.night_routine(routine_id)?;
        window::run_now(now_unix_ms(), until_ms)?;
        let in_flight = self
            .routine_runs
            .lock()
            .expect("routine run lock")
            .contains_key(&routine_id);
        if in_flight {
            bail!(
                "Night shift routine {routine_id} already has a run in flight; stop it before \
                 starting another"
            );
        }
        let run_id = self
            .night_shift_fire(&row, proto::RoutineTrigger::Manual, Some(until_ms))?
            .ok_or_else(|| anyhow!("the Night shift run did not start"))?;
        let run = self
            .db
            .night_run(run_id)?
            .ok_or_else(|| anyhow!("night run {run_id} vanished"))?;
        Ok(proto::ServerMsg::NightShiftRunEvent {
            run: self.night_run_to_wire(run)?,
        })
    }

    /// Every start goes through here: preflight, worktree, brief, pane.
    pub(super) fn night_shift_fire(
        self: &Arc<Self>,
        row: &crate::db::RoutineRow,
        trigger: proto::RoutineTrigger,
        until_ms: Option<i64>,
    ) -> Result<Option<u32>> {
        let now = now_unix_ms();
        let s = self.night_settings(row.id)?;
        let workspace = row
            .workspace_id
            .clone()
            .ok_or_else(|| anyhow!("Night shift routine {} has no workspace", row.id))?;
        let win = match until_ms {
            Some(until) => window::run_now(now, until)?,
            None => {
                let due = if trigger == proto::RoutineTrigger::Schedule {
                    row.next_run_at_ms.min(now)
                } else {
                    now
                };
                window::scheduled(due, &s.window)
            }
        };
        let next =
            window::next_start(win.hard_stop_at_ms, &s.window).unwrap_or(win.hard_stop_at_ms);
        let mut items = preflight::evaluate(&s, &self.night_facts(&s));
        let mut refusal = None;
        if win.wrap_up_at_ms <= now {
            refusal = Some(format!(
                "missed: the machine was not running Houston before wrap-up ({} min late)",
                (now - win.wrap_up_at_ms) / MINUTE_MS
            ));
        }
        let blocking: Vec<String> = items
            .iter()
            .filter(|i| i.status == proto::PreflightStatus::Block)
            .map(|i| i.id.clone())
            .collect();
        if refusal.is_none() && !blocking.is_empty() {
            refusal = Some(format!(
                "preflight blocked the run: {}",
                blocking.join(", ")
            ));
        }
        let mut run_dir = None;
        if refusal.is_none() {
            match self.routine_worktree(row, Path::new(&workspace), now) {
                Ok(d) => run_dir = Some(d),
                Err(e) => {
                    refusal = Some(format!(
                        "its worktree of {workspace} could not be made: {e:#}"
                    ))
                }
            }
        }
        let run_id = self.record_run_start(row, trigger, None, now, next)?;
        let report_dir = crate::night_shift::run_dir(&self.state_dir, run_id);
        let mut night = NightRunRow {
            run_id,
            routine_id: row.id,
            workspace: workspace.clone(),
            trigger,
            phase: proto::NightRunPhase::Running,
            session_id: None,
            started_at_ms: now,
            wrap_up_at_ms: win.wrap_up_at_ms,
            hard_stop_at_ms: win.hard_stop_at_ms,
            ended_at_ms: None,
            report_path: report_dir.join("report.md").display().to_string(),
            report_published: false,
            summary: None,
            wrap_up_sent: false,
            stop_reason: None,
            stop_detail: None,
            interruptions: Vec::new(),
            cost: proto::NightCost::default(),
            limited: Vec::new(),
            preflight: std::mem::take(&mut items),
            keep_awake: proto::NightKeepAwake::Off,
            merge_order: Vec::new(),
        };
        if let Some(why) = refusal {
            night.phase = proto::NightRunPhase::Refused;
            night.ended_at_ms = Some(now);
            night.stop_detail = Some(why.clone());
            self.db.create_night_run(&night)?;
            self.settle_run(
                run_id,
                row.id,
                proto::RoutineOutcome::EngineRefused,
                Some(why),
            );
            return Ok(Some(run_id));
        }
        self.db.create_night_run(&night)?;
        std::fs::create_dir_all(&report_dir)
            .with_context(|| format!("creating {}", report_dir.display()))?;
        let digest = self
            .db
            .night_digest(row.id, run_id, proto::NIGHT_SHIFT_DIGEST_ENTRIES_MAX)?;
        let (wrap_label, stop_label) = brief::window_labels(
            win.wrap_up_at_ms,
            win.hard_stop_at_ms,
            window::local_offset_ms,
        );
        let report_path = night.report_path.clone();
        let text = brief::compose(
            &s,
            &brief::BriefRun {
                run_id,
                report_path: &report_path,
                wrap_up: &wrap_label,
                hard_stop: &stop_label,
            },
            &digest,
        );
        let brief_path = report_dir.join("brief.md");
        std::fs::write(&brief_path, &text)
            .with_context(|| format!("writing {}", brief_path.display()))?;
        let dir = run_dir
            .expect("a run that was not refused has its worktree")
            .to_string_lossy()
            .into_owned();
        let mut launch_row = row.clone();
        launch_row.engine = s.orchestrator.provider;
        launch_row.model = s.orchestrator.model.clone();
        launch_row.permission_mode = proto::ChatPermissionMode::BypassPermissions;
        let env = vec![(
            crate::night_shift::RUN_DIR_ENV.to_string(),
            report_dir.display().to_string(),
        )];
        self.routine_spawn_run_pane(&launch_row, run_id, now, next, &dir, text, env)?;
        self.broadcast_night_run(run_id);
        Ok(Some(run_id))
    }

    /// The dev channel may stand a script in for the orchestrator's CLI: a
    /// PowerShell script path on Windows, a `sh -c` command elsewhere. The
    /// launch appends the brief as arguments, which both forms ignore.
    pub(super) fn night_shift_dev_cmd(&self) -> Option<Vec<String>> {
        let channel = crate::paths::channel_of_state_dir(&self.state_dir);
        if channel.as_deref() != Some("dev") {
            return None;
        }
        let cmd = self
            .env()
            .var("HOUSTON_NIGHT_SHIFT_DEV_CMD")
            .filter(|c| !c.trim().is_empty())?;
        Some(if cfg!(windows) {
            vec![
                "powershell.exe".into(),
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                cmd,
            ]
        } else {
            vec!["sh".into(), "-c".into(), cmd]
        })
    }

    pub(super) fn night_shift_pane_opened(self: &Arc<Self>, run_id: u32, session: u32) {
        let _guard = self.night.lock.lock().expect("night lock");
        let Ok(Some(mut row)) = self.db.night_run(run_id) else {
            return;
        };
        row.session_id = Some(session);
        row.keep_awake = self.night_awake_acquire(run_id);
        if row.keep_awake == proto::NightKeepAwake::Unavailable
            && !row.preflight.iter().any(|i| i.id == "inhibit_unavailable")
        {
            row.preflight.extend(awake::inhibitor_item(false));
        }
        if let Err(e) = self.db.save_night_run(&row) {
            tracing::warn!("recording night run {run_id}'s pane: {e:#}");
        }
        self.night
            .last_tick
            .lock()
            .expect("night ticks")
            .insert(run_id, row.started_at_ms);
    }

    fn night_awake_acquire(&self, run_id: u32) -> proto::NightKeepAwake {
        let hook = self
            .night
            .awake_for_test
            .lock()
            .expect("night awake hook")
            .clone();
        let slot = match hook {
            Some(hook) => {
                hook(run_id, true);
                Some(HoldSlot::Test)
            }
            None => match awake::acquire(self.env().var("PATH").as_deref()) {
                Ok(hold) => Some(HoldSlot::Real(hold)),
                Err(why) => {
                    tracing::warn!("Night shift run {run_id} runs without keep-awake: {why}");
                    None
                }
            },
        };
        match slot {
            Some(slot) => {
                self.night
                    .holds
                    .lock()
                    .expect("night holds")
                    .insert(run_id, slot);
                proto::NightKeepAwake::Held
            }
            None => proto::NightKeepAwake::Unavailable,
        }
    }

    fn night_awake_release(&self, run_id: u32) {
        let slot = self
            .night
            .holds
            .lock()
            .expect("night holds")
            .remove(&run_id);
        if let Some(HoldSlot::Test) = slot {
            if let Some(hook) = self
                .night
                .awake_for_test
                .lock()
                .expect("night awake hook")
                .clone()
            {
                hook(run_id, false);
            }
        }
        drop(slot);
    }

    // ---- runs in flight ----

    fn night_runs_live(&self) -> Vec<(u32, RoutineRun)> {
        self.routine_runs
            .lock()
            .expect("routine run lock")
            .iter()
            .filter(|(_, run)| run.night)
            .map(|(id, run)| (*id, *run))
            .collect()
    }

    /// The live Night shift run whose tree holds `session`, as (routine, run,
    /// orchestrator).
    pub(crate) fn night_run_of_pane(&self, session: u32) -> Option<(u32, u32, u32)> {
        for (routine_id, run) in self.night_runs_live() {
            let Some(orchestrator) = run.session_id else {
                continue;
            };
            if orchestrator == session || self.descendants_of(orchestrator).contains(&session) {
                return Some((routine_id, run.run_id, orchestrator));
            }
        }
        None
    }

    pub(crate) fn is_night_shift_orchestrator(&self, session: u32) -> bool {
        self.night_runs_live()
            .iter()
            .any(|(_, run)| run.session_id == Some(session))
    }

    /// False keeps the run in flight: an orchestrator's turn end settles its
    /// run only after `night_report`.
    pub(super) fn night_shift_turn_ended(&self, session: u32) -> bool {
        self.night_zcode_turn_ended(session);
        let Some((_, run)) = self
            .night_runs_live()
            .into_iter()
            .find(|(_, run)| run.session_id == Some(session))
        else {
            return true;
        };
        let _guard = self.night.lock.lock().expect("night lock");
        match self.db.night_run(run.run_id) {
            Ok(Some(mut row)) if row.report_published => {
                if row.stop_reason.is_none() {
                    row.stop_reason = Some(proto::NightStopReason::Report);
                    if let Err(e) = self.db.save_night_run(&row) {
                        tracing::warn!("recording night run {}'s end: {e:#}", row.run_id);
                    }
                }
                true
            }
            _ => false,
        }
    }

    pub fn night_shift_tick_at(self: &Arc<Self>, now_ms: i64) {
        for (routine_id, run) in self.night_runs_live() {
            let Ok(Some(row)) = self.db.night_run(run.run_id) else {
                continue;
            };
            let pane_hours = self.night_account(&row, now_ms);
            if now_ms >= row.hard_stop_at_ms {
                self.night_shift_stop_run(routine_id, run, proto::NightStopReason::HardStop, None);
            } else if pane_hours >= f64::from(self.night_cap(row.routine_id)) {
                let cap = self.night_cap(row.routine_id);
                self.night_shift_stop_run(
                    routine_id,
                    run,
                    proto::NightStopReason::SafetyCap,
                    Some(format!(
                        "{pane_hours:.2} pane-hours reached the {cap} pane-hour safety cap"
                    )),
                );
            } else {
                if now_ms >= row.wrap_up_at_ms && !row.wrap_up_sent {
                    self.night_send_wrap_up(run.run_id);
                }
                self.night_zcode_stall_pass(run.run_id, now_ms);
            }
        }
    }

    fn night_cap(&self, routine_id: u32) -> u32 {
        self.night_settings(routine_id)
            .map(|s| s.safety_cap_pane_hours)
            .unwrap_or(60)
    }

    /// Adds the panes' time since the last tick to the run's cost; answers
    /// the run's pane-hours so far.
    fn night_account(&self, row: &NightRunRow, now_ms: i64) -> f64 {
        let Some(orchestrator) = row.session_id else {
            return row.cost.pane_hours;
        };
        let mut panes = vec![orchestrator];
        panes.extend(self.descendants_of(orchestrator));
        let since = {
            let mut ticks = self.night.last_tick.lock().expect("night ticks");
            let last = ticks
                .insert(row.run_id, now_ms)
                .unwrap_or(row.started_at_ms);
            (now_ms - last).max(0)
        };
        let _guard = self.night.lock.lock().expect("night lock");
        let Ok(Some(mut row)) = self.db.night_run(row.run_id) else {
            return 0.0;
        };
        let hours = since as f64 / 3_600_000.0;
        {
            let mut crew = self.night.crew.lock().expect("night crew");
            let seen = crew.entry(row.run_id).or_default();
            for id in &panes {
                let provider = self
                    .get(*id)
                    .map(|s| s.info.agent)
                    .unwrap_or(proto::AgentKind::Custom);
                seen.entry(*id).or_insert((provider, now_ms));
                row.cost.pane_hours += hours;
                match row
                    .cost
                    .per_provider
                    .iter_mut()
                    .find(|l| l.provider == provider)
                {
                    Some(line) => line.pane_hours += hours,
                    None => row.cost.per_provider.push(proto::NightCostLine {
                        provider,
                        panes: 0,
                        pane_hours: hours,
                    }),
                }
            }
            row.cost.panes = seen.len() as u32;
            for line in &mut row.cost.per_provider {
                line.panes = seen.values().filter(|(p, _)| *p == line.provider).count() as u32;
            }
        }
        if let Err(e) = self.db.save_night_run(&row) {
            tracing::warn!("recording night run {}'s cost: {e:#}", row.run_id);
        }
        self.night_heartbeat(row.run_id, now_ms);
        row.cost.pane_hours
    }

    fn night_heartbeat(&self, run_id: u32, now_ms: i64) {
        if let Err(e) = self.db.set_night_heartbeat(run_id, now_ms) {
            tracing::warn!("recording night run {run_id}'s heartbeat: {e:#}");
        }
    }

    fn night_tell_orchestrator(self: &Arc<Self>, run_id: u32, title: &str, body: &str) {
        let Ok(Some(row)) = self.db.night_run(run_id) else {
            return;
        };
        let Some(orchestrator) = row.session_id else {
            return;
        };
        if let Err(e) = self.inbox_write(
            orchestrator,
            &row.workspace,
            None,
            None,
            crate::orchestrate::InboxKind::OperatorNote,
            title,
            body,
            Vec::new(),
            None,
            None,
            false,
            true,
        ) {
            tracing::warn!("telling night run {run_id}'s orchestrator {title:?}: {e:#}");
        }
    }

    fn night_send_wrap_up(self: &Arc<Self>, run_id: u32) {
        {
            let _guard = self.night.lock.lock().expect("night lock");
            let Ok(Some(mut row)) = self.db.night_run(run_id) else {
                return;
            };
            if row.wrap_up_sent || row.ended_at_ms.is_some() {
                return;
            }
            row.wrap_up_sent = true;
            row.phase = proto::NightRunPhase::WrappingUp;
            if let Err(e) = self.db.save_night_run(&row) {
                tracing::warn!("recording night run {run_id}'s wrap-up: {e:#}");
                return;
            }
        }
        let (_, stop) = self
            .db
            .night_run(run_id)
            .ok()
            .flatten()
            .map(|r| {
                brief::window_labels(r.wrap_up_at_ms, r.hard_stop_at_ms, window::local_offset_ms)
            })
            .unwrap_or_default();
        self.night_tell_orchestrator(
            run_id,
            "Night shift wrap-up",
            &format!(
                "Wrap-up has begun. Start nothing new: finish or park what is in flight, record \
                 every open thread with the night_* tools, write the report and call \
                 night_report. Houston closes every pane at the hard stop ({stop})."
            ),
        );
        self.broadcast_night_run(run_id);
    }

    /// Closes the run's descendants, then its orchestrator, and settles it.
    fn night_shift_stop_run(
        self: &Arc<Self>,
        routine_id: u32,
        run: RoutineRun,
        reason: proto::NightStopReason,
        detail: Option<String>,
    ) {
        let taken = {
            let mut running = self.routine_runs.lock().expect("routine run lock");
            if running
                .get(&routine_id)
                .is_some_and(|current| current.run_id == run.run_id)
            {
                running.remove(&routine_id)
            } else {
                None
            }
        };
        let Some(run) = taken else { return };
        {
            let _guard = self.night.lock.lock().expect("night lock");
            if let Ok(Some(mut row)) = self.db.night_run(run.run_id) {
                if row.stop_reason.is_none() {
                    row.stop_reason = Some(reason);
                    row.stop_detail = detail;
                }
                if let Err(e) = self.db.save_night_run(&row) {
                    tracing::warn!("recording night run {}'s stop: {e:#}", run.run_id);
                }
            }
        }
        let mut order = Vec::new();
        if let Some(orchestrator) = run.session_id {
            for child in self.descendants_of(orchestrator).into_iter().rev() {
                if let Err(e) = self.kill(child) {
                    tracing::warn!("closing night run {}'s pane {child}: {e:#}", run.run_id);
                }
                order.push(child);
            }
            if let Err(e) = self.kill(orchestrator) {
                tracing::warn!("closing night run {}'s orchestrator: {e:#}", run.run_id);
            }
            order.push(orchestrator);
        }
        self.night
            .stop_order
            .lock()
            .expect("night stop order")
            .insert(run.run_id, order);
        self.settle_run(run.run_id, routine_id, proto::RoutineOutcome::Ok, None);
    }

    /// The panes a hard stop closed, in order.
    #[doc(hidden)]
    pub fn night_shift_stop_order(&self, run_id: u32) -> Vec<u32> {
        self.night
            .stop_order
            .lock()
            .expect("night stop order")
            .get(&run_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn night_shift_wrap_up_now(self: &Arc<Self>, run_id: u32) -> Result<()> {
        self.night_live_run(run_id)?;
        self.night_send_wrap_up(run_id);
        Ok(())
    }

    pub fn night_shift_stop_now(self: &Arc<Self>, run_id: u32) -> Result<()> {
        let (routine_id, run) = self.night_live_run(run_id)?;
        self.night_shift_stop_run(routine_id, run, proto::NightStopReason::Stopped, None);
        Ok(())
    }

    fn night_live_run(&self, run_id: u32) -> Result<(u32, RoutineRun)> {
        self.night_runs_live()
            .into_iter()
            .find(|(_, run)| run.run_id == run_id)
            .ok_or_else(|| anyhow!("Night shift run {run_id} is not in flight"))
    }

    /// Called for every settled routine run; closes the Night shift side.
    pub(super) fn night_shift_settled(&self, run_id: u32) {
        let row = {
            let _guard = self.night.lock.lock().expect("night lock");
            let Ok(Some(mut row)) = self.db.night_run(run_id) else {
                return;
            };
            if row.phase == proto::NightRunPhase::Settled {
                return;
            }
            let now = now_unix_ms();
            row.ended_at_ms = Some(row.ended_at_ms.unwrap_or(now));
            if row.phase != proto::NightRunPhase::Refused {
                row.phase = proto::NightRunPhase::Settled;
                if row.stop_reason.is_none() {
                    row.stop_reason = Some(proto::NightStopReason::PaneExited);
                }
            }
            if row.keep_awake == proto::NightKeepAwake::Held {
                row.keep_awake = proto::NightKeepAwake::Off;
            }
            if let Err(e) = self.db.save_night_run(&row) {
                tracing::warn!("settling night run {run_id}: {e:#}");
            }
            row
        };
        self.night_awake_release(run_id);
        self.night
            .last_tick
            .lock()
            .expect("night ticks")
            .remove(&run_id);
        let crew = self.night.crew.lock().expect("night crew").remove(&run_id);
        if let Some(crew) = crew {
            self.night
                .zcode_turns
                .lock()
                .expect("zcode turns")
                .retain(|session, _| !crew.contains_key(session));
        }
        self.broadcast_night_run(run_id);
        let entries = self.db.night_entries(run_id).unwrap_or_default();
        let prs = entries
            .iter()
            .filter(|e| e.kind == proto::NightEntryKind::Pr)
            .count();
        let open = entries
            .iter()
            .filter(|e| e.kind == proto::NightEntryKind::Decision && e.choice.is_none())
            .count();
        self.broadcast_control(&proto::ServerMsg::NightShiftNotice {
            workspace: row.workspace.clone(),
            run_id,
            headline: crate::night_shift::headline(
                prs,
                open,
                row.phase == proto::NightRunPhase::Refused,
            ),
        });
    }

    // ---- restart recovery ----

    /// After a daemon start: a run whose hard stop is ahead and whose wrap-up
    /// has not passed continues; any other is settled. Both record the gap.
    pub fn night_shift_recover_at(self: &Arc<Self>, now_ms: i64) {
        let rows = match self.db.night_runs_in_flight() {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("reading Night shift runs to recover: {e:#}");
                return;
            }
        };
        for mut row in rows {
            let tracked = self
                .routine_runs
                .lock()
                .expect("routine run lock")
                .values()
                .any(|r| r.run_id == row.run_id);
            if tracked {
                continue;
            }
            let orchestrator = row.session_id.and_then(|s| self.night_live_successor(s));
            let at_ms = self
                .db
                .night_heartbeat(row.run_id)
                .ok()
                .flatten()
                .unwrap_or(row.started_at_ms);
            let resumable = now_ms < row.hard_stop_at_ms
                && now_ms < row.wrap_up_at_ms
                && !row.wrap_up_sent
                && orchestrator.is_some();
            let detail = if resumable {
                "the daemon restarted; the run continued".to_string()
            } else if orchestrator.is_none() {
                "the daemon restarted and the orchestrator pane did not come back".to_string()
            } else {
                "the daemon came back after wrap-up; the run was settled".to_string()
            };
            row.interruptions.push(proto::NightInterruption {
                at_ms,
                resumed_at_ms: now_ms,
                detail: detail.clone(),
                resumed: resumable,
            });
            if let Some(o) = orchestrator {
                row.session_id = Some(o);
            }
            if !resumable {
                row.stop_reason = Some(proto::NightStopReason::Restart);
                row.stop_detail = Some(detail.clone());
                if let Err(e) = self.db.save_night_run(&row) {
                    tracing::warn!("recording night run {}'s interruption: {e:#}", row.run_id);
                }
                if let Some(o) = orchestrator {
                    for child in self.descendants_of(o).into_iter().rev() {
                        let _ = self.kill(child);
                    }
                    let _ = self.kill(o);
                }
                self.settle_run(
                    row.run_id,
                    row.routine_id,
                    proto::RoutineOutcome::Ok,
                    Some(detail),
                );
                continue;
            }
            let session = orchestrator.expect("resumable runs have their pane");
            if let Err(e) = self.db.save_night_run(&row) {
                tracing::warn!("recording night run {}'s interruption: {e:#}", row.run_id);
            }
            if let Err(e) = self.db.set_routine_run_session(row.run_id, session) {
                tracing::warn!("recording night run {}'s pane: {e:#}", row.run_id);
            }
            self.routine_runs.lock().expect("routine run lock").insert(
                row.routine_id,
                RoutineRun {
                    run_id: row.run_id,
                    session_id: Some(session),
                    started_at_ms: row.started_at_ms,
                    denied: false,
                    night: true,
                },
            );
            let mut panes = vec![session];
            panes.extend(self.descendants_of(session));
            for pane in panes {
                self.night_resume_held(pane);
            }
            self.night_shift_pane_opened(row.run_id, session);
            self.night
                .last_tick
                .lock()
                .expect("night ticks")
                .insert(row.run_id, now_ms);
            self.broadcast_night_run(row.run_id);
            self.broadcast_control(&self.routine_list());
        }
    }

    /// The live pane that continues `session`: itself, or its respawn.
    fn night_live_successor(&self, session: u32) -> Option<u32> {
        let live = |id: u32| {
            self.get(id)
                .is_ok_and(|s| s.state.lock().expect("state lock").is_live())
        };
        if live(session) {
            return Some(session);
        }
        let origin = self.db.session_origin(session).unwrap_or(session);
        let sessions = self.sessions.lock().expect("sessions lock");
        sessions
            .values()
            .filter(|s| s.state.lock().expect("state lock").is_live())
            .filter(|s| s.info.session_origin == Some(origin))
            .map(|s| s.info.id)
            .max()
    }

    /// Held instructions resume; uncertain ones never do.
    fn night_resume_held(self: &Arc<Self>, session: u32) {
        let Ok(snapshot) = self.instruction_queue(None, session) else {
            return;
        };
        for item in snapshot.items {
            if item.state != proto::InstructionState::HeldAfterRecovery {
                continue;
            }
            if let Err(e) = self.instruction_resume(None, session, &item.id) {
                tracing::info!(
                    "Night shift left instruction {} of pane {session} held: {e:#}",
                    item.id
                );
            }
        }
    }

    // ---- ledger ----

    /// One `night_*` verb from the run's orchestrator.
    pub fn night_tool(self: &Arc<Self>, caller: u32, verb: &str, args: &Value) -> Result<Value> {
        let run = self
            .night_runs_live()
            .into_iter()
            .find(|(_, run)| run.session_id == Some(caller))
            .map(|(_, run)| run.run_id)
            .ok_or_else(|| {
                anyhow!(
                    "night_{verb} refused: pane {caller} is not the orchestrator of a Night \
                     shift run in flight; only the pane Houston opened for the run writes its \
                     ledger"
                )
            })?;
        let title_max = proto::NIGHT_SHIFT_ENTRY_TITLE_MAX;
        let body_max = proto::NIGHT_SHIFT_ENTRY_BODY_MAX;
        let now = now_unix_ms();
        let note = match verb {
            "report" => return self.night_report(run, args),
            "pr" => {
                let number = args
                    .get("number")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok())
                    .filter(|n| *n > 0)
                    .ok_or_else(|| anyhow!("number must be the PR's number"))?;
                let existing =
                    self.db.night_entries(run)?.into_iter().find(|e| {
                        e.kind == proto::NightEntryKind::Pr && e.pr_number == Some(number)
                    });
                let base = existing.as_ref().map(|e| e.gates).unwrap_or_default();
                let gates = proto::NightGates {
                    checks: gate_arg(args, "checks", base.checks)?,
                    review: gate_arg(args, "review", base.review)?,
                    qa: gate_arg(args, "qa", base.qa)?,
                    ci: gate_arg(args, "ci", base.ci)?,
                    reruns: base.reruns,
                };
                let title = required(args, "title", title_max)?;
                let write = NightEntryWrite {
                    run_id: run,
                    kind: proto::NightEntryKind::Pr,
                    title,
                    theme: text_arg(args, "theme", 80)?
                        .or(existing.as_ref().and_then(|e| e.theme.as_deref())),
                    status: text_arg(args, "status", 40)?
                        .or(existing.as_ref().and_then(|e| e.status.as_deref())),
                    pr_number: Some(number),
                    visible: bool_arg(args, "visible")?
                        .unwrap_or(existing.as_ref().is_some_and(|e| e.visible)),
                    body: text_arg(args, "body", body_max)?
                        .or(existing.as_ref().map(|e| e.body.as_str()))
                        .unwrap_or_default(),
                    gates,
                    now_ms: now,
                };
                match &existing {
                    Some(e) => {
                        self.db.update_night_entry(e.id, &write)?;
                        format!("updated PR #{number} in the ledger")
                    }
                    None => {
                        self.night_entry_room(run)?;
                        self.db.insert_night_entry(&write)?;
                        self.night_watch_pr(caller, number);
                        format!("recorded PR #{number}")
                    }
                }
            }
            "plan" | "lesson" | "decision" => {
                self.night_entry_room(run)?;
                let title = required(args, "title", title_max)?;
                let mut body = text_arg(args, "body", body_max)?
                    .unwrap_or_default()
                    .to_string();
                let (kind, title) = match verb {
                    "plan" if bool_arg(args, "deferred")? == Some(true) => {
                        (proto::NightEntryKind::Deferred, title.to_string())
                    }
                    "plan" => (proto::NightEntryKind::Plan, title.to_string()),
                    "lesson" => match text_arg(args, "flaky_test", 200)? {
                        Some(test) if !test.trim().is_empty() => {
                            body = if body.is_empty() {
                                title.to_string()
                            } else {
                                format!("{title}: {body}")
                            };
                            (proto::NightEntryKind::Flaky, test.trim().to_string())
                        }
                        _ => (proto::NightEntryKind::Lesson, title.to_string()),
                    },
                    _ => {
                        if let Some(options) = args.get("options").and_then(Value::as_array) {
                            let options: Vec<&str> =
                                options.iter().filter_map(Value::as_str).collect();
                            if !options.is_empty() {
                                if !body.is_empty() {
                                    body.push_str("\n\n");
                                }
                                body.push_str(&format!("Options: {}", options.join(" | ")));
                            }
                        }
                        if body.chars().count() > body_max {
                            bail!("body and options are over {body_max} characters together");
                        }
                        (proto::NightEntryKind::Decision, title.to_string())
                    }
                };
                let id = self.db.insert_night_entry(&NightEntryWrite {
                    run_id: run,
                    kind,
                    title: &title,
                    theme: text_arg(args, "theme", 80)?,
                    status: text_arg(args, "status", 40)?,
                    pr_number: None,
                    visible: false,
                    body: &body,
                    gates: proto::NightGates::default(),
                    now_ms: now,
                })?;
                format!(
                    "recorded {} entry {id}",
                    crate::db::wire_name(&kind).unwrap_or_default()
                )
            }
            other => bail!(
                "night_{other} is not a Night shift tool; expected plan, pr, lesson, decision \
                 or report"
            ),
        };
        self.broadcast_night_run(run);
        Ok(json!({ "recorded": true, "note": note }))
    }

    fn night_entry_room(&self, run: u32) -> Result<()> {
        let count = self.db.night_entry_count(run)?;
        if count >= proto::NIGHT_SHIFT_ENTRIES_PER_RUN_MAX {
            bail!(
                "run {run} already has {count} ledger entries; the limit is {} per run",
                proto::NIGHT_SHIFT_ENTRIES_PER_RUN_MAX
            );
        }
        Ok(())
    }

    fn night_watch_pr(self: &Arc<Self>, orchestrator: u32, number: u32) {
        if let Err(e) = self.pr_watch_start(orchestrator, &number.to_string()) {
            tracing::info!("Night shift could not watch PR #{number}: {e:#}");
        }
    }

    fn night_report(self: &Arc<Self>, run_id: u32, args: &Value) -> Result<Value> {
        let summary = required(args, "summary", 200)?;
        let merge_order: Vec<u32> = match args.get("merge_order") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| {
                    v.as_u64()
                        .and_then(|n| u32::try_from(n).ok())
                        .ok_or_else(|| anyhow!("merge_order holds PR numbers; got {v}"))
                })
                .collect::<Result<_>>()?,
            Some(other) => bail!("merge_order must be a list of PR numbers; got {other}"),
        };
        let _guard = self.night.lock.lock().expect("night lock");
        let mut row = self
            .db
            .night_run(run_id)?
            .ok_or_else(|| anyhow!("night run {run_id} vanished"))?;
        let path = Path::new(&row.report_path);
        let size = std::fs::metadata(path)
            .map_err(|_| {
                anyhow!(
                    "night_report refused: {} does not exist; write the report there first",
                    path.display()
                )
            })?
            .len();
        if size > proto::NIGHT_SHIFT_REPORT_MAX_BYTES {
            bail!(
                "night_report refused: {} is {size} bytes, over the {} byte cap (256 KiB)",
                path.display(),
                proto::NIGHT_SHIFT_REPORT_MAX_BYTES
            );
        }
        row.report_published = true;
        row.summary = Some(crate::orchestrate::sanitize_handoff_text(summary.trim()));
        row.merge_order = merge_order;
        self.db.save_night_run(&row)?;
        drop(_guard);
        self.broadcast_night_run(run_id);
        Ok(json!({
            "published": true,
            "note": "report published; the user reads it in Routines ▸ Night shift. End your \
                     turn now: the run settles when it ends."
        }))
    }

    pub fn night_shift_decide(&self, entry_id: u32, choice: &str) -> Result<()> {
        let choice = choice.trim();
        if choice.is_empty() || choice.chars().count() > 200 {
            bail!(
                "a decision's answer is 1 to 200 characters; got {}",
                choice.chars().count()
            );
        }
        let entry = self
            .db
            .night_entry(entry_id)?
            .ok_or_else(|| anyhow!("no Night shift ledger entry {entry_id}"))?;
        if entry.kind != proto::NightEntryKind::Decision {
            bail!("ledger entry {entry_id} is not a decision");
        }
        if let Err(first) = self
            .db
            .decide_night_entry(entry_id, choice, now_unix_ms())?
        {
            bail!("decision {entry_id} was already answered with {first:?}; an answer is final");
        }
        self.broadcast_night_run(entry.run_id);
        Ok(())
    }

    pub fn night_shift_qa_passed(self: &Arc<Self>, entry_id: u32) -> Result<()> {
        let entry = self
            .db
            .night_entry(entry_id)?
            .ok_or_else(|| anyhow!("no Night shift ledger entry {entry_id}"))?;
        let number = entry
            .pr_number
            .filter(|_| entry.kind == proto::NightEntryKind::Pr)
            .ok_or_else(|| anyhow!("ledger entry {entry_id} is not a pull request"))?;
        if !self.db.set_night_entry_qa_passed(entry_id)? {
            bail!("PR #{number} is already marked QA passed");
        }
        let run = self
            .db
            .night_run(entry.run_id)?
            .ok_or_else(|| anyhow!("night run {} vanished", entry.run_id))?;
        let s = self.night_settings(run.routine_id)?;
        if s.output == proto::NightOutput::MergeQueue {
            self.merge_queue_enqueue(&run.workspace, &number.to_string(), None, None)
                .with_context(|| format!("PR #{number} is QA passed but was not enqueued"))?;
        }
        self.broadcast_night_run(entry.run_id);
        Ok(())
    }

    pub fn night_shift_report(&self, run_id: u32) -> Result<proto::ServerMsg> {
        let row = self
            .db
            .night_run(run_id)?
            .ok_or_else(|| anyhow!("no Night shift run {run_id}"))?;
        let file = std::fs::File::open(&row.report_path)
            .with_context(|| format!("run {run_id} has no report at {}", row.report_path))?;
        let cap = proto::NIGHT_SHIFT_REPORT_MAX_BYTES;
        let mut bytes = Vec::new();
        file.take(cap + 1)
            .read_to_end(&mut bytes)
            .with_context(|| format!("reading {}", row.report_path))?;
        let truncated = bytes.len() as u64 > cap;
        bytes.truncate(cap as usize);
        Ok(proto::ServerMsg::NightShiftReport {
            run_id,
            markdown: String::from_utf8_lossy(&bytes).into_owned(),
            truncated,
        })
    }

    // ---- wire ----

    fn broadcast_night_run(&self, run_id: u32) {
        match self.db.night_run(run_id) {
            Ok(Some(row)) => match self.night_run_to_wire(row) {
                Ok(run) => self.broadcast_control(&proto::ServerMsg::NightShiftRunEvent { run }),
                Err(e) => tracing::warn!("reading night run {run_id} to broadcast it: {e:#}"),
            },
            Ok(None) => {}
            Err(e) => tracing::warn!("reading night run {run_id}: {e:#}"),
        }
    }

    pub(super) fn night_run_to_wire(&self, r: NightRunRow) -> Result<proto::NightRun> {
        let entries = self.db.night_entries(r.run_id)?;
        let live = r.ended_at_ms.is_none();
        let crew = match (live, r.session_id) {
            (true, Some(orchestrator)) => {
                let seen = self
                    .night
                    .crew
                    .lock()
                    .expect("night crew")
                    .get(&r.run_id)
                    .cloned()
                    .unwrap_or_default();
                let mut ids = vec![orchestrator];
                ids.extend(self.descendants_of(orchestrator));
                ids.into_iter()
                    .filter_map(|id| {
                        let s = self.get(id).ok()?;
                        let info = s.snapshot_info();
                        let limited = s.limit.lock().expect("limit lock").is_some();
                        Some(proto::NightCrewMember {
                            session_id: id,
                            provider: info.agent,
                            role: self.delegation_of(id).and_then(|d| d.role),
                            status: info.status,
                            started_at_ms: seen
                                .get(&id)
                                .map(|(_, t)| *t)
                                .unwrap_or(r.started_at_ms),
                            limited,
                        })
                    })
                    .collect()
            }
            _ => Vec::new(),
        };
        Ok(proto::NightRun {
            run_id: r.run_id,
            routine_id: r.routine_id,
            workspace: r.workspace,
            trigger: r.trigger,
            phase: r.phase,
            session_id: r.session_id,
            started_at_ms: r.started_at_ms,
            wrap_up_at_ms: r.wrap_up_at_ms,
            hard_stop_at_ms: r.hard_stop_at_ms,
            ended_at_ms: r.ended_at_ms,
            report_path: r.report_path,
            report_published: r.report_published,
            summary: r.summary,
            stop_reason: r.stop_reason,
            stop_detail: r.stop_detail,
            interruptions: r.interruptions,
            cost: r.cost,
            limited: r.limited,
            preflight: r.preflight,
            keep_awake: r.keep_awake,
            merge_order: r.merge_order,
            entries,
            crew,
        })
    }

    // ---- provider limits ----

    /// A pane of a run reported its provider's limit: the provider is limited
    /// for the rest of the run, and the orchestrator is told once.
    pub(super) fn night_shift_provider_limited(
        self: &Arc<Self>,
        session: u32,
        provider: proto::AgentKind,
        why: &str,
    ) {
        let Some((_, run_id, _)) = self.night_run_of_pane(session) else {
            return;
        };
        {
            let _guard = self.night.lock.lock().expect("night lock");
            let Ok(Some(mut row)) = self.db.night_run(run_id) else {
                return;
            };
            if row.limited.contains(&provider) {
                return;
            }
            row.limited.push(provider);
            if let Err(e) = self.db.save_night_run(&row) {
                tracing::warn!("recording night run {run_id}'s limited provider: {e:#}");
                return;
            }
        }
        let slug = crate::agent_hooks::provider_slug(provider);
        let next = self
            .night_substitute(run_id, provider)
            .ok()
            .map(|p| crate::agent_hooks::provider_slug(p).to_string())
            .unwrap_or_else(|| "none: every worker provider is limited".into());
        self.night_tell_orchestrator(
            run_id,
            &format!("Night shift: {slug} limited"),
            &format!(
                "{slug} reported its usage limit ({why}) in pane {session}. For the rest of this \
                 run Houston starts {slug} spawns with the next worker provider instead: {next}. \
                 Re-plan the work that pane held."
            ),
        );
        self.broadcast_night_run(run_id);
    }

    /// The first unlimited worker provider, from `requested`'s place in the
    /// chain onwards; refused naming every limited provider.
    fn night_substitute(
        &self,
        run_id: u32,
        requested: proto::AgentKind,
    ) -> Result<proto::AgentKind> {
        let row = self
            .db
            .night_run(run_id)?
            .ok_or_else(|| anyhow!("night run {run_id} vanished"))?;
        let s = self.night_settings(row.routine_id)?;
        let chain: Vec<proto::AgentKind> = s.workers.iter().map(|w| w.provider).collect();
        let start = chain.iter().position(|p| *p == requested).unwrap_or(0);
        chain
            .iter()
            .cycle()
            .skip(start)
            .take(chain.len())
            .find(|p| !row.limited.contains(p))
            .copied()
            .ok_or_else(|| {
                anyhow!(
                    "pane_spawn refused: every Night shift worker provider is limited for this \
                     run ({})",
                    row.limited
                        .iter()
                        .map(|p| crate::agent_hooks::provider_slug(*p))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
    }

    /// A spawn from a run's tree: providers without a limit signal are refused
    /// and a limited one is swapped for the next in the chain. Answers the
    /// provider to launch and, when it changed, the reply's warning.
    pub(crate) fn night_shift_spawn_provider(
        &self,
        caller: u32,
        requested: proto::AgentKind,
    ) -> Result<(proto::AgentKind, Option<proto::PaneSpawnWarning>)> {
        let Some((_, run_id, _)) = self.night_run_of_pane(caller) else {
            return Ok((requested, None));
        };
        if settings::reports_no_limit(requested) {
            bail!(
                "pane_spawn refused: {} cannot work in a Night shift run because it reports no \
                 usage limit; use a worker provider from the brief",
                crate::agent_hooks::provider_slug(requested)
            );
        }
        let limited = self
            .db
            .night_run(run_id)?
            .is_some_and(|r| r.limited.contains(&requested));
        if !limited {
            return Ok((requested, None));
        }
        let next = self.night_substitute(run_id, requested)?;
        let (from, to) = (
            crate::agent_hooks::provider_slug(requested),
            crate::agent_hooks::provider_slug(next),
        );
        Ok((
            next,
            Some(proto::PaneSpawnWarning {
                code: "night_shift_substituted".into(),
                message: format!(
                    "{from} is limited for this Night shift run, so this pane runs {to} instead \
                     (requested {from}, started {to})"
                ),
            }),
        ))
    }

    /// CI news for a PR the run recorded: gates follow it, and a failure on a
    /// known flaky test asks the orchestrator for one re-run.
    pub(super) fn night_shift_pr_changes(
        self: &Arc<Self>,
        session: u32,
        repo: &Path,
        number: u32,
        changes: &[crate::pull_requests::watch::Change],
        check_runs: &[(String, Option<u64>)],
    ) {
        use crate::pull_requests::watch::Change;
        if changes.is_empty() || !self.is_night_shift_orchestrator(session) {
            return;
        }
        let failed: Vec<String> = changes
            .iter()
            .filter_map(|c| match c {
                Change::FailedCheck { name, .. } => Some(name.clone()),
                _ => None,
            })
            .collect();
        if changes
            .iter()
            .any(|c| matches!(c, Change::ChecksPassed { .. }))
        {
            self.night_set_ci(session, number, proto::NightGate::Passed);
        }
        if failed.is_empty() {
            return;
        }
        let mut texts = Vec::new();
        for name in &failed {
            texts.push(name.clone());
            let run = check_runs
                .iter()
                .find(|(n, _)| n == name)
                .and_then(|(_, id)| *id);
            if let Some(run_id) = run {
                match crate::gh::pr_check_log(repo, run_id) {
                    Ok(log) => texts.extend(log.lines),
                    Err(e) => tracing::info!("reading CI log {run_id} of PR #{number}: {e:#}"),
                }
            }
        }
        if let Err(e) = self.night_shift_ci_failed(session, number, &texts) {
            tracing::warn!("Night shift CI pass for PR #{number}: {e:#}");
        }
    }

    fn night_set_ci(&self, session: u32, number: u32, gate: proto::NightGate) {
        let Some((_, run_id, _)) = self.night_run_of_pane(session) else {
            return;
        };
        let Ok(entries) = self.db.night_entries(run_id) else {
            return;
        };
        if let Some(e) = entries
            .into_iter()
            .find(|e| e.kind == proto::NightEntryKind::Pr && e.pr_number == Some(number))
        {
            let gates = proto::NightGates {
                ci: gate,
                ..e.gates
            };
            if let Err(err) = self.db.set_night_entry_gates(e.id, &gates) {
                tracing::warn!("recording the CI gate of PR #{number}: {err:#}");
            }
            self.broadcast_night_run(run_id);
        }
    }

    /// `texts` are the failed checks' names and log lines. Answers whether a
    /// re-run was asked for; a test re-runs once per PR.
    pub fn night_shift_ci_failed(
        self: &Arc<Self>,
        session: u32,
        number: u32,
        texts: &[String],
    ) -> Result<bool> {
        let Some((routine_id, run_id, orchestrator)) = self.night_run_of_pane(session) else {
            return Ok(false);
        };
        let Some(entry) = self
            .db
            .night_entries(run_id)?
            .into_iter()
            .find(|e| e.kind == proto::NightEntryKind::Pr && e.pr_number == Some(number))
        else {
            return Ok(false);
        };
        let flaky = self.db.night_flaky_tests(routine_id)?;
        let hit = crate::night_shift::flaky_match(&flaky, texts).map(str::to_string);
        let mut gates = entry.gates;
        let rerun = hit.is_some() && gates.reruns == 0;
        if rerun {
            gates.reruns += 1;
            gates.ci = proto::NightGate::Pending;
        } else {
            gates.ci = proto::NightGate::Failed;
        }
        self.db.set_night_entry_gates(entry.id, &gates)?;
        let (title, body) = match (hit, rerun) {
            (Some(test), true) => (
                format!("Night shift: re-run CI on PR #{number}"),
                format!(
                    "CI on PR #{number} failed on {test}, a known flaky test in the ledger. \
                     Re-run the failed jobs once (gh run rerun RUN_ID --failed); Houston \
                     recorded the re-run. If it fails again, treat it as a real failure."
                ),
            ),
            (Some(test), false) => (
                format!("Night shift: PR #{number} failed again"),
                format!(
                    "CI on PR #{number} failed on {test} again after its one re-run: hand it \
                     to a fixer pane as a real failure."
                ),
            ),
            (None, _) => (
                format!("Night shift: PR #{number} CI failed"),
                format!(
                    "CI on PR #{number} failed on no known flaky test: hand the failure to a \
                     fixer pane."
                ),
            ),
        };
        let workspace = self
            .db
            .night_run(run_id)?
            .map(|r| r.workspace)
            .unwrap_or_default();
        if let Err(e) = self.inbox_write(
            orchestrator,
            &workspace,
            None,
            None,
            crate::orchestrate::InboxKind::OperatorNote,
            &title,
            &body,
            Vec::new(),
            None,
            None,
            false,
            true,
        ) {
            tracing::warn!("telling night run {run_id} about PR #{number}: {e:#}");
        }
        self.broadcast_night_run(run_id);
        Ok(rerun)
    }

    fn night_zcode_turn_ended(&self, session: u32) {
        let mut turns = self.night.zcode_turns.lock().expect("zcode turns");
        if let Some(at) = turns.get_mut(&session) {
            *at = now_unix_ms();
        }
    }

    /// ZCode reports no limit: a pane of the run that ended no turn for the
    /// stall time while working, and whose quota probe fails, is limited.
    fn night_zcode_stall_pass(self: &Arc<Self>, run_id: u32, now_ms: i64) {
        let Ok(Some(row)) = self.db.night_run(run_id) else {
            return;
        };
        if row.limited.contains(&proto::AgentKind::Zcode) {
            return;
        }
        let Some(orchestrator) = row.session_id else {
            return;
        };
        let mut panes = vec![orchestrator];
        panes.extend(self.descendants_of(orchestrator));
        let stall = i64::from(proto::NIGHT_SHIFT_ZCODE_STALL_MINUTES) * MINUTE_MS;
        let mut stalled = None;
        {
            let mut turns = self.night.zcode_turns.lock().expect("zcode turns");
            for id in panes {
                let Ok(s) = self.get(id) else { continue };
                if s.info.agent != proto::AgentKind::Zcode {
                    continue;
                }
                let since = *turns.entry(id).or_insert(now_ms);
                let working =
                    *s.status.lock().expect("status lock") == Some(proto::AgentStatus::Working);
                if !working {
                    turns.insert(id, now_ms);
                } else if now_ms - since >= stall {
                    stalled = Some((id, (now_ms - since) / MINUTE_MS));
                    break;
                }
            }
        }
        let Some((pane, minutes)) = stalled else {
            return;
        };
        if self.night_zcode_probe_ok() {
            self.night
                .zcode_turns
                .lock()
                .expect("zcode turns")
                .insert(pane, now_ms);
            return;
        }
        self.night_shift_provider_limited(
            pane,
            proto::AgentKind::Zcode,
            &format!("no turn ended for {minutes} min and its quota probe failed"),
        );
    }

    /// Whether ZCode still answers. Without a probe the daemon can run, a
    /// stall alone is not taken as a limit.
    fn night_zcode_probe_ok(&self) -> bool {
        if let Some(ok) = *self.night.zcode_probe_for_test.lock().expect("zcode probe") {
            return ok;
        }
        true
    }
}
