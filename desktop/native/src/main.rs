#![cfg_attr(all(windows, feature = "ely"), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = agent_space_native::start() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
