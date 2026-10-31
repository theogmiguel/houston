//! Pure Niri/Hyprland config edits. Mirrors upstream `captureConfigEdit.ts`.

use regex::Regex;

use super::capture_config_kdl::{read_kdl_nodes, KdlNode};
use super::linux_capture_session::niri_capture_binding;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureConfigFormat {
    Niri,
    Hyprland,
    HyprlandLua,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureConfigKeys {
    pub label: String,
    pub modifiers: String,
    pub key: String,
    pub mask: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureConfigEdit {
    pub after: String,
    pub shortcut: String,
}

fn parse_shortcut(input: &str) -> Option<(String, bool, bool, bool, bool, bool)> {
    let lowered = input.to_lowercase();
    let mut tokens: Vec<String> = lowered
        .split('+')
        .map(|token| token.trim().to_string())
        .collect();
    let mut trailing = 0;
    while tokens.last().is_some_and(String::is_empty) {
        trailing += 1;
        tokens.pop();
    }
    if trailing > 0 {
        tokens.push("+".to_string());
    }
    if tokens.iter().any(String::is_empty) || tokens.is_empty() {
        return None;
    }
    let mut key: Option<String> = None;
    let (mut meta, mut ctrl, mut shift, mut alt, mut mod_key) = (false, false, false, false, false);
    for token in tokens {
        match token.as_str() {
            "cmd" | "meta" => meta = true,
            "ctrl" | "control" => ctrl = true,
            "shift" => shift = true,
            "alt" | "option" => alt = true,
            "mod" => mod_key = true,
            other => {
                if key.is_some() {
                    return None;
                }
                key = Some(match other {
                    "space" => " ".to_string(),
                    "esc" => "escape".to_string(),
                    value => value.to_string(),
                });
            }
        }
    }
    Some((key?, meta, ctrl, shift, alt, mod_key))
}

pub fn capture_config_keys(input: &str) -> Result<CaptureConfigKeys, String> {
    let normalized = input.to_lowercase().replace("super", "meta");
    let Some((key, meta, ctrl, shift, alt, mod_key)) = parse_shortcut(&normalized) else {
        return Err(
            "Choose a letter, number, or function key with Ctrl, Alt, or Super.".to_string(),
        );
    };
    let function_key = key
        .strip_prefix('f')
        .and_then(|digits| digits.parse::<u8>().ok())
        .is_some_and(|number| (1..=24).contains(&number));
    if mod_key
        || !(key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric()) || function_key)
        || !(ctrl || alt || meta)
    {
        return Err(
            "Choose a letter, number, or function key with Ctrl, Alt, or Super.".to_string(),
        );
    }
    let modifiers: Vec<&str> = [
        ctrl.then_some("Ctrl"),
        alt.then_some("Alt"),
        shift.then_some("Shift"),
        meta.then_some("Super"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let key = key.to_uppercase();
    Ok(CaptureConfigKeys {
        label: modifiers
            .iter()
            .copied()
            .chain(std::iter::once(key.as_str()))
            .collect::<Vec<_>>()
            .join("+"),
        modifiers: modifiers.join(" ").to_uppercase(),
        key,
        mask: (shift as u32) | (ctrl as u32) << 2 | (alt as u32) << 3 | (meta as u32) << 6,
    })
}

fn same_keys(left: &str, right: &str) -> bool {
    match (capture_config_keys(left), capture_config_keys(right)) {
        (Ok(left), Ok(right)) => left.label == right.label,
        _ => false,
    }
}

pub fn capture_config_binding(
    format: CaptureConfigFormat,
    app_id: &str,
    keys: &str,
) -> Result<String, String> {
    if app_id.is_empty()
        || !app_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err("Invalid capture application ID.".to_string());
    }
    let chord = capture_config_keys(keys)?;
    if format == CaptureConfigFormat::Niri {
        return Ok(niri_capture_binding(app_id).replace("Ctrl+Shift+2", &chord.label));
    }
    let action = format!("{app_id}:capture-window");
    Ok(match format {
        CaptureConfigFormat::HyprlandLua => format!(
            "hl.bind(\"{}\", hl.dsp.global(\"{action}\"))",
            chord.label.to_uppercase().replace('+', " + ")
        ),
        CaptureConfigFormat::Hyprland => {
            format!(
                "bind = {}, {}, global, {action}",
                chord.modifiers, chord.key
            )
        }
        CaptureConfigFormat::Niri => unreachable!(),
    })
}

fn niri_binds(source: &str) -> Result<Option<KdlNode>, String> {
    let blocks: Vec<KdlNode> = read_kdl_nodes(source)?
        .into_iter()
        .filter(|node| node.name == "binds")
        .collect();
    if blocks.len() > 1 || blocks.iter().any(|node| node.close.is_none()) {
        return Err(
            "This Niri config has an unexpected binds section. Check it in Advanced.".to_string(),
        );
    }
    Ok(blocks.into_iter().next())
}

fn niri_capture_node(node: &KdlNode, app_id: &str) -> bool {
    let Ok(expected_nodes) = read_kdl_nodes(
        &capture_config_binding(CaptureConfigFormat::Niri, app_id, "Ctrl+Shift+2")
            .unwrap_or_default(),
    ) else {
        return false;
    };
    let Some(expected) = expected_nodes
        .first()
        .and_then(|node| node.children.first())
    else {
        return false;
    };
    let Some(action) = node.children.first() else {
        return false;
    };
    node.children.len() == 1
        && action.children.is_empty()
        && action
            .header
            .iter()
            .map(|token| &token.value)
            .eq(expected.header.iter().map(|token| &token.value))
}

pub fn niri_config_includes(source: &str) -> Result<Vec<(String, bool)>, String> {
    let nodes = read_kdl_nodes(source)?;
    nodes
        .into_iter()
        .filter(|node| node.name == "include")
        .map(|node| {
            let path = node
                .header
                .iter()
                .enumerate()
                .find(|(index, token)| {
                    *index > 0
                        && token.quoted
                        && node.header.get(index - 1).map(|token| token.value.as_str()) != Some("=")
                })
                .map(|(_, token)| token.value.clone());
            let Some(path) = path else {
                return Err(
                    "Couldn't resolve a Niri include. Choose the config in Advanced.".to_string(),
                );
            };
            let optional = node.header.iter().enumerate().any(|(index, token)| {
                token.value == "optional"
                    && node.header.get(index + 1).map(|token| token.value.as_str()) == Some("=")
                    && node.header.get(index + 2).map(|token| token.value.as_str()) == Some("true")
            });
            Ok((path, optional))
        })
        .collect()
}

pub fn niri_config_conflict(source: &str, app_id: &str, keys: &str) -> Result<bool, String> {
    Ok(niri_binds(source)?
        .map(|block| {
            block
                .children
                .iter()
                .any(|node| same_keys(&node.name, keys) && !niri_capture_node(node, app_id))
        })
        .unwrap_or(false))
}

#[derive(Debug, Clone)]
struct HyprlandBind {
    start: usize,
    end: usize,
    keys: String,
    action: String,
}

fn hyprland_binds(source: &str, lua: bool) -> Vec<HyprlandBind> {
    let legacy =
        Regex::new(r"^\s*bind[a-z]*\s*=\s*([^,]*),\s*([^,]*),\s*([^,]*),\s*(.*?)\s*(?:#.*)?$")
            .expect("static legacy bind regex");
    let modern = Regex::new(
        r#"^\s*hl\.bind\(\s*["'](.*?)["']\s*,\s*hl\.dsp\.global\(\s*["'](.*?)["']\s*\)\s*\)\s*;?\s*(?:--.*)?$"#,
    )
    .expect("static lua bind regex");
    let mut bindings = Vec::new();
    let mut start = 0;
    for line in source.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if !lua {
            if let Some(captures) = legacy.captures(trimmed) {
                let keys = format!(
                    "{}+{}",
                    captures[1].split_whitespace().collect::<Vec<_>>().join("+"),
                    captures[2].trim()
                );
                let action = if captures[3].trim() == "global" {
                    captures[4].trim().to_string()
                } else {
                    String::new()
                };
                bindings.push(HyprlandBind {
                    start,
                    end: start + line.len(),
                    keys,
                    action,
                });
            }
        } else if let Some(captures) = modern.captures(trimmed) {
            bindings.push(HyprlandBind {
                start,
                end: start + line.len(),
                keys: captures[1].to_string(),
                action: captures[2].to_string(),
            });
        }
        start += line.len();
    }
    bindings
}

fn remove_nodes(source: &str, ranges: &[(usize, usize)]) -> String {
    let mut result = source.to_string();
    let mut sorted = ranges.to_vec();
    sorted.sort_by_key(|range| std::cmp::Reverse(range.0));
    for (start, end) in sorted {
        let line_start = source[..start]
            .rfind('\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        let next_line = source[end..].find('\n').map(|index| end + index);
        let line_end = next_line.unwrap_or(source.len());
        let whole_line =
            source[line_start..start].trim().is_empty() && source[end..line_end].trim().is_empty();
        result = if whole_line {
            format!(
                "{}{}",
                &result[..line_start],
                &result[line_end.saturating_add(1).min(source.len())..]
            )
        } else {
            format!("{}{}", &result[..start], &result[end..])
        };
    }
    result
}

pub fn edit_capture_config(
    source: &str,
    format: CaptureConfigFormat,
    app_id: &str,
    operation: &str,
    requested_keys: Option<&str>,
) -> Result<CaptureConfigEdit, String> {
    if format == CaptureConfigFormat::HyprlandLua {
        let returns = Regex::new(r"(?m)^\s*return\b").expect("static return regex");
        let long_bracket = Regex::new(r"\[=*\[").expect("static long bracket regex");
        if returns.is_match(source) || long_bracket.is_match(source) {
            return Err(
                "This Lua config needs a manual edit. Choose your bindings file or use manual setup in Advanced."
                    .to_string(),
            );
        }
    }
    let niri = format == CaptureConfigFormat::Niri;
    let existing: Vec<(usize, usize, String)> = if niri {
        niri_binds(source)?
            .map(|block| {
                block
                    .children
                    .into_iter()
                    .filter(|node| niri_capture_node(node, app_id))
                    .map(|node| (node.start, node.end, node.name))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        hyprland_binds(source, format == CaptureConfigFormat::HyprlandLua)
            .into_iter()
            .filter(|bind| bind.action == format!("{app_id}:capture-window"))
            .map(|bind| (bind.start, bind.end, bind.keys))
            .collect()
    };
    let keys = capture_config_keys(requested_keys.unwrap_or_else(|| {
        existing
            .first()
            .map(|(_, _, keys)| keys.as_str())
            .unwrap_or("Ctrl+Shift+2")
    }))?
    .label;
    if operation == "install" && existing.len() == 1 && same_keys(&existing[0].2, &keys) {
        return Ok(CaptureConfigEdit {
            after: source.to_string(),
            shortcut: keys,
        });
    }
    let mut after = remove_nodes(
        source,
        &existing
            .iter()
            .map(|(start, end, _)| (*start, *end))
            .collect::<Vec<_>>(),
    );
    if operation == "remove" {
        return Ok(CaptureConfigEdit {
            after,
            shortcut: keys,
        });
    }
    let conflict = if niri {
        niri_config_conflict(&after, app_id, &keys)?
    } else {
        hyprland_binds(&after, false)
            .iter()
            .any(|bind| same_keys(&bind.keys, &keys))
    };
    if conflict {
        return Err(format!(
            "{keys} is already used in this config. Choose another shortcut."
        ));
    }
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let binding = capture_config_binding(format, app_id, &keys)?;
    if niri {
        match niri_binds(&after)? {
            Some(block) => {
                if let Some(close) = block.close {
                    let line_start = after[..close]
                        .rfind('\n')
                        .map(|index| index + 1)
                        .unwrap_or(0);
                    let indent = &after[line_start..close];
                    if indent.trim().is_empty() {
                        after = format!(
                            "{}{indent}    {binding}{newline}{}",
                            &after[..line_start],
                            &after[line_start..]
                        );
                    } else {
                        after = format!(
                            "{}{newline}    {binding}{newline}{}",
                            &after[..close],
                            &after[close..]
                        );
                    }
                } else {
                    return Err(
                        "This Niri config has an unexpected binds section. Check it in Advanced."
                            .to_string(),
                    );
                }
            }
            None => {
                let separator = if after.is_empty() || after.ends_with('\n') {
                    ""
                } else {
                    newline
                };
                after = format!(
                    "{after}{separator}{newline}binds {{{newline}    {binding}{newline}}}{newline}"
                );
            }
        }
        read_kdl_nodes(&after)?;
    } else {
        let separator = if after.is_empty() || after.ends_with('\n') {
            ""
        } else {
            newline
        };
        after = format!("{after}{separator}{newline}{binding}{newline}");
    }
    Ok(CaptureConfigEdit {
        after,
        shortcut: keys,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = "com.t3tools.T3Code";

    fn binding() -> String {
        capture_config_binding(CaptureConfigFormat::Niri, APP, "Ctrl+Shift+2").unwrap()
    }

    #[test]
    fn inserts_into_existing_binds() {
        let before = "// My desktop\ninput { keyboard { xkb { layout \"us\"; }; }; }\nbinds {\n    Mod+Q { spawn \"kitty\"; } // keep me\n}\n";
        let result =
            edit_capture_config(before, CaptureConfigFormat::Niri, APP, "install", None).unwrap();
        assert_eq!(
            result.after,
            before.replace("\n}\n", &format!("\n    {}\n}}\n", binding()))
        );
    }

    #[test]
    fn handles_compact_or_absent_binds() {
        for before in ["binds {}", "binds { Mod+Q { quit; }; }", "input { }\n", ""] {
            let result =
                edit_capture_config(before, CaptureConfigFormat::Niri, APP, "install", None)
                    .unwrap();
            let nodes = read_kdl_nodes(&result.after).unwrap();
            let block = nodes.iter().find(|node| node.name == "binds").unwrap();
            assert!(block
                .children
                .iter()
                .any(|node| node.name == "Ctrl+Shift+2"));
        }
    }

    #[test]
    fn preserves_crlf_and_bom() {
        let before = "\u{FEFF}binds {\r\n}\r\n";
        assert_eq!(
            edit_capture_config(before, CaptureConfigFormat::Niri, APP, "install", None)
                .unwrap()
                .after,
            format!("\u{FEFF}binds {{\r\n    {}\r\n}}\r\n", binding())
        );
    }

    #[test]
    fn does_not_duplicate_an_existing_binding() {
        let before = format!(
            "binds {{\n    {}\n}}\n",
            binding().replace("Ctrl+Shift+2", "Alt+Ctrl+Y")
        );
        let result =
            edit_capture_config(&before, CaptureConfigFormat::Niri, APP, "install", None).unwrap();
        assert_eq!(result.after, before);
        assert_eq!(result.shortcut, "Ctrl+Alt+Y");
    }

    #[test]
    fn replaces_and_removes_only_this_apps_binding() {
        let other =
            capture_config_binding(CaptureConfigFormat::Niri, "com.t3tools.Other", "Ctrl+Alt+4")
                .unwrap();
        let before = format!("binds {{\n    {}\n    {other}\n}}\n", binding());
        let result = edit_capture_config(
            &before,
            CaptureConfigFormat::Niri,
            APP,
            "install",
            Some("Ctrl+Alt+Y"),
        )
        .unwrap();
        assert!(result.after.contains(&other));
        assert!(!result.after.contains("Ctrl+Shift+2"));
        assert!(result.after.contains("Ctrl+Alt+Y"));
        let removed = edit_capture_config(
            &result.after,
            CaptureConfigFormat::Niri,
            APP,
            "remove",
            None,
        )
        .unwrap();
        assert_eq!(removed.after, format!("binds {{\n    {other}\n}}\n"));
    }

    #[test]
    fn refuses_occupied_keys_regardless_of_modifier_order() {
        let before = "binds { Shift+Control+2 { quit; } }";
        assert!(niri_config_conflict(before, APP, "Ctrl+Shift+2").unwrap());
        assert!(
            edit_capture_config(before, CaptureConfigFormat::Niri, APP, "install", None).is_err()
        );
    }

    #[test]
    fn reads_only_real_top_level_includes() {
        assert_eq!(
            niri_config_includes(
                "// include \"no\"\n/- include \"no\"\ninclude \"keys.kdl\"\ninclude optional=true \"extra.kdl\""
            )
            .unwrap(),
            vec![
                ("keys.kdl".to_string(), false),
                ("extra.kdl".to_string(), true)
            ]
        );
    }

    #[test]
    fn hyprland_edits_are_idempotent_and_reversible() {
        for format in [
            CaptureConfigFormat::Hyprland,
            CaptureConfigFormat::HyprlandLua,
        ] {
            let before = if format == CaptureConfigFormat::Hyprland {
                "# Keep my preferences\n$mainMod = SUPER\n"
            } else {
                "-- Keep my preferences\nhl.config({ general = { border_size = 2 } })\n"
            };
            let added = edit_capture_config(before, format, APP, "install", None).unwrap();
            assert!(added.after.starts_with(before));
            assert_eq!(
                edit_capture_config(&added.after, format, APP, "install", None)
                    .unwrap()
                    .after,
                added.after
            );
            let changed =
                edit_capture_config(&added.after, format, APP, "install", Some("Ctrl+Alt+Y"))
                    .unwrap();
            assert!(!changed
                .after
                .contains(&capture_config_binding(format, APP, "Ctrl+Shift+2").unwrap()));
            assert!(changed
                .after
                .contains(&capture_config_binding(format, APP, "Ctrl+Alt+Y").unwrap()));
            assert_eq!(
                edit_capture_config(&changed.after, format, APP, "remove", None)
                    .unwrap()
                    .after
                    .trim(),
                before.trim()
            );
        }
    }

    #[test]
    fn does_not_steal_an_existing_legacy_shortcut() {
        assert!(edit_capture_config(
            "bind = SHIFT CTRL, 2, exec, kitty\n",
            CaptureConfigFormat::Hyprland,
            APP,
            "install",
            None
        )
        .is_err());
    }

    #[test]
    fn refuses_to_guess_complex_lua() {
        for source in [
            "return {}",
            "--[[\nhl.bind(\"CTRL + SHIFT + 2\", hl.dsp.global(\"com.t3tools.T3Code:capture-window\"))\n]]",
        ] {
            assert!(edit_capture_config(
                source,
                CaptureConfigFormat::HyprlandLua,
                APP,
                "install",
                None
            )
            .is_err());
        }
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_keys() {
        for keys in ["Ctrl+\"\nexec", "Ctrl+;", "2", "Mod+2"] {
            assert!(edit_capture_config(
                "",
                CaptureConfigFormat::Hyprland,
                APP,
                "install",
                Some(keys)
            )
            .is_err());
        }
    }
}
