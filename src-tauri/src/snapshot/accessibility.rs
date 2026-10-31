//! Pure accessibility helpers from upstream `snapShot.ts`. The AT-SPI reader is
//! not ported yet, so these only support the bounded text and window matching
//! decisions shared with a future reader.
#![allow(dead_code)]

use super::platform::Bounds;

const MAX_ACCESSIBILITY_TREE_NODES: usize = 10_000;

#[derive(Debug, Clone, Default)]
pub struct TextNode {
    pub name: Option<String>,
    pub value: Option<String>,
    pub children: Vec<TextNode>,
}

pub fn accessible_window_text(root: &TextNode, max_chars: usize) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![root];
    let mut text = String::new();
    let mut visited = 0;
    while let Some(node) = stack.pop() {
        if text.encode_utf16().count() >= max_chars || visited >= MAX_ACCESSIBILITY_TREE_NODES {
            break;
        }
        visited += 1;
        for value in [&node.name, &node.value].into_iter().flatten() {
            let candidate = value.replace('\0', "");
            let candidate = candidate.trim();
            if candidate.is_empty() || seen.contains(candidate) {
                continue;
            }
            let separator = if text.is_empty() { 0 } else { 1 };
            let remaining = max_chars.saturating_sub(text.encode_utf16().count() + separator);
            if remaining == 0 {
                return text;
            }
            text.push_str(&"\n".repeat(separator));
            let mut taken = 0;
            for character in candidate.chars() {
                let width = character.len_utf16();
                if taken + width > remaining {
                    return text;
                }
                text.push(character);
                taken += width;
            }
            seen.insert(candidate.to_string());
        }
        for child in node.children.iter().rev() {
            stack.push(child);
        }
    }
    text
}

#[derive(Debug, Clone)]
pub struct WindowCandidate {
    pub name: Option<String>,
    pub bounds: Option<Bounds>,
    pub active: bool,
}

#[derive(Debug, Clone)]
pub struct CapturedWindow {
    pub title: String,
    pub source_title: Option<String>,
    pub bounds: Bounds,
    pub client_bounds: Option<Bounds>,
    pub platform: String,
    pub bundle_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchMode {
    ScreenBounds,
    Wayland,
}

fn normalize_title(value: &str, mode: MatchMode) -> String {
    let title = value.trim();
    if mode != MatchMode::Wayland {
        return title.to_string();
    }
    let mut chars = title.chars();
    match chars.next() {
        Some(spinner) if "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".contains(spinner) => {
            chars.as_str().trim_start().to_string()
        }
        _ => title.to_string(),
    }
}

fn bounds_match(bounds: Bounds, candidate: Bounds, mode: MatchMode) -> bool {
    if mode == MatchMode::Wayland {
        (bounds.width - candidate.width).abs() <= 2 && (bounds.height - candidate.height).abs() <= 2
    } else {
        (bounds.x - candidate.x).abs() <= 2
            && (bounds.y - candidate.y).abs() <= 2
            && (bounds.width - candidate.width).abs() <= 2
            && (bounds.height - candidate.height).abs() <= 2
    }
}

pub fn find_accessible_window(
    windows: &[WindowCandidate],
    captured: &CapturedWindow,
    mode: MatchMode,
    allow_untitled_unique_bounds: bool,
) -> Option<usize> {
    let titles: std::collections::HashSet<String> =
        [Some(captured.title.clone()), captured.source_title.clone()]
            .into_iter()
            .flatten()
            .map(|title| normalize_title(&title, mode))
            .filter(|title| !title.is_empty())
            .collect();
    let candidates: Vec<Bounds> = match (mode, captured.client_bounds) {
        (MatchMode::Wayland, Some(client)) => vec![captured.bounds, client],
        _ => vec![captured.bounds],
    };
    let matches_bounds = |window: &WindowCandidate| {
        window.bounds.is_some_and(|bounds| {
            candidates
                .iter()
                .any(|candidate| bounds_match(bounds, *candidate, mode))
        })
    };
    if !titles.is_empty() {
        let matches: Vec<usize> = windows
            .iter()
            .enumerate()
            .filter(|(_, window)| {
                titles.contains(&normalize_title(window.name.as_deref().unwrap_or(""), mode))
                    && matches_bounds(window)
            })
            .map(|(index, _)| index)
            .collect();
        if matches.len() == 1 {
            return Some(matches[0]);
        }
        let active: Vec<usize> = matches
            .iter()
            .copied()
            .filter(|index| windows[*index].active)
            .collect();
        if active.len() == 1 {
            return Some(active[0]);
        }
        if !matches.is_empty() {
            return None;
        }
    }
    if !allow_untitled_unique_bounds {
        return None;
    }
    let untitled: Vec<usize> = windows
        .iter()
        .enumerate()
        .filter(|(_, window)| {
            normalize_title(window.name.as_deref().unwrap_or(""), mode).is_empty()
                && matches_bounds(window)
        })
        .map(|(index, _)| index)
        .collect();
    (untitled.len() == 1).then_some(untitled[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(x: i64, y: i64, width: i64, height: i64) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
        }
    }

    fn captured() -> CapturedWindow {
        CapturedWindow {
            title: "Editor".to_string(),
            source_title: None,
            bounds: bounds(100, 200, 800, 600),
            client_bounds: None,
            platform: "linux".to_string(),
            bundle_id: None,
        }
    }

    fn window(name: &str, bounds: Bounds) -> WindowCandidate {
        WindowCandidate {
            name: Some(name.to_string()),
            bounds: Some(bounds),
            active: false,
        }
    }

    #[test]
    fn caps_large_text_without_splitting_a_surrogate_pair() {
        let root = TextNode {
            value: Some("abc😀def".to_string()),
            ..Default::default()
        };
        assert_eq!(accessible_window_text(&root, 5), "abc😀");
    }

    #[test]
    fn stops_traversing_very_large_trees() {
        let mut root = TextNode {
            children: (0..10_000).map(|_| TextNode::default()).collect(),
            ..Default::default()
        };
        root.children.push(TextNode {
            value: Some("past node limit".to_string()),
            ..Default::default()
        });
        assert!(!accessible_window_text(&root, 100).contains("past node limit"));
    }

    #[test]
    fn matches_one_window_by_captured_bounds() {
        let windows = [
            window("Private", bounds(0, 0, 400, 300)),
            window("Editor", bounds(101, 199, 800, 601)),
        ];
        assert_eq!(
            find_accessible_window(&windows, &captured(), MatchMode::ScreenBounds, false),
            Some(1)
        );
    }

    #[test]
    fn uses_the_captured_source_title_when_the_active_title_changed() {
        let windows = [window("Editor — saved", bounds(100, 200, 800, 600))];
        let captured = CapturedWindow {
            title: "Editor — saving".to_string(),
            source_title: Some("Editor — saved".to_string()),
            ..captured()
        };
        assert_eq!(
            find_accessible_window(&windows, &captured, MatchMode::ScreenBounds, false),
            Some(0)
        );
    }

    #[test]
    fn uses_the_active_match_to_disambiguate_equal_windows() {
        let mut first = window("Editor", bounds(100, 200, 800, 600));
        first.active = false;
        let mut second = first.clone();
        second.active = true;
        assert_eq!(
            find_accessible_window(
                &[first, second],
                &captured(),
                MatchMode::ScreenBounds,
                false
            ),
            Some(1)
        );
    }

    #[test]
    fn does_not_match_equal_bounds_with_a_different_title() {
        let windows = [window("Private", bounds(100, 200, 800, 600))];
        assert_eq!(
            find_accessible_window(&windows, &captured(), MatchMode::ScreenBounds, false),
            None
        );
    }

    #[test]
    fn wayland_ignores_position_but_requires_size() {
        let captured = CapturedWindow {
            title: "hello world (Draft) - Text Editor".to_string(),
            bounds: bounds(479, 342, 700, 520),
            ..captured()
        };
        let windows = [window(&captured.title, bounds(0, 0, 700, 520))];
        assert_eq!(
            find_accessible_window(&windows, &captured, MatchMode::Wayland, false),
            Some(0)
        );
        assert_eq!(
            find_accessible_window(&windows, &captured, MatchMode::ScreenBounds, false),
            None
        );
    }

    #[test]
    fn wayland_matches_a_verified_client_size() {
        let client = bounds(100, 229, 800, 571);
        let windows = [window("Editor", bounds(0, 0, 800, 571))];
        let captured = CapturedWindow {
            client_bounds: Some(client),
            ..captured()
        };
        assert_eq!(
            find_accessible_window(&windows, &captured, MatchMode::Wayland, false),
            Some(0)
        );
        assert_eq!(
            find_accessible_window(&windows, &captured, MatchMode::ScreenBounds, false),
            None
        );
    }

    #[test]
    fn does_not_match_an_untitled_window_by_size_alone() {
        let windows = [window("", bounds(100, 200, 800, 600))];
        let captured = CapturedWindow {
            title: String::new(),
            ..captured()
        };
        assert_eq!(
            find_accessible_window(&windows, &captured, MatchMode::Wayland, false),
            None
        );
        assert_eq!(
            find_accessible_window(&windows, &captured, MatchMode::Wayland, true),
            Some(0)
        );
    }

    #[test]
    fn accepts_spinner_titles_only_when_they_normalize_to_the_same_text() {
        let windows = [window("⠙ t3code", bounds(100, 200, 800, 600))];
        let captured = CapturedWindow {
            title: "⠋ t3code".to_string(),
            ..captured()
        };
        assert_eq!(
            find_accessible_window(&windows, &captured, MatchMode::Wayland, false),
            Some(0)
        );
        let private = [window("⠙ private", bounds(100, 200, 800, 600))];
        assert_eq!(
            find_accessible_window(&private, &captured, MatchMode::Wayland, false),
            None
        );
    }
}
