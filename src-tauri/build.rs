fn main() {
    // 确保替换图标后，`tauri dev` 的构建会重新触发（否则 Cargo 可能不重跑 build.rs，Dock 仍显示旧图标）。
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=windows-app-manifest.rc");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        embed_resource::compile_for_everything("windows-app-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect("compile Windows application manifest");
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let attributes = tauri_build::Attributes::new().windows_attributes(windows);
        tauri_build::try_build(attributes).expect("failed to run Tauri build script");
    }
    #[cfg(not(windows))]
    tauri_build::build()
}
