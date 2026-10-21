use regex::{Regex, RegexBuilder};
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;

use super::{build_path_index, load_path_index, IndexedPath};
use crate::fs_allowlist::{assert_within_allowed_roots, AllowedRoots};

// Larger files are generated or vendored in practice, and the editor refuses most of them.
const MAX_SEARCHED_FILE_BYTES: u64 = 1024 * 1024;
// Five screens of rows; past that the user refines the query instead of scrolling.
const MAX_MATCHING_LINES: usize = 1000;
// Bounds disk reads per query in a monorepo; the path index itself allows 100 000 files.
const MAX_SCANNED_FILES: usize = 20_000;
// A slow disk or network share must release the search so a refined query can run.
const SEARCH_DEADLINE: Duration = Duration::from_secs(5);
const MAX_QUERY_CHARS: usize = 256;
// Minified lines would otherwise send megabytes; keep a window around the first hit.
const MAX_PREVIEW_CHARS: usize = 300;
const PREVIEW_LEAD_CHARS: usize = 60;
// The same NUL-in-prefix test Git uses to call a file binary.
const BINARY_SNIFF_BYTES: usize = 8000;
// Superseded scans exit at their next file, so two permits cover one live query.
const MAX_CONTENT_SEARCHES: usize = 2;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    pub line: usize,
    pub column: usize,
    pub preview: String,
    pub ranges: Vec<[usize; 2]>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentFile {
    pub path: String,
    pub matches: Vec<ContentMatch>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ContentLimitKind {
    MatchingLines,
    ScannedFiles,
    Milliseconds,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentLimit {
    pub kind: ContentLimitKind,
    pub limit: u64,
    pub actual: u64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResult {
    pub files: Vec<ContentFile>,
    pub matching_lines: usize,
    pub scanned_files: usize,
    pub skipped_large: usize,
    pub skipped_binary: usize,
    pub stopped_at: Option<ContentLimit>,
}

struct Limits {
    matching_lines: usize,
    scanned_files: usize,
    deadline: Duration,
}

const LIMITS: Limits = Limits {
    matching_lines: MAX_MATCHING_LINES,
    scanned_files: MAX_SCANNED_FILES,
    deadline: SEARCH_DEADLINE,
};

fn content_matcher(
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<Regex, String> {
    let chars = query.chars().count();
    if chars > MAX_QUERY_CHARS {
        return Err(format!(
            "fs_search_contents: query length limit {MAX_QUERY_CHARS} characters; actual {chars}"
        ));
    }
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let pattern = if regex && whole_word {
        format!(r"\b(?:{query})\b")
    } else if regex {
        query.to_string()
    } else {
        let literal = regex::escape(query);
        // A literal edge that is punctuation has no word boundary to require.
        let start = whole_word && word(query.chars().next());
        let end = whole_word && word(query.chars().next_back());
        format!(
            "{}{literal}{}",
            if start { r"\b" } else { "" },
            if end { r"\b" } else { "" }
        )
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| {
            format!("fs_search_contents: {query:?} is not a valid regular expression: {error}")
        })
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn line_match(line: &str, number: usize, matcher: &Regex) -> Option<ContentMatch> {
    let hits = matcher
        .find_iter(line)
        .filter(|hit| !hit.is_empty())
        .map(|hit| (hit.start(), hit.end()))
        .collect::<Vec<_>>();
    let first = hits.first()?.0;
    let first_char = line[..first].chars().count();
    let indent = line.chars().take_while(|c| c.is_whitespace()).count();
    let start_char = first_char.min(indent.max(first_char.saturating_sub(PREVIEW_LEAD_CHARS)));
    let start = line
        .char_indices()
        .nth(start_char)
        .map_or(line.len(), |(i, _)| i);
    let end = line[start..]
        .char_indices()
        .nth(MAX_PREVIEW_CHARS)
        .map_or(line.len(), |(i, _)| start + i);
    let preview = &line[start..end];
    let ranges = hits
        .iter()
        .filter(|(from, _)| *from >= start && *from < end)
        .map(|&(from, to)| {
            [
                utf16_len(&line[start..from]),
                utf16_len(&line[start..to.min(end)]),
            ]
        })
        .collect();
    Some(ContentMatch {
        line: number,
        column: utf16_len(&line[..first]) + 1,
        preview: preview.to_string(),
        ranges,
    })
}

enum FileText {
    Text(String),
    Large,
    Binary,
    Unreadable,
}

fn read_text(path: &Path) -> FileText {
    // Symlinks may leave the allowed root and FIFOs block a read forever.
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => return FileText::Unreadable,
        Ok(metadata) if metadata.len() > MAX_SEARCHED_FILE_BYTES => return FileText::Large,
        Ok(_) => {}
        Err(_) => return FileText::Unreadable,
    }
    let Ok(file) = std::fs::File::open(path) else {
        return FileText::Unreadable;
    };
    let mut bytes = Vec::new();
    if file
        .take(MAX_SEARCHED_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return FileText::Unreadable;
    }
    if bytes.len() as u64 > MAX_SEARCHED_FILE_BYTES {
        return FileText::Large;
    }
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return FileText::Binary;
    }
    FileText::Text(String::from_utf8_lossy(&bytes).into_owned())
}

fn scan(
    root: &Path,
    index: &[IndexedPath],
    matcher: &Regex,
    limits: &Limits,
    superseded: impl Fn() -> bool,
) -> Result<ContentSearchResult, String> {
    let started = Instant::now();
    let candidates = index.iter().filter(|entry| !entry.is_dir);
    let total = candidates.clone().count();
    let mut result = ContentSearchResult::default();
    for entry in candidates {
        if superseded() {
            return Err("fs_search_contents: superseded by a newer search".to_string());
        }
        let elapsed = started.elapsed();
        if elapsed >= limits.deadline {
            result.stopped_at = Some(ContentLimit {
                kind: ContentLimitKind::Milliseconds,
                limit: limits.deadline.as_millis() as u64,
                actual: elapsed.as_millis() as u64,
            });
            break;
        }
        if result.scanned_files == limits.scanned_files {
            result.stopped_at = Some(ContentLimit {
                kind: ContentLimitKind::ScannedFiles,
                limit: limits.scanned_files as u64,
                actual: total as u64,
            });
            break;
        }
        result.scanned_files += 1;
        let text = match read_text(&root.join(&entry.relative)) {
            FileText::Text(text) => text,
            FileText::Large => {
                result.skipped_large += 1;
                continue;
            }
            FileText::Binary => {
                result.skipped_binary += 1;
                continue;
            }
            FileText::Unreadable => continue,
        };
        if !matcher.is_match(&text) {
            continue;
        }
        let mut matches = Vec::new();
        for (number, line) in text.split('\n').enumerate() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let Some(hit) = line_match(line, number + 1, matcher) else {
                continue;
            };
            if result.matching_lines == limits.matching_lines {
                result.stopped_at = Some(ContentLimit {
                    kind: ContentLimitKind::MatchingLines,
                    limit: limits.matching_lines as u64,
                    actual: limits.matching_lines as u64 + 1,
                });
                break;
            }
            result.matching_lines += 1;
            matches.push(hit);
        }
        if !matches.is_empty() {
            result.files.push(ContentFile {
                path: entry.relative.clone(),
                matches,
            });
        }
        if result.stopped_at.is_some() {
            break;
        }
    }
    Ok(result)
}

fn content_search_permits() -> &'static Arc<tokio::sync::Semaphore> {
    static PERMITS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    PERMITS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_CONTENT_SEARCHES)))
}

static LATEST_SEARCH: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn fs_search_contents(
    root: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    state: State<'_, AllowedRoots>,
) -> Result<ContentSearchResult, String> {
    let generation = LATEST_SEARCH.fetch_add(1, Ordering::SeqCst) + 1;
    if query.is_empty() {
        return Ok(ContentSearchResult::default());
    }
    let matcher = content_matcher(&query, case_sensitive, whole_word, regex)?;
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real_root = assert_within_allowed_roots(&root, &roots).await?;
    if !real_root.is_dir() {
        return Err(format!(
            "fs_search_contents: root {} is not a directory",
            real_root.display()
        ));
    }
    let index = load_path_index(real_root.clone(), |root| build_path_index(&root)).await?;
    let permit = content_search_permits()
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| format!("fs_search_contents: search permits closed: {error}"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        scan(&real_root, &index, &matcher, &LIMITS, || {
            LATEST_SEARCH.load(Ordering::SeqCst) != generation
        })
    })
    .await
    .map_err(|error| format!("fs_search_contents search task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn indexed(paths: &[&str]) -> Vec<IndexedPath> {
        paths
            .iter()
            .map(|path| IndexedPath {
                relative: path.to_string(),
                is_dir: false,
            })
            .collect()
    }

    fn search(root: &Path, paths: &[&str], matcher: Regex) -> ContentSearchResult {
        scan(root, &indexed(paths), &matcher, &LIMITS, || false).unwrap()
    }

    #[test]
    fn matches_report_line_column_and_utf16_ranges_per_file() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("a.rs"),
            "fn main() {\r\n    let café = Needle;\r\n}\n// needle needle\n",
        )
        .unwrap();
        std::fs::write(root.path().join("b.rs"), "nothing here\n").unwrap();
        let result = search(
            root.path(),
            &["a.rs", "b.rs"],
            content_matcher("needle", false, false, false).unwrap(),
        );
        assert_eq!(result.scanned_files, 2);
        assert_eq!(result.matching_lines, 2);
        assert_eq!(result.stopped_at, None);
        assert_eq!(
            result.files,
            vec![ContentFile {
                path: "a.rs".to_string(),
                matches: vec![
                    ContentMatch {
                        line: 2,
                        column: 16,
                        preview: "let café = Needle;".to_string(),
                        ranges: vec![[11, 17]],
                    },
                    ContentMatch {
                        line: 4,
                        column: 4,
                        preview: "// needle needle".to_string(),
                        ranges: vec![[3, 9], [10, 16]],
                    },
                ],
            }]
        );
    }

    #[test]
    fn case_whole_word_and_regex_toggles_narrow_matches() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("a.txt"),
            "Needle\nneedles\nneedle()\nneedle_x\n",
        )
        .unwrap();
        let lines = |matcher| {
            search(root.path(), &["a.txt"], matcher).files[0]
                .matches
                .iter()
                .map(|hit| hit.line)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            lines(content_matcher("needle", true, false, false).unwrap()),
            [2, 3, 4]
        );
        assert_eq!(
            lines(content_matcher("needle", false, true, false).unwrap()),
            [1, 3]
        );
        assert_eq!(
            lines(content_matcher("needle()", false, true, false).unwrap()),
            [3]
        );
        assert_eq!(
            lines(content_matcher("needle(s|_x)", false, false, true).unwrap()),
            [2, 4]
        );
        let invalid = content_matcher("needle(", false, false, true).unwrap_err();
        assert!(invalid.contains("\"needle(\""), "{invalid}");
        let long =
            content_matcher(&"x".repeat(MAX_QUERY_CHARS + 1), false, false, false).unwrap_err();
        assert!(
            long.contains(&format!(
                "limit {MAX_QUERY_CHARS} characters; actual {}",
                MAX_QUERY_CHARS + 1
            )),
            "{long}"
        );
    }

    #[test]
    fn binary_large_and_non_regular_files_are_skipped() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("bin.dat"), b"needle\0rest").unwrap();
        let large = format!("needle\n{}", "x".repeat(MAX_SEARCHED_FILE_BYTES as usize));
        std::fs::write(root.path().join("large.txt"), large).unwrap();
        std::fs::create_dir(root.path().join("dir")).unwrap();
        std::fs::write(root.path().join("ok.txt"), "needle").unwrap();
        let result = search(
            root.path(),
            &["bin.dat", "large.txt", "dir", "gone.txt", "ok.txt"],
            content_matcher("needle", false, false, false).unwrap(),
        );
        assert_eq!(result.skipped_binary, 1);
        assert_eq!(result.skipped_large, 1);
        assert_eq!(result.matching_lines, 1);
        assert_eq!(result.files[0].path, "ok.txt");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_out_of_the_root_are_not_read() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "needle").unwrap();
        let root = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.path().join("link.txt"),
        )
        .unwrap();
        let result = search(
            root.path(),
            &["link.txt"],
            content_matcher("needle", false, false, false).unwrap(),
        );
        assert_eq!(result.matching_lines, 0);
    }

    #[test]
    fn long_lines_preview_a_window_around_the_first_hit() {
        let root = tempfile::tempdir().unwrap();
        let line = format!("{}needle{}", "a".repeat(5000), "b".repeat(5000));
        std::fs::write(root.path().join("min.js"), &line).unwrap();
        let result = search(
            root.path(),
            &["min.js"],
            content_matcher("needle", false, false, false).unwrap(),
        );
        let hit = &result.files[0].matches[0];
        assert_eq!(hit.column, 5001);
        assert_eq!(hit.preview.chars().count(), MAX_PREVIEW_CHARS);
        assert_eq!(
            hit.ranges,
            vec![[PREVIEW_LEAD_CHARS, PREVIEW_LEAD_CHARS + 6]]
        );
    }

    #[test]
    fn each_cap_stops_the_scan_and_names_limit_and_actual() {
        let root = tempfile::tempdir().unwrap();
        for name in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(root.path().join(name), "needle\nneedle\n").unwrap();
        }
        let paths = indexed(&["a.txt", "b.txt", "c.txt"]);
        let matcher = content_matcher("needle", false, false, false).unwrap();
        let run = |limits: Limits| scan(root.path(), &paths, &matcher, &limits, || false).unwrap();

        let lines = run(Limits {
            matching_lines: 3,
            ..LIMITS
        });
        assert_eq!(lines.matching_lines, 3);
        assert_eq!(lines.files.len(), 2);
        assert_eq!(
            lines.stopped_at,
            Some(ContentLimit {
                kind: ContentLimitKind::MatchingLines,
                limit: 3,
                actual: 4
            })
        );

        let files = run(Limits {
            scanned_files: 2,
            ..LIMITS
        });
        assert_eq!(files.scanned_files, 2);
        assert_eq!(
            files.stopped_at,
            Some(ContentLimit {
                kind: ContentLimitKind::ScannedFiles,
                limit: 2,
                actual: 3
            })
        );

        let time = run(Limits {
            deadline: Duration::ZERO,
            ..LIMITS
        });
        assert_eq!(time.scanned_files, 0);
        assert!(matches!(
            time.stopped_at,
            Some(ContentLimit {
                kind: ContentLimitKind::Milliseconds,
                limit: 0,
                ..
            })
        ));
    }

    #[test]
    fn a_newer_search_supersedes_a_running_scan() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.txt"), "needle").unwrap();
        let matcher = content_matcher("needle", false, false, false).unwrap();
        let error = scan(root.path(), &indexed(&["a.txt"]), &matcher, &LIMITS, || {
            true
        })
        .unwrap_err();
        assert!(error.contains("superseded"), "{error}");
    }

    #[test]
    fn gitignored_files_are_not_searched() {
        let root = tempfile::tempdir().unwrap();
        let initialized = houston_core::spawn::command("git")
            .args(["init", "-q"])
            .current_dir(root.path())
            .status();
        if !initialized.map(|status| status.success()).unwrap_or(false) {
            return;
        }
        std::fs::write(root.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(root.path().join("visible.txt"), "needle").unwrap();
        std::fs::write(root.path().join("ignored.txt"), "needle").unwrap();
        let index = build_path_index(root.path()).unwrap();
        let matcher = content_matcher("needle", false, false, false).unwrap();
        let result = scan(root.path(), &index, &matcher, &LIMITS, || false).unwrap();
        let paths = result
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, ["visible.txt"]);
    }
}
