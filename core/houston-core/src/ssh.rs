use crate::daemon::StdinWriteError;
use anyhow::{anyhow, bail, Context, Result};
use russh::client::{self, Handle};
#[cfg(unix)]
use russh::keys::agent::client::AgentClient;
use russh::keys::{load_secret_key, HashAlg, PublicKey};
use russh::ChannelMsg;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, watch, Semaphore};

use houston_protocol as proto;

// Supports agent, identity-file, password and `~/.ssh/config`-resolved
// auth; TOFU host-key verification against `~/.houston/known_hosts`; no
// auto-reconnect.

pub enum SshCmd {
    Data {
        bytes: Vec<u8>,
        reply: std::sync::mpsc::Sender<std::result::Result<(), StdinWriteError>>,
        _budget: tokio::sync::OwnedSemaphorePermit,
    },
    Upload {
        local_path: PathBuf,
        remote_name: String,
        reply: oneshot::Sender<Result<UploadOutcome, String>>,
        _slot: tokio::sync::OwnedSemaphorePermit,
    },
}

pub struct UploadOutcome {
    pub remote_path: String,
    pub bytes: u64,
}

// Includes active transfer bytes and bounds tiny writes and upload requests separately.
const SSH_INPUT_BYTES: usize = 4 * 1024 * 1024;
const SSH_INPUT_ITEMS: usize = 128;
const SSH_UPLOADS: usize = 4;
// Closing must complete locally even when the peer never acknowledges channel teardown.
const SSH_CLOSE_WAIT: std::time::Duration = std::time::Duration::from_millis(200);

pub type SshWriteReceipt = std::sync::mpsc::Receiver<std::result::Result<(), StdinWriteError>>;
type SshQueue = (
    SshHandle,
    mpsc::Receiver<SshCmd>,
    watch::Receiver<bool>,
    watch::Receiver<(u16, u16)>,
);

pub struct SshHandle {
    tx: mpsc::Sender<SshCmd>,
    bytes: Arc<Semaphore>,
    transferring: Arc<std::sync::atomic::AtomicBool>,
    uploads: Arc<Semaphore>,
    cancel: watch::Sender<bool>,
    resize: watch::Sender<(u16, u16)>,
}

impl SshHandle {
    fn queue(cols: u16, rows: u16) -> SshQueue {
        let (tx, rx) = mpsc::channel(SSH_INPUT_ITEMS);
        let (cancel, cancelled) = watch::channel(false);
        let (resize, resized) = watch::channel((cols, rows));
        (
            Self {
                tx,
                bytes: Arc::new(Semaphore::new(SSH_INPUT_BYTES)),
                transferring: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                uploads: Arc::new(Semaphore::new(SSH_UPLOADS)),
                cancel,
                resize,
            },
            rx,
            cancelled,
            resized,
        )
    }

    #[cfg(all(test, unix))]
    pub(crate) fn stub() -> Self {
        Self::queue(80, 24).0
    }

    pub fn enqueue_stdin(
        &self,
        data: &[u8],
    ) -> std::result::Result<SshWriteReceipt, StdinWriteError> {
        let refusal = |error| StdinWriteError {
            written: Some(0),
            error,
        };
        if *self.cancel.borrow() || self.tx.is_closed() {
            return Err(refusal(anyhow!(
                "SSH input refused: session driver is stopping"
            )));
        }
        let budget = u32::try_from(data.len().max(1))
            .ok()
            .and_then(|size| Arc::clone(&self.bytes).try_acquire_many_owned(size).ok())
            .ok_or_else(|| {
                refusal(anyhow!(
                    "SSH input byte limit {SSH_INPUT_BYTES}, actual {}, requested {} bytes",
                    SSH_INPUT_BYTES - self.bytes.available_permits(),
                    data.len()
                ))
            })?;
        let (reply, receipt) = std::sync::mpsc::channel();
        self.tx.try_send(SshCmd::Data { bytes: data.to_vec(), reply, _budget: budget }).map_err(|_| refusal(anyhow!(
            "SSH input item limit {SSH_INPUT_ITEMS}, actual {}, requested 1 item; queue full or driver stopped",
            SSH_INPUT_ITEMS - self.tx.capacity()
        )))?;
        Ok(receipt)
    }

    #[cfg(feature = "test-barriers")]
    #[doc(hidden)]
    pub fn transfer_active_for_test(&self) -> bool {
        self.transferring.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn write_stdin(&self, data: &[u8]) -> std::result::Result<(), StdinWriteError> {
        self.enqueue_stdin(data)?.recv().unwrap_or_else(|_| {
            Err(StdinWriteError {
                written: None,
                error: anyhow!(
                    "SSH driver stopped before delivery receipt; partial delivery is unknown"
                ),
            })
        })
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if *self.cancel.borrow() {
            bail!("SSH resize refused: driver is stopping");
        }
        self.resize
            .send((cols, rows))
            .map_err(|_| anyhow!("SSH session driver has stopped"))
    }

    pub fn kill(&self) -> Result<()> {
        self.cancel.send_replace(true);
        Ok(())
    }

    pub fn upload(
        &self,
        local_path: PathBuf,
        remote_name: String,
    ) -> Result<oneshot::Receiver<Result<UploadOutcome, String>>> {
        if *self.cancel.borrow() {
            bail!("SSH upload refused: driver is stopping");
        }
        let slot = Arc::clone(&self.uploads).try_acquire_owned().map_err(|_| {
            anyhow!(
                "SSH upload limit {SSH_UPLOADS}, actual {}, requested 1 upload",
                SSH_UPLOADS - self.uploads.available_permits()
            )
        })?;
        let (reply, rx) = oneshot::channel();
        self.tx
            .try_send(SshCmd::Upload {
                local_path,
                remote_name,
                reply,
                _slot: slot,
            })
            .map_err(|_| {
                anyhow!(
                    "SSH command item limit {SSH_INPUT_ITEMS}, actual {}, requested 1 upload item; queue full or driver stopped",
                    SSH_INPUT_ITEMS - self.tx.capacity()
                )
            })?;
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
    pub default_dir: Option<String>,
}

/// The path is quoted while a leading ~/ expands through the remote HOME;
/// the startup command is deliberately NOT quoted — the
/// user typed it to run on their own machine, and quoting would break it.
pub fn post_connect_lines(p: &proto::SshProfile) -> Vec<String> {
    let mut out = Vec::new();
    out.extend(post_connect_directory(p.default_dir.as_deref()));
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

pub fn post_connect_directory(dir: Option<&str>) -> Vec<String> {
    dir.map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(directory_line)
        .into_iter()
        .collect()
}

fn directory_line(dir: &str) -> String {
    let quote = |s: &str| s.replace('\'', "'\\''");
    if dir == "~" {
        "cd -- \"$HOME\"\n".into()
    } else if let Some(rest) = dir.strip_prefix("~/") {
        format!("cd -- \"$HOME\"/'{}'\n", quote(rest))
    } else {
        format!("cd -- '{}'\n", quote(dir))
    }
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
    cmds: mpsc::Receiver<SshCmd>,
    cancel: watch::Receiver<bool>,
    transferring: Arc<std::sync::atomic::AtomicBool>,
    resize: watch::Receiver<(u16, u16)>,
}

pub fn apply_ssh_config(params: &mut SshParams) {
    let blocks = crate::ssh_config::default_path()
        .and_then(|path| match crate::ssh_config::load(&path) {
            Ok(blocks) => Some(blocks),
            Err(e) => {
                tracing::warn!("reading {} for SSH connection: {e}", path.display());
                None
            }
        })
        .unwrap_or_default();
    apply_host_config(params, crate::ssh_config::resolve(&blocks, &params.host));
}

fn apply_host_config(params: &mut SshParams, resolved: crate::ssh_config::HostConfig) {
    if let Some(host) = resolved.hostname {
        params.host = host;
    }
    if params.user.trim().is_empty() {
        params.user = resolved.user.or_else(local_username).unwrap_or_default();
    }
    if params.port == 22 {
        params.port = resolved.port.unwrap_or(22);
    }
    params.config_identity = resolved.identity_file;
}

fn local_username() -> Option<String> {
    #[cfg(unix)]
    {
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        // NSS may need more than the POSIX suggested size; grow only on ERANGE.
        let suggested = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
        // Bound NSS scratch space without assuming a short local passwd record.
        const MAX_NSS_BYTES: usize = 1024 * 1024;
        let initial = usize::try_from(suggested)
            .ok()
            .filter(|size| (1..=MAX_NSS_BYTES).contains(size))
            .unwrap_or(16 * 1024);
        let mut buffer = vec![0u8; initial];
        loop {
            let status = unsafe {
                libc::getpwuid_r(
                    libc::getuid(),
                    entry.as_mut_ptr(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut result,
                )
            };
            if status == libc::ERANGE && buffer.len() <= MAX_NSS_BYTES / 2 {
                buffer.resize(buffer.len() * 2, 0);
                continue;
            }
            if status == 0 && !result.is_null() {
                let entry = unsafe { entry.assume_init() };
                return Some(
                    unsafe { std::ffi::CStr::from_ptr(entry.pw_name) }
                        .to_string_lossy()
                        .into_owned(),
                );
            }
            break;
        }
    }
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .filter(|user| !user.trim().is_empty())
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

    let (handle, cmds, cancel, resize) = SshHandle::queue(params.cols, params.rows);
    let transferring = Arc::clone(&handle.transferring);
    Ok((
        handle,
        Connected {
            session: Arc::new(session),
            channel,
            cmds,
            cancel,
            transferring,
            resize,
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

pub async fn run(connected: Connected, mut on_output: impl FnMut(&[u8])) -> SshOutcome {
    let Connected {
        session,
        channel,
        mut cmds,
        mut cancel,
        transferring,
        mut resize,
    } = connected;
    let (mut reader, writer) = channel.split();
    let mut exit_code = None;
    let mut uploads = tokio::task::JoinSet::new();
    let (upload_stop, upload_cancel) = watch::channel(false);
    'driver: loop {
        if *cancel.borrow() {
            break;
        }
        tokio::select! {
            biased;
            _ = cancel.changed() => break,
            Some(_) = uploads.join_next(), if !uploads.is_empty() => {},
            msg = reader.wait() => {
                if !ssh_output(msg, &mut on_output, &mut exit_code) { break; }
            },
            changed = resize.changed() => {
                if changed.is_err() { break; }
                let (cols, rows) = *resize.borrow_and_update();
                tokio::select! {
                    _ = cancel.changed() => break,
                    _ = writer.window_change(cols as u32, rows as u32, 0, 0) => {},
                }
            },
            cmd = cmds.recv() => match cmd {
                Some(SshCmd::Data { bytes, reply, _budget }) => {
                    transferring.store(true, std::sync::atomic::Ordering::Release);
                    let delivery = writer.data(&bytes[..]);
                    tokio::pin!(delivery);
                    let result = loop {
                        tokio::select! {
                            biased;
                            _ = cancel.changed() => break Err(StdinWriteError { written: None, error: anyhow!("SSH transfer cancelled; partial delivery is unknown") }),
                            result = &mut delivery => break result.map_err(|error| StdinWriteError { written: None, error: anyhow!(error).context("SSH transfer failed; partial delivery is unknown") }),
                            msg = reader.wait() => {
                                if !ssh_output(msg, &mut on_output, &mut exit_code) {
                                    break Err(StdinWriteError { written: None, error: anyhow!("SSH channel closed during delivery; partial delivery is unknown") });
                                }
                            },
                            changed = resize.changed() => {
                                if changed.is_err() { break Err(StdinWriteError { written: None, error: anyhow!("SSH handle dropped during delivery") }); }
                                let (cols, rows) = *resize.borrow_and_update();
                                tokio::select! {
                                    _ = cancel.changed() => break Err(StdinWriteError { written: None, error: anyhow!("SSH transfer cancelled; partial delivery is unknown") }),
                                    _ = writer.window_change(cols as u32, rows as u32, 0, 0) => {},
                                }
                            }
                        }
                    };
                    transferring.store(false, std::sync::atomic::Ordering::Release);
                    let stopped = result.is_err();
                    let _ = reply.send(result);
                    drop(_budget);
                    if stopped { break 'driver; }
                },
                Some(SshCmd::Upload { local_path, remote_name, reply, _slot }) => {
                    let session = Arc::clone(&session);
                    let mut cancel = upload_cancel.clone();
                    uploads.spawn(async move {
                        let _slot = _slot;
                        let out = tokio::select! {
                            biased;
                            _ = cancel.changed() => Err("SSH upload cancelled; a partial remote file may remain".into()),
                            out = upload_file(&session, &local_path, &remote_name) => out.map_err(|error| format!("{error:#}; a partial remote file may remain")),
                        };
                        let _ = reply.send(out);
                    });
                },
                None => break,
            }
        }
    }
    cmds.close();
    while let Some(cmd) = cmds.recv().await {
        match cmd {
            SshCmd::Data { reply, .. } => {
                let _ = reply.send(Err(StdinWriteError {
                    written: Some(0),
                    error: anyhow!("SSH queued input cancelled before transfer"),
                }));
            }
            SshCmd::Upload { reply, .. } => {
                let _ = reply.send(Err("SSH queued upload cancelled before transfer".into()));
            }
        }
    }
    upload_stop.send_replace(true);
    while uploads.join_next().await.is_some() {}
    let _ = tokio::time::timeout(SSH_CLOSE_WAIT, writer.close()).await;
    let _ = tokio::time::timeout(
        SSH_CLOSE_WAIT,
        session.disconnect(russh::Disconnect::ByApplication, "", ""),
    )
    .await;
    SshOutcome { exit_code }
}

fn ssh_output(
    msg: Option<ChannelMsg>,
    on_output: &mut impl FnMut(&[u8]),
    exit_code: &mut Option<i32>,
) -> bool {
    match msg {
        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
            on_output(&data)
        }
        Some(ChannelMsg::ExitStatus { exit_status }) => *exit_code = Some(exit_status as i32),
        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => return false,
        Some(_) => {}
    }
    true
}

#[cfg(feature = "test-barriers")]
#[doc(hidden)]
pub async fn connect_stream_for_test(
    stream: tokio::io::DuplexStream,
    known_hosts: PathBuf,
) -> Result<(SshHandle, Connected)> {
    let (prompt_tx, _prompts) = mpsc::unbounded_channel();
    let mut session = client::connect_stream(
        Arc::new(client::Config::default()),
        stream,
        Client {
            known_hosts,
            host: "fixture".into(),
            port: 22,
            prompt_tx,
        },
    )
    .await?;
    anyhow::ensure!(
        session
            .authenticate_password("fixture", "fixture")
            .await?
            .success(),
        "fixture authentication refused"
    );
    let channel = session.channel_open_session().await?;
    channel.request_shell(true).await?;
    anyhow::ensure!(
        channel.writable_packet_size().await == 0,
        "fixture requires an initial zero receive window"
    );
    let (handle, cmds, cancel, resize) = SshHandle::queue(80, 24);
    let transferring = Arc::clone(&handle.transferring);
    Ok((
        handle,
        Connected {
            session: Arc::new(session),
            channel,
            cmds,
            cancel,
            transferring,
            resize,
        },
    ))
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
            default_dir: None,
        };
        assert_eq!(p(22).display(), "u@host");
        assert_eq!(p(2200).display(), "u@host:2200");
    }

    #[test]
    fn k8_remote_home_expands_without_evaluating_path_text() {
        assert_eq!(post_connect_directory(Some("~")), vec!["cd -- \"$HOME\"\n"]);
        assert_eq!(
            post_connect_directory(Some("~/a $(touch bad)")),
            vec!["cd -- \"$HOME\"/'a $(touch bad)'\n"]
        );
    }

    #[test]
    fn k8_selected_key_resolves_alias_and_empty_user_uses_local_account() {
        let blocks = crate::ssh_config::parse(
            "Host target\n HostName 127.0.0.1\n Port 2222\nHost *\n User deploy\n Port 3333\n",
        );
        let mut params = SshParams {
            host: "target".into(),
            port: 22,
            user: String::new(),
            auth: proto::SshAuth::IdentityFile {
                path: "/chosen/key".into(),
                passphrase_profile: None,
            },
            cols: 80,
            rows: 24,
            config_identity: None,
            default_dir: None,
        };
        apply_host_config(&mut params, crate::ssh_config::resolve(&blocks, "target"));
        assert_eq!(
            (&*params.host, params.port, &*params.user),
            ("127.0.0.1", 2222, "deploy")
        );
        assert!(
            matches!(params.auth, proto::SshAuth::IdentityFile { ref path, .. } if path == "/chosen/key")
        );
        params.user.clear();
        apply_host_config(&mut params, crate::ssh_config::HostConfig::default());
        assert_eq!(Some(params.user.clone()), local_username());
        assert!(!params.user.is_empty());
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
        assert_eq!(lines, vec!["cd -- '/srv/app'\n", "tmux attach\n"]);
    }

    #[test]
    fn quotes_a_directory_so_it_cannot_become_a_second_command() {
        let lines = post_connect_lines(&profile(Some("/tmp/a b; touch marker"), None));
        assert_eq!(lines, vec!["cd -- '/tmp/a b; touch marker'\n"]);

        let lines = post_connect_lines(&profile(Some("/tmp/it's"), None));
        assert_eq!(lines, vec!["cd -- '/tmp/it'\\''s'\n"]);
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
