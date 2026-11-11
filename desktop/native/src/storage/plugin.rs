use super::{GRANT_TTL_MS, OBJECT_TTL_MS, now, origin};
use crate::{plugin_catalog::Catalog, plugin_host::Host, state::private_file};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::TempPath;
use url::Url;
use uuid::Uuid;

pub(super) struct NativeStorage {
    host: Host,
    directory: PathBuf,
    allowed_origin: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Info {
    version: u8,
    visibility: String,
    upload_origins: Vec<String>,
    #[serde(default)]
    remove: bool,
}

#[derive(Deserialize)]
#[serde(tag = "encoding", rename_all = "lowercase", deny_unknown_fields)]
enum Upload {
    Multipart {
        url: String,
        method: String,
        fields: HashMap<String, String>,
        #[serde(rename = "fileField")]
        file_field: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    Raw {
        url: String,
        method: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

impl NativeStorage {
    pub(super) fn load(
        directory: &Path,
        relay: &Url,
        key: &str,
        config: Option<&Path>,
    ) -> Result<Self> {
        let package = Catalog::open(directory)?
            .package(key)?
            .context("未安装指定的原生对象存储插件")?;
        ensure!(
            package.manifest.product == "object-storage",
            "指定的插件不是对象存储插件"
        );
        let settings = if let Some(config) = config {
            ensure!(config.is_absolute(), "对象存储插件配置必须是绝对路径");
            let mut bytes = Vec::new();
            private_file(config, false)?
                .take(64 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 64 * 1024, "对象存储插件配置过大");
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| anyhow::anyhow!("对象存储插件配置无效"))?;
            ensure!(value.is_object(), "对象存储插件配置必须为 JSON 对象");
            value
        } else {
            json!({})
        };
        let allowed_origin = relay.origin().ascii_serialization();
        let directory = directory.join("native-storage-plugin");
        let host = Host::new(
            "media-storage".into(),
            "Private object storage".into(),
            Some(package),
            json!({"purpose":"media","origin":allowed_origin,"settings":settings}),
            directory.clone(),
            false,
        );
        Ok(Self {
            host,
            directory,
            allowed_origin,
        })
    }

    async fn info(&self) -> Result<Info> {
        let info: Info = serde_json::from_value(
            self.host
                .call("storage/info", json!({}), Duration::from_secs(15))
                .await?,
        )?;
        ensure!(
            info.version == 1
                && info.visibility == "private"
                && info.upload_origins.len() <= 32
                && info.upload_origins.iter().all(|raw| {
                    origin(raw).is_ok_and(|url| url.origin().ascii_serialization() == *raw)
                }),
            "原生对象存储插件必须声明私有存储及 HTTPS 上传源"
        );
        Ok(info)
    }

    pub(super) async fn plan(&self, key: &str, size: usize) -> Result<Value> {
        let info = self.info().await?;
        let grant = self
            .host
            .call(
                "storage/createUpload",
                json!({"key":key,"size":size,"expiresAt":now() + GRANT_TTL_MS}),
                Duration::from_secs(15),
            )
            .await?;
        validate_upload(&grant, &info.upload_origins)?;
        Ok(grant)
    }

    pub(super) async fn download_url(&self, key: &str, expires: i64) -> Result<Url> {
        self.info().await?;
        let result = self
            .host
            .call(
                "storage/downloadUrl",
                json!({"key":key,"expiresAt":expires}),
                Duration::from_secs(15),
            )
            .await?;
        signed_url(result.as_str().context("对象存储下载授权无效")?)
    }

    pub(super) async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        self.info().await?;
        let path = self
            .directory
            .join(format!("ciphertext-{}", Uuid::new_v4()));
        let staged = tokio::task::spawn_blocking(move || -> Result<_> {
            let cleanup = TempPath::try_from_path(&path)?;
            let mut file = private_file(&path, true)?;
            file.write_all(&bytes)?;
            Ok((cleanup, path))
        })
        .await??;
        let result = self
            .host
            .call(
                "storage/putFile",
                json!({
                    "key":key,"file":staged.1,"contentType":"application/octet-stream",
                    "cacheControl":"private, max-age=0","allowedOrigin":self.allowed_origin,
                    "expiresAt":now() + OBJECT_TTL_MS
                }),
                Duration::from_secs(120),
            )
            .await?;
        ensure!(
            matches!(result.as_str(), Some("created" | "exists")),
            "对象存储写入未确认"
        );
        Ok(())
    }

    pub(super) async fn remove(&self, key: &str) -> Result<()> {
        if self.info().await?.remove {
            let result = self
                .host
                .call(
                    "storage/remove",
                    json!({"key":key}),
                    Duration::from_secs(15),
                )
                .await?;
            ensure!(result["ok"] == true, "对象存储清理未确认");
        }
        Ok(())
    }
}

fn signed_url(raw: &str) -> Result<Url> {
    ensure!(raw.len() <= 16 * 1024, "对象存储授权过大");
    let url = Url::parse(raw).map_err(|_| anyhow::anyhow!("对象存储授权地址无效"))?;
    ensure!(
        url.scheme() == "https"
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none(),
        "对象存储授权必须使用 HTTPS"
    );
    Ok(url)
}

fn validate_upload(value: &Value, origins: &[String]) -> Result<()> {
    let upload: Upload = serde_json::from_value(value.clone())
        .map_err(|_| anyhow::anyhow!("原生对象存储上传授权无效"))?;
    let (url, headers) = match upload {
        Upload::Multipart {
            url,
            method,
            fields,
            file_field,
            headers,
        } => {
            ensure!(
                method == "POST"
                    && (1..=200).contains(&file_field.len())
                    && !fields.contains_key(&file_field)
                    && fields.len() <= 64
                    && fields.keys().all(|key| (1..=200).contains(&key.len())),
                "对象存储表单授权无效"
            );
            (url, headers)
        }
        Upload::Raw {
            url,
            method,
            headers,
        } => {
            ensure!(method == "PUT", "对象存储直传授权无效");
            (url, headers)
        }
    };
    ensure!(
        headers.len() <= 64
            && headers.iter().all(|(name, value)| {
                !name.is_empty()
                    && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    && reqwest::header::HeaderValue::from_str(value).is_ok()
            }),
        "对象存储授权请求头无效"
    );
    let url = signed_url(&url)?;
    ensure!(
        origins.contains(&url.origin().ascii_serialization()),
        "对象存储未声明此上传源"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_both_old_browser_grant_shapes() {
        let origins = ["https://uploads.example.org".to_owned()];
        let multipart = json!({
            "url":"https://uploads.example.org/","method":"POST","encoding":"multipart",
            "fields":{"policy":"fixture"},"fileField":"file",
        });
        let raw = json!({
            "url":"https://uploads.example.org/object?token=fixture","method":"PUT","encoding":"raw",
            "headers":{"Content-Type":"application/octet-stream"},
        });
        assert!(validate_upload(&multipart, &origins).is_ok());
        assert!(validate_upload(&raw, &origins).is_ok());
        for (key, value) in [
            ("url", json!("https://elsewhere.example.org/object")),
            ("url", json!("https://user@uploads.example.org/object")),
            ("url", json!("http://uploads.example.org/object")),
            ("method", json!("POST")),
            ("headers", json!({"X-Test":"invalid\r\nheader"})),
        ] {
            let mut invalid = raw.clone();
            invalid[key] = value;
            assert!(validate_upload(&invalid, &origins).is_err());
        }
        let mut overlapping = multipart;
        overlapping["fields"]["file"] = json!("conflict");
        assert!(validate_upload(&overlapping, &origins).is_err());
    }
}
