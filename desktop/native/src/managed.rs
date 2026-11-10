use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use std::{
    env,
    fs::File,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, watch},
};

use crate::{
    gateway::{DisplayPairing, ManagedAgent, Phase, Snapshot},
    state,
};

pub fn payload(executable: &Path) -> Option<PathBuf> {
    let parent = executable.parent()?;
    env::var_os("POCKET_NATIVE_GATEWAY_PAYLOAD")
        .map(PathBuf::from)
        .or_else(|| {
            let root = if cfg!(target_os = "macos") {
                parent.parent()?.join("Resources/gateway")
            } else if cfg!(target_os = "linux") && parent == Path::new("/usr/bin") {
                PathBuf::from("/usr/lib/agent-space-native/gateway")
            } else {
                parent.join("gateway")
            };
            root.join("package.json").is_file().then_some(root)
        })
}

fn command(root: &Path, directory: &Path, origin: &str) -> std::process::Command {
    let executable = if cfg!(windows) {
        "runtime/node.exe"
    } else {
        "runtime/node"
    };
    let mut child = std::process::Command::new(root.join(executable));
    child
        .current_dir(root)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("POCKET_STATE_DIR", directory)
        .env("POCKET_PUBLIC_ORIGIN", origin)
        .env("POCKET_NATIVE_VERSION", env!("CARGO_PKG_VERSION"))
        .env(
            "POCKET_PYTHON",
            root.join(if cfg!(windows) {
                "python/python.exe"
            } else {
                "python/bin/python3"
            }),
        );
    if env::var_os("POCKET_ENV_FILE").is_none() {
        let path = directory.join("gateway.env");
        if path.exists() {
            child.env("POCKET_ENV_FILE", path);
        }
    }
    for (source, target) in [
        ("POCKET_NATIVE_CODEX_HOME", "CODEX_HOME"),
        ("POCKET_NATIVE_CODEX_SOCKET", "POCKET_CODEX_SOCKET"),
        ("POCKET_NATIVE_CODEX_EXECUTABLE", "POCKET_CODEX_EXECUTABLE"),
        ("POCKET_NATIVE_CODEX_APP_TOOLS", "POCKET_CODEX_APP_TOOLS"),
        ("POCKET_NATIVE_CODEX_CLI", "POCKET_CODEX_CLI"),
        ("POCKET_NATIVE_READ_ONLY", "POCKET_READ_ONLY"),
        ("POCKET_NATIVE_P2P", "POCKET_P2P"),
    ] {
        if let Some(value) = env::var_os(source) {
            child.env(target, value);
        }
    }
    child.arg("--import").arg(root.join("scripts/env.mjs"));
    child
}

pub fn adapter_cli(root: &Path, directory: &Path, origin: &str, args: &[String]) -> Result<()> {
    let mut child = command(root, directory, origin);
    let instances = directory.join("instances.json");
    if instances.is_file()
        && env::var_os("POCKET_ADAPTERS_FILE").is_none()
        && env::var_os("POCKET_BACKENDS_FILE").is_none()
    {
        child.env("POCKET_NATIVE_DEFAULT_INSTANCES", instances);
    }
    let status = child
        .arg(root.join("dist/server/adapters/cli.js"))
        .args(args)
        .status()?;
    ensure!(status.success(), "插件管理命令执行失败");
    Ok(())
}

pub fn im_cli(
    root: &Path,
    directory: &Path,
    origin: &str,
    calls: bool,
    args: &[String],
) -> Result<()> {
    let entry = if calls {
        "desktop-call-cli.js"
    } else {
        "desktop-im-cli.js"
    };
    let status = command(root, directory, origin)
        .arg(root.join("dist/server").join(entry))
        .args(args)
        .status()?;
    ensure!(status.success(), "独立 Agent 命令执行失败");
    Ok(())
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Event {
    Status {
        #[serde(default)]
        relay_connected: bool,
        #[serde(default)]
        agents: Vec<ManagedAgent>,
        pairing: Option<PairStatus>,
        #[serde(default)]
        update: String,
        #[serde(default)]
        manual_update: bool,
    },
    Pair {
        link: String,
        expires_at: i64,
    },
    ExitForUpdate,
}

#[derive(Deserialize)]
struct PairStatus {
    state: String,
}

pub struct Gateway {
    pub root: PathBuf,
    pub directory: PathBuf,
    pub executable: PathBuf,
    pub origin: String,
    pub enrollment: String,
    pub lock: File,
}

impl Gateway {
    pub async fn run(
        self,
        mut pair: mpsc::Receiver<()>,
        mut install: mpsc::Receiver<()>,
        mut stop: watch::Receiver<bool>,
        state: watch::Sender<Snapshot>,
    ) -> Result<()> {
        let _lock = self.lock;
        let mut child = Command::from(command(&self.root, &self.directory, &self.origin));
        child
            .arg(self.root.join("scripts/native-manager.mjs"))
            .arg(&self.executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if !self.enrollment.is_empty() {
            child.env("POCKET_RELAY_ENROLLMENT", self.enrollment);
        }
        #[cfg(windows)]
        child.creation_flags(0x0800_0000);
        state.send_modify(|current| current.phase = Phase::Connecting);
        let mut child = child.spawn().context("无法启动插件网关")?;
        let mut input = child.stdin.take().context("插件网关控制通道不可用")?;
        let mut lines =
            BufReader::new(child.stdout.take().context("插件网关状态通道不可用")?).lines();
        let mut saved = false;
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Some(line) = line? else { break };
                    match serde_json::from_str(&line)? {
                        Event::Status { relay_connected, agents, pairing, update, manual_update } => {
                            if relay_connected && !saved {
                                let _ = state::remember_origin(&self.directory, &self.origin);
                                saved = true;
                            }
                            state.send_modify(|current| {
                                current.phase = if relay_connected { Phase::Online } else { Phase::Unavailable };
                                current.agents = agents;
                                current.update = update;
                                current.manual_update = manual_update;
                                if pairing.is_none_or(|pair| pair.state != "ready") {
                                    current.pairing = None;
                                }
                            });
                        }
                        Event::Pair { link, expires_at } => state.send_modify(|current| {
                            current.pairing = Some(DisplayPairing { link, expires_at });
                        }),
                        Event::ExitForUpdate => state.send_modify(|current| current.exit_for_update = true),
                    }
                }
                Some(()) = pair.recv() => input.write_all(b"pair\n").await?,
                Some(()) = install.recv() => input.write_all(b"install-update\n").await?,
                _ = stop.changed() => break,
            }
        }
        drop(input);
        let status = tokio::time::timeout(Duration::from_secs(15), child.wait()).await??;
        ensure!(status.success(), "插件网关退出异常");
        Ok(())
    }
}
