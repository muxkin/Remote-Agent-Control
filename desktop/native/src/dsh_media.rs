use crate::{
    dsh::{Dsh, Session, records},
    files::{BLOCK, VerifiedUpload},
    history_media::{MissingAttachment, Source, legacy_root, links},
    plugins::Media,
    state::{hash, private_file},
};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

const MAX_FILE: u64 = 256 * BLOCK as u64;
const MAX_IMAGE_BATCH: u64 = 32 * BLOCK as u64;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    attachment_id: String,
    bytes: u64,
    name: Option<String>,
    media_type: Option<String>,
}

pub(crate) fn attachments(message: &Value) -> Vec<Value> {
    content_attachments(message)
        .filter_map(|(kind, data)| {
            let id = data["attachmentId"].as_str().filter(|id| {
                attachment_digest(id).is_some() || (kind == "image" && valid_id(id))
            })?;
            let fallback = if kind == "image" { "图片" } else { "附件" };
            Some(json!({
                "name":data["name"].as_str().filter(|name| valid_name(name)).unwrap_or(fallback),
                "path":format!("dsh-{kind}:{id}")
            }))
        })
        .take(32)
        .collect()
}

fn content_attachments(message: &Value) -> impl Iterator<Item = (&str, &Value)> {
    message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            let kind @ ("image" | "file") = block["type"].as_str()? else {
                return None;
            };
            Some((kind, &block["attachment"]))
        })
}

impl Dsh {
    pub(crate) async fn prompt_content(
        &self,
        session: &Session,
        thread: &str,
        text: &str,
        files: Vec<VerifiedUpload>,
        limits: &Value,
    ) -> Result<Vec<Value>> {
        let mut parts = Vec::new();
        if !text.is_empty() {
            parts.push(json!({"type":"text","text":text}));
        }
        let mut images = 0;
        let mut image_bytes = 0;
        for upload in files {
            let mut file = tokio::fs::File::from_std(private_file(&upload.path, false)?);
            ensure!(
                (1..=MAX_FILE).contains(&upload.size)
                    && file.metadata().await?.len() == upload.size,
                "附件大小已变化"
            );
            let mut prefix = [0; 12];
            file.read_exact(&mut prefix[..upload.size.min(12) as usize])
                .await?;
            file.rewind().await?;
            if let Some(mime) = image_type(&prefix) {
                images += 1;
                image_bytes += upload.size;
                ensure!(
                    images <= limits["maxImagesPerMessage"].as_u64().unwrap_or(10)
                        && upload.size
                            <= limits["maxImageBytes"].as_u64().unwrap_or(MAX_IMAGE_BATCH)
                        && image_bytes
                            <= limits["maxMessageImageBytes"]
                                .as_u64()
                                .unwrap_or(MAX_IMAGE_BATCH)
                                .min(MAX_IMAGE_BATCH),
                    "图片超过 DSH 原生限制"
                );
                let mut bytes = Vec::with_capacity(upload.size as usize);
                file.take(upload.size + 1).read_to_end(&mut bytes).await?;
                ensure!(
                    bytes.len() as u64 == upload.size
                        && format!("{:x}", Sha256::digest(&bytes)) == upload.sha256,
                    "附件校验失败"
                );
                parts.push(json!({"type":"image","mediaType":mime,"data":STANDARD.encode(bytes),"name":upload.name}));
                continue;
            }
            let mut url = self.base.join("api/session/uploadFileBinary")?;
            url.query_pairs_mut()
                .append_pair("sessionId", thread)
                .append_pair("name", &upload.name);
            let response = self
                .authorized(session, self.http.post(url))
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .header(reqwest::header::CONTENT_LENGTH, upload.size)
                .timeout(Duration::from_secs(90))
                .body(reqwest::Body::wrap_stream(ReaderStream::new(
                    file.take(upload.size),
                )))
                .send()
                .await?;
            let value = crate::dsh::bounded_json(response, 64 * 1024).await?;
            let receipt = value["value"]["receiptId"]
                .as_str()
                .filter(|id| valid_id(id));
            let file = &value["value"]["file"];
            ensure!(
                value["ok"] == true
                    && file["attachmentId"].as_str().and_then(attachment_digest)
                        == Some(upload.sha256.as_str())
                    && file["bytes"] == upload.size,
                "DSH 未确认附件"
            );
            parts.push(json!({"type":"file","receiptId":receipt.context("DSH 未返回附件凭据")?}));
        }
        Ok(parts)
    }

    pub(crate) async fn attachment(&self, thread: &str, reference: &str) -> Result<Media> {
        if let Some(id) = reference
            .strip_prefix("dsh-image:")
            .filter(|id| attachment_digest(id).is_some() || valid_id(id))
        {
            let mut result = self
                .call(
                    "session/attachment",
                    json!({"request":{"sessionId":thread,"attachmentId":id}}),
                )
                .await
                .map_err(|_| MissingAttachment)?;
            let data: Reference = serde_json::from_value(result["attachment"].take())?;
            let bytes = STANDARD.decode(result["data"].as_str().context("DSH 图片无效")?)?;
            let mime = data
                .media_type
                .as_deref()
                .filter(|mime| image_type(&bytes) == Some(mime))
                .context("DSH 图片类型无效")?;
            ensure!(
                data.attachment_id == id && data.bytes == bytes.len() as u64,
                "DSH 图片校验失败"
            );
            let ext = match mime {
                "image/jpeg" => "jpg",
                "image/png" => "png",
                "image/gif" => "gif",
                "image/webp" => "webp",
                _ => unreachable!(),
            };
            let name = data
                .name
                .filter(|name| valid_name(name))
                .unwrap_or_else(|| "DSH 图片".to_owned());
            let actual_ext = Path::new(&name)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or_default();
            let name = if actual_ext.eq_ignore_ascii_case(ext)
                || (ext == "jpg" && actual_ext.eq_ignore_ascii_case("jpeg"))
            {
                name
            } else {
                format!("{name}.{ext}")
            };
            let mut file = tempfile::tempfile()?;
            file.write_all(&bytes)?;
            return Ok(Media::Download(Source {
                file,
                name,
                expected: None,
            }));
        }
        if let Some(id) = reference.strip_prefix("dsh-file:")
            && let Some(sha256) = attachment_digest(id)
        {
            let attachment =
                tokio::time::timeout(Duration::from_secs(12), self.find_file(thread, id)).await??;
            return Ok(Media::VerifiedFile {
                name: attachment
                    .name
                    .filter(|name| valid_name(name))
                    .unwrap_or_else(|| "DSH 附件".to_owned()),
                size: attachment.bytes,
                attachment_id: attachment.attachment_id,
                sha256: sha256.to_owned(),
            });
        }
        if reference.starts_with("dsh-file:") || reference.starts_with("dsh-image:") {
            return Err(MissingAttachment.into());
        }
        let path =
            tokio::time::timeout(Duration::from_secs(12), self.linked_path(thread, reference))
                .await??;
        self.download_link(&path).await.map(Media::Download)
    }

    async fn find_file(&self, thread: &str, id: &str) -> Result<Reference> {
        let page = self.snapshot(thread).await?;
        let found = self
            .find_message(thread, page, |message| {
                content_attachments(message)
                    .find(|(kind, data)| *kind == "file" && data["attachmentId"] == id)
                    .map(|(_, data)| data.clone())
            })
            .await?;
        Ok(serde_json::from_value(found)?)
    }

    async fn linked_path(&self, thread: &str, reference: &str) -> Result<String> {
        let page = self.snapshot(thread).await?;
        let cwd = page["header"]["cwd"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let path = workspace_path(&cwd, reference).context(MissingAttachment)?;
        self.find_message(thread, page, |message| {
            if message["role"] != "assistant" {
                return None;
            }
            let text = crate::dsh::blocks(message, "text");
            links(&text)
                .any(|link| workspace_path(&cwd, &link).as_deref() == Some(&path))
                .then_some(())
        })
        .await?;
        Ok(path)
    }

    async fn download_link(&self, path: &str) -> Result<Source> {
        let mut url = self.base.join("api/file")?;
        url.query_pairs_mut().append_pair("path", path);
        let name = path
            .rsplit(['/', '\\'])
            .next()
            .filter(|name| valid_name(name))
            .unwrap_or("DSH 文件");
        self.download_source(url, name.to_owned(), false).await
    }

    pub(crate) async fn session_log(&self, thread: &str) -> Result<Source> {
        let mut url = self.base.join("api/session.export")?;
        url.query_pairs_mut()
            .append_pair("sessionId", thread)
            .append_pair("includeDescendants", "true");
        let name = format!("dsh-session-{}.zip", &hash(thread)[..12]);
        self.download_source(url, name, true).await
    }

    async fn download_source(&self, url: url::Url, name: String, zip: bool) -> Result<Source> {
        let session = self.authenticate().await?;
        let mut response = self
            .authorized(&session, self.http.get(url))
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        ensure!(
            response.status().is_success()
                && response
                    .content_length()
                    .is_none_or(|size| size <= MAX_FILE),
            MissingAttachment
        );
        let mut file = tokio::fs::File::from_std(tempfile::tempfile()?);
        let mut bytes = 0_u64;
        while let Some(chunk) = response.chunk().await? {
            bytes += chunk.len() as u64;
            ensure!(bytes <= MAX_FILE, "DSH 文件过大");
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        if zip {
            file.rewind().await?;
            let mut signature = [0; 4];
            file.read_exact(&mut signature).await?;
            ensure!(
                matches!(&signature, b"PK\x03\x04" | b"PK\x05\x06"),
                "DSH 日志不是 ZIP 文件"
            );
        }
        Ok(Source {
            file: file.into_std().await,
            name,
            expected: None,
        })
    }

    pub(crate) async fn file_references(&self, thread: &str, query: &str) -> Result<Value> {
        ensure!(query.encode_utf16().count() <= 500, "DSH 文件搜索条件无效");
        let rows = self
            .call(
                "fileReferences/list",
                json!({"agentId":thread,"query":query}),
            )
            .await?;
        let files: Vec<_> = rows
            .as_array()
            .context("DSH 文件目录无效")?
            .iter()
            .take(200)
            .filter_map(|row| {
                let path = row["path"].as_str()?;
                Some(json!({"path":path,"name":row["name"].as_str().unwrap_or(path)}))
            })
            .collect();
        Ok(json!({"files":files}))
    }

    async fn find_message<T>(
        &self,
        thread: &str,
        mut page: Value,
        find: impl Fn(&Value) -> Option<T>,
    ) -> Result<T> {
        let through = page["cursor"].as_i64().context("DSH 历史游标无效")?;
        let mut before = through.saturating_add(1);
        loop {
            let rows = records(&page)?;
            for row in rows {
                let event = &row["event"];
                let message = match event["type"].as_str() {
                    Some("user/message") => &event["data"],
                    Some("assistant/message" | "tool/result") => &event["data"]["message"],
                    _ => continue,
                };
                if let Some(result) = find(message) {
                    return Ok(result);
                }
            }
            let oldest = rows
                .iter()
                .filter_map(|row| row["event"]["seq"].as_i64())
                .min();
            let Some(next) =
                oldest.filter(|&seq| seq >= 0 && seq < before && page["hasMore"] == true)
            else {
                return Err(MissingAttachment.into());
            };
            before = next;
            page = self
                .call(
                    "session/page",
                    json!({"request":{
                        "address":{"kind":"session","sessionId":thread},"throughSeq":through,
                        "beforeSeq":before,"maxMessages":100
                    }}),
                )
                .await?;
        }
    }
}

fn workspace_path(cwd: &str, reference: &str) -> Option<String> {
    let raw = percent_encoding::percent_decode_str(reference.trim())
        .decode_utf8()
        .ok()?;
    if raw.is_empty() || raw.chars().any(char::is_control) {
        return None;
    }
    let drive = |path: &str| match path.as_bytes() {
        [letter, b':', b'/' | b'\\', ..] if letter.is_ascii_alphabetic() => Some(*letter as char),
        _ => None,
    };
    let windows = drive(cwd);
    let (prefix, body) = if let Some(letter) = windows {
        let raw = raw.replace('\\', "/");
        let base = cwd.replace('\\', "/");
        let path = if drive(&raw).is_some() {
            raw
        } else if raw.starts_with('/') {
            format!("{letter}:{raw}")
        } else if raw.contains(':') {
            return None;
        } else {
            format!("{base}/{raw}")
        };
        let root = path[..2].to_owned();
        (root, path[2..].to_owned())
    } else if raw.contains(':') || raw.starts_with("//") {
        return None;
    } else if raw.starts_with('/') {
        (String::new(), raw.into_owned())
    } else if cwd.starts_with('/') {
        (String::new(), format!("{cwd}/{raw}"))
    } else {
        return None;
    };
    let mut parts = Vec::new();
    for part in body.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return None;
    }
    if windows.is_some() {
        Some(format!("{prefix}\\{}", parts.join("\\")))
    } else {
        Some(format!("/{}", parts.join("/")))
    }
}

pub(crate) fn legacy_file(backend: &str, thread: &str, attachment_id: &str) -> Result<File> {
    let root = legacy_root().context(MissingAttachment)?;
    let receipt_name = format!("{}.json", hash(&json!([thread, attachment_id]).to_string()));
    let receipt = root
        .join("backends")
        .join(backend)
        .join("receipts")
        .join(receipt_name);
    let mut bytes = Vec::new();
    private_file(&receipt, false)
        .map_err(|_| MissingAttachment)?
        .take(8193)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 8192, "旧附件回执无效");
    let value: Value = serde_json::from_slice(&bytes)?;
    let path = PathBuf::from(value["path"].as_str().context(MissingAttachment)?);
    let uploads = root
        .join("uploads")
        .canonicalize()
        .map_err(|_| MissingAttachment)?;
    let canonical = path.canonicalize().map_err(|_| MissingAttachment)?;
    ensure!(
        path.is_absolute() && canonical.starts_with(uploads),
        "旧附件不在上传目录"
    );
    private_file(&canonical, false)
}

fn valid_id(id: &str) -> bool {
    (1..=200).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn attachment_digest(id: &str) -> Option<&str> {
    let digest = id.strip_prefix("sha256:").unwrap_or(id);
    (digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(digest)
}

fn valid_name(name: &str) -> bool {
    (1..=200).contains(&name.encode_utf16().count())
        && !matches!(name, "." | "..")
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | '<' | '>'))
}

fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::workspace_path;

    #[test]
    fn resolves_paths_for_the_dsh_host() {
        assert_eq!(
            workspace_path(r"C:\fixture\work", r"..\report%20copy.pdf").as_deref(),
            Some(r"C:\fixture\report copy.pdf"),
        );
        assert_eq!(
            workspace_path("/fixture/work", "../report%20copy.pdf").as_deref(),
            Some("/fixture/report copy.pdf"),
        );
        assert!(workspace_path(r"C:\fixture", "https://example.invalid/file").is_none());
        assert!(workspace_path("/fixture", "bad%00file").is_none());
    }
}
