use houston_core::spawn::{command, output_within};
use std::path::Path;
use std::time::Duration;

#[test]
fn remote_pwa_requests_ignore_stale_responses_and_recover_after_deadlines() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let mut cmd = command("node");
    cmd.arg(repo.join("scripts/test-remote-pwa.mjs"))
        .env_remove("HOUSTON_PWA_TEST_SOURCE");
    let output = output_within(cmd, Duration::from_secs(10))
        .expect("Node.js is required by the development runbook")
        .expect("PWA script regression finishes within ten seconds");
    assert!(
        output.status.success(),
        "PWA script regression failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
