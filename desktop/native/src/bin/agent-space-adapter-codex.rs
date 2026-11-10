fn main() {
    if let Err(error) = agent_space_native::run_codex_plugin() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
