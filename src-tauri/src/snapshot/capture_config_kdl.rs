//! A bounded KDL reader for Niri's `binds` and `include` nodes. Mirrors
//! upstream `captureConfigKdl.ts`; anything unusual falls back to manual setup.

#[derive(Debug, Clone)]
pub struct Token {
    pub value: String,
    pub start: usize,
    pub end: usize,
    pub quoted: bool,
}

#[derive(Debug, Clone)]
pub struct KdlNode {
    pub name: String,
    pub header: Vec<Token>,
    pub children: Vec<KdlNode>,
    pub start: usize,
    pub end: usize,
    pub close: Option<usize>,
}

fn invalid() -> String {
    "Couldn't read this Niri config. Use Advanced to configure it manually.".to_string()
}

fn is_kdl_space(c: char) -> bool {
    matches!(
        c,
        '\t' | ' ' | '\r' | '\u{FEFF}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

fn starts_with_at(source: &str, offset: usize, needle: &str) -> bool {
    source[offset..].starts_with(needle)
}

pub fn read_kdl_nodes(source: &str) -> Result<Vec<KdlNode>, String> {
    let mut tokens = Vec::new();
    let mut offset = 0;
    while offset < source.len() {
        let start = offset;
        let rest = &source[offset..];
        let Some(first) = rest.chars().next() else {
            break;
        };
        if is_kdl_space(first) {
            offset += first.len_utf8();
            continue;
        }
        if starts_with_at(source, offset, "//") {
            offset = source[offset..]
                .find('\n')
                .map(|index| offset + index)
                .unwrap_or(source.len());
            continue;
        }
        if starts_with_at(source, offset, "/*") {
            offset += 2;
            let mut depth = 1;
            while depth > 0 && offset < source.len() {
                if starts_with_at(source, offset, "/*") {
                    depth += 1;
                    offset += 2;
                } else if starts_with_at(source, offset, "*/") {
                    depth -= 1;
                    offset += 2;
                } else {
                    offset += source[offset..]
                        .chars()
                        .next()
                        .map(char::len_utf8)
                        .unwrap_or(1);
                }
            }
            if depth > 0 {
                return Err(invalid());
            }
            continue;
        }
        if first == '\\' {
            let mut scan = offset + 1;
            let mut saw_newline = false;
            while scan < source.len() {
                let c = source[scan..].chars().next().unwrap_or('\n');
                if c == '\n' {
                    saw_newline = true;
                    scan += 1;
                    break;
                }
                if !is_kdl_space(c) {
                    break;
                }
                scan += c.len_utf8();
            }
            if saw_newline {
                offset = scan;
                continue;
            }
        }
        if first == 'r' {
            let hashes = source[offset + 1..]
                .bytes()
                .take_while(|byte| *byte == b'#')
                .count();
            if hashes <= 32 && source.as_bytes().get(offset + 1 + hashes) == Some(&b'"') {
                let content_start = offset + 1 + hashes + 1;
                let terminator = format!("\"{}", "#".repeat(hashes));
                let Some(found) = source[content_start..].find(&terminator) else {
                    return Err(invalid());
                };
                let end = content_start + found + terminator.len();
                tokens.push(Token {
                    value: source[content_start..content_start + found].to_string(),
                    start,
                    end,
                    quoted: true,
                });
                offset = end;
                continue;
            }
        }
        if first == '"' {
            offset += 1;
            while offset < source.len() && source.as_bytes()[offset] != b'"' {
                if source.as_bytes()[offset] == b'\\' {
                    offset += 1;
                }
                offset += source[offset..]
                    .chars()
                    .next()
                    .map(char::len_utf8)
                    .unwrap_or(1);
            }
            if offset >= source.len() {
                return Err(invalid());
            }
            offset += 1;
            let value: String =
                serde_json::from_str(&source[start..offset]).map_err(|_| invalid())?;
            tokens.push(Token {
                value,
                start,
                end: offset,
                quoted: true,
            });
            continue;
        }
        if starts_with_at(source, offset, "/-") {
            offset += 2;
        } else if matches!(first, '{' | '}' | ';' | '\n' | '=' | '(' | ')') {
            offset += first.len_utf8();
        } else {
            while offset < source.len() {
                let c = source[offset..].chars().next().unwrap_or(' ');
                if is_kdl_space(c) || matches!(c, '{' | '}' | ';' | '=' | '"' | '(' | ')') {
                    break;
                }
                if ["//", "/*", "/-"]
                    .iter()
                    .any(|prefix| starts_with_at(source, offset, prefix))
                {
                    break;
                }
                offset += c.len_utf8();
            }
        }
        if offset == start {
            return Err(invalid());
        }
        tokens.push(Token {
            value: source[start..offset].to_string(),
            start,
            end: offset,
            quoted: false,
        });
    }

    let mut cursor = 0;
    fn is(token: Option<&Token>, value: &str) -> bool {
        token.is_some_and(|token| !token.quoted && token.value == value)
    }

    fn nodes(tokens: &[Token], cursor: &mut usize, nested: bool) -> Result<Vec<KdlNode>, String> {
        let mut result = Vec::new();
        while *cursor < tokens.len() {
            if is(tokens.get(*cursor), "\n") || is(tokens.get(*cursor), ";") {
                *cursor += 1;
                continue;
            }
            if is(tokens.get(*cursor), "}") {
                if !nested {
                    return Err(invalid());
                }
                return Ok(result);
            }
            let disabled = is(tokens.get(*cursor), "/-");
            if disabled {
                *cursor += 1;
            }
            let Some(name) = tokens.get(*cursor).cloned() else {
                return Err(invalid());
            };
            *cursor += 1;
            if ["{", "}", "=", ";", "\n", "("].contains(&name.value.as_str()) {
                return Err(invalid());
            }
            let mut node = KdlNode {
                name: name.value.clone(),
                header: vec![name.clone()],
                children: Vec::new(),
                start: name.start,
                end: name.end,
                close: None,
            };
            while *cursor < tokens.len()
                && !is(tokens.get(*cursor), "\n")
                && !is(tokens.get(*cursor), ";")
                && !is(tokens.get(*cursor), "}")
            {
                let token = tokens[*cursor].clone();
                *cursor += 1;
                if is(Some(&token), "{") {
                    node.children = nodes(tokens, cursor, true)?;
                    let Some(close) = tokens.get(*cursor) else {
                        return Err(invalid());
                    };
                    if !is(Some(close), "}") {
                        return Err(invalid());
                    }
                    *cursor += 1;
                    node.close = Some(close.start);
                    node.end = close.end;
                    break;
                }
                node.header.push(token.clone());
                node.end = token.end;
            }
            if !disabled {
                result.push(node);
            }
        }
        if nested {
            return Err(invalid());
        }
        Ok(result)
    }

    nodes(&tokens, &mut cursor, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_binds_and_ignores_comments_and_strings() {
        let source = "// binds { fake\n/* nested /* */ } */\nbinds {\n    Mod+Q { spawn \"kitty\"; }\n}\nspawn-at-startup \"echo\" r#\"binds { }\"#\n";
        let nodes = read_kdl_nodes(source).unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].name, "binds");
        assert_eq!(nodes[0].children.len(), 1);
    }

    #[test]
    fn rejects_unbalanced_structures() {
        assert!(read_kdl_nodes("binds {").is_err());
        assert!(read_kdl_nodes("/* unfinished").is_err());
        assert!(read_kdl_nodes("spawn \"unfinished").is_err());
        assert!(read_kdl_nodes("binds {}\nbinds {}").is_ok());
    }

    #[test]
    fn handles_compact_binds_and_disabled_nodes() {
        let nodes =
            read_kdl_nodes("/- binds { Ctrl+Shift+2 { quit; } }\nbinds { Mod+Q { quit; }; }")
                .unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].children.len(), 1);
    }
}
