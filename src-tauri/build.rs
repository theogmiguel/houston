fn main() {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut attrs = tauri_build::Attributes::new();
    #[cfg(windows)]
    {
        attrs = attrs.windows_attributes(
            tauri_build::WindowsAttributes::new()
                .app_manifest(include_str!("windows-app-manifest.xml")),
        );
    }
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
