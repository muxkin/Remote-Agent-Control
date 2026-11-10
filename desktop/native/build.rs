fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var_os("CARGO_FEATURE_ELY").is_some()
    {
        println!("cargo:rerun-if-changed=agent-space.rc");
        println!("cargo:rerun-if-changed=../../assets/branding/agent-space.ico");
        embed_resource::compile_for(
            "agent-space.rc",
            ["agent-space-native"],
            embed_resource::NONE,
        )
        .manifest_required()
        .expect("embed Agent Space executable icon");
    }
}
