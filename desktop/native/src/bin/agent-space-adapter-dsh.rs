fn main() {
    if let Err(error) = agent_space_native::run_dsh_plugin() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
