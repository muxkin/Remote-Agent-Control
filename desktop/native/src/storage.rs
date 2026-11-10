use crate::{
    files::BLOCK,
    gateway::Database,
    history_media::legacy_upload_receipt,
    state::{legacy_private_file, now, private_file},
};
use anyhow::{Context, Result, ensure};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE},
};
use reqwest::{
    Client,
    multipart::{Form, Part},
};
use ring::{aead, hmac};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{OnceCell, Semaphore};
use url::Url;
use uuid::Uuid;

mod discovery;
mod plugin;
use discovery::Endpoints;
use plugin::NativeStorage;

#[derive(Clone)]
pub struct Storage {
    inner: Arc<Transport>,
}

struct Transport {
    http: Client,
    provider: Provider,
    prefix: String,
    batch: usize,
    jobs: Semaphore,
}

enum Provider {
    Qiniu(Qiniu),
    Plugin(NativeStorage),
}

struct Qiniu {
    http: Client,
    upload_override: Option<Url>,
    endpoints: OnceCell<Endpoints>,
    download: Url,
    access_key: String,
    secret: hmac::Key,
    bucket: String,
}

pub struct Transports {
    pub direct: Option<crate::direct::Direct>,
    pub storage: Option<Storage>,
}

impl Transports {
    pub fn load(directory: &Path, relay: &Url) -> Result<Self> {
        let file = directory.join("transport.env");
        let profile = if file.exists() {
            dotenvy::Iter::new(private_file(&file, false)?)
                .collect::<Result<HashMap<_, _>, _>>()
                .map_err(|_| anyhow::anyhow!("原生适配器 transport.env 格式无效"))?
        } else {
            HashMap::new()
        };
        let explicit = |name: &str| {
            std::env::var(name)
                .ok()
                .or_else(|| profile.get(name).cloned())
        };
        let legacy = match explicit("POCKET_NATIVE_STORAGE_ENV_FILE") {
            Some(path) => {
                let path = PathBuf::from(path);
                ensure!(path.is_absolute(), "对象存储配置文件必须是绝对路径");
                transport_settings(legacy_private_file(&path)?, true)?
            }
            None => migrated_transport_settings(directory, crate::migration::source())?,
        };
        let get = |name: &str| explicit(name).or_else(|| legacy.get(name).cloned());
        let direct = if get("POCKET_NATIVE_P2P")
            .or_else(|| get("POCKET_P2P"))
            .as_deref()
            == Some("0")
        {
            None
        } else {
            let urls: Vec<_> = get("POCKET_STUN_URLS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(str::to_owned)
                .collect();
            ensure!(
                urls.len() <= 8
                    && urls.iter().all(|url| url.len() <= 256
                        && !url.chars().any(char::is_whitespace)
                        && (url.starts_with("stun:") || url.starts_with("stuns:"))),
                "STUN 配置无效"
            );
            Some(crate::direct::Direct::new(urls))
        };
        let upload = get("POCKET_NATIVE_QINIU_UPLOAD_URL").filter(|value| !value.is_empty());
        let storage = if let Some(key) = explicit("POCKET_NATIVE_STORAGE_PLUGIN") {
            let config = explicit("POCKET_NATIVE_STORAGE_PLUGIN_CONFIG").map(PathBuf::from);
            let plugin = NativeStorage::load(directory, relay, &key, config.as_deref())?;
            Some(Storage::new(Provider::Plugin(plugin), &get)?)
        } else if upload.is_some()
            || [
                "POCKET_MEDIA_ORIGIN",
                "POCKET_MEDIA_BUCKET",
                "POCKET_QINIU_ACCESS_KEY",
                "POCKET_QINIU_SECRET_KEY",
            ]
            .iter()
            .all(|key| get(key).is_some_and(|value| !value.is_empty()))
        {
            Some(Storage::qiniu(upload, &get)?)
        } else {
            None
        };
        Ok(Self { direct, storage })
    }
}

fn migrated_transport_settings(
    directory: &Path,
    source: Option<&Path>,
) -> Result<HashMap<String, String>> {
    let Some(source) = source else {
        return Ok(HashMap::new());
    };
    let config = directory.join("gateway.env");
    let config = if config.try_exists()? {
        config
    } else {
        source.join("gateway.env")
    };
    match legacy_private_file(&config) {
        Ok(file) => transport_settings(file, false),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(HashMap::new())
        }
        Err(error) => Err(error),
    }
}

fn transport_settings(file: std::fs::File, explicit: bool) -> Result<HashMap<String, String>> {
    let mut settings = HashMap::new();
    for entry in dotenvy::Iter::new(file) {
        let (key, value) = entry.map_err(|_| anyhow::anyhow!("既有传输配置格式无效"))?;
        if matches!(
            key.as_str(),
            "POCKET_MEDIA_ADAPTER"
                | "POCKET_MEDIA_ORIGIN"
                | "POCKET_MEDIA_BUCKET"
                | "POCKET_MEDIA_PREFIX"
                | "POCKET_QINIU_ACCESS_KEY"
                | "POCKET_QINIU_SECRET_KEY"
                | "POCKET_NATIVE_QINIU_UPLOAD_URL"
                | "POCKET_NATIVE_STORAGE_BATCH_MIB"
                | "POCKET_NATIVE_P2P"
                | "POCKET_P2P"
                | "POCKET_STUN_URLS"
        ) {
            settings.insert(key, value);
        }
    }
    let used_media = settings
        .remove("POCKET_MEDIA_ADAPTER")
        .is_some_and(|value| !value.is_empty());
    if !explicit && !used_media {
        settings.retain(|key, _| {
            matches!(
                key.as_str(),
                "POCKET_NATIVE_P2P" | "POCKET_P2P" | "POCKET_STUN_URLS"
            )
        });
    }
    Ok(settings)
}

impl Storage {
    fn qiniu(upload: Option<String>, get: &impl Fn(&str) -> Option<String>) -> Result<Self> {
        let required = |name| {
            get(name)
                .filter(|value| !value.is_empty())
                .with_context(|| format!("缺少对象存储配置 {name}"))
        };
        let upload_override = upload.as_deref().map(origin).transpose()?;
        let download = origin(&required("POCKET_MEDIA_ORIGIN")?)?;
        let access_key = required("POCKET_QINIU_ACCESS_KEY")?;
        let secret = hmac::Key::new(
            hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
            required("POCKET_QINIU_SECRET_KEY")?.as_bytes(),
        );
        let bucket = required("POCKET_MEDIA_BUCKET")?;
        Self::new(
            Provider::Qiniu(Qiniu {
                http: storage_client()?,
                upload_override,
                endpoints: OnceCell::new(),
                download,
                access_key,
                secret,
                bucket,
            }),
            get,
        )
    }

    fn new(provider: Provider, get: &impl Fn(&str) -> Option<String>) -> Result<Self> {
        let prefix = get("POCKET_MEDIA_PREFIX").unwrap_or_else(|| "codex-pocket".to_owned());
        ensure!(
            !prefix.is_empty()
                && prefix.len() <= 63
                && prefix.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'-'
                    || b == b'_'),
            "对象存储前缀无效"
        );
        let batch = get("POCKET_NATIVE_STORAGE_BATCH_MIB")
            .map(|v| v.parse::<usize>())
            .transpose()?
            .unwrap_or(25);
        ensure!((1..=50).contains(&batch), "对象存储批次须在 1–50 MiB");
        let http = match &provider {
            Provider::Qiniu(qiniu) => qiniu.http.clone(),
            Provider::Plugin(_) => storage_client()?,
        };
        Ok(Self {
            inner: Arc::new(Transport {
                http,
                provider,
                prefix,
                batch,
                jobs: Semaphore::new(2),
            }),
        })
    }

    pub fn batch(&self) -> usize {
        self.inner.batch
    }

    pub async fn handle(
        &self,
        db: Database,
        device: String,
        scope: crate::files::Scope,
        id: Uuid,
        action: &str,
        request: &Value,
    ) -> Result<Value> {
        let _job = self
            .inner
            .jobs
            .try_acquire()
            .context("对象存储正在处理其他附件")?;
        if matches!(action, "storage-plan" | "storage-import") {
            let (db, device, scope) = (db.clone(), device.clone(), scope.clone());
            let batch = self.batch();
            tokio::task::spawn_blocking(move || {
                db.lock()
                    .expect("database mutex poisoned")
                    .import_pending_upload(&device, &scope, id, Some(batch))
            })
            .await??;
        }
        if action == "storage-plan" {
            let indices: Vec<usize> = serde_json::from_value(request["indices"].clone())?;
            ensure!(
                !indices.is_empty()
                    && indices.len() <= self.batch()
                    && indices
                        .windows(2)
                        .all(|pair| pair[0].checked_add(1) == Some(pair[1])),
                "对象存储批次无效"
            );
            let (manifest, complete) = db
                .lock()
                .expect("database mutex poisoned")
                .storage_manifest(&device, &scope, id)?;
            let size = indices.iter().try_fold(0, |total, &index| {
                Ok::<_, anyhow::Error>(total + block_length(&manifest, index)? + aead::MAX_TAG_LEN)
            })?;
            let object = Uuid::new_v4();
            let key = self.inner.key(object);
            let grant = if complete {
                None
            } else {
                Some(self.inner.provider.plan(&key, size).await?)
            };
            {
                let store = db.lock().expect("database mutex poisoned");
                store.db.execute(
                    "DELETE FROM native_storage_objects WHERE expires<=?1",
                    [now()],
                )?;
                let count: i64 = store.db.query_row(
                    "SELECT count(*) FROM native_storage_objects WHERE device=?1",
                    [&device],
                    |row| row.get(0),
                )?;
                ensure!(count < 32, "待处理对象存储批次过多");
                store.db.execute(
                    "INSERT INTO native_storage_objects VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![
                        object.to_string(),
                        device,
                        scope.key(),
                        id.to_string(),
                        serde_json::to_string(&indices)?,
                        complete,
                        now() + 900_000
                    ],
                )?;
            }
            if let Some(grant) = grant {
                return Ok(json!({"objectId":object,"upload":grant}));
            }
            let mut ciphertext = Vec::with_capacity(size);
            for &index in &indices {
                let db = db.clone();
                let device = device.clone();
                let manifest = manifest.clone();
                let scope = scope.clone();
                let block = tokio::task::spawn_blocking(move || {
                    let plain = db.lock().expect("database mutex poisoned").read_upload(
                        &device,
                        &scope,
                        id,
                        index as u64,
                    )?;
                    encrypt(&manifest, index, plain)
                })
                .await??;
                ciphertext.extend(block);
            }
            self.inner.provider.put(&key, ciphertext).await?;
            let url = self.inner.provider.download_url(&key, 900).await?;
            return Ok(
                json!({"objectId":object,"url":url.as_str(), "indices":indices, "size":size}),
            );
        }

        let object = Uuid::parse_str(request["objectId"].as_str().context("对象编号无效")?)?;
        let native = db.lock().expect("database mutex poisoned").db.query_row(
            "SELECT indices,download FROM native_storage_objects WHERE id=?1 AND device=?2 AND thread=?3 AND transfer=?4 AND expires>?5",
            params![object.to_string(), device, scope.key(), id.to_string(), now()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        ).optional()?;
        let key = self.inner.key(object);
        let (indices, download) = match &native {
            Some((indices, download)) => (serde_json::from_str(indices)?, *download),
            None if action == "storage-import" => {
                let indices = legacy_object_indices(&device, &scope, id, object, &key)?;
                let missing = db.lock().expect("database mutex poisoned").file_request(
                    &device,
                    &scope,
                    id,
                    "missing",
                    None,
                    &[],
                )?;
                for &index in &indices {
                    block_length(&missing["manifest"], index)?;
                }
                let missing: Vec<usize> = serde_json::from_value(missing["missing"].clone())?;
                if indices.iter().all(|index| !missing.contains(index)) {
                    return Ok(json!({"ok":true}));
                }
                (indices, false)
            }
            None => anyhow::bail!("对象不属于此附件或已过期"),
        };
        match action {
            "storage-import" if !download => {
                let (manifest, _) = db
                    .lock()
                    .expect("database mutex poisoned")
                    .storage_manifest(&device, &scope, id)?;
                let size = indices.iter().try_fold(0, |total, &index| {
                    Ok::<_, anyhow::Error>(
                        total + block_length(&manifest, index)? + aead::MAX_TAG_LEN,
                    )
                })?;
                let url = self.inner.provider.download_url(&key, 300).await?;
                let mut response = self.inner.http.get(url).send().await?;
                ensure!(
                    response.status().is_success()
                        && response.content_length().is_none_or(|n| n == size as u64),
                    "对象读取失败或大小无效"
                );
                let mut encrypted = Vec::with_capacity(size);
                while let Some(chunk) = response.chunk().await? {
                    ensure!(encrypted.len() + chunk.len() <= size, "对象数据过大");
                    encrypted.extend_from_slice(&chunk);
                }
                ensure!(encrypted.len() == size, "对象数据未传完");
                let device = device.clone();
                let db = db.clone();
                tokio::task::spawn_blocking(move || {
                    let mut offset = 0;
                    for index in indices {
                        let end = offset + block_length(&manifest, index)? + aead::MAX_TAG_LEN;
                        let plain = decrypt(&manifest, index, encrypted[offset..end].to_vec())?;
                        db.lock().expect("database mutex poisoned").file_request(
                            &device,
                            &scope,
                            id,
                            "write",
                            Some(index as u64),
                            &plain,
                        )?;
                        offset = end;
                    }
                    Ok::<_, anyhow::Error>(())
                })
                .await??;
            }
            "storage-done" if download => {}
            _ => anyhow::bail!("对象方向无效"),
        }
        // The bucket policy expires unfinished ciphertext even if the desktop is offline.
        if self.inner.provider.remove(&key).await.is_ok() && native.is_some() {
            db.lock().expect("database mutex poisoned").db.execute(
                "DELETE FROM native_storage_objects WHERE id=?1",
                [object.to_string()],
            )?;
        }
        Ok(json!({"ok":true}))
    }
}

fn legacy_object_indices(
    device: &str,
    scope: &crate::files::Scope,
    transfer: Uuid,
    object: Uuid,
    key: &str,
) -> Result<Vec<usize>> {
    let (backend, thread) = scope.backend_and_thread();
    let record = legacy_upload_receipt(backend, thread, device, transfer)?
        .context("旧对象不属于此附件或已过期")?
        .storage_object(object)?
        .context("旧对象不存在")?;
    ensure!(
        record["id"] == object.to_string()
            && record["transfer"] == transfer.to_string()
            && record["key"] == key
            && record["expires"]
                .as_i64()
                .is_some_and(|expires| expires > now()),
        "旧对象不属于此附件或已过期"
    );
    let indices: Vec<usize> = serde_json::from_value(record["indices"].clone())?;
    ensure!(
        (1..=15).contains(&indices.len())
            && indices.iter().all(|&index| index < 256)
            && indices.windows(2).all(|pair| pair[0] + 1 == pair[1]),
        "旧对象的分块清单无效"
    );
    Ok(indices)
}

fn origin(raw: &str) -> Result<Url> {
    let url = Url::parse(raw)?;
    ensure!(
        url.scheme() == "https"
            && url.host().is_some()
            && url.path() == "/"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "对象存储要求 HTTPS 源"
    );
    Ok(url)
}

fn storage_client() -> Result<Client> {
    Ok(Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(120))
        .build()?)
}

impl Transport {
    fn key(&self, id: Uuid) -> String {
        format!("{}/private-encrypted-v2/{id}", self.prefix)
    }
}

impl Provider {
    async fn plan(&self, key: &str, size: usize) -> Result<Value> {
        match self {
            Self::Qiniu(qiniu) => qiniu.plan(&qiniu.endpoints().await?.upload, key, size),
            Self::Plugin(plugin) => plugin.plan(key, size).await,
        }
    }

    async fn download_url(&self, key: &str, seconds: i64) -> Result<Url> {
        match self {
            Self::Qiniu(qiniu) => {
                qiniu.endpoints().await?;
                Ok(Url::parse(&qiniu.signed_url(key, seconds))?)
            }
            Self::Plugin(plugin) => plugin.download_url(key, now() + seconds * 1_000).await,
        }
    }

    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        match self {
            Self::Qiniu(qiniu) => {
                qiniu
                    .put(&qiniu.endpoints().await?.upload, key, bytes)
                    .await
            }
            Self::Plugin(plugin) => plugin.put(key, bytes).await,
        }
    }

    async fn remove(&self, key: &str) -> Result<()> {
        match self {
            Self::Qiniu(qiniu) => qiniu.remove(key).await,
            Self::Plugin(plugin) => plugin.remove(key).await,
        }
    }
}

impl Qiniu {
    fn sign(&self, data: &str) -> String {
        format!(
            "{}:{}",
            self.access_key,
            URL_SAFE.encode(hmac::sign(&self.secret, data.as_bytes()))
        )
    }

    fn token(&self, key: &str, size: usize) -> Result<String> {
        let policy = json!({"scope":format!("{}:{key}",self.bucket),"insertOnly":1,
            "deadline":now()/1000+900,"fsizeMin":size,"fsizeLimit":size,"deleteAfterDays":1});
        let policy = URL_SAFE.encode(serde_json::to_vec(&policy)?);
        Ok(format!("{}:{policy}", self.sign(&policy)))
    }

    fn plan(&self, upload: &Url, key: &str, size: usize) -> Result<Value> {
        Ok(
            json!({"url":upload.as_str(),"method":"POST","encoding":"multipart",
            "fields":{"token":self.token(key,size)?,"key":key},"fileField":"file"}),
        )
    }

    fn signed_url(&self, key: &str, seconds: i64) -> String {
        let url = format!("{}{key}?e={}", self.download, now() / 1000 + seconds);
        format!("{url}&token={}", self.sign(&url))
    }

    async fn put(&self, upload: &Url, key: &str, bytes: Vec<u8>) -> Result<()> {
        let form = Form::new()
            .text("key", key.to_owned())
            .text("token", self.token(key, bytes.len())?)
            .part(
                "file",
                Part::bytes(bytes)
                    .file_name("data")
                    .mime_str("application/octet-stream")?,
            );
        ensure!(
            self.http
                .post(upload.clone())
                .multipart(form)
                .send()
                .await?
                .status()
                .is_success(),
            "对象写入失败"
        );
        Ok(())
    }

    async fn remove(&self, key: &str) -> Result<()> {
        let path = format!(
            "/delete/{}",
            URL_SAFE.encode(format!("{}:{key}", self.bucket))
        );
        let url = self.endpoints().await?.resource.join(&path)?;
        let response = self.management_request(url).send().await?;
        ensure!(
            response.status().is_success() || response.status().as_u16() == 612,
            "对象清理失败"
        );
        Ok(())
    }
}

fn block_length(manifest: &Value, index: usize) -> Result<usize> {
    ensure!(manifest["hashes"].get(index).is_some(), "附件块不存在");
    let size = usize::try_from(manifest["size"].as_u64().context("附件大小无效")?)?;
    Ok((size - index * BLOCK).min(BLOCK))
}

fn cipher(manifest: &Value, index: usize) -> Result<(aead::LessSafeKey, aead::Nonce, Vec<u8>)> {
    let key = STANDARD.decode(manifest["key"].as_str().context("附件密钥无效")?)?;
    let prefix = STANDARD.decode(manifest["nonce"].as_str().context("附件 nonce 无效")?)?;
    ensure!(prefix.len() == 8, "附件 nonce 无效");
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| anyhow::anyhow!("附件密钥无效"))?;
    let mut nonce = [0; 12];
    nonce[..8].copy_from_slice(&prefix);
    nonce[8..].copy_from_slice(&u32::try_from(index)?.to_be_bytes());
    let aad = serde_json::to_vec(&json!([
        manifest["id"],
        manifest["version"],
        index,
        block_length(manifest, index)?
    ]))?;
    Ok((
        aead::LessSafeKey::new(key),
        aead::Nonce::assume_unique_for_key(nonce),
        aad,
    ))
}

fn encrypt(manifest: &Value, index: usize, mut bytes: Vec<u8>) -> Result<Vec<u8>> {
    let (key, nonce, aad) = cipher(manifest, index)?;
    key.seal_in_place_append_tag(nonce, aead::Aad::from(aad), &mut bytes)
        .map_err(|_| anyhow::anyhow!("附件加密失败"))?;
    Ok(bytes)
}

fn decrypt(manifest: &Value, index: usize, mut bytes: Vec<u8>) -> Result<Vec<u8>> {
    let (key, nonce, aad) = cipher(manifest, index)?;
    let length = key
        .open_in_place(nonce, aead::Aad::from(aad), &mut bytes)
        .map_err(|_| anyhow::anyhow!("对象附件认证失败"))?
        .len();
    bytes.truncate(length);
    Ok(bytes)
}

#[cfg(test)]
mod tests;
