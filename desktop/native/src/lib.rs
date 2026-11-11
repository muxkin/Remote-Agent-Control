#[cfg(feature = "official-plugins")]
mod app_tools;
mod appearance;
mod appearance_cli;
mod conversations;

#[cfg(feature = "official-plugins")]
mod codex;
mod codex_backend;
mod codex_live;
#[cfg(feature = "official-plugins")]
mod codex_peer;
mod codex_service;
mod device;
mod direct;
#[cfg(feature = "official-plugins")]
mod dsh;
#[cfg(feature = "official-plugins")]
mod dsh_events;
#[cfg(feature = "official-plugins")]
mod dsh_live;
#[cfg(feature = "official-plugins")]
mod dsh_media;
#[cfg(feature = "official-plugins")]
mod dsh_settings;
mod files;
mod gateway;
mod history_media;
mod im_agent;
mod im_attachments;
mod im_calls;
mod im_cli;
mod im_client;
mod im_crypto;
mod im_interactions;
mod migration;
mod operations;
mod plugin_catalog;
mod plugin_host;
#[cfg(feature = "official-plugins")]
mod plugin_server;
mod plugins;
mod queue;
#[cfg(feature = "official-plugins")]
mod reply_fork;
mod requests;
mod settings;
mod state;
mod storage;
#[cfg(feature = "official-plugins")]
mod tool_activity;
#[cfg(feature = "official-plugins")]
mod tools_catalog;
mod update;
mod update_install;
#[cfg(target_os = "linux")]
mod update_linux;
mod update_preferences;
mod usage;

#[cfg(windows)]
mod windows;

#[cfg(feature = "desktop")]
mod desktop_shell;
mod management;

use anyhow::{Context, Result, bail, ensure};
use gateway::{Phase, RelayConfig, Snapshot};
use std::{
    env,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{
    runtime::Runtime,
    sync::{mpsc, watch},
};

pub fn start() -> Result<()> {
    install_tls()?;
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.first().is_some_and(|flag| flag == "--im") {
        return im_cli::run(&arguments[1..]);
    }
    if arguments.first().is_some_and(|flag| flag == "--im-call") {
        return im_calls::cli(&arguments[1..]);
    }
    let directory = env::var_os("POCKET_NATIVE_STATE_DIR")
        .map(PathBuf::from)
        .or_else(state::default_directory)
        .context("无法定位状态目录")?;
    let directory = std::path::absolute(directory)?;
    if arguments
        .first()
        .is_some_and(|flag| flag == "--import-node-state")
    {
        let (source, origin) = match &arguments[1..] {
            [source] => (source, None),
            [source, flag, origin] if flag == "--origin" => (source, Some(origin.as_str())),
            _ => {
                bail!("用法: agent-space-native --import-node-state 旧状态目录 [--origin 服务地址]")
            }
        };
        migration::import(std::path::Path::new(source), &directory, origin)?;
        println!("已导入旧版配对和适配器状态");
        return Ok(());
    }
    if arguments.first().is_some_and(|flag| flag == "--adapter") {
        return plugin_catalog::cli(&directory, &arguments[1..]);
    }
    if arguments.first().is_some_and(|flag| flag == "--instance") {
        migration::initialize(&directory)?;
        return appearance_cli::run(&directory, &arguments[1..]);
    }
    if arguments
        .first()
        .is_some_and(|flag| flag == update::APPLY_FLAG)
    {
        let headless = arguments.get(3).is_some_and(|value| value == "--headless");
        ensure!(
            arguments.len() == 3 || (arguments.len() == 4 && headless),
            "更新交接参数无效"
        );
        return update::apply(
            std::path::Path::new(&arguments[1]),
            std::path::Path::new(&arguments[2]),
            &directory,
            headless,
        );
    }
    let executable = env::current_exe()?;
    let headless = arguments.iter().any(|value| value == "--headless");
    let configure = arguments.iter().any(|value| value == "--configure");
    let background = arguments.iter().any(|value| value == "--background");
    let print_settings = arguments.iter().any(|value| value == "--print-settings");
    let print_pair = arguments.iter().any(|value| value == "--print-pair");
    ensure!(
        arguments.iter().all(|value| matches!(
            value.as_str(),
            "--headless" | "--print-pair" | "--print-settings" | "--configure" | "--background"
        )) && (!print_pair || headless)
            && (!configure || !headless)
            && (!background || (!headless && !configure && !print_settings))
            && (!print_settings || !headless),
        "用法: agent-space-native [--configure | --background | --headless [--print-pair]] [--print-settings]"
    );
    let runtime = Runtime::new()?;
    let owner = if headless {
        None
    } else if let Some(owner) = management::claim(&directory)? {
        Some(owner)
    } else if background {
        return Ok(());
    } else {
        return runtime.block_on(management::reopen(&directory, print_settings));
    };
    migration::initialize(&directory)?;
    let source = migration::source();
    let environment = migration::GatewayEnvironment::load(&directory, source)?;
    let configured_origin = if configure {
        None
    } else {
        let origin = env::var("POCKET_NATIVE_ORIGIN")
            .ok()
            .filter(|value| !value.is_empty())
            .or(state::saved_origin(&directory)?)
            .or_else(|| environment.origin().map(str::to_owned));
        if origin.is_none()
            && (source.is_some() || env::var_os("POCKET_NATIVE_LEGACY_DESKTOP_SETTINGS").is_some())
        {
            update_preferences::legacy_origin()?
        } else {
            origin
        }
    };
    let enrollment = env::var("POCKET_NATIVE_ENROLLMENT")
        .ok()
        .or_else(|| {
            configured_origin
                .as_deref()
                .and_then(|origin| environment.enrollment_for(origin))
                .map(str::to_owned)
        })
        .unwrap_or_default();
    let bundled = runtime.block_on(plugin_catalog::provision_official(&executable, &directory))?;
    let (state, updates) = watch::channel(Snapshot::default());
    let (pair, commands) = mpsc::channel(1);
    let (update_commands, update_requests) = mpsc::channel(8);
    let mut update_requests = Some(update_requests);
    let mut commands = Some(commands);
    let handle = runtime.handle().clone();
    let im_workers = im_agent::Workers::default();
    let im_runtime = im_workers.clone();
    let run_directory = directory.clone();
    let run_executable = executable.clone();
    let mut connect = move |origin: &str, enrollment: String| -> Result<String> {
        let mut config = RelayConfig::new(origin, enrollment)?;
        let db = Arc::new(Mutex::new(state::Store::open(&directory)?));
        let (plugins, codex) = plugins::Registry::load(&directory, &handle, bundled, &environment)?;
        config.codex = codex_backend::Group::load(&directory, &handle, codex, bundled)?;
        let transports = storage::Transports::load(&directory, &config.origin, &environment)?;
        config.plugins = plugins;
        config.direct = transports.direct;
        config.storage = transports.storage;
        if let Some(storage) = config.storage.clone() {
            handle.spawn(storage.cleanup_expired(db.clone()));
        }
        let origin = config.origin.origin().ascii_serialization();
        let receiver = commands.take().context("连接已初始化")?;
        let gate = update::UpdateGate::default();
        im_agent::start(
            &directory,
            &handle,
            &im_runtime,
            gate.clone(),
            state.clone(),
            &environment,
        );
        handle.spawn(update::run(
            config.origin.clone(),
            executable.clone(),
            directory.clone(),
            db.clone(),
            gate.clone(),
            update_requests.take().context("连接已初始化")?,
            state.clone(),
            &environment,
            headless,
        ));
        handle.spawn(gateway::run(config, db, receiver, state.clone(), gate));
        Ok(origin)
    };
    let (origin, error) = match configured_origin {
        Some(origin) => match connect(&origin, enrollment) {
            Ok(origin) => (Some(origin), None),
            Err(error) if headless => return Err(error),
            Err(error) => (None, Some(error.to_string())),
        },
        None => (None, None),
    };

    let result = if let Some(owner) = owner {
        let manager = management::Manager::start(
            &runtime,
            owner,
            management::Startup {
                origin,
                error,
                connect: Box::new(connect),
            },
            updates.clone(),
            pair,
            update_commands,
        )?;
        let exit = run_managed(&runtime, &manager, updates, background, print_settings);
        runtime.block_on(im_workers.shutdown());
        drop(runtime);
        drop(manager);
        if matches!(exit?, management::Exit::Configure) {
            std::process::Command::new(run_executable)
                .arg("--configure")
                .env("POCKET_NATIVE_STATE_DIR", run_directory)
                .spawn()
                .context("无法重新打开连接设置")?;
        }
        Ok(())
    } else {
        ensure!(origin.is_some(), "请先设置 POCKET_NATIVE_ORIGIN");
        let result = runtime.block_on(run_headless(updates, pair, print_pair));
        runtime.block_on(im_workers.shutdown());
        result
    };
    result
}

fn run_managed(
    runtime: &Runtime,
    manager: &management::Manager,
    mut updates: watch::Receiver<Snapshot>,
    background: bool,
    print_settings: bool,
) -> Result<management::Exit> {
    let (tray_events, mut events) = mpsc::unbounded_channel();
    #[cfg(not(feature = "desktop"))]
    drop(tray_events);
    #[cfg(feature = "desktop")]
    let _desktop_events = desktop_shell::prepare(tray_events.clone());
    #[cfg(feature = "desktop")]
    let tray = {
        if let Err(error) = desktop_shell::register_launcher() {
            eprintln!("无法注册应用入口：{error}");
        }
        match desktop_shell::install(tray_events) {
            Ok(tray) => Some(tray),
            Err(error) => {
                eprintln!("托盘不可用，适配器将在后台继续运行：{error}");
                None
            }
        }
    };

    if !background && let Err(error) = manager.state.open(print_settings) {
        eprintln!("{error}");
    }
    let mut stop = manager.stop.clone();
    let panel = manager.state.clone();
    let future = async move {
        let shutdown = shutdown_signal();
        tokio::pin!(shutdown);
        loop {
            if let Some(exit) = *stop.borrow_and_update() {
                return Ok(exit);
            }
            if updates.borrow_and_update().exit_for_update {
                return Ok(management::Exit::Quit);
            }
            tokio::select! {
                change = stop.changed() => change?,
                change = updates.changed() => change?,
                result = &mut shutdown => {
                    result?;
                    return Ok(management::Exit::Quit);
                }
                Some(event) = events.recv() => match event {
                    management::TrayEvent::Open => {
                        if let Err(error) = panel.open(false) {
                            eprintln!("{error}");
                        }
                    }
                    management::TrayEvent::CheckUpdate => {
                        panel.check_update();
                        if let Err(error) = panel.open(false) {
                            eprintln!("{error}");
                        }
                    }
                    management::TrayEvent::Quit => return Ok(management::Exit::Quit),
                }
            }
        }
    };
    #[cfg(feature = "desktop")]
    if tray.is_some() {
        return desktop_shell::drive(runtime, future)?;
    }
    runtime.block_on(future)
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            signal = tokio::signal::ctrl_c() => signal?,
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

#[cfg(feature = "official-plugins")]
pub fn run_dsh_plugin() -> Result<()> {
    install_tls()?;
    Runtime::new()?.block_on(plugin_server::run_dsh())
}

#[cfg(feature = "official-plugins")]
pub fn run_codex_plugin() -> Result<()> {
    install_tls()?;
    Runtime::new()?.block_on(plugin_server::run_codex())
}

fn install_tls() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("无法初始化 TLS 加密提供程序"))
}

async fn run_headless(
    mut updates: watch::Receiver<Snapshot>,
    pair: mpsc::Sender<()>,
    print_pair: bool,
) -> Result<()> {
    let mut requested = false;
    let mut printed = false;
    let mut last_phase = Phase::Setup;
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        let state = updates.borrow_and_update().clone();
        if state.exit_for_update {
            return Ok(());
        }
        if last_phase != state.phase {
            if state.phase == Phase::Online {
                println!("中继已连接");
            }
            last_phase = state.phase.clone();
        }
        if state.phase == Phase::Online && print_pair && !requested {
            pair.send(()).await?;
            requested = true;
        }
        if let Some(code) = state.pairing.filter(|_| !printed && print_pair) {
            println!("{}", code.link);
            printed = true;
        }
        tokio::select! {
            change = updates.changed() => {
                if change.is_err() {
                    bail!("网关已退出");
                }
            }
            result = &mut shutdown => {
                result?;
                return Ok(());
            }
        }
    }
}
