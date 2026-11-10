use anyhow::Result;
#[cfg(unix)]
use anyhow::{Context, bail, ensure};
use std::{
    env,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite};

pub trait Transport: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Transport for T {}
pub type Stream = Box<dyn Transport>;

#[derive(Clone)]
pub struct Endpoint {
    socket: PathBuf,
    executable: Option<PathBuf>,
}

impl Endpoint {
    pub fn discover(home: &Path) -> Option<Self> {
        let socket = env::var_os("POCKET_NATIVE_CODEX_SOCKET")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    PathBuf::from(r"\\.\pipe\codex-ipc")
                } else {
                    home.join("ipc/ipc.sock")
                }
            });
        let executable = env::var_os("POCKET_NATIVE_CODEX_EXECUTABLE")
            .map(PathBuf::from)
            .or_else(|| {
                if cfg!(target_os = "linux") {
                    Some(PathBuf::from("/usr/lib/chatgpt/ChatGPT"))
                } else if cfg!(target_os = "macos") {
                    let candidates = [
                        "/Applications/Codex.app/Contents/MacOS/Codex",
                        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
                    ]
                    .into_iter()
                    .map(PathBuf::from)
                    .filter(|path| path.is_file())
                    .collect::<Vec<_>>();
                    (candidates.len() == 1).then(|| candidates[0].clone())
                } else {
                    None
                }
            });
        Some(Self { socket, executable })
    }

    pub fn executable(&self) -> Option<&Path> {
        self.executable.as_deref()
    }

    pub async fn open(&self) -> Result<Stream> {
        tokio::time::timeout(Duration::from_secs(5), self.connect(false)).await?
    }

    pub async fn open_app_tools(&self) -> Result<Stream> {
        let socket = env::var_os("POCKET_NATIVE_CODEX_APP_TOOLS").map(PathBuf::from);
        #[cfg(unix)]
        let socket = socket.or_else(|| {
            let root = if cfg!(target_os = "linux") {
                PathBuf::from("/tmp")
            } else {
                env::temp_dir()
            };
            let uid = rustix::process::geteuid().as_raw();
            let candidates: Vec<_> = [
                root.join(format!("codex-app-tools-{uid}")),
                root.join("codex-app-tools"),
            ]
            .iter()
            .filter_map(|directory| std::fs::read_dir(directory).ok())
            .flatten()
            .filter_map(|entry| {
                use std::os::unix::fs::FileTypeExt;
                let entry = entry.ok()?;
                let path = entry.path();
                (entry.file_type().ok()?.is_socket()
                    && path.extension()?.eq_ignore_ascii_case("sock")
                    && uuid::Uuid::parse_str(path.file_stem()?.to_str()?).is_ok())
                .then_some(path)
            })
            .collect();
            (candidates.len() == 1).then(|| candidates[0].clone())
        });
        let endpoint = Self {
            socket: socket
                .ok_or_else(|| anyhow::anyhow!("本机桌面应用工具不可用或存在多个端点"))?,
            executable: self.executable.clone(),
        };
        tokio::time::timeout(Duration::from_secs(5), endpoint.connect(true)).await?
    }

    #[cfg(unix)]
    async fn connect(&self, app_tools: bool) -> Result<Stream> {
        use std::os::unix::{
            ffi::OsStrExt,
            fs::{FileTypeExt, MetadataExt},
        };
        let uid = rustix::process::geteuid();
        let parent = self.socket.parent().context("Codex Socket 路径无效")?;
        let directory = std::fs::symlink_metadata(parent)?;
        let socket = std::fs::symlink_metadata(&self.socket)?;
        ensure!(
            directory.is_dir()
                && directory.uid() == uid.as_raw()
                && (directory.mode() & 0o777 == 0o700
                    || (app_tools && directory.mode() & 0o777 == 0o755))
                && socket.file_type().is_socket()
                && socket.uid() == uid.as_raw()
                && socket.mode() & 0o777 == 0o600,
            "Codex Socket 权限无效",
        );
        let limit = if cfg!(target_os = "macos") { 103 } else { 107 };
        let path = if self.socket.as_os_str().as_bytes().len() > limit {
            use sha2::{Digest, Sha256};
            let directory = parent.canonicalize()?;
            let base = PathBuf::from(format!("/tmp/codex-ipc-{}", uid.as_raw()));
            let metadata = std::fs::symlink_metadata(&base)?;
            ensure!(
                metadata.is_dir()
                    && metadata.uid() == uid.as_raw()
                    && metadata.mode() & 0o777 == 0o700,
                "Codex 短路径目录不安全"
            );
            let alias = base.join(format!(
                "{:x}",
                Sha256::digest(directory.as_os_str().as_bytes())
            ));
            ensure!(
                std::fs::symlink_metadata(&alias)?.uid() == uid.as_raw()
                    && alias.canonicalize()? == directory,
                "Codex 短路径指向错误"
            );
            alias.join(self.socket.file_name().context("Codex Socket 路径无效")?)
        } else {
            self.socket.clone()
        };
        let stream = tokio::net::UnixStream::connect(path).await?;
        verify_unix(
            &stream,
            self.executable.as_deref().context("未找到 Codex 程序")?,
            uid.as_raw(),
        )?;
        Ok(Box::new(stream))
    }

    #[cfg(windows)]
    async fn connect(&self, _app_tools: bool) -> Result<Stream> {
        let expected = if let Some(path) = &self.executable {
            path.clone()
        } else {
            tokio::task::spawn_blocking(windows_executable).await??
        };
        crate::windows::codex_pipe(&self.socket, &expected)
    }

    #[cfg(not(any(unix, windows)))]
    async fn connect(&self, _app_tools: bool) -> Result<Stream> {
        let _ = (&self.socket, &self.executable);
        anyhow::bail!("本平台的 Codex IPC 身份校验尚不可用")
    }
}

#[cfg(target_os = "linux")]
fn verify_unix(stream: &tokio::net::UnixStream, expected: &Path, uid: u32) -> Result<()> {
    use std::{fs, os::unix::fs::MetadataExt};
    let credential = rustix::net::sockopt::socket_peercred(stream)?;
    ensure!(credential.uid.as_raw() == uid, "Codex 对端用户不匹配");
    let proc = PathBuf::from(format!("/proc/{}/exe", credential.pid.as_raw_nonzero()));
    let peer = fs::read_link(&proc)?;
    let expected = expected.canonicalize()?;
    if peer == expected {
        return Ok(());
    }
    // A running root-installed executable can outlive a package replacement.
    let Some(original) = peer
        .to_str()
        .and_then(|path| path.strip_suffix(" (deleted)"))
    else {
        bail!("Codex 对端程序不匹配")
    };
    ensure!(
        Path::new(original).canonicalize()? == expected,
        "Codex 对端程序不匹配"
    );
    for path in [&expected, &proc] {
        let metadata = fs::metadata(path)?;
        ensure!(
            metadata.is_file() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
            "Codex 对端程序不受保护"
        );
    }
    for directory in expected.ancestors().skip(1) {
        let metadata = fs::metadata(directory)?;
        ensure!(
            metadata.is_dir() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
            "Codex 安装目录不受保护"
        );
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "linux")))]
fn verify_unix(_stream: &tokio::net::UnixStream, _expected: &Path, _uid: u32) -> Result<()> {
    bail!("本平台的 Codex IPC 身份校验尚不可用")
}

#[cfg(windows)]
pub(crate) fn windows_executable() -> Result<PathBuf> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        ProcessRefreshKind::new().with_exe(UpdateKind::Always),
    );
    let paths = system
        .processes()
        .values()
        .filter(|process| {
            let name = process.name().to_string_lossy();
            name.eq_ignore_ascii_case("codex.exe") || name.eq_ignore_ascii_case("chatgpt.exe")
        })
        .filter_map(|process| process.exe()?.canonicalize().ok())
        .filter(|path| {
            path.parent()
                .is_some_and(|root| root.join("resources/app.asar").is_file())
        })
        .collect::<std::collections::BTreeSet<_>>();
    anyhow::ensure!(
        paths.len() == 1,
        "未找到唯一的 Codex 程序，请显式配置其路径"
    );
    Ok(paths.into_iter().next().unwrap())
}
