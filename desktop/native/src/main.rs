#![cfg_attr(all(windows, feature = "ely"), windows_subsystem = "windows")]
mod app_tools;
mod conversations;

mod codex;
mod codex_live;
mod codex_peer;
mod device;
mod direct;
mod dsh;
mod dsh_events;
mod dsh_live;
mod dsh_media;
mod dsh_settings;
mod files;
mod gateway;
mod history_media;
mod operations;
mod plugins;
mod queue;
mod reply_fork;
mod requests;
mod settings;
mod state;
mod storage;
mod tool_activity;
mod tools_catalog;
mod update;
mod update_install;
mod usage;

#[cfg(windows)]
mod windows;

#[cfg(feature = "ely")]
mod desktop_shell;
#[cfg(feature = "ely")]
mod ui;

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

fn main() {
    if let Err(error) = start() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn start() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("无法初始化 TLS 加密提供程序"))?;
    let arguments: Vec<String> = env::args().skip(1).collect();
    let directory = env::var_os("POCKET_NATIVE_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::data_local_dir().map(|path| path.join("agent-space-native-preview")))
        .context("无法定位状态目录")?;
    let directory = std::path::absolute(directory)?;
    if arguments
        .first()
        .is_some_and(|flag| flag == update::APPLY_FLAG)
    {
        ensure!(arguments.len() == 3, "更新交接参数无效");
        return update::apply(
            std::path::Path::new(&arguments[1]),
            std::path::Path::new(&arguments[2]),
            &directory,
        );
    }
    let executable = env::current_exe()?;
    let headless = arguments.iter().any(|value| value == "--headless");
    let configure = arguments.iter().any(|value| value == "--configure");
    let background = arguments.iter().any(|value| value == "--background");
    let print_pair = arguments.iter().any(|value| value == "--print-pair");
    ensure!(
        arguments.iter().all(|value| matches!(
            value.as_str(),
            "--headless" | "--print-pair" | "--configure" | "--background"
        )) && (!print_pair || headless)
            && (!configure || !headless)
            && (!background || (!headless && !configure)),
        "用法: agent-space-native [--configure | --background | --headless [--print-pair]]"
    );
    let configured_origin = if configure {
        None
    } else {
        env::var("POCKET_NATIVE_ORIGIN")
            .ok()
            .filter(|value| !value.is_empty())
            .or(state::saved_origin(&directory)?)
    };
    let runtime = Runtime::new()?;
    let (state, updates) = watch::channel(Snapshot::default());
    let (pair, commands) = mpsc::channel(1);
    let (install, installs) = mpsc::channel(1);
    let mut installs = Some(installs);
    let mut commands = Some(commands);
    let handle = runtime.handle().clone();
    let mut connect = move |origin: &str, enrollment: String| -> Result<String> {
        let mut config = RelayConfig::new(origin, enrollment)?;
        let explicit = env::var_os("POCKET_NATIVE_CODEX_HOME");
        let home = explicit
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| env::var_os("CODEX_HOME").map(PathBuf::from))
            .or_else(|| dirs::home_dir().map(|path| path.join(".codex")));
        if let Some(home) = home {
            match codex::History::open(&home) {
                Ok(history) => {
                    config.history = Some(history.clone());
                    if env::var("POCKET_NATIVE_READ_ONLY").as_deref() != Ok("1") {
                        config.desktop = codex_peer::Endpoint::discover(&home)
                            .map(|endpoint| codex_live::Desktop::new(endpoint, history));
                    }
                }
                Err(error) if explicit.is_some() => {
                    return Err(error).context("无法读取 Codex 会话索引");
                }
                Err(_) => {}
            }
        }
        let db = Arc::new(Mutex::new(state::Store::open(&directory)?));
        let transports = storage::Transports::load(&directory)?;
        config.plugins = plugins::Registry::load(&directory)?;
        config.direct = transports.direct;
        config.storage = transports.storage;
        let origin = config.origin.origin().ascii_serialization();
        let receiver = commands.take().context("连接已初始化")?;
        let gate = update::UpdateGate::default();
        if !headless {
            handle.spawn(update::run(
                config.origin.clone(),
                executable.clone(),
                directory.clone(),
                db.clone(),
                gate.clone(),
                installs.take().context("连接已初始化")?,
                state.clone(),
            ));
        }
        handle.spawn(gateway::run(config, db, receiver, state.clone(), gate));
        Ok(origin)
    };
    let configured = if let Some(origin) = configured_origin {
        Some(connect(
            &origin,
            env::var("POCKET_NATIVE_ENROLLMENT").unwrap_or_default(),
        )?)
    } else {
        None
    };

    if headless {
        ensure!(configured.is_some(), "请先设置 POCKET_NATIVE_ORIGIN");
        runtime.block_on(run_headless(updates, pair, print_pair))
    } else {
        #[cfg(feature = "ely")]
        {
            ui::run(
                updates,
                pair,
                install,
                configured,
                Box::new(connect),
                background,
            )
        }
        #[cfg(not(feature = "ely"))]
        {
            let _ = install;
            Err(anyhow::anyhow!(
                "此二进制没有编译 Ely 界面，请使用 --headless"
            ))
        }
    }
}

async fn run_headless(
    mut updates: watch::Receiver<Snapshot>,
    pair: mpsc::Sender<()>,
    print_pair: bool,
) -> Result<()> {
    let mut requested = false;
    let mut printed = false;
    let mut last_phase = Phase::Setup;
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
            result = tokio::signal::ctrl_c() => {
                result?;
                return Ok(());
            }
        }
    }
}
