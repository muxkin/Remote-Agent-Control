#![cfg_attr(all(windows, feature = "desktop"), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = agent_space_native::start() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
