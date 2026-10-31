//! Pixel transcoding between the Windows GDI capture surface and the stored PNG.
//! Upstream resizes with Electron's native image pipeline; the arithmetic here is
//! ordinary Rust so the caps and channel order are covered by tests on every host.

use png::{BitDepth, ColorType, Encoder};

/// Upstream's `snapShotThumbnailSize` caps a capture at the composer's image limits.
pub const MAX_CAPTURE_WIDTH: u32 = 2_560;
pub const MAX_CAPTURE_HEIGHT: u32 = 1_600;

/// The stored size never exceeds the capture caps and never collapses to zero.
pub fn bounded_size(width: u32, height: u32) -> (u32, u32) {
    (
        width.clamp(1, MAX_CAPTURE_WIDTH),
        height.clamp(1, MAX_CAPTURE_HEIGHT),
    )
}

/// GDI's `BI_RGB` 32-bit surface is BGRA with an unused alpha byte; PNG wants RGBA
/// with real alpha, so the stored image is fully opaque.
pub fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(bgra.len());
    for pixel in bgra.as_chunks::<4>().0 {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
    }
    rgba
}

pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected = width as usize * height as usize * 4;
    if width == 0 || height == 0 {
        return Err(format!(
            "the captured image is {width}x{height}; expected a positive width and height"
        ));
    }
    if rgba.len() != expected {
        return Err(format!(
            "the captured image buffer is {} bytes; expected {expected} for {width}x{height}",
            rgba.len()
        ));
    }
    let mut encoded = Vec::new();
    {
        let mut encoder = Encoder::new(&mut encoded, width, height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("encoding the snapshot header: {error}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|error| format!("encoding the snapshot pixels: {error}"))?;
    }
    Ok(encoded)
}

/// Converts a top-down BGRA capture to a bounded, opaque PNG.
pub fn encode_capture(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err(format!(
            "the captured region is {width}x{height}; expected a positive width and height"
        ));
    }
    let expected = width as usize * height as usize * 4;
    if bgra.len() != expected {
        return Err(format!(
            "the captured bitmap is {} bytes; expected {expected} for {width}x{height}",
            bgra.len()
        ));
    }
    let (target_width, target_height) = bounded_size(width, height);
    let rgba = bgra_to_rgba(bgra);
    let rgba = if (target_width, target_height) == (width, height) {
        rgba
    } else {
        scale(&rgba, width, height, target_width, target_height)
    };
    encode_png(target_width, target_height, &rgba)
}

fn scale(src: &[u8], src_width: u32, src_height: u32, width: u32, height: u32) -> Vec<u8> {
    let mut scaled = vec![0u8; width as usize * height as usize * 4];
    for y in 0..height {
        let source_y = ((y as f64 + 0.5) * src_height as f64 / height as f64 - 0.5)
            .clamp(0.0, (src_height - 1) as f64);
        let top = source_y.floor() as u32;
        let bottom = (top + 1).min(src_height - 1);
        let weight_y = source_y - top as f64;
        for x in 0..width {
            let source_x = ((x as f64 + 0.5) * src_width as f64 / width as f64 - 0.5)
                .clamp(0.0, (src_width - 1) as f64);
            let left = source_x.floor() as u32;
            let right = (left + 1).min(src_width - 1);
            let weight_x = source_x - left as f64;
            for channel in 0..4 {
                let at = |column: u32, row: u32| {
                    src[((row * src_width + column) * 4 + channel) as usize] as f64
                };
                let top_left = at(left, top);
                let top_right = at(right, top);
                let bottom_left = at(left, bottom);
                let bottom_right = at(right, bottom);
                let value = top_left * (1.0 - weight_x) * (1.0 - weight_y)
                    + top_right * weight_x * (1.0 - weight_y)
                    + bottom_left * (1.0 - weight_x) * weight_y
                    + bottom_right * weight_x * weight_y;
                scaled[((y * width + x) * 4 + channel) as usize] =
                    value.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    scaled
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn capture_size_keeps_the_window_and_applies_the_composer_caps() {
        assert_eq!(bounded_size(800, 600), (800, 600));
        assert_eq!(
            bounded_size(4_000, 2_000),
            (MAX_CAPTURE_WIDTH, MAX_CAPTURE_HEIGHT)
        );
        assert_eq!(bounded_size(0, 0), (1, 1));
    }

    #[test]
    fn bgra_pixels_become_opaque_rgba() {
        assert_eq!(
            bgra_to_rgba(&[10, 20, 30, 0, 40, 50, 60, 7]),
            vec![30, 20, 10, 255, 60, 50, 40, 255]
        );
    }

    #[test]
    fn captured_bitmap_round_trips_through_png() {
        let bgra = [0u8, 0, 255, 0, 255, 0, 0, 0];
        let encoded = encode_capture(&bgra, 2, 1).expect("encode");
        assert!(encoded.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]));
        let decoder = png::Decoder::new(Cursor::new(encoded));
        let mut reader = decoder.read_info().expect("decode header");
        let info = reader.info();
        assert_eq!((info.width, info.height), (2, 1));
        assert_eq!(info.color_type, ColorType::Rgba);
        let mut pixels = vec![0u8; reader.output_buffer_size()];
        reader.next_frame(&mut pixels).expect("decode pixels");
        assert_eq!(&pixels[..8], &[255, 0, 0, 255, 0, 0, 255, 255]);
    }

    #[test]
    fn scaling_averages_the_source_pixels() {
        let rgba = [
            0u8, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 255, 255, 255, 255,
        ];
        assert_eq!(
            scale(&rgba, 2, 2, 1, 1),
            vec![139, 139, 139, 255],
            "a 1x1 destination samples the four source pixels evenly"
        );
    }

    #[test]
    fn a_buffer_that_does_not_match_the_size_is_refused() {
        let error = encode_capture(&[0, 0, 0, 0], 2, 2).expect_err("refused");
        assert!(error.contains("expected 16 for 2x2"), "got {error}");
        let error = encode_capture(&[], 0, 0).expect_err("refused");
        assert!(error.contains("positive width and height"), "got {error}");
    }
}
