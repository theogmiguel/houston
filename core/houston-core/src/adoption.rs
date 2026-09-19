use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

pub const MANIFEST_VERSION: u32 = 2;

// Hard cap on descriptors one handoff may transfer in a single SCM_RIGHTS message: one
// PTY master per session, plus the /ws+/mcp listener and the daemon lock.
pub const FD_CAP: usize = 64;

// Every buffer field is base64'd rather than a bare JSON number array (~3.5x smaller
// for the same bytes), and this bounds that base64'd size.
pub const MANIFEST_BYTE_CAP: usize = 8 * 1024 * 1024;

pub const QUIESCE_PARK_TIMEOUT_MS: u64 = 1500;

pub const HANDOFF_STEP_TIMEOUT_MS: u64 = 5_000;

pub const HANDOFF_MCP_DRAIN_MS: u64 = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionManifest {
    pub session_id: u32,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub output_offset: u64,
    pub state: houston_protocol::SessionState,
    pub status: Option<houston_protocol::AgentStatus>,
    pub hidden: bool,
    pub project_dir: String,
    pub cwd: String,
    pub title: String,
    #[serde(default)]
    pub codename: String,
    #[serde(default)]
    pub tags: Vec<u32>,
    pub agent: houston_protocol::AgentKind,
    pub swarm_agent: Option<u64>,
    pub hook_cwd: Option<String>,
    pub mcp_cred: Option<McpCredManifest>,
    #[serde(with = "b64")]
    pub vt_snapshot: Vec<u8>,
    pub vt_format_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpCredManifest {
    pub hash: String,
    pub workspace_id: String,
    pub remaining_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub generation: u64,
    pub token: String,
    pub sessions: Vec<SessionManifest>,
}

impl Manifest {
    pub fn wire_byte_len(&self) -> Result<usize> {
        Ok(serde_json::to_vec(self)?.len())
    }
}

mod b64 {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(s.as_bytes())
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdoptionHello {
    pub build: String,
    pub protocol_version: u32,
    pub schema_version: u32,
    pub manifest_version: u32,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum FromOld {
    Refuse { reason: String },
    Manifest(Manifest),
    Commit { generation: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum FromNew {
    Hello(AdoptionHello),
    Prepared,
    PrepareFailed { reason: String },
    CommitAck,
}

pub fn write_frame<W: Write>(w: &mut W, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MANIFEST_BYTE_CAP {
        bail!(
            "adoption frame is {} bytes, cap is {MANIFEST_BYTE_CAP}",
            bytes.len()
        );
    }
    w.write_all(&(bytes.len() as u32).to_le_bytes())?;
    w.write_all(&bytes)?;
    w.flush()?;
    Ok(())
}

pub fn read_frame<R: Read, T: for<'de> Deserialize<'de>>(r: &mut R) -> Result<T> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MANIFEST_BYTE_CAP {
        bail!("adoption frame declares {len} bytes, cap is {MANIFEST_BYTE_CAP}");
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(serde_json::from_slice(&buf)?)
}

pub fn send_fds(sock: RawFd, fds: &[RawFd]) -> Result<()> {
    use nix::sys::socket::{sendmsg, ControlMessage, MsgFlags};
    let tag = [1u8];
    let iov = [std::io::IoSlice::new(&tag)];
    let cmsg = [ControlMessage::ScmRights(fds)];
    sendmsg::<()>(sock, &iov, &cmsg, MsgFlags::empty(), None)
        .map_err(|e| anyhow!("sendmsg(SCM_RIGHTS) for {} fds: {e}", fds.len()))?;
    Ok(())
}

pub fn recv_fds(sock: RawFd, max_fds: usize) -> Result<Vec<OwnedFd>> {
    use nix::sys::socket::{recvmsg, ControlMessageOwned, MsgFlags};
    let mut tag_buf = [0u8; 1];
    let mut iov = [std::io::IoSliceMut::new(&mut tag_buf)];
    let mut cmsg_buf = nix::cmsg_space!([RawFd; 64]);
    let msg = recvmsg::<()>(sock, &mut iov, Some(&mut cmsg_buf), MsgFlags::empty())
        .map_err(|e| anyhow!("recvmsg(SCM_RIGHTS): {e}"))?;
    let mut out = Vec::new();
    for cmsg in msg.cmsgs().context("reading control messages")? {
        if let ControlMessageOwned::ScmRights(raw) = cmsg {
            for fd in raw {
                // SAFETY: the kernel just handed us a freshly dup'd, process-unique
                // descriptor via this recvmsg call; nothing else has seen or can close it.
                out.push(unsafe { OwnedFd::from_raw_fd(fd) });
            }
        }
    }
    if out.len() > max_fds {
        bail!(
            "adoption handoff received {} descriptors, cap is {max_fds}",
            out.len()
        );
    }
    Ok(out)
}

pub struct RawMasterPty {
    file: std::sync::Mutex<Option<File>>,
    child_pid: Option<i32>,
}

impl RawMasterPty {
    pub fn from_owned_fd(fd: OwnedFd, child_pid: Option<i32>) -> Result<(Self, File)> {
        let file: File = fd.into();
        let reader_half = file
            .try_clone()
            .context("cloning the reconstructed PTY master fd for the reader thread")?;
        Ok((
            RawMasterPty {
                file: std::sync::Mutex::new(Some(file)),
                child_pid,
            },
            reader_half,
        ))
    }

    pub fn write_all(&self, data: &[u8]) -> Result<()> {
        let mut guard = self.file.lock().expect("raw pty file lock");
        let Some(f) = guard.as_mut() else {
            bail!("adopted session has no live pty (already killed)");
        };
        f.write_all(data)?;
        f.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(u16, u16)> {
        let guard = self.file.lock().expect("raw pty file lock");
        let Some(f) = guard.as_ref() else {
            bail!("adopted session has no live pty (already killed)");
        };
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: `f` is a live, still-open PTY fd; `ws` is a valid winsize matching
        // TIOCSWINSZ's expected layout.
        let rc = unsafe { libc::ioctl(f.as_raw_fd(), libc::TIOCSWINSZ, &ws as *const _) };
        if rc != 0 {
            bail!(
                "ioctl(TIOCSWINSZ) on adopted pty: {}",
                std::io::Error::last_os_error()
            );
        }
        // SAFETY: a plain-old-data struct; all-zero bits are a valid winsize.
        let mut actual: libc::winsize = unsafe { std::mem::zeroed() };
        // SAFETY: `f` is the same live fd; `actual` is a valid out-pointer for TIOCGWINSZ.
        let rc = unsafe { libc::ioctl(f.as_raw_fd(), libc::TIOCGWINSZ, &mut actual as *mut _) };
        if rc != 0 {
            bail!(
                "ioctl(TIOCGWINSZ) on adopted pty: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok((actual.ws_col, actual.ws_row))
    }

    // Through crate::pid, never libc::kill directly: a pid is not an integer, and an
    // unchecked one reaching kill(2) is a broadcast (-1 = everything signallable, 0 =
    // this whole process group).
    pub fn kill(&self) -> Result<()> {
        let Some(pid) = self.child_pid else {
            bail!("adopted session has no recorded child pid");
        };
        let pid: u32 = pid
            .try_into()
            .map_err(|_| anyhow!("adopted child pid {pid} is not a signallable pid"))?;
        match crate::pid::signal_process_checked(pid, crate::pid::Signal::Term) {
            Ok(_) => Ok(()),
            Err(e) => bail!("SIGTERM to adopted pid {pid}: {e}"),
        }
    }

    pub fn release(&self) {
        *self.file.lock().expect("raw pty file lock") = None;
    }

    pub fn as_raw_fd(&self) -> Option<RawFd> {
        self.file
            .lock()
            .expect("raw pty file lock")
            .as_ref()
            .map(|f| f.as_raw_fd())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_frame_round_trips_through_length_prefix() {
        let m = Manifest {
            version: MANIFEST_VERSION,
            generation: 2,
            token: "tok".to_string(),
            sessions: vec![SessionManifest {
                session_id: 1,
                pid: Some(4242),
                cols: 80,
                rows: 24,
                output_offset: 12,
                state: houston_protocol::SessionState::Running,
                status: None,
                hidden: false,
                project_dir: "/tmp/p".to_string(),
                cwd: "/tmp/p".to_string(),
                title: "shell".to_string(),
                codename: "shell".to_string(),
                tags: vec![],
                agent: houston_protocol::AgentKind::Shell,
                swarm_agent: None,
                hook_cwd: None,
                mcp_cred: Some(McpCredManifest {
                    hash: "abc".to_string(),
                    workspace_id: "/tmp/p".to_string(),
                    remaining_secs: 3600,
                }),
                vt_snapshot: vec![1, 2, 3, 4],
                vt_format_version: 1,
            }],
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &FromOld::Manifest(m.clone())).unwrap();
        let mut cur = std::io::Cursor::new(buf);
        let got: FromOld = read_frame(&mut cur).unwrap();
        match got {
            FromOld::Manifest(got) => {
                assert_eq!(got.sessions[0].vt_snapshot, vec![1, 2, 3, 4]);
                assert_eq!(got.sessions[0].vt_format_version, 1);
                assert_eq!(got.token, "tok");
            }
            _ => panic!("expected Manifest"),
        }
    }

    #[test]
    fn base64_buffer_is_never_a_bare_json_number_array() {
        let m = SessionManifest {
            session_id: 1,
            pid: None,
            cols: 80,
            rows: 24,
            output_offset: 0,
            state: houston_protocol::SessionState::Running,
            status: None,
            hidden: false,
            project_dir: String::new(),
            cwd: String::new(),
            title: String::new(),
            codename: String::new(),
            tags: vec![],
            agent: houston_protocol::AgentKind::Shell,
            swarm_agent: None,
            hook_cwd: None,
            mcp_cred: None,
            vt_snapshot: vec![0u8; 4096],
            vt_format_version: 1,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("[0,0,0"));
    }

    #[test]
    fn a_truncated_frame_is_an_error_not_a_short_read() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&4096u32.to_le_bytes());
        buf.extend_from_slice(b"{\"versio");
        let mut cur = std::io::Cursor::new(buf);
        let err = read_frame::<_, Manifest>(&mut cur).unwrap_err();
        assert!(
            err.to_string().contains("fill whole buffer")
                || err.downcast_ref::<std::io::Error>().is_some(),
            "a truncated frame must report the short read: {err}"
        );
    }

    #[test]
    fn a_frame_over_the_cap_is_refused_naming_the_limit_and_the_actual_size() {
        let huge = "x".repeat(MANIFEST_BYTE_CAP + 1);
        let mut buf = Vec::new();
        let err = write_frame(&mut buf, &FromNew::PrepareFailed { reason: huge }).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains(&MANIFEST_BYTE_CAP.to_string()) && msg.contains("adoption frame is"),
            "the refusal must name the cap and the actual size: {msg}"
        );
        assert!(buf.is_empty(), "nothing may be written past the cap");
    }

    #[test]
    fn oversized_frame_is_rejected_before_allocating() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&((MANIFEST_BYTE_CAP as u32) + 1).to_le_bytes());
        let mut cur = std::io::Cursor::new(buf);
        let err = read_frame::<_, Manifest>(&mut cur).unwrap_err();
        assert!(err.to_string().contains("cap is"));
    }
}
