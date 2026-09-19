#![allow(clippy::disallowed_methods)]

use std::fs;
use std::io::Write as _;
use std::process::{Child, Command};
#[cfg(unix)]
use std::time::Duration;

fn win_essentials() -> impl Iterator<Item = (&'static str, String)> {
    #[cfg(windows)]
    {
        let keys = [
            "SystemRoot",
            "SystemDrive",
            "windir",
            "TEMP",
            "TMP",
            "PATH",
            "PATHEXT",
            "COMSPEC",
        ];
        keys.into_iter()
            .filter_map(|k| std::env::var(k).ok().map(|v| (k, v)))
    }
    #[cfg(not(windows))]
    {
        let empty: Vec<(&'static str, String)> = Vec::new();
        empty.into_iter()
    }
}

#[cfg(unix)]
fn find_sleep_binary() -> String {
    let output = Command::new("which")
        .arg("sleep")
        .output()
        .expect("`which sleep` failed to run");
    assert!(output.status.success(), "`which sleep` did not find sleep");
    String::from_utf8(output.stdout)
        .expect("which output is not utf8")
        .trim()
        .to_string()
}

struct KillOnDrop(u32);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = houston_core::pid::signal_process(self.0, houston_core::pid::Signal::Kill);
    }
}

#[cfg(unix)]
fn spawn_houston_core_looking_fixture() -> Child {
    let fixture_dir = tempfile::tempdir().expect("fixture tempdir");
    let symlink_path = fixture_dir.path().join("houston-core");
    std::os::unix::fs::symlink(find_sleep_binary(), &symlink_path).expect("symlink sleep");

    let child = Command::new(&symlink_path)
        .arg("100")
        .spawn()
        .expect("spawn fixture process");
    let pid = child.id();

    std::thread::sleep(Duration::from_millis(50));
    let comm = fs::read_to_string(format!("/proc/{pid}/comm"))
        .expect("read fixture /proc/<pid>/comm")
        .trim()
        .to_string();
    assert_eq!(
        comm, "houston-core",
        "fixture process comm must read as houston-core for this test to exercise the Live path"
    );
    child
}

#[cfg(windows)]
fn spawn_houston_core_looking_fixture() -> Child {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("tr-own-fixture-{}-{}", std::process::id(), n));
    std::fs::create_dir_all(&dir).expect("fixture dir");
    let comspec =
        std::env::var("COMSPEC").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into());
    let exe = dir.join("houston-core.exe");
    std::fs::copy(&comspec, &exe).expect("copy host cmd.exe as houston-core.exe");
    Command::new(&exe)
        .args(["/c", "ping -n 60 127.0.0.1 >nul"])
        .spawn()
        .expect("spawn fixture process")
}

fn write_daemon_json(state_dir: &std::path::Path, pid: u32) {
    let daemon_json =
        format!("{{\"port\":0,\"token\":\"test-token\",\"pid\":{pid},\"protocol\":1}}");
    let mut f = fs::File::create(state_dir.join("daemon.json")).expect("write daemon.json");
    f.write_all(daemon_json.as_bytes()).expect("write bytes");
}

#[cfg(debug_assertions)]
#[test]
fn debug_build_no_flags_targets_dev_via_print_target_with_zero_side_effects() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .arg("--print-target")
        .output()
        .expect("failed to run houston-tauri");

    assert!(
        output.status.success(),
        "--print-target must exit 0; stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let dev_state_dir = home.path().join(".houston-dev");
    let dev_log_dir = dev_state_dir.join("logs");
    assert!(
        stdout.contains("channel=dev"),
        "a debug build with no flags must target dev, got: {stdout}"
    );
    assert!(
        stdout.contains(&format!("state_dir={}", dev_state_dir.display())),
        "must name the dev state dir, got: {stdout}"
    );
    assert!(
        stdout.contains(&format!("config_dir={}", dev_state_dir.display())),
        "read site config_dir() must agree with the dev target, got: {stdout}"
    );
    assert!(
        stdout.contains(&format!("log_dir={}", dev_log_dir.display())),
        "read site log_dir() (where watchdog.ndjson lands) must agree with the dev target, \
         got: {stdout}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "--print-target must not touch the sandbox HOME, found: {sandbox_contents:?}"
    );
}

#[test]
fn explicit_channel_release_targets_release_and_warns() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .args(["--channel", "release", "--print-target"])
        .output()
        .expect("failed to run houston-tauri");

    assert!(
        output.status.success(),
        "--print-target must exit 0; stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let release_dir = home.path().join(".houston");
    assert!(stdout.contains("channel=release"), "got: {stdout}");
    assert!(
        stdout.contains(&format!("state_dir={}", release_dir.display())),
        "got: {stdout}"
    );
    assert!(
        stderr.contains("WARNING") && stderr.contains(&release_dir.display().to_string()),
        "explicit --channel release must warn loudly and name the state dir, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "--print-target must not touch the sandbox HOME, found: {sandbox_contents:?}"
    );
}

#[test]
fn whitespace_only_channel_value_is_rejected_at_parse_time() {
    let home = tempfile::tempdir().expect("tempdir");

    for raw in [" ", "\t", "\n"] {
        let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
            .env_clear()
            .envs(win_essentials())
            .env("HOME", home.path())
            .args(["--channel", raw])
            .output()
            .expect("failed to run houston-tauri");

        assert!(
            !output.status.success(),
            "--channel {raw:?} must be rejected; stdout={:?} stderr={:?}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(&format!("{raw:?}")),
            "refusal must name the offending value {raw:?}, got: {stderr}"
        );
    }

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "a rejected --channel must refuse before touching the sandbox HOME, found: \
         {sandbox_contents:?}"
    );
}

#[test]
fn release_warning_fires_for_every_spelling_that_resolves_to_release() {
    let home = tempfile::tempdir().expect("tempdir");

    for raw in ["release", " release ", "release\n", "\trelease"] {
        let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
            .env_clear()
            .envs(win_essentials())
            .env("HOME", home.path())
            .args(["--channel", raw, "--print-target"])
            .output()
            .expect("failed to run houston-tauri");

        assert!(
            output.status.success(),
            "--channel {raw:?} --print-target must exit 0; stdout={:?} stderr={:?}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stdout.contains("channel=release"),
            "--channel {raw:?} must resolve to release, got: {stdout}"
        );
        assert!(
            stderr.contains("WARNING"),
            "--channel {raw:?} resolves to release and must warn, got: {stderr}"
        );
    }

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "--print-target must not touch the sandbox HOME, found: {sandbox_contents:?}"
    );
}

#[test]
fn repeated_channel_flag_resolves_to_the_last_occurrence() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .args(["--channel", "release", "--channel", "dev", "--print-target"])
        .output()
        .expect("failed to run houston-tauri");

    assert!(
        output.status.success(),
        "--print-target must exit 0; stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stdout.contains("channel=dev"),
        "--channel release --channel dev must resolve to dev (the LAST flag), got: {stdout}"
    );
    assert!(
        !stderr.contains("WARNING"),
        "must not warn about release when the resolved target is dev, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "--print-target must not touch the sandbox HOME, found: {sandbox_contents:?}"
    );
}

#[test]
fn channel_flag_path_traversal_is_rejected_and_named() {
    let home = tempfile::tempdir().expect("tempdir");
    let bad = "x/../.houston";

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .args(["--channel", bad])
        .output()
        .expect("failed to run houston-tauri");

    assert!(
        !output.status.success(),
        "expected a non-zero exit; stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(bad),
        "refusal must name the offending value {bad:?}, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "an invalid --channel must refuse before touching the sandbox HOME, found: \
         {sandbox_contents:?}"
    );
}

#[cfg(not(debug_assertions))]
#[test]
fn release_build_with_unset_channel_and_live_daemon_json_refuses_via_singleton_guard() {
    let home = tempfile::tempdir().expect("tempdir");
    let state_dir = home.path().join(".houston");
    fs::create_dir_all(&state_dir).expect("create state dir");

    let mut child = spawn_houston_core_looking_fixture();
    let pid = child.id();
    let _guard = KillOnDrop(pid);

    write_daemon_json(&state_dir, pid);

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .output()
        .expect("failed to run houston-tauri");

    let _ = child.kill();
    let _ = child.wait();

    assert!(
        !output.status.success(),
        "expected a non-zero exit; stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("--daemon-fresh"),
        "must be refused by the singleton guard specifically, got: {stderr}"
    );
    assert!(
        !stderr.contains("this is a debug build"),
        "release build must never take the (debug-only) channel guard's refusal, got: {stderr}"
    );
    assert!(
        stderr.contains(&pid.to_string()),
        "message must name the pid {pid}, got: {stderr}"
    );
    assert!(
        stderr.contains(&state_dir.display().to_string()),
        "message must name the state dir {}, got: {stderr}",
        state_dir.display()
    );

    let after = fs::read_to_string(state_dir.join("daemon.json")).expect("daemon.json survives");
    assert!(
        after.contains(&pid.to_string()),
        "daemon.json must still name the original pid after a refusal, got: {after}"
    );
}

#[test]
fn daemon_fresh_self_protection_refuses_before_signalling_and_leaves_the_fixture_alive() {
    let home = tempfile::tempdir().expect("tempdir");
    let state_dir = home.path().join(".houston-dev");
    fs::create_dir_all(&state_dir).expect("create state dir");

    let mut child = spawn_houston_core_looking_fixture();
    let pid = child.id();
    let _guard = KillOnDrop(pid);

    write_daemon_json(&state_dir, pid);

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .env("HOUSTON_CHANNEL", "dev")
        .env("HOUSTON_SESSION", "sess-test")
        .args(["--channel", "dev", "--daemon-fresh"])
        .output()
        .expect("failed to run houston-tauri");

    assert!(
        !output.status.success(),
        "self-protection must refuse; stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("refusing --daemon-fresh"), "got: {stderr}");
    assert!(
        stderr.contains("'dev'"),
        "must name the channel, got: {stderr}"
    );
    assert!(
        stderr.contains("sess-test"),
        "must name the session, got: {stderr}"
    );

    assert!(
        houston_core::pid::process_comm(pid).is_some(),
        "self-protection must refuse BEFORE sending SIGTERM -- the fixture must still be alive"
    );
    let after = fs::read_to_string(state_dir.join("daemon.json")).expect("daemon.json survives");
    assert!(
        after.contains(&pid.to_string()),
        "daemon.json must be untouched by a refused --daemon-fresh, got: {after}"
    );

    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn unrecognized_argument_is_rejected_end_to_end() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .args(["--channel", "dev", "--print-target", "garbage"])
        .output()
        .expect("failed to run houston-tauri");

    assert!(
        !output.status.success(),
        "an unrecognized token must be rejected; stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("garbage"),
        "refusal must name the offending token, got: {stderr}"
    );
    assert!(
        stderr.contains("Accepted flags:"),
        "refusal must list the accepted flags, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "an unrecognized token must refuse before touching the sandbox HOME, found: \
         {sandbox_contents:?}"
    );
}

#[test]
fn unrecognized_flag_alone_is_rejected_end_to_end() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .args(["--nonsense"])
        .output()
        .expect("failed to run houston-tauri");

    assert!(
        !output.status.success(),
        "stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--nonsense"), "got: {stderr}");
}

#[test]
fn unrecognized_token_alongside_channel_release_refuses_before_the_release_warning() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .args(["--channel", "release", "--nonsense"])
        .output()
        .expect("failed to run houston-tauri");

    assert!(
        !output.status.success(),
        "stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("--nonsense"),
        "refusal must name the offending token, got: {stderr}"
    );
    assert!(
        !stderr.contains("WARNING"),
        "must refuse BEFORE ever reaching the release warning, got: {stderr}"
    );
    assert!(
        !stderr.contains("INSTALLED APP"),
        "must never resolve or mention the installed app's daemon, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "must refuse before touching the sandbox HOME (never resolving the release state \
         dir), found: {sandbox_contents:?}"
    );
}

#[test]
fn every_accepted_flag_still_works() {
    let home = tempfile::tempdir().expect("tempdir");

    let cases: &[&[&str]] = &[
        &["--channel", "dev", "--print-target"],
        &["--channel=dev", "--print-target"],
        &["--print-target"],
        &["--print-target", "--daemon-fresh"],
        &["--print-target", "--spike-invoke"],
        &["--print-target", "--spike-webview"],
        &["--print-target", "--spike-webview-auto"],
    ];

    for args in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
            .env_clear()
            .envs(win_essentials())
            .env("HOME", home.path())
            .args(*args)
            .output()
            .expect("failed to run houston-tauri");

        assert!(
            output.status.success(),
            "accepted argv {args:?} must not be rejected as unrecognized; stdout={:?} \
             stderr={:?}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !stderr.contains("unrecognized argument"),
            "accepted argv {args:?} must not be reported as unrecognized, got: {stderr}"
        );
    }

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "--print-target must not touch the sandbox HOME, found: {sandbox_contents:?}"
    );
}

#[test]
fn bench_flag_matches_the_build_it_runs_in() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .args(["--print-target", "--bench"])
        .output()
        .expect("failed to run houston-tauri");
    let stderr = String::from_utf8_lossy(&output.stderr);

    if cfg!(feature = "bench") {
        assert!(
            !output.status.success(),
            "a --features bench build under `cargo test` is still a debug build, so --bench \
             must still hit its pre-existing debug refusal (acceptance criterion 3); \
             stdout={:?} stderr={stderr:?}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            !stderr.contains("unrecognized argument"),
            "must not be reported as unrecognized -- --bench IS a real, accepted flag in this \
             build, got: {stderr}"
        );
        assert!(
            !stderr.contains("not built with --features bench"),
            "must not hit round 5's missing-feature refusal -- this build DOES have the \
             feature, got: {stderr}"
        );
        assert!(
            stderr.contains("this is a debug build"),
            "must hit --bench's own pre-existing debug refusal \
             (refuse_if_debug_without_escape_hatch), unchanged by this fix, got: {stderr}"
        );
    } else {
        assert!(
            !output.status.success(),
            "a default build must refuse --bench, not proceed; stdout={:?} stderr={stderr:?}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            stderr.contains("not built with --features bench"),
            "must name the missing feature, got: {stderr}"
        );
        assert!(
            stderr.contains("cargo build --features bench"),
            "must give the build command, got: {stderr}"
        );
        assert!(
            !stderr.contains("unrecognized argument"),
            "must use the specific bench-feature-missing message, not the generic unrecognized \
             one, got: {stderr}"
        );
    }

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "--bench must not touch the sandbox HOME in either build, found: {sandbox_contents:?}"
    );
}

#[test]
fn bench_scenario_flag_matches_the_build_it_runs_in() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .args(["--print-target", "--bench=M8"])
        .output()
        .expect("failed to run houston-tauri");
    let stderr = String::from_utf8_lossy(&output.stderr);

    if cfg!(feature = "bench") {
        assert!(
            !output.status.success(),
            "a --features bench build under `cargo test` is still a debug build, so \
             --bench=M8 must still hit the pre-existing debug refusal before scenario \
             validation ever runs; stdout={:?} stderr={stderr:?}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            !stderr.contains("unrecognized argument"),
            "must not be reported as unrecognized -- --bench=M8 IS an accepted flag shape in \
             this build, got: {stderr}"
        );
        assert!(
            stderr.contains("this is a debug build"),
            "must hit --bench's own pre-existing debug refusal, got: {stderr}"
        );
    } else {
        assert!(
            !output.status.success(),
            "a default build must refuse --bench=M8, not proceed; stdout={:?} stderr={stderr:?}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            stderr.contains("not built with --features bench"),
            "must name the missing feature, got: {stderr}"
        );
        assert!(
            !stderr.contains("unrecognized argument"),
            "must use the specific bench-feature-missing message, not the generic unrecognized \
             one, got: {stderr}"
        );
    }

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "--bench=M8 must not touch the sandbox HOME in either build, found: {sandbox_contents:?}"
    );
}

#[cfg(feature = "bench")]
#[test]
fn unknown_bench_scenario_is_refused_end_to_end() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .env("TR_BENCH_ALLOW_DEBUG", "1")
        .args(["--channel", "dev", "--bench=M6,M99,M8"])
        .output()
        .expect("failed to run houston-tauri");
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        !output.status.success(),
        "an unrecognized scenario name must refuse, not proceed; stdout={:?} stderr={stderr:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        stderr.contains("\"M99\""),
        "must name the offending scenario value, got: {stderr}"
    );
    assert!(
        stderr.contains("Accepted scenarios:"),
        "must name the accepted set, got: {stderr}"
    );
    for name in ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10"] {
        assert!(
            stderr.contains(name),
            "accepted-set listing must include {name}, got: {stderr}"
        );
    }

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "an unrecognized --bench scenario must not touch the sandbox HOME even under the debug \
         escape hatch, found: {sandbox_contents:?}"
    );
}

#[cfg(feature = "bench")]
#[test]
fn bench_without_channel_refuses_end_to_end() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .env("TR_BENCH_ALLOW_DEBUG", "1")
        .args(["--bench"])
        .output()
        .expect("failed to run houston-tauri");
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        !output.status.success(),
        "a bare --bench with no --channel must refuse, not proceed; stdout={:?} stderr={stderr:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        stderr.contains("--bench requires an explicit --channel"),
        "must name the requirement, got: {stderr}"
    );
    assert!(
        stderr.contains("\"dev\""),
        "this test binary is a debug build, so the named default must be \"dev\" (the \
         \"release\" wording is covered by src/bench.rs's own unit tests, which inject the \
         build-type flag directly), got: {stderr}"
    );
    assert!(
        stderr.contains("--channel dev --bench") && stderr.contains("--channel release --bench"),
        "must give the correct invocation, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "a channel-less --bench must refuse before touching the sandbox HOME, found: \
         {sandbox_contents:?}"
    );
}

#[cfg(feature = "bench")]
#[test]
fn bench_scenario_flag_without_channel_refuses_identically() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .env("TR_BENCH_ALLOW_DEBUG", "1")
        .args(["--bench=M8"])
        .output()
        .expect("failed to run houston-tauri");
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        !output.status.success(),
        "--bench=M8 with no --channel must refuse, not proceed; stdout={:?} stderr={stderr:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        stderr.contains("--bench requires an explicit --channel"),
        "must name the requirement, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "must refuse before touching the sandbox HOME, found: {sandbox_contents:?}"
    );
}

#[cfg(feature = "bench")]
#[test]
fn ambient_houston_channel_env_does_not_satisfy_the_guard() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .env("TR_BENCH_ALLOW_DEBUG", "1")
        .env("HOUSTON_CHANNEL", "dev")
        .args(["--bench"])
        .output()
        .expect("failed to run houston-tauri");
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        !output.status.success(),
        "HOUSTON_CHANNEL=dev alone must NOT satisfy the guard -- that is precisely the \
         false comfort that caused the 2026-08-06 incident; stdout={:?} stderr={stderr:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        stderr.contains("--bench requires an explicit --channel"),
        "must still refuse with the channel-explicitness message, got: {stderr}"
    );
    assert!(
        stderr.contains("HOUSTON_CHANNEL=\"dev\""),
        "must name the env var's actual value, so the reader sees exactly why setting it \
         didn't help, got: {stderr}"
    );
    assert!(
        stderr.contains("never read as a bench target"),
        "must say why setting it did not help, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "must refuse before touching the sandbox HOME, found: {sandbox_contents:?}"
    );
}

#[cfg(feature = "bench")]
#[test]
fn explicit_dev_channel_is_allowed_past_the_guard() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .env("TR_BENCH_ALLOW_DEBUG", "1")
        .args(["--channel", "dev", "--bench", "--print-target"])
        .output()
        .expect("failed to run houston-tauri");
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        output.status.success(),
        "--channel dev --bench must be allowed past the new guard; stdout={:?} stderr={stderr:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        !stderr.contains("BENCH REFUSED: --bench requires an explicit --channel"),
        "the channel-explicitness guard must not fire, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "--print-target must not touch the sandbox HOME, found: {sandbox_contents:?}"
    );
}

#[cfg(feature = "bench")]
#[test]
fn explicit_release_channel_is_allowed_past_the_guard() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .env("TR_BENCH_ALLOW_DEBUG", "1")
        .args(["--channel", "release", "--bench", "--print-target"])
        .output()
        .expect("failed to run houston-tauri");
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        output.status.success(),
        "--channel release --bench must be allowed past the new guard (explicitness, not a \
         release-channel ban); stdout={:?} stderr={stderr:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        !stderr.contains("BENCH REFUSED: --bench requires an explicit --channel"),
        "the channel-explicitness guard must not fire, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "--print-target must not touch the sandbox HOME, found: {sandbox_contents:?}"
    );
}

#[test]
fn no_bench_flag_leaves_the_new_guard_inert() {
    let home = tempfile::tempdir().expect("tempdir");

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .args(["--channel", "dev", "--print-target"])
        .output()
        .expect("failed to run houston-tauri");
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        output.status.success(),
        "normal startup with no --bench must be unaffected; stdout={:?} stderr={stderr:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        !stderr.contains("BENCH REFUSED"),
        "the bench channel guard must never fire with no --bench flag, got: {stderr}"
    );

    let sandbox_contents: Vec<_> = fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "--print-target must not touch the sandbox HOME, found: {sandbox_contents:?}"
    );
}

#[test]
fn live_pid_in_daemon_json_refuses_and_names_the_pid_and_state_dir() {
    let home = tempfile::tempdir().expect("tempdir");
    let state_dir = home.path().join(".houston-dev");
    fs::create_dir_all(&state_dir).expect("create state dir");

    let mut child = spawn_houston_core_looking_fixture();
    let pid = child.id();
    let _guard = KillOnDrop(pid);

    write_daemon_json(&state_dir, pid);

    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .envs(win_essentials())
        .env("HOME", home.path())
        .args(["--channel", "dev"])
        .output()
        .expect("failed to run houston-tauri");

    let _ = child.kill();
    let _ = child.wait();

    assert!(
        !output.status.success(),
        "expected a non-zero exit; stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(&pid.to_string()),
        "message must name the pid {pid}, got: {stderr}"
    );
    assert!(
        stderr.contains(&state_dir.display().to_string()),
        "message must name the state dir {}, got: {stderr}",
        state_dir.display()
    );
    assert!(
        stderr.contains("--daemon-fresh"),
        "message must name the way out, got: {stderr}"
    );

    let after = fs::read_to_string(state_dir.join("daemon.json")).expect("daemon.json survives");
    assert!(
        after.contains(&pid.to_string()),
        "daemon.json must still name the original pid after a refusal, got: {after}"
    );
}
