use std::io::Cursor;

const MAX_IMAGE_RGBA_BYTES: usize = 256 * 1024 * 1024;

#[tauri::command]
pub async fn clipboard_save_image() -> Result<Option<String>, String> {
    let Some(png) = read_clipboard_png().await? else {
        return Ok(None);
    };
    crate::fs::save_bytes_under("pastes", "png", &png)
        .await
        .map(Some)
}

#[tauri::command]
pub async fn clipboard_read_text() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let mut clipboard = open_clipboard()?;
        match clipboard.get_text() {
            Ok(text) => Ok(text),
            Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
            Err(e) => Err(format!("cannot read clipboard text: {e}")),
        }
    })
    .await
    .map_err(|e| format!("clipboard text read task failed: {e}"))?
}

async fn read_clipboard_png() -> Result<Option<Vec<u8>>, String> {
    tokio::task::spawn_blocking(|| {
        let mut clipboard = open_clipboard()?;
        let image = match clipboard.get_image() {
            Ok(image) => image,
            Err(arboard::Error::ContentNotAvailable) => return Ok(None),
            Err(e) => return Err(format!("cannot read clipboard image: {e}")),
        };
        encode_png(&image.bytes, image.width, image.height).map(Some)
    })
    .await
    .map_err(|e| format!("clipboard image read task failed: {e}"))?
}

fn open_clipboard() -> Result<arboard::Clipboard, String> {
    arboard::Clipboard::new().map_err(|e| format!("cannot open the system clipboard: {e}"))
}

fn encode_png(rgba: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    let expected = width
        .checked_mul(height)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| {
            format!("clipboard image dimensions overflow: {width}x{height} pixels at 4 bytes each")
        })?;
    if width == 0 || height == 0 {
        return Err(format!(
            "clipboard image has no pixels: {width}x{height}, expected both dimensions above zero"
        ));
    }
    if expected > MAX_IMAGE_RGBA_BYTES {
        return Err(format!(
            "clipboard image is too large: {width}x{height} is {expected} RGBA bytes, over the {MAX_IMAGE_RGBA_BYTES}-byte limit"
        ));
    }
    if rgba.len() < expected {
        return Err(format!(
            "clipboard image is truncated: {len} RGBA bytes for {width}x{height}, expected {expected}",
            len = rgba.len()
        ));
    }

    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(Cursor::new(&mut out), width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("cannot write PNG header for {width}x{height} image: {e}"))?;
        writer
            .write_image_data(&rgba[..expected])
            .map_err(|e| format!("cannot encode {width}x{height} clipboard image as PNG: {e}"))?;
        writer
            .finish()
            .map_err(|e| format!("cannot finish PNG for {width}x{height} clipboard image: {e}"))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba_2x1() -> Vec<u8> {
        vec![255, 0, 0, 255, 0, 255, 0, 255]
    }

    #[test]
    fn encodes_rgba_as_a_real_png() {
        let png = encode_png(&rgba_2x1(), 2, 1).expect("2x1 encodes");
        assert_eq!(
            &png[..8],
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
            "output must start with the PNG signature"
        );
        let decoder = png::Decoder::new(Cursor::new(&png));
        let mut reader = decoder.read_info().expect("decodes");
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).expect("frame decodes");
        assert_eq!((info.width, info.height), (2, 1));
        assert_eq!(&buf[..info.buffer_size()], rgba_2x1().as_slice());
    }

    #[test]
    fn trims_a_buffer_longer_than_the_frame() {
        let mut padded = rgba_2x1();
        padded.extend_from_slice(&[9, 9, 9, 9]);
        assert!(
            encode_png(&padded, 2, 1).is_ok(),
            "a backend that pads rows must not fail the encode"
        );
    }

    #[test]
    fn refuses_a_truncated_buffer_naming_both_sizes() {
        let err = encode_png(&[255, 0, 0, 255], 2, 1).expect_err("4 bytes is half a 2x1 frame");
        assert!(err.contains('4') && err.contains('8'), "got {err}");
    }

    #[test]
    fn refuses_zero_dimensions() {
        let err = encode_png(&[], 0, 4).expect_err("no pixels");
        assert!(err.contains("0x4"), "got {err}");
    }

    #[test]
    fn refuses_an_image_over_the_cap_naming_the_cap() {
        let err = encode_png(&[], 8193, 8193).expect_err("over the cap");
        assert!(
            err.contains(&MAX_IMAGE_RGBA_BYTES.to_string()) && err.contains("8193x8193"),
            "the error must name the limit and what was asked for; got {err}"
        );
    }

    #[test]
    fn refuses_dimensions_that_overflow_the_byte_count() {
        let err = encode_png(&[], usize::MAX, 4).expect_err("overflows");
        assert!(err.contains("overflow"), "got {err}");
    }
}
