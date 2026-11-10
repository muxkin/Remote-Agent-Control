use crate::codex_live::Outcome;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
    time::{Instant, timeout},
};
use uuid::Uuid;

const VERSION: &str = "0.167.0-alpha.3.2";
const CLIENT: &str = "pocket_reply_fork";
const LINE_LIMIT: u64 = 256 * 1024;

#[derive(Clone, Default)]
pub struct ReplyFork {
    executable: Option<PathBuf>,
    checked: Arc<Mutex<Option<Instant>>>,
    supported: Arc<AtomicBool>,
}

impl ReplyFork {
    pub fn new(desktop: Option<&Path>, cli: Option<&Path>) -> Self {
        let executable = cli
            .map(Path::to_path_buf)
            .or_else(|| desktop.and_then(cli_for_desktop))
            .filter(|path| path.is_absolute());
        Self {
            executable,
            ..Default::default()
        }
    }

    async fn command(&self) -> Option<Command> {
        let executable = self.executable.clone();
        #[cfg(windows)]
        let executable = match executable {
            Some(path) => Some(path),
            None => tokio::task::spawn_blocking(crate::codex_peer::windows_executable)
                .await
                .ok()
                .and_then(Result::ok)
                .as_deref()
                .and_then(cli_for_desktop),
        };
        let mut command = Command::new(executable?);
        command.kill_on_drop(true).stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        Some(command)
    }

    pub fn supported(&self) -> bool {
        self.supported.load(Ordering::Relaxed)
    }

    pub async fn probe(&self) {
        let mut checked = self.checked.lock().await;
        if checked.is_some_and(|time| time.elapsed() < Duration::from_secs(30)) {
            return;
        }
        let supported = match self.command().await {
            Some(mut cmd) => timeout(Duration::from_secs(2), cmd.arg("--version").output())
                .await
                .ok()
                .and_then(Result::ok)
                .filter(|output| output.status.success())
                .map(|output| {
                    String::from_utf8_lossy(&output.stdout).trim() == format!("codex-cli {VERSION}")
                }),
            None => Some(false),
        };
        // A failed or timed-out process gives no evidence about the installed version.
        self.supported
            .store(supported.unwrap_or(false), Ordering::Relaxed);
        *checked = supported.map(|_| Instant::now());
    }

    pub async fn fork(&self, home: &Path, thread: &str, turn: &str) -> Outcome {
        if !self.supported() {
            self.probe().await;
        }
        if !self.supported() {
            return Outcome::Rejected("此桌面版本尚未验证指定回复分支接口".into());
        }
        let mut dispatched = false;
        let result = timeout(
            Duration::from_secs(15),
            self.run(home, thread, turn, &mut dispatched),
        )
        .await;
        match result {
            Ok(Ok(outcome)) => outcome,
            _ if dispatched => Outcome::Uncertain,
            _ => Outcome::Rejected("本机分支接口暂不可用".into()),
        }
    }

    async fn run(
        &self,
        home: &Path,
        thread: &str,
        turn: &str,
        dispatched: &mut bool,
    ) -> Result<Outcome> {
        let mut child = self
            .command()
            .await
            .context("没有可用的桌面分支程序")?
            .args(["app-server", "--listen", "stdio://"])
            .env("CODEX_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let mut input = child.stdin.take().context("分支请求流不可用")?;
        let mut output = BufReader::new(child.stdout.take().context("分支响应流不可用")?);
        write(
            &mut input,
            json!({"id":1,"method":"initialize","params":{
                "clientInfo":{"name":CLIENT,"version":"1.0.0"},
            }}),
        )
        .await?;
        let initial = read(&mut output, 1).await?;
        ensure!(
            initial["result"]["userAgent"]
                .as_str()
                .is_some_and(|agent| { agent.starts_with(&format!("{CLIENT}/{VERSION} ")) }),
            "Codex 分支协议版本未经验证"
        );
        write(&mut input, json!({"method":"initialized"})).await?;
        *dispatched = true;
        write(
            &mut input,
            json!({"id":2,"method":"thread/fork","params":{
                "threadId":thread,"lastTurnId":turn,"excludeTurns":true,"threadSource":"user",
            }}),
        )
        .await?;
        let result = read(&mut output, 2).await?;
        if result["error"]["code"] == -32600 {
            return Ok(Outcome::Rejected(
                "无法从所选回复创建分支，请刷新后重试".into(),
            ));
        }
        let fork = &result["result"]["thread"];
        ensure!(fork["forkedFromId"] == thread, "分支来源未经确认");
        let id = Uuid::parse_str(fork["id"].as_str().context("缺少分支 ID")?)?;
        ensure!(id.to_string() != thread, "返回了原会话");
        Ok(Outcome::Completed(Some(id)))
    }
}

fn cli_for_desktop(desktop: &Path) -> Option<PathBuf> {
    let root = desktop.parent()?;
    let resources = if cfg!(target_os = "macos") {
        root.parent()?.join("Resources")
    } else {
        root.join("resources")
    };
    Some(resources.join(if cfg!(windows) { "codex.exe" } else { "codex" }))
}

async fn write(output: &mut (impl AsyncWrite + Unpin), value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    output.write_all(&bytes).await?;
    output.flush().await?;
    Ok(())
}

async fn read(input: &mut (impl AsyncBufReadExt + Unpin), id: u64) -> Result<Value> {
    let mut line = Vec::new();
    loop {
        line.clear();
        input.take(LINE_LIMIT).read_until(b'\n', &mut line).await?;
        ensure!(line.last() == Some(&b'\n'), "分支响应不完整");
        let value: Value = serde_json::from_slice(&line)?;
        if value["id"] == id {
            return Ok(value);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test]
    async fn retries_a_transient_cli_probe_failure() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let cli = directory.path().join("codex");
        fs::write(&cli, "#!/bin/sh\nexit 1\n")?;
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700))?;
        let service = ReplyFork::new(None, Some(&cli));
        service.probe().await;
        assert!(!service.supported());

        fs::write(
            &cli,
            format!("#!/bin/sh\nprintf 'codex-cli {VERSION}\\n'\n"),
        )?;
        service.probe().await;
        assert!(service.supported());
        Ok(())
    }
}
