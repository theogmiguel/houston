//! The pairing QR code, rendered as SVG markup the renderer shows inline.
use anyhow::{anyhow, Result};
use qrcode::render::svg;
use qrcode::{EcLevel, QrCode};

/// Dark modules on a white field with the standard quiet zone: phone cameras
/// read that contrast in either theme, so the colours are not theme tokens.
pub fn svg(text: &str) -> Result<String> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M)
        .map_err(|e| anyhow!("encoding the pairing link as a QR code: {e}"))?;
    Ok(code
        .render()
        .min_dimensions(232, 232)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .quiet_zone(true)
        .build())
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_pairing_link_renders_as_svg() {
        let out =
            super::svg("https://box.tail1.ts.net/#pair=0123456789abcdef0123456789abcdef").unwrap();
        assert!(out.contains("<svg"), "{out}");
        assert!(out.contains("#000000"));
    }
}
