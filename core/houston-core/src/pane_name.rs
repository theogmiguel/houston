use std::collections::HashSet;

const CODENAMES: [&str; 60] = [
    "Max", "Leo", "Finn", "Cole", "Jude", "Kai", "Rex", "Beau", "Zane", "Cruz", "Reed", "Wade",
    "Hugo", "Otto", "Jax", "Dean", "Knox", "Seth", "Milo", "Ezra", "Abel", "Enzo", "Theo", "Gus",
    "Levi", "Cy", "Roan", "Tate", "Bo", "Nico", "Mia", "Ivy", "Ava", "Zoe", "Lux", "Nova", "Luna",
    "Cleo", "Elle", "Wren", "Faye", "Iris", "Juno", "Rey", "Vera", "Esme", "Nell", "Sage", "Remy",
    "Thea", "Lena", "Gia", "Bree", "Cora", "Dara", "Nia", "Lia", "Eve", "Mae", "Wynn",
];

/// How a restored pane tells "still unnamed" from "named by someone", since only
/// the name survives a restart: a pool name reads as unnamed and may be improved
/// on, anything else is treated as the user's and is never overwritten.
pub(crate) fn is_codename(title: &str) -> bool {
    CODENAMES.iter().any(|c| c.eq_ignore_ascii_case(title))
}

pub(crate) fn pick_codename(used: &HashSet<String>) -> String {
    use rand::seq::IndexedRandom;
    let used_lower: HashSet<String> = used.iter().map(|s| s.to_lowercase()).collect();
    let mut rng = rand::rng();
    for suffix in 1.. {
        let free: Vec<String> = CODENAMES
            .iter()
            .map(|name| {
                if suffix == 1 {
                    (*name).to_string()
                } else {
                    format!("{name}-{suffix}")
                }
            })
            .filter(|c| !used_lower.contains(&c.to_lowercase()))
            .collect();
        if let Some(pick) = free.choose(&mut rng) {
            return pick.clone();
        }
    }
    unreachable!("the suffix loop is unbounded")
}

pub fn title_from_prompt(prompt: &str, max_len: usize) -> Option<String> {
    let line = prompt.lines().map(str::trim).find(|l| !l.is_empty())?;
    static PREFIX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let prefix = PREFIX.get_or_init(|| regex::Regex::new(
        r"(?i)^(?:(?:can|could|would) you(?: please)?\s+|please\s+|help me(?: to)?\s+|(?:issue\s+)?#\d+\s*[:\-–—]?\s*)"
    ).expect("title prefix regex"));
    let mut line = line;
    while let Some(found) = prefix.find(line) {
        line = &line[found.end()..];
    }
    let mut words = line
        .split_whitespace()
        .flat_map(|w| w.trim_start_matches(['@', '/', '#']).split(['-', '_']))
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()));
    let first_word = words.next()?;
    let mut title = String::new();
    let mut used = 0usize;
    for word in std::iter::once(first_word).chain(words) {
        let separator = usize::from(!title.is_empty());
        let Some(room) = max_len
            .checked_sub(used)
            .and_then(|n| n.checked_sub(separator))
        else {
            break;
        };
        let length = word.chars().take(room.saturating_add(1)).count();
        if length > room {
            break;
        }
        if separator != 0 {
            title.push(' ');
        }
        title.push_str(word);
        used += separator + length;
    }
    if title.is_empty() {
        title = first_word.chars().take(max_len).collect();
    }
    let mut chars = title.chars();
    let first = chars.next()?;
    let title = first.to_uppercase().collect::<String>() + chars.as_str();
    Some(truncate_at_word_boundary(&title, max_len))
}

/// Cuts to at most `max_len` chars. When the cut lands past roughly half of
/// `max_len`, backs up to the last space so the result reads as a word rather
/// than a stub; otherwise a hard cut, since backing up further wastes the budget.
pub fn truncate_at_word_boundary(text: &str, max_len: usize) -> String {
    let char_count = text.chars().count();
    if char_count <= max_len {
        return text.to_string();
    }
    let cut: String = text.chars().take(max_len).collect();
    let last_space = cut
        .chars()
        .enumerate()
        .filter(|&(_, c)| c == ' ')
        .map(|(i, _)| i)
        .last();
    match last_space {
        Some(idx) if idx >= max_len / 2 => cut.chars().take(idx).collect(),
        _ => cut,
    }
}

pub fn unique(name: &str, used: &HashSet<String>) -> String {
    let used: HashSet<String> = used.iter().map(|s| s.to_lowercase()).collect();
    if !used.contains(&name.to_lowercase()) {
        return name.to_string();
    }
    (2..)
        .map(|n| format!("{name}-{n}"))
        .find(|c| !used.contains(&c.to_lowercase()))
        .expect("the suffix sequence is unbounded")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_char_uppercase_expansion_stays_within_title_limit() {
        let prompt = format!("ß{}", "a".repeat(39));
        let title = title_from_prompt(&prompt, 40).unwrap();
        assert!(title.starts_with("SS"));
        assert_eq!(title.chars().count(), 40);
    }

    #[test]
    fn zero_limit_and_normalization_edges_preserve_prompt_titles() {
        assert_eq!(title_from_prompt("useful title", 0), None);
        assert_eq!(title_from_prompt("ß", 1).as_deref(), Some("S"));
        assert_eq!(title_from_prompt("ß abc def", 9).as_deref(), Some("SS abc"));
        assert_eq!(
            title_from_prompt("\n  --@feature__#133 -- ...\nignored", 40).as_deref(),
            Some("@feature #133")
        );
        assert_eq!(
            title_from_prompt("alpha_ beta--gamma", 40).as_deref(),
            Some("Alpha beta gamma")
        );
        assert_eq!(title_from_prompt("alpha beta", 5).as_deref(), Some("Alpha"));
    }

    #[test]
    fn filler_and_issue_prefixes_leave_the_task_visible() {
        for prompt in [
            "Can you please fix authentication",
            "Please help me to fix authentication",
            "Issue #133: fix authentication",
            "#133 — can you please fix authentication",
        ] {
            assert_eq!(
                title_from_prompt(prompt, 40).as_deref(),
                Some("Fix authentication")
            );
        }
        assert_eq!(title_from_prompt("Please", 40).as_deref(), Some("Please"));
        assert_eq!(
            title_from_prompt("Can you explain #133 safely", 40).as_deref(),
            Some("Explain 133 safely")
        );
    }

    #[test]
    fn the_references_own_example() {
        assert_eq!(
            title_from_prompt("review @acme-api", 40).as_deref(),
            Some("Review acme api")
        );
    }

    #[test]
    fn first_line_cleaned_capitalised_and_cut_at_a_word() {
        assert_eq!(
            title_from_prompt("\n\n  /review the   auth_flow please\nsecond line", 40).as_deref(),
            Some("Review the auth flow please")
        );
        assert_eq!(
            title_from_prompt("fix the flaky late attach flood test today", 20).as_deref(),
            Some("Fix the flaky late")
        );
        assert_eq!(
            title_from_prompt("supercalifragilisticexpialidocious now", 10).as_deref(),
            Some("Supercalif")
        );
        assert_eq!(title_from_prompt("@ / -- ...", 40), None);
        assert_eq!(title_from_prompt("   ", 40), None);
        assert_eq!(title_from_prompt("bom dia", 40).as_deref(), Some("Bom dia"));
    }

    #[test]
    fn truncate_backs_up_to_the_last_space_past_half_the_cap() {
        assert_eq!(
            truncate_at_word_boundary("Fixing the authentication bug today", 12),
            "Fixing the"
        );
    }

    #[test]
    fn truncate_hard_cuts_when_no_space_falls_near_the_cap() {
        assert_eq!(
            truncate_at_word_boundary("supercalifragilisticexpialidocious", 10),
            "supercalif"
        );
    }

    #[test]
    fn truncate_stays_on_a_char_boundary_with_multibyte_text() {
        let out = truncate_at_word_boundary("ação ação ação ação ação ação ação ação", 10);
        assert_eq!(out, "ação ação");
    }

    #[test]
    fn a_taken_name_gets_a_suffix() {
        let used: HashSet<String> = ["review the api".to_string(), "Review the api-2".to_string()]
            .into_iter()
            .collect();
        assert_eq!(unique("Review the api", &used), "Review the api-3");
        assert_eq!(unique("Docs writer", &used), "Docs writer");
    }
}
