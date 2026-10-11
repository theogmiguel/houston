//! Windows paths into a distro's file share: `\\wsl.localhost\<D>\...`, `\\wsl$\<D>\...`,
//! and the `\\?\UNC\` form `canonicalize` returns for either.

/// `(distro, POSIX path)` for a path inside a distro's share; the host is case-insensitive.
pub fn parse(path: &str) -> Option<(String, String)> {
    let path = path.replace('/', "\\");
    let rest = match path.get(..8) {
        Some(prefix) if prefix.eq_ignore_ascii_case(r"\\?\UNC\") => &path[8..],
        _ => path.strip_prefix(r"\\")?,
    };
    let (host, rest) = rest.split_once('\\').unwrap_or((rest, ""));
    if !host.eq_ignore_ascii_case("wsl.localhost") && !host.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let mut parts = rest.split('\\').filter(|part| !part.is_empty());
    let distro = parts.next()?.to_string();
    let posix = format!("/{}", parts.collect::<Vec<_>>().join("/"));
    Some((distro, posix))
}

pub fn to_unc(distro: &str, posix: &str) -> String {
    format!(r"\\wsl.localhost\{distro}{}", posix.replace('/', "\\"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wsl(distro: &str, posix: &str) -> Option<(String, String)> {
        Some((distro.to_string(), posix.to_string()))
    }

    #[test]
    fn parses_every_share_form() {
        assert_eq!(
            parse(r"\\?\UNC\wsl.localhost\Ubuntu\home\u\a.rs"),
            wsl("Ubuntu", "/home/u/a.rs")
        );
        assert_eq!(
            parse(r"\\?\unc\WSL.LOCALHOST\Ubuntu\home"),
            wsl("Ubuntu", "/home")
        );
        assert_eq!(
            parse(r"\\WSL$\Ubuntu\home\u\p\"),
            wsl("Ubuntu", "/home/u/p")
        );
        assert_eq!(parse(r"\\wsl.localhost\Ubuntu"), wsl("Ubuntu", "/"));
        assert_eq!(parse("//wsl.localhost/Debian/srv"), wsl("Debian", "/srv"));
        assert_eq!(parse(r"C:\x"), None);
        assert_eq!(parse(r"\\?\C:\x"), None);
        assert_eq!(parse(r"\\server\share\x"), None);
        assert_eq!(parse(r"\\wsl.localhost\"), None);
        assert_eq!(
            to_unc("Ubuntu", "/home/u/a.rs"),
            r"\\wsl.localhost\Ubuntu\home\u\a.rs"
        );
    }
}
