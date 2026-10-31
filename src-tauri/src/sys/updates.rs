use std::cmp::Ordering;

/// Compares two `MAJOR.MINOR.PATCH` strings, tolerating a leading `v` and ignoring
/// any prerelease or build suffix. Anything unparseable compares `Equal`, so an
/// unknown remote version is never read as newer.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    match (parse_semver(a), parse_semver(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => Ordering::Equal,
    }
}

fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Stable offers only a strictly newer release; an equal or older version is
/// not an update.
pub fn is_newer(remote: &str, running: &str) -> bool {
    compare_versions(remote, running) == Ordering::Greater
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_versions_compare_equal() {
        assert_eq!(compare_versions("1.2.3", "1.2.3"), Ordering::Equal);
        assert_eq!(compare_versions("v1.2.3", "1.2.3"), Ordering::Equal);
    }

    #[test]
    fn greater_patch_minor_major_compare_greater() {
        assert_eq!(compare_versions("1.2.4", "1.2.3"), Ordering::Greater);
        assert_eq!(compare_versions("1.2.3", "1.2.4"), Ordering::Less);
        assert_eq!(compare_versions("1.3.0", "1.2.99"), Ordering::Greater);
        assert_eq!(compare_versions("2.0.0", "1.99.99"), Ordering::Greater);
    }

    #[test]
    fn numeric_not_lexicographic() {
        assert_eq!(compare_versions("0.10.0", "0.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("0.9.0", "0.10.0"), Ordering::Less);
    }

    #[test]
    fn prerelease_suffix_is_ignored() {
        assert_eq!(compare_versions("1.2.3-rc.1", "1.2.3"), Ordering::Equal);
    }

    #[test]
    fn unparseable_compares_equal() {
        assert_eq!(compare_versions("latest", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("", "1.0.0"), Ordering::Equal);
    }

    #[test]
    fn only_a_strictly_newer_release_is_an_update() {
        assert!(is_newer("1.2.4", "1.2.3"));
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2.2", "1.2.3"));
    }
}
