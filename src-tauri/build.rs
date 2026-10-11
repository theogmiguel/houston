fn main() {
    // tauri.windows.conf.json bundles wsl/; the release build stages the Linux daemon
    // there, and an empty directory keeps every other Windows build compiling.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        std::fs::create_dir_all("wsl").expect("creating src-tauri/wsl for the bundle");
        println!("cargo:rerun-if-changed=wsl");
    }
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
