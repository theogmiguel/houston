//! Window identity helpers shared by the Windows capture path. Upstream strips the
//! executable extension and falls back to the raw name without a platform API.

/// `snapShotAppName`: the executable's file stem, extension removed case-insensitively.
pub fn executable_name(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let stem = if file.len() >= 4 && file[file.len() - 4..].eq_ignore_ascii_case(".exe") {
        &file[..file.len() - 4]
    } else {
        file
    };
    stem.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::executable_name;

    #[test]
    fn executable_names_drop_the_extension_and_directory() {
        assert_eq!(executable_name(r"C:\Apps\Code\Code.exe"), "Code");
        assert_eq!(executable_name("C:/Apps/Code/Code.EXE"), "Code");
        assert_eq!(executable_name("powershell"), "powershell");
        assert_eq!(executable_name(""), "");
    }
}
