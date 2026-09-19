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
    let words: Vec<String> = line
        .split_whitespace()
        .map(|w| {
            w.trim_start_matches(['@', '/', '#'])
                .replace(['-', '_'], " ")
        })
        .flat_map(|w| w.split_whitespace().map(str::to_owned).collect::<Vec<_>>())
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
        .collect();
    if words.is_empty() {
        return None;
    }
    let mut title = String::new();
    for w in &words {
        let next = if title.is_empty() {
            w.clone()
        } else {
            format!("{title} {w}")
        };
        if next.chars().count() > max_len {
            break;
        }
        title = next;
    }
    if title.is_empty() {
        title = words[0].chars().take(max_len).collect();
    }
    let mut chars = title.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().collect::<String>() + chars.as_str())
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
