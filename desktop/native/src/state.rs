use anyhow::{Context, Result, bail, ensure};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use libp2p_identity::{Keypair, PeerId};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityFile {
    peer_id: String,
    private_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub ticket: String,
    pub expires: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<String>,
}

#[derive(Clone)]
pub struct Pairing {
    pub code: String,
    pub expires_at: i64,
}

pub struct Device {
    pub id: String,
    pub name: String,
    pub ticket: String,
}

pub struct Store {
    pub(crate) db: Connection,
    pub(crate) directory: std::path::PathBuf,
    pub identity: Keypair,
    pub(crate) downloads: std::collections::HashMap<Uuid, crate::files::Download>,
    _lock: File,
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        private_directory(directory)?;
        ensure!(
            !directory.join("adapters/supervisor.json").exists(),
            "旧版适配器仍持有此目录的监督器记录，请正常退出后重试"
        );
        let lock = lock_directory(directory)?;
        let identity_path = directory.join("device-identity-v2.json");
        let identity = if identity_path.exists() {
            use std::io::Read;
            let mut input = String::new();
            private_file(&identity_path, false)?
                .take(8192)
                .read_to_string(&mut input)?;
            let document: IdentityFile = serde_json::from_str(&input)?;
            let key = Keypair::from_protobuf_encoding(&STANDARD.decode(document.private_key)?)?;
            ensure!(
                key.public().to_peer_id().to_string() == document.peer_id,
                "设备身份校验失败"
            );
            key.clone()
                .try_into_ed25519()
                .context("设备身份必须使用 Ed25519")?;
            key
        } else {
            let key = Keypair::generate_ed25519();
            let document = IdentityFile {
                peer_id: key.public().to_peer_id().to_string(),
                private_key: STANDARD.encode(key.to_protobuf_encoding()?),
            };
            let path = directory.join(format!(".identity-{}", Uuid::new_v4()));
            let mut file = private_file(&path, true)?;
            let write = (|| -> Result<()> {
                file.write_all(&serde_json::to_vec(&document)?)?;
                file.sync_all()?;
                drop(file);
                fs::rename(&path, &identity_path)?;
                Ok(())
            })();
            if write.is_err() {
                let _ = fs::remove_file(path);
            }
            write?;
            key
        };
        let path = directory.join("state.sqlite");
        drop(private_file(&path, true)?);
        let mut db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(3))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS pairing (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS devices (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
               created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS device_keys (
               peer_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, route_ticket TEXT UNIQUE NOT NULL
             );
             CREATE TABLE IF NOT EXISTS operations (
               id TEXT NOT NULL, device_id TEXT NOT NULL, thread_id TEXT NOT NULL,
               kind TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
               turn_id TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
               result_thread_id TEXT, backend_id TEXT NOT NULL DEFAULT 'codex-local',
               PRIMARY KEY(backend_id,id)
             );
             CREATE TABLE IF NOT EXISTS native_uploads (
               id TEXT PRIMARY KEY, device TEXT NOT NULL, thread TEXT NOT NULL,
               manifest TEXT NOT NULL, present TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0,
               expires INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS native_storage_objects (
               id TEXT PRIMARY KEY, device TEXT NOT NULL, thread TEXT NOT NULL, transfer TEXT NOT NULL,
               indices TEXT NOT NULL, download INTEGER NOT NULL, expires INTEGER NOT NULL
             );",
        )?;
        migrate_operations(&mut db)?;
        db.execute(
            "CREATE INDEX IF NOT EXISTS operations_by_conversation ON operations(backend_id,thread_id,device_id,created)",
            [],
        )?;
        db.execute("UPDATE operations SET state='uncertain',error='网关重启，等待原实例状态确认',updated=?1 WHERE state='dispatching'", [now()])?;
        db.execute("UPDATE operations SET state='rejected',error='网关在发送前退出',updated=?1 WHERE state='received'", [now()])?;
        Ok(Self {
            db,
            directory: directory.to_owned(),
            identity,
            downloads: Default::default(),
            _lock: lock,
        })
    }

    pub fn mint_pairing(&mut self, previous: Option<&Pairing>) -> Result<Pairing> {
        let code = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>());
        let expires_at = now() + 5 * 60_000;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM pairing WHERE expires <= ?1", [now()])?;
        if let Some(previous) = previous {
            tx.execute(
                "DELETE FROM pairing WHERE hash = ?1",
                [hash(&previous.code)],
            )?;
        }
        tx.execute(
            "INSERT INTO pairing VALUES (?1, ?2)",
            params![hash(&code), expires_at],
        )?;
        tx.commit()?;
        Ok(Pairing { code, expires_at })
    }

    pub fn pairing_pending(&self, pairing: &Pairing) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "SELECT 1 FROM pairing WHERE hash = ?1 AND expires > ?2",
                params![hash(&pairing.code), now()],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub fn routes(&self) -> Result<Vec<Route>> {
        let mut query = self.db.prepare(
            "SELECT hash, expires, NULL FROM pairing WHERE expires > ?1
             UNION ALL
             SELECT k.route_ticket, d.expires, k.peer_id FROM device_keys k
               JOIN devices d ON d.id=k.device_id WHERE d.revoked=0 AND d.expires > ?1
             LIMIT 256",
        )?;
        Ok(query
            .query_map([now()], |row| {
                Ok(Route {
                    ticket: row.get(0)?,
                    expires: row.get(1)?,
                    peer_id: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn device(&self, peer: PeerId) -> Result<Option<Device>> {
        Ok(self.db.query_row(
            "SELECT d.id,d.name,k.route_ticket FROM device_keys k JOIN devices d ON d.id=k.device_id
             WHERE k.peer_id=?1 AND d.revoked=0 AND d.expires>?2",
            params![peer.to_string(), now()],
            |row| Ok(Device { id: row.get(0)?, name: row.get(1)?, ticket: row.get(2)? }),
        ).optional()?)
    }

    pub fn pair(&mut self, ticket: &str, name: &str, peer: PeerId) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let time = now();
        if tx.execute(
            "DELETE FROM pairing WHERE hash=?1 AND expires>?2",
            params![ticket, time],
        )? != 1
        {
            bail!("配对码已经使用或过期");
        }
        let device_id = Uuid::new_v4().to_string();
        let token = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
        let route_ticket = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
        tx.execute(
            "INSERT INTO devices (id,name,token_hash,created,expires) VALUES (?1,?2,?3,?4,?5)",
            params![device_id, name, hash(&token), time, time + 30 * 86_400_000],
        )?;
        let peer = peer.to_string();
        tx.execute("UPDATE devices SET revoked=1 WHERE id IN (SELECT device_id FROM device_keys WHERE peer_id=?1)", [&peer])?;
        tx.execute(
            "INSERT OR REPLACE INTO device_keys VALUES (?1,?2,?3)",
            params![peer, device_id, route_ticket],
        )?;
        tx.commit()?;
        Ok(())
    }
}

fn migrate_operations(db: &mut Connection) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let columns = {
        let mut query = tx.prepare("PRAGMA table_info(operations)")?;
        query
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, u32>(5)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if !columns.iter().any(|(name, _)| name == "result_thread_id") {
        tx.execute(
            "ALTER TABLE operations ADD COLUMN result_thread_id TEXT",
            [],
        )?;
    }
    if !columns.iter().any(|(name, _)| name == "backend_id") {
        tx.execute(
            "ALTER TABLE operations ADD COLUMN backend_id TEXT NOT NULL DEFAULT 'codex-local'",
            [],
        )?;
    }
    if columns.iter().filter(|(_, key)| *key > 0).count() == 1 {
        tx.execute_batch(
            "ALTER TABLE operations RENAME TO operations_legacy;
             CREATE TABLE operations (
               id TEXT NOT NULL, device_id TEXT NOT NULL, thread_id TEXT NOT NULL,
               kind TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
               turn_id TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
               result_thread_id TEXT, backend_id TEXT NOT NULL DEFAULT 'codex-local',
               PRIMARY KEY(backend_id,id)
             );
             INSERT INTO operations
               SELECT id,device_id,thread_id,kind,fingerprint,state,turn_id,error,created,updated,
                      result_thread_id,backend_id
               FROM operations_legacy;
             DROP TABLE operations_legacy;",
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub(crate) fn lock_directory(directory: &Path) -> Result<File> {
    private_directory(directory)?;
    let lock = private_file(&directory.join("native.lock"), true)?;
    lock.try_lock().context("已有原生适配器使用此状态目录")?;
    for name in ["device-identity-v2.json", "state.sqlite"] {
        let path = directory.join(name);
        match fs::symlink_metadata(&path) {
            Ok(_) => drop(private_file(&path, false).with_context(|| format!("检查 {name}"))?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    for name in [
        "state.sqlite-wal",
        "state.sqlite-shm",
        "state.sqlite-journal",
    ] {
        let path = directory.join(name);
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                #[cfg(windows)]
                crate::windows::private_sqlite_sidecar(&path)
                    .with_context(|| format!("检查 {name}"))?;
                #[cfg(not(windows))]
                drop(private_file(&path, false)?);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(lock)
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(unix)]
pub(crate) fn private_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    match fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
    {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir()
            && metadata.uid() == rustix::process::geteuid().as_raw()
            && metadata.mode() & 0o777 == 0o700,
        "状态目录必须属于当前用户，权限为 0700"
    );
    Ok(())
}

#[cfg(unix)]
pub(crate) fn private_file(path: &Path, create: bool) -> Result<File> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == rustix::process::geteuid().as_raw()
            && metadata.mode() & 0o777 == 0o600,
        "状态文件必须属于当前用户，权限为 0600"
    );
    Ok(file)
}

#[cfg(windows)]
pub(crate) use crate::windows::{private_directory, private_file};

#[cfg(not(any(unix, windows)))]
fn private_directory(_: &Path) -> Result<()> {
    bail!("此预览尚未实现 Windows 的私有目录 ACL")
}

#[cfg(not(any(unix, windows)))]
fn private_file(_: &Path, _: bool) -> Result<File> {
    bail!("此预览尚未实现 Windows 的私有文件 ACL")
}

pub fn saved_origin(directory: &Path) -> Result<Option<String>> {
    use std::io::Read;
    let path = directory.join("service-origin");
    if !path.exists() {
        return Ok(None);
    }
    private_directory(directory)?;
    let mut origin = String::new();
    private_file(&path, false)?
        .take(8192)
        .read_to_string(&mut origin)?;
    Ok(Some(origin))
}

pub fn remember_origin(directory: &Path, origin: &str) -> Result<()> {
    if saved_origin(directory)?.as_deref() == Some(origin) {
        return Ok(());
    }
    let temp = directory.join(format!(".origin-{}", Uuid::new_v4()));
    let write = (|| -> Result<()> {
        let mut file = private_file(&temp, true)?;
        file.write_all(origin.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, directory.join("service-origin"))?;
        Ok(())
    })();
    if write.is_err() {
        let _ = fs::remove_file(temp);
    }
    write
}
