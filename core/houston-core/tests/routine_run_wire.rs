mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{now_unix_ms, Daemon};
use houston_protocol as proto;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn routines(daemon: &Daemon) -> Vec<proto::Routine> {
    let proto::ServerMsg::Routines { routines, .. } = daemon.routine_list() else {
        panic!("routine_list answers Routines");
    };
    routines
}

fn routine_of(daemon: &Daemon, id: u32) -> proto::Routine {
    routines(daemon)
        .into_iter()
        .find(|r| r.id == id)
        .expect("the routine exists")
}

fn runs_of(daemon: &Daemon, routine_id: u32) -> Vec<proto::RoutineRun> {
    let proto::ServerMsg::RoutineRuns { runs } = daemon.routine_runs_list(Some(routine_id)) else {
        panic!("routine_runs_list answers RoutineRuns");
    };
    runs
}

fn make_routine(daemon: &Daemon, name: &str, dir: Option<&Path>) -> u32 {
    let proto::ServerMsg::Routines { routines, .. } = daemon
        .routine_create_for_test(
            name,
            "do the thing",
            proto::Cadence::Interval { seconds: 86_400 },
            dir.map(|d| d.display().to_string()),
            proto::AgentKind::Cursor,
            None,
            None,
        )
        .expect("a well-formed create never Errs")
    else {
        panic!("routine_create answers Routines");
    };
    routines
        .into_iter()
        .find(|r| r.name == name)
        .expect("the routine just created is listed")
        .id
}

/// A pane that prints a line and stays alive long enough to be observed.
fn sleeper_cmd() -> Vec<String> {
    vec![
        "sh".to_string(),
        "-c".to_string(),
        "printf 'audit complete: 3 stale deps\\n'; sleep 30".to_string(),
    ]
}

async fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if f() {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_for_outcome(daemon: &Arc<Daemon>, id: u32, want: proto::RoutineOutcome) {
    let d = daemon.clone();
    wait_until(&format!("routine {id} to settle {want:?}"), move || {
        routine_of(&d, id).last_outcome == Some(want)
    })
    .await;
}

async fn wait_for_ok_runs(daemon: &Arc<Daemon>, routine: u32, want: usize) {
    let d = daemon.clone();
    wait_until(&format!("{want} settled run(s)"), move || {
        runs_of(&d, routine)
            .iter()
            .filter(|r| r.status == proto::RoutineRunStatus::Ok)
            .count()
            >= want
    })
    .await;
}

fn session_has_exited(db_path: &Path, session: u32) -> bool {
    let conn = rusqlite::Connection::open(db_path).expect("the test database opens");
    conn.query_row(
        "SELECT state FROM sessions WHERE id = ?1",
        rusqlite::params![session],
        |row| row.get::<_, String>(0),
    )
    .map(|state| state != "running")
    .unwrap_or(false)
}

/// Fire a run, close its pane if it is still live, and wait for its record to
/// settle.
async fn fire_close_settle(daemon: &Arc<Daemon>, routine: u32, settled: usize) {
    daemon.routine_fire(routine).expect("fire");
    let d = daemon.clone();
    wait_until("the run to open or settle", || {
        !d.routine_runs_in_flight().is_empty()
            || runs_of(&d, routine)
                .first()
                .is_some_and(|run| run.status != proto::RoutineRunStatus::Running)
    })
    .await;
    if let Some(run) = runs_of(daemon, routine)
        .into_iter()
        .find(|run| run.status == proto::RoutineRunStatus::Running)
    {
        daemon
            .close(run.session_id.expect("a running pane run has a session"))
            .expect("the pane closes");
    }
    wait_for_ok_runs(daemon, routine, settled).await;
}

#[tokio::test]
async fn a_run_is_a_pane_session_and_its_own_record() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let routine = make_routine(&daemon, "Nightly sweep", Some(&dir));
    daemon.set_routine_pane_cmd_for_test(sleeper_cmd());

    daemon.routine_fire(routine).expect("fire");

    let r = routine_of(&daemon, routine);
    let session = r
        .last_run_session_id
        .expect("a run records the pane session it spawned");
    assert_eq!(
        daemon.session_cwd(session).unwrap(),
        dir.display().to_string(),
        "the run starts in the routine's own directory"
    );

    let runs = runs_of(&daemon, routine);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].trigger, proto::RoutineTrigger::Schedule);
    assert_eq!(runs[0].status, proto::RoutineRunStatus::Running);
    assert_eq!(runs[0].session_id, Some(session));
    assert!(runs[0].ended_at_ms.is_none(), "a live run is not dated yet");

    daemon.close(session).expect("the pane closes");
    wait_for_outcome(&daemon, routine, proto::RoutineOutcome::Ok).await;
    let runs = runs_of(&daemon, routine);
    assert_eq!(runs[0].status, proto::RoutineRunStatus::Ok);
    assert!(runs[0].ended_at_ms.is_some(), "a settled run is dated");
}

#[tokio::test]
async fn manual_and_scheduled_runs_share_the_executor_path() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let routine = make_routine(&daemon, "Nightly sweep", Some(&dir));
    daemon.set_routine_pane_cmd_for_test(sleeper_cmd());

    let proto::ServerMsg::Routines { .. } = daemon.routine_run_now(routine).expect("run now")
    else {
        panic!("routine_run_now answers Routines");
    };
    let d = daemon.clone();
    wait_until("the manual run's pane to open", || {
        !d.routine_runs_in_flight().is_empty()
    })
    .await;
    let session = routine_of(&daemon, routine).last_run_session_id.unwrap();
    daemon.close(session).expect("the pane closes");
    wait_for_ok_runs(&daemon, routine, 1).await;

    let conn = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    conn.execute(
        "UPDATE routines SET next_run_at_ms = ?2 WHERE id = ?1",
        rusqlite::params![routine, now_unix_ms() - 1],
    )
    .unwrap();
    daemon.routine_tick_at(now_unix_ms());
    wait_until("the scheduled run to open", || {
        runs_of(&daemon, routine)
            .iter()
            .any(|run| run.trigger == proto::RoutineTrigger::Schedule)
    })
    .await;
    let session = routine_of(&daemon, routine)
        .last_run_session_id
        .expect("the scheduled run spawned a pane too");
    daemon.close(session).expect("the pane closes");
    wait_for_ok_runs(&daemon, routine, 2).await;

    let runs = runs_of(&daemon, routine);
    let manual = runs
        .iter()
        .find(|r| r.trigger == proto::RoutineTrigger::Manual)
        .expect("the manual run is recorded");
    let scheduled = runs
        .iter()
        .find(|r| r.trigger == proto::RoutineTrigger::Schedule)
        .expect("the scheduled run is recorded");
    for run in [manual, scheduled] {
        assert!(run.session_id.is_some(), "both ran as real panes: {run:?}");
        assert_eq!(run.status, proto::RoutineRunStatus::Ok);
    }
}

#[tokio::test]
async fn run_history_is_newest_first() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let routine = make_routine(&daemon, "Nightly sweep", Some(&dir));
    daemon.set_routine_pane_cmd_for_test(vec![
        "sh".to_string(),
        "-c".to_string(),
        "true".to_string(),
    ]);

    for i in 0..3 {
        fire_close_settle(&daemon, routine, i + 1).await;
    }

    let runs = runs_of(&daemon, routine);
    assert_eq!(runs.len(), 3);
    let ids: Vec<u32> = runs.iter().map(|r| r.id).collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(ids, sorted, "the history is newest first");
    assert!(runs.iter().all(|r| r.status == proto::RoutineRunStatus::Ok));
}

#[tokio::test]
async fn a_short_run_settles_when_exit_precedes_registration() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let routine = make_routine(&daemon, "Nightly sweep", Some(&dir));
    daemon.set_routine_pane_cmd_for_test(vec![
        "sh".to_string(),
        "-c".to_string(),
        "true".to_string(),
    ]);

    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let hook_entered = entered.clone();
    let hook_release = release.clone();
    daemon.set_routine_pane_registration_hook_for_test(Some(Box::new(move |_| {
        hook_entered.wait();
        hook_release.wait();
    })));

    let fire_daemon = daemon.clone();
    let fired = tokio::task::spawn_blocking(move || fire_daemon.routine_fire(routine));
    tokio::task::spawn_blocking(move || entered.wait())
        .await
        .expect("the registration hook joins");

    let session = routine_of(&daemon, routine)
        .last_run_session_id
        .expect("the run records its session before registration");
    let db_path = state.path().join("test.db");
    wait_until("the pane to exit before registration", || {
        session_has_exited(&db_path, session)
    })
    .await;
    daemon.routine_pane_exited_for_test(session);
    assert_eq!(
        runs_of(&daemon, routine)[0].status,
        proto::RoutineRunStatus::Running
    );

    tokio::task::spawn_blocking(move || release.wait())
        .await
        .expect("the registration hook releases");
    fired
        .await
        .expect("the routine fire joins")
        .expect("the routine fires");
    daemon.set_routine_pane_registration_hook_for_test(None);

    wait_for_ok_runs(&daemon, routine, 1).await;
    let runs = runs_of(&daemon, routine);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, proto::RoutineRunStatus::Ok);
    assert!(daemon.routine_runs_in_flight().is_empty());
}

#[tokio::test]
async fn a_routine_with_no_directory_is_refused_naming_it() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let routine = make_routine(&daemon, "Nightly sweep", None);

    daemon.routine_fire(routine).expect("fire");
    wait_for_outcome(&daemon, routine, proto::RoutineOutcome::EngineRefused).await;
    let error = routine_of(&daemon, routine)
        .last_error
        .expect("the refusal names itself");
    assert!(error.contains("no working directory"), "{error}");
    let runs = runs_of(&daemon, routine);
    assert_eq!(runs.len(), 1, "a refused run is still a record");
    assert_eq!(runs[0].status, proto::RoutineRunStatus::EngineRefused);
    assert!(runs[0].session_id.is_none());
}

#[tokio::test]
async fn run_now_refuses_while_the_previous_run_is_in_flight() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let routine = make_routine(&daemon, "Nightly sweep", Some(&dir));
    daemon.set_routine_pane_cmd_for_test(sleeper_cmd());

    daemon.routine_fire(routine).expect("fire");
    let refused = daemon
        .routine_run_now(routine)
        .expect("a refusal is a reply");
    let proto::ServerMsg::RoutineRefused { kind, id, .. } = refused else {
        panic!("expected RoutineRefused, got {refused:?}");
    };
    assert_eq!(kind, proto::RoutineErrorKind::AlreadyRunning);
    assert_eq!(id, Some(routine));

    let session = routine_of(&daemon, routine).last_run_session_id.unwrap();
    daemon.close(session).ok();
    wait_for_outcome(&daemon, routine, proto::RoutineOutcome::Ok).await;
}

#[tokio::test]
async fn a_run_past_the_cap_is_stopped_and_recorded() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let routine = make_routine(&daemon, "Nightly sweep", Some(&dir));
    daemon.set_routine_pane_cmd_for_test(sleeper_cmd());

    daemon.routine_fire(routine).expect("fire");
    daemon.routine_tick_at(now_unix_ms() + proto::ROUTINE_RUN_MAX_MS as i64 + 1_000);
    wait_for_outcome(&daemon, routine, proto::RoutineOutcome::KilledAtCap).await;

    let error = routine_of(&daemon, routine)
        .last_error
        .expect("the stop names itself");
    assert!(
        error.contains("ROUTINE_RUN_MAX_MS")
            && error.contains(&(proto::ROUTINE_RUN_MAX_MS / 1000).to_string()),
        "the error names the limit and the value: {error}"
    );
    let runs = runs_of(&daemon, routine);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, proto::RoutineRunStatus::KilledAtCap);
    assert!(runs[0].ended_at_ms.is_some(), "a stopped run is dated");
    assert!(
        daemon.routine_runs_in_flight().is_empty(),
        "the stopped run gave its slot back"
    );
}

#[tokio::test]
async fn firing_advances_the_clock_before_the_run_finishes() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let routine = make_routine(&daemon, "Nightly sweep", Some(&dir));
    daemon.set_routine_pane_cmd_for_test(sleeper_cmd());

    daemon.routine_fire(routine).expect("fire");
    let r = routine_of(&daemon, routine);
    let ran_at = r.last_run_at_ms.expect("the run is dated as it starts");
    assert!(
        r.next_run_at_ms > ran_at,
        "next_run_at_ms {} is not strictly after the run that just started at {ran_at}",
        r.next_run_at_ms
    );
    let session = r.last_run_session_id.unwrap();
    daemon.close(session).ok();
    wait_for_outcome(&daemon, routine, proto::RoutineOutcome::Ok).await;
}

#[tokio::test]
async fn a_run_left_in_flight_by_a_dead_daemon_reads_failed_on_boot() {
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let cfg = || houston_core::daemon::DaemonConfig {
        token: "t".into(),
        db_path: db_path.clone(),
    };
    let routine_id = {
        let daemon = Daemon::new(cfg()).unwrap();
        let dir = state_dir.path().join("project");
        std::fs::create_dir_all(&dir).unwrap();
        make_routine(&daemon, "Nightly", Some(&dir))
    };
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO routine_runs (routine_id, trigger, status, started_at_ms) \
             VALUES (?1, 'schedule', 'running', 0)",
            rusqlite::params![routine_id],
        )
        .unwrap();
    }
    let daemon = Daemon::new(cfg()).unwrap();
    let proto::ServerMsg::RoutineRuns { runs } = daemon.routine_runs_list(Some(routine_id)) else {
        unreachable!()
    };
    assert_eq!(runs.len(), 1, "the stale row is kept, not dropped");
    assert_eq!(runs[0].status, proto::RoutineRunStatus::Failed);
    let error = runs[0].error.as_deref().expect("the closure says why");
    assert!(error.contains("daemon stopped"), "{error}");
    assert!(runs[0].ended_at_ms.is_some(), "a closed run is dated");
}
