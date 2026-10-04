//! Opt-in Slack intake: a Socket Mode connection that turns a mention into a
//! pending task and reports the task's run back to the message's thread.

pub mod api;
pub mod credentials;
pub mod form;
pub mod intake;
pub mod socket;
pub mod text;

/// The image type by its leading bytes, never by the name or Slack's mimetype.
pub fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, ..] => Some("png"),
        [0xff, 0xd8, 0xff, ..] => Some("jpg"),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some("gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::image_extension;

    #[test]
    fn images_are_recognised_by_their_bytes_only() {
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\n...."), Some("png"));
        assert_eq!(image_extension(b"\xff\xd8\xff\xe0"), Some("jpg"));
        assert_eq!(image_extension(b"GIF89a.."), Some("gif"));
        assert_eq!(image_extension(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_extension(b"<svg xmlns=..."), None);
        assert_eq!(image_extension(b"%PDF-1.7"), None);
    }
}
