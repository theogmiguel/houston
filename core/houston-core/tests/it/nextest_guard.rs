//! Plain `cargo test` runs every module of this binary as threads of one process, while many
//! modules still mutate the process environment under per-module locks. nextest runs each
//! test in its own process and sets `NEXTEST`; a re-executed child sets `HOUSTON_TEST_REEXEC`.

const ACCEPTED: [&str; 3] = [
    "NEXTEST",
    "HOUSTON_TEST_REEXEC",
    "HOUSTON_ALLOW_PLAIN_CARGO_TEST",
];

#[test]
fn the_suite_runs_one_test_per_process() {
    assert!(
        ACCEPTED.iter().any(|name| std::env::var_os(name).is_some()),
        "this integration binary needs one process per test: run `cargo nextest run` \
         (none of {ACCEPTED:?} is set; HOUSTON_ALLOW_PLAIN_CARGO_TEST=1 overrides for a single module)"
    );
}
