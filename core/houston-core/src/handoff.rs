use crate::agents::strip_ansi;
use crate::blocks::CommandBlock;

const TOTAL_BUDGET: usize = 128 * 1024;
const BLOCK_CAP: usize = 12 * 1024;
const KEEP_FIRST: usize = 3;
const KEEP_LAST: usize = 10;
const IDLE_GAP_SECS: u64 = 5 * 60;
pub const FALLBACK_TAIL_BYTES: u64 = 32 * 1024;

pub struct Facts {
    pub codename: String,
    pub agent: String,
    pub cwd: String,
    pub branch: Option<String>,
    pub platform: String,
    pub age_secs: Option<u64>,
}

fn fmt_duration(secs: u64) -> String {
    if secs >= 3600 {
        format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60)
    } else if secs >= 60 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else {
        format!("{secs}s")
    }
}

fn elide_middle(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let keep = cap / 2;
    let mut head_end = keep.min(text.len());
    while !text.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = text.len() - keep.min(text.len());
    while !text.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    let omitted = tail_start - head_end;
    format!(
        "{}\n… {omitted} bytes omitted …\n{}",
        &text[..head_end],
        &text[tail_start..]
    )
}

fn render_block(b: &CommandBlock, output: &str, output_truncated: bool) -> String {
    let exit = match b.exit {
        Some(0) => String::new(),
        Some(code) => format!(" — exit {code}"),
        None => " — exit unknown".to_string(),
    };
    let dur = fmt_duration(b.ended_at.saturating_sub(b.started_at));
    let trunc = if output_truncated {
        "\n(older output no longer in the scrollback buffer)"
    } else {
        ""
    };
    let out = elide_middle(output.trim_end(), BLOCK_CAP);
    // Only sanitization point before this block reaches disk in the handoff
    // prompt file — must run here, not by whoever writes the file later.
    let (cmd, _) = crate::sanitize::redact_command_secrets(&b.cmd);
    format!(
        "### `$ {}`\n({} · {}{}){}\n```\n{}\n```\n",
        cmd, b.cwd, dur, exit, trunc, out
    )
}

fn select_indices(blocks: &[CommandBlock], rendered: &[String]) -> Vec<usize> {
    let n = rendered.len();
    let mut chosen: Vec<usize> = (0..n)
        .filter(|&i| i < KEEP_FIRST || i + KEEP_LAST >= n)
        .collect();
    let mut used: usize = chosen.iter().map(|&i| rendered[i].len()).sum();
    let mut middle: Vec<usize> = (0..n)
        .filter(|&i| i >= KEEP_FIRST && i + KEEP_LAST < n)
        .collect();
    middle.sort_by_key(|&i| (blocks[i].exit == Some(0), std::cmp::Reverse(i)));
    for i in middle {
        if used + rendered[i].len() > TOTAL_BUDGET {
            continue;
        }
        used += rendered[i].len();
        chosen.push(i);
    }
    chosen.sort_unstable();
    chosen
}

pub fn curate_blocks(
    blocks: &[CommandBlock],
    mut fetch_output: impl FnMut(u64, u64) -> (Vec<u8>, bool),
) -> String {
    let rendered: Vec<String> = blocks
        .iter()
        .map(|b| {
            let (raw, truncated) = fetch_output(b.start_offset, b.end_offset);
            let text = strip_ansi(&String::from_utf8_lossy(&raw));
            render_block(b, &text, truncated)
        })
        .collect();
    let chosen = select_indices(blocks, &rendered);

    let mut out = String::new();
    let mut prev: Option<usize> = None;
    for &i in &chosen {
        if let Some(p) = prev {
            let skipped = i - p - 1;
            if skipped > 0 {
                out.push_str(&format!("\n… {skipped} command(s) omitted …\n\n"));
            }
            let gap = blocks[i].started_at.saturating_sub(blocks[p].ended_at);
            if gap > IDLE_GAP_SECS {
                out.push_str(&format!("— idle {} —\n\n", fmt_duration(gap)));
            }
        }
        out.push_str(&rendered[i]);
        out.push('\n');
        prev = Some(i);
    }
    out
}

pub fn fallback_tail(raw: &[u8]) -> String {
    let text = strip_ansi(&String::from_utf8_lossy(raw));
    format!(
        "### Recent terminal output (no command markers available)\n```\n{}\n```\n",
        text.trim()
    )
}

pub fn build_prompt(facts: &Facts, activity: &str) -> String {
    let branch = facts.branch.as_deref().unwrap_or("(none)");
    let age = facts
        .age_secs
        .map(fmt_duration)
        .unwrap_or_else(|| "unknown".into());
    format!(
        r#"You are writing a session handoff: a briefing that lets another engineer (or
agent) pick up this terminal session exactly where it left off. Base it ONLY
on the session record below — never invent commands, files, or outcomes.

Write the handoff as markdown between the literal markers <<<START>>> and
<<<END>>>, with exactly these sections:

## Summary
## What Happened
## Detailed Results
## Problems
## Where Things Left Off
## Next Steps

Be specific: real paths, real commands, real error text. If something is
unknown, say it is unknown.

# Session facts
- Pane: {codename} ({agent})
- Working directory: {cwd}
- Git branch: {branch}
- Platform: {platform}
- Session age: {age}

# Terminal activity

{activity}
"#,
        codename = facts.codename,
        agent = facts.agent,
        cwd = facts.cwd,
        branch = branch,
        platform = facts.platform,
        age = age,
        activity = activity,
    )
}

pub fn extract_markdown(raw_output: &str) -> String {
    let stripped = strip_ansi(raw_output)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    if let Some(s) = stripped.find("<<<START>>>") {
        let body = &stripped[s + "<<<START>>>".len()..];
        if let Some(e) = body.find("<<<END>>>") {
            return body[..e].trim().to_string();
        }
    }
    stripped.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(i: usize, exit: i32, start: u64, end: u64, t0: u64, t1: u64) -> CommandBlock {
        CommandBlock {
            cmd: format!("cmd-{i}"),
            cwd: "/w".into(),
            exit: Some(exit),
            start_offset: start,
            end_offset: end,
            started_at: t0,
            ended_at: t1,
        }
    }

    #[test]
    fn keeps_first_three_and_last_ten() {
        let blocks: Vec<CommandBlock> = (0..30)
            .map(|i| block(i, 0, 0, 10, i as u64 * 10, i as u64 * 10 + 1))
            .collect();
        let out = curate_blocks(&blocks, |_, _| (b"ok".to_vec(), false));
        for i in [0, 1, 2, 20, 29] {
            assert!(out.contains(&format!("cmd-{i}")), "must keep cmd-{i}");
        }
    }

    #[test]
    fn failed_middle_blocks_win_over_ok_ones_under_budget() {
        let blocks: Vec<CommandBlock> = (0..40)
            .map(|i| {
                let exit = if i == 15 { 1 } else { 0 };
                block(i, exit, 0, 10, i as u64, i as u64 + 1)
            })
            .collect();
        let out = curate_blocks(&blocks, |_, _| (vec![b'x'; 6 * 1024], false));
        assert!(
            out.contains("cmd-15"),
            "the failed middle block must be selected first"
        );
        assert!(out.contains("exit 1"));
        assert!(out.contains("command(s) omitted"));
    }

    #[test]
    fn long_output_is_middle_elided_to_the_block_cap() {
        let blocks = vec![block(0, 0, 0, 100, 0, 1)];
        let out = curate_blocks(&blocks, |_, _| (vec![b'y'; 50 * 1024], false));
        assert!(out.contains("bytes omitted"));
        assert!(out.len() < 14 * 1024, "got {}", out.len());
    }

    #[test]
    fn idle_gaps_are_annotated() {
        let blocks = vec![block(0, 0, 0, 10, 100, 110), block(1, 0, 10, 20, 800, 810)];
        let out = curate_blocks(&blocks, |_, _| (b"z".to_vec(), false));
        assert!(out.contains("— idle 11m30s —"), "out: {out}");
    }

    #[test]
    fn trimmed_output_is_flagged() {
        let blocks = vec![block(0, 0, 0, 10, 0, 1)];
        let out = curate_blocks(&blocks, |_, _| (b"tail".to_vec(), true));
        assert!(out.contains("no longer in the scrollback buffer"));
    }

    #[test]
    fn extract_markdown_prefers_the_markers() {
        let raw = "noise\x1b[31m\r\n<<<START>>>\r\n## Summary\r\nhi\r\n<<<END>>>\r\ntrailer";
        assert_eq!(extract_markdown(raw), "## Summary\nhi");
        assert_eq!(extract_markdown("plain output"), "plain output");
        let unterminated = "<<<START>>>\nhalf";
        assert!(extract_markdown(unterminated).contains("half"));
    }

    #[test]
    fn prompt_carries_facts_and_activity() {
        let p = build_prompt(
            &Facts {
                codename: "Kai".into(),
                agent: "claude".into(),
                cwd: "/repo".into(),
                branch: Some("main".into()),
                platform: "linux/x86_64".into(),
                age_secs: Some(3700),
            },
            "### `$ ls`\n",
        );
        for needle in ["Kai", "/repo", "main", "1h01m", "<<<START>>>", "### `$ ls`"] {
            assert!(p.contains(needle), "prompt missing {needle}");
        }
    }

    #[test]
    fn rendered_block_redacts_secrets_in_the_command_line() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
        let mut b = block(0, 0, 0, 10, 0, 1);
        b.cmd = format!(
            "curl -H \"Authorization: Bearer {jwt}\" -u AKIAIOSFODNN7EXAMPLE:secret https://api.example.com"
        );
        let out = curate_blocks(&[b], |_, _| (b"ok".to_vec(), false));
        assert!(out.contains("[redacted:jwt]"), "out: {out}");
        assert!(out.contains("[redacted:aws_key]"), "out: {out}");
        assert!(!out.contains(jwt));
        assert!(!out.contains("AKIAIOSFODNN7EXAMPLE"));
    }

    #[test]
    fn rendered_block_leaves_an_ordinary_uuid_argument_alone() {
        let uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
        let mut b = block(0, 0, 0, 10, 0, 1);
        b.cmd = format!("kubectl get pod {uuid} -n default");
        let out = curate_blocks(&[b], |_, _| (b"ok".to_vec(), false));
        assert!(
            out.contains(uuid),
            "a bare uuid argument must survive: {out}"
        );
    }
}
