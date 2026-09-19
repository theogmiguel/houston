use std::io::{self, Read, Write};

pub const SUPERVISOR_FD_ENV: &str = "HOUSTON_SUPERVISOR_FD";

// Bounds on a length-prefixed field/argv so a corrupt or hostile peer can't make the
// reader allocate an unbounded buffer; generous for a real daemon path/argv.
const MAX_STRING_LEN: usize = 64 * 1024;
const MAX_ARGS: usize = 256;

const TAG_CHILD_EXITED: u8 = 1;
const TAG_SPAWN_NEXT: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorFile {
    pub pid: u32,
    pub pid_creation: Option<u64>,
    pub generation: u64,
}

impl SupervisorFile {
    // Hand-rolled, not serde_json: houston-supervisor must not link a serializer to
    // stay on its minimal std + libc/nix code path.
    pub fn to_json(self) -> String {
        let pid_creation = match self.pid_creation {
            Some(pc) => pc.to_string(),
            None => "null".to_string(),
        };
        format!(
            "{{\"pid\":{},\"pid_creation\":{pid_creation},\"generation\":{}}}",
            self.pid, self.generation
        )
    }

    pub fn from_json(s: &str) -> Option<Self> {
        let pid = extract_u64(s, "\"pid\":")? as u32;
        let generation = extract_u64(s, "\"generation\":")?;
        let pid_creation = extract_u64(s, "\"pid_creation\":");
        Some(SupervisorFile {
            pid,
            pid_creation,
            generation,
        })
    }
}

fn extract_u64(s: &str, key: &str) -> Option<u64> {
    let idx = s.find(key)? + key.len();
    let rest = s[idx..].trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    rest[..end].parse().ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitReport {
    pub pid: i32,
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnNext {
    pub daemon_path: String,
    pub args: Vec<String>,
}

pub enum FromSupervisor {
    ChildExited(ExitReport),
}

pub enum ToSupervisor {
    SpawnNext(SpawnNext),
}

fn write_option_i32<W: Write>(w: &mut W, v: Option<i32>) -> io::Result<()> {
    match v {
        Some(n) => {
            w.write_all(&[1u8])?;
            w.write_all(&n.to_le_bytes())
        }
        None => w.write_all(&[0u8]),
    }
}

fn read_option_i32<R: Read>(r: &mut R) -> io::Result<Option<i32>> {
    let mut tag = [0u8; 1];
    r.read_exact(&mut tag)?;
    if tag[0] == 0 {
        return Ok(None);
    }
    let mut buf = [0u8; 4];
    r.read_exact(&mut buf)?;
    Ok(Some(i32::from_le_bytes(buf)))
}

fn write_string<W: Write>(w: &mut W, s: &str) -> io::Result<()> {
    let bytes = s.as_bytes();
    w.write_all(&(bytes.len() as u32).to_le_bytes())?;
    w.write_all(bytes)
}

fn read_string<R: Read>(r: &mut R) -> io::Result<String> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_STRING_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("supervisor wire: string field is {len} bytes, cap is {MAX_STRING_LEN}"),
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    String::from_utf8(buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

pub fn write_exit_report<W: Write>(w: &mut W, report: ExitReport) -> io::Result<()> {
    w.write_all(&[TAG_CHILD_EXITED])?;
    w.write_all(&report.pid.to_le_bytes())?;
    write_option_i32(w, report.code)?;
    write_option_i32(w, report.signal)?;
    w.flush()
}

pub fn write_spawn_next<W: Write>(w: &mut W, req: &SpawnNext) -> io::Result<()> {
    if req.args.len() > MAX_ARGS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "supervisor wire: spawn_next argv has {} entries, cap is {MAX_ARGS}",
                req.args.len()
            ),
        ));
    }
    w.write_all(&[TAG_SPAWN_NEXT])?;
    write_string(w, &req.daemon_path)?;
    w.write_all(&(req.args.len() as u32).to_le_bytes())?;
    for a in &req.args {
        write_string(w, a)?;
    }
    w.flush()
}

pub fn read_from_supervisor<R: Read>(r: &mut R) -> io::Result<FromSupervisor> {
    let mut tag = [0u8; 1];
    r.read_exact(&mut tag)?;
    match tag[0] {
        TAG_CHILD_EXITED => {
            let mut pid_buf = [0u8; 4];
            r.read_exact(&mut pid_buf)?;
            let pid = i32::from_le_bytes(pid_buf);
            let code = read_option_i32(r)?;
            let signal = read_option_i32(r)?;
            Ok(FromSupervisor::ChildExited(ExitReport {
                pid,
                code,
                signal,
            }))
        }
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("supervisor wire: unknown supervisor->daemon tag {other}"),
        )),
    }
}

pub fn read_to_supervisor<R: Read>(r: &mut R) -> io::Result<ToSupervisor> {
    let mut tag = [0u8; 1];
    r.read_exact(&mut tag)?;
    match tag[0] {
        TAG_SPAWN_NEXT => {
            let daemon_path = read_string(r)?;
            let mut argc_buf = [0u8; 4];
            r.read_exact(&mut argc_buf)?;
            let argc = u32::from_le_bytes(argc_buf) as usize;
            if argc > MAX_ARGS {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "supervisor wire: spawn_next argv has {argc} entries, cap is {MAX_ARGS}"
                    ),
                ));
            }
            let mut args = Vec::with_capacity(argc);
            for _ in 0..argc {
                args.push(read_string(r)?);
            }
            Ok(ToSupervisor::SpawnNext(SpawnNext { daemon_path, args }))
        }
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("supervisor wire: unknown daemon->supervisor tag {other}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn supervisor_file_json_round_trips() {
        let f = SupervisorFile {
            pid: 4242,
            pid_creation: Some(123456),
            generation: 3,
        };
        let parsed = SupervisorFile::from_json(&f.to_json()).expect("parses back");
        assert_eq!(parsed, f);
    }

    #[test]
    fn supervisor_file_json_handles_null_pid_creation() {
        let f = SupervisorFile {
            pid: 1,
            pid_creation: None,
            generation: 1,
        };
        let parsed = SupervisorFile::from_json(&f.to_json()).expect("parses back");
        assert_eq!(parsed, f);
    }

    #[test]
    fn exit_report_round_trips_with_code() {
        let report = ExitReport {
            pid: 999,
            code: Some(42),
            signal: None,
        };
        let mut buf = Vec::new();
        write_exit_report(&mut buf, report).unwrap();
        let mut cur = Cursor::new(buf);
        match read_from_supervisor(&mut cur).unwrap() {
            FromSupervisor::ChildExited(got) => assert_eq!(got, report),
        }
    }

    #[test]
    fn exit_report_round_trips_with_signal() {
        let report = ExitReport {
            pid: 12,
            code: None,
            signal: Some(9),
        };
        let mut buf = Vec::new();
        write_exit_report(&mut buf, report).unwrap();
        let mut cur = Cursor::new(buf);
        match read_from_supervisor(&mut cur).unwrap() {
            FromSupervisor::ChildExited(got) => assert_eq!(got, report),
        }
    }

    #[test]
    fn spawn_next_round_trips() {
        let req = SpawnNext {
            daemon_path: "/path/to/houston-core".to_string(),
            args: vec!["--flag".to_string(), "value".to_string()],
        };
        let mut buf = Vec::new();
        write_spawn_next(&mut buf, &req).unwrap();
        let mut cur = Cursor::new(buf);
        match read_to_supervisor(&mut cur).unwrap() {
            ToSupervisor::SpawnNext(got) => assert_eq!(got, req),
        }
    }

    #[test]
    fn oversized_string_is_rejected() {
        let mut buf = Vec::new();
        buf.push(TAG_SPAWN_NEXT);
        buf.extend_from_slice(&((MAX_STRING_LEN as u32) + 1).to_le_bytes());
        let mut cur = Cursor::new(buf);
        assert!(read_to_supervisor(&mut cur).is_err());
    }
}
