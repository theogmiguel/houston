//! Hermetic PTY agent fixture. Only integration tests launch this binary.
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
struct Script {
    provider: String,
    seed: u64,
    home: PathBuf,
    helper: PathBuf,
    fixtures: PathBuf,
    log: PathBuf,
    steps: Vec<Value>,
}

struct Agent {
    script: Script,
    started: Instant,
    random: u64,
    slow_hooks: u64,
    ignore_stop: bool,
    children: Vec<u32>,
    prompt_text: Option<String>,
    prompt_sequence: u64,
}

impl Agent {
    fn log(&self, event: &str, data: Value) -> Result<()> {
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.script.log)?;
        let record = format!(
            "{}\n",
            json!({"us": self.started.elapsed().as_micros(), "seed": self.script.seed, "event":event, "data":data})
        );
        log.write_all(record.as_bytes())?;
        Ok(())
    }

    fn hook(&self, event: &str, fixture: &str) -> Result<()> {
        if self.ignore_stop && matches!(event, "Stop" | "stop" | "session.idle") {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(self.slow_hooks));
        let mut payload: Value = serde_json::from_slice(&std::fs::read(
            self.script
                .fixtures
                .join(&self.script.provider)
                .join(fixture),
        )?)?;
        if let Some(text) = &self.prompt_text {
            if let Some(prompt) = payload.get_mut("prompt") {
                *prompt = json!(text);
            }
        }
        for key in ["prompt_id", "turn_id"] {
            if let Some(id) = payload.get_mut(key) {
                *id = json!(uuid::Uuid::from_u128(
                    (u128::from(self.script.seed) << 64) | u128::from(self.prompt_sequence)
                )
                .to_string());
            }
        }
        let payload = serde_json::to_vec(&payload)?;
        let mut process = houston_core::spawn::command(&self.script.helper)
            .args(["hook", event, "--agent", &self.script.provider])
            .env("HOME", &self.script.home)
            .env("HOUSTON_CHANNEL", "chaos")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        process
            .stdin
            .take()
            .context("hook stdin")?
            .write_all(&payload)?;
        let output = process.wait_with_output()?;
        if !output.status.success() {
            bail!(
                "hook {event} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let payload: Value = serde_json::from_slice(&payload)?;
        self.log("hook",json!({"event":event,"fixture":fixture,"prompt":payload.get("prompt"),"stderr":String::from_utf8_lossy(&output.stderr)}))
    }

    fn lifecycle(&self, stage: &str) -> Result<()> {
        let (event, file) = match (self.script.provider.as_str(), stage) {
            ("claude", "start") => ("SessionStart", "claude-2.1.263-01-SessionStart.json"),
            ("claude", "prompt") => (
                "UserPromptSubmit",
                "claude-2.1.263-02-UserPromptSubmit.json",
            ),
            ("claude", "stop") => ("Stop", "claude-2.1.263-07-Stop.json"),
            ("claude", "ask") => (
                "PreToolUse",
                "claude-docs-11-PreToolUse-AskUserQuestion.json",
            ),
            ("claude", "answered") => (
                "PostToolUse",
                "claude-docs-12-PostToolUse-AskUserQuestion.json",
            ),
            ("codex", "start") => ("SessionStart", "codex-0.153.4-01-SessionStart.json"),
            ("codex", "prompt") => ("UserPromptSubmit", "codex-0.153.4-02-UserPromptSubmit.json"),
            ("codex", "stop") => ("Stop", "codex-0.153.4-03-Stop.json"),
            ("codex", "ask") => (
                "PermissionRequest",
                "codex-0.155.1-04-PermissionRequest-Bash.json",
            ),
            ("codex", "answered") => ("PostToolUse", "codex-0.155.1-08-PostToolUse-Bash.json"),
            ("antigravity", "start") => ("SessionStart", "antigravity-1.1.26-01-SessionStart.json"),
            ("antigravity", "prompt") => {
                ("PreInvocation", "antigravity-1.1.26-02-PreInvocation.json")
            }
            ("antigravity", "stop") => ("Stop", "antigravity-1.1.26-03-Stop.json"),
            ("antigravity", "ask") => (
                "PreToolUse",
                "antigravity-1.1.26-04-PreToolUse-ask_question.json",
            ),
            ("antigravity", "answered") => (
                "PostToolUse",
                "antigravity-1.1.26-05-PostToolUse-ask_question.json",
            ),
            ("opencode", "start") => (
                "session.created",
                "opencode-1.18.27-01-session.created.json",
            ),
            ("opencode", "prompt") => (
                "message.updated",
                "opencode-1.18.27-02-message.updated.json",
            ),
            ("opencode", "stop") => ("session.idle", "opencode-1.18.27-03-session.idle.json"),
            ("opencode", "ask") => ("question.asked", "opencode-1.18.31-06-question.asked.json"),
            ("opencode", "answered") => (
                "question.replied",
                "opencode-1.18.31-07-question.replied.json",
            ),
            ("cursor", "start") => ("sessionStart", "cursor-docs-01-sessionStart.json"),
            ("cursor", "prompt") => (
                "beforeSubmitPrompt",
                "cursor-docs-02-beforeSubmitPrompt.json",
            ),
            ("cursor", "stop") => ("stop", "cursor-docs-03-stop.json"),
            ("grok", "start") => ("SessionStart", "grok-docs-01-SessionStart.json"),
            ("grok", "prompt") => ("UserPromptSubmit", "grok-docs-02-UserPromptSubmit.json"),
            ("grok", "stop") => ("Stop", "grok-docs-03-Stop.json"),
            ("grok", "ask") => ("Notification", "grok-docs-04-Notification.json"),
            (provider, stage) => bail!("no fixture for provider {provider:?}, lifecycle {stage:?}"),
        };
        self.hook(event, file)
    }

    fn request(&self, tool: &str, arguments: Value) -> Result<reqwest::blocking::RequestBuilder> {
        let endpoint = std::env::var("HOUSTON_MCP_URL")?;
        let url = reqwest::Url::parse(&endpoint)?;
        if !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            || url.scheme() != "http"
        {
            bail!("fake_agent endpoint {endpoint:?}: expected local HTTP daemon");
        }
        self.log("call", json!({"tool":tool}))?;
        let (wire_tool, arguments) = if self.script.provider == "codex"
            && matches!(
                tool,
                "pane_spawn" | "pane_send_keys" | "pane_prompt" | "pane_kill"
            ) {
            ("call_tool", json!({"name":tool,"args":arguments}))
        } else {
            (tool, arguments)
        };
        Ok(reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(30)).build()?
            .post(url).bearer_auth(std::env::var("HOUSTON_MCP_TOKEN")?)
            .json(&json!({"jsonrpc":"2.0", "id":1, "method":"tools/call", "params":{"name":wire_tool,"arguments":arguments}})))
    }

    fn call(&self, tool: &str, arguments: Value) -> Result<Value> {
        let response: Value = self
            .request(tool, arguments)?
            .send()?
            .error_for_status()?
            .json()?;
        if response.get("error").is_some() || response["result"]["isError"] == true {
            bail!("{tool}: {response}");
        }
        let result = response["result"]["structuredContent"].clone();
        self.log("reply", json!({"tool":tool,"result":result}))?;
        Ok(result)
    }

    fn prompt(&mut self) -> Result<String> {
        print!("\r\nFAKE-COMPOSER> ");
        std::io::stdout().flush()?;
        let text = read_composer()?;
        self.prompt_sequence += 1;
        self.prompt_text = Some(text.clone());
        println!("\r\nFAKE-PROMPT:{text}");
        self.log("prompt", json!({"text":text}))?;
        Ok(text)
    }

    fn run(&mut self) -> Result<()> {
        self.log("start", json!({"provider":self.script.provider}))?;
        self.lifecycle("start")?;
        self.lifecycle("prompt")?;
        println!("FAKE-READY");
        for step in self.script.steps.clone() {
            let op = step["op"].as_str().context("step requires op")?;
            self.log("step", json!({"op":op}))?;
            match op {
                "think" => {
                    // Xorshift fixes the jitter stream independently of the rand crate version.
                    self.random ^= self.random << 13;
                    self.random ^= self.random >> 7;
                    self.random ^= self.random << 17;
                    std::thread::sleep(Duration::from_millis(
                        step["ms"].as_u64().unwrap_or(0) + self.random % 11,
                    ));
                }
                "submit" => {
                    let summary = step["summary"].as_str().context("submit summary")?;
                    let body = format!(
                        "{summary}{}",
                        "x".repeat(step["bytes"].as_u64().unwrap_or(0) as usize)
                    );
                    self.call("pane_submit", json!({"body":body,"summary":summary,"request_id":step["request_id"].as_u64().unwrap_or(1)}))?;
                    self.lifecycle("stop")?;
                }
                "spawn" => {
                    let result = self.call("pane_spawn", step["args"].clone())?;
                    self.children
                        .push(result["session"].as_u64().context("spawn session_id")? as u32);
                }
                "wait_file" => {
                    let path = PathBuf::from(step["path"].as_str().context("wait_file path")?);
                    let deadline = Instant::now() + Duration::from_secs(30);
                    while !path.exists() {
                        if Instant::now() >= deadline {
                            bail!("barrier {} timed out", path.display());
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
                "wait_all" => {
                    for child in &self.children {
                        let result =
                            self.call("pane_wait", json!({"session":child,"timeout_ms":20000}))?;
                        if result["timed_out"] == true {
                            bail!("child {child} timed out");
                        }
                    }
                }
                "call" => {
                    self.call(
                        step["tool"].as_str().context("call tool")?,
                        step["args"].clone(),
                    )?;
                }
                "background_wait" => {
                    let request = self.request("pane_wait", json!({"timeout_ms":20000}))?;
                    let _ = request
                        .timeout(Duration::from_millis(step["ms"].as_u64().unwrap_or(20)))
                        .send();
                    self.log("abandoned_wait", Value::Null)?;
                }
                "wait_prompt" => {
                    self.prompt()?;
                    self.lifecycle("prompt")?;
                }
                "ask" => {
                    println!(
                        "FAKE-QUESTION: {}",
                        step["question"]
                            .as_str()
                            .unwrap_or("May this fixture continue?")
                    );
                    self.lifecycle("ask")?;
                    let turn = self.prompt_sequence;
                    self.prompt()?;
                    self.prompt_sequence = turn;
                    self.lifecycle("answered")?;
                }
                "hook" => {
                    self.hook(
                        step["event"].as_str().context("hook event")?,
                        step["fixture"].as_str().context("hook fixture")?,
                    )?;
                }
                "slow_hooks" => {
                    self.slow_hooks = step["ms"].as_u64().context("slow_hooks ms")?;
                }
                "stop" => {
                    self.lifecycle("stop")?;
                }
                "ignore_stop_hook" => {
                    self.ignore_stop = true;
                }
                "crash" => {
                    #[cfg(unix)]
                    houston_core::pid::signal_process_checked(
                        std::process::id(),
                        houston_core::pid::Signal::Kill,
                    )?;
                    #[cfg(not(unix))]
                    std::process::abort();
                }
                "exit" => {
                    std::process::exit(step["code"].as_i64().unwrap_or(0) as i32);
                }
                "hang" => loop {
                    std::thread::park();
                },
                other => bail!("step {other:?}: expected a scripted fake-agent operation"),
            }
        }
        self.log("done", Value::Null)?;
        loop {
            std::thread::park();
        }
    }
}

fn read_composer() -> Result<String> {
    let mut bytes = Vec::new();
    let mut paste = false;
    loop {
        let mut byte = [0];
        std::io::stdin().read_exact(&mut byte)?;
        bytes.push(byte[0]);
        if bytes.ends_with(b"\x1b[200~") {
            paste = true;
        }
        if bytes.ends_with(b"\x1b[201~") {
            paste = false;
        }
        if !paste && matches!(byte[0], b'\r' | b'\n') {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&bytes)
        .replace("\x1b[200~", "")
        .replace("\x1b[201~", "")
        .trim_end_matches(['\r', '\n'])
        .to_string())
}

fn main() -> Result<()> {
    #[cfg(unix)]
    {
        let _ = houston_core::spawn::command("stty")
            .args(["raw", "-echo"])
            .status();
    }
    let args: Vec<String> = std::env::args().collect();
    let mut input = args.join(" ");
    if !input.contains("@fake:") {
        input = read_composer()?;
    }
    let path = input
        .split_once("@fake:")
        .context("script marker")?
        .1
        .split_whitespace()
        .next()
        .context("script path")?;
    let script: Script = serde_json::from_slice(&std::fs::read(path)?)?;
    let random = script.seed.max(1);
    let mut agent = Agent {
        script,
        random,
        started: Instant::now(),
        slow_hooks: 0,
        ignore_stop: false,
        children: Vec::new(),
        prompt_text: Some(format!("@fake:{path}")),
        prompt_sequence: 0,
    };
    if let Err(error) = agent.run() {
        agent.log("error", json!({"message":format!("{error:#}")}))?;
        return Err(error);
    }
    Ok(())
}
