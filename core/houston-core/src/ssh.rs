use anyhow::{anyhow, bail, Context, Result};
use russh::client::{self, Handle};
#[cfg(unix)]
use russh::keys::agent::client::AgentClient;
use russh::keys::{load_secret_key, HashAlg, PublicKey};
use russh::ChannelMsg;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

use houston_protocol as proto;

// Supports agent, identity-file, password and `~/.ssh/config`-resolved
// auth; TOFU host-key verification against `~/.houston/known_hosts`; no
// auto-reconnect.

pub enum SshCmd {
    Data(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
    Close,
    Upload {
        local_path: PathBuf,
        remote_name: String,
        reply: oneshot::Sender<Result<UploadOutcome, String>>,
    },
}

pub struct UploadOutcome {
    pub remote_path: String,
    pub bytes: u64,
}

pub struct SshHandle {
    tx: mpsc::UnboundedSender<SshCmd>,
}

impl SshHandle {
    #[cfg(all(test, unix))]
    pub(crate) fn stub() -> Self {
        let (tx, _rx) = mpsc::unbounded_channel();
        Self { tx }
    }

    pub fn write_stdin(&self, data: &[u8]) -> Result<()> {
        self.tx
            .send(SshCmd::Data(data.to_vec()))
            .map_err(|_| anyhow!("ssh session driver has stopped"))
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.tx
            .send(SshCmd::Resize { cols, rows })
            .map_err(|_| anyhow!("ssh session driver has stopped"))
    }
    pub fn kill(&self) -> Result<()> {
        let _ = self.tx.send(SshCmd::Close);
        Ok(())
    }

    pub fn upload(
        &self,
        local_path: PathBuf,
        remote_name: String,
    ) -> Result<oneshot::Receiver<Result<UploadOutcome, String>>> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(SshCmd::Upload {
                local_path,
                remote_name,
                reply,
            })
            .map_err(|_| anyhow!("ssh session driver has stopped"))?;
        Ok(rx)
    }
}

pub struct SshParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: proto::SshAuth,
    pub cols: u16,
    pub rows: u16,
    pub config_identity: Option<String>,
}

/// The directory is single-quoted so a path with spaces or `;`/`$(…)` can't
/// turn into two lines; the startup command is deliberately NOT quoted — the
/// user typed it to run on their own machine, and quoting would break it.
pub fn post_connect_lines(p: &proto::SshProfile) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(dir) = p
        .default_dir
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        out.push(format!("cd '{}'\n", dir.replace('\'', "'\\''")));
    }
    if let Some(cmd) = p
        .startup_cmd
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        out.push(format!("{cmd}\n"));
    }
    out
}

/// A patience bound, not a memory one (the transfer streams in
/// `UPLOAD_CHUNK_BYTES` pieces): with no progress UI, ~54s on a 10 Mbit/s
/// link is judged the ceiling before silence reads as a hang.
pub const UPLOAD_MAX_BYTES: u64 = 64 * 1024 * 1024;

const UPLOAD_CHUNK_BYTES: usize = 32 * 1024;

const UPLOAD_REMOTE_DIR: &str = ".houston/uploads";

pub fn upload_remote_name(
    local_path: &std::path::Path,
    remote_name: Option<&str>,
) -> Result<String> {
    let name = match remote_name {
        Some(n) => n.to_string(),
        None => local_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| {
                anyhow!(
                    "cannot derive a remote file name from {} (expected a path ending in a \
                     UTF-8 file name)",
                    local_path.display()
                )
            })?
            .to_string(),
    };
    if name.trim().is_empty() {
        bail!("remote file name is empty (expected a plain file name, e.g. \"notes.txt\")");
    }
    if name == "." || name == ".." {
        bail!("remote file name {name:?} is a directory entry, not a file name");
    }
    if name.contains('/') {
        bail!(
            "remote file name {name:?} contains a path separator (expected a plain file name, \
             e.g. \"notes.txt\" — the destination directory is Houston's, not the caller's)"
        );
    }
    if let Some(c) = name.chars().find(|c| c.is_control()) {
        bail!(
            "remote file name {name:?} contains a control character ({:?}) (expected a plain \
             file name with no newlines or control codes)",
            c
        );
    }
    if name.len() > 255 {
        bail!(
            "remote file name {name:?} is {} bytes, over the 255-byte limit most filesystems \
             enforce on a single name",
            name.len()
        );
    }
    Ok(name)
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn upload_command(name: &str) -> String {
    let quoted = shell_single_quote(name);
    format!(
        "d=\"$HOME/{UPLOAD_REMOTE_DIR}\"; mkdir -p \"$d\" || exit 1; b={quoted}; p=\"$d/$b\"; \
         n=1; while [ -e \"$p\" ]; do p=\"$d/$b.$n\"; n=$((n+1)); done; \
         cat > \"$p\" && printf '%s\\n' \"$p\""
    )
}

async fn upload_file(
    session: &Handle<Client>,
    local_path: &std::path::Path,
    remote_name: &str,
) -> Result<UploadOutcome> {
    let mut file = tokio::fs::File::open(local_path)
        .await
        .with_context(|| format!("opening {} to upload", local_path.display()))?;
    let size = file
        .metadata()
        .await
        .with_context(|| format!("reading the size of {}", local_path.display()))?
        .len();
    if size > UPLOAD_MAX_BYTES {
        bail!(
            "{} is {size} bytes, over the {UPLOAD_MAX_BYTES}-byte upload limit \
             ({} MiB, no progress reporting exists yet to justify a bigger one)",
            local_path.display(),
            UPLOAD_MAX_BYTES / (1024 * 1024)
        );
    }

    let channel = session
        .channel_open_session()
        .await
        .context("opening an ssh channel for the upload")?;
    channel
        .exec(true, upload_command(remote_name))
        .await
        .context("starting the remote receiver for the upload")?;

    use tokio::io::AsyncReadExt;
    let mut buf = vec![0u8; UPLOAD_CHUNK_BYTES];
    let mut sent: u64 = 0;
    loop {
        let n = file
            .read(&mut buf)
            .await
            .with_context(|| format!("reading {}", local_path.display()))?;
        if n == 0 {
            break;
        }
        channel
            .data(&buf[..n])
            .await
            .with_context(|| format!("sending {} to the remote host", local_path.display()))?;
        sent += n as u64;
    }
    channel.eof().await.context("closing the upload stream")?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit: Option<u32> = None;
    let mut channel = channel;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }

    let remote_path = String::from_utf8_lossy(&stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
    match exit {
        Some(0) if !remote_path.is_empty() => Ok(UploadOutcome {
            remote_path,
            bytes: sent,
        }),
        Some(0) => bail!(
            "the remote host wrote the file but reported no path (remote stderr: {})",
            if stderr.is_empty() { "none" } else { &stderr }
        ),
        Some(code) => bail!(
            "the remote host refused the upload (exit {code}: {})",
            if stderr.is_empty() {
                "no error output"
            } else {
                &stderr
            }
        ),
        None => bail!(
            "the remote upload ended without an exit status (connection lost mid-transfer \
             after {sent} of {size} bytes)"
        ),
    }
}

impl SshParams {
    pub fn display(&self) -> String {
        if self.port == 22 {
            format!("{}@{}", self.user, self.host)
        } else {
            format!("{}@{}:{}", self.user, self.host, self.port)
        }
    }
}

pub enum HostKeyVerdict {
    Accept,
    Reject,
}

pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub randomart: String,
    pub changed: bool,
    pub previous_fingerprint: Option<String>,
    pub reply: oneshot::Sender<HostKeyVerdict>,
}

struct Client {
    known_hosts: PathBuf,
    host: String,
    port: u16,
    prompt_tx: mpsc::UnboundedSender<HostKeyPrompt>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let known_line = format!(
            "{} {}",
            host_key(&self.host, self.port),
            key.to_openssh().map_err(|_| russh::Error::Inconsistent)?
        );
        let prior = read_known_host(&self.known_hosts, &self.host, self.port);
        match &prior {
            Some(line) if line == &known_line => return Ok(true),
            _ => {}
        }
        let (reply_tx, reply_rx) = oneshot::channel();
        let previous_fingerprint = prior.as_deref().and_then(fingerprint_from_known_host_line);
        let prompt = HostKeyPrompt {
            host: self.host.clone(),
            port: self.port,
            algorithm: key.algorithm().to_string(),
            fingerprint,
            randomart: key
                .fingerprint(HashAlg::Sha256)
                .to_randomart(key.algorithm().as_str()),
            changed: prior.is_some(),
            previous_fingerprint,
            reply: reply_tx,
        };
        if self.prompt_tx.send(prompt).is_err() {
            return Ok(false);
        }
        match tokio::time::timeout(HOST_KEY_ANSWER_TIMEOUT, reply_rx).await {
            Ok(Ok(HostKeyVerdict::Accept)) => {
                if let Err(e) =
                    record_known_host(&self.known_hosts, &self.host, self.port, &known_line)
                {
                    tracing::warn!("recording known host {}: {e}", self.host);
                }
                Ok(true)
            }
            _ => Ok(false),
        }
    }
}

const HOST_KEY_ANSWER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

fn host_key(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

fn read_known_host(path: &PathBuf, host: &str, port: u16) -> Option<String> {
    let key = host_key(host, port);
    let text = std::fs::read_to_string(path).ok()?;
    text.lines()
        .find(|l| l.split_whitespace().next() == Some(key.as_str()))
        .map(|l| l.to_string())
}

fn fingerprint_from_known_host_line(line: &str) -> Option<String> {
    let key_part = line.split_once(' ').map(|(_, rest)| rest)?;
    match PublicKey::from_openssh(key_part) {
        Ok(key) => Some(key.fingerprint(HashAlg::Sha256).to_string()),
        Err(e) => {
            tracing::warn!("parsing previous known_host key {key_part:?}: {e}");
            None
        }
    }
}

fn record_known_host(path: &PathBuf, host: &str, port: u16, line: &str) -> Result<()> {
    let key = host_key(host, port);
    let mut kept: Vec<String> = std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| l.split_whitespace().next() != Some(key.as_str()))
        .map(|l| l.to_string())
        .collect();
    kept.push(line.to_string());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let tmp = path.with_extension(format!("tmp.{}", key.replace(['/', ':', '[', ']'], "_")));
    std::fs::write(&tmp, kept.join("\n") + "\n")
        .with_context(|| format!("writing known_hosts {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("moving {} into place", tmp.display()))?;
    Ok(())
}

pub struct Connected {
    session: Arc<Handle<Client>>,
    channel: russh::Channel<client::Msg>,
    cmds: mpsc::UnboundedReceiver<SshCmd>,
}

pub fn apply_ssh_config(params: &mut SshParams) {
    let Some(path) = crate::ssh_config::default_path() else {
        return;
    };
    let blocks = match crate::ssh_config::load(&path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("reading {} for ssh_config auth: {e}", path.display());
            return;
        }
    };
    let resolved = crate::ssh_config::resolve(&blocks, &params.host);
    if let Some(h) = resolved.hostname {
        params.host = h;
    }
    if params.user.trim().is_empty() {
        if let Some(u) = resolved.user {
            params.user = u;
        }
    }
    if params.port == 22 {
        if let Some(p) = resolved.port {
            params.port = p;
        }
    }
    params.config_identity = resolved.identity_file;
}

pub async fn connect(
    params: &SshParams,
    known_hosts: PathBuf,
    prompt_tx: mpsc::UnboundedSender<HostKeyPrompt>,
) -> Result<(SshHandle, Connected)> {
    let config = Arc::new(client::Config::default());
    let handler = Client {
        known_hosts,
        host: params.host.clone(),
        port: params.port,
        prompt_tx,
    };
    let mut session = client::connect(config, (params.host.as_str(), params.port), handler)
        .await
        .with_context(|| format!("connecting to {}:{}", params.host, params.port))?;

    let ok = match &params.auth {
        proto::SshAuth::Agent => authenticate_agent(&mut session, &params.user).await?,
        proto::SshAuth::IdentityFile {
            path,
            passphrase_profile,
        } => {
            let passphrase = match passphrase_profile.as_deref() {
                Some(profile) => crate::ssh_credentials::load(profile)?,
                None => None,
            };
            let key =
                load_secret_key(path, passphrase.as_ref().map(|s| s.expose())).map_err(|e| {
                    match passphrase_profile.as_deref() {
                        Some(profile) => anyhow!(
                        "loading identity file {path}: {e} (a passphrase is stored for profile \
                         {profile:?} — if the key was re-encrypted, update the stored passphrase)"
                    ),
                        None => anyhow!(
                        "loading identity file {path}: {e} (if this key is encrypted, save its \
                         passphrase on the profile or use the agent)"
                    ),
                    }
                })?;
            let hash = session.best_supported_rsa_hash().await?.flatten();
            let res = session
                .authenticate_publickey(
                    &params.user,
                    russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await?;
            res.success()
        }
        proto::SshAuth::Password { profile } => {
            let secret = crate::ssh_credentials::load(profile)?.ok_or_else(|| {
                anyhow!(
                    "no password is stored for ssh profile {profile:?} — save one in the \
                     connect dialog, or switch that profile to agent auth"
                )
            })?;
            let res = session
                .authenticate_password(&params.user, secret.expose())
                .await?;
            res.success()
        }
        proto::SshAuth::SshConfig => match &params.config_identity {
            Some(path) => {
                let key = load_secret_key(path, None).map_err(|e| {
                    anyhow!(
                        "loading identity file {path} (from ~/.ssh/config): {e} \
                         (encrypted keys need the agent, or a passphrase saved on a profile)"
                    )
                })?;
                let hash = session.best_supported_rsa_hash().await?.flatten();
                let res = session
                    .authenticate_publickey(
                        &params.user,
                        russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await?;
                res.success()
            }
            None => authenticate_agent(&mut session, &params.user).await?,
        },
    };
    if !ok {
        bail!(
            "SSH authentication failed for {}@{} (host key verified, credentials rejected)",
            params.user,
            params.host
        );
    }

    let channel = session
        .channel_open_session()
        .await
        .context("opening ssh session channel")?;
    channel
        .request_pty(
            false,
            "xterm-256color",
            params.cols as u32,
            params.rows as u32,
            0,
            0,
            &[],
        )
        .await
        .context("requesting remote pty")?;
    channel
        .request_shell(true)
        .await
        .context("requesting remote shell")?;

    let (tx, cmds) = mpsc::unbounded_channel();
    Ok((
        SshHandle { tx },
        Connected {
            session: Arc::new(session),
            channel,
            cmds,
        },
    ))
}

async fn authenticate_agent(session: &mut Handle<Client>, user: &str) -> Result<bool> {
    #[cfg(unix)]
    {
        let mut agent = AgentClient::connect_env()
            .await
            .context("connecting to the SSH agent (is SSH_AUTH_SOCK set?)")?;
        let identities = agent
            .request_identities()
            .await
            .context("listing SSH agent identities")?;
        if identities.is_empty() {
            bail!("the SSH agent has no identities loaded (ssh-add your key first)");
        }
        let hash = session.best_supported_rsa_hash().await?.flatten();
        for id in identities {
            let key = id.public_key().into_owned();
            match session
                .authenticate_publickey_with(user, key, hash, &mut agent)
                .await
            {
                Ok(res) if res.success() => return Ok(true),
                Ok(_) => continue,
                Err(e) => tracing::debug!("agent identity rejected: {e}"),
            }
        }
        Ok(false)
    }
    #[cfg(not(unix))]
    {
        let _ = (session, user);
        bail!(
            "SSH-agent authentication is not supported on this platform (the \
             SSH_AUTH_SOCK transport does not exist here); use password or \
             key-file auth"
        )
    }
}

pub struct SshOutcome {
    pub exit_code: Option<i32>,
}

pub async fn run(mut connected: Connected, mut on_output: impl FnMut(&[u8])) -> SshOutcome {
    let mut exit_code: Option<i32> = None;
    loop {
        tokio::select! {
            msg = connected.channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) => on_output(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => on_output(&data),
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status as i32);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
            cmd = connected.cmds.recv() => match cmd {
                Some(SshCmd::Data(bytes)) => {
                    if connected.channel.data(&bytes[..]).await.is_err() {
                        break;
                    }
                }
                Some(SshCmd::Resize { cols, rows }) => {
                    let _ = connected
                        .channel
                        .window_change(cols as u32, rows as u32, 0, 0)
                        .await;
                }
                Some(SshCmd::Upload { local_path, remote_name, reply }) => {
                    let session = Arc::clone(&connected.session);
                    tokio::spawn(async move {
                        let out = upload_file(&session, &local_path, &remote_name)
                            .await
                            .map_err(|e| format!("{e:#}"));
                        if reply.send(out).is_err() {
                            tracing::debug!(
                                "ssh upload of {} finished with nobody listening",
                                local_path.display()
                            );
                        }
                    });
                }
                Some(SshCmd::Close) | None => {
                    let _ = connected.channel.close().await;
                    break;
                }
            },
        }
    }
    let _ = connected
        .session
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
    SshOutcome { exit_code }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_uses_bracketed_form_only_off_default_port() {
        assert_eq!(host_key("example.com", 22), "example.com");
        assert_eq!(host_key("example.com", 2222), "[example.com]:2222");
    }

    #[test]
    fn known_hosts_records_and_replaces_a_changed_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");

        assert!(read_known_host(&path, "h1", 22).is_none());

        record_known_host(&path, "h1", 22, "h1 ssh-ed25519 AAAA1").unwrap();
        record_known_host(&path, "h2", 2222, "[h2]:2222 ssh-ed25519 AAAA2").unwrap();
        assert_eq!(
            read_known_host(&path, "h1", 22).unwrap(),
            "h1 ssh-ed25519 AAAA1"
        );
        assert_eq!(
            read_known_host(&path, "h2", 2222).unwrap(),
            "[h2]:2222 ssh-ed25519 AAAA2"
        );

        record_known_host(&path, "h1", 22, "h1 ssh-ed25519 BBBB").unwrap();
        assert_eq!(
            read_known_host(&path, "h1", 22).unwrap(),
            "h1 ssh-ed25519 BBBB"
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text.matches("h1 ssh-ed25519").count(),
            1,
            "no stale line: {text}"
        );
        assert!(read_known_host(&path, "h2", 2222).is_some(), "h2 survives");
    }

    #[test]
    fn previous_fingerprint_parses_a_well_formed_line_and_fails_soft_on_a_bad_one() {
        let line =
            "h1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
        let fp = fingerprint_from_known_host_line(line).expect("well-formed line parses");
        assert!(
            fp.starts_with("SHA256:"),
            "unexpected fingerprint shape: {fp}"
        );

        assert!(fingerprint_from_known_host_line("h1 not-a-real-key").is_none());
        assert!(fingerprint_from_known_host_line("no-space-at-all").is_none());
    }

    #[test]
    fn display_elides_the_default_port() {
        let agent = proto::SshAuth::Agent;
        let p = |port| SshParams {
            host: "host".into(),
            port,
            user: "u".into(),
            auth: agent.clone(),
            cols: 80,
            rows: 24,
            config_identity: None,
        };
        assert_eq!(p(22).display(), "u@host");
        assert_eq!(p(2200).display(), "u@host:2200");
    }

    fn profile(default_dir: Option<&str>, startup_cmd: Option<&str>) -> proto::SshProfile {
        proto::SshProfile {
            name: "p".into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            auth: proto::SshAuth::Agent,
            default_dir: default_dir.map(str::to_string),
            startup_cmd: startup_cmd.map(str::to_string),
            last_used_at: None,
            has_credential: false,
        }
    }

    #[test]
    fn sends_nothing_for_a_profile_with_neither() {
        assert!(post_connect_lines(&profile(None, None)).is_empty());
        assert!(post_connect_lines(&profile(Some("   "), Some("\t"))).is_empty());
    }

    #[test]
    fn cds_then_runs_in_that_order() {
        let lines = post_connect_lines(&profile(Some("/srv/app"), Some("tmux attach")));
        assert_eq!(lines, vec!["cd '/srv/app'\n", "tmux attach\n"]);
    }

    #[test]
    fn quotes_a_directory_so_it_cannot_become_a_second_command() {
        let lines = post_connect_lines(&profile(Some("/tmp/a b; touch marker"), None));
        assert_eq!(lines, vec!["cd '/tmp/a b; touch marker'\n"]);

        let lines = post_connect_lines(&profile(Some("/tmp/it's"), None));
        assert_eq!(lines, vec!["cd '/tmp/it'\\''s'\n"]);
    }

    #[test]
    fn remote_name_defaults_to_the_local_file_name() {
        let p = std::path::Path::new("/home/dev/notes.txt");
        assert_eq!(upload_remote_name(p, None).unwrap(), "notes.txt");
        assert_eq!(
            upload_remote_name(p, Some("other.txt")).unwrap(),
            "other.txt"
        );
    }

    #[test]
    fn remote_name_refuses_a_path_instead_of_flattening_it() {
        let p = std::path::Path::new("/tmp/x");
        let e = upload_remote_name(p, Some("../../.ssh/authorized_keys")).unwrap_err();
        let msg = format!("{e}");
        assert!(msg.contains("path separator"), "{msg}");
        assert!(msg.contains("authorized_keys"), "names the offender: {msg}");

        assert!(upload_remote_name(p, Some("")).is_err());
        assert!(upload_remote_name(p, Some("..")).is_err());
        assert!(upload_remote_name(p, Some("a\nb")).is_err(), "newline");
        assert!(
            upload_remote_name(p, Some(&"x".repeat(256))).is_err(),
            "255 bytes"
        );
        assert_eq!(
            upload_remote_name(p, Some("relatório final.pdf")).unwrap(),
            "relatório final.pdf"
        );
    }

    #[test]
    fn upload_command_quotes_the_name_so_it_stays_data() {
        let cmd = upload_command("a b; touch marker.txt");
        assert!(cmd.contains("b='a b; touch marker.txt'"), "{cmd}");
        let cmd = upload_command("it's $(whoami).txt");
        assert!(cmd.contains(r"b='it'\''s $(whoami).txt'"), "{cmd}");
    }

    #[test]
    fn upload_command_never_clobbers_and_reports_its_path() {
        let cmd = upload_command("notes.txt");
        assert!(cmd.contains("mkdir -p \"$d\""), "{cmd}");
        assert!(cmd.contains("while [ -e \"$p\" ]"), "{cmd}");
        assert!(
            cmd.contains("cat > \"$p\" && printf '%s\\n' \"$p\""),
            "{cmd}"
        );
    }

    #[test]
    fn leaves_the_startup_command_unquoted_on_purpose() {
        let lines = post_connect_lines(&profile(None, Some("source .venv/bin/activate && cd src")));
        assert_eq!(lines, vec!["source .venv/bin/activate && cd src\n"]);
    }
}
