use crate::{
    gateway::{Database, Snapshot},
    state::{lock_directory, now, private_directory, private_file},
};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::Deserialize;
use sha2::{Digest, Sha512};
use std::{
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio::{
    io::AsyncWriteExt,
    sync::{mpsc, watch},
    time::{interval, sleep},
};
use url::Url;

const MAX_MANIFEST: usize = 16 * 1024;
const MAX_PACKAGE: u64 = 512 * 1024 * 1024;
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
const QUIET_PERIOD: Duration = Duration::from_secs(20);
const KEY: &str = include_str!("../update-release.pub");
const SPKI_HEADER: &[u8] = b"\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00";

pub(crate) const APPLY_FLAG: &str = "--apply-native-update";

#[derive(Clone, Copy, PartialEq)]
struct Target {
    platform: &'static str,
    arch: &'static str,
    suffix: &'static str,
}

fn target() -> Option<Target> {
    let (platform, arch, suffix) = match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => ("linux", "x64", "linux-x64.deb"),
        ("windows", "x86_64") => ("win32", "x64", "windows-x64-setup.exe"),
        ("macos", "x86_64") => ("darwin", "x64", "macos-x64.dmg"),
        ("macos", "aarch64") => ("darwin", "arm64", "macos-arm64.dmg"),
        _ => return None,
    };
    Some(Target {
        platform,
        arch,
        suffix,
    })
}

#[derive(Deserialize)]
struct Envelope {
    payload: String,
    signature: String,
}

#[derive(Deserialize, Debug)]
struct Release {
    format: u32,
    runtime: String,
    version: String,
    platform: String,
    arch: String,
    file: String,
    size: u64,
    sha512: String,
    publisher: Option<String>,
}

fn version(text: &str) -> Option<[u32; 3]> {
    let parts: [&str; 3] = text.split('.').collect::<Vec<_>>().try_into().ok()?;
    let mut result = [0; 3];
    for (number, part) in result.iter_mut().zip(parts) {
        if part.len() > 6
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        *number = part.parse().ok()?;
    }
    Some(result)
}

fn verify_manifest(
    data: &[u8],
    key: &[u8],
    current: &str,
    target: Target,
) -> Result<Option<Release>> {
    ensure!(data.len() <= MAX_MANIFEST, "更新清单过大");
    let document: Envelope = serde_json::from_slice(data)?;
    let payload = STANDARD.decode(document.payload)?;
    let signature = STANDARD.decode(document.signature)?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(&payload, &signature)
        .map_err(|_| anyhow::anyhow!("更新清单签名无效"))?;
    let release: Release = serde_json::from_slice(&payload)?;
    let installed = version(current).context("当前版本无效")?;
    let next = version(&release.version).context("更新版本无效")?;
    ensure!(
        release.format == 1
            && release.runtime == "rust"
            && release.platform == target.platform
            && release.arch == target.arch
            && release.file == format!("AgentSpace-Native-{}-{}", release.version, target.suffix)
            && (1..=MAX_PACKAGE).contains(&release.size)
            && release.sha512.len() == 128
            && release
                .sha512
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            && match release.publisher.as_deref() {
                None => true,
                Some("release-key") => target.platform != "linux",
                _ => false,
            },
        "更新包不符合原生安装规范"
    );
    Ok((next > installed).then_some(release))
}

fn pinned_manifest(data: &[u8], target: Target) -> Result<Option<Release>> {
    let der = STANDARD.decode(
        KEY.lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>(),
    )?;
    let key = der
        .strip_prefix(SPKI_HEADER)
        .filter(|raw| raw.len() == 32)
        .context("发布公钥无效")?;
    verify_manifest(data, key, env!("CARGO_PKG_VERSION"), target)
}

struct Activity {
    clients: usize,
    quiet_since: Instant,
    draining: bool,
}

#[derive(Clone)]
pub(crate) struct UpdateGate(Arc<Mutex<Activity>>);

impl Default for UpdateGate {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Activity {
            clients: 0,
            quiet_since: Instant::now(),
            draining: false,
        })))
    }
}

pub(crate) struct Client(UpdateGate);

impl UpdateGate {
    pub(crate) fn admit(&self) -> Option<Client> {
        let mut activity = self.0.lock().expect("update activity poisoned");
        if activity.draining {
            return None;
        }
        activity.clients += 1;
        Some(Client(self.clone()))
    }

    fn drain(&self, db: &Database) -> Result<bool> {
        let mut activity = self.0.lock().expect("update activity poisoned");
        if activity.draining
            || activity.clients > 0
            || activity.quiet_since.elapsed() < QUIET_PERIOD
        {
            return Ok(false);
        }
        let busy: bool = db.lock().expect("database poisoned").db.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE state IN ('received','dispatching'))",
            [],
            |row| row.get(0),
        )?;
        if !busy {
            activity.draining = true;
        }
        Ok(!busy)
    }

    fn resume(&self) {
        self.0.lock().expect("update activity poisoned").draining = false;
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let mut activity = self.0.0.lock().expect("update activity poisoned");
        activity.clients -= 1;
        if activity.clients == 0 {
            activity.quiet_since = Instant::now();
        }
    }
}

fn feed(origin: &Url, target: Target) -> Result<Url> {
    let base = match env::var("POCKET_NATIVE_UPDATE_BASE_URL") {
        Ok(value) => origin.join(&value)?,
        Err(env::VarError::NotPresent) => origin.join("/downloads/desktop/native/rust/")?,
        Err(error) => return Err(error.into()),
    };
    ensure!(
        base.scheme() == "https"
            && base.username().is_empty()
            && base.password().is_none()
            && base.query().is_none()
            && base.fragment().is_none(),
        "原生更新源必须使用 HTTPS"
    );
    let mut result = base;
    result
        .path_segments_mut()
        .map_err(|_| anyhow::anyhow!("更新地址无效"))?
        .pop_if_empty()
        .extend([target.platform, target.arch, ""]);
    Ok(result)
}

struct Staged {
    release: Release,
    directory: TempDir,
}

async fn stage(origin: &Url, target: Target, directory: &Path) -> Result<Option<Staged>> {
    let base = feed(origin, target)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(900))
        .build()?;
    let mut response = client
        .get(base.join("latest.json")?)
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    ensure!(response.status().is_success(), "无法读取更新清单");
    let mut manifest = Vec::new();
    while let Some(part) = response.chunk().await? {
        ensure!(manifest.len() + part.len() <= MAX_MANIFEST, "更新清单过大");
        manifest.extend_from_slice(&part);
    }
    let Some(release) = pinned_manifest(&manifest, target)? else {
        return Ok(None);
    };
    if let Ok(mut old) = private_file(&directory.join("native-update-attempt.json"), false) {
        let mut bytes = Vec::new();
        Read::by_ref(&mut old).take(4096).read_to_end(&mut bytes)?;
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            ensure!(
                value["version"] != release.version
                    || value["time"].as_i64().is_none_or(
                        |time| now().saturating_sub(time) >= CHECK_INTERVAL.as_millis() as i64
                    ),
                "上次安装未生效，将稍后重试"
            );
        }
    }
    let mut temporary = tempfile::Builder::new();
    temporary.prefix(".native-update-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary.permissions(fs::Permissions::from_mode(0o700));
    }
    let temporary = temporary.tempdir_in(directory)?;
    private_directory(temporary.path())?;
    let manifest_file = temporary.path().join("latest.json");
    private_file(&manifest_file, true)?.write_all(&manifest)?;
    let path = temporary.path().join(&release.file);
    let mut output = tokio::fs::File::from_std(private_file(&path, true)?);
    let mut response = client.get(base.join(&release.file)?).send().await?;
    ensure!(response.status().is_success(), "无法下载更新包");
    if let Some(length) = response.content_length() {
        ensure!(length == release.size, "更新包长度无效");
    }
    let mut size = 0;
    let mut digest = Sha512::new();
    while let Some(part) = response.chunk().await? {
        size += part.len() as u64;
        ensure!(size <= release.size, "更新包长度无效");
        output.write_all(&part).await?;
        digest.update(&part);
    }
    ensure!(
        size == release.size && format!("{:x}", digest.finalize()) == release.sha512,
        "更新包校验失败"
    );
    output.sync_all().await?;
    Ok(Some(Staged {
        release,
        directory: temporary,
    }))
}

fn detached(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0200 | 0x0000_0008);
    }
    command
}

fn handoff(staged: &Staged, executable: &Path, directory: &Path) -> Result<()> {
    let helper = staged
        .directory
        .path()
        .join(if cfg!(windows) { "apply.exe" } else { "apply" });
    fs::copy(executable, &helper)?;
    detached(&helper)
        .arg(APPLY_FLAG)
        .arg(executable)
        .arg(staged.directory.path())
        .env("POCKET_NATIVE_STATE_DIR", directory)
        .env_remove("POCKET_NATIVE_ENROLLMENT")
        .env_remove("POCKET_RELAY_ENROLLMENT")
        .spawn()?;
    Ok(())
}

pub(crate) async fn run(
    origin: Url,
    executable: PathBuf,
    directory: PathBuf,
    db: Database,
    gate: UpdateGate,
    mut install: mpsc::Receiver<()>,
    status: watch::Sender<Snapshot>,
) {
    let Some(target) = target() else { return };
    if env::var("POCKET_NATIVE_UPDATES").as_deref() == Ok("0")
        || !crate::update_install::installed(&executable)
        || feed(&origin, target).is_err()
    {
        return;
    }
    let manual = target.platform == "linux";
    remove_expired_staging(&directory);
    let mut checks = interval(CHECK_INTERVAL);
    checks.tick().await;
    sleep(Duration::from_secs(15)).await;
    let mut staged = None;
    let mut requested = false;
    let mut apply = interval(Duration::from_secs(15));
    let mut next = Some(stage(&origin, target, &directory).await);
    loop {
        if let Some(result) = next.take() {
            let message = match result {
                Ok(Some(package)) => {
                    let message = format!(
                        "已下载 v{}，{}",
                        package.release.version,
                        if manual {
                            "安装需要系统授权"
                        } else {
                            "等待连接空闲后安装"
                        }
                    );
                    staged = Some(package);
                    message
                }
                Ok(None) => "已是最新版本".into(),
                Err(_) => "检查或下载更新失败，将在后台重试".into(),
            };
            status.send_modify(|snapshot| {
                snapshot.update = message.clone();
                snapshot.manual_update = manual && staged.is_some();
            });
        }
        if let Some(package) = &staged
            && (!manual || requested)
            && gate.drain(&db).unwrap_or(false)
        {
            match handoff(package, &executable, &directory) {
                Ok(()) => {
                    let _ = staged.take().unwrap().directory.keep();
                    status.send_modify(|snapshot| snapshot.exit_for_update = true);
                    return;
                }
                Err(_) => {
                    gate.resume();
                    status.send_modify(|snapshot| {
                        snapshot.update = "安装未启动，将在后台重试".into()
                    });
                }
            }
        }
        tokio::select! {
            _ = checks.tick(), if staged.is_none() => next = Some(stage(&origin, target, &directory).await),
            _ = apply.tick(), if staged.is_some() => {},
            command = install.recv() => {
                if command.is_none() { return; }
                requested = true;
            }
        }
    }
}

fn remove_expired_staging(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_dir())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(48 * 60 * 60));
        if old
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(".native-update-"))
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

pub(crate) fn apply(executable: &Path, stage: &Path, directory: &Path) -> Result<()> {
    ensure!(crate::update_install::installed(executable), "安装位置无效");
    let directory = directory.canonicalize()?;
    let stage = stage.canonicalize()?;
    ensure!(
        stage.parent() == Some(directory.as_path())
            && stage
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(".native-update-")),
        "更新暂存目录无效"
    );
    private_directory(&stage)?;
    let lock = (0..120)
        .find_map(|_| match lock_directory(&directory) {
            Ok(lock) => Some(lock),
            Err(_) => {
                std::thread::sleep(Duration::from_millis(250));
                None
            }
        })
        .context("等待适配器安全退出超时")?;
    let result = (|| {
        let mut data = Vec::new();
        private_file(&stage.join("latest.json"), false)?
            .take((MAX_MANIFEST + 1) as u64)
            .read_to_end(&mut data)?;
        let release = pinned_manifest(&data, target().context("更新平台不支持")?)?
            .context("更新版本已过期")?;
        let artifact = stage.join(&release.file);
        let mut file = private_file(&artifact, false)?;
        let mut hash = Sha512::new();
        let size = std::io::copy(
            &mut Read::by_ref(&mut file).take(release.size + 1),
            &mut hash,
        )?;
        ensure!(
            size == release.size && format!("{:x}", hash.finalize()) == release.sha512,
            "更新包校验失败"
        );
        drop(file);
        let mut attempt = tempfile::NamedTempFile::new_in(&directory)?;
        serde_json::to_writer(
            &mut attempt,
            &serde_json::json!({"version":release.version,"time":now()}),
        )?;
        attempt.persist(directory.join("native-update-attempt.json"))?;
        crate::update_install::replace(
            executable,
            &artifact,
            &stage,
            release.publisher.as_deref() == Some("release-key"),
        )
    })();
    drop(lock);
    let relaunched = crate::update_install::restart(executable);
    // Windows keeps the running helper executable mapped. Remove what can be deleted.
    let _ = fs::remove_dir_all(stage);
    result.and(relaunched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };
    use serde_json::{Value, json};

    const LINUX: Target = Target {
        platform: "linux",
        arch: "x64",
        suffix: "linux-x64.deb",
    };

    fn sign(key: &Ed25519KeyPair, value: &Value) -> Vec<u8> {
        let payload = serde_json::to_vec(value).unwrap();
        serde_json::to_vec(&json!({
            "payload": STANDARD.encode(&payload),
            "signature": STANDARD.encode(key.sign(&payload)),
        }))
        .unwrap()
    }

    #[test]
    fn blocks_new_clients_while_draining_and_waits_for_in_flight_operations() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("state");
        let db = Arc::new(Mutex::new(crate::state::Store::open(&directory).unwrap()));
        let gate = UpdateGate::default();
        let age = || gate.0.lock().unwrap().quiet_since = Instant::now() - QUIET_PERIOD;
        age();
        let client = gate.admit().unwrap();
        assert!(!gate.drain(&db).unwrap());
        drop(client);
        assert!(!gate.drain(&db).unwrap());
        age();
        db.lock()
            .unwrap()
            .db
            .execute(
                "INSERT INTO operations
             (id,device_id,thread_id,kind,fingerprint,state,created,updated)
             VALUES ('id','device','thread','send','hash','dispatching',0,0)",
                [],
            )
            .unwrap();
        assert!(!gate.drain(&db).unwrap());
        db.lock()
            .unwrap()
            .db
            .execute("UPDATE operations SET state='accepted'", [])
            .unwrap();
        assert!(gate.drain(&db).unwrap());
        assert!(gate.admit().is_none());
        gate.resume();
        assert!(gate.admit().is_some());
    }

    #[test]
    fn accepts_only_newer_rust_builds_for_the_installed_platform() {
        let rng = SystemRandom::new();
        let document = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let key = Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap();
        let raw = key.public_key().as_ref();
        let mut metadata = json!({
            "format":1,"runtime":"rust","version":"0.3.1","platform":"linux","arch":"x64",
            "file":"AgentSpace-Native-0.3.1-linux-x64.deb","size":5,"sha512":"f".repeat(128)
        });
        assert!(
            verify_manifest(&sign(&key, &metadata), raw, "0.3.0", LINUX)
                .unwrap()
                .is_some()
        );
        assert!(
            verify_manifest(&sign(&key, &metadata), raw, "0.3.1", LINUX)
                .unwrap()
                .is_none()
        );
        assert!(verify_manifest(&sign(&key, &metadata), &[0; 32], "0.3.0", LINUX).is_err());
        metadata.as_object_mut().unwrap().remove("runtime");
        assert!(verify_manifest(&sign(&key, &metadata), raw, "0.3.0", LINUX).is_err());
        metadata["runtime"] = json!("rust");
        metadata["file"] = json!("../AgentSpace-Native-0.3.1-linux-x64.deb");
        assert!(verify_manifest(&sign(&key, &metadata), raw, "0.3.0", LINUX).is_err());
    }
}
