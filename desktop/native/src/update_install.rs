use anyhow::{Context, Result, ensure};
use std::{
    env, fs,
    path::Path,
    process::{Command, Stdio},
};

const MAC_APP: &str = "Agent Space Adapter.app";

fn mac_app(executable: &Path) -> Option<&Path> {
    let app = executable.parent()?.parent()?.parent()?;
    (app.file_name()?.to_str()? == MAC_APP
        && executable.strip_prefix(app).ok()? == Path::new("Contents/MacOS/agent-space-native")
        && !app.starts_with("/Volumes"))
    .then_some(app)
}

pub(crate) fn installed(executable: &Path) -> bool {
    match env::consts::OS {
        "linux" => {
            executable == Path::new("/usr/bin/agent-space-native")
                && Path::new("/usr/bin/apt-get").is_file()
                && Path::new("/usr/bin/pkexec").is_file()
        }
        "macos" => mac_app(executable).is_some(),
        "windows" => env::var_os("LOCALAPPDATA").is_some_and(|directory| {
            std::path::PathBuf::from(directory)
                .join("Programs/Agent Space Adapter/agent-space-native.exe")
                .components()
                .eq(executable.components())
        }),
        _ => false,
    }
}

fn command(program: &Path, args: &[&std::ffi::OsStr]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("无法启动系统安装工具 {}", program.display()))?;
    ensure!(status.success(), "系统安装工具退出异常");
    Ok(())
}

pub(crate) fn replace(
    executable: &Path,
    artifact: &Path,
    stage: &Path,
    release_key: bool,
) -> Result<()> {
    if cfg!(target_os = "macos") {
        return replace_mac(executable, artifact, stage, release_key);
    }
    if cfg!(windows) {
        return replace_windows(executable, artifact, release_key);
    }
    ensure!(
        cfg!(target_os = "linux") && installed(executable),
        "不支持此安装位置"
    );
    command(
        Path::new("/usr/bin/pkexec"),
        &[
            "/usr/bin/apt-get".as_ref(),
            "-y".as_ref(),
            "install".as_ref(),
            "--".as_ref(),
            artifact.as_os_str(),
        ],
    )
}

fn replace_windows(executable: &Path, artifact: &Path, release_key: bool) -> Result<()> {
    if !release_key {
        let root = env::var_os("SystemRoot").context("未找到 Windows 系统目录")?;
        let powershell =
            std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let status = Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "if ((Get-AuthenticodeSignature -LiteralPath $env:POCKET_NATIVE_UPDATE_ARTIFACT).Status -ne 'Valid') { exit 1 }"])
            .env("POCKET_NATIVE_UPDATE_ARTIFACT", artifact)
            .status()?;
        ensure!(status.success(), "Windows 发布者签名无效");
    }
    let directory = executable.parent().context("安装位置无效")?;
    let backup = tempfile::Builder::new()
        .prefix(".previous-")
        .tempdir_in(directory)?;
    let previous = backup.path().join("agent-space-native.exe");
    fs::rename(executable, &previous)?;
    let result = command(artifact, &["/S".as_ref()]).and_then(|_| {
        ensure!(executable.is_file(), "安装后缺少适配器");
        Ok(())
    });
    if result.is_err() {
        let restore = (|| -> std::io::Result<()> {
            if executable.exists() {
                fs::remove_file(executable)?;
            }
            fs::rename(previous, executable)
        })();
        if restore.is_err() {
            let _ = backup.keep();
        }
        restore?;
    }
    result
}

fn replace_mac(executable: &Path, artifact: &Path, stage: &Path, release_key: bool) -> Result<()> {
    let app = mac_app(executable).context("应用安装位置无效")?;
    let folder = app.parent().context("应用安装位置无效")?;
    let mount = stage.join("dmg");
    fs::create_dir(&mount)?;
    let disk = Path::new("/usr/bin/hdiutil");
    command(
        disk,
        &[
            "attach".as_ref(),
            artifact.as_os_str(),
            "-readonly".as_ref(),
            "-nobrowse".as_ref(),
            "-mountpoint".as_ref(),
            mount.as_os_str(),
        ],
    )?;
    let result = (|| {
        let next = mount.join(MAC_APP);
        command(
            Path::new("/usr/bin/codesign"),
            &[
                "--verify".as_ref(),
                "--deep".as_ref(),
                "--strict".as_ref(),
                next.as_os_str(),
            ],
        )?;
        if !release_key {
            command(
                Path::new("/usr/sbin/spctl"),
                &[
                    "--assess".as_ref(),
                    "--type".as_ref(),
                    "execute".as_ref(),
                    next.as_os_str(),
                ],
            )?;
        }
        let transaction = tempfile::Builder::new()
            .prefix(".agent-space-update-")
            .tempdir_in(folder)?;
        let incoming = transaction.path().join(MAC_APP);
        let backup = transaction.path().join("previous.app");
        command(
            Path::new("/usr/bin/ditto"),
            &[next.as_os_str(), incoming.as_os_str()],
        )?;
        fs::rename(app, &backup)?;
        if let Err(error) = fs::rename(incoming, app) {
            if fs::rename(backup, app).is_err() {
                let _ = transaction.keep();
            }
            return Err(error.into());
        }
        Ok(())
    })();
    let _ = command(disk, &["detach".as_ref(), mount.as_os_str()]);
    result
}

pub(crate) fn restart(executable: &Path) -> Result<()> {
    if cfg!(target_os = "macos") {
        let app = mac_app(executable).context("应用安装位置无效")?;
        return command(
            Path::new("/usr/bin/open"),
            &[
                "-a".as_ref(),
                app.as_os_str(),
                "--args".as_ref(),
                "--background".as_ref(),
            ],
        );
    }
    let mut child = Command::new(executable);
    child
        .arg("--background")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x0000_0200 | 0x0000_0008);
    }
    child.spawn()?;
    Ok(())
}
