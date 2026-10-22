//! Workspace transfer: a workspace's Claude and Codex conversations and code state,
//! carried to another computer in one passphrase-encrypted file. The daemon builds and
//! restores the file; nothing is sent over a network.

pub mod archive;
pub mod checkout;
pub mod manifest;
pub mod transcripts;

use houston_protocol as proto;

/// Refusals list at most this many paths or values; the rest are counted.
const MAX_LISTED: usize = 20;

/// A refused transfer, carried through `anyhow` so the server can answer
/// `transfer_refused` instead of a generic error.
#[derive(Debug)]
pub struct Refused(pub proto::TransferRefusal);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0.problem)?;
        for item in &self.0.items {
            write!(f, "; {item}")?;
        }
        Ok(())
    }
}

impl std::error::Error for Refused {}

pub fn refuse(
    code: proto::TransferRefusalCode,
    problem: impl Into<String>,
    items: Vec<String>,
    steps: Vec<String>,
) -> anyhow::Error {
    anyhow::Error::new(Refused(proto::TransferRefusal {
        code,
        problem: problem.into(),
        items: bounded(items),
        steps,
    }))
}

/// The refusal inside `error`, if it is one.
pub fn refusal(error: &anyhow::Error) -> Option<&proto::TransferRefusal> {
    error.downcast_ref::<Refused>().map(|refused| &refused.0)
}

fn bounded(mut items: Vec<String>) -> Vec<String> {
    if items.len() > MAX_LISTED {
        let more = items.len() - MAX_LISTED;
        items.truncate(MAX_LISTED);
        items.push(format!("and {more} more"));
    }
    items
}

/// `n` followed by `one` or `many`.
pub fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_lists_twenty_items_and_counts_the_rest() {
        let error = refuse(
            proto::TransferRefusalCode::DirtyCheckout,
            "dirty",
            (0..25).map(|i| format!("file{i}")).collect(),
            vec!["commit".into()],
        );
        let refusal = refusal(&error).expect("a refusal");
        assert_eq!(refusal.items.len(), 21);
        assert_eq!(refusal.items[20], "and 5 more");
        assert!(format!("{error:#}").starts_with("dirty; file0"));
    }
}
