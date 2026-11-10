use crate::{
    im_client::{Client, MessageConflict, checked_bytes, required, segment},
    im_crypto::{Envelope, decode_fixed, open_bytes, random, seal_bytes},
    state::private_file,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Method, StatusCode, header};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_FILE: usize = 10 * 1024 * 1024;
const TAG: usize = 16;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Upload {
    path: PathBuf,
    name: Option<String>,
    file_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Download {
    file_id: Uuid,
    path: PathBuf,
}

struct Attachment {
    sender: String,
    context: String,
    key: [u8; 32],
    iv: [u8; 12],
    name: String,
    mime: String,
    size: usize,
}

impl Attachment {
    fn public(&self, id: Uuid, path: &str) -> Value {
        json!({"id":id,"name":self.name,"mime":self.mime,"size":self.size,"url":format!("/api/im{path}")})
    }
}

impl Client {
    pub(crate) async fn attachment_metadata(
        &self,
        encrypted: &str,
        context: &str,
    ) -> Result<(String, Value)> {
        let envelope = Envelope::parse(encrypted)?;
        let sender = envelope.sender().to_owned();
        let metadata = self.decrypt(&sender, context, envelope).await?;
        ensure!(metadata["context"] == context, "附件身份校验失败");
        Ok((sender, metadata))
    }

    async fn attachment(&self, cid: &str, id: Uuid, path: &str) -> Result<Attachment> {
        let metadata = self.get(&format!("{path}?meta=1&full=1")).await?;
        let context = format!("attachment:{cid}:{id}");
        let (sender, secret) = self
            .attachment_metadata(required(&metadata, "encrypted")?, &context)
            .await?;
        let size = secret["size"]
            .as_u64()
            .filter(|size| (1..=MAX_FILE as u64).contains(size))
            .context("附件大小无效")? as usize;
        ensure!(metadata["size"] == size + TAG, "加密附件大小不符");
        Ok(Attachment {
            sender,
            context,
            key: decode_fixed(&STANDARD, &secret["key"])?,
            iv: decode_fixed(&STANDARD, &secret["iv"])?,
            name: required(&secret, "name")?.to_owned(),
            mime: required(&secret, "mime")?.to_owned(),
            size,
        })
    }

    async fn attachment_bytes(&self, path: &str, attachment: &Attachment) -> Result<Vec<u8>> {
        // The authorized download route proxies private objects on both runtimes.
        let request = self.api_request(Method::GET, &format!("{path}?download=1"), 45);
        let ciphertext = checked_bytes(request, attachment.size + TAG).await?;
        ensure!(
            ciphertext.len() == attachment.size + TAG,
            "加密附件大小不符"
        );
        open_bytes(
            &attachment.key,
            attachment.iv,
            ciphertext,
            &attachment.context,
        )
    }

    pub(crate) async fn upload_attachment(&self, cid: &str, input: Upload) -> Result<Value> {
        let Upload {
            path,
            name,
            file_id,
        } = input;
        ensure!(path.is_absolute(), "附件需要使用绝对路径");
        let name = name
            .or_else(|| path.file_name()?.to_str().map(str::to_owned))
            .filter(|name| {
                !name.trim().is_empty()
                    && name.encode_utf16().count() <= 180
                    && !name
                        .chars()
                        .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
            })
            .context("附件名称无效")?;
        let bytes = tokio::task::spawn_blocking(move || {
            ensure!(fs::metadata(&path)?.is_file(), "附件需要普通文件");
            read_plain(File::open(path)?)
        })
        .await??;
        let mime = attachment_mime(&name, &bytes);
        let size = bytes.len();
        let id = file_id.unwrap_or_else(Uuid::new_v4);
        let endpoint = format!("/conversations/{}", segment(cid));
        let path = file_path(cid, id)?;
        if file_id.is_some() {
            match self.attachment(cid, id, &path).await {
                Ok(existing) => {
                    if existing.sender != self.id
                        || existing.name != name
                        || existing.mime != mime
                        || existing.size != size
                        || self.attachment_bytes(&path, &existing).await? != bytes
                    {
                        return Err(MessageConflict.into());
                    }
                    return Ok(existing.public(id, &path));
                }
                Err(error)
                    if error
                        .downcast_ref::<reqwest::Error>()
                        .and_then(reqwest::Error::status)
                        == Some(StatusCode::NOT_FOUND) => {}
                Err(error) => return Err(error),
            }
        }
        let context = format!("attachment:{cid}:{id}");
        let key = random::<32>()?;
        let (iv, ciphertext) = seal_bytes(&key, bytes, &context)?;
        let recipients = self.recipients(&endpoint).await?;
        let recipients = recipients.iter().map(String::as_str).collect::<Vec<_>>();
        let encrypted = self
            .encrypt(
                &recipients,
                &context,
                &json!({
                    "key":STANDARD.encode(key),"iv":STANDARD.encode(iv),"name":name,
                    "mime":mime,"size":size,"context":context
                }),
            )
            .await?;
        let request = self
            .api_request(Method::POST, &format!("{endpoint}/files"), 45)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header("x-file-name", "encrypted.pocket")
            .header("x-encrypted-header", &encrypted)
            .body(ciphertext);
        let response: Value = serde_json::from_slice(&checked_bytes(request, 64 * 1024).await?)?;
        let file = &response["file"];
        ensure!(
            file["id"] == id.to_string() && file["encrypted"] == encrypted,
            "服务返回的附件身份不符"
        );
        Ok(json!({"id":id,"name":name,"mime":mime,"size":size,"url":format!("/api/im{path}")}))
    }

    pub(crate) async fn download_attachment(&self, cid: &str, input: Download) -> Result<Value> {
        let Download {
            path: output,
            file_id,
        } = input;
        ensure!(
            output.is_absolute() && output.file_name().is_some(),
            "附件需要使用绝对文件路径"
        );
        let path = file_path(cid, file_id)?;
        let attachment = self.attachment(cid, file_id, &path).await?;
        let plaintext = self.attachment_bytes(&path, &attachment).await?;
        tokio::task::spawn_blocking(move || write_private(&output, &plaintext)).await??;
        let mut result = attachment.public(file_id, &path);
        result["mime"] = json!(safe_mime(&attachment.mime));
        Ok(result)
    }

    pub(crate) async fn remove_attachment(&self, cid: &str, file_id: Uuid) -> Result<Value> {
        let path = format!("/conversations/{}/files/{file_id}", segment(cid));
        self.request(Method::DELETE, &path, None).await
    }
}

fn file_path(cid: &str, id: Uuid) -> Result<String> {
    let cid = Uuid::parse_str(cid).context("会话标识无效")?;
    Ok(format!("/conversations/{cid}/files/{id}/encrypted.pocket"))
}

fn read_plain(file: File) -> Result<Vec<u8>> {
    ensure!(file.metadata()?.is_file(), "附件需要普通文件");
    let mut bytes = Vec::new();
    file.take((MAX_FILE + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(
        (1..=MAX_FILE).contains(&bytes.len()),
        "附件需要为 1 字节至 10 MB"
    );
    Ok(bytes)
}

fn write_private(output: &Path, bytes: &[u8]) -> Result<()> {
    match private_file(output, false) {
        Ok(existing) => {
            if read_plain(existing)? == bytes {
                return Ok(());
            }
            return Err(MessageConflict.into());
        }
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) => {}
        Err(error) => return Err(error),
    }
    let parent = output.parent().context("附件目标目录无效")?;
    let staged = parent.join(format!(".agent-space-{}.part", Uuid::new_v4()));
    let temp = tempfile::TempPath::try_from_path(&staged)?;
    let mut file = private_file(&staged, true)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    temp.persist_noclobber(output)?;
    Ok(())
}

fn attachment_mime(name: &str, data: &[u8]) -> &'static str {
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let starts = |prefix: &[u8]| data.starts_with(prefix);
    let at = |offset: usize, prefix: &[u8]| {
        data.get(offset..)
            .is_some_and(|part| part.starts_with(prefix))
    };
    let head = &data[..data.len().min(4096)];
    let has = |needle: &[u8]| head.windows(needle.len()).any(|window| window == needle);
    if starts(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if starts(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if starts(b"GIF87a") || starts(b"GIF89a") {
        "image/gif"
    } else if starts(b"RIFF") && at(8, b"WEBP") {
        "image/webp"
    } else if starts(b"RIFF") && at(8, b"WAVE") {
        "audio/wav"
    } else if starts(b"OggS") {
        "audio/ogg"
    } else if starts(b"fLaC") {
        "audio/flac"
    } else if starts(b"ID3")
        || (data.len() > 3
            && data[0] == 0xff
            && data[1] & 0xe0 == 0xe0
            && data[1] & 0x06 != 0
            && data[2] & 0xf0 != 0xf0)
    {
        "audio/mpeg"
    } else if at(4, b"ftyp") && extension == "m4a" {
        "audio/mp4"
    } else if at(4, b"ftyp") && extension == "mp4" {
        "video/mp4"
    } else if starts(b"\x1a\x45\xdf\xa3") && has(b"webm") {
        if has(b"OpusHead") && ![b"V_VP8", b"V_VP9", b"V_AV1"].iter().any(|kind| has(*kind)) {
            "audio/webm"
        } else {
            "video/webm"
        }
    } else if matches!(
        extension.as_str(),
        "txt"
            | "md"
            | "csv"
            | "log"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "py"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "sh"
            | "rs"
            | "c"
            | "cpp"
            | "h"
    ) && !data.contains(&0)
        && std::str::from_utf8(data).is_ok()
    {
        "text/plain; charset=utf-8"
    } else if starts(b"%PDF-") {
        "application/pdf"
    } else {
        "application/octet-stream"
    }
}

fn safe_mime(mime: &str) -> &str {
    let media = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let playback = media
        .strip_prefix("audio/")
        .or_else(|| media.strip_prefix("video/"));
    if matches!(
        media.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "text/plain" | "application/pdf"
    ) || playback.is_some_and(|kind| {
        !kind.is_empty()
            && kind
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
    }) {
        mime
    } else {
        "application/octet-stream"
    }
}
