pub fn build_commit() -> &'static str {
    option_env!("HOUSTON_BUILD_COMMIT").unwrap_or("unknown")
}
