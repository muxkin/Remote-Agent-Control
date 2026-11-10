#![cfg_attr(all(windows, feature = "ely"), windows_subsystem = "windows")]
mod app_tools;
mod conversations;

mod codex;
mod codex_live;
mod codex_peer;
mod device;
mod direct;
mod files;
mod gateway;
mod history_media;
mod managed;
mod operations;
mod queue;
mod reply_fork;
mod requests;
mod settings;
mod state;
mod storage;
mod tool_activity;
mod tools_catalog;
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
    let executable = env::current_exe()?;
    let payload = managed::payload(&executable);
    let directory = env::var_os("POCKET_NATIVE_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::data_local_dir().map(|path| path.join("agent-space-native-preview")))
        .context("无法定位状态目录")?;
    let directory = std::path::absolute(directory)?;
    if let Some(flag @ ("--adapter" | "--im" | "--im-call")) = arguments.first().map(String::as_str)
    {
        let root = payload.context("此构建没有附带插件网关")?;
        let origin =
            state::saved_origin(&directory)?.unwrap_or_else(|| "http://127.0.0.1:4317".into());
        return if flag == "--adapter" {
            managed::adapter_cli(&root, &directory, &origin, &arguments[1..])
        } else {
            managed::im_cli(
                &root,
                &directory,
                &origin,
                flag == "--im-call",
                &arguments[1..],
            )
        };
    }
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
    let (stop, stopping) = watch::channel(false);
    let managed_task = Arc::new(Mutex::new(None));
    let task = managed_task.clone();
    let mut installs = Some(installs);
    let mut commands = Some(commands);
    let handle = runtime.handle().clone();
    let mut connect = move |origin: &str, enrollment: String| -> Result<String> {
        let mut config = RelayConfig::new(origin, enrollment)?;
        if let Some(root) = &payload {
            let origin = config.origin.origin().ascii_serialization();
            let gateway = managed::Gateway {
                root: root.clone(),
                directory: directory.clone(),
                executable: executable.clone(),
                origin: origin.clone(),
                enrollment: config.enrollment,
                lock: state::lock_directory(&directory)?,
            };
            let commands = commands.take().context("连接已初始化")?;
            let installs = installs.take().context("连接已初始化")?;
            let stopping = stopping.clone();
            let state = state.clone();
            *task.lock().unwrap() = Some(handle.spawn(async move {
                if let Err(error) = gateway
                    .run(commands, installs, stopping, state.clone())
                    .await
                {
                    eprintln!("{error:#}");
                    state.send_modify(|current| current.phase = Phase::Unavailable);
                }
            }));
            return Ok(origin);
        }
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
        config.direct = transports.direct;
        config.storage = transports.storage;
        let origin = config.origin.origin().ascii_serialization();
        let receiver = commands.take().context("连接已初始化")?;
        handle.spawn(gateway::run(config, db, receiver, state.clone()));
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

    let result = if headless {
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
    };
    let _ = stop.send(true);
    if let Some(task) = managed_task.lock().unwrap().take() {
        let _ = runtime.block_on(task);
    }
    result
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
