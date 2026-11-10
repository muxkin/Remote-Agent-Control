use crate::{
    gateway::RelayConfig,
    state::{
        Store, legacy_private_file, private_directory, private_file, remember_origin, saved_origin,
    },
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, MAIN_DB, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
};
use uuid::Uuid;

const SOURCE_FILE: &str = "node-state-source.json";
const GATEWAY_SOURCE_FILE: &str = "legacy-gateway-source.json";
static SOURCE: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn initialize(directory: &Path) -> Result<()> {
    let source = if let Some(path) = env::var_os("POCKET_NATIVE_LEGACY_STATE") {
        Some(PathBuf::from(path))
    } else if let Some(file) = optional_file(&directory.join(SOURCE_FILE))? {
        let mut bytes = Vec::new();
        file.take(16_385).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 16_384, "旧版状态目录配置过大");
        Some(serde_json::from_slice(&bytes).context("旧版状态目录配置无效")?)
    } else {
        // The hybrid installer used the same directory name as the Rust installer.
        directory
            .join("adapters/registry.json")
            .is_file()
            .then(|| directory.to_owned())
    };
    if let Some(path) = source {
        ensure!(path.is_absolute(), "旧版状态目录必须是绝对路径");
        let _ = SOURCE.set(path);
    }
    Ok(())
}

pub(crate) fn source() -> Option<&'static Path> {
    SOURCE.get().map(PathBuf::as_path)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewaySource {
    environment_file: PathBuf,
    working_directory: PathBuf,
    origin: Option<String>,
}

#[derive(Default)]
pub(crate) struct GatewayEnvironment {
    pub(crate) values: HashMap<String, String>,
    external: Option<GatewaySource>,
}

impl GatewayEnvironment {
    pub(crate) fn load(directory: &Path, source: Option<&Path>) -> Result<Self> {
        let saved: Option<GatewaySource> = optional_file(&directory.join(GATEWAY_SOURCE_FILE))?
            .map(|file| serde_json::from_reader(file.take(16 * 1024)))
            .transpose()
            .context("旧版网关迁移记录无效")?;
        let desktop = if env::var_os("POCKET_NATIVE_LEGACY_DESKTOP_SETTINGS").is_some()
            || (saved.is_none() && source.is_some())
        {
            crate::update_preferences::legacy_gateway()?.map(|old| GatewaySource {
                environment_file: old.environment_file,
                working_directory: old.working_directory,
                origin: old
                    .origin
                    .and_then(|origin| RelayConfig::new(&origin, String::new()).ok())
                    .map(|config| config.origin.origin().ascii_serialization()),
            })
        } else {
            None
        };
        let mut external = desktop.or(saved);
        if let Some(file) = env::var_os("POCKET_ENV_FILE").filter(|value| !value.is_empty()) {
            let file = PathBuf::from(file);
            let working_directory = match &external {
                Some(old) => old.working_directory.clone(),
                None => env::current_dir()?,
            };
            external = Some(GatewaySource {
                environment_file: working_directory.join(file),
                working_directory,
                origin: external.and_then(|old| old.origin),
            });
        }
        let mut config = Self::default();
        if let Some(external) = external {
            ensure!(
                external.environment_file.is_absolute() && external.working_directory.is_absolute(),
                "旧版网关迁移记录须使用绝对路径"
            );
            config.extend(
                legacy_private_file(&external.environment_file)
                    .context("无法读取旧版网关环境文件")?,
            )?;
            config.external = Some(external);
        } else {
            for root in source
                .filter(|source| *source != directory)
                .into_iter()
                .chain([directory])
            {
                if let Some(file) = optional_file(&root.join("gateway.env"))? {
                    config.extend(file)?;
                }
            }
        }
        Ok(config)
    }

    pub(crate) fn is_external(&self) -> bool {
        self.external.is_some()
    }

    fn extend(&mut self, file: fs::File) -> Result<()> {
        const LIMIT: usize = 128 * 1024;
        let mut bytes = Vec::new();
        file.take((LIMIT + 1) as u64).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= LIMIT, "网关环境文件过大");
        for entry in dotenvy::Iter::new(bytes.as_slice()) {
            let (name, value) = entry.map_err(|_| anyhow::anyhow!("网关环境文件格式无效"))?;
            self.values.insert(name, value);
        }
        Ok(())
    }

    pub(crate) fn resolve(&self, path: PathBuf) -> PathBuf {
        match &self.external {
            Some(external) if !path.is_absolute() => external.working_directory.join(path),
            _ => path,
        }
    }

    pub(crate) fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    pub(crate) fn origin(&self) -> Option<&str> {
        self.external
            .as_ref()
            .and_then(|source| source.origin.as_deref())
            .or_else(|| {
                self.get("POCKET_PUBLIC_ORIGIN")
                    .filter(|origin| !origin.is_empty())
            })
    }

    pub(crate) fn enrollment_for(&self, origin: &str) -> Option<&str> {
        let declared = self
            .get("POCKET_PUBLIC_ORIGIN")
            .filter(|origin| !origin.is_empty())
            .or_else(|| self.origin())?;
        let configured = RelayConfig::new(declared, String::new()).ok()?;
        let origin = RelayConfig::new(origin, String::new()).ok()?;
        if configured.origin == origin.origin {
            self.get("POCKET_RELAY_ENROLLMENT")
        } else {
            None
        }
    }
}

pub(crate) fn import(source: &Path, target: &Path, origin: Option<&str>) -> Result<()> {
    ensure!(
        source.is_absolute() && fs::symlink_metadata(source)?.is_dir(),
        "请选择已存在的旧版状态目录"
    );
    let source_canonical = source.canonicalize()?;
    let parent = target.parent().context("无法确定目标状态目录")?;
    ensure!(
        !target.starts_with(source) && !target.starts_with(&source_canonical),
        "目标状态目录必须位于旧版目录之外"
    );
    ensure_target_missing(target)?;
    private_directory(source)?;
    ensure_node_stopped(source)?;
    let source_lock = source.join("native.lock");
    let _lock = if optional_file(&source_lock)?.is_some() {
        let lock = private_file(&source_lock, true)?;
        lock.try_lock().context("旧版状态目录仍在使用")?;
        Some(lock)
    } else {
        None
    };
    let identity = legacy_private_file(&source.join("device-identity-v2.json"))
        .context("旧版状态目录缺少主机身份")?;
    let database = source.join("state.sqlite");
    drop(private_file(&database, false).context("旧版状态目录缺少配对数据库")?);
    for name in [
        "state.sqlite-wal",
        "state.sqlite-shm",
        "state.sqlite-journal",
    ] {
        let sidecar = source.join(name);
        match fs::symlink_metadata(&sidecar) {
            Ok(metadata) => ensure!(metadata.is_file(), "旧版数据库临时文件路径无效"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }

    ensure!(
        !parent
            .canonicalize()
            .context("目标状态目录的父目录必须存在")?
            .starts_with(&source_canonical),
        "目标状态目录必须位于旧版目录之外"
    );
    let environment = GatewayEnvironment::load(source, Some(source))?;
    let staging = parent.join(format!(".native-import-{}", Uuid::new_v4()));
    private_directory(&staging)?;
    let result = (|| -> Result<()> {
        let staging_db = staging.join("state.sqlite");
        drop(private_file(&staging_db, true)?);
        let old = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        ensure!(
            old.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('devices','device_keys')",
                [],
                |row| row.get::<_, i64>(0),
            )? == 2,
            "源数据库缺少配对表"
        );
        old.backup(MAIN_DB, &staging_db, None)
            .context("无法复制旧版 SQLite 状态，请确认旧适配器已退出")?;
        drop(old);
        copy(identity, &staging.join("device-identity-v2.json"))?;
        for name in [
            "gateway.env",
            "instances.json",
            "transport.env",
            "im-agents.json",
        ] {
            if let Some(input) = optional_file(&source.join(name))? {
                copy(input, &staging.join(name))?;
            }
        }
        for name in ["im-agent-progress", "native-uploads"] {
            let original = source.join(name);
            if original.try_exists()? {
                copy_tree(&original, &staging.join(name))?;
            }
        }
        let mut pointer = private_file(&staging.join(SOURCE_FILE), true)?;
        serde_json::to_writer(&mut pointer, source)?;
        pointer.sync_all()?;
        drop(pointer);
        if let Some(external) = &environment.external {
            let mut pointer = private_file(&staging.join(GATEWAY_SOURCE_FILE), true)?;
            serde_json::to_writer(&mut pointer, external)?;
            pointer.sync_all()?;
        }
        let origin = choose_origin(source, origin, &environment)?;
        if let Some(origin) = origin {
            let config = RelayConfig::new(&origin, String::new())?;
            remember_origin(&staging, &config.origin.origin().ascii_serialization())?;
        }
        let checked = Store::open(&staging).context("导入的身份或数据库无效")?;
        ensure!(
            checked
                .db
                .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))?
                == "ok",
            "导入的配对数据库未通过完整性检查"
        );
        drop(checked);
        ensure_node_stopped(source)?;
        ensure_target_missing(target)?;
        fs::rename(&staging, target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn ensure_target_missing(target: &Path) -> Result<()> {
    match fs::symlink_metadata(target) {
        Ok(_) => anyhow::bail!("目标状态目录已存在；请选择新的 POCKET_NATIVE_STATE_DIR"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn ensure_node_stopped(source: &Path) -> Result<()> {
    ensure!(
        !source.join("adapters/supervisor.json").try_exists()?,
        "旧版适配器仍持有监督器记录，请正常退出旧版适配器后重试"
    );
    Ok(())
}

fn choose_origin(
    source: &Path,
    explicit: Option<&str>,
    environment: &GatewayEnvironment,
) -> Result<Option<String>> {
    if let Some(origin) = explicit {
        return Ok(Some(origin.to_owned()));
    }
    if let Some(origin) = saved_origin(source)? {
        return Ok(Some(origin));
    }
    if let Some(origin) = environment.origin() {
        return Ok(Some(origin.to_owned()));
    }
    crate::update_preferences::legacy_origin()
}

fn optional_file(path: &Path) -> Result<Option<fs::File>> {
    match private_file(path, false) {
        Ok(file) => Ok(Some(file)),
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn copy(mut input: fs::File, target: &Path) -> Result<()> {
    let mut output = private_file(target, true)?;
    io::copy(&mut input, &mut output)?;
    output.flush()?;
    output.sync_all()?;
    Ok(())
}

fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    private_directory(source)?;
    private_directory(target)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        let path = item.path();
        let destination = target.join(item.file_name());
        if item.file_type()?.is_dir() {
            copy_tree(&path, &destination)?;
        } else {
            copy(private_file(&path, false)?, &destination)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_enrollment_is_reused_only_at_the_declared_origin() {
        let environment = GatewayEnvironment {
            external: Some(GatewaySource {
                environment_file: PathBuf::new(),
                working_directory: PathBuf::new(),
                origin: Some("https://desktop.example.org".into()),
            }),
            values: HashMap::from([
                (
                    "POCKET_PUBLIC_ORIGIN".into(),
                    "https://legacy.example.org".into(),
                ),
                (
                    "POCKET_RELAY_ENROLLMENT".into(),
                    "fixture-enrollment".into(),
                ),
            ]),
        };
        assert_eq!(environment.origin(), Some("https://desktop.example.org"));
        assert_eq!(
            environment.enrollment_for("https://desktop.example.org"),
            None
        );
        assert_eq!(
            environment.enrollment_for("https://legacy.example.org/"),
            Some("fixture-enrollment")
        );
    }

    #[test]
    fn imports_old_operation_schema_and_cursor_without_changing_source() -> Result<()> {
        let fixture = tempfile::tempdir()?;
        let old = fixture.path().join("old");
        let new = fixture.path().join("new");
        let store = Store::open(&old)?;
        store.db.execute_batch(
            "DROP TABLE operations;
             CREATE TABLE operations (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, thread_id TEXT NOT NULL,
               kind TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, turn_id TEXT, error TEXT,
               created INTEGER NOT NULL, updated INTEGER NOT NULL);
             INSERT INTO operations VALUES ('id','phone','thread','rename','fingerprint','dispatching',NULL,NULL,1,1);",
        )?;
        let progress = old.join("im-agent-progress");
        private_directory(&progress)?;
        private_file(&progress.join("existing.json"), true)?.write_all(b"{\"cursor\":42}")?;
        private_file(&old.join("gateway.env"), true)?
            .write_all(b"POCKET_PUBLIC_ORIGIN=https://relay.example.org\n")?;
        drop(store);
        let original = fs::read(old.join("state.sqlite"))?;
        import(&old, &new, None)?;
        let reopened = Store::open(&new)?;
        let operation: (String, String) = reopened.db.query_row(
            "SELECT backend_id,state FROM operations WHERE id='id'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(operation, ("codex-local".into(), "uncertain".into()));
        assert_eq!(fs::read(old.join("state.sqlite"))?, original);
        assert_eq!(
            saved_origin(&new)?.as_deref(),
            Some("https://relay.example.org")
        );
        assert_eq!(
            fs::read(new.join("im-agent-progress/existing.json"))?,
            b"{\"cursor\":42}"
        );
        assert!(import(&old, &new, None).is_err());
        Ok(())
    }
}
