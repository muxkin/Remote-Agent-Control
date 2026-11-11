use crate::state::{private_directory, private_file};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const MAX_BINARY: u64 = 256 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Manifest {
    sdk: u32,
    pub name: String,
    pub version: String,
    pub product: String,
    state_version: u32,
    entry: String,
    sha256: String,
}

#[derive(Clone)]
pub(crate) struct Package {
    pub manifest: Manifest,
    pub root: PathBuf,
}

impl Package {
    pub(crate) fn executable(&self) -> Result<PathBuf> {
        self.manifest.validate()?;
        let binary = self.root.join(&self.manifest.entry);
        verify_binary(&binary, &self.manifest.sha256)?;
        Ok(binary)
    }
}

impl Manifest {
    fn validate(&self) -> Result<()> {
        let segment = |value: &str| {
            !value.is_empty()
                && value.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'-' | b'_' | b'.')
                })
        };
        let name = if let Some(scoped) = self.name.strip_prefix('@') {
            scoped
                .split_once('/')
                .is_some_and(|(scope, name)| segment(scope) && segment(name))
        } else {
            segment(&self.name)
        };
        let version = regex::Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")?;
        ensure!(
            self.sdk == 1
                && self.state_version > 0
                && self.name.len() <= 160
                && name
                && self.version.len() <= 100
                && version.is_match(&self.version)
                && (1..=80).contains(&self.product.len())
                && !self.product.chars().any(char::is_control)
                && (1..=120).contains(&self.entry.len())
                && !matches!(self.entry.as_str(), "." | ".." | "adapter.json")
                && self
                    .entry
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
                && self.sha256.len() == 64
                && self
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "原生插件清单无效"
        );
        if cfg!(windows) {
            ensure!(
                self.entry.to_ascii_lowercase().ends_with(".exe"),
                "需要原生 EXE 入口"
            );
        }
        Ok(())
    }

    pub(crate) fn key(&self) -> String {
        format!("{}@{}", self.name, self.version)
    }
}

pub(crate) struct Catalog {
    root: PathBuf,
    db: Connection,
}

#[derive(Clone)]
pub(crate) struct Switch {
    pub id: String,
    pub expected: String,
    pub target: Package,
}

impl Catalog {
    pub(crate) fn open(directory: &Path) -> Result<Self> {
        private_directory(directory)?;
        let root = directory.join("native-plugins");
        private_directory(&root)?;
        let path = root.join("registry.sqlite");
        drop(private_file(&path, true)?);
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS packages (
            key TEXT PRIMARY KEY, directory TEXT NOT NULL, manifest TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bindings (
            instance TEXT PRIMARY KEY, current TEXT NOT NULL, previous TEXT
        );
        CREATE TABLE IF NOT EXISTS switches (
            id TEXT PRIMARY KEY, instance TEXT NOT NULL, expected TEXT NOT NULL,
            target TEXT NOT NULL, outcome TEXT, submitted INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_pending_switch ON switches(instance) WHERE outcome IS NULL;
        CREATE TABLE IF NOT EXISTS bundled_switches (
            instance TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(instance,target)
        );",
        )?;
        Ok(Self { root, db })
    }

    pub(crate) async fn install(&mut self, source: &Path) -> Result<String> {
        let manifest = read_manifest(source)?;
        self.install_package(source, manifest, false).await
    }

    async fn install_package(
        &mut self,
        source: &Path,
        manifest: Manifest,
        reuse: bool,
    ) -> Result<String> {
        let key = manifest.key();
        if self.package(&key)?.is_some() {
            ensure!(reuse, "原生插件版本已安装");
            return Ok(key);
        }
        let source = source.join(&manifest.entry);
        let metadata = fs::symlink_metadata(&source)?;
        ensure!(
            metadata.is_file() && metadata.len() <= MAX_BINARY,
            "原生插件入口无效"
        );
        let packages = self.root.join("packages");
        private_directory(&packages)?;
        let stage = tempfile::Builder::new()
            .prefix("stage-")
            .tempdir_in(&packages)?;
        let binary = stage.path().join(&manifest.entry);
        let mut copied = private_file(&binary, true)?;
        std::io::copy(&mut File::open(source)?.take(MAX_BINARY + 1), &mut copied)?;
        copied.sync_all()?;
        drop(copied);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o700))?;
        }
        let package = Package {
            root: stage.path().to_owned(),
            manifest,
        };
        crate::plugin_host::check(&package).await?;
        let directory = Uuid::new_v4().to_string();
        let target = packages.join(&directory);
        fs::rename(stage.path(), &target)?;
        let insert = self.db.execute(
            "INSERT OR IGNORE INTO packages VALUES (?1,?2,?3)",
            params![key, directory, serde_json::to_string(&package.manifest)?],
        );
        if !matches!(insert, Ok(1)) {
            let _ = fs::remove_dir_all(target);
            insert?;
            ensure!(reuse, "原生插件版本已安装");
        }
        Ok(key)
    }

    pub(crate) fn package(&self, key: &str) -> Result<Option<Package>> {
        let record: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT directory,manifest FROM packages WHERE key=?1",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((directory, document)) = record else {
            return Ok(None);
        };
        let manifest: Manifest = serde_json::from_str(&document)?;
        manifest.validate()?;
        ensure!(manifest.key() == key, "原生插件登记与清单不匹配");
        let root = self
            .root
            .join("packages")
            .join(Uuid::parse_str(&directory)?.to_string());
        Ok(Some(Package { root, manifest }))
    }

    pub(crate) fn bind(
        &self,
        id: &str,
        name: &str,
        version: Option<&str>,
    ) -> Result<Option<Package>> {
        if let Some(version) = version {
            let key = format!("{name}@{version}");
            self.db.execute(
                "INSERT OR IGNORE INTO bindings(instance,current)
                SELECT ?1,key FROM packages WHERE key=?2",
                params![id, key],
            )?;
        }
        let current: Option<String> = self
            .db
            .query_row(
                "SELECT current FROM bindings WHERE instance=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(key) = current else {
            return Ok(None);
        };
        let package = self.package(&key)?;
        ensure!(
            package
                .as_ref()
                .is_none_or(|package| package.manifest.name == name),
            "已绑定插件名称与配置不符"
        );
        Ok(package)
    }

    pub(crate) fn bind_official(
        &self,
        id: &str,
        name: &str,
        version: Option<&str>,
        bundled: bool,
    ) -> Result<Option<Package>> {
        if let Some(package) = self.bind(id, name, version)? {
            if bundled {
                let target = format!("{name}@{}", env!("CARGO_PKG_VERSION"));
                if let Some(replacement) = self.package(&target)? {
                    self.queue_bundled(id, &package.manifest, &replacement.manifest)?;
                }
            }
            return Ok(Some(package));
        }
        if let Some(package) = self.bind(id, name, Some(env!("CARGO_PKG_VERSION")))? {
            return Ok(Some(package));
        }
        let key: Option<String> = self.db.query_row(
            "SELECT key FROM packages WHERE substr(key,1,length(?1)+1)=?1||'@' ORDER BY rowid DESC LIMIT 1",
            [name],
            |row| row.get(0),
        ).optional()?;
        if let Some(package) = key
            .as_deref()
            .map(|key| self.package(key))
            .transpose()?
            .flatten()
        {
            return self.bind(id, name, Some(&package.manifest.version));
        }
        Ok(None)
    }

    fn queue_bundled(&self, id: &str, old: &Manifest, new: &Manifest) -> Result<()> {
        if old.name != new.name
            || old.product != new.product
            || old.state_version != new.state_version
            || !release_order(&old.version)
                .zip(release_order(&new.version))
                .is_some_and(|(old, new)| old < new)
        {
            return Ok(());
        }
        let target = new.key();
        let tx = rusqlite::Transaction::new_unchecked(
            &self.db,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let enqueued = tx.execute(
            "INSERT OR IGNORE INTO switches
             SELECT ?1,instance,current,?2,NULL,?3 FROM bindings
             WHERE instance=?4 AND current=?5 AND previous IS NOT ?2
             AND NOT EXISTS (SELECT 1 FROM bundled_switches WHERE instance=?4 AND target=?2)",
            params![
                Uuid::new_v4().to_string(),
                target,
                crate::state::now(),
                id,
                old.key()
            ],
        )?;
        if enqueued == 1 {
            tx.execute(
                "INSERT INTO bundled_switches VALUES (?1,?2)",
                params![id, target],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn queue(&mut self, id: &str, target: Option<&str>) -> Result<(String, String)> {
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (current, previous): (String, Option<String>) = tx
            .query_row(
                "SELECT current,previous FROM bindings WHERE instance=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .context("原生插件实例尚未绑定")?;
        let target = target
            .or(previous.as_deref())
            .context("没有可回滚的原生插件版本")?;
        let manifest = |key: &str| -> Result<Manifest> {
            let document: String = tx
                .query_row("SELECT manifest FROM packages WHERE key=?1", [key], |row| {
                    row.get(0)
                })
                .optional()?
                .context("请先安装目标原生插件")?;
            let manifest: Manifest = serde_json::from_str(&document)?;
            manifest.validate()?;
            Ok(manifest)
        };
        let old = manifest(&current)?;
        let new = manifest(target)?;
        ensure!(
            old.name == new.name
                && old.product == new.product
                && old.state_version == new.state_version,
            "原生插件产品或私有状态版本不兼容"
        );
        let request = Uuid::new_v4().to_string();
        let result = (current == target).then_some("applied");
        tx.execute(
            "INSERT INTO switches VALUES (?1,?2,?3,?4,?5,?6)",
            params![request, id, current, target, result, crate::state::now()],
        )
        .context("此实例已有待处理的插件切换")?;
        tx.commit()?;
        Ok((request, target.to_owned()))
    }

    pub(crate) fn next(&self, instance: &str) -> Result<Option<Switch>> {
        let row: Option<(String, String, String)> = self
            .db
            .query_row(
                "SELECT id,expected,target FROM switches WHERE instance=?1 AND outcome IS NULL",
                [instance],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((id, expected, target)) = row else {
            return Ok(None);
        };
        let Some(target) = self.package(&target)? else {
            self.db.execute(
                "UPDATE switches SET outcome='package_missing' WHERE id=?1 AND outcome IS NULL",
                [&id],
            )?;
            return Ok(None);
        };
        Ok(Some(Switch {
            id,
            expected,
            target,
        }))
    }

    pub(crate) fn finish(&mut self, request: &Switch, instance: &str, outcome: &str) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if outcome == "applied" {
            let changed = tx.execute(
                "UPDATE bindings SET current=?1,previous=current WHERE instance=?2 AND current=?3",
                params![request.target.manifest.key(), instance, request.expected],
            )?;
            ensure!(changed == 1, "插件当前绑定已更换");
        }
        let changed = tx.execute(
            "UPDATE switches SET outcome=?1 WHERE id=?2 AND instance=?3 AND outcome IS NULL",
            params![outcome, request.id, instance],
        )?;
        ensure!(changed == 1, "插件切换请求已更换");
        tx.execute(
            "DELETE FROM switches WHERE outcome IS NOT NULL AND submitted<?1",
            [crate::state::now() - 7 * 86_400_000],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn result(&self, request: &str) -> Result<Value> {
        self.db
            .query_row(
                "SELECT instance,target,outcome FROM switches WHERE id=?1",
                [request],
                |row| {
                    Ok(json!({
                        "requestId":request,"instance":row.get::<_,String>(0)?,
                        "target":row.get::<_,String>(1)?,"outcome":row.get::<_,Option<String>>(2)?,
                    }))
                },
            )
            .optional()?
            .context("找不到插件切换请求")
    }

    fn list(&self) -> Result<Value> {
        let mut packages = self.db.prepare("SELECT key FROM packages ORDER BY key")?;
        let packages = packages
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut bindings = self
            .db
            .prepare("SELECT instance,current,previous FROM bindings ORDER BY instance")?;
        let bindings = bindings.query_map([], |row| Ok(json!({
            "instance":row.get::<_,String>(0)?,"current":row.get::<_,String>(1)?,"previous":row.get::<_,Option<String>>(2)?
        })))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({"packages":packages,"instances":bindings}))
    }
}

fn release_order(version: &str) -> Option<([u64; 3], bool)> {
    let (core, stable) = version
        .split_once('-')
        .map_or((version, true), |(core, _)| (core, false));
    let mut numbers = core.split('.');
    let major = numbers.next()?.parse().ok()?;
    let minor = numbers.next()?.parse().ok()?;
    let patch = numbers.next()?.parse().ok()?;
    Some(([major, minor, patch], stable))
}

pub(crate) fn read_manifest(source: &Path) -> Result<Manifest> {
    let manifest_path = source.join("adapter.json");
    ensure!(
        fs::symlink_metadata(&manifest_path)?.is_file(),
        "原生插件清单须为普通文件"
    );
    let mut document = Vec::new();
    File::open(manifest_path)?
        .take(16_385)
        .read_to_end(&mut document)?;
    ensure!(document.len() <= 16_384, "原生插件清单过大");
    let manifest: Manifest = serde_json::from_slice(&document)?;
    manifest.validate()?;
    Ok(manifest)
}

pub(crate) async fn provision_official(executable: &Path, directory: &Path) -> Result<bool> {
    let parent = executable.parent().context("无法定位官方插件目录")?;
    let root = if cfg!(target_os = "linux") && parent == Path::new("/usr/bin") {
        PathBuf::from("/usr/lib/agent-space-native/official-plugins")
    } else if cfg!(target_os = "macos") && parent.ends_with("Contents/MacOS") {
        parent.join("../Resources/official-plugins")
    } else {
        parent.join("official-plugins")
    };
    let metadata = match fs::symlink_metadata(&root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    ensure!(metadata.is_dir(), "官方插件目录无效");
    let mut catalog = Catalog::open(directory)?;
    for product in ["codex", "dsh"] {
        let source = root.join(product);
        ensure!(fs::symlink_metadata(&source)?.is_dir(), "官方插件目录无效");
        let manifest = read_manifest(&source)?;
        ensure!(
            manifest.name == format!("@agent-remote/adapter-{product}")
                && manifest.product == product
                && manifest.version == env!("CARGO_PKG_VERSION"),
            "安装包的官方插件与适配器版本不匹配"
        );
        catalog.install_package(&source, manifest, true).await?;
    }
    Ok(true)
}

pub(crate) fn cli(directory: &Path, args: &[String]) -> Result<()> {
    let mut catalog = Catalog::open(directory)?;
    match args {
        [command] if command == "list" => {
            println!("{}", serde_json::to_string_pretty(&catalog.list()?)?)
        }
        [command, folder] if command == "install" => {
            let runtime = tokio::runtime::Runtime::new()?;
            println!("{}", runtime.block_on(catalog.install(Path::new(folder)))?);
        }
        [command, instance, target] if command == "upgrade" => {
            enqueue(&mut catalog, directory, instance, Some(target))?;
        }
        [command, instance] if command == "rollback" => {
            enqueue(&mut catalog, directory, instance, None)?;
        }
        [command, request] if command == "result" => println!("{}", catalog.result(request)?),
        _ => anyhow::bail!(
            "用法: --adapter list | install <目录> | upgrade <实例> <插件@版本> | rollback <实例> | result <请求 ID>"
        ),
    }
    Ok(())
}

fn enqueue(
    catalog: &mut Catalog,
    directory: &Path,
    instance: &str,
    target: Option<&str>,
) -> Result<()> {
    let (request, target) = catalog.queue(instance, target)?;
    let online = directory.join("native.lock").exists()
        && private_file(&directory.join("native.lock"), true)
            .is_ok_and(|lock| lock.try_lock().is_err());
    let until = std::time::Instant::now() + Duration::from_secs(if online { 35 } else { 0 });
    loop {
        let result = catalog.result(&request)?;
        match result["outcome"].as_str() {
            Some("applied") => {
                println!("{instance}: {target}");
                return Ok(());
            }
            Some("startup_failed") => {
                anyhow::bail!("新版插件未启动，已保留旧版本（请求 {request}）")
            }
            Some("busy") => anyhow::bail!("实例仍在处理写入，版本保持不变（请求 {request}）"),
            Some(_) => anyhow::bail!("插件切换未应用（请求 {request}）"),
            None if std::time::Instant::now() >= until => {
                println!("{instance}: {target}（已排队，请求 {request}）");
                return Ok(());
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn verify_binary(path: &Path, expected: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && (4..=MAX_BINARY).contains(&metadata.len()),
        "原生插件入口无效"
    );
    let mut file = File::open(path)?;
    let mut magic = [0; 4];
    file.read_exact(&mut magic)?;
    let native = if cfg!(windows) {
        magic.starts_with(b"MZ")
    } else if cfg!(target_os = "macos") {
        matches!(
            magic,
            [0xcf, 0xfa, 0xed, 0xfe] | [0xca, 0xfe, 0xba, 0xbe] | [0xca, 0xfe, 0xba, 0xbf]
        )
    } else {
        &magic == b"\x7fELF"
    };
    ensure!(native, "插件入口须为当前平台的原生可执行文件");
    let mut digest = Sha256::new();
    digest.update(magic);
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    ensure!(
        format!("{:x}", digest.finalize()) == expected,
        "原生插件入口校验失败"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_updates_keep_rollback_and_do_not_replace_a_pending_user_switch() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let mut catalog = Catalog::open(&directory.path().join("state"))?;
        let mut old = Manifest {
            sdk: 1,
            name: "@agent-remote/adapter-codex".into(),
            version: "0.0.1".into(),
            product: "codex".into(),
            state_version: 1,
            entry: "agent-space-adapter-codex.exe".into(),
            sha256: "0".repeat(64),
        };
        let bundled = Manifest {
            version: env!("CARGO_PKG_VERSION").into(),
            ..old.clone()
        };
        let manual = Manifest {
            version: "0.0.2".into(),
            ..old.clone()
        };
        for manifest in [&old, &manual, &bundled] {
            catalog.db.execute(
                "INSERT INTO packages VALUES (?1,?2,?3)",
                params![
                    manifest.key(),
                    Uuid::new_v4().to_string(),
                    serde_json::to_string(manifest)?
                ],
            )?;
        }
        let id = "codex-local";
        let read = |catalog: &Catalog| -> Result<String> {
            Ok(catalog
                .bind_official(id, &old.name, Some("0.0.1"), true)?
                .context("missing binding")?
                .manifest
                .key())
        };
        catalog.bind(id, &old.name, Some(&old.version))?;
        let user = catalog.queue(id, Some(&manual.key()))?;
        assert_eq!(read(&catalog)?, old.key());
        let pending = catalog.next(id)?.context("missing user switch")?;
        assert_eq!(pending.id, user.0);
        catalog.finish(&pending, id, "applied")?;
        assert_eq!(read(&catalog)?, manual.key());
        let automatic = catalog.next(id)?.context("missing bundled switch")?;
        assert_eq!(automatic.expected, manual.key());
        assert_eq!(automatic.target.manifest.key(), bundled.key());
        catalog.finish(&automatic, id, "applied")?;
        assert_eq!(read(&catalog)?, bundled.key());
        catalog.queue(id, None)?;
        let rollback = catalog.next(id)?.context("missing rollback")?;
        assert_eq!(rollback.target.manifest.key(), manual.key());
        catalog.finish(&rollback, id, "applied")?;
        catalog.db.execute("DELETE FROM switches", [])?;
        assert_eq!(read(&catalog)?, manual.key());
        assert!(catalog.next(id)?.is_none());

        old.state_version = 2;
        old.version = "9.9.9".into();
        catalog.queue_bundled(id, &manual, &old)?;
        assert!(catalog.next(id)?.is_none());
        assert!(release_order("0.3.9") < release_order("0.3.10"));
        assert!(release_order("0.3.10-rc.1") < release_order("0.3.10"));
        Ok(())
    }
}
