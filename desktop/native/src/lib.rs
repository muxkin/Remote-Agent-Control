mod app_tools;
mod appearance;
mod appearance_cli;
mod conversations;

mod codex;
mod codex_backend;
mod codex_live;
mod codex_peer;
mod codex_service;
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
mod reply_fork;
mod requests;
mod settings;
mod state;
mod storage;
mod tool_activity;
mod tools_catalog;
mod update;
mod update_install;
mod update_preferences;
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
        .or_else(|| dirs::data_local_dir().map(|path| path.join("agent-space-native-preview")))
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
    let runtime = Runtime::new()?;
    let bundled = runtime.block_on(plugin_catalog::provision_official(&executable, &directory))?;
    let (state, updates) = watch::channel(Snapshot::default());
    let (pair, commands) = mpsc::channel(1);
    let (update_commands, update_requests) = mpsc::channel(8);
    let mut update_requests = Some(update_requests);
    let mut commands = Some(commands);
    let handle = runtime.handle().clone();
    let im_workers = im_agent::Workers::default();
    let im_runtime = im_workers.clone();
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
        if !headless {
            handle.spawn(update::run(
                config.origin.clone(),
                executable.clone(),
                directory.clone(),
                db.clone(),
                gate.clone(),
                update_requests.take().context("连接已初始化")?,
                state.clone(),
                &environment,
            ));
        }
        handle.spawn(gateway::run(config, db, receiver, state.clone(), gate));
        Ok(origin)
    };
    let configured = if let Some(origin) = configured_origin {
        Some(connect(&origin, enrollment)?)
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
                update_commands,
                configured,
                Box::new(connect),
                background,
            )
        }
        #[cfg(not(feature = "ely"))]
        {
            let _ = update_commands;
            Err(anyhow::anyhow!(
                "此二进制没有编译 Ely 界面，请使用 --headless"
            ))
        }
    };
    runtime.block_on(im_workers.shutdown());
    result
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
