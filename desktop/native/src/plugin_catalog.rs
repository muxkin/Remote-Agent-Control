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

    fn key(&self) -> String {
        format!("{}@{}", self.name, self.version)
    }
}

pub(crate) struct Catalog {
    root: PathBuf,
    db: Connection,
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
        );",
        )?;
        Ok(Self { root, db })
    }

    pub(crate) async fn install(&mut self, source: &Path) -> Result<String> {
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
        let key = manifest.key();
        ensure!(self.package(&key)?.is_none(), "原生插件版本已安装");
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
        if let Err(error) = self.db.execute(
            "INSERT INTO packages VALUES (?1,?2,?3)",
            params![key, directory, serde_json::to_string(&package.manifest)?],
        ) {
            let _ = fs::remove_dir_all(target);
            return Err(error.into());
        }
        Ok(key)
    }

    fn package(&self, key: &str) -> Result<Option<Package>> {
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

    fn switch(&mut self, id: &str, target: Option<&str>) -> Result<String> {
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
        if current != target {
            tx.execute(
                "UPDATE bindings SET current=?1,previous=?2 WHERE instance=?3",
                params![target, current, id],
            )?;
        }
        tx.commit()?;
        Ok(target.to_owned())
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
            println!(
                "{instance}: {}（下次启动时应用）",
                catalog.switch(instance, Some(target))?
            );
        }
        [command, instance] if command == "rollback" => {
            println!(
                "{instance}: {}（下次启动时应用）",
                catalog.switch(instance, None)?
            );
        }
        _ => anyhow::bail!(
            "用法: --adapter list | install <目录> | upgrade <实例> <插件@版本> | rollback <实例>"
        ),
    }
    Ok(())
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
