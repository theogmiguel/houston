use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const SKILLS_CAP: usize = 200;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub agent: String,
    pub name: String,
    pub description: String,
    pub invoke: String,
    pub source: String,
    pub path: String,
}

fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    if !text.starts_with("---") {
        return (None, None);
    }
    let Some(rest) = text.get(3..) else {
        return (None, None);
    };
    let Some(end) = rest.find("\n---") else {
        return (None, None);
    };
    let block = &rest[..end];
    (
        grab_frontmatter_key(block, "name"),
        grab_frontmatter_key(block, "description"),
    )
}

fn grab_frontmatter_key(block: &str, key: &str) -> Option<String> {
    static NAME_RE: OnceLock<Regex> = OnceLock::new();
    static DESCRIPTION_RE: OnceLock<Regex> = OnceLock::new();
    let re = match key {
        "name" => NAME_RE.get_or_init(|| Regex::new(r"(?m)^name:\s*(.+)$").unwrap()),
        "description" => {
            DESCRIPTION_RE.get_or_init(|| Regex::new(r"(?m)^description:\s*(.+)$").unwrap())
        }
        _ => unreachable!(
            "grab_frontmatter_key is only ever called with \"name\" or \"description\""
        ),
    };
    re.captures(block)
        .map(|c| strip_matching_quotes(c[1].trim()))
}

fn strip_matching_quotes(s: &str) -> String {
    let mut chars: Vec<char> = s.chars().collect();
    if matches!(chars.first(), Some('\'') | Some('"')) {
        chars.remove(0);
    }
    if matches!(chars.last(), Some('\'') | Some('"')) {
        chars.pop();
    }
    chars.into_iter().collect()
}

async fn md_entries(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(mut read_dir) = tokio::fs::read_dir(root).await else {
        return out;
    };
    loop {
        let entry = match read_dir.next_entry().await {
            Ok(Some(e)) => e,
            Ok(None) => break,
            Err(_) => break,
        };
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_file() {
            if let Some(stem) = name.strip_suffix(".md") {
                out.push((stem.to_string(), entry.path()));
            }
        } else if file_type.is_dir() {
            let Ok(mut sub_read) = tokio::fs::read_dir(entry.path()).await else {
                continue;
            };
            loop {
                let sub_entry = match sub_read.next_entry().await {
                    Ok(Some(e)) => e,
                    Ok(None) => break,
                    Err(_) => break,
                };
                let sub_name = sub_entry.file_name().to_string_lossy().into_owned();
                if let Some(stem) = sub_name.strip_suffix(".md") {
                    out.push((format!("{name}:{stem}"), sub_entry.path()));
                }
            }
        }
    }
    out
}

async fn claude_skills(base: &Path, source: &str) -> Vec<Skill> {
    let mut out = Vec::new();
    let skills_dir = base.join("skills");
    if let Ok(mut read_dir) = tokio::fs::read_dir(&skills_dir).await {
        loop {
            let entry = match read_dir.next_entry().await {
                Ok(Some(e)) => e,
                Ok(None) => break,
                Err(_) => break,
            };
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().into_owned();
            let skill_md = skills_dir.join(&dir_name).join("SKILL.md");
            let Ok(text) = tokio::fs::read_to_string(&skill_md).await else {
                continue;
            };
            let (fm_name, fm_description) = parse_frontmatter(&text);
            let name = fm_name.unwrap_or_else(|| dir_name.clone());
            out.push(Skill {
                agent: "claude".to_string(),
                name: name.clone(),
                description: fm_description.unwrap_or_default(),
                invoke: format!("/{name}"),
                source: source.to_string(),
                path: skill_md.to_string_lossy().into_owned(),
            });
        }
    }

    for (name, file) in md_entries(&base.join("commands")).await {
        let description = match tokio::fs::read_to_string(&file).await {
            Ok(text) => parse_frontmatter(&text).1.unwrap_or_default(),
            Err(_) => String::new(),
        };
        out.push(Skill {
            agent: "claude".to_string(),
            name: name.clone(),
            description,
            invoke: format!("/{name}"),
            source: source.to_string(),
            path: file.to_string_lossy().into_owned(),
        });
    }
    out
}

async fn codex_skills(prompts_dir: &Path) -> Vec<Skill> {
    md_entries(prompts_dir)
        .await
        .into_iter()
        .map(|(name, file)| Skill {
            agent: "codex".to_string(),
            name: name.clone(),
            description: String::new(),
            invoke: format!("/{name}"),
            source: "user".to_string(),
            path: file.to_string_lossy().into_owned(),
        })
        .collect()
}

fn extract_gemini_description(text: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"(?m)^description\s*=\s*"(.*?)""#).unwrap());
    re.captures(text).map(|c| c[1].to_string())
}

fn gemini_walk<'a>(
    dir: PathBuf,
    ns: String,
    out: &'a mut Vec<Skill>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ()>> + Send + 'a>> {
    Box::pin(async move {
        let mut entries = Vec::new();
        let mut read_dir = tokio::fs::read_dir(&dir).await.map_err(|_| ())?;
        loop {
            match read_dir.next_entry().await {
                Ok(Some(e)) => entries.push(e),
                Ok(None) => break,
                Err(_) => return Err(()),
            }
        }
        for entry in entries {
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            let entry_name = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_dir() {
                let child_ns = if ns.is_empty() {
                    entry_name.clone()
                } else {
                    format!("{ns}:{entry_name}")
                };
                gemini_walk(entry.path(), child_ns, out).await?;
            } else if let Some(stem) = entry_name.strip_suffix(".toml") {
                let name = if ns.is_empty() {
                    stem.to_string()
                } else {
                    format!("{ns}:{stem}")
                };
                let path = entry.path();
                let description = match tokio::fs::read_to_string(&path).await {
                    Ok(text) => extract_gemini_description(&text).unwrap_or_default(),
                    Err(_) => String::new(),
                };
                out.push(Skill {
                    agent: "gemini".to_string(),
                    name: name.clone(),
                    description,
                    invoke: format!("/{name}"),
                    source: "user".to_string(),
                    path: path.to_string_lossy().into_owned(),
                });
            }
        }
        Ok(())
    })
}

async fn gemini_skills(commands_root: &Path) -> Vec<Skill> {
    let mut out = Vec::new();
    let _ = gemini_walk(commands_root.to_path_buf(), String::new(), &mut out).await;
    out
}

async fn list_skills_under(home: &Path, project_dir: Option<&Path>) -> Vec<Skill> {
    let user_claude_base = home.join(".claude");
    let project_claude_base = project_dir.map(|dir| dir.join(".claude"));
    let codex_prompts = home.join(".codex").join("prompts");
    let gemini_commands = home.join(".gemini").join("commands");
    let (user_claude, project_claude, codex, gemini) = tokio::join!(
        claude_skills(&user_claude_base, "user"),
        async {
            match &project_claude_base {
                Some(base) => claude_skills(base, "project").await,
                None => Vec::new(),
            }
        },
        codex_skills(&codex_prompts),
        gemini_skills(&gemini_commands),
    );
    let mut out =
        Vec::with_capacity(user_claude.len() + project_claude.len() + codex.len() + gemini.len());
    out.extend(user_claude);
    out.extend(project_claude);
    out.extend(codex);
    out.extend(gemini);
    out.truncate(SKILLS_CAP);
    out
}

#[tauri::command]
pub async fn system_list_skills(project_dir: Option<String>) -> Result<Vec<Skill>, String> {
    let home = houston_core::home_dir::home_dir()
        .ok_or_else(|| "system_list_skills: cannot resolve home directory".to_string())?;
    let project_dir = project_dir.map(PathBuf::from);
    Ok(list_skills_under(&home, project_dir.as_deref()).await)
}

fn skill_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-zA-Z0-9_-]{1,64}$").unwrap())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSkillResult {
    pub ok: bool,
    pub error: Option<String>,
}

impl WriteSkillResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn err(error: String) -> Self {
        Self {
            ok: false,
            error: Some(error),
        }
    }
}

fn escape_gemini_body(content: &str) -> String {
    let step1 = content.replace("\"\"\"", "\\\"\\\"\\\"");
    if let Some(stripped) = step1.strip_suffix('\\') {
        format!("{stripped}\\\\")
    } else {
        step1
    }
}

fn looks_like_toml(content: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*(description|prompt)\s*=").unwrap())
        .is_match(content)
}

async fn write_skill_under(
    provider: &str,
    name: &str,
    content: &str,
    home: &Path,
    project_dir: Option<&Path>,
) -> WriteSkillResult {
    if !skill_name_re().is_match(name) {
        return WriteSkillResult::err(format!(
            "invalid skill name \"{name}\" — use only letters, numbers, \"_\" and \"-\" (1-64 chars)"
        ));
    }
    let result: std::io::Result<()> = async {
        match provider {
            "claude" => {
                let base = match project_dir {
                    Some(dir) => dir.join(".claude"),
                    None => home.join(".claude"),
                };
                let dir = base.join("skills").join(name);
                tokio::fs::create_dir_all(&dir).await?;
                tokio::fs::write(dir.join("SKILL.md"), content).await
            }
            "codex" => {
                let dir = home.join(".codex").join("prompts");
                tokio::fs::create_dir_all(&dir).await?;
                tokio::fs::write(dir.join(format!("{name}.md")), content).await
            }
            _ => {
                let dir = home.join(".gemini").join("commands");
                tokio::fs::create_dir_all(&dir).await?;
                let body = if looks_like_toml(content) {
                    content.to_string()
                } else {
                    format!(
                        "description = \"\"\nprompt = \"\"\"\n{}\n\"\"\"\n",
                        escape_gemini_body(content)
                    )
                };
                tokio::fs::write(dir.join(format!("{name}.toml")), body).await
            }
        }
    }
    .await;
    match result {
        Ok(()) => WriteSkillResult::ok(),
        Err(e) => WriteSkillResult::err(e.to_string()),
    }
}

fn skill_roots(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".claude").join("skills"),
        home.join(".claude").join("commands"),
        home.join(".codex").join("prompts"),
        home.join(".gemini").join("commands"),
    ]
}

async fn is_allowed_skill_path(path: &Path, home: &Path) -> bool {
    let resolved = match tokio::fs::canonicalize(path).await {
        Ok(p) => p,
        Err(_) => return false,
    };
    let resolved_str = resolved.to_string_lossy();
    let sep = std::path::MAIN_SEPARATOR;
    if skill_roots(home)
        .iter()
        .any(|root| resolved_str.starts_with(&format!("{}{sep}", root.to_string_lossy())))
    {
        return true;
    }
    let parts: Vec<&str> = resolved_str.split(sep).collect();
    match parts.iter().position(|p| *p == ".claude") {
        Some(i) => i + 1 < parts.len() && matches!(parts[i + 1], "skills" | "commands"),
        None => false,
    }
}

async fn delete_skill_under(path: &str, home: &Path) -> WriteSkillResult {
    let target = Path::new(path);
    if !is_allowed_skill_path(target, home).await {
        return WriteSkillResult::err(format!(
            "refusing to delete outside known skill roots: {path}"
        ));
    }
    if let Err(e) = tokio::fs::remove_file(target).await {
        return WriteSkillResult::err(e.to_string());
    }
    if target.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
        if let Some(dir) = target.parent() {
            if let Ok(mut read_dir) = tokio::fs::read_dir(dir).await {
                if matches!(read_dir.next_entry().await, Ok(None)) {
                    let _ = tokio::fs::remove_dir(dir).await;
                }
            }
        }
    }
    WriteSkillResult::ok()
}

#[tauri::command]
pub async fn system_write_skill(
    provider: String,
    name: String,
    content: String,
    project_dir: Option<String>,
) -> WriteSkillResult {
    let project_dir = project_dir.map(PathBuf::from);
    write_skill_with_home(
        houston_core::home_dir::home_dir(),
        &provider,
        &name,
        &content,
        project_dir.as_deref(),
    )
    .await
}

async fn write_skill_with_home(
    home: Option<PathBuf>,
    provider: &str,
    name: &str,
    content: &str,
    project_dir: Option<&Path>,
) -> WriteSkillResult {
    match home {
        Some(home) => write_skill_under(provider, name, content, &home, project_dir).await,
        None => WriteSkillResult::err(NO_HOME_ERROR.to_string()),
    }
}

const NO_HOME_ERROR: &str = "cannot resolve a home directory: neither $HOME nor this user's passwd entry gives one, so the skill directories have no base";

#[tauri::command]
pub async fn system_delete_skill(path: String) -> WriteSkillResult {
    delete_skill_with_home(houston_core::home_dir::home_dir(), &path).await
}

async fn delete_skill_with_home(home: Option<PathBuf>, path: &str) -> WriteSkillResult {
    match home {
        Some(home) => delete_skill_under(path, &home).await,
        None => WriteSkillResult::err(NO_HOME_ERROR.to_string()),
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillUrlPreview {
    pub name: String,
    pub description: String,
    pub content: String,
    pub size_bytes: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillResult {
    pub ok: bool,
    pub error: Option<String>,
    pub conflict: Option<SkillUrlConflict>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillUrlConflict {
    pub existing_content: String,
    pub path: String,
}

impl InstallSkillResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
            conflict: None,
        }
    }

    fn err(error: String) -> Self {
        Self {
            ok: false,
            error: Some(error),
            conflict: None,
        }
    }
}

const SKILL_URL_MAX_BYTES: u64 = 256 * 1024;
const SKILL_URL_TIMEOUT_SECS: u64 = 10;

fn validate_skill_url(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|e| format!("\"{url}\" is not a valid URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!(
            "Install from link only supports https:// links to a SKILL.md file, got \"{url}\""
        ));
    }
    let path = parsed.path();
    if !path.ends_with("/SKILL.md") && path != "/SKILL.md" {
        return Err(format!(
            "Install from link only supports a direct link to a SKILL.md file (a URL ending in \
             \"/SKILL.md\"), got \"{url}\""
        ));
    }
    Ok(())
}

async fn fetch_skill_md(url: &str) -> Result<String, String> {
    validate_skill_url(url)?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(std::time::Duration::from_secs(SKILL_URL_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("building the HTTP client: {e}"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("fetching {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "fetching {url}: the server answered {}",
            response.status()
        ));
    }
    if let Some(len) = response.content_length() {
        if len > SKILL_URL_MAX_BYTES {
            return Err(format!(
                "{url} is {len} bytes; the limit for Install from link is \
                 {SKILL_URL_MAX_BYTES} bytes (SKILL_URL_MAX_BYTES)"
            ));
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("reading {url}: {e}"))?
    {
        let actual = bytes.len() as u64 + chunk.len() as u64;
        if actual > SKILL_URL_MAX_BYTES {
            return Err(format!(
                "{url} exceeds the {SKILL_URL_MAX_BYTES}-byte limit: received {actual} bytes"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let content =
        String::from_utf8(bytes).map_err(|e| format!("{url} is not valid UTF-8 text: {e}"))?;
    if content
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("<!doctype html")
        || content
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("<html")
    {
        return Err("The link returned an HTML page. Use the raw SKILL.md file link.".to_string());
    }
    Ok(content)
}

fn derive_skill_name_from_url(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| {
            let segments: Vec<_> = url
                .path_segments()?
                .filter(|part| !part.is_empty())
                .collect();
            (segments.len() >= 2).then(|| segments[segments.len() - 2].to_string())
        })
        .unwrap_or_else(|| "imported-skill".to_string())
}

#[tauri::command]
pub async fn system_preview_skill_url(url: String) -> Result<SkillUrlPreview, String> {
    let content = fetch_skill_md(&url).await?;
    let (fm_name, fm_description) = parse_frontmatter(&content);
    let name = fm_name.unwrap_or_else(|| derive_skill_name_from_url(&url));
    Ok(SkillUrlPreview {
        name,
        description: fm_description.unwrap_or_default(),
        size_bytes: content.len(),
        content,
    })
}

async fn install_skill_url_under(
    name: &str,
    content: &str,
    home: &Path,
    project_dir: Option<&Path>,
    overwrite: bool,
) -> InstallSkillResult {
    if content.len() as u64 > SKILL_URL_MAX_BYTES {
        return InstallSkillResult::err(format!(
            "Skill content is {} bytes; expected at most {SKILL_URL_MAX_BYTES} bytes",
            content.len()
        ));
    }
    if !skill_name_re().is_match(name) {
        return InstallSkillResult::err(format!(
            "invalid skill name \"{name}\" — use only letters, numbers, \"_\" and \"-\" (1-64 chars)"
        ));
    }
    let base = match project_dir {
        Some(dir) => dir.join(".claude"),
        None => home.join(".claude"),
    };
    let target = base.join("skills").join(name).join("SKILL.md");
    match tokio::fs::read_to_string(&target).await {
        Ok(existing) if existing == content => return InstallSkillResult::ok(),
        Ok(existing) if !overwrite => {
            return InstallSkillResult {
                ok: false,
                error: Some(format!(
                    "a skill named \"{name}\" already exists at {} and differs from the one \
                     being installed",
                    target.display()
                )),
                conflict: Some(SkillUrlConflict {
                    existing_content: existing,
                    path: target.to_string_lossy().into_owned(),
                }),
            };
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return InstallSkillResult::err(format!(
                "reading {} before installation: {error}",
                target.display()
            ))
        }
    }
    let Some(dir) = target.parent() else {
        return InstallSkillResult::err(format!("{name}: no parent directory for {target:?}"));
    };
    if let Err(e) = tokio::fs::create_dir_all(dir).await {
        return InstallSkillResult::err(e.to_string());
    }
    use tokio::io::AsyncWriteExt;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true);
    if overwrite {
        options.create(true).truncate(true);
    } else {
        options.create_new(true);
    }
    let mut file = match options.open(&target).await {
        Ok(file) => file,
        Err(error) => {
            return InstallSkillResult::err(format!(
                "opening {} for installation: {error}",
                target.display()
            ))
        }
    };
    match file.write_all(content.as_bytes()).await {
        Ok(()) => InstallSkillResult::ok(),
        Err(e) => InstallSkillResult::err(e.to_string()),
    }
}

#[tauri::command]
pub async fn system_install_skill_url(
    name: String,
    content: String,
    project_dir: Option<String>,
    overwrite: bool,
) -> InstallSkillResult {
    let Some(home) = houston_core::home_dir::home_dir() else {
        return InstallSkillResult::err(NO_HOME_ERROR.to_string());
    };
    let project_dir = project_dir.map(PathBuf::from);
    install_skill_url_under(&name, &content, &home, project_dir.as_deref(), overwrite).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.unwrap();
        }
        tokio::fs::write(path, content).await.unwrap();
    }

    fn find<'a>(skills: &'a [Skill], agent: &str, name: &str) -> Option<&'a Skill> {
        skills.iter().find(|s| s.agent == agent && s.name == name)
    }

    #[test]
    fn parse_frontmatter_reads_name_and_description() {
        let text = "---\nname: security-audit\ndescription: Audits the codebase\n---\nBody";
        let (name, description) = parse_frontmatter(text);
        assert_eq!(name.as_deref(), Some("security-audit"));
        assert_eq!(description.as_deref(), Some("Audits the codebase"));
    }

    #[test]
    fn parse_frontmatter_strips_matching_quotes() {
        let text = "---\nname: \"quoted-name\"\ndescription: 'quoted desc'\n---\n";
        let (name, description) = parse_frontmatter(text);
        assert_eq!(name.as_deref(), Some("quoted-name"));
        assert_eq!(description.as_deref(), Some("quoted desc"));
    }

    #[test]
    fn parse_frontmatter_returns_nothing_without_a_leading_block() {
        let (name, description) = parse_frontmatter("# just a heading\nno frontmatter here");
        assert_eq!(name, None);
        assert_eq!(description, None);
    }

    #[test]
    fn parse_frontmatter_returns_nothing_for_an_unterminated_block() {
        let (name, description) = parse_frontmatter("---\nname: incomplete\nno closing marker");
        assert_eq!(name, None);
        assert_eq!(description, None);
    }

    #[tokio::test]
    async fn claude_skills_reads_a_skill_with_frontmatter() {
        let base = tempdir().unwrap();
        write_file(
            &base.path().join("skills/security-audit/SKILL.md"),
            "---\nname: security-audit\ndescription: Audits things\n---\nBody",
        )
        .await;

        let skills = claude_skills(base.path(), "user").await;
        let skill = find(&skills, "claude", "security-audit").expect("skill must be found");
        assert_eq!(skill.description, "Audits things");
        assert_eq!(skill.invoke, "/security-audit");
        assert_eq!(skill.source, "user");
        assert!(skill
            .path
            .replace('\\', "/")
            .ends_with("skills/security-audit/SKILL.md"));
    }

    #[tokio::test]
    async fn claude_skills_falls_back_to_the_directory_name_and_empty_description() {
        let base = tempdir().unwrap();
        write_file(
            &base.path().join("skills/bare-skill/SKILL.md"),
            "Just a body, no frontmatter",
        )
        .await;

        let skills = claude_skills(base.path(), "user").await;
        let skill = find(&skills, "claude", "bare-skill").expect("skill must be found");
        assert_eq!(skill.description, "");
        assert_eq!(skill.invoke, "/bare-skill");
    }

    #[tokio::test]
    async fn claude_skills_skips_a_directory_without_skill_md() {
        let base = tempdir().unwrap();
        tokio::fs::create_dir_all(base.path().join("skills/empty-dir"))
            .await
            .unwrap();
        write_file(
            &base.path().join("skills/real-skill/SKILL.md"),
            "---\nname: real-skill\n---\n",
        )
        .await;

        let skills = claude_skills(base.path(), "user").await;
        assert!(find(&skills, "claude", "empty-dir").is_none());
        assert!(find(&skills, "claude", "real-skill").is_some());
    }

    #[tokio::test]
    async fn claude_skills_returns_nothing_for_a_missing_base_directory() {
        let base = tempdir().unwrap();
        let missing = base.path().join("does-not-exist");
        let skills = claude_skills(&missing, "user").await;
        assert!(skills.is_empty());
    }

    #[tokio::test]
    async fn claude_skills_reads_a_namespaced_slash_command() {
        let base = tempdir().unwrap();
        write_file(
            &base.path().join("commands/ns/cmd.md"),
            "---\ndescription: A namespaced command\n---\n",
        )
        .await;

        let skills = claude_skills(base.path(), "project").await;
        let skill = find(&skills, "claude", "ns:cmd").expect("namespaced command must be found");
        assert_eq!(skill.description, "A namespaced command");
        assert_eq!(skill.invoke, "/ns:cmd");
        assert_eq!(skill.source, "project");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_skills_lists_an_unreadable_command_file_without_a_description() {
        use std::os::unix::fs::PermissionsExt;
        let base = tempdir().unwrap();
        let file = base.path().join("commands/broken.md");
        write_file(&file, "---\ndescription: unreachable\n---\n").await;
        tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000))
            .await
            .unwrap();

        let skills = claude_skills(base.path(), "user").await;
        let skill = find(&skills, "claude", "broken").expect("must still be listed");
        assert_eq!(
            skill.description, "",
            "an unreadable file must list with an empty description"
        );

        tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn codex_skills_reads_a_prompt_with_no_description() {
        let base = tempdir().unwrap();
        let prompts_dir = base.path().join("prompts");
        write_file(&prompts_dir.join("deploy.md"), "Some prompt body").await;

        let skills = codex_skills(&prompts_dir).await;
        let skill = find(&skills, "codex", "deploy").expect("prompt must be found");
        assert_eq!(skill.description, "");
        assert_eq!(skill.invoke, "/deploy");
        assert_eq!(skill.source, "user");
    }

    #[tokio::test]
    async fn codex_skills_returns_nothing_for_a_missing_prompts_directory() {
        let base = tempdir().unwrap();
        let skills = codex_skills(&base.path().join("nope")).await;
        assert!(skills.is_empty());
    }

    #[tokio::test]
    async fn gemini_skills_reads_a_nested_command_with_its_description() {
        let base = tempdir().unwrap();
        let commands_dir = base.path().join("commands");
        write_file(
            &commands_dir.join("git/commit.toml"),
            "description = \"Commit staged changes\"\nprompt = \"\"\"do it\"\"\"\n",
        )
        .await;

        let skills = gemini_skills(&commands_dir).await;
        let skill = find(&skills, "gemini", "git:commit").expect("nested command must be found");
        assert_eq!(skill.description, "Commit staged changes");
        assert_eq!(skill.invoke, "/git:commit");
        assert_eq!(skill.source, "user");
    }

    #[tokio::test]
    async fn gemini_skills_returns_nothing_for_a_missing_commands_directory() {
        let base = tempdir().unwrap();
        let skills = gemini_skills(&base.path().join("nope")).await;
        assert!(skills.is_empty());
    }

    #[tokio::test]
    async fn gemini_skills_lists_a_command_without_a_matching_description_key() {
        let base = tempdir().unwrap();
        let commands_dir = base.path().join("commands");
        write_file(
            &commands_dir.join("bare.toml"),
            "prompt = \"\"\"no description key\"\"\"\n",
        )
        .await;

        let skills = gemini_skills(&commands_dir).await;
        let skill = find(&skills, "gemini", "bare").expect("must still be listed");
        assert_eq!(skill.description, "");
    }

    #[tokio::test]
    async fn list_skills_under_merges_user_and_project_claude_codex_and_gemini() {
        let home = tempdir().unwrap();
        let project = tempdir().unwrap();
        write_file(
            &home.path().join(".claude/skills/user-skill/SKILL.md"),
            "---\n---\n",
        )
        .await;
        write_file(
            &project.path().join(".claude/skills/project-skill/SKILL.md"),
            "---\n---\n",
        )
        .await;
        write_file(&home.path().join(".codex/prompts/prompt-one.md"), "body").await;
        write_file(
            &home.path().join(".gemini/commands/tool.toml"),
            "description = \"A gemini tool\"\n",
        )
        .await;

        let skills = list_skills_under(home.path(), Some(project.path())).await;
        assert!(find(&skills, "claude", "user-skill").is_some());
        assert!(find(&skills, "claude", "project-skill").is_some());
        assert!(find(&skills, "codex", "prompt-one").is_some());
        assert!(find(&skills, "gemini", "tool").is_some());
    }

    #[tokio::test]
    async fn list_skills_under_omits_project_skills_when_no_project_dir_is_given() {
        let home = tempdir().unwrap();
        write_file(
            &home.path().join(".claude/skills/user-skill/SKILL.md"),
            "---\n---\n",
        )
        .await;

        let skills = list_skills_under(home.path(), None).await;
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].source, "user");
    }

    #[tokio::test]
    async fn list_skills_under_caps_the_result_at_skills_cap() {
        let home = tempdir().unwrap();
        let prompts_dir = home.path().join(".codex/prompts");
        for i in 0..(SKILLS_CAP + 25) {
            write_file(&prompts_dir.join(format!("prompt-{i}.md")), "body").await;
        }

        let skills = list_skills_under(home.path(), None).await;
        assert_eq!(
            skills.len(),
            SKILLS_CAP,
            "result must be capped at SKILLS_CAP"
        );
    }

    #[tokio::test]
    async fn falsification_list_skills_under_would_exceed_the_cap_without_truncation() {
        let home = tempdir().unwrap();
        let prompts_dir = home.path().join(".codex/prompts");
        for i in 0..(SKILLS_CAP + 25) {
            write_file(&prompts_dir.join(format!("prompt-{i}.md")), "body").await;
        }

        let uncapped = codex_skills(&prompts_dir).await;
        assert!(
            uncapped.len() > SKILLS_CAP,
            "fixture must produce more than SKILLS_CAP entries for the cap test above to mean anything"
        );
    }

    #[test]
    fn skill_serializes_the_expected_camel_case_key_set() {
        let skill = Skill {
            agent: "claude".to_string(),
            name: "n".to_string(),
            description: "d".to_string(),
            invoke: "/n".to_string(),
            source: "user".to_string(),
            path: "/p".to_string(),
        };
        let value = serde_json::to_value(&skill).unwrap();
        let obj = value.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["agent", "description", "invoke", "name", "path", "source"]
        );
    }

    #[tokio::test]
    async fn write_skill_under_rejects_an_empty_name() {
        let home = tempdir().unwrap();
        let result = write_skill_under("claude", "", "content", home.path(), None).await;
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("invalid skill name"));
    }

    #[tokio::test]
    async fn write_skill_under_rejects_a_name_with_a_disallowed_character() {
        let home = tempdir().unwrap();
        let result = write_skill_under("claude", "bad/name", "content", home.path(), None).await;
        assert!(!result.ok);
    }

    #[tokio::test]
    async fn write_skill_under_accepts_exactly_64_chars_rejects_65() {
        let home = tempdir().unwrap();
        let name_64 = "a".repeat(64);
        let name_65 = "a".repeat(65);

        let result_64 = write_skill_under("codex", &name_64, "content", home.path(), None).await;
        assert!(result_64.ok, "a 64-char name must be accepted");

        let result_65 = write_skill_under("codex", &name_65, "content", home.path(), None).await;
        assert!(!result_65.ok, "a 65-char name must be rejected");
    }

    #[tokio::test]
    async fn write_skill_under_writes_a_user_scoped_claude_skill() {
        let home = tempdir().unwrap();
        let result = write_skill_under("claude", "my-skill", "# Body", home.path(), None).await;
        assert!(result.ok);
        let written =
            tokio::fs::read_to_string(home.path().join(".claude/skills/my-skill/SKILL.md"))
                .await
                .unwrap();
        assert_eq!(written, "# Body");
    }

    #[tokio::test]
    async fn write_skill_under_writes_a_project_scoped_claude_skill_under_project_dir() {
        let home = tempdir().unwrap();
        let project = tempdir().unwrap();
        let result = write_skill_under(
            "claude",
            "proj-skill",
            "# Proj",
            home.path(),
            Some(project.path()),
        )
        .await;
        assert!(result.ok);
        let written =
            tokio::fs::read_to_string(project.path().join(".claude/skills/proj-skill/SKILL.md"))
                .await
                .unwrap();
        assert_eq!(written, "# Proj");
        assert!(
            tokio::fs::metadata(home.path().join(".claude/skills/proj-skill"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn write_skill_under_creates_intermediate_directories() {
        let home = tempdir().unwrap();
        assert!(tokio::fs::metadata(home.path().join(".claude"))
            .await
            .is_err());
        let result = write_skill_under("claude", "new-skill", "x", home.path(), None).await;
        assert!(result.ok);
    }

    #[tokio::test]
    async fn write_skill_under_writes_a_codex_prompt_md_file() {
        let home = tempdir().unwrap();
        let result = write_skill_under("codex", "deploy", "prompt body", home.path(), None).await;
        assert!(result.ok);
        let written = tokio::fs::read_to_string(home.path().join(".codex/prompts/deploy.md"))
            .await
            .unwrap();
        assert_eq!(written, "prompt body");
    }

    #[tokio::test]
    async fn write_skill_under_wraps_plain_text_into_toml_prompt() {
        let home = tempdir().unwrap();
        let result =
            write_skill_under("gemini", "tool", "plain instructions", home.path(), None).await;
        assert!(result.ok);
        let written = tokio::fs::read_to_string(home.path().join(".gemini/commands/tool.toml"))
            .await
            .unwrap();
        assert_eq!(
            written,
            "description = \"\"\nprompt = \"\"\"\nplain instructions\n\"\"\"\n"
        );
    }

    #[tokio::test]
    async fn write_skill_under_passes_through_content_that_already_looks_like_toml() {
        let home = tempdir().unwrap();
        let toml_content = "description = \"already toml\"\nprompt = \"\"\"body\"\"\"\n";
        let result = write_skill_under("gemini", "tool", toml_content, home.path(), None).await;
        assert!(result.ok);
        let written = tokio::fs::read_to_string(home.path().join(".gemini/commands/tool.toml"))
            .await
            .unwrap();
        assert_eq!(
            written, toml_content,
            "already-TOML content must pass through unwrapped"
        );
    }

    #[tokio::test]
    async fn write_skill_under_escapes_embedded_triple_quotes() {
        let home = tempdir().unwrap();
        let result =
            write_skill_under("gemini", "tool", "has \"\"\" inside", home.path(), None).await;
        assert!(result.ok);
        let written = tokio::fs::read_to_string(home.path().join(".gemini/commands/tool.toml"))
            .await
            .unwrap();
        assert!(written.contains("has \\\"\\\"\\\" inside"));
    }

    #[test]
    fn escape_gemini_body_doubles_a_single_trailing_backslash() {
        assert_eq!(escape_gemini_body("line ends with\\"), "line ends with\\\\");
    }

    #[test]
    fn escape_gemini_body_leaves_non_trailing_backslashes_alone() {
        assert_eq!(escape_gemini_body("a\\b"), "a\\b");
    }

    #[test]
    fn looks_like_toml_detects_a_description_key() {
        assert!(looks_like_toml("description = \"x\"\n"));
    }

    #[test]
    fn looks_like_toml_detects_a_prompt_key() {
        assert!(looks_like_toml("prompt = \"\"\"x\"\"\"\n"));
    }

    #[test]
    fn looks_like_toml_is_false_for_plain_text() {
        assert!(!looks_like_toml("just some plain instructions"));
    }

    #[tokio::test]
    async fn is_allowed_skill_path_accepts_a_file_under_a_known_global_root() {
        let home = tempdir().unwrap();
        let file = home.path().join(".claude/skills/foo/SKILL.md");
        write_file(&file, "x").await;
        assert!(is_allowed_skill_path(&file, home.path()).await);
    }

    #[tokio::test]
    async fn is_allowed_skill_path_accepts_a_project_scoped_claude_skills_subtree() {
        let home = tempdir().unwrap();
        let project = tempdir().unwrap();
        let file = project.path().join(".claude/skills/foo/SKILL.md");
        write_file(&file, "x").await;
        assert!(is_allowed_skill_path(&file, home.path()).await);
    }

    #[tokio::test]
    async fn is_allowed_skill_path_accepts_a_project_scoped_claude_commands_subtree() {
        let home = tempdir().unwrap();
        let project = tempdir().unwrap();
        let file = project.path().join(".claude/commands/foo.md");
        write_file(&file, "x").await;
        assert!(is_allowed_skill_path(&file, home.path()).await);
    }

    #[tokio::test]
    async fn is_allowed_skill_path_rejects_a_bare_claude_segment() {
        let home = tempdir().unwrap();
        let file = home.path().join(".claude/settings.json");
        write_file(&file, "{}").await;
        assert!(!is_allowed_skill_path(&file, home.path()).await);
    }

    #[tokio::test]
    async fn is_allowed_skill_path_rejects_a_path_outside_every_root() {
        let home = tempdir().unwrap();
        let outside = home.path().join("Documents/notes.txt");
        write_file(&outside, "x").await;
        assert!(!is_allowed_skill_path(&outside, home.path()).await);
    }

    #[tokio::test]
    async fn is_allowed_skill_path_rejects_a_nonexistent_path() {
        let home = tempdir().unwrap();
        let missing = home.path().join(".claude/skills/foo/SKILL.md");
        assert!(!is_allowed_skill_path(&missing, home.path()).await);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn is_allowed_skill_path_resolves_a_symlink_before_checking() {
        let home = tempdir().unwrap();
        let outside_dir = tempdir().unwrap();
        let real_file = outside_dir.path().join("evil.txt");
        write_file(&real_file, "x").await;
        let planted_link = home.path().join(".claude/skills/foo/SKILL.md");
        tokio::fs::create_dir_all(planted_link.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::symlink(&real_file, &planted_link).await.unwrap();
        assert!(
            !is_allowed_skill_path(&planted_link, home.path()).await,
            "a symlink resolving outside every root must be rejected"
        );
    }

    #[tokio::test]
    async fn delete_skill_under_refuses_a_path_outside_known_skill_roots() {
        let home = tempdir().unwrap();
        let file = home.path().join("Documents/notes.txt");
        write_file(&file, "x").await;
        let result = delete_skill_under(file.to_str().unwrap(), home.path()).await;
        assert!(!result.ok);
        assert!(result
            .error
            .unwrap()
            .contains("refusing to delete outside known skill roots"));
        assert!(tokio::fs::metadata(&file).await.is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delete_skill_under_deletes_a_file_inside_a_known_root() {
        let home = tempdir().unwrap();
        let file = home.path().join(".codex/prompts/deploy.md");
        write_file(&file, "x").await;
        let result = delete_skill_under(file.to_str().unwrap(), home.path()).await;
        assert!(result.ok);
        assert!(tokio::fs::metadata(&file).await.is_err());
    }

    #[tokio::test]
    async fn delete_skill_under_cleans_up_an_emptied_skill_directory() {
        let home = tempdir().unwrap();
        let dir = home.path().join(".claude/skills/my-skill");
        let file = dir.join("SKILL.md");
        write_file(&file, "x").await;
        let result = delete_skill_under(file.to_str().unwrap(), home.path()).await;
        assert!(result.ok);
        assert!(
            tokio::fs::metadata(&dir).await.is_err(),
            "the now-empty skill directory must be removed"
        );
    }

    #[tokio::test]
    async fn delete_skill_under_leaves_a_non_empty_skill_directory_in_place() {
        let home = tempdir().unwrap();
        let dir = home.path().join(".claude/skills/my-skill");
        let file = dir.join("SKILL.md");
        write_file(&file, "x").await;
        write_file(&dir.join("reference.md"), "extra").await;
        let result = delete_skill_under(file.to_str().unwrap(), home.path()).await;
        assert!(result.ok);
        assert!(
            tokio::fs::metadata(&dir).await.is_ok(),
            "a skill directory with leftover files must NOT be removed"
        );
    }

    #[tokio::test]
    async fn delete_skill_under_does_not_clean_up_parent_for_non_skill_md_files() {
        let home = tempdir().unwrap();
        let dir = home.path().join(".claude/commands");
        let file = dir.join("cmd.md");
        write_file(&file, "x").await;
        let result = delete_skill_under(file.to_str().unwrap(), home.path()).await;
        assert!(result.ok);
        assert!(tokio::fs::metadata(&dir).await.is_ok());
    }

    #[tokio::test]
    async fn write_skill_with_no_home_is_a_value_not_a_rejection() {
        let result = write_skill_with_home(None, "claude", "my-skill", "body", None).await;
        assert!(!result.ok, "an unresolvable home must not reject the call");
        let error = result
            .error
            .expect("the failure must carry an error string");
        assert!(
            error.contains("home directory") && error.contains("$HOME"),
            "the error must name the condition the user can act on, got {error:?}"
        );
    }

    #[tokio::test]
    async fn delete_skill_with_no_home_is_a_value_not_a_rejection() {
        let result = delete_skill_with_home(None, "/anything/SKILL.md").await;
        assert!(!result.ok, "an unresolvable home must not reject the call");
        assert!(result
            .error
            .expect("the failure must carry an error string")
            .contains("home directory"));
    }

    #[tokio::test]
    async fn write_skill_with_home_some_delegates_to_the_real_write() {
        let home = tempdir().unwrap();
        let result =
            write_skill_with_home(Some(home.path().to_path_buf()), "claude", "s", "B", None).await;
        assert!(result.ok);
        let written = tokio::fs::read_to_string(home.path().join(".claude/skills/s/SKILL.md"))
            .await
            .unwrap();
        assert_eq!(written, "B");
    }

    #[test]
    fn write_skill_result_ok_serializes_error_null_not_omitted() {
        let value = serde_json::to_value(WriteSkillResult::ok()).unwrap();
        let obj = value.as_object().unwrap();
        assert_eq!(obj.get("ok"), Some(&serde_json::json!(true)));
        assert!(
            obj.contains_key("error"),
            "error key must be present (as null) on success, matching PathOpenResult's precedent"
        );
        assert_eq!(obj.get("error"), Some(&serde_json::json!(null)));
    }

    #[test]
    fn validate_skill_url_accepts_a_direct_https_skill_md_link() {
        assert!(validate_skill_url("https://example.com/skills/deploy/SKILL.md").is_ok());
    }

    #[test]
    fn validate_skill_url_rejects_http() {
        let err = validate_skill_url("http://example.com/skills/deploy/SKILL.md").unwrap_err();
        assert!(err.contains("https://"), "got {err:?}");
    }

    #[test]
    fn validate_skill_url_rejects_a_path_not_ending_in_skill_md() {
        let err = validate_skill_url("https://example.com/skills/deploy/README.md").unwrap_err();
        assert!(err.contains("SKILL.md"), "got {err:?}");
    }

    #[test]
    fn validate_skill_url_rejects_a_repository_link() {
        let err = validate_skill_url("https://github.com/acme/skills").unwrap_err();
        assert!(err.contains("SKILL.md"), "got {err:?}");
    }

    #[test]
    fn validate_skill_url_rejects_garbage() {
        assert!(validate_skill_url("not a url").is_err());
    }

    #[test]
    fn derive_skill_name_from_url_takes_the_parent_segment() {
        assert_eq!(
            derive_skill_name_from_url("https://example.com/skills/deploy/SKILL.md"),
            "deploy"
        );
    }

    #[test]
    fn derive_skill_name_from_url_falls_back_for_a_bare_file() {
        assert_eq!(
            derive_skill_name_from_url("https://example.com/SKILL.md"),
            "imported-skill"
        );
    }

    #[test]
    fn derive_skill_name_ignores_query_and_fragment() {
        assert_eq!(
            derive_skill_name_from_url("https://example.com/skills/deploy/SKILL.md?raw=1#content"),
            "deploy"
        );
    }

    #[tokio::test]
    async fn install_skill_rejects_oversized_content_before_writing() {
        let home = tempdir().unwrap();
        let result = install_skill_url_under(
            "deploy",
            &"x".repeat(SKILL_URL_MAX_BYTES as usize + 1),
            home.path(),
            None,
            false,
        )
        .await;
        assert!(!result.ok);
        assert!(!home.path().join(".claude/skills/deploy/SKILL.md").exists());
    }

    #[tokio::test]
    async fn install_skill_url_under_writes_a_new_user_scoped_skill() {
        let home = tempdir().unwrap();
        let result =
            install_skill_url_under("deploy", "# Deploy\nbody", home.path(), None, false).await;
        assert!(result.ok);
        assert!(result.conflict.is_none());
        let written = tokio::fs::read_to_string(home.path().join(".claude/skills/deploy/SKILL.md"))
            .await
            .unwrap();
        assert_eq!(written, "# Deploy\nbody");
    }

    #[tokio::test]
    async fn install_skill_url_under_writes_a_project_scoped_skill_under_project_dir() {
        let home = tempdir().unwrap();
        let project = tempdir().unwrap();
        let result = install_skill_url_under(
            "deploy",
            "# Deploy",
            home.path(),
            Some(project.path()),
            false,
        )
        .await;
        assert!(result.ok);
        assert!(
            tokio::fs::metadata(project.path().join(".claude/skills/deploy/SKILL.md"))
                .await
                .is_ok()
        );
        assert!(
            tokio::fs::metadata(home.path().join(".claude/skills/deploy"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn install_skill_url_under_rejects_an_invalid_name() {
        let home = tempdir().unwrap();
        let result = install_skill_url_under("bad/name", "body", home.path(), None, false).await;
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("invalid skill name"));
    }

    #[tokio::test]
    async fn install_skill_url_under_is_a_silent_no_op_when_content_is_already_identical() {
        let home = tempdir().unwrap();
        write_file(
            &home.path().join(".claude/skills/deploy/SKILL.md"),
            "# Deploy",
        )
        .await;
        let result = install_skill_url_under("deploy", "# Deploy", home.path(), None, false).await;
        assert!(result.ok);
        assert!(result.conflict.is_none());
    }

    #[tokio::test]
    async fn install_skill_url_under_refuses_to_overwrite_differing_content_without_the_flag() {
        let home = tempdir().unwrap();
        write_file(
            &home.path().join(".claude/skills/deploy/SKILL.md"),
            "# Deploy v1",
        )
        .await;
        let result =
            install_skill_url_under("deploy", "# Deploy v2", home.path(), None, false).await;
        assert!(!result.ok);
        let conflict = result
            .conflict
            .expect("a differing file must report a conflict");
        assert_eq!(conflict.existing_content, "# Deploy v1");
        let untouched =
            tokio::fs::read_to_string(home.path().join(".claude/skills/deploy/SKILL.md"))
                .await
                .unwrap();
        assert_eq!(
            untouched, "# Deploy v1",
            "a refused overwrite must not touch the existing file"
        );
    }

    #[tokio::test]
    async fn install_skill_url_under_overwrites_differing_content_when_explicitly_told_to() {
        let home = tempdir().unwrap();
        write_file(
            &home.path().join(".claude/skills/deploy/SKILL.md"),
            "# Deploy v1",
        )
        .await;
        let result =
            install_skill_url_under("deploy", "# Deploy v2", home.path(), None, true).await;
        assert!(result.ok);
        let written = tokio::fs::read_to_string(home.path().join(".claude/skills/deploy/SKILL.md"))
            .await
            .unwrap();
        assert_eq!(written, "# Deploy v2");
    }

    #[test]
    fn skill_url_preview_serializes_the_expected_camel_case_key_set() {
        let preview = SkillUrlPreview {
            name: "n".to_string(),
            description: "d".to_string(),
            content: "c".to_string(),
            size_bytes: 1,
        };
        let value = serde_json::to_value(&preview).unwrap();
        let obj = value.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["content", "description", "name", "sizeBytes"]);
    }
}
