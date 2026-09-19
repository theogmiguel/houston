use crate::markers::{Hit, Marker, MarkerScanner};
use std::collections::VecDeque;

// Ring bounds: block count and total command-text bytes. The ring is memory-only,
// so a wrong value costs leaked memory or a truncated history, never correctness.
const MAX_BLOCKS: usize = 200;
const MAX_RING_CMD_BYTES: usize = 256 * 1024;
// A single command line is truncated to this many bytes char-safely, so one
// enormous paste cannot dominate the ring.
const MAX_CMD_LEN: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandBlock {
    pub cmd: String,
    pub cwd: String,
    pub exit: Option<i32>,
    pub start_offset: u64,
    pub end_offset: u64,
    pub started_at: u64,
    pub ended_at: u64,
}

#[derive(Debug)]
struct Pending {
    cmd: String,
    cwd: String,
    start_offset: u64,
    started_at: u64,
}

#[derive(Debug, Default)]
pub struct FeedOutcome {
    pub completed: Vec<CommandBlock>,
    pub cwd: Option<String>,
}

#[derive(Debug)]
pub struct BlockTracker {
    scanner: MarkerScanner,
    ring: VecDeque<CommandBlock>,
    ring_cmd_bytes: usize,
    current: Option<Pending>,
    last_cwd: Option<String>,
}

fn truncate_cmd(mut cmd: String) -> String {
    if cmd.len() > MAX_CMD_LEN {
        let mut cut = MAX_CMD_LEN;
        while !cmd.is_char_boundary(cut) {
            cut -= 1;
        }
        cmd.truncate(cut);
    }
    cmd
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl BlockTracker {
    pub fn new(token: String) -> Self {
        Self {
            scanner: MarkerScanner::new(token),
            ring: VecDeque::new(),
            ring_cmd_bytes: 0,
            current: None,
            last_cwd: None,
        }
    }

    pub fn feed(&mut self, chunk: &[u8], chunk_offset: u64) -> FeedOutcome {
        let hits = self.scanner.feed(chunk, chunk_offset);
        let mut out = FeedOutcome::default();
        for Hit { marker, offset } in hits {
            match marker {
                Marker::Cwd { path } => {
                    let p = path.display().to_string();
                    self.last_cwd = Some(p.clone());
                    out.cwd = Some(p);
                }
                Marker::CommandStart { cmd } => {
                    self.current = Some(Pending {
                        cmd: truncate_cmd(cmd),
                        cwd: self.last_cwd.clone().unwrap_or_default(),
                        start_offset: offset,
                        started_at: now_unix(),
                    });
                }
                Marker::CommandEnd { exit } => {
                    if let Some(p) = self.current.take() {
                        let block = CommandBlock {
                            cmd: p.cmd,
                            cwd: p.cwd,
                            exit,
                            start_offset: p.start_offset,
                            end_offset: offset,
                            started_at: p.started_at,
                            ended_at: now_unix(),
                        };
                        self.push(block.clone());
                        out.completed.push(block);
                    }
                }
                Marker::PromptStart | Marker::InputStart => {}
            }
        }
        out
    }

    fn push(&mut self, block: CommandBlock) {
        self.ring_cmd_bytes += block.cmd.len();
        self.ring.push_back(block);
        while self.ring.len() > MAX_BLOCKS || self.ring_cmd_bytes > MAX_RING_CMD_BYTES {
            match self.ring.pop_front() {
                Some(evicted) => self.ring_cmd_bytes -= evicted.cmd.len(),
                None => break,
            }
        }
    }

    pub fn blocks(&self) -> Vec<CommandBlock> {
        self.ring.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    const TOKEN: &str = "right-token";

    fn feed_str(t: &mut BlockTracker, s: &str, offset: u64) -> FeedOutcome {
        t.feed(s.as_bytes(), offset)
    }

    fn cmd_marker(cmd: &str) -> String {
        format!(
            "\x1b]133;C;{TOKEN};{}\x07",
            base64::engine::general_purpose::STANDARD.encode(cmd)
        )
    }

    #[test]
    fn assembles_a_block_from_c_and_d() {
        let mut t = BlockTracker::new(TOKEN.into());
        feed_str(&mut t, "\x1b]9;9;right-token;/home/x\x07", 0);
        let start = cmd_marker("cargo test");
        feed_str(&mut t, &start, 100);
        let out = feed_str(&mut t, "output...\x1b]133;D;right-token;0\x07", 500);
        assert_eq!(out.completed.len(), 1);
        let b = &out.completed[0];
        assert_eq!(b.cmd, "cargo test");
        assert_eq!(b.cwd, "/home/x");
        assert_eq!(b.exit, Some(0));
        assert_eq!(b.start_offset, 100);
        assert_eq!(b.end_offset, 500 + 9);
        assert_eq!(t.blocks().len(), 1);
    }

    #[test]
    fn d_without_c_is_ignored() {
        let mut t = BlockTracker::new(TOKEN.into());
        let out = feed_str(&mut t, "\x1b]133;D;right-token;1\x07", 0);
        assert!(out.completed.is_empty());
        assert!(t.blocks().is_empty());
    }

    #[test]
    fn ring_is_bounded_by_count() {
        let mut t = BlockTracker::new(TOKEN.into());
        for i in 0..(MAX_BLOCKS + 50) {
            let seq = format!(
                "{}{}",
                cmd_marker(&format!("cmd-{i}")),
                "\x1b]133;D;right-token;0\x07"
            );
            feed_str(&mut t, &seq, (i * 100) as u64);
        }
        let blocks = t.blocks();
        assert_eq!(blocks.len(), MAX_BLOCKS);
        assert_eq!(blocks[0].cmd, "cmd-50", "oldest evicted first");
    }

    #[test]
    fn oversize_command_is_truncated_char_safe() {
        let mut t = BlockTracker::new(TOKEN.into());
        let long = "é".repeat(MAX_CMD_LEN);
        let seq = format!("{}{}", cmd_marker(&long), "\x1b]133;D;right-token;0\x07");
        feed_str(&mut t, &seq, 0);
        let b = &t.blocks()[0];
        assert!(b.cmd.len() <= MAX_CMD_LEN);
        assert!(b.cmd.chars().all(|c| c == 'é'), "no split char at the cut");
    }

    #[test]
    fn cwd_report_updates_between_blocks() {
        let mut t = BlockTracker::new(TOKEN.into());
        feed_str(&mut t, "\x1b]9;9;right-token;/a\x07", 0);
        feed_str(&mut t, &cmd_marker("one"), 10);
        feed_str(
            &mut t,
            "\x1b]133;D;right-token;0\x07\x1b]9;9;right-token;/b\x07",
            20,
        );
        feed_str(&mut t, &cmd_marker("two"), 40);
        let out = feed_str(&mut t, "\x1b]133;D;right-token;0\x07", 50);
        assert_eq!(out.completed[0].cwd, "/b");
        assert_eq!(t.blocks()[0].cwd, "/a");
    }

    #[test]
    fn raw_marker_offsets_still_index_length_preserving_redacted_output() {
        let mut tracker = BlockTracker::new(TOKEN.into());
        let mut redactor = crate::shellint::TokenRedactor::new(TOKEN);
        let held_prefix = b"output righ";
        let start = cmd_marker("echo safe");
        let end = b"done\x1b]133;D;right-token;0\x07";

        let mut public = Vec::new();
        public.extend_from_slice(redactor.feed(held_prefix).as_ref());
        tracker.feed(held_prefix, 0);
        public.extend_from_slice(redactor.feed(start.as_bytes()).as_ref());
        tracker.feed(start.as_bytes(), held_prefix.len() as u64);
        public.extend_from_slice(redactor.feed(end).as_ref());
        let outcome = tracker.feed(end, (held_prefix.len() + start.len()) as u64);
        public.extend_from_slice(&redactor.finish());

        let block = &outcome.completed[0];
        let public_start = memchr::memmem::find(&public, b"\x1b]133;C;").unwrap();
        let public_end = memchr::memmem::rfind(&public, b"\x1b]133;D;").unwrap();
        assert_eq!(block.start_offset, public_start as u64);
        assert_eq!(block.end_offset, public_end as u64);
    }
}
